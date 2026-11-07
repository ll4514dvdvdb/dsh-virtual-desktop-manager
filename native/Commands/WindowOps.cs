using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using VdmHost.Interop;
using VdmHost.Support;

namespace VdmHost.Commands
{
    internal static class WindowOps
    {
        public static object List(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            bool includeHidden = Program.OptBool(input, "includeHidden", false);
            int limit = Program.OptInt(input, "limit", 200);
            if (limit <= 0 || limit > 2000) limit = 200;

            string desktopFilter = Program.OptString(input, "desktopId");
            Guid? desktopId = null;
            if (!string.IsNullOrWhiteSpace(desktopFilter))
            {
                Guid g;
                if (!Guid.TryParse(desktopFilter, out g))
                    throw new VdmException("invalid_argument", "desktopId 不是合法 GUID");
                desktopId = g;
            }

            int pidFilter = Program.OptInt(input, "pid", 0);
            string nameFilter = Program.OptString(input, "processName");
            string titleFilter = Program.OptString(input, "titleContains");

            List<WindowInfo> all = Windows.Enumerate(api, includeHidden, true);
            var items = new List<object>();
            int truncated = 0;

            foreach (var w in all)
            {
                if (desktopId.HasValue && (!w.DesktopId.HasValue || w.DesktopId.Value != desktopId.Value)) continue;
                if (pidFilter > 0 && (int)w.Pid != pidFilter) continue;
                if (!string.IsNullOrWhiteSpace(nameFilter) &&
                    (w.ProcessName == null || w.ProcessName.IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) < 0)) continue;
                if (!string.IsNullOrWhiteSpace(titleFilter) &&
                    (w.Title == null || w.Title.IndexOf(titleFilter, StringComparison.OrdinalIgnoreCase) < 0)) continue;

                if (items.Count >= limit) { truncated++; continue; }
                items.Add(w.ToJson());
            }

            if (truncated > 0)
                warnings.Add($"结果被 limit={limit} 截断，还有 {truncated} 个窗口未返回。");

            Guid current = Guid.Empty;
            try { current = api.CurrentId(); } catch { }

            return new Dictionary<string, object>
            {
                { "currentDesktopId", current == Guid.Empty ? null : current.ToString() },
                { "totalMatched", items.Count + truncated },
                { "returned", items.Count },
                { "windows", items },
                { "note", "onCurrentDesktop 为 true 表示窗口在用户当前看的桌面上；virtualDesktopId 为 null 通常是窗口还没进 shell 视图集合（刚创建或已隐藏）。" },
            };
        }

        public static object Info(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            long raw = Program.RequiredHwnd(input);
            IntPtr hwnd = new IntPtr(raw);
            WindowInfo w = Windows.Describe(hwnd);
            if (w == null) throw new VdmException("invalid_hwnd", $"窗口 0x{raw:X} 不存在（可能已关闭）");
            Windows.FillDesktop(api, w);

            var data = w.ToJson();
            // GetForegroundWindow() 在窗口被移到别的虚拟桌面之后，仍可能返回它（实测：记事本移到
            // AI 工作桌面后 GetForegroundWindow() 依然是它）。用户看不见的窗口不可能是在"操作"，
            // 所以这里必须叠加"窗口就在当前显示的桌面上"这个条件，否则会误报"这是用户正在用的窗口"。
            bool foreground = Win32.GetForegroundWindow() == hwnd && w.OnCurrentDesktop == true;
            data["isForeground"] = foreground;
            if (!foreground && Win32.GetForegroundWindow() == hwnd)
            {
                data["foregroundNote"] =
                    "GetForegroundWindow() 仍指向这个窗口，但它不在用户当前显示的桌面上（已 cloaked），"
                    + "用户看不到也碰不到它，因此不判定为用户正在操作的窗口。";
            }
            return data;
        }

        public static object Move(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            long raw = Program.RequiredHwnd(input);
            Guid target = Program.RequiredGuid(input);
            bool allowForeground = Program.OptBool(input, "allowForeground", false);
            IntPtr hwnd = new IntPtr(raw);

            if (!Win32.IsWindow(hwnd))
                throw new VdmException("invalid_hwnd", $"窗口 0x{raw:X} 不存在（可能已关闭）");

            if (api.Find(target) == null)
                throw new VdmException("desktop_not_found", $"目标虚拟桌面 {target} 不存在（可能已被用户手动删除）。请先 list_desktops 重新确认。");

            // 硬保护：绝不移动用户正在操作的窗口。这是需求里最不能出错的一条。
            if (Win32.GetForegroundWindow() == hwnd && !allowForeground)
            {
                throw new VdmException("target_is_foreground",
                    $"窗口 0x{raw:X} 正是当前前台窗口，移动它会把用户正在使用（很可能是游戏）的窗口从眼前拿走。"
                    + "如确有需要，先确认该窗口属于本次任务并显式传 allowForeground=true。");
            }

            // 子窗口/控件跟着父窗口走，单独"移动"到别的桌面没有意义，
            // 而且用户多半是抓错了 hwnd（把按钮、编辑框当成窗口）。当场拒绝比默默做无效操作好。
            IntPtr root = Win32.GetAncestor(hwnd, Win32.GA_ROOT);
            if (root != hwnd)
            {
                throw new VdmException("not_a_top_level_window",
                    $"0x{raw:X} 不是顶层窗口（它是 0x{root.ToInt64():X} 的子窗口/控件）。"
                    + "子窗口跟着父窗口一起走，不能单独移动。请对顶层窗口操作——用 list_windows 拿 isTopLevel:true 的那些。");
            }

            WindowInfo before = Windows.Describe(hwnd);
            Guid? beforeDesktop = api.WindowDesktop(hwnd);

            // "当前前台"只是用户正在操作的一种情形：焦点可能在别的窗口上，而用户眼前这个窗口
            // 仍然是他要看的（比如游戏窗口失焦后被通知打断）。移走它同样会让他眼前的东西消失，
            // 所以这种情况不下手也不是自动决定的——至少要说清楚，别让调用方以为悄无声息。
            if (before != null && before.Visible && beforeDesktop.HasValue && beforeDesktop.Value == api.CurrentId())
            {
                warnings.Add(
                    $"这个窗口原本就在用户当前显示的桌面上（0x{raw:X}「{before.Title}」）。移走之后它会从用户眼前消失；"
                    + "如果那是用户正在看/正在玩的东西，请立刻用 move_window 移回原桌面。");
            }

            if (beforeDesktop.HasValue && beforeDesktop.Value == target)
            {
                return new Dictionary<string, object>
                {
                    { "moved", false },
                    { "reason", "already_on_target" },
                    { "hwnd", "0x" + hwnd.ToInt64().ToString("X") },
                    { "desktopId", target.ToString() },
                };
            }

            string detail;
            string via;
            try
            {
                via = api.MoveWindow(hwnd, target, out detail);
            }
            catch (VdmException ex) when (ex.Code == "move_failed" && before != null && !before.Visible)
            {
                // 隐藏窗口不在 shell 视图集合里。用"显示但不激活"的方式让它进入集合后重试一次。
                // 这是参考实现的做法，但我们把它限制到只对隐藏窗口、且只重试一次。
                warnings.Add("窗口不可见，先以 SW_SHOWNOACTIVATE 显示（不激活）以便加入 shell 视图集合，随后重试移动。");
                Win32.ShowWindow(hwnd, Win32.SW_SHOWNOACTIVATE);
                System.Threading.Thread.Sleep(900);
                via = api.MoveWindow(hwnd, target, out detail);
            }

            Guid? after = api.WindowDesktop(hwnd);
            bool verified = after.HasValue && after.Value == target;
            if (!verified)
                warnings.Add($"移动后复查显示窗口属于 {after?.ToString() ?? "未知"}，与目标 {target} 不一致。");

            return new Dictionary<string, object>
            {
                { "moved", true },
                { "hwnd", "0x" + hwnd.ToInt64().ToString("X") },
                { "desktopId", target.ToString() },
                { "previousDesktopId", beforeDesktop?.ToString() },
                { "verified", verified },
                { "channel", via },
                { "detail", detail },
                { "stayedVisibleOnUserDesktop", false },
            };
        }

        public static object CaptureTo(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            long raw = Program.RequiredHwnd(input);
            IntPtr hwnd = new IntPtr(raw);
            string outputPath = Program.OptString(input, "outputPath");
            if (string.IsNullOrWhiteSpace(outputPath))
                throw new VdmException("invalid_argument", "outputPath 必填：原生层把 PNG 直接写到磁盘，避免几 MB 的 base64 在 stdout 里往返。");
            bool clientOnly = Program.OptBool(input, "clientOnly", false);
            bool allowRestore = Program.OptBool(input, "allowRestore", false);
            bool strict = Program.OptBool(input, "strict", false);

            if (Win32.GetForegroundWindow() == hwnd)
                warnings.Add("被截图的窗口正处于前台。PrintWindow 不会把用户其他桌面内容拍进来，但如果你以为它在后台，请确认句柄。" );

            CaptureResult cap = Capture.CaptureWindow(hwnd, clientOnly, allowRestore);
            warnings.AddRange(cap.Warnings);

            string full = Path.GetFullPath(outputPath);
            string dir = Path.GetDirectoryName(full);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                throw new VdmException("output_dir_missing", $"输出目录不存在：{dir}");

            File.WriteAllBytes(full, cap.Png);

            var data = new Dictionary<string, object>
            {
                { "path", full },
                { "width", cap.Width },
                { "height", cap.Height },
                { "bytes", cap.Png.LongLength },
                { "printWindowOk", cap.PrintWindowOk },
                { "printWindowFlags", "0x" + cap.FlagsUsed.ToString("X") },
                { "suspectedBlank", cap.SuspectedBlank },
                { "sampledDistinctColors", cap.SampledDistinct },
                { "dominantColorShare", Math.Round(cap.DominantShare, 4) },
                { "dominantColor", cap.DominantColor },
                { "hints", cap.Hints.ToArray() },
                { "qualityVerdict", cap.SuspectedBlank ? "blank_or_uncapturable" : "ok" },
            };

            if (cap.SuspectedBlank && strict)
            {
                throw new VdmException("blank_capture",
                    $"截图疑似空白（主色 {cap.DominantColor} 占比 {cap.DominantShare:P1}，采样到 {cap.SampledDistinct} 种颜色），"
                    + "strict=true 因此判为失败。" + string.Join(" ", cap.Hints));
            }

            return data;
        }

        private static readonly HashSet<string> DocumentApps = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "notepad.exe", "notepad++.exe", "code.exe", "devenv.exe", "studio64.exe", "idea64.exe",
            "pycharm64.exe", "webstorm64.exe", "sublime_text.exe", "gvim.exe", "vim.exe", "emacs.exe",
            "winword.exe", "excel.exe", "powerpnt.exe", "onenote.exe", "outlook.exe", "acrord32.exe",
            "acrobat.exe", "photoshop.exe", "illustrator.exe", "blender.exe", "gimp-2.10.exe",
            "typora.exe", "obsidian.exe", "notion.exe", "wordpad.exe", "sqlserver.exe", "ssms.exe",
            "rider64.exe", "clion64.exe", "goland64.exe", "androidstudio64.exe", "inkscape.exe",
            "audacity.exe", "krita.exe", "libreoffice.exe", "soffice.bin", "wps.exe", "et.exe", "wpp.exe",
        };

        public static object Close(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            long raw = Program.RequiredHwnd(input);
            IntPtr hwnd = new IntPtr(raw);
            bool dryRun = Program.OptBool(input, "dryRun", true);
            int waitMs = Program.OptInt(input, "waitMs", 1500);

            WindowInfo w = Windows.Describe(hwnd);
            if (w == null) throw new VdmException("invalid_hwnd", $"窗口 0x{raw:X} 不存在（可能已关闭）");

            var reasons = new List<string>();
            string level = "low";

            if (w.Hung)
            {
                reasons.Add("窗口已无响应（IsHungAppWindow=true），关闭请求可能不会走到保存逻辑，也可能弹出一个系统等待框。");
                level = "high";
            }

            bool documentApp = w.ProcessName != null && DocumentApps.Contains(w.ProcessName);
            if (documentApp)
            {
                reasons.Add($"进程 {w.ProcessName} 属于文档/工程类程序，关窗可能触发未保存提示，或被直接丢弃。");
                if (level == "low") level = "medium";
            }

            string title = w.Title ?? string.Empty;
            if (title.TrimStart().StartsWith("*") || title.Contains(" *") || title.Contains("•") || title.Contains("[已修改]"))
            {
                reasons.Add("窗口标题看起来带有'未保存'标记（* / • / [已修改]），几乎可以肯定有未保存内容。");
                level = "high";
            }

            if (Win32.GetForegroundWindow() == hwnd)
            {
                reasons.Add("该窗口正处于前台，用户可能正在其中操作。");
                if (level == "low") level = "medium";
            }

            bool hasDialogChildren = HasModalDialog(hwnd);
            if (hasDialogChildren)
            {
                reasons.Add("窗口下存在对话框类子窗口，可能正在询问保存/确认。");
                level = "high";
            }

            var risk = new Dictionary<string, object>
            {
                { "level", level },
                { "reasons", reasons.ToArray() },
                { "processName", w.ProcessName },
                { "title", w.Title },
                { "notResponding", w.Hung },
            };

            if (dryRun)
            {
                return new Dictionary<string, object>
                {
                    { "hwnd", "0x" + raw.ToString("X") },
                    { "closed", false },
                    { "dryRun", true },
                    { "risk", risk },
                    { "how", "将以 PostMessage(WM_CLOSE) 发送普通的关闭请求，等同于用户点标题栏的 X；不会 TerminateProcess。" },
                };
            }

            if (level == "high" && !Program.OptBool(input, "force", false))
            {
                throw new VdmException("close_risky",
                    "关闭风险被判定为 high：" + string.Join(" ", reasons)
                    + " 请先与用户确认，或让用户自己保存并关闭；确实要关时传 force=true。");
            }

            bool posted = Win32.PostMessage(hwnd, Win32.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            if (!posted)
                throw new VdmException("close_failed", "PostMessage(WM_CLOSE) 失败，窗口可能属于其他会话或已销毁。");

            var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(200, waitMs));
            while (DateTime.UtcNow < deadline)
            {
                if (!Win32.IsWindow(hwnd)) break;
                System.Threading.Thread.Sleep(80);
            }

            bool stillOpen = Win32.IsWindow(hwnd);
            if (stillOpen)
            {
                warnings.Add("WM_CLOSE 已发送，窗口仍未关闭。这通常意味着程序弹出了保存/确认对话框在等人操作 —— "
                    + "请不要反复发送关闭请求，也不要强杀；交由用户处理。");
            }

            return new Dictionary<string, object>
            {
                { "hwnd", "0x" + raw.ToString("X") },
                { "closed", !stillOpen },
                { "stillOpen", stillOpen },
                { "dryRun", false },
                { "risk", risk },
                { "needsUserAttention", stillOpen },
            };
        }

        private static bool HasModalDialog(IntPtr parent)
        {
            // 常见的对话框类名（Win32 / WinForms / WPF / Electron 自定义）
            string[] classes = { "#32770", "Chrome_WidgetWin_1", "HwndWrapper" };
            bool found = false;
            try
            {
                // 用 EnumChildWindows 太重，这里只检查 GetLastActivePopup 是否不同。
                IntPtr popup = GetLastActivePopup(parent);
                if (popup != IntPtr.Zero && popup != parent && Win32.IsWindowVisible(popup))
                {
                    var sb = new StringBuilder(256);
                    Win32.GetClassName(popup, sb, sb.Capacity);
                    string cls = sb.ToString();
                    foreach (var c in classes)
                        if (string.Equals(cls, c, StringComparison.Ordinal)) { found = true; break; }
                    if (!found && cls.Length > 0) found = false;
                }
            }
            catch { }
            return found;
        }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern IntPtr GetLastActivePopup(IntPtr hWnd);
    }
}
