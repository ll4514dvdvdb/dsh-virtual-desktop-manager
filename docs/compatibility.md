# Windows 版本兼容性

## 结论表

| 构建号 | 版本 | 状态 | 说明 |
|---|---|---|---|
| **26200** | Windows 11 **25H2** | ✅ **已实测通过** | 全部 14 个工具、建桌面不切屏、跨桌面移动、PrintWindow 截图、Game Mode 全部验证 |
| 26100 | Windows 11 **24H2** | ⚠️ **理论支持，未实测** | 接口签名与 24H2 标定表一致，代码里 `IsBuildSupported` 从 26100 起放行，但本机没有该版本可测 |
| 22631 / 22621 | Windows 11 23H2 | ❌ **明确不支持** | vtable 顺序与 24H2 不同，强行调用会调错方法（可能切屏/删错桌面），插件会直接拒绝并报"接口版本未标定" |
| 22000 | Windows 11 21H2 | ❌ 不支持 | 同上 |
| 19044 / 19045 | Windows 10 21H2 / 22H2 | ❌ 不支持 | 公开的 `IVirtualDesktopManager` 可用，但内部接口完全不同，本插件不覆盖 |
| 20348+ / Server | Windows Server | ❌ 不支持 | 没有 Shell 虚拟桌面组件 |

判断依据是 `Environment.OSVersion.Version.Build`，`IsBuildSupported(build) => build >= 26100`。不受支持时 `capabilities` 会返回 `buildSupported:false`，并明确提示"接口版本未标定，不做任何桌面操作"。

## 实测环境（26200）

- Windows 11 25H2，build 26200，UBR 9711
- Session 1，交互式登录
- 进程完整性 **Medium (0x2000)**，`asInvoker`
- 结果：`desktopApiAvailable:true`，`desktopCount:3`，`list_windows` 能读到 Electron / Win32 / Store 应用窗口

## UI Automation 依赖

`vdm_uia_tree` / `vdm_uia_act` 用 .NET Framework 自带的 `UIAutomationClient` / `UIAutomationTypes` / `WindowsBase`
（GAC 内置，不引入第三方包，Windows 7 起就有）。

版本相关的只有一点：**UIA provider 由目标程序自己实现**，Windows 版本给不出保证。
Windows 11 25H2 上的实测样本见 [limits.md](limitations.md) 第 3.5 节。

已知的 UIA 行为差异：

| 情况 | 表现 |
|---|---|
| 窗口在别的虚拟桌面（cloaked） | 内容可能退化成只有外壳，`note` 会提示 |
| Chromium / Electron | 默认不暴露网页 DOM，只有原生外壳 |
| 自绘 UI（微信、游戏） | 只有 1~4 个节点 |
| 目标无响应（`IsHungAppWindow`） | 插件直接拒绝（`target_not_responding`），不让调用挂到超时 |
| 控件不支持该 pattern | 返回 `succeeded:false` + `supportedPatterns`，不退回坐标点击 |
## 完整性级别要求（最容易踩的坑）

内部 COM 接口要求调用进程至少 **Medium** 完整性：

| 启动方式 | 完整性 | 能否用本插件 |
|---|---|---|
| DSH 宿主子进程（插件正常路径） | Medium `0x2000` | ✅ |
| 普通用户 PowerShell / cmd | Medium `0x2000` | ✅ |
| DSH 沙箱 shell（Low 策略时） | Low `0x1000` | ❌ `0x80070005` |
| 计划任务"最低权限" + 受限令牌 | Low | ❌ |
| 以管理员身份运行（High） | High `0x3000` | ❌ 反而会 `E_ACCESSDENIED` |
| Windows 服务（Session 0） | 任意 | ❌ 没有交互式 Shell |

**注意反直觉的一点：以管理员身份运行会更糟。** `vdmhost.exe` 的 manifest 固定 `asInvoker`，不要给它加 `requireAdministrator`。

如果你在别的环境里跑 `node tests/host-smoke.mjs` 得到退出码 2，先看它打印的 `integrity` 值——大概率就是这个原因，不是代码坏了。

## 与 Windows 更新的关系

隐藏 COM 接口的 GUID 和 vtable 顺序**随大版本变化**。23H2 → 24H2 就改过一次。所以：

- 插件**不猜**接口：只在标定的构建号上工作，其余直接拒绝。
- 拒绝时不影响其他功能：窗口枚举、截图、Game Mode 都还能用，只有建/删/切桌面不可用。
- Windows 大版本更新后如果本插件报"接口版本未标定"，正确做法是等适配，**不要**用别的工具混着调，容易把桌面状态搞乱。

## 已知的 Windows 行为差异（与版本相关）

| 现象 | 说明 |
|---|---|
| 应用商店版程序窗口不在启动进程里 | `notepad.exe` 是转发壳，启动后立刻退出，真正 UI 在 `WindowsApps\...\Notepad.exe`。插件会按进程名 + 启动时间兜底匹配，并告警 |
| 部分程序忽略 `minimized`/`hidden` 启动参数 | 插件会事后检查窗口真实状态，`windowStyleApplied:false` 时明确告警。实测 Store 版记事本即使 `minimized` 启动也会抢一次前台 |
| 公开 `IVirtualDesktopManager::MoveWindowToDesktop` 对跨进程窗口常失败 | 实测 26200 上未成功，插件自动回退到内部 `MoveViewToDesktop`，返回 `channel:"internal"` |
| 隐藏/cloaked 窗口不在 Shell 视图集合里 | 移动会失败，插件先 `SW_SHOWNOACTIVATE`（不激活）再重试一次 |
| 桌面被用户手动删除 | 插件不缓存桌面序号，每次操作重新枚举；GUID 失效时报 `desktop_not_found`，不会静默乱来 |
