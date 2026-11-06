# 更新记录

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
