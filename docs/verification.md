# 验证记录（需求 → 实现 → 证据）

本文只记录**实际跑过、能复现**的结果。没验过的条目单独列在最后，不混在一起说。

环境：Windows 11 25H2 build 26200.9711 / Session 1 / 进程完整性 Medium(0x2000) / DSH 0.2.2-rc.1 / pnpm 11.28.5。

## 一、需求里的 9 个接口

| 需求接口 | 实现 | 工具名 | 证据 |
|---|---|---|---|
| `list_desktops` | `native/Commands/Desktops.cs` `List` | `vdm_list_desktops` | `tools-live [2]` 真机枚举 3~4 个桌面；`host-smoke` 校验 GUID 形式、恰好一个 `isCurrent` |
| `create_desktop` | `Desktops.cs` `Create` | `vdm_create_desktop` / `vdm_ensure_workspace_desktop` | `tools-live [7]`：创建成功、GUID 拿到、中文名生效、**没切走当前桌面**、同名再建 `reused:true`、删除成功 |
| `get_current_desktop` | `Desktops.cs` `Current` | `vdm_get_current_desktop` | `host-smoke` 断言与 `list_desktops` 的 `currentDesktopId` 一致 |
| `switch_desktop`（必须授权） | `Desktops.cs` `Switch` | `vdm_switch_desktop` | `plugin.test`：不带 `authorized` 直接拒绝且**不碰原生助手**；原生层同样有二次校验 |
| `list_windows` | `native/Commands/WindowOps.cs` `List` | `vdm_list_windows` | `host-smoke` 校验 hwnd/pid/processName、`onCurrentDesktop` 与 `virtualDesktopId` 自洽 |
| `move_window` | `WindowOps.cs` `Move` | `vdm_move_window` | 真机把 notepad 移进「AI 工作桌面」：`moved:true verified:true channel:"internal"`；前台窗口不带 `allowForeground` 抛 `target_is_foreground` |
| `launch_in_desktop` | `native/Commands/LaunchCmd.cs` + `native/Support/Launcher.cs` | `vdm_launch_in_desktop` | 真机启动记事本到「AI 工作桌面」：`windowFound:true`、`movedTo` 生效、用户当前桌面不变 |
| `capture_window` | `native/Support/Capture.cs` | `vdm_capture_window` | 真机抓 DSH 窗口 2906×1550 / 362KB / 114 种采样色 / `qualityVerdict:"ok"`，肉眼确认是完整界面 |
| `close_window`（检查未保存风险） | `WindowOps.cs` `Close` | `vdm_close_window` | 默认 `dryRun:true` 给出 `risk{level:"medium"}`；`plugin.test` 覆盖 Game Mode 下只放行 dryRun |

## 二、技术实现要求

| 要求 | 落实 |
|---|---|
| 官方 `IVirtualDesktopManager`（`IsWindowOnCurrentVirtualDesktop` / `GetWindowDesktopId` / `MoveWindowToDesktop`） | `native/Interop/Desktop.cs` 的 `IVirtualDesktopManagerPublic`，`WindowDesktop` / `IsOnCurrentVirtualDesktop` / `MoveWindow` 先走公开接口 |
| 公开接口不支持的功能才用内部接口 | `MoveWindow` 失败后回退 `IVirtualDesktopManagerInternal.MoveViewToDesktop`，返回 `channel:"internal"` 如实标注（真机实测公开接口确实没成功） |
| 未公开接口做版本兼容检测 | `native/Program.cs` `IsBuildSupported(build) => build >= 26100`；`capabilities` 返回 `buildSupported`；不支持的构建直接拒绝而不是"猜一个方法试试" |
| 不假定内部接口在所有 Win11 版本有效 | `docs/compatibility.md` 列明 26200 实测、26100 理论、22631/22621/22000 vtable 不同 |
| 不为创建桌面模拟 Win+Ctrl+D | 创建走 `CreateDesktop` COM，代码里没有任何 `keybd_event` / `SendInput` |
| 启动：传参、拿 PID、拿 HWND、移到桌面、记日志 | `Launcher.cs` 用 `CreateProcess`（`bInheritHandles=false`，避免子进程继承 stdout 句柄导致管道不释放）；`FindWindowForPid` + `FindWindowByName` 兜底；每次调用写审计日志 |
| 检测实际窗口状态，不假定隐藏参数生效 | `LaunchResult.StyleApplied`：请求 minimized 但实际没最小化时加 warning「该程序忽略了 WindowStyle」。真机实测 Store 版记事本即使 `minimized` 仍抢前台 |
| 截图用窗口级捕获 | `PrintWindow` + `PW_RENDERFULLCONTENT(0x2)`，只针对单个 HWND，不截整个桌面 |
| 识别截图失败/黑屏/GPU 无法捕获 | `Capture.Analyze()` 采样最多 64×64 点算主色占比；`SuspectedBlank` 时 `qualityVerdict:"blank_or_uncapturable"` 并给排查提示；`plugin.test` 断言文案必须含"不能当作软件运行正常" |
| GUI 自动化优先 UI Automation | `native/Interop/Uia.cs` + `native/Commands/UiaCmd.cs`；**零** `SendInput` 调用点 |
| 不默认全局键鼠模拟 | 同上；坐标点击也没实现——不支持的动作返回 `succeeded:false` + `supportedPatterns` |
| 必须切桌面才能完成的测试要暂停等授权 | `switch_desktop` / `remove_desktop` / `game_mode off` 都要 `authorized:true`；Game Mode 下切换桌面任何情况都拒绝 |

## 三、可靠性要求

| 要求 | 落实与证据 |
|---|---|
| 不用固定桌面编号作永久标识 | 所有接口只认 GUID；`index` 只用于展示，`list_desktops` 的 note 明确写"不要持久化序号"；`plugin.test` 断言该提示存在 |
| 考虑桌面被用户手动删除 | 每次操作重新枚举并校验桌面存在（`DesktopApi.Find`），状态里存的 GUID 找不到时报 `desktop_not_found` 并提示重新 `ensure_workspace` |
| 处理多窗口/子窗口/窗口尚未创建 | `Windows.Enumerate` 只取顶层（`GetAncestor(GA_ROOT)`）、按 owner/标题打分；`FindWindowForPid` 轮询等窗口出现（默认 8s，转发壳退出后再等 5s） |
| 不移动用户当前正在操作的窗口 | `move_window` 对 `GetForegroundWindow()` 命中直接抛 `target_is_foreground`（真机验证过）；Game Mode 下额外默认全拒 |
| 失败不反复切桌面 | 代码里没有任何"移动失败就切过去看看"的逻辑；`switch_desktop` 是独立显式操作 |
| 兼容 Windows 11 | build ≥ 26100 放行，其他明确报不支持 |
| 优先 C#/.NET，不引大框架 | net472 + 系统自带 GAC 程序集（`System.Web.Extensions` / `System.Drawing` / `UIAutomationClient` / `UIAutomationTypes` / `WindowsBase`），零 NuGet 依赖，产物单文件 69KB |
| 虚拟桌面不是独立会话 | README 开篇第一段就写明；`docs/limitations.md` 第 1 节逐条列出不隔离什么 |

## 四、Game Mode

| 要求 | 落实与证据 |
|---|---|
| 禁止自动切桌面 | `plugin.test`：`switch_desktop` / `create_desktop` / `remove_desktop` 在 Game Mode 下被 gate 拦 |
| 禁止自动抢前台 | `launch` 在 Game Mode 下只允许 `windowStyle: minimized/hidden` + `allowInGameMode` |
| 禁止全局键鼠模拟 | 全项目无 `SendInput`；`uia_act` 不发输入 |
| 禁止自动打开干扰游戏的可见窗口 | 同上 launch 限制；`plugin.test` 专门有用例「以普通可见窗口启动仍被拦」 |
| 允许 Node/Python/Git/编译器继续跑 | Game Mode 只拦本插件的桌面/窗口操作，不碰进程 |
| 允许后台日志收集 | `audit.log` 不受 Game Mode 影响 |
| 允许窗口级截图 | `plugin.test` + `tools-live [9]` 都断言 Game Mode 下 `capture_window` 仍可用 |
| 需桌面交互的测试进等待队列 | gate 拦截时 `pushPending`，`state.test` 覆盖封顶 200 条；`tools-live [9]` 断言"被拦截的任务进了等待队列" |
| 必须用户显式控制，不自动解除 | `game_mode off` 要 `authorized:true`；状态文件损坏时**保守按开启处理**（`state.test` 专门有用例） |

## 五、自动化测试（全部实跑）

| 命令 | 结果 | 覆盖 |
|---|---|---|
| `npm test` | **42 / 42 通过** | `format.test.mjs` 12 个纯函数渲染用例；`state.test.mjs` 7 个状态/队列/审计；`bridge.test.mjs` 8 个 spawn 与错误归一化；`plugin.test.mjs` 15 个注册/契约/Game Mode gate |
| `node tests/host-smoke.mjs` | **全部通过（12 项）** | 直连原生助手：build、完整性、COM 可用、桌面枚举、当前桌面一致性、窗口字段与自洽 |
| `node tests/tools-live.mjs` | **56 / 56 通过** | 真装载插件、真调 16 个工具：capabilities→桌面→窗口→截图→UIA→建删桌面→ensure→Game Mode 全链路→审计日志 |
| `scripts/verify-install.ps1` | **安装完整** | 校验 deps / bundles / pnpm-lock / node_modules 四处，再用**装好的那份拷贝**跑 host-smoke |

`tools-live` 刻意**不**做的事（会动真实环境）：`switch_desktop`、真的 `close_window`、真的把用户窗口移走、`launch` 可见 GUI 程序。这几项靠人工真机验证，结果记在上面第一、二节。

## 六、安装验证

| 检查 | 结果 |
|---|---|
| `dsh plugin --profile desktop list` | 17 packages，含 `dsh-virtual-desktop-manager@file:D:/Deepseek Harness/dsh-virtual-desktop-manager` |
| `package.json` dependencies | 有 `dsh-virtual-desktop-manager` |
| `dsh.profile.bundles` | 第 19 项，已注册 |
| `pnpm-lock.yaml` | 已记账 |
| `node_modules\...\dist\vdmhost.exe` | 69120 字节，与仓库源码 SHA256 一致 |
| 源码与已装副本一致性 | `index.js` / `lib/*.js` / `dist/vdmhost.exe` / `cordis.patch.yml` / `package.json` 哈希全部一致 |
| 一次性 profile 交叉验证 | `--profile vdm-test` 装完 `--dump-config` 输出含 `- id: virtual-desktop-manager`；在副本里跑 `tools-live` 56/56 |

## 七、尚未验证（诚实标注）

这几项只有在**重启 DSH 之后**才能验，本机当时有其他任务在跑，没有重启：

1. **DSH 运行时里真的出现 16 个 `vdm_*` 工具**——安装落地与 `--dump-config` 已证明会加载，但"重启后在会话里调得到"这一步没在本机跑过。
2. **`vdm_capture_window` 的图片能否挂进对话**——`attachments.saveImages` 的四种失败分支有单测（`attachImage` 返回 `note`），成功分支只在 mock 里跑过。
3. **Game Mode 全链路在真实 DSH 会话里**（当前是在 `tools-live` 里直接调工具函数验证的，绕过 DSH 调度层）。
4. **`launch` 在 DSH 内被调用的完整链路**（含 `hostPath` 解析走配置分支）。

重启后一条 `vdm_capabilities` 就能确认第 1 项；其余三项按 README 的典型工作流各跑一次即可。
