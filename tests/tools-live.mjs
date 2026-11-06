#!/usr/bin/env node
/**
 * 工具层集成测试：真的把 index.js 注册的 vdm_* 工具跑一遍，直连原生助手（不经过 DSH）。
 *
 * 目的：在把插件装进 profile、重启 DSH 之前，就能确认「工具层 -> bridge -> 原生层」整条链路是通的，
 * 而不是等到重启后才发现某个工具的参数名对不上。
 *
 * 刻意不碰的危险操作（脚本里显式跳过，并列在输出里）：
 *   - switch_desktop   会把你整个屏幕切走
 *   - launch           实测 Store 版记事本即使 minimized 也会抢前台
 *   - move_window 真移 会动到真实窗口的归属
 *   - close_window 真关 会关掉真实程序
 * 这些都是"装好之后由人在场时才做"的验证，不属于自动化冒烟。
 *
 * 用法：
 *   node tests/tools-live.mjs
 *   node tests/tools-live.mjs --keep    保留临时状态目录，方便看 captures/
 *   node tests/tools-live.mjs --no-desktop  跳过建/删桌面的用例
 */
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const skipDesktop = argv.includes('--no-desktop')

const stateRoot = mkdtempSync(join(tmpdir(), 'vdm-live-'))
process.env.VDM_STATE_DIR = stateRoot

const { default: _ignored, ...mod } = await import('../index.js').catch((err) => {
  console.error('导入 index.js 失败：' + err.message)
  process.exit(1)
})

// --- mock 一个最小的 DSH ctx ------------------------------------------------
const tools = new Map()
const savedImages = []
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  tools: {
    register(tool) {
      if (!tool?.name) throw new Error('注册的工具没有 name')
      tools.set(tool.name, tool)
    },
  },
  get(name) {
    if (name === 'attachments') {
      return {
        async saveImages(images) {
          savedImages.push(...images)
          return images.map((img, i) => ({ id: `att-${i}`, name: img.name, mediaType: img.mediaType }))
        },
      }
    }
    return undefined
  },
  inject() {},
}

mod.apply(ctx, {})

// --- 小工具 ---------------------------------------------------------------
let pass = 0
let fail = 0
const skipped = []
const failures = []

function ok(label, cond, detail) {
  if (cond) {
    pass++
    console.log(`  \u2713 ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  \u2717 ${label}`)
    if (detail !== undefined) {
      const s = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2)
      console.log('      ' + s.split('\n').join('\n      '))
    }
  }
  return cond
}

async function call(name, args = {}) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`工具 ${name} 没注册`)
  return tool.execute(args, {})
}

function show(out) {
  return (out?.text || '').split('\n').slice(0, 6).join('\n')
}

// --- 开始 -----------------------------------------------------------------
console.log('=== vdm 工具层集成测试（直连原生助手，不经过 DSH）===')
console.log('状态目录：' + stateRoot)
console.log('')

if (!ok('16 个 vdm_* 工具都已注册', tools.size === 16, `实际 ${tools.size} 个：${[...tools.keys()].join(', ')}`)) {
  console.log('\n工具都没注册齐，后面的用例没有意义。')
  process.exit(1)
}

// 1. capabilities
console.log('\n[1] vdm_capabilities')
const caps = await call('vdm_capabilities')
ok('返回 ok', caps.ok === true, caps.text)
if (caps.ok) {
  const d = caps.data || {}
  ok('知道自己的完整性级别', typeof d.integrity === 'string', d.integrity)
  ok('构建号有结论', typeof d.buildSupported === 'boolean', `buildSupported=${d.buildSupported}`)
  const comOk = d.desktopApiAvailable === true
  ok('虚拟桌面 COM 可用', comOk, d.desktopApiError || '')
  const cmds = Array.isArray(d.commands) ? d.commands : []
  ok('原生层报了 uia_tree / uia_act 两个命令', cmds.includes('uia_tree') && cmds.includes('uia_act'), cmds.join(','))
  if (!comOk) {
    console.log('\n  COM 不可用，后续用例全部跳过（这通常是完整性级别/会话问题，不是代码问题）。')
    finish(2)
  }
}

// 2. list_desktops
console.log('\n[2] vdm_list_desktops')
const listDesk = await call('vdm_list_desktops')
ok('返回 ok', listDesk.ok === true, listDesk.text)
const desktops = listDesk.data?.desktops || []
ok('至少 1 个桌面', desktops.length >= 1, `桌面数 ${desktops.length}`)
ok(
  '每个桌面都有 GUID 形式的 id',
  desktops.every((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.id)),
  desktops.map((x) => x.id),
)
const currentFromList = listDesk.data?.currentDesktopId
ok('恰好一个 isCurrent 且与 currentDesktopId 一致', desktops.filter((x) => x.isCurrent).length === 1 && desktops.some((x) => x.id === currentFromList), {
  currentFromList,
})

// 3. get_current_desktop
console.log('\n[3] vdm_get_current_desktop')
const cur = await call('vdm_get_current_desktop')
ok('返回 ok', cur.ok === true, cur.text)
ok('与 list_desktops 的 currentDesktopId 一致', cur.data?.id === currentFromList, { got: cur.data?.id, want: currentFromList })

// 4. list_windows
console.log('\n[4] vdm_list_windows')
const winList = await call('vdm_list_windows', { limit: 50 })
ok('返回 ok', winList.ok === true, winList.text)
const windows = winList.data?.windows || []
ok('拿到窗口数组', Array.isArray(windows), typeof windows)
ok('窗口记录含 hwnd/pid/processName', windows.every((w) => w.hwnd && typeof w.pid === 'number' && typeof w.processName === 'string'), windows.slice(0, 2))
ok(
  'onCurrentDesktop 与 virtualDesktopId 自洽',
  windows.every((w) => w.onCurrentDesktop === (w.virtualDesktopId === currentFromList)),
  windows.map((w) => [w.processName, w.virtualDesktopId, w.onCurrentDesktop]).slice(0, 3),
)

// 5. window_info
console.log('\n[5] vdm_window_info')
const target = windows.find((w) => /DeepSeek Harness/i.test(w.title || '')) || windows.find((w) => !w.minimized) || windows[0]
if (!target) {
  skipped.push('window_info（没有可用窗口）')
  console.log('  - 没有可用窗口，跳过')
} else {
  const info = await call('vdm_window_info', { hwnd: target.hwnd })
  ok('返回 ok', info.ok === true, info.text)
  ok('hwnd 匹配', String(info.data?.hwnd).toLowerCase() === String(target.hwnd).toLowerCase(), { got: info.data?.hwnd, want: target.hwnd })
  ok('带 rect 几何信息', typeof info.data?.rect?.width === 'number', info.data?.rect)
  ok('带 isForeground 判定', typeof info.data?.isForeground === 'boolean', info.data?.isForeground)
}

// 6. capture_window
console.log('\n[6] vdm_capture_window')
if (!target) {
  skipped.push('capture_window（没有可用窗口）')
  console.log('  - 没有可用窗口，跳过')
} else {
  const cap = await call('vdm_capture_window', { hwnd: target.hwnd })
  ok('返回 ok', cap.ok === true, cap.text)
  if (cap.ok) {
    const p = cap.data?.path
    ok('给出了截图文件路径', typeof p === 'string' && p.length > 0, p)
    ok('文件真的存在且非空', !!p && existsSync(p) && statSync(p).size > 1024, p ? `${p} -> ${existsSync(p) ? statSync(p).size : 'missing'} 字节` : '')
    ok(
      'qualityVerdict 有明确结论',
      cap.data?.qualityVerdict === 'ok' || cap.data?.qualityVerdict === 'blank_or_uncapturable',
      cap.data?.qualityVerdict,
    )
    // 图片挂载：有 attachments 服务时应该真的挂上
    ok('图片通过 attachments 挂进了对话', savedImages.length > 0, `saveImages 收到 ${savedImages.length} 张`)
    ok('返回文本里说明了图片路径', typeof cap.text === 'string' && cap.text.includes(p || '\u0000'), show(cap))
  }
}

// 6.5 UI Automation（只读 + 错误路径；真实点击类操作要人工确认，不放进自动回归）
console.log('\n[6.5] vdm_uia_tree / vdm_uia_act（UIA 控件级自动化）')
if (!target) {
  skipped.push('uia_tree / uia_act（没有可用窗口）')
  console.log('  - 没有可用窗口，跳过')
} else {
  const tree = await call('vdm_uia_tree', { hwnd: target.hwnd, maxDepth: 4, maxNodes: 120 })
  ok('uia_tree 返回 ok（UIA 真的能读到这个窗口）', tree.ok === true, tree.text)
  if (tree.ok) {
    const nodes = tree.data?.nodes || []
    ok('至少读到根节点', nodes.length >= 1, `节点数 ${nodes.length}`)
    ok('根节点 path 为空串、且带 type', nodes[0]?.path === '' && typeof nodes[0]?.type === 'string', nodes[0])
    ok(
      '每个节点都有 path/type/name 结构',
      nodes.every((n) => typeof n.path === 'string' && typeof n.type === 'string' && typeof n.name === 'string'),
      nodes.slice(0, 2),
    )
    ok('文本里有节点清单或"没读到控件"的解释', typeof tree.text === 'string' && tree.text.length > 30, show(tree))
  }

  const missing = await call('vdm_uia_act', { hwnd: target.hwnd, path: '99/99', action: 'invoke' })
  ok(
    '越界 path 明确报"找不到控件"，不静默失败',
    missing.ok === false && (missing.code === 'uia_element_not_found' || /找不到控件/.test(missing.text || '')),
    missing.text,
  )

  const noAction = await call('vdm_uia_act', { hwnd: target.hwnd, path: '' })
  ok('缺 action 时报参数错误', noAction.ok === false, noAction.text)
}

// 7. 建 / 删桌面
let tempDesktop = null
if (skipDesktop) {
  skipped.push('create_desktop / remove_desktop（--no-desktop）')
  console.log('\n[7] 建/删桌面  已按 --no-desktop 跳过')
} else {
  console.log('\n[7] vdm_create_desktop + vdm_remove_desktop')
  const name = `__vdm_selftest_${Date.now()}`
  const created = await call('vdm_create_desktop', { name })
  ok('创建返回 ok', created.ok === true, created.text)
  if (created.ok) {
    // create_desktop 的 GUID 在顶层 desktopId，也在嵌套 desktop.id；两个都认。
    tempDesktop = created.data?.desktopId ?? created.data?.desktop?.id
    ok('拿到新桌面 GUID', typeof tempDesktop === 'string' && tempDesktop.length === 36, tempDesktop)
    const createdName = created.data?.desktop?.name ?? created.data?.name
    ok('中文/自定义名字生效', createdName === name, { got: createdName, want: name })
    ok(
      '创建没有切走用户当前桌面（核心主张）',
      created.data?.currentDesktopChanged === false,
      `currentDesktopChanged=${created.data?.currentDesktopChanged}`,
    )
    const again = await call('vdm_create_desktop', { name })
    ok('同名再建返回 reused:true（不会重复堆桌面）', again.ok === true && again.data?.reused === true, again.data)

    const removed = await call('vdm_remove_desktop', { desktopId: tempDesktop, authorized: true })
    ok('删除返回 ok', removed.ok === true, removed.text)
    if (removed.ok) {
      const after = await call('vdm_list_desktops')
      ok(
        '删完确实不在列表里了',
        !(after.data?.desktops || []).some((d) => d.id === tempDesktop),
        (after.data?.desktops || []).map((d) => d.name),
      )
      tempDesktop = null
    }
  }
}

// 8. ensure_workspace_desktop
console.log('\n[8] vdm_ensure_workspace_desktop')
const ws = await call('vdm_ensure_workspace_desktop', {})
ok('返回 ok', ws.ok === true, ws.text)
ok('给出工作桌面 GUID', typeof ws.desktopId === 'string' && ws.desktopId.length === 36, ws.desktopId ?? ws.data)

// 9. Game Mode 全链路
console.log('\n[9] vdm_game_mode（开 -> 拦截 -> 关）')
const gmOn = await call('vdm_game_mode', { action: 'on', reason: '集成测试' })
ok('开启返回 ok', gmOn.ok === true, gmOn.text)

const blockedMove = await call('vdm_move_window', { hwnd: target?.hwnd || '0x1', desktopId: currentFromList })
ok('Game Mode 下 move_window 被拦截（没走到原生层）', blockedMove.ok === false, blockedMove.text)
ok('拦截原因是 Game Mode', typeof blockedMove.code === 'string' && /game/i.test(blockedMove.code + blockedMove.text), blockedMove.code)
ok('被拦截的任务进了等待队列', (blockedMove.text || '').includes('等待') || (blockedMove.text || '').includes('队列'), show(blockedMove))

const pending = await call('vdm_game_mode', { action: 'pending' })
ok('pending 能看到队列里的记录', pending.ok === true && (pending.data?.length ?? pending.data?.pending?.length ?? 0) > 0, pending.data)

const status = await call('vdm_game_mode', { action: 'status' })
ok('status 显示开启中', status.ok === true && status.data?.gameMode === true, status.data)

// Game Mode 里明确允许的两件事，必须真的还能跑：窗口级截图、只读评估。
if (target?.hwnd) {
  const capInGame = await call('vdm_capture_window', { hwnd: target.hwnd, strict: false })
  ok('Game Mode 下 capture_window 仍可用（不影响前台的窗口级截图）', capInGame.ok === true, capInGame.text)
  const closeDry = await call('vdm_close_window', { hwnd: target.hwnd, dryRun: true })
  ok('Game Mode 下 close_window 的 dryRun 预演仍可用（只读）', closeDry.ok === true, closeDry.text)
  const closeReal = await call('vdm_close_window', { hwnd: target.hwnd, dryRun: false })
  ok('Game Mode 下 close_window 真关被拦截', closeReal.ok === false, closeReal.text)
} else {
  skipped.push('Game Mode 截图/关闭用例（没拿到可用窗口）')
}

const offNoAuth = await call('vdm_game_mode', { action: 'off' })
ok('不带 authorized 关不掉', offNoAuth.ok === false, offNoAuth.text)

const off = await call('vdm_game_mode', { action: 'off', authorized: true })
ok('带 authorized 可以关', off.ok === true, off.text)
const status2 = await call('vdm_game_mode', { action: 'status' })
ok('关掉后状态是 false', status2.data?.gameMode === false, status2.data)

// 10. 审计日志
console.log('\n[10] 审计日志')
const auditFile = join(stateRoot, 'audit.log')
ok('audit.log 已生成', existsSync(auditFile), auditFile)
if (existsSync(auditFile)) {
  const lines = statSync(auditFile).size > 0
  ok('日志非空', lines, statSync(auditFile).size + ' 字节')
}

// --- 收尾 -----------------------------------------------------------------
function finish(code) {
  console.log('')
  if (skipped.length) {
    console.log('跳过（这些必须人工在场才做）：')
    for (const s of skipped) console.log('  - ' + s)
    console.log('  - switch_desktop（会把你整个屏幕切走）')
    console.log('  - launch（Store 版程序会抢前台）')
    console.log('  - close_window 真关（会关掉真实程序）')
    console.log('')
  }
  if (keep) console.log('临时状态目录保留：' + stateRoot)
  else rmSync(stateRoot, { recursive: true, force: true })

  console.log(`结果：${pass} 通过，${fail} 失败`)
  if (fail > 0) {
    console.log('失败项：')
    for (const f of failures) console.log('  - ' + f)
  }
  process.exit(code ?? (fail > 0 ? 1 : 0))
}

finish()
