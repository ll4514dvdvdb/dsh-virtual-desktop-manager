// 窗口枚举与信息采集。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using VdmHost.Interop;

namespace VdmHost.Support
{
    internal sealed class WindowInfo
    {
        public IntPtr Hwnd;
        public uint Pid;
        public string ProcessName;
        public string ProcessPath;
        public string Title;
        public string ClassName;
        public bool Visible;
        public bool Minimized;
        public bool Maximized;
        public bool Cloaked;
        public bool Hung;
        public bool IsTopLevel;
        public IntPtr Owner;
        public long Style;
        public long ExStyle;
        public int X, Y, Width, Height;
        public Guid? DesktopId;
        public bool? OnCurrentDesktop;

        public Dictionary<string, object> ToJson()
        {
            return new Dictionary<string, object>
            {
                { "hwnd", Hwnd.ToInt64().ToString("X") },
                { "hwndDecimal", Hwnd.ToInt64() },
                { "pid", (long)Pid },
                { "processName", ProcessName },
                { "processPath", ProcessPath },
                { "title", Title },
                { "className", ClassName },
                { "visible", Visible },
                { "minimized", Minimized },
                { "maximized", Maximized },
                { "cloaked", Cloaked },
                { "notResponding", Hung },
                { "isTopLevel", IsTopLevel },
                { "rect", new Dictionary<string, object> { { "x", X }, { "y", Y }, { "width", Width }, { "height", Height } } },
                { "virtualDesktopId", DesktopId?.ToString() },
                { "onCurrentDesktop", OnCurrentDesktop },
            };
        }
    }

    internal static class Windows
    {
        /// <summary>
        /// 枚举顶层窗口。默认只返回 Alt-Tab 意义上的"用户可见窗口"：
        /// 有 WS_VISIBLE、未 DWM 隐身（cloaked，UWP 后台/切换桌面时会被隐身）、非工具窗口、
        /// 且是顶层（GetAncestor(GA_ROOT) == self，排除子窗口）。
        /// includeHidden=true 时返回所有顶级窗口，便于诊断"窗口还没创建/被藏起来"的情况。
        /// </summary>
        public static List<WindowInfo> Enumerate(DesktopApi desktop, bool includeHidden, bool fillDesktopInfo)
        {
            var result = new List<WindowInfo>();
            Win32.EnumWindows((hwnd, _) =>
            {
                var info = Describe(hwnd);
                if (info == null) return true;
                if (!includeHidden && !IsUserFacing(info)) return true;
                if (fillDesktopInfo && desktop != null) FillDesktop(desktop, info);
                result.Add(info);
                return true;
            }, IntPtr.Zero);
            return result;
        }

        public static bool IsUserFacing(WindowInfo w)
        {
            if (!w.Visible || w.Cloaked) return false;
            if ((w.ExStyle & Win32.WS_EX_TOOLWINDOW) != 0) return false;
            if (string.IsNullOrEmpty(w.Title) && (w.Owner == IntPtr.Zero)) return false;
            return true;
        }

        public static void FillDesktop(DesktopApi desktop, WindowInfo info)
        {
            try
            {
                info.DesktopId = desktop.WindowDesktop(info.Hwnd);
                info.OnCurrentDesktop = desktop.IsOnCurrentDesktop(info.Hwnd);
            }
            catch
            {
                info.DesktopId = null;
                info.OnCurrentDesktop = null;
            }
        }

        public static WindowInfo Describe(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return null;

            var w = new WindowInfo { Hwnd = hwnd };
            w.Visible = Win32.IsWindowVisible(hwnd);
            w.Minimized = Win32.IsIconic(hwnd);
            w.Maximized = Win32.IsZoomed(hwnd);
            w.IsTopLevel = Win32.GetAncestor(hwnd, Win32.GA_ROOT) == hwnd;
            w.Owner = Win32.GetWindow(hwnd, Win32.GW_OWNER);
            w.Style = Win32.GetWindowLongPtr(hwnd, Win32.GWL_STYLE).ToInt64();
            w.ExStyle = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64();

            int cloaked;
            w.Cloaked = Win32.DwmGetWindowAttribute(hwnd, Win32.DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0;
            w.Hung = Win32.IsHungAppWindow(hwnd);

            StringBuilder sb = new StringBuilder(512);
            Win32.GetClassName(hwnd, sb, sb.Capacity);
            w.ClassName = sb.ToString();

            int len = Win32.GetWindowTextLength(hwnd);
            if (len > 0)
            {
                sb = new StringBuilder(len + 2);
                Win32.GetWindowText(hwnd, sb, sb.Capacity);
                w.Title = sb.ToString();
            }
            else w.Title = string.Empty;

            RECT rect;
            if (Win32.GetWindowRect(hwnd, out rect))
            {
                w.X = rect.Left; w.Y = rect.Top;
                w.Width = rect.Width; w.Height = rect.Height;
            }

            uint pid;
            Win32.GetWindowThreadProcessId(hwnd, out pid);
            w.Pid = pid;
            FillProcess(w);

            return w;
        }

        private static readonly Dictionary<uint, string[]> ProcessNameCache = new Dictionary<uint, string[]>();
        private static readonly object ProcessNameLock = new object();

        private static void FillProcess(WindowInfo w)
        {
            if (w.Pid == 0) return;
            string[] cached;
            lock (ProcessNameLock)
            {
                if (ProcessNameCache.TryGetValue(w.Pid, out cached))
                {
                    w.ProcessName = cached[0];
                    w.ProcessPath = cached[1];
                    return;
                }
            }

            string name = null, path = null;
            IntPtr h = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION, false, w.Pid);
            if (h != IntPtr.Zero)
            {
                try
                {
                    uint size = 1024;
                    var buf = new StringBuilder((int)size);
                    if (Win32.QueryFullProcessImageName(h, 0, buf, ref size))
                    {
                        path = buf.ToString();
                        try { name = System.IO.Path.GetFileName(path); } catch { }
                    }
                }
                finally { Win32.CloseHandle(h); }
            }

            if (name == null)
            {
                try
                {
                    using (var p = Process.GetProcessById((int)w.Pid))
                    {
                        name = p.ProcessName + ".exe";
                        try { path = p.MainModule?.FileName; } catch { }
                    }
                }
                catch { name = "<未知进程>"; }
            }

            lock (ProcessNameLock)
            {
                if (ProcessNameCache.Count > 4096) ProcessNameCache.Clear();
                ProcessNameCache[w.Pid] = new[] { name, path };
            }
            w.ProcessName = name;
            w.ProcessPath = path;
        }

        /// <summary>只取进程名（带 .exe），走同一份缓存，用于启动后按进程名兜底匹配窗口。</summary>
        public static string ProcessName(uint pid)
        {
            if (pid == 0) return null;
            var w = new WindowInfo { Pid = pid };
            FillProcess(w);
            return w.ProcessName;
        }

        public static void ClearCache()
        {
            lock (ProcessNameLock) ProcessNameCache.Clear();
        }
    }
}
