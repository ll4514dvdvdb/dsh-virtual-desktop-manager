// 原生层冒烟测试：直接驱动 vdmhost.exe 走一遍只读命令。
//
// 这个脚本不做任何有副作用的事（不建桌面、不切桌面、不移动窗口、不启动程序），
// 只验证"COM 能不能用、能不能读到桌面和窗口"。
//
// 退出码：0 全部通过；1 有断言失败；2 环境不支持（例如不是 Medium 完整性、构建号未标定）。
//
// 用法：node tests/host-smoke.mjs
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveHostPath, runHost } from '../lib/bridge.js'
import { fmtDesktops, fmtWindows } from '../lib/format.js'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

let failures = 0
let skipped = 0

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`)
    return true
  }
  failures += 1
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

async function main() {
  console.log('=== 原生助手冒烟测试 ===')

  if (!existsSync(join(PKG_DIR, 'dist', 'vdmhost.exe'))) {
    console.log('找不到 dist/vdmhost.exe，请先运行 npm run build:host')
    process.exit(2)
  }
  const host = resolveHostPath(PKG_DIR, {})
  console.log(`助手：${host}`)

  const caps = await runHost(host, 'capabilities', {}, { timeoutMs: 20000 })
  const c = caps.data
  console.log(`环境：build ${c.osBuild} / session ${c.sessionId} / ${c.integrity}`)
  check('构建号有结论（受支持或明确未标定）', typeof c.buildSupported === 'boolean', String(c.buildSupported))
  check('知道自己是不是 Medium 完整性', typeof c.integrity === 'string' && c.integrity.length > 0)

  if (!c.desktopApiAvailable) {
    console.log(`  ! 虚拟桌面 COM 不可用：${c.desktopApiError || '(无详情)'}`)
    console.log('    常见原因：进程不是 Medium 完整性（被沙箱、服务或降权方式启动），或不是交互式会话。')
    console.log('    这一项无法测，退出码 2。')
    process.exit(2)
  }
  check('虚拟桌面 COM 可用', true)
  check('至少枚举到 1 个桌面', c.desktopCount >= 1, `desktopCount=${c.desktopCount}`)

  const list = await runHost(host, 'list_desktops', {}, { timeoutMs: 20000 })
  const d = list.data
  check('list_desktops 返回 desktops 数组', Array.isArray(d.desktops) && d.desktops.length >= 1)
  check('每个桌面都有 GUID 形式的 id', d.desktops.every((x) => /^[0-9a-f-]{36}$/i.test(x.id)))
  check(
    '恰好一个 current 桌面，且与 currentDesktopId 一致',
    d.desktops.filter((x) => x.isCurrent).length === 1 &&
      d.desktops.find((x) => x.isCurrent).id === d.currentDesktopId,
  )
  check('桌面带 windowCount 统计', d.desktops.every((x) => typeof x.windowCount === 'number'))

  const cur = await runHost(host, 'get_current_desktop', {}, { timeoutMs: 20000 })
  check('get_current_desktop 与 list_desktops 一致', cur.data.desktopId === d.currentDesktopId)

  const wins = await runHost(host, 'list_windows', { limit: 50 }, { timeoutMs: 25000 })
  const w = wins.data
  check('list_windows 返回 windows 数组', Array.isArray(w.windows))
  check('窗口记录含 hwnd/pid/processName', w.windows.every((x) => x.hwnd && x.pid && x.processName))
  check(
    '窗口的 onCurrentDesktop 与 virtualDesktopId 逻辑自洽',
    w.windows.every((x) => !x.virtualDesktopId || x.onCurrentDesktop === (x.virtualDesktopId === d.currentDesktopId)),
  )

  console.log('\n--- list_desktops 渲染结果 ---')
  console.log(fmtDesktops(d))
  console.log('\n--- list_windows 渲染结果（前 10 条）---')
  console.log(fmtWindows({ ...w, windows: w.windows.slice(0, 10), totalMatched: w.totalMatched }))

  console.log('')
  if (skipped) console.log(`跳过 ${skipped} 项`)
  if (failures > 0) {
    console.log(`失败 ${failures} 项`)
    process.exit(1)
  }
  console.log('全部通过')
}

main().catch((err) => {
  console.error('冒烟测试异常：', err?.code || '', err?.message || err)
  process.exit(1)
})
