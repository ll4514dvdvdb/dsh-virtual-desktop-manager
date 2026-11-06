// dsh-virtual-desktop-manager
//
// 让 Harness 在独立的 Windows 虚拟桌面里启动、管理、截图 GUI 应用。
//
// 分层：
//   index.js（本文件，跑在 DSH 宿主 Medium 进程内）
//     → spawn dist/vdmhost.exe（C#/.NET Framework 4.7.2，一次性进程，JSON over stdio）
//       → COM: IVirtualDesktopManager / IVirtualDesktopManagerInternal / PrintWindow / UIA
//
// 为什么必须是这个分层：DSH 沙箱里的 pwsh 是 Low 完整性，虚拟桌面 COM 会 E_ACCESSDENIED；
// 只有在宿主 Medium 进程里 spawn 出来的子进程才有权限。任何"先跑个脚本试试"的绕法都不成立。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HostError, resolveHostPath, runHost } from './lib/bridge.js'
import * as fmt from './lib/format.js'
import {
  audit,
  auditFile,
  capturesDir,
  clearPending,
  pushPending,
  readState,
  stateDir,
  writeState,
} from './lib/state.js'

export const name = 'virtual-desktop-manager'
export const inject = ['tools']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKSPACE_NAME = 'AI 工作桌面'

// ---------------------------------------------------------------------------
// 输出契约
// ---------------------------------------------------------------------------

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '给人看的中文说明' },
      ok: { type: 'boolean' },
      code: { type: 'string' },
    },
    required: ['text'],
    additionalProperties: true,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

const IMAGE_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      ok: { type: 'boolean' },
      code: { type: 'string' },
      images: { type: 'array', items: { type: 'object' } },
    },
    required: ['text'],
    additionalProperties: true,
  },
  render: (_args, value) => {
    const parts = [{ type: 'text', text: String(value?.text ?? '') }]
    for (const a of value?.images || []) parts.push({ type: 'image', attachment: a })
    return parts
  },
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const cfg = {
    hostPath: config.hostPath || '',
    workspaceDesktopName: config.workspaceDesktopName || DEFAULT_WORKSPACE_NAME,
    defaultTimeoutMs: clampInt(config.defaultTimeoutMs, 5000, 120000, 25000),
    captureTimeoutMs: clampInt(config.captureTimeoutMs, 5000, 120000, 30000),
    audit: config.audit !== false,
    captureDir: config.captureDir || '',
  }

  let hostPathCache = null
  const hostPath = () => {
    if (!hostPathCache) hostPathCache = resolveHostPath(PKG_DIR, cfg)
    return hostPathCache
  }

  const call = (command, payload, opts = {}) =>
    runHost(hostPath(), command, payload, {
      timeoutMs: opts.timeoutMs ?? cfg.defaultTimeoutMs,
      signal: opts.signal,
    })

  ctx.logger?.info?.(`[virtual-desktop] 已加载，原生助手：${safeHostPath(hostPath)}，状态目录：${stateDir()}`)

  // -------------------------------------------------------------------------
  // 通用执行壳：Game Mode 拦截 → 审计 → 错误归一化
  // -------------------------------------------------------------------------

  async function executeTool(spec, args, exec) {
    const started = Date.now()
    const record = { tool: spec.name, args: compactArgs(args) }

    const blocked = spec.gate ? await spec.gate(args) : null
    if (blocked) {
      if (blocked.queue !== false) {
        try {
          pushPending({ action: spec.name, reason: blocked.reason || blocked.code, args: compactArgs(args) })
        } catch {
          /* 队列写失败不影响拒绝 */
        }
      }
      if (cfg.audit) {
        audit({ ...record, ok: false, code: blocked.code, blockedBy: 'gate', elapsedMs: Date.now() - started })
      }
      return { ok: false, code: blocked.code, text: blocked.text }
    }

    try {
      const value = await spec.run(args, exec)
      if (cfg.audit) audit({ ...record, ok: true, elapsedMs: Date.now() - started })
      return value
    } catch (err) {
      const text = describeError(err, spec.name)
      if (cfg.audit) {
        audit({
          ...record,
          ok: false,
          code: err?.code || 'unknown',
          hresult: err?.hresult || null,
          elapsedMs: Date.now() - started,
          message: err?.message ? String(err.message).slice(0, 500) : '',
        })
      }
      return { ok: false, code: err?.code || 'unknown', text }
    }
  }

  // -------------------------------------------------------------------------
  // Game Mode 判定
  // -------------------------------------------------------------------------

  const gameModeOn = () => {
    try {
      return readState().gameMode === true
    } catch {
      // 读不到状态时按"开启"保守处理，宁可少做动作
      return true
    }
  }

  function gameModeBlock(action, { allowsMinimizedOnly = false } = {}) {
    return async (args) => {
      if (!gameModeOn()) return null
      if (args?.allowInGameMode === true) {
        if (allowsMinimizedOnly) {
          const style = String(args?.windowStyle || 'normal').toLowerCase()
          if (style === 'normal') {
            return {
              code: 'game_mode_blocks_visible_window',
              reason: `${action}：Game Mode 下不允许以普通可见窗口方式启动`,
              text: [
                'Game Mode 已开启，这次启动会弹出可见窗口，已拒绝。',
                '如果这个程序确实只服务后台测试（无界面或最小化/隐藏启动），请重试并显式传 windowStyle: "minimized" 或 "hidden"，同时带上 allowInGameMode: true。',
                '需要用户桌面真正让出来时，请让用户手动关闭 Game Mode。',
              ].join('\n'),
            }
          }
        }
        return null
      }
      return {
        code: 'game_mode_blocks',
        reason: `${action}：Game Mode 下禁止`,
        text: [
          `Game Mode 已开启，${action} 被拒绝（这条请求已进等待队列）。`,
          'Game Mode 期间允许：枚举/查询窗口与桌面、窗口级截图、后台构建与测试。',
          '需要真正执行时：请用户在 Game Mode 面板里显式关闭它，而不是由你自行判断游戏已结束。',
        ].join('\n'),
      }
    }
  }

  // -------------------------------------------------------------------------
  // 工具注册
  // -------------------------------------------------------------------------

  const tools = []

  const register = (spec) => {
    tools.push(spec)
    ctx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: spec.output || TEXT_OUTPUT,
      timeoutMs: spec.timeoutMs || cfg.defaultTimeoutMs + 5000,
      execute: (args = {}, exec = {}) => executeTool(spec, args, exec),
    })
  }

  // 1. 诊断 ----------------------------------------------------------------
  register({
    name: 'vdm_capabilities',
    description:
      '【先跑这个】检测虚拟桌面原生助手的可用性：完整性级别、COM 是否可调、Windows 构建号是否受支持、当前桌面数量。任何一次"接口莫名失败"都先回到这里看原因。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await call('capabilities', {})
      const data = { ...r.data, hostPath: hostPath() }
      return { ok: true, text: fmt.fmtCapabilities(data), data }
    },
  })

  // 2. 枚举桌面 ------------------------------------------------------------
  register({
    name: 'vdm_list_desktops',
    description:
      '列出所有 Windows 虚拟桌面：GUID、名称、序号、是否当前桌面、各桌面上的窗口数。GUID 是唯一稳定标识，序号会随用户增删桌面变化，不要持久化序号。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await call('list_desktops', {})
      return { ok: true, text: fmt.fmtDesktops(r.data), data: r.data }
    },
  })

  // 3. 当前桌面 ------------------------------------------------------------
  register({
    name: 'vdm_get_current_desktop',
    description:
      '查询用户当前正在看的虚拟桌面（GUID）。注意：这是"正在显示"的桌面，不是"AI 工作桌面"，两者通常不同。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await call('get_current_desktop', {})
      return { ok: true, text: fmt.fmtCurrentDesktop(r.data), data: r.data }
    },
  })

  // 4. 创建桌面 ------------------------------------------------------------
  register({
    name: 'vdm_create_desktop',
    description:
      '创建（或按名字复用）一个虚拟桌面。默认按名字复用已存在的同名桌面，不会重复创建。正常情况下不会切换用户当前桌面；如果某些 Windows 版本上发生了切换，返回值里会有 currentDesktopChanged 告警。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '桌面名称，例如 "AI 工作桌面"。留空则创建无名桌面。' },
        reuseExistingName: {
          type: 'boolean',
          description: '同名桌面已存在时直接复用而不是新建，默认 true。',
        },
        allowInGameMode: { type: 'boolean', description: 'Game Mode 下是否允许（默认不允许）。' },
      },
      additionalProperties: false,
    },
    gate: gameModeBlock('创建虚拟桌面'),
    run: async (args) => {
      const r = await call('create_desktop', {
        name: args.name || undefined,
        reuseExistingName: args.reuseExistingName !== false,
      })
      const text = [fmt.fmtCreateDesktop(r.data), ...r.warnings.map((w) => `⚠ ${w}`)].join('\n')
      if (r.data?.desktopId) {
        try {
          writeState({ workspaceDesktopId: r.data.deleted ? null : r.data.desktopId })
        } catch {
          /* 记不住就记不住，不影响创建结果 */
        }
      }
      return { ok: true, text, data: r.data }
    },
  })

  // 5. AI 工作桌面（识别 / 复用 / 创建）------------------------------------
  register({
    name: 'vdm_ensure_workspace_desktop',
    description:
      `确保持有一个"AI 工作桌面"并返回它的 GUID：先按名字查，查不到就创建，查到了就复用（默认名字 "${DEFAULT_WORKSPACE_NAME}" 可用 workspaceDesktopName 配置改）。后续所有 launch/move 都用这个 GUID 作为目标桌面。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `桌面名称，默认 "${DEFAULT_WORKSPACE_NAME}"。` },
        allowInGameMode: { type: 'boolean', description: 'Game Mode 下是否允许创建（默认不允许；已有同名桌面时只是查询，不会创建）。' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const wanted = (args.name || cfg.workspaceDesktopName || DEFAULT_WORKSPACE_NAME).trim()
      // 先纯查询，避免在 Game Mode 下因为"已经有桌面"却被 gate 挡住
      const list = await call('list_desktops', {})
      const found = (list.data?.desktops || []).find((d) => d.name && d.name === wanted)
      if (found) {
        try {
          writeState({ workspaceDesktopId: found.id, workspaceDesktopName: wanted })
        } catch {
          /* ignore */
        }
        return {
          ok: true,
          desktopId: found.id,
          text: [
            `已复用现有 AI 工作桌面："${wanted}"`,
            `GUID：${found.id}`,
            found.isCurrent ? '⚠ 这个桌面当前正显示给用户，之后往里启动窗口会直接出现在用户眼前。' : '该桌面当前不显示，对它操作不会打扰用户。',
            `里面的窗口：${found.windowCount ?? 0} 个`,
          ].join('\n'),
          // data 里也放一份 desktopId：两个分支的 data 结构要一致，否则调用方得写兼容代码
          data: { ...found, desktopId: found.id },
        }
      }

      if (gameModeOn() && args.allowInGameMode !== true) {
        const p = pushPending({ action: 'ensure_workspace_desktop', reason: `AI 工作桌面 "${wanted}" 不存在，需要创建`, args: { name: wanted } })
        return {
          ok: false,
          code: 'game_mode_blocks',
          text: [
            `Game Mode 已开启，而 AI 工作桌面 "${wanted}" 还不存在，需要新建桌面才能继续，已拒绝并进等待队列（第 ${p} 条）。`,
            '两个选择：让用户手动创建一个叫这个名字的桌面，或让用户在 Game Mode 面板里关闭 Game Mode 后重试。',
          ].join('\n'),
        }
      }

      const created = await call('create_desktop', { name: wanted, reuseExistingName: true })
      // 原生层两种返回形态都见过：顶层 desktopId，或嵌套 desktop.id。两个都认，别让 GUID 变 undefined。
      const newDesktopId = created.data?.desktopId ?? created.data?.desktop?.id ?? null
      if (newDesktopId) {
        try {
          writeState({ workspaceDesktopId: newDesktopId, workspaceDesktopName: wanted })
        } catch {
          /* ignore */
        }
      }
      const text = [
        created.data?.reused ? `已复用 AI 工作桌面："${wanted}"` : `已创建 AI 工作桌面："${wanted}"`,
        `GUID：${newDesktopId ?? '(原生层没有返回 GUID，请用 vdm_list_desktops 按名字找)'}`,
        created.data?.currentDesktopChanged
          ? '⚠ 创建后用户当前桌面发生了变化，请让用户确认并手动切回。'
          : '用户当前使用的桌面没有被切换。',
        ...created.warnings.map((w) => `⚠ ${w}`),
      ].join('\n')
      return {
        ok: true,
        desktopId: newDesktopId,
        text,
        data: newDesktopId ? { ...created.data, desktopId: newDesktopId } : created.data,
      }
    },
  })

  // 6. 切换桌面（必须授权）-------------------------------------------------
  register({
    name: 'vdm_switch_desktop',
    description:
      '切换用户当前显示的虚拟桌面。这是唯一会直接改变用户眼前画面的操作，因此必须显式传 authorized:true，且 Game Mode 下一律拒绝。除非用户明确要求，不要调用。',
    parameters: {
      type: 'object',
      properties: {
        desktopId: { type: 'string', description: '目标桌面 GUID。与 name 二选一。' },
        name: { type: 'string', description: '目标桌面名称。' },
        authorized: { type: 'boolean', description: '必须为 true，表示用户已明确同意切屏。' },
      },
      additionalProperties: false,
    },
    gate: async (args) => {
      if (args?.authorized !== true) {
        return {
          code: 'not_authorized',
          queue: false,
          text: [
            '拒绝执行：switch_desktop 会直接改变用户眼前的画面，必须显式传 authorized: true。',
            '只有在用户明确说"切到那个桌面"之后才应该传这个参数；不要为了完成测试而自作主张切屏。',
          ].join('\n'),
        }
      }
      return gameModeBlock('切换虚拟桌面')(args)
    },
    run: async (args) => {
      let desktopId = args.desktopId
      if (!desktopId) {
        if (!args.name) throw new HostError('missing_target', '需要 desktopId 或 name 之一')
        const list = await call('list_desktops', {})
        const hit = (list.data?.desktops || []).find((d) => d.name === args.name)
        if (!hit) throw new HostError('desktop_not_found', `没有名为 "${args.name}" 的桌面`)
        desktopId = hit.id
      }
      const r = await call('switch_desktop', { desktopId, authorized: true })
      return { ok: true, text: fmt.fmtSwitchDesktop(r.data), data: r.data }
    },
  })

  // 7. 删除桌面（破坏性，要求授权）----------------------------------------
  register({
    name: 'vdm_remove_desktop',
    description:
      '删除一个虚拟桌面，系统会把该桌面上的窗口迁移到相邻桌面。破坏性操作，必须显式传 authorized:true；不允许删掉最后一个桌面。',
    parameters: {
      type: 'object',
      properties: {
        desktopId: { type: 'string', description: '要删除的桌面 GUID。' },
        authorized: { type: 'boolean', description: '必须为 true。' },
        allowInGameMode: { type: 'boolean' },
      },
      required: ['desktopId'],
      additionalProperties: false,
    },
    gate: async (args) => {
      if (args?.authorized !== true) {
        return {
          code: 'not_authorized',
          queue: false,
          text: '拒绝执行：删除桌面会迁移其上的所有窗口，属于破坏性操作，必须显式传 authorized: true。',
        }
      }
      return gameModeBlock('删除虚拟桌面')(args)
    },
    run: async (args) => {
      const r = await call('remove_desktop', { desktopId: args.desktopId })
      try {
        const st = readState()
        if (st.workspaceDesktopId === args.desktopId) writeState({ workspaceDesktopId: null })
      } catch {
        /* ignore */
      }
      return { ok: true, text: fmt.fmtRemoveDesktop(r.data), data: r.data }
    },
  })

  // 8. 列出窗口 ------------------------------------------------------------
  register({
    name: 'vdm_list_windows',
    description:
      '列出顶层窗口：HWND、PID、进程名、标题、所属虚拟桌面、是否在当前桌面。支持按桌面/PID/进程名/标题过滤。默认只列有可见性意义的窗口，includeHidden 可看全部。',
    parameters: {
      type: 'object',
      properties: {
        includeHidden: { type: 'boolean', description: '包含隐藏窗口，默认 false。' },
        desktopId: { type: 'string', description: '只看某个桌面上的窗口。' },
        pid: { type: 'number', description: '只看某个进程的窗口。' },
        processName: { type: 'string', description: '进程名包含该字符串（不区分大小写），如 "chrome"。' },
        titleContains: { type: 'string', description: '标题包含该字符串。' },
        limit: { type: 'number', description: '最多返回多少条，默认 100，上限 500。' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await call('list_windows', {
        includeHidden: args.includeHidden === true,
        desktopId: args.desktopId || undefined,
        pid: args.pid != null ? Math.trunc(Number(args.pid)) : undefined,
        processName: args.processName || undefined,
        titleContains: args.titleContains || undefined,
        limit: clampInt(args.limit, 1, 500, 100),
      })
      return { ok: true, text: fmt.fmtWindows(r.data), data: r.data }
    },
  })

  // 9. 单个窗口详情 --------------------------------------------------------
  register({
    name: 'vdm_window_info',
    description:
      '查询单个窗口的详细信息：进程、路径、类名、所属桌面、可见/最小化/cloaked/无响应、是否当前前台窗口、位置尺寸。移动或截图之前先用它确认目标。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: ['string', 'number'], description: '窗口句柄，支持十进制或 "0x1A2B3C" 十六进制。' },
      },
      required: ['hwnd'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await call('window_info', { hwnd: String(args.hwnd) })
      return { ok: true, text: fmt.fmtWindowInfo(r.data), data: r.data }
    },
  })

  // 10. 移动窗口 -----------------------------------------------------------
  register({
    name: 'vdm_move_window',
    description:
      '把指定窗口移动到指定虚拟桌面。硬性保护：如果目标窗口正是用户当前的前台窗口（比如游戏），原生层会直接拒绝，除非显式传 allowForeground:true 且用户已同意。移动不会让该窗口获得焦点。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: ['string', 'number'], description: '窗口句柄。' },
        desktopId: { type: 'string', description: '目标桌面 GUID。' },
        allowForeground: { type: 'boolean', description: '允许移动当前前台窗口（危险，默认 false）。' },
        allowInGameMode: {
          type: 'boolean',
          description:
            'Game Mode 下是否允许移动（默认拒绝）。Game Mode 期间只有前台窗口会被原生层硬拦，后台窗口拦不住，所以默认一律不动；确认目标不是用户正在用的东西再传 true。',
        },
      },
      required: ['hwnd', 'desktopId'],
      additionalProperties: false,
    },
    gate: gameModeBlock('移动窗口'),
    run: async (args) => {
      if (gameModeOn() && args.allowForeground === true) {
        throw new HostError('game_mode_blocks', 'Game Mode 下不允许移动前台窗口')
      }
      const r = await call('move_window', {
        hwnd: String(args.hwnd),
        desktopId: args.desktopId,
        allowForeground: args.allowForeground === true && !gameModeOn(),
      })
      const text = [fmt.fmtMove(r.data), ...r.warnings.map((w) => `⚠ ${w}`)].join('\n')
      return { ok: true, text, data: r.data }
    },
  })

  // 11. 启动程序 -----------------------------------------------------------
  register({
    name: 'vdm_launch_in_desktop',
    description:
      '启动一个 EXE 并（可选）把它的主窗口移到指定虚拟桌面。会返回 PID、匹配到的 HWND、是否抢走了前台、以及窗口样式是否真的生效（有些程序会忽略最小化参数）。注意：窗口创建的那一瞬间一定先出现在当前显示的桌面上，随后才被移走——这是虚拟桌面的固有行为，无法完全消除。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '可执行文件路径（绝对路径，或 PATH 中能找到的名字）。' },
        args: { type: 'array', items: { type: 'string' }, description: '命令行参数数组。' },
        cwd: { type: 'string', description: '工作目录。' },
        desktopId: { type: 'string', description: '启动后把主窗口移动到哪个桌面（推荐传 AI 工作桌面的 GUID）。' },
        windowStyle: {
          type: 'string',
          enum: ['normal', 'minimized', 'hidden'],
          description: '期望的窗口样式，默认 normal。minimized/hidden 可能被程序忽略，返回值会告诉你是否真的生效。',
        },
        waitForWindowMs: { type: 'number', description: '等待主窗口出现的最长时间，默认 8000，上限 60000。' },
        avoidForegroundMove: {
          type: 'boolean',
          description:
            '默认 false：即使新窗口抢到前台，也照样把它移到目标桌面（它正是那个该被移走的窗口）。设为 true 则抢到前台就放弃移动。',
        },
        allowInGameMode: { type: 'boolean', description: 'Game Mode 下是否允许启动（默认不允许）。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    timeoutMs: 90000,
    gate: gameModeBlock('启动 GUI 程序', { allowsMinimizedOnly: true }),
    run: async (args) => {
      const exePath = normalizeExePath(args.path, args.cwd)
      const r = await call(
        'launch',
        {
          path: exePath,
          args: Array.isArray(args.args) ? args.args.map(String) : [],
          cwd: args.cwd || undefined,
          desktopId: args.desktopId || undefined,
          windowStyle: args.windowStyle || 'normal',
          waitForWindowMs: clampInt(args.waitForWindowMs, 0, 60000, 8000),
          avoidForegroundMove: args.avoidForegroundMove === true,
        },
        { timeoutMs: Math.max(cfg.defaultTimeoutMs, 60000) },
      )
      const text = [fmt.fmtLaunch(r.data), ...r.warnings.map((w) => `⚠ ${w}`)].join('\n')
      return { ok: true, text, data: r.data }
    },
  })

  // 12. 窗口截图 -----------------------------------------------------------
  register({
    name: 'vdm_capture_window',
    description:
      '只截取指定窗口（PrintWindow，可选 PW_RENDERFULLCONTENT），不截整个屏幕，因此不影响用户当前在做什么。会做空白/纯色检测：GPU 直出或受保护内容可能截出空白，返回的 qualityVerdict 会明确标出，不允许把空白当正常。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: ['string', 'number'], description: '窗口句柄。' },
        clientOnly: { type: 'boolean', description: '只截客户区（不含标题栏/边框），默认 false。' },
        allowRestore: {
          type: 'boolean',
          description: '窗口最小化时是否允许用 SW_SHOWNOACTIVATE 还原它（不会激活、不抢前台），默认 true。',
        },
        strict: { type: 'boolean', description: '检测到疑似空白时直接报错而不是返回文件，默认 false。' },
        fileName: { type: 'string', description: '自定义文件名（不含路径），默认按时间戳自动命名。' },
      },
      required: ['hwnd'],
      additionalProperties: false,
    },
    output: IMAGE_OUTPUT,
    timeoutMs: 60000,
    run: async (args, exec) => {
      const dir = cfg.captureDir ? resolve(cfg.captureDir) : capturesDir()
      const hwndText = String(args.hwnd)
      const safeName = sanitizeFileName(args.fileName) || `${stamp()}_${hwndText.replace(/[^0-9a-fx]/gi, '')}.png`
      const outputPath = join(dir, safeName.endsWith('.png') ? safeName : `${safeName}.png`)
      const r = await call(
        'capture_window',
        {
          hwnd: hwndText,
          clientOnly: args.clientOnly === true,
          allowRestore: args.allowRestore !== false,
          strict: args.strict === true,
          outputPath,
        },
        { timeoutMs: cfg.captureTimeoutMs, signal: exec?.signal },
      )
      const attached = await attachImage(ctx, r.data?.path)
      const text = [fmt.fmtCapture(r.data), attached.note, ...r.warnings.map((w) => `⚠ ${w}`)]
        .filter(Boolean)
        .join('\n')
      return { ok: true, text, images: attached.images, data: r.data }
    },
  })

  // 12.5 UIA 控件树 --------------------------------------------------------
  register({
    name: 'vdm_uia_tree',
    description:
      '用 UI Automation 读取指定窗口的控件树（类型/名称/自动 ID/是否可交互/位置）。只读：不点击、不输入、不需要目标在前台、不需要切换桌面，因此不影响用户当前正在做的事。已知边界：Electron/Chromium 应用默认不向 UIA 暴露网页内容；微信等自绘界面可能只有外壳；窗口在别的虚拟桌面时内容也可能退化。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: ['string', 'number'], description: '窗口句柄。' },
        maxDepth: { type: 'number', description: '最大深度，默认 3，上限 12。' },
        maxNodes: { type: 'number', description: '最大节点数，默认 150，上限 800。调大能看更多，也会更慢。' },
        nameContains: {
          type: 'string',
          description: '只保留名称/自动 ID/类名/类型里包含该子串的节点（根节点始终保留）。',
        },
      },
      required: ['hwnd'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: cfg.defaultTimeoutMs,
    run: async (args) => {
      const r = await call('uia_tree', {
        hwnd: String(args.hwnd),
        maxDepth: clampInt(args.maxDepth, 0, 12, 3),
        maxNodes: clampInt(args.maxNodes, 1, 800, 150),
        nameContains: args.nameContains == null ? '' : String(args.nameContains),
      })
      const text = [fmt.fmtUiaTree(r.data), ...r.warnings.map((w) => `⚠ ${w}`)].join('\n')
      return { ok: true, text, data: r.data }
    },
  })

  // 12.6 UIA 控件操作 ------------------------------------------------------
  register({
    name: 'vdm_uia_act',
    description:
      '对指定控件执行一个 UI Automation 动作（invoke/setvalue/toggle/expand/collapse/select/focus/scroll）。不需要鼠标键盘、不按屏幕坐标、不需要目标在前台，所以不会打到用户正在操作的窗口上。path 来自 vdm_uia_tree，只在这一瞬间有效。控件不支持该动作时返回 succeeded:false 并列出它支持的 pattern，绝不退回坐标点击。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: ['string', 'number'], description: '窗口句柄。' },
        path: { type: 'string', description: '控件路径，如 "0/2/1"；空字符串表示窗口根节点。' },
        action: {
          type: 'string',
          enum: ['invoke', 'setvalue', 'toggle', 'expand', 'collapse', 'select', 'focus', 'scroll'],
          description: '要执行的动作。focus 会改变前台焦点，Game Mode 下始终禁止。',
        },
        value: { type: 'string', description: 'setvalue 要写入的文本（其它动作忽略）。' },
        allowInGameMode: {
          type: 'boolean',
          description: 'Game Mode 下是否允许（默认拒绝）。focus 即使传 true 也不允许。',
        },
      },
      required: ['hwnd', 'path', 'action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    timeoutMs: cfg.defaultTimeoutMs,
    gate: async (args) => {
      if (!gameModeOn()) return null
      const action = String(args?.action || '').toLowerCase()
      if (action === 'focus') {
        return {
          code: 'game_mode_blocks',
          reason: 'UIA focus：Game Mode 下禁止改变前台焦点',
          queue: false,
          text: [
            'Game Mode 已开启，focus 会把焦点交给目标控件，可能把目标窗口提到前台，因此即使 allowInGameMode:true 也不允许。',
            '其余动作（invoke/setvalue/toggle/expand/collapse/select/scroll）不改变前台窗口，可以带 allowInGameMode: true 重试。',
          ].join('\n'),
        }
      }
      if (args?.allowInGameMode === true) return null
      return {
        code: 'game_mode_blocks',
        reason: 'UIA 动作：Game Mode 下默认不操作系统控件',
        text: [
          'Game Mode 已开启，UIA 动作默认被拦住（已进等待队列）。',
          '如果确定目标窗口不是用户正在用的程序、且动作不是 focus，可以带 allowInGameMode: true 重试。',
          '只读的 vdm_uia_tree 不受限制，随时可用。',
        ].join('\n'),
      }
    },
    run: async (args) => {
      const r = await call('uia_act', {
        hwnd: String(args.hwnd),
        path: args.path == null ? '' : String(args.path),
        action: String(args.action),
        value: args.value == null ? '' : String(args.value),
      })
      const text = [fmt.fmtUiaAct(r.data), ...r.warnings.map((w) => `⚠ ${w}`)].join('\n')
      return { ok: true, text, data: r.data }
    },
  })

  // 13. 关闭窗口 -----------------------------------------------------------
  register({
    name: 'vdm_close_window',
    description:
      '向窗口发送 WM_CLOSE（不是强杀）。默认 dryRun:true 只评估未保存内容风险，不真关。风险等级 high 时必须显式 force:true。前台窗口在 Game Mode 下不允许关闭。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: ['string', 'number'], description: '窗口句柄。' },
        dryRun: { type: 'boolean', description: '只评估风险、不实际关闭，默认 true。' },
        force: { type: 'boolean', description: '风险等级为 high 时仍执行关闭，默认 false。' },
        waitMs: { type: 'number', description: '发送后等待窗口消失的时间，默认 1500。' },
        allowInGameMode: { type: 'boolean' },
      },
      required: ['hwnd'],
      additionalProperties: false,
    },
    gate: async (args) => {
      if (!gameModeOn()) return null
      // dryRun 只做只读评估，不碰目标程序，任何时候都允许。
      if (args?.dryRun !== false) return null
      if (args?.allowInGameMode === true) return null
      return {
        code: 'game_mode_blocks',
        reason: '关闭窗口：Game Mode 下禁止真正关闭',
        text: [
          'Game Mode 已开启，关闭窗口会向目标程序发 WM_CLOSE，可能弹出保存对话框抢走前台，已拒绝（这条请求已进等待队列）。',
          '只做风险预演不受限制：传 dryRun: true 可以评估是否存在未保存内容。',
          '真要关时请让用户在 Game Mode 面板里关闭它；或确认目标不是用户正在用的东西后显式传 allowInGameMode: true。',
        ].join('\n'),
      }
    },
    run: async (args) => {
      const r = await call('close_window', {
        hwnd: String(args.hwnd),
        dryRun: args.dryRun !== false,
        force: args.force === true,
        waitMs: clampInt(args.waitMs, 0, 15000, 1500),
      })
      return { ok: true, text: fmt.fmtClose(r.data), data: r.data }
    },
  })

  // 14. Game Mode ----------------------------------------------------------
  register({
    name: 'vdm_game_mode',
    description:
      '读写全局 Game Mode。这是唯一的"用户显式开关"，AI 不得自行关闭：用户说要退出游戏后由用户或用户授权的动作关闭。status 查看、on 开启、off 关闭（需 authorized:true）、pending 查看被拦下的等待队列、clear_pending 清空队列。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'on', 'off', 'pending', 'clear_pending'],
          description: '要执行的动作，默认 status。',
        },
        reason: { type: 'string', description: '开启/关闭的原因，写进状态与日志。' },
        authorized: { type: 'boolean', description: 'action=off 时必须为 true（表示用户本人要求关闭）。' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const action = args.action || 'status'
      if (action === 'status') {
        const st = readState()
        return { ok: true, text: fmt.fmtGameMode(st), data: st }
      }
      if (action === 'on') {
        const st = writeState({
          gameMode: true,
          gameModeReason: String(args.reason || '用户要求'),
          gameModeSince: new Date().toISOString(),
        })
        if (cfg.audit) audit({ tool: 'game_mode', ok: true, action: 'on', reason: st.gameModeReason })
        return { ok: true, text: fmt.fmtGameMode(st), data: st }
      }
      if (action === 'off') {
        if (args.authorized !== true) {
          return {
            ok: false,
            code: 'not_authorized',
            text: [
              '拒绝：关闭 Game Mode 必须由用户显式决定。',
              '请把这句话原样告诉用户："Game Mode 只能由你本人关闭（传 authorized:true），我不会自行判断游戏是否结束。"',
            ].join('\n'),
          }
        }
        const before = readState()
        const st = writeState({ gameMode: false, gameModeReason: '', gameModeSince: null })
        if (cfg.audit) audit({ tool: 'game_mode', ok: true, action: 'off', reason: String(args.reason || '') })
        const lines = [fmt.fmtGameMode(st)]
        if (before.pending?.length) {
          lines.push('', `Game Mode 期间被拦下的请求共 ${before.pending.length} 条，用 vdm_game_mode action=pending 查看后再决定要不要重做。`)
        }
        return { ok: true, text: lines.join('\n'), data: st }
      }
      if (action === 'pending') {
        const st = readState()
        return { ok: true, text: fmt.fmtPending(st.pending), data: { pending: st.pending } }
      }
      if (action === 'clear_pending') {
        clearPending()
        return { ok: true, text: '等待队列已清空。', data: { pending: [] } }
      }
      throw new HostError('bad_action', `未知 action：${action}`)
    },
  })

  ctx.logger?.info?.(`[virtual-desktop] 已注册 ${tools.length} 个工具`)
  return { tools }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function service(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  } catch {
    return undefined
  }
}

// 把截图挂进当前对话。任何一步失败都要说出来——图片没挂上但文件还在，
// 不等于"截图失败"，也不能静默丢掉，否则模型会以为自己看到了界面。
async function attachImage(ctx, filePath) {
  if (!filePath) return { images: [], note: '⚠ 原生层没有返回截图路径。' }
  if (!existsSync(filePath)) return { images: [], note: `⚠ 截图文件不存在：${filePath}` }

  const svc = service(ctx, 'attachments')
  if (!svc || typeof svc.saveImages !== 'function') {
    return { images: [], note: `⚠ 当前环境没有 attachments 服务，图片没有挂进对话。文件在：${filePath}` }
  }
  try {
    const data = readFileSync(filePath)
    const saved = await svc.saveImages([{ data, mediaType: 'image/png', name: filePath.split(/[\\/]/).pop() }])
    const images = Array.isArray(saved) ? saved : []
    if (images.length === 0) {
      return { images, note: `⚠ 附件服务没有返回可用图片，界面内容看不到。文件在：${filePath}` }
    }
    return { images, note: '' }
  } catch (err) {
    return { images: [], note: `⚠ 把截图挂进对话失败（${err?.message || err}）。文件在：${filePath}` }
  }
}

export function describeError(err, toolName) {
  const code = err?.code || 'unknown'
  const parts = [`${toolName} 失败：${err?.message || String(err)}`]
  if (err?.code) parts.push(`错误码：${code}`)
  if (err?.hresult) parts.push(`HRESULT：0x${(Number(err.hresult) >>> 0).toString(16).toUpperCase().padStart(8, '0')}`)

  if (code === 'not_authorized') {
    parts.push('', '这个操作需要用户明确授权。把原因告诉用户，不要自己绕过。')
  } else if (code === 'game_mode_blocks' || code === 'game_mode_blocks_visible_window') {
    parts.push('', 'Game Mode 正在保护用户的桌面。让用户决定是否关闭，不要自行判断游戏已结束。')
  } else if (code === 'target_is_foreground') {
    parts.push('', '目标窗口正是用户当前在操作的窗口（很可能是游戏）。换一个窗口，或先向用户确认。')
  } else if (code === 'close_risky') {
    parts.push('', '该窗口有未保存内容的风险。先问用户，确认后再传 force:true。')
  } else if (code === 'blank_capture') {
    parts.push('', '截到的画面是空白/纯色。这通常是 GPU 直出或受保护内容导致 PrintWindow 拿不到画面——')
    parts.push('不能据此判断软件运行正常，请换方式验证（读日志、查进程状态、或用 UI Automation 取控件树）。')
  } else if (code === 'target_minimized') {
    parts.push('', '目标窗口处于最小化状态。要么传 allowRestore:true（会用不激活的方式还原），要么先把它切到非最小化。')
  } else if (code === 'desktop_not_found') {
    parts.push('', '这个桌面 GUID 已经不存在了——很可能被用户手动删掉了。')
    parts.push('先跑 vdm_list_desktops 拿最新 GUID，或用 vdm_ensure_workspace_desktop 按名字重新获取/重建。不要沿用旧 GUID。')
  } else if (code === 'invalid_hwnd') {
    parts.push('', '窗口句柄已经失效（窗口被关掉或重建了）。重新跑 vdm_list_windows 拿新的 hwnd，不要复用旧句柄。')
  } else if (code === 'last_desktop') {
    parts.push('', '不能删除最后一个虚拟桌面。要重建的话，先建新的再删旧的。')
  } else if (code === 'move_unconfirmed') {
    parts.push('', '移动调用返回成功，但复查发现窗口仍在原来的桌面。不要对同一个窗口反复重试——')
    parts.push('先用 vdm_window_info 看 cloaked / visible 状态，必要时交给用户手动确认。')
  } else if (code === 'move_failed') {
    parts.push('', '窗口还没进 shell 的视图集合，所以移不过去。常见于隐藏窗口或刚创建还没显示的窗口。')
    parts.push('先让它显示出来（launch 时给 windowStyle:"normal"）再移；反复失败就交给用户，别反复切桌面。')
  } else if (code === 'target_not_responding') {
    parts.push('', '目标窗口无响应（IsHungAppWindow）。UIA 的同步调用会跟着一起卡住，所以直接拒绝了。')
    parts.push('不要改成按坐标点击——那会打到用户正在用的窗口上。')
  } else if (code === 'uia_element_not_found') {
    parts.push('', '按 path 找不到控件，界面多半已经变了。重新跑 vdm_uia_tree 取最新路径，不要缓存旧的。')
  } else if (code === 'launch_failed' || code === 'exe_not_found' || code === 'missing_path' || code === 'cwd_not_found') {
    parts.push('', '程序没起来。确认 path 是完整的 EXE 路径（或确实在 PATH 里），工作目录存在。')
  } else if (code === 'close_failed') {
    parts.push('', 'WM_CLOSE 发出去了但窗口还开着，很可能弹了保存对话框。不要反复发、不要强杀，交给用户处理。')
  } else if (code === 'host_timeout') {
    parts.push('', '原生助手超时。目标程序可能卡住，或窗口太多；可调大超时，或先用 limit / desktopId 缩小范围。')
  } else if (code === 'aborted') {
    parts.push('', '调用被取消（用户中断或会话结束），不是失败。需要的话重跑一次。')
  } else if (code === 'host_not_found' || code === 'host_spawn_failed') {
    parts.push('', '原生助手起不来。先跑 vdm_capabilities；如果是 host_not_found，说明 dist/vdmhost.exe 没随包发布或没编译。')
  } else if (code === 'desktop_api_unavailable') {
    parts.push('', '虚拟桌面 COM 调不通，最常见原因是调用进程完整性级别不对（必须是 Medium，不能是沙箱里的 Low）。')
  } else if (err?.hresult && Number(err.hresult) === 0x80070005) {
    parts.push('', 'E_ACCESSDENIED：当前进程不是 Medium 完整性级别，调不到 ImmersiveShell。')
  }
  for (const w of err?.warnings || []) parts.push(`⚠ ${w}`)
  return parts.join('\n')
}

function compactArgs(args) {
  const out = {}
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || v === null) continue
    if (
      k === 'authorized' ||
      k === 'force' ||
      k === 'allowForeground' ||
      k === 'avoidForegroundMove' ||
      k === 'allowInGameMode'
    ) {
      out[k] = Boolean(v)
      continue
    }
    if (typeof v === 'string') out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map(String)
    else out[k] = v
  }
  return out
}

function normalizeExePath(input, cwd) {
  const raw = String(input || '').trim()
  if (!raw) throw new HostError('missing_path', '需要 path 参数')
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) {
    if (!existsSync(raw)) throw new HostError('exe_not_found', `找不到可执行文件：${raw}`)
    return raw
  }
  // 相对路径：先按 cwd 解析，再作为裸命令名交给系统
  const base = cwd ? resolve(cwd) : process.cwd()
  const candidate = resolve(base, raw)
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  return raw
}

function sanitizeFileName(input) {
  if (!input) return ''
  const base = String(input).split(/[\\/]/).pop() || ''
  return base.replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 120)
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function safeHostPath(fn) {
  try {
    return fn()
  } catch (err) {
    return `(未找到：${err.message})`
  }
}

export { auditFile, stateDir }
