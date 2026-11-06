// 渲染层的纯函数测试：不碰 COM、不碰文件系统，只断言"给模型看的文本"里
// 该出现的结论和风险提示都在。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  fmtCapabilities,
  fmtCapture,
  fmtClose,
  fmtCurrentDesktop,
  fmtDesktops,
  fmtGameMode,
  fmtLaunch,
  fmtMove,
  fmtPending,
  fmtWindowInfo,
  fmtWindows,
  hwndHex,
} from '../lib/format.js'

test('hwndHex 兼容十六进制字符串、0x 前缀和十进制数字', () => {
  assert.equal(hwndHex('3084C'), '3084C')
  assert.equal(hwndHex('0x3084c'), '3084C')
  assert.equal(hwndHex(267386), '4147A')
  assert.equal(hwndHex('267386'), '4147A')
  assert.equal(hwndHex(null), '?')
  assert.equal(hwndHex(''), '?')
})

test('fmtDesktops 标出当前桌面并提醒序号不稳定', () => {
  const text = fmtDesktops({
    desktopCount: 2,
    currentDesktopId: 'aaaa',
    desktops: [
      { id: 'aaaa', name: '主页面', index: 0, isCurrent: true, windowCount: 3 },
      { id: 'bbbb', name: 'AI 工作桌面', index: 1, isCurrent: false, windowCount: 0 },
    ],
  })
  assert.match(text, /共 2 个虚拟桌面/)
  assert.match(text, /▶ \[0\] "主页面"/)
  assert.match(text, /用户正在这个桌面/)
  assert.match(text, /不要持久化序号/)
})

test('fmtCurrentDesktop 给出 id、名字和总数', () => {
  const text = fmtCurrentDesktop({ desktopId: 'aaaa', name: '主页面', desktopCount: 2 })
  assert.match(text, /aaaa/)
  assert.match(text, /主页面/)
  assert.match(text, /共 2 个/)
})

test('fmtWindows 按上限截断并标出最小化/隐藏/无响应', () => {
  const windows = Array.from({ length: 130 }, (_, i) => ({
    hwnd: (0x1000 + i).toString(16),
    pid: 100 + i,
    processName: 'x.exe',
    title: `w${i}`,
    visible: true,
    minimized: i === 0,
    notResponding: i === 1,
    virtualDesktopId: 'aaaa',
    onCurrentDesktop: true,
  }))
  const text = fmtWindows({ windows, totalMatched: 130, note: '提示：序号不稳定' })
  assert.match(text, /匹配到 130 个顶层窗口/)
  assert.match(text, /只返回前 120 个/)
  assert.match(text, /另有 10 个窗口未列出/)
  assert.match(text, /最小化/)
  assert.match(text, /无响应/)
  assert.match(text, /提示：序号不稳定/)
})

test('fmtCapture 明确区分正常画面和空白画面', () => {
  const ok = fmtCapture({
    path: 'C:/x/a.png',
    width: 800,
    height: 600,
    bytes: 1234,
    printWindowFlags: 2,
    printWindowOk: true,
    qualityVerdict: 'ok',
    dominantColorShare: 0.68,
    dominantColor: '#FFFFFF',
    sampledDistinctColors: 114,
    hints: [],
  })
  assert.match(ok, /画面有实际内容/)
  assert.match(ok, /C:\/x\/a\.png/)

  const blank = fmtCapture({
    path: 'C:/x/b.png',
    width: 800,
    height: 600,
    bytes: 99,
    printWindowFlags: 2,
    printWindowOk: false,
    qualityVerdict: 'blank_or_uncapturable',
    suspectedBlank: true,
    hints: ['该窗口可能是 GPU 直出'],
  })
  assert.match(blank, /不能当作"软件运行正常"/)
  assert.match(blank, /排查方向/)
  assert.match(blank, /GPU 直出/)
})

test('fmtMove 处理 already_on_target 与复查失败', () => {
  const same = fmtMove({ moved: false, reason: 'already_on_target', hwnd: '4147A', desktopId: 'bbbb' })
  assert.match(same, /本来就在桌面 bbbb/)
  assert.match(same, /0x4147A/)

  const unverified = fmtMove({ moved: true, hwnd: '4147A', desktopId: 'bbbb', verified: false, channel: 'internal' })
  assert.match(unverified, /内部 IVirtualDesktopManagerInternal 回退/)
  assert.match(unverified, /复查没通过/)
})

test('fmtLaunch 把抢前台、样式未生效、兜底匹配都说清楚', () => {
  const text = fmtLaunch({
    pid: 100,
    processName: 'Notepad.exe',
    hwnd: '5147C',
    windowTitle: '记事本',
    movedTo: 'bbbb',
    foregroundStolen: true,
    windowStyleRequested: 'minimized',
    windowStyleApplied: true,
    windowMatchedByPid: false,
  })
  assert.match(text, /已启动：Notepad.exe \(PID 100\)/)
  assert.match(text, /已移动到桌面 bbbb/)
  assert.match(text, /前台窗口没被抢|抢走了前台窗口/)
  assert.match(text, /按进程名兜底匹配/)

  const ignored = fmtLaunch({
    pid: 101,
    processName: 'app.exe',
    windowStyleRequested: 'minimized',
    windowStyleApplied: false,
  })
  assert.match(ignored, /忽略了启动参数/)
  assert.match(ignored, /没找到可见顶层窗口/)
})

test('fmtClose 在疑似等保存时提示不要强杀', () => {
  const dry = fmtClose({
    dryRun: true,
    hwnd: '4147A',
    risk: { level: 'high', reasons: ['标题带 * 号'], processName: 'Notepad.exe', title: 'a.txt*' },
  })
  assert.match(dry, /未执行关闭（dryRun 预演）/)
  assert.match(dry, /未保存内容风险：high/)
  assert.match(dry, /标题带 \* 号/)

  const stuck = fmtClose({ closed: false, hwnd: '4147A', needsUserAttention: true, risk: { level: 'medium', reasons: [] } })
  assert.match(stuck, /窗口还在/)
  assert.match(stuck, /交给用户处理/)
})

test('fmtGameMode 说明当前权限与等待队列', () => {
  const on = fmtGameMode({ gameMode: true, gameModeReason: '用户在玩游戏', pending: [{}, {}] })
  assert.match(on, /已开启/)
  assert.match(on, /用户在玩游戏/)
  assert.match(on, /等待队列：2 条/)
  assert.match(on, /只能由用户显式关闭/)

  const off = fmtGameMode({ gameMode: false, pending: [] })
  assert.match(off, /已关闭/)
  assert.match(off, /等待队列为空/)
})

test('fmtPending 空列表不报错', () => {
  assert.equal(fmtPending([]), '等待队列为空。')
  assert.match(fmtPending([{ ts: '2026-01-01T00:00:00Z', action: 'vdm_move_window', reason: 'game_mode_blocks' }]), /共 1 条/)
})

test('fmtWindowInfo 对前台窗口给出手别碰的警告', () => {
  const text = fmtWindowInfo({
    window: {
      hwnd: '3084C',
      hwndDecimal: 198220,
      pid: 27284,
      processName: 'DeepSeek Harness.exe',
      className: 'Chrome_WidgetWin_1',
      title: 'DSH',
      visible: true,
      minimized: false,
      maximized: false,
      cloaked: false,
      notResponding: false,
      isTopLevel: true,
      isForeground: true,
      rect: { x: 0, y: 0, width: 100, height: 100 },
      virtualDesktopId: 'aaaa',
      onCurrentDesktop: true,
    },
  })
  assert.match(text, /★ 当前前台窗口/)
  assert.match(text, /不要移动也不要关闭它/)
})

test('fmtCapabilities 对不受支持的构建号明确提示未标定', () => {
  const text = fmtCapabilities({
    hostVersion: '0.1.0',
    clr: '4.0.30319.42000',
    osBuild: '26200',
    sessionId: 1,
    is64BitProcess: true,
    integrity: 'Medium (0x2000)',
    desktopApiAvailable: true,
    desktopCount: 3,
    buildSupported: true,
  })
  assert.match(text, /虚拟桌面 COM：可用/)
  assert.match(text, /受支持/)

  const old = fmtCapabilities({ desktopApiAvailable: false, desktopApiError: 'E_ACCESSDENIED', buildSupported: false })
  assert.match(old, /不可用/)
  assert.match(old, /E_ACCESSDENIED/)
  assert.match(old, /未标定/)
})
