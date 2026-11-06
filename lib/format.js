// 把原生助手的结构化结果渲染成给模型/用户看的中文文本。
// 原则：先给结论，再给明细；潜在风险（抢前台、空白截图、未保存改动）必须显式写出来，
// 不能让调用方只看到一个 ok。字段名以原生层的实测输出为准（见 native/Support/*.cs 的 ToJson）。

const MAX_WINDOWS = 120

/** 原生层给的是十六进制字符串（"3084C"）；也兼容传进来的十进制数字或 "0x" 前缀。 */
export function hwndHex(value) {
  if (value == null) return '?'
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString(16).toUpperCase()
  const s = String(value).trim()
  if (s === '') return '?'
  if (/^0x[0-9a-f]+$/i.test(s)) return s.slice(2).toUpperCase()
  if (/^\d+$/.test(s)) return Math.trunc(Number(s)).toString(16).toUpperCase()
  return s.toUpperCase()
}

export function fmtDesktops(data) {
  const list = Array.isArray(data?.desktops) ? data.desktops : []
  const lines = [`共 ${data?.desktopCount ?? list.length} 个虚拟桌面，当前显示的是：${data?.currentDesktopId ?? '(未知)'}`]
  lines.push('')
  for (const d of list) {
    const mark = d.isCurrent ? '▶' : ' '
    const name = d.name ? `"${d.name}"` : '(未命名)'
    lines.push(
      `${mark} [${d.index}] ${name}  ${d.id}  窗口 ${d.windowCount ?? 0} 个${d.isCurrent ? '  ← 用户正在这个桌面' : ''}`,
    )
  }
  lines.push('')
  lines.push('id 是 GUID，唯一稳定；index 只是当前排列顺序，用户增删桌面就会变，不要持久化序号。')
  return lines.join('\n')
}

export function fmtCurrentDesktop(data) {
  return `当前显示的桌面：${data?.desktopId ?? '(未知)'}${data?.name ? `（"${data.name}"）` : ''}，共 ${data?.desktopCount ?? '?'} 个桌面。`
}

export function fmtCreateDesktop(data) {
  if (data?.reused) {
    return [
      `复用了已存在的桌面：${data.desktop?.id ?? data.desktopId}`,
      data.desktop?.name ? `名称："${data.desktop.name}"` : '该桌面没有名字。',
      '没有新建，也没有切换用户当前桌面。',
    ].join('\n')
  }
  const lines = [`已新建桌面：${data?.desktop?.id ?? data?.desktopId}`]
  if (data?.desktop?.name) lines.push(`名称："${data.desktop.name}"`)
  if (data?.currentDesktopChanged) {
    lines.push('⚠ 新建之后用户当前桌面发生了变化（Windows 在个别版本上会这样）。')
    lines.push('  请让用户确认并手动切回原桌面，不要自己再切一次。')
  } else {
    lines.push('用户当前使用的桌面没有被切换。')
  }
  return lines.join('\n')
}

export function fmtMove(data) {
  if (data?.moved === false && data?.reason === 'already_on_target') {
    return `窗口 0x${hwndHex(data.hwnd)} 本来就在桌面 ${data.desktopId} 上，无需移动。`
  }
  const lines = [
    `已把窗口 0x${hwndHex(data.hwnd)} 移到桌面 ${data.desktopId}（${data?.channel === 'public' ? '官方 IVirtualDesktopManager' : data?.channel === 'internal' ? '内部 IVirtualDesktopManagerInternal 回退' : data?.channel ?? '未知通道'}）`,
  ]
  if (data?.previousDesktopId) lines.push(`移动前属于：${data.previousDesktopId}`)
  if (data?.verified === false) lines.push('⚠ 移动后复查没通过，窗口可能还在原桌面，请用 vdm_list_windows 再确认。')
  if (data?.detail) lines.push(`细节：${data.detail}`)
  return lines.join('\n')
}

export function fmtWindows(data) {
  const list = Array.isArray(data?.windows) ? data.windows : []
  const total = data?.totalMatched ?? list.length
  const shown = Math.min(list.length, MAX_WINDOWS)
  const lines = [`匹配到 ${total} 个顶层窗口${shown < total ? `，只返回前 ${shown} 个` : ''}。`]
  lines.push('')
  for (const w of list.slice(0, MAX_WINDOWS)) {
    const flags = []
    if (w.minimized) flags.push('最小化')
    if (!w.visible) flags.push('隐藏')
    if (w.cloaked) flags.push('cloaked')
    if (w.notResponding) flags.push('无响应')
    const desktop = w.virtualDesktopId ? (w.onCurrentDesktop ? '当前桌面' : w.virtualDesktopId.slice(0, 8)) : '无视图'
    lines.push(
      `0x${hwndHex(w.hwnd)}  ${String(w.processName || '?').padEnd(20)} ${String(w.pid).padStart(6)}  ${desktop.padEnd(10)} ${(flags.join('/') || '正常').padEnd(6)}  ${clip(w.title, 52) || '(无标题)'}`,
    )
  }
  if (list.length > MAX_WINDOWS) lines.push(`…另有 ${list.length - MAX_WINDOWS} 个窗口未列出`)
  if (data?.note) {
    lines.push('')
    lines.push(data.note)
  }
  return lines.join('\n')
}

export function fmtWindowInfo(data) {
  const w = data?.window || data
  if (!w) return '没有拿到窗口信息。'
  const rect = w.rect || {}
  const lines = [
    `HWND 0x${hwndHex(w.hwnd)}（十进制 ${w.hwndDecimal ?? '?'}）  进程 ${w.processName} (PID ${w.pid})`,
    `标题：${w.title || '(空)'}`,
    `类名：${w.className || '(未知)'}`,
  ]
  if (w.processPath) lines.push(`路径：${w.processPath}`)
  lines.push(`所属桌面：${w.virtualDesktopId || '取不到（窗口可能还没进 shell 视图集合，或已被隐藏）'}`)
  const state = []
  state.push(w.visible ? '可见' : '隐藏')
  if (w.minimized) state.push('最小化')
  if (w.maximized) state.push('最大化')
  if (w.cloaked) state.push('cloaked')
  if (w.notResponding) state.push('无响应')
  if (w.isForeground) state.push('★ 当前前台窗口')
  lines.push(`状态：${state.join(' / ')}`)
  lines.push(`位置：(${rect.x ?? '?'}, ${rect.y ?? '?'}) ${rect.width ?? '?'}×${rect.height ?? '?'}`)
  if (w.isForeground) lines.push('', '⚠ 这是用户正在操作的窗口。除非用户明确同意，不要移动也不要关闭它。')
  return lines.join('\n')
}

export function fmtCapture(data) {
  const lines = []
  const verdict = data?.qualityVerdict || 'unknown'
  if (verdict === 'ok') lines.push('截图已保存，画面有实际内容。')
  else lines.push('⚠⚠ 截到的画面是空白/纯色，不能当作"软件运行正常"。')
  lines.push(`文件：${data?.path || '(未写盘)'}`)
  lines.push(`尺寸：${data?.width}×${data?.height}，${data?.bytes ?? '?'} 字节，flags=${data?.printWindowFlags ?? '?'}`)
  if (typeof data?.dominantColorShare === 'number') {
    lines.push(`采样分析：主色 ${data?.dominantColor} 占 ${(data.dominantColorShare * 100).toFixed(1)}%，不同颜色采样点 ${data?.sampledDistinctColors}`)
  }
  if (data?.printWindowOk === false) lines.push('PrintWindow 本身返回失败，这个 PNG 可能只有黑/白底。')
  const hints = Array.isArray(data?.hints) ? data.hints : []
  if (hints.length) {
    lines.push('')
    lines.push('排查方向：')
    for (const h of hints) lines.push(`- ${h}`)
  }
  return lines.join('\n')
}

export function fmtClose(data) {
  const lines = []
  const risk = data?.risk
  if (data?.dryRun) {
    lines.push(`未执行关闭（dryRun 预演）：0x${hwndHex(data.hwnd)} ${risk?.processName || ''} "${clip(risk?.title, 40) || ''}"`)
  } else if (data?.closed) {
    lines.push('已发送 WM_CLOSE，窗口已消失。')
  } else {
    lines.push('已发送 WM_CLOSE，但窗口还在。')
  }
  if (risk) {
    const reasons = Array.isArray(risk.reasons) && risk.reasons.length ? risk.reasons.join('；') : '没有明显风险信号'
    lines.push(`未保存内容风险：${risk.level} — ${reasons}`)
  }
  if (data?.needsUserAttention) {
    lines.push('⚠ 窗口没有关掉，很可能弹了"是否保存"的对话框在等人。不要反复发送关闭请求、不要强杀，交给用户处理。')
  }
  if (data?.how) lines.push(data.how)
  return lines.join('\n')
}

export function fmtLaunch(data) {
  const lines = [`已启动：${data?.processName || ''} (PID ${data?.pid})`]
  if (data?.commandLine) lines.push(`命令行：${clip(data.commandLine, 300)}`)
  if (data?.hwnd) {
    lines.push(`主窗口：0x${hwndHex(data.hwnd)}  ${clip(data.windowTitle, 60) || '(无标题)'}`)
    if (data?.windowMatchedByPid === false) {
      lines.push('（这个窗口是按进程名兜底匹配到的：启动转发壳自己不建窗口，真正的 UI 在另一个进程里。）')
    }
  } else {
    lines.push('等待时间内没找到可见顶层窗口。可能是控制台程序、启动慢、或窗口在子进程里。')
  }
  if (data?.movedTo) lines.push(`已移动到桌面 ${data.movedTo}`)
  if (data?.moveSkipped === 'window_is_foreground') {
    lines.push('⚠ 没有移动窗口：它启动后抢到了前台，为了不换掉用户眼前的画面而跳过。')
  } else if (data?.moveSkipped === 'window_not_found') {
    lines.push('⚠ 没有移动窗口：没找到属于该进程的窗口。')
  }
  if (data?.foregroundStolen === true) {
    lines.push('⚠ 启动过程抢走了前台窗口（用户可能正在游戏或打字）。')
  } else if (data?.foregroundStolen === false) {
    lines.push('前台窗口没被抢。')
  }
  if (data?.windowStyleRequested && data?.windowStyleApplied === false) {
    lines.push(`⚠ 请求的窗口样式 ${data.windowStyleRequested} 没生效——该程序忽略了启动参数。`)
  }
  if (data?.note) {
    lines.push('')
    lines.push(data.note)
  }
  return lines.join('\n')
}

export function fmtCapabilities(data) {
  const lines = []
  lines.push(
    `原生助手 v${data?.hostVersion ?? '?'} · CLR ${data?.clr ?? '?'} · OS build ${data?.osBuild ?? '?'} · session ${data?.sessionId ?? '?'} · ${data?.is64BitProcess ? 'x64' : 'x86'}`,
  )
  lines.push(`进程完整性级别：${data?.integrity ?? '未知'}`)
  lines.push(
    data?.desktopApiAvailable
      ? `虚拟桌面 COM：可用（枚举到 ${data?.desktopCount ?? '?'} 个桌面）`
      : `虚拟桌面 COM：不可用 — ${data?.desktopApiError || '原因未知'}`,
  )
  lines.push(
    data?.buildSupported
      ? '构建号：受支持（>= 26100，即 Windows 11 24H2 及以上）'
      : '构建号：未标定。内置 COM vtable 只对 24H2/25H2 验证过，其他版本请以实测结果为准。',
  )
  return lines.join('\n')
}

export function fmtGameMode(state) {
  if (state?.gameMode) {
    const since = state.gameModeSince ? `，自 ${state.gameModeSince} 起` : ''
    return [
      `Game Mode：已开启${since}`,
      state.gameModeReason ? `原因：${state.gameModeReason}` : '没有记录原因。',
      '',
      '开启期间被禁止：切换虚拟桌面、把可见窗口启动到前台、移动前台窗口、全局键鼠模拟。',
      '仍然允许：窗口级截图、枚举与查询、后台构建与测试、日志收集。',
      `等待队列：${state.pending?.length ?? 0} 条被拦下的请求。`,
      'Game Mode 只能由用户显式关闭，插件不会自行判断游戏是否结束。',
    ].join('\n')
  }
  const pending = state?.pending?.length ?? 0
  return [
    'Game Mode：已关闭（GUI 自动化权限正常）',
    pending ? `等待队列里还有 ${pending} 条 Game Mode 期间被拦下的请求。` : '等待队列为空。',
  ].join('\n')
}

export function fmtPending(list) {
  if (!list?.length) return '等待队列为空。'
  const lines = [`等待队列共 ${list.length} 条（Game Mode 期间被拦下的请求）：`]
  for (const item of list.slice(-50)) {
    lines.push(`- ${item.ts}  ${item.action}  ${item.reason || ''}`)
  }
  if (list.length > 50) lines.push(`…另有 ${list.length - 50} 条更早的记录未列出。`)
  return lines.join('\n')
}

export function fmtRemoveDesktop(data) {
  const lines = [`已删除桌面 ${data?.desktopId}`]
  if (typeof data?.migratedWindows === 'number') lines.push(`系统把 ${data.migratedWindows} 个窗口迁移到了相邻桌面。`)
  return lines.join('\n')
}

export function fmtSwitchDesktop(data) {
  const lines = [`已切换到桌面 ${data?.desktopId ?? ''}`]
  if (data?.verified === false) lines.push('⚠ 切换后复查没通过，当前桌面可能没变。')
  if (data?.previousDesktopId) lines.push(`切换前：${data.previousDesktopId}`)
  return lines.join('\n')
}

export function fmtUiaTree(data) {
  const lines = []
  const nodes = Array.isArray(data?.nodes) ? data.nodes : []
  lines.push(
    `窗口 0x${hwndHex(data?.hwnd)} ${data?.processName || ''} "${clip(data?.title, 40) || ''}" 的控件树：${nodes.length} 个节点`,
  )
  if (data?.rootName || data?.rootType) {
    lines.push(`根节点：${data?.rootType || '?'} "${clip(data?.rootName, 40) || ''}"`)
  }
  if (data?.processName && data?.onCurrentDesktop === false) {
    lines.push('这个窗口在别的虚拟桌面（cloaked）。UIA 读取通常仍然有效，不需要切换桌面；但如果内容明显残缺，可以再看一眼截图。')
  }
  if (data?.truncated) {
    lines.push(`⚠ 节点数达到上限 ${data?.maxNodes}，后面的层级没有展开。可以调大 maxNodes，或用 nameContains 过滤。`)
  }
  if (!nodes.length) {
    lines.push('')
    lines.push('没读到任何控件。常见原因：该程序不实现 UI Automation（自绘界面）、Electron/Chromium 默认不暴露网页内容、或窗口已销毁。')
    return lines.join('\n')
  }

  lines.push('')
  for (const n of nodes) {
    const indent = '  '.repeat(Math.min(Number(n?.depth) || 0, 8))
    const flags = []
    if (n?.interactive) flags.push('可交互')
    if (n?.enabled === false) flags.push('已禁用')
    if (n?.offscreen) flags.push('不可见')
    if (n?.unreadable) flags.push('读不到属性')
    const id = n?.automationId ? ` id=${n.automationId}` : ''
    const cls = n?.className ? ` ${n.className}` : ''
    lines.push(`${indent}[${n?.path ?? '?'}] ${n?.type || '?'} "${clip(n?.name, 40) || ''}"${id}${cls}${flags.length ? ` (${flags.join('、')})` : ''}`)
  }
  if (data?.note) {
    lines.push('')
    lines.push(String(data.note))
  }
  return lines.join('\n')
}

export function fmtUiaAct(data) {
  const lines = []
  const target = `${data?.elementType || '?'} "${clip(data?.elementName, 40) || ''}" [${data?.path ?? '?'}]`
  if (data?.succeeded) {
    lines.push(`已执行 ${data?.action}（pattern: ${data?.pattern || '?'}）→ ${target}`)
    if (data?.detail) lines.push(String(data.detail))
  } else {
    lines.push(`没有执行成功：${data?.action} 没能作用在 ${target} 上。`)
    if (data?.reason) lines.push(`原因：${data.reason}`)
    const supported = Array.isArray(data?.supportedPatterns) ? data.supportedPatterns : []
    if (supported.length) {
      lines.push(`该控件支持：${supported.join('、')}`)
    } else {
      lines.push('该控件没有报告任何可用的 pattern。可以改用 vdm_capture_window 截图 + 人工确认，不要退回坐标点击。')
    }
  }
  if (data?.note) {
    lines.push('')
    lines.push(String(data.note))
  }
  return lines.join('\n')
}

function clip(text, limit) {
  if (!text) return ''
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length <= limit ? s : `${s.slice(0, limit)}…`
}
