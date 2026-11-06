# 更新记录

## 0.1.1 — 工具层联调修复

新增工具层集成测试（真的装载插件、真的调 `vdm_*` 工具，不 mock 链路本身），立刻抓出 5 个只在"工具之间衔接"时才暴露的缺陷。

### 修复

- **`hwnd` 回传断裂（会导致最常用链路直接不可用）**：`list_windows` 返回 `"3084C"`（无 `0x` 前缀），而 `window_info` / `capture_window` / `move_window` / `close_window` 只接受 `0x...`，于是"枚举 → 查询/截图"必然报 `invalid_argument`。现在原生层所有 `hwnd` 字段统一带 `0x` 前缀。
- **`create_desktop` 返回值嵌套导致 GUID 变 `undefined`**：原生返回 `{ desktop: { id } }`，Node 层却读 `data.desktopId`，新用户第一次 `vdm_ensure_workspace_desktop` 会建出桌面却写不进状态、返回文本里 GUID 显示 `undefined`。现在原生层顶层也给出 `desktopId`，Node 层同时兼容 `desktopId ?? desktop.id`。
- **`get_current_desktop` 与 `list_desktops` 字段名不一致**：前者只有 `desktopId`，后者每项是 `id`，调用方无法直接比对。现在 `get_current_desktop` 同时返回 `id` 与 `desktopId`。
- **`vdm_move_window` 在 Game Mode 下只拦前台窗口**：原生层只会硬拦"当前前台"的窗口，后台窗口拦不住，而游戏窗口不一定恰好是前台。现在 Game Mode 下默认拒绝移动，需显式 `allowInGameMode: true`。
- **`vdm_close_window` 在 Game Mode 下无拦截**：关窗口可能弹出保存对话框抢走前台。现在 Game Mode 下只放行 `dryRun: true`（只读评估），真关需显式 `allowInGameMode: true`。
- `close_window` 的返回补上 `hwnd`，此前 dryRun 结果里没有句柄，前端渲染成 `0x?`。

### 测试

- `npm test`：39 个用例（format 13 / state 7 / bridge 8 / plugin 装载 11），全绿。
- `npm run test:host`：原生层只读冒烟，12 项全绿。
- `npm run test:live`：**新增**，工具层集成 45 项全绿。

## 0.1.0 — 首个版本

首个可用的 MVP，在 Windows 11 25H2（build 26200）上实测通过。

### 工具

- 虚拟桌面：`vdm_list_desktops`、`vdm_get_current_desktop`、`vdm_create_desktop`、`vdm_ensure_workspace_desktop`、`vdm_switch_desktop`（需授权）、`vdm_remove_desktop`（需授权）
- 窗口：`vdm_list_windows`、`vdm_window_info`、`vdm_move_window`（前台保护）、`vdm_capture_window`（PrintWindow + 空白检测）、`vdm_close_window`（WM_CLOSE，默认 dryRun）
- 启动：`vdm_launch_in_desktop`（PID/HWND 识别、样式生效校验、可移到指定桌面）
- 策略：`vdm_game_mode`（全局硬开关 + 等待队列）
- 诊断：`vdm_capabilities`

### 实现要点

- 两层架构：Node 插件跑在 DSH 宿主（Medium 完整性）里，spawn `vdmhost.exe`（C# / net472，单文件零第三方依赖）。
- 虚拟桌面走未公开 COM `IVirtualDesktopManagerInternal`，按构建号标定（≥ 26100 放行），GUID 为唯一标识，不持久化序号。
- 移动窗口先试公开 `IVirtualDesktopManager::MoveWindowToDesktop`，失败自动回退内部 `MoveViewToDesktop`。
- 启动程序用 `CreateProcess` + `bInheritHandles=false`，避免子进程继承重定向句柄导致调用方等不到 EOF。
- 应用商店版/转发壳程序按"进程名 + 启动时间"兜底匹配真正窗口。
- 截图用 `PrintWindow` + `PW_RENDERFULLCONTENT`，采样统计颜色分布，疑似空白明确告警。
- 关闭窗口只发 `WM_CLOSE`，从不 `TerminateProcess`。
- 审计日志 JSONL，状态目录 `~/.dsh/virtual-desktop-manager/`。

### 测试

- `npm test`：38 个用例（format 13 / state 7 / bridge 8 / plugin 装载 11），全绿。
- `npm run test:host`：原生层只读冒烟，12 项检查全绿。

### 已知问题

- 公开 `MoveWindowToDesktop` 在本机实测对跨进程窗口未成功，实际走内部接口。
- Store 版记事本 `minimized` 启动仍会抢一次前台。
- GPU 直出 / DRM 内容截图空白（能检测，抓不到）。
- 未实现 UIA 元素级自动化与 Windows Graphics Capture。
