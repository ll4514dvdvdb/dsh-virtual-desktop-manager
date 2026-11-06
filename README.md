# dsh-virtual-desktop-manager

让 DeepSeek Harness（DSH）在**独立的 Windows 虚拟桌面**里启动、管理、截图 GUI 应用，而不是随时抢占你正在用的那个桌面。

14 个工具，覆盖：枚举/创建/切换/删除虚拟桌面，列出/检查/移动窗口，在指定桌面启动程序，窗口级截图，安全关闭窗口，以及一个由你本人控制的全局 **Game Mode**。

> **先明确边界，别被"虚拟桌面"这个词骗了**
>
> Windows 虚拟桌面**不是独立会话**（不是 RDP、不是 Hyper-V、不是沙箱）。它只是把同一套桌面上的窗口分成几组，同一时间只有一组显示在屏幕上。所以：
>
> - ❌ 不隔离输入：别的进程（包括 AI 启动的程序）仍然能往你正在玩的游戏里发输入，本插件不做、也不承诺拦住别的东西做。
> - ❌ 不隔离 GPU/CPU/内存：AI 桌面里的程序照吃你的显卡和内存，游戏该掉帧还是会掉帧。
> - ❌ 不隔离后台进程：同一用户、同一会话（Session 1），权限完全相同。
> - ✅ 隔离的是**可见性**：AI 桌面上的窗口不会出现在你眼前，不会抢你的视觉焦点，你可以继续在主桌面玩游戏。
>
> 本插件提供的安全来自**行为约束**（Game Mode、前台保护、授权开关、只用窗口级 API），不是来自隔离。

## 为什么是"Node 插件 + C# 原生助手"两层

虚拟桌面的未公开 COM 接口（`IVirtualDesktopManagerInternal`）要求调用进程处于 **Medium 完整性**。而 DSH 的沙箱 shell 是 **Low** 完整性，在那种进程里 `CoCreateInstance(CLSID_ImmersiveShell)` 直接返回 `0x80070005`（E_ACCESSDENIED）。

所以：

```
index.js / lib/*.js      跑在 DSH 宿主进程（Medium）里，负责工具注册、参数校验、Game Mode、审计
      ↓ spawn（一次一条命令，JSON over stdio）
dist/vdmhost.exe          C# / .NET Framework 4.7.2，单文件、无第三方依赖
      ↓ P/Invoke + COM
IVirtualDesktopManager / IVirtualDesktopManagerInternal / PrintWindow / Win32 窗口 API
```

`vdmhost.exe` 的 manifest 刻意是 `asInvoker`——**提权到 High 反而会 E_ACCESSDENIED**，这不是疏忽。

## 安装

前提：Windows 11（详见[兼容性](docs/compatibility.md)）、DSH ≥ 0.2.0-rc.1。

**必须先把 DSH 完全退出**（含托盘图标）。运行中的 DSH 会持有 profile 的 `package.json` 写锁，此时安装会卡在 `atomic-write: timed out waiting for the writer lock` 上——这是实测行为，不是偶发。CLI 安装和 DSH 内的插件管理器都绕不过。

```powershell
# 方式一（推荐）：退出 DSH 后跑安装脚本，会自动检查进程、缺原生助手就先构建
cd "D:/Deepseek Harness/dsh-virtual-desktop-manager"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1

# 方式二：手动 add（同样要在 DSH 退出后）
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "file:D:/Deepseek Harness/dsh-virtual-desktop-manager"
```

卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Remove
```

装完重开 DSH。桌面版不能用 `--dump-config` 检查（profile 由 Electron 独占管理）。

不想开命令行的话，直接双击 `scripts\install.cmd`——内容一样，只是带 `pause` 让你看清输出。

### 装完先自检（强烈建议）

```powershell
cd "D:/Deepseek Harness/dsh-virtual-desktop-manager"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-install.ps1
```

它查四处是否真的落地（`dependencies` / `dsh.profile.bundles` / `pnpm-lock.yaml` / `node_modules`），再用**装着的那份拷贝**跑一次原生助手冒烟测试，最后打印当前桌面与窗口列表。全绿再重开 DSH。

### 排错：安装卡住 / 装完 DSH 里没有 `vdm_*` 工具

实测踩到过两种现象，原因不一样，别混为一谈。

**现象 A：卡住，600 秒后被强杀**

```
Progress: resolved 267, reused 8, downloaded 0, added 2
dsh: pnpm printed nothing for 600000ms and was terminated
```

结果是半成品——**文件已经拷进 `node_modules` 了，但 `dependencies`、`dsh.profile.bundles`、`pnpm-lock.yaml` 三处一个都没写**。命令退出码看起来正常，重开 DSH 却什么都没有。

第一次是这个原因：`package.json` 被运行中的 DSH 握着写锁（用 `[IO.File]::Open($pf,'Open','ReadWrite','None')` 会抛"文件正由另一进程使用"）。**但后来 DSH 照样开着，安装却成功了**——所以"必须退出 DSH"不是铁律。真正让 pnpm 卡住的还有第二种情况：

**现象 B：慢，但不是死锁**

pnpm 在解析时会去 `registry.npmjs.org` 拉包（尤其是它想顺手把别的依赖升级到"推荐版本"时）。实测有一次单条请求就花了 11 秒：

```
[WARN] Request took 11094ms: https://registry.npmjs.org/billion-context
```

这一轮完整跑下来 **3 分 20 秒**，看起来像卡死，其实在动。判断方法：看 `Progress:` 行的 `downloaded` / `added` 有没有在涨。

处理顺序：

1. 先跑 `verify-install.ps1` 看落到了几处（它会直接标红）。
2. 卡住但 `Progress` 在涨 → 等，别杀。网络不好就是慢。
3. `Progress` 完全不动超过 10 分钟 → 确认代理可用（`registry.npmjs.org` 走代理），再 `install.ps1 -Remove` 重装。
4. 真清不干净 → 完全退出 DSH（`Get-Process -Name 'DeepSeek Harness'` 无输出）后再装。

另外两点：

- 在运行中的 DSH 里用插件管理器（`plugin_manager` 工具）装也一样会遇到，不是脚本的问题。
- 装到一次性 profile（`--profile vdm-test`）通常 500~650ms 就完，因为那边没有要顺带升级的旧依赖。
- **`dsh plugin add` 可能顺带改动别的包**：实测这次把 `billion-context` 从 0.1.209 升到了 0.1.212，还多塞了一个 `dsh-ops`（不在 `bundles` 里、和当前 DSH 版本不兼容）。不想要的用 `dsh plugin --profile desktop remove dsh-ops` 清掉即可（5 秒）。

### 原生助手

`dist/vdmhost.exe`（约 54KB，单文件、零第三方依赖）随仓库一起分发，装完即可用。

想自己从源码重建（改了 `native/` 下任何 C# 之后**必须**重建）：

```powershell
cd "D:/Deepseek Harness/dsh-virtual-desktop-manager"
npm run build:host        # 需要 .NET SDK（或 MSBuild；目标框架 net472）
node tests/host-smoke.mjs # 冒烟：COM 是否可用 + 桌面/窗口能否读到
```

`scripts/build-host.ps1` 会把 `APPDATA`/`LOCALAPPDATA`/`DOTNET_CLI_HOME`/`NUGET_PACKAGES` 重定向到工程内 `.build\`，**不需要联网、不需要全局 NuGet 配置、不会污染你的用户目录**。

## 工具清单

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `vdm_capabilities` | 诊断：完整性级别、COM 可用性、构建号是否受支持、桌面上限 | 任何"莫名失败"先跑它 |
| `vdm_list_desktops` | 列出所有桌面（GUID/名称/序号/是否当前/窗口数） | 序号会变，只认 GUID |
| `vdm_get_current_desktop` | 用户**正在看**的桌面 | 通常不是 AI 工作桌面 |
| `vdm_create_desktop` | 创建或按名字复用桌面 | 正常不切屏；变了会告警 |
| `vdm_ensure_workspace_desktop` | 查→复用→没有才创建"AI 工作桌面" | 推荐所有任务的起点 |
| `vdm_switch_desktop` | 切换用户眼前显示的桌面 | **必须 `authorized:true`**；Game Mode 一律拒绝 |
| `vdm_remove_desktop` | 删除桌面（窗口迁移到相邻桌面） | **必须 `authorized:true`**；不删最后一个 |
| `vdm_list_windows` | 顶层窗口：HWND/PID/进程名/标题/所属桌面 | 可按桌面/PID/进程名/标题过滤 |
| `vdm_window_info` | 单窗口详情（含 `isForeground`、cloaked、无响应） | 移动/截图前先确认 |
| `vdm_move_window` | 把窗口移到指定桌面 | **前台窗口直接拒绝**，除非 `allowForeground:true` |
| `vdm_launch_in_desktop` | 启动 EXE 并把主窗口移到目标桌面 | 返回 PID/HWND/是否抢前台/样式是否真生效 |
| `vdm_capture_window` | PrintWindow 抓单窗口（`PW_RENDERFULLCONTENT`） | 空白检测；空白**不许**当正常 |
| `vdm_uia_tree` | UI Automation 读控件树（类型/名称/自动 ID/是否可交互） | 纯只读；不需要前台、不需要切桌面 |
| `vdm_uia_act` | 按控件执行 invoke/setvalue/toggle/expand/collapse/select/focus/scroll | 不发鼠标键盘；不支持就报 `succeeded:false`，**不退回坐标点击** |
| `vdm_close_window` | 发 `WM_CLOSE`（不是强杀） | 默认 `dryRun:true`；high 风险需 `force:true` |
| `vdm_game_mode` | Game Mode 开关/状态/等待队列 | `off` **必须 `authorized:true`** |

所有工具都返回中文 `text`（给人看）+ 结构化 `data`（给下一步用）；每次调用写审计日志。

### 为什么 GUI 自动化走 UI Automation 而不是模拟鼠标键盘

虚拟桌面**不是独立会话**。`SendInput` 打进的是当前会话的输入队列，会原封不动打到用户正在玩的那一局游戏里；
按屏幕坐标点击还依赖窗口位置和 DPI，窗口在别的桌面时坐标根本没意义。

UIA 的 `Invoke`/`SetValue`/`Toggle` 是**跨进程、针对具体控件**的操作：不需要目标在前台，不需要切换桌面，
不会移动鼠标。代价是它依赖目标程序自己实现 UIA —— 见下面的"已知限制"。

`focus` 是个例外：它会把焦点交给目标控件（可能把窗口提到前台），所以 Game Mode 下**即使传 `allowInGameMode:true` 也禁止**。

实测样本（Win11 25H2 / build 26200）：

| 目标 | `vdm_uia_tree` 结果 | 能否 `uia_act` |
|---|---|---|
| 文件资源管理器 | 95 个节点，标题栏按钮标为可交互 | 能（`invoke` 真生效） |
| 记事本（Win11 版） | 7 个节点，只有外壳 + 标题栏按钮 | 能（实测 `invoke` 最小化，`window_info` 确认 `minimized` 变了） |
| 微信 / Steam | 1~4 个节点，只有外壳 | 读得到但内容极少（自绘 UI） |
| DeepSeek Harness（Electron） | 12 个节点，只有标题栏按钮 | 读不到网页内容（Chromium 默认不暴露） |

## 典型工作流

```
1. vdm_capabilities                       确认能跑
2. vdm_game_mode {action:"status"}        确认没在游戏模式挡着
3. vdm_ensure_workspace_desktop           拿到 AI 工作桌面的 GUID
4. vdm_launch_in_desktop {path, desktopId} 启动你的程序，窗口秒移走
5. vdm_capture_window {hwnd}              截图看界面（不截你屏幕）
6. vdm_uia_tree {hwnd}                    看有哪些控件（只读，不打扰）
7. vdm_uia_act {hwnd, path, action}       直接点/填，不碰鼠标键盘
8. vdm_list_windows {desktopId}           确认窗口状态
9. vdm_close_window {hwnd, dryRun:false}  收尾
```

## Game Mode

一个存在 `~/.dsh/virtual-desktop-manager/state.json` 里的全局开关，**只能由用户显式控制**。

开启后：

| 禁止 | 允许 |
|---|---|
| 切换桌面（任何情况下） | 枚举桌面/窗口、查详情 |
| 创建/删除桌面 | 窗口级截图（PrintWindow，不影响前台） |
| 以普通可见窗口启动程序 | 最小化/隐藏方式启动（需显式 `windowStyle` + `allowInGameMode`） |
| 移动前台窗口 | 移动非前台窗口 |
| 关闭窗口 | Node/Python/Git/编译/构建/后台日志 |

被拦下的请求进**等待队列**（最多 200 条），`vdm_game_mode {action:"pending"}` 可查。

**AI 不得自行关闭 Game Mode。** 代码里 `off` 需要 `authorized:true`，且提示文案明确写"由用户本人要求关闭"。关闭后恢复全部权限。

一个细节：`state.json` 解析失败时按 **Game Mode 开启**的保守状态继续（`gameMode:true` + `_warning`）。宁可少做动作，也不能因为状态读不出来就在你打游戏时去切桌面。

## 安全设计（不是营销词，是实现里真实存在的判断）

- **前台窗口保护**：`move_window` 对 `GetForegroundWindow()` 命中的窗口直接抛 `target_is_foreground`。想动它必须显式 `allowForeground:true`，Game Mode 下连这个口子都堵死。
- **启动后的窗口不同待遇**：刚由我们启动、刚识别到的窗口即使抢了前台也照样移走——因为它正是该被移走的那个。想反过来保护用 `avoidForegroundMove`。
- **不切屏是默认路径**：`switch_desktop` 是唯一改变你眼前画面的操作，必须 `authorized:true`。
- **不模拟全局输入**：不调用 `SendInput`、不模拟 `Win+Ctrl+D`、不点鼠标、不按屏幕坐标点击。桌面创建走 COM，不靠快捷键；控件操作走 UI Automation 的 pattern。
- **不抢焦点**：还原最小化窗口用 `SW_SHOWNOACTIVATE`，不激活。
- **不静默失败**：窗口句柄要按 `EnumWindows` 实时查，桌面每次操作重新枚举校验，全部写日志。
- **不把空白当成功**：`capture_window` 采样统计颜色分布，`qualityVerdict: "blank_or_uncapturable"` 时提示"GPU 直出/受保护内容，不能当作软件运行正常"。
- **不硬杀进程**：`close_window` 只发 `WM_CLOSE`，`TerminateProcess` 从头到尾没有调用点。

## 状态与日志

```
~/.dsh/virtual-desktop-manager/
├── state.json         Game Mode、AI 工作桌面 GUID、等待队列
├── audit.log          每次工具调用的 JSONL（时间、工具、结果、耗时、错误码）
└── captures/          窗口截图 PNG
```

`VDM_STATE_DIR` 可以整体改到别处（测试就是这么隔离的）。

## 目录结构

```
index.js                 工具注册、Game Mode 策略、错误翻译、审计
lib/bridge.js            spawn vdmhost.exe，JSON over stdio，超时/取消/错误归一化
lib/state.js             状态、等待队列、审计日志
lib/format.js            纯函数：把原生 JSON 渲染成中文说明
native/Program.cs        命令分发 + 响应封装（{ok,data,warnings,elapsedMs}）
native/Interop/Desktop.cs  虚拟桌面 COM（公开 + 内部接口、GUID、vtable）
native/Interop/Win32.cs    P/Invoke
native/Support/*.cs       窗口枚举、PrintWindow 截图、CreateProcess 启动、完整性级别
native/Commands/*.cs      各命令实现（含 UiaCmd.cs）
scripts/build-host.ps1    离线构建原生助手（重定向所有 dotnet 目录，不联网）
scripts/install.ps1       装/卸 profile（必须在 DSH 完全退出后跑）
scripts/install.cmd       双击版安装入口（带 pause）
scripts/verify-install.ps1 安装落地校验 + 原生层冒烟
tests/*.mjs               单元测试 + 原生层冒烟
```

## 测试

```powershell
npm test              # 39 个用例：format / state / bridge / plugin 装载（纯 JS，不需要原生 exe）
npm run test:host     # 原生层冒烟（只读命令，不建桌面不移动窗口）
npm run test:live     # 工具层集成：真的调用 vdm_* 工具走完整链路（详见下方）
npm run test:all      # 三个都跑
```

`npm test` 不需要原生 exe（找不到时会 skip 依赖它的用例）；`npm run test:host` 需要先 `npm run build:host`，并且在**能拿到 COM 的进程**里跑（普通 PowerShell 通常可以；被降权/沙箱化的 shell 会返回退出码 2 并说明原因）。

### `npm run test:live`：工具层集成测试

单测只验证"格式化函数长什么样"，冒烟只验证"原生助手能不能读",都不验证**工具之间能不能接上**。`tests/tools-live.mjs` 补这一段：它 mock 一个最小 ctx、装载整个插件，然后依次真调用 `vdm_capabilities` → `list_desktops` → `get_current_desktop` → `list_windows` → `window_info` → `capture_window` → `create_desktop`/`remove_desktop` → `ensure_workspace_desktop` → `game_mode` 开关与拦截 → 审计日志。

它真的会建一个临时桌面又删掉（名字 `__vdm_selftest_<时间戳>`），所以不切屏但会短暂出现在任务视图里。

刻意**不做**的动作：`switch_desktop`（会切走用户的屏）、`launch`（会弹窗抢前台）、`move_window` 真移、`close_window` 真关——这些属于"要么动用户桌面、要么动用户程序"，不该出现在自动测试里。`--no-desktop` 可跳过建/删桌面，`--keep` 保留临时状态目录。

这一层是抓真 bug 的关键：早期版本 `list_windows` 返回的 `hwnd` 是 `"3084C"`（没有 `0x` 前缀），而 `window_info` 只认 `0x...`，于是"枚举→查询"这条最常用的链路直接断掉——单测和冒烟都测不到，因为各自都自洽。

## 开发时的一个坑：改代码要重新安装

DSH 用 pnpm 装 `file:` 依赖时是**硬链接/拷贝**整个包到 `~/.dsh/profiles/desktop/node_modules/`，不是目录软链。所以：

| 改了什么 | 要做什么 |
|---|---|
| `lib/*.js`、`index.js` | 重新 `install.ps1`（或直接改 node_modules 里的副本）才会反映到运行中的 DSH |
| `native/**/*.cs` | `npm run build:host` 重新生成 `dist/vdmhost.exe`，**然后**重新安装（副本里的 exe 不会自己更新） |
| `scripts/`、`tests/`、文档 | 不用重装 |

改完想立刻验证原生层，不必等插件装载——直接 `node tests/host-smoke.mjs`，它走的是同一套 `bridge.js` 调用路径。

## 兼容性

已在 **Windows 11 25H2（build 26200, UBR 9711）** 实测通过。完整矩阵与每个版本的风险点见 [docs/compatibility.md](docs/compatibility.md)。

## 已知限制

见 [docs/limitations.md](docs/limitations.md)。几条最要紧的：

- 窗口创建的那一瞬间**一定**先出现在当前显示的桌面上，随后才被移走（虚拟桌面固有行为，无法消除）。
- 应用商店版/转发壳程序（例如 `notepad.exe`）真正的 UI 在另一个进程里，启动参数可能被忽略，窗口可能抢前台。
- GPU 直出、DRM 受保护、硬件覆盖层窗口截出来可能是空白——检测得到，但抓不到。
- 内部 COM 接口**未公开**，Windows 大版本更新可能失效。失效时插件会明确报"接口版本不匹配"，而不是静默乱切桌面。

## 免责声明

1. 本插件使用**未公开**的 Windows 内部 COM 接口（`IVirtualDesktopManagerInternal` 等）来创建/删除/切换虚拟桌面。微软不保证这些接口在未来的 Windows 版本中保持稳定，Windows 更新后本插件可能失效。
2. 接口签名与 vtable 顺序来自公开的开源社区逆向成果（见致谢），**不是官方文档**。本项目只在声明支持的构建号上做过实测。
3. 本插件会启动、移动、截图、关闭**你指定**的程序。请自行确认目标窗口。`close_window` 只发 `WM_CLOSE`，但程序弹了保存对话框时可能一直卡在那里——插件会提示"交给用户处理"，不会替你强杀，也不会替你决定未保存内容怎么办。
4. 虚拟桌面**不提供**任何安全隔离。不要把本插件当作沙箱使用，不要在里面运行不信任的程序。
5. 本插件不拦截、也不保证其他软件对你系统的输入注入或抢占；它只约束**自己**的行为。
6. 审计日志与截图保存在你本机 `~/.dsh/virtual-desktop-manager/`，不上传任何地方。截图可能包含敏感内容，自己注意清理。
7. 按 MIT 许可"按现状"提供，不附带任何担保。使用本插件造成的窗口丢失、程序异常、桌面被误删等问题，作者不承担责任。

## 致谢

- 虚拟桌面 COM 接口的 GUID 与 vtable 顺序参考 [MScholtes/VirtualDesktop](https://github.com/MScholtes/VirtualDesktop)（MIT, Copyright © 2017 Markus Scholtes）与 [saimanish1/logitech-ipc-protocol](https://github.com/saimanish1/logitech-ipc-protocol) 的交叉验证。
- 本项目为独立实现，只借鉴接口约定，不复制上述项目的代码逻辑。

## 许可

MIT，见 [LICENSE](LICENSE)。
