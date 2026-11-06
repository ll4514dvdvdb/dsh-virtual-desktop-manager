// 插件装载测试：不依赖 DSH 运行时，用 mock ctx 走一遍 apply()。
// 目的：保证 16 个工具的 schema 合法、Game Mode 拦截在"真正调用原生助手之前"就生效
// （拦截类用例绝不能真的去启动程序或切桌面）。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'vdm-plugin-'))
process.env.VDM_STATE_DIR = join(root, 'state')

const { apply, name, inject, describeError } = await import('../index.js')
const state = await import('../lib/state.js')

/** 最小可用的 ctx 桩：只提供 apply() 真正用到的东西 */
function makeCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      tools: { register: (tool) => registered.push(tool) },
      get: () => undefined,
      inject: () => undefined,
    },
  }
}

const EXPECTED_TOOLS = [
  'vdm_capabilities',
  'vdm_list_desktops',
  'vdm_get_current_desktop',
  'vdm_create_desktop',
  'vdm_ensure_workspace_desktop',
  'vdm_switch_desktop',
  'vdm_remove_desktop',
  'vdm_list_windows',
  'vdm_window_info',
  'vdm_move_window',
  'vdm_launch_in_desktop',
  'vdm_capture_window',
  'vdm_close_window',
  'vdm_uia_tree',
  'vdm_uia_act',
  'vdm_game_mode',
]

let registered

before(() => {
  const { ctx, registered: r } = makeCtx()
  apply(ctx, { workspaceDesktopName: 'AI 工作桌面', defaultTimeoutMs: 8000 })
  registered = r
  assert.equal(name, 'virtual-desktop-manager')
  assert.deepEqual(inject, ['tools'])
})

after(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
})

test('注册了全部 16 个工具，名字与预期一致', () => {
  assert.deepEqual(registered.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort())
})

test('每个工具的 schema、描述、输出契约都完整', () => {
  for (const tool of registered) {
    assert.ok(tool.description && tool.description.length > 10, `${tool.name} 缺描述`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} 参数不是 object`)
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} 必须禁止未知参数`)
    assert.equal(typeof tool.parameters.properties, 'object', `${tool.name} 缺 properties`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
    assert.equal(typeof tool.timeoutMs, 'number', `${tool.name} 缺 timeoutMs`)
    // 危险操作的必填校验必须写进 schema，否则模型漏参数时会静默跑错
    assert.equal(tool.output.schema.type, 'object', `${tool.name} 输出 schema 不对`)
    assert.ok(Array.isArray(tool.output.render({}, { text: 'x' })), `${tool.name} render 不返回数组`)
  }
})

test('需要授权的工具在 schema 里就能看到 authorized/allowForeground 这类开关', () => {
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
  assert.ok(byName.vdm_switch_desktop.parameters.properties.authorized)
  assert.ok(byName.vdm_remove_desktop.parameters.properties.authorized)
  assert.ok(byName.vdm_move_window.parameters.properties.allowForeground)
  assert.deepEqual(byName.vdm_move_window.parameters.required, ['hwnd', 'desktopId'])
  assert.deepEqual(byName.vdm_launch_in_desktop.parameters.required, ['path'])
  assert.deepEqual(byName.vdm_window_info.parameters.required, ['hwnd'])
})

test('launch 的控制参数是 avoidForegroundMove，不是 allowForeground（原生层只认前者）', () => {
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
  const props = byName.vdm_launch_in_desktop.parameters.properties
  assert.ok(props.avoidForegroundMove, 'launch 应暴露 avoidForegroundMove')
  assert.equal(props.allowForeground, undefined, 'launch 不该暴露 allowForeground：原生层不读这个参数')
  // move_window 的 allowForeground 是另一套语义（保护用户自己的前台窗口），必须保留
  assert.ok(
    byName.vdm_move_window.parameters.properties.allowForeground,
    'move_window 的 allowForeground 不能被顺手删掉',
  )
})

test('switch_desktop 不带 authorized 时拒绝，且不碰原生助手', async () => {
  state.writeState({ gameMode: false, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_switch_desktop')
  const out = await tool.execute({ desktopId: '00000000-0000-0000-0000-000000000000' }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'not_authorized')
  assert.match(out.text, /authorized/)
})

test('remove_desktop 不带 authorized 时拒绝', async () => {
  state.writeState({ gameMode: false, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_remove_desktop')
  const out = await tool.execute({ desktopId: '00000000-0000-0000-0000-000000000000' }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'not_authorized')
})

test('Game Mode 开启时 launch 被拦下并进等待队列（不启动任何程序）', async () => {
  state.writeState({ gameMode: true, gameModeReason: '用户在打游戏', pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_launch_in_desktop')
  const out = await tool.execute({ path: 'C:\\Windows\\notepad.exe' }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'game_mode_blocks')
  assert.match(out.text, /等待队列/)

  const st = state.readState()
  assert.equal(st.pending.length, 1)
  assert.equal(st.pending[0].action, 'vdm_launch_in_desktop')
})

test('Game Mode 下以普通可见窗口启动仍被拦（防止偷偷弹窗打扰游戏）', async () => {
  state.writeState({ gameMode: true, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_launch_in_desktop')
  const out = await tool.execute({ path: 'C:\\Windows\\notepad.exe', allowInGameMode: true, windowStyle: 'normal' }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'game_mode_blocks_visible_window')
})

test('Game Mode 下 create_desktop 被拦', async () => {
  state.writeState({ gameMode: true, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_create_desktop')
  const out = await tool.execute({ name: 'AI 工作桌面' }, {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'game_mode_blocks')
})

test('Game Mode 下窗口级截图不被拦（只读、不影响前台）', async () => {
  state.writeState({ gameMode: true, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_capture_window')
  // 不传真实 hwnd：只验证没有被 Game Mode 拦下，错误来自原生层参数校验/句柄不存在
  const out = await tool.execute({ hwnd: '0xDEAD', strict: true }, {})
  assert.notEqual(out.code, 'game_mode_blocks')
})

test('game_mode 工具能开、能查、关闭必须授权', async () => {
  const tool = registered.find((t) => t.name === 'vdm_game_mode')

  const on = await tool.execute({ action: 'on', reason: '用户在玩游戏' }, {})
  assert.equal(on.ok, true)
  assert.equal(state.readState().gameMode, true)

  const status = await tool.execute({ action: 'status' }, {})
  assert.equal(status.ok, true)
  assert.match(status.text, /开启/)

  const offDenied = await tool.execute({ action: 'off' }, {})
  assert.equal(offDenied.ok, false)
  assert.equal(offDenied.code, 'not_authorized')
  assert.equal(state.readState().gameMode, true, '未授权时绝不允许真的关掉')

  const off = await tool.execute({ action: 'off', authorized: true, reason: '用户说打完了' }, {})
  assert.equal(off.ok, true)
  assert.equal(state.readState().gameMode, false)
})

test('Game Mode 下前台窗口移动被额外限制', async () => {
  state.writeState({ gameMode: true, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_move_window')
  const out = await tool.execute(
    { hwnd: '0xDEAD', desktopId: '00000000-0000-0000-0000-000000000000', allowForeground: true },
    {},
  )
  assert.equal(out.ok, false)
  assert.equal(out.code, 'game_mode_blocks')
})

test('Game Mode 下 uia_tree 不被拦（只读，不碰目标程序）', async () => {
  state.writeState({ gameMode: true, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_uia_tree')
  // 故意给不存在的句柄：只要不是 game_mode_blocks，就说明只读读取没有被拦
  const out = await tool.execute({ hwnd: '0xDEAD' }, {})
  assert.notEqual(out.code, 'game_mode_blocks')
})

test('Game Mode 下 uia_act 默认被拦，focus 即使 allowInGameMode 也拦', async () => {
  state.writeState({ gameMode: true, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_uia_act')

  const blocked = await tool.execute({ hwnd: '0xDEAD', path: '0/1', action: 'invoke' }, {})
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'game_mode_blocks')
  assert.match(blocked.text, /allowInGameMode/)

  const focusBlocked = await tool.execute(
    { hwnd: '0xDEAD', path: '0/1', action: 'focus', allowInGameMode: true },
    {},
  )
  assert.equal(focusBlocked.ok, false)
  assert.equal(focusBlocked.code, 'game_mode_blocks')
  assert.match(focusBlocked.text, /提到前台/)

  // focus 被拦不进等待队列（它不是"等到用户允许就能做"的事，而是永远不允许）
  const pendingAfterFocus = state.readState().pending.map((p) => p.reason).join('\n')
  assert.doesNotMatch(pendingAfterFocus, /focus/)
})

test('Game Mode 关闭后 uia_act 不再被 gate 拦（错误来自原生层）', async () => {
  state.writeState({ gameMode: false, pending: [] })
  const tool = registered.find((t) => t.name === 'vdm_uia_act')
  const out = await tool.execute({ hwnd: '0xDEAD', path: '0/1', action: 'invoke' }, {})
  assert.notEqual(out.code, 'game_mode_blocks')
})

test('错误码会翻译成可执行的中文下一步，未知错误码也不崩', () => {
  const cases = [
    ['desktop_not_found', /手动删掉/],
    ['invalid_hwnd', /重新跑 vdm_list_windows/],
    ['uia_element_not_found', /重新跑 vdm_uia_tree/],
    ['move_unconfirmed', /反复重试/],
    ['move_failed', /windowStyle:"normal"/],
    ['target_not_responding', /无响应/],
    ['close_failed', /交给用户处理/],
    ['last_desktop', /最后一个/],
    ['host_timeout', /超时/],
    ['launch_failed', /路径/],
    ['not_authorized', /明确授权/],
    ['target_is_foreground', /游戏/],
  ]
  for (const [code, re] of cases) {
    const text = describeError({ code, message: '触发失败' }, 'vdm_test')
    assert.match(text, /错误码：/, `${code} 应该带上错误码行`)
    assert.match(text, /触发失败/, `${code} 应该保留原始 message`)
    assert.match(text, re, `${code} 的中文提示没覆盖关键点：${text}`)
  }
  // 没见过的错误码：保留原文，不抛异常、不吞掉
  const unknown = describeError({ code: 'never_heard_of', message: 'boom' }, 'vdm_test')
  assert.match(unknown, /boom/)
  assert.match(unknown, /never_heard_of/)
  // warnings 和 HRESULT 都要透传
  const withWarn = describeError({ code: 'x', message: 'm', hresult: -2147024891, warnings: ['窗口已最小化'] }, 'vdm_test')
  assert.match(withWarn, /80070005/)
  assert.match(withWarn, /窗口已最小化/)
})