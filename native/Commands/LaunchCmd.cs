using System;
using System.Collections.Generic;
using System.Text;
using VdmHost.Interop;
using VdmHost.Support;

namespace VdmHost.Commands
{
    internal static class LaunchCmd
    {
        public static object Run(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            // 参数名同时接受 path（Node 层用）和 file（早期手测脚本用）
            string file = Program.OptString(input, "path") ?? Program.OptString(input, "file");
            if (string.IsNullOrWhiteSpace(file))
                throw new VdmException("invalid_argument", "path 必填（EXE 的完整路径，或已在 PATH 中的名字）");

            var spec = new LaunchSpec
            {
                File = file.Trim(),
                Arguments = ReadArguments(input),
                WorkingDirectory = Program.OptString(input, "cwd"),
                WaitForWindowMs = Program.OptInt(input, "waitForWindowMs", 8000),
                Style = ParseStyle(Program.OptString(input, "windowStyle", "normal")),
            };

            string desktopRaw = Program.OptString(input, "desktopId");
            Guid? target = null;
            if (!string.IsNullOrWhiteSpace(desktopRaw))
            {
                Guid g;
                if (!Guid.TryParse(desktopRaw, out g))
                    throw new VdmException("invalid_argument", "desktopId 不是合法 GUID");
                if (api.Find(g) == null)
                    throw new VdmException("desktop_not_found", "目标虚拟桌面 " + g + " 不存在。请先 list_desktops。");
                target = g;
            }

            LaunchResult result = Launcher.Launch(spec);
            warnings.AddRange(result.Warnings);

            string processName = null;
            string title = null;
            string hwndHex = null;
            if (result.WindowFound)
            {
                hwndHex = new IntPtr(result.Hwnd).ToInt64().ToString("X");
                if (result.Window != null)
                {
                    processName = result.Window.ProcessName;
                    title = result.Window.Title;
                }
            }
            if (string.IsNullOrEmpty(processName))
            {
                try { processName = System.IO.Path.GetFileName(result.Executable); } catch { }
            }

            var data = new Dictionary<string, object>
            {
                { "pid", result.Pid },
                { "processName", processName },
                { "executable", result.Executable },
                { "commandLine", BuildCommandLine(result.Executable, result.Arguments) },
                { "windowFound", result.WindowFound },
                { "windowMatchedByPid", result.WindowMatchedByPid },
                { "hwnd", hwndHex },
                { "windowTitle", title },
                { "windowVisible", result.Window != null ? (object)result.Window.Visible : null },
                { "windowMinimized", result.Window != null ? (object)result.Window.Minimized : null },
                { "foregroundStolen", result.ForegroundStolen },
                { "windowStyleRequested", StyleName(result.StyleRequested) },
                { "windowStyleApplied", result.StyleApplied.HasValue ? (object)result.StyleApplied.Value : null },
                { "note", "启动瞬间窗口会先出现在当前显示的桌面上，随后才被移走；这是虚拟桌面的固有行为，无法完全隐藏。" },
            };

            if (target.HasValue && result.WindowFound)
            {
                IntPtr hwnd = new IntPtr(result.Hwnd);
                bool isForeground = Win32.GetForegroundWindow() == hwnd;
                bool avoidForegroundMove = Program.OptBool(input, "avoidForegroundMove", false);

                if (isForeground && avoidForegroundMove)
                {
                    warnings.Add("刚启动的窗口抢到了前台，且传入 avoidForegroundMove=true，因此没有移动它。"
                        + "确认无害后可用 move_window 配 allowForeground=true 手动移走。");
                    data["moveSkipped"] = "window_is_foreground";
                }
                else
                {
                    // 注意：这里和 move_window 的策略不同。move_window 保护的是"用户自己的窗口"；
                    // 这个窗口是我们刚刚亲手启动并识别到的，移走它才是对用户有利的操作，
                    // 所以即使它抢到了前台也照移，只如实记录下"它抢过前台"这件事。
                    if (isForeground)
                        warnings.Add("刚启动的窗口抢到了前台（启动参数没能阻止）。现在把它移到目标桌面，让它从用户眼前消失。");

                    try
                    {
                        string detail;
                        string via = api.MoveWindow(hwnd, target.Value, out detail);
                        Guid? after = api.WindowDesktop(hwnd);
                        bool ok = after.HasValue && after.Value == target.Value;
                        data["desktopId"] = target.Value.ToString();
                        data["moveChannel"] = via;
                        data["moveDetail"] = detail;
                        if (ok) data["movedTo"] = target.Value.ToString();
                        if (!ok)
                            warnings.Add("启动成功但窗口没能移到目标桌面（当前归属 "
                                + (after.HasValue ? after.Value.ToString() : "未知") + "）。可稍后重试 move_window。");
                    }
                    catch (VdmException ex)
                    {
                        data["moveError"] = ex.Message;
                        warnings.Add("启动成功，但移动窗口失败：" + ex.Message);
                    }
                }
            }
            else if (target.HasValue)
            {
                data["moveSkipped"] = "window_not_found";
            }

            return data;
        }

        /// <summary>args 既接受字符串数组（推荐），也接受单个字符串（老脚本用）。</summary>
        private static string ReadArguments(Dictionary<string, object> input)
        {
            object v;
            if (!input.TryGetValue("args", out v) || v == null) return string.Empty;

            if (v is object[] array)
            {
                var sb = new StringBuilder();
                foreach (object item in array)
                {
                    if (item == null) continue;
                    string s = Convert.ToString(item);
                    if (s == null) continue;
                    if (sb.Length > 0) sb.Append(' ');
                    sb.Append(Quote(s));
                }
                return sb.ToString();
            }

            string single = Convert.ToString(v);
            return single ?? string.Empty;
        }

        private static string Quote(string s)
        {
            if (s.Length == 0) return "\"\"";
            if (s.IndexOf(' ') < 0 && s.IndexOf('\t') < 0 && s.IndexOf('"') < 0) return s;
            return "\"" + s.Replace("\"", "\\\"") + "\"";
        }

        private static string BuildCommandLine(string exe, string args)
        {
            if (string.IsNullOrEmpty(args)) return Quote(exe);
            return Quote(exe) + " " + args;
        }

        private static WindowStyleMode ParseStyle(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return WindowStyleMode.Normal;
            switch (raw.Trim().ToLowerInvariant())
            {
                case "minimized":
                case "minimised":
                case "minimize":
                    return WindowStyleMode.Minimized;
                case "hidden":
                case "hide":
                    return WindowStyleMode.Hidden;
                case "normal":
                case "shownormal":
                default:
                    return WindowStyleMode.Normal;
            }
        }

        private static string StyleName(WindowStyleMode style)
        {
            switch (style)
            {
                case WindowStyleMode.Minimized: return "minimized";
                case WindowStyleMode.Hidden: return "hidden";
                default: return "normal";
            }
        }
    }
}
