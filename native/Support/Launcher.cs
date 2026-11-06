// 程序启动 + 找到它真正的窗口。
//
// 两个现实问题必须按事实处理，不能靠假设：
// 1) WindowStyle=Minimized / Hidden 经常被 GUI 程序忽略 —— 所以启动前后都记录 GetForegroundWindow，
//    把"是否真的抢了前台""窗口样式是否真的生效"当成事实写进返回值，由上层如实转告。
// 2) 很多程序（应用商店版、单实例转交、启动器）的窗口不在我们拿到的 PID 里。
//    先按 PID 找，找不到再按"进程名 + 启动时间"兜底匹配，并明确告知这次是兜底匹配出来的。
//
// 另外用 CreateProcess 显式 bInheritHandles=FALSE + 标准句柄置为 INVALID_HANDLE_VALUE：
// 否则被启动的程序会继承 vdmhost 的 stdout 管道，调用方要等到那个程序退出才能读到 EOF。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using VdmHost.Interop;

namespace VdmHost.Support
{
    internal enum WindowStyleMode
    {
        Normal,
        Minimized,
        Hidden,
    }

    internal sealed class LaunchSpec
    {
        public string File;
        public string Arguments;
        public string WorkingDirectory;
        public int WaitForWindowMs = 8000;
        public WindowStyleMode Style = WindowStyleMode.Normal;
    }

    internal sealed class LaunchResult
    {
        public int Pid;
        public string Executable;
        public string Arguments;
        public long ForegroundBefore;
        public long ForegroundAfter;
        public bool ForegroundStolen;
        public long Hwnd;
        public WindowInfo Window;
        public bool WindowFound;
        /// <summary>窗口是按 PID 找到的（true），还是按进程名兜底匹配到的（false）。</summary>
        public bool WindowMatchedByPid;
        public WindowStyleMode StyleRequested;
        /// <summary>请求的窗口样式是否真的生效；null 表示拿不到窗口、无法判定。</summary>
        public bool? StyleApplied;
        public List<string> Warnings = new List<string>();
    }

    internal static class Launcher
    {
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcess(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO si,
            out PROCESS_INFORMATION pi);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const int STARTF_USESHOWWINDOW = 0x00000001;
        private const int STARTF_USESTDHANDLES = 0x00000100;
        private const short SW_HIDE = 0;
        private const short SW_SHOWMINNOACTIVE = 7;

        public static LaunchResult Launch(LaunchSpec spec)
        {
            if (string.IsNullOrWhiteSpace(spec.File))
                throw new VdmException("invalid_argument", "path 不能为空");

            string workDir = spec.WorkingDirectory;
            if (!string.IsNullOrWhiteSpace(workDir))
            {
                if (!Directory.Exists(workDir))
                    throw new VdmException("cwd_not_found", "工作目录不存在：" + workDir);
            }
            else
            {
                // 不设 cwd 时用 EXE 所在目录，避免程序把配置写进 vdmhost 的当前目录
                try { workDir = Path.GetDirectoryName(Path.GetFullPath(spec.File)); } catch { workDir = null; }
            }

            var result = new LaunchResult
            {
                Executable = spec.File,
                Arguments = spec.Arguments,
                StyleRequested = spec.Style,
            };
            result.ForegroundBefore = GetForegroundWindow().ToInt64();

            var si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags = STARTF_USESTDHANDLES;
            // INVALID_HANDLE_VALUE(-1)：子进程拿不到我们的管道/文件句柄，stdout 不会被它一直占着
            si.hStdInput = new IntPtr(-1);
            si.hStdOutput = new IntPtr(-1);
            si.hStdError = new IntPtr(-1);

            if (spec.Style == WindowStyleMode.Minimized)
            {
                si.dwFlags |= STARTF_USESHOWWINDOW;
                si.wShowWindow = SW_SHOWMINNOACTIVE;
            }
            else if (spec.Style == WindowStyleMode.Hidden)
            {
                si.dwFlags |= STARTF_USESHOWWINDOW;
                si.wShowWindow = SW_HIDE;
            }

            var cmdline = new StringBuilder(BuildCommandLine(spec.File, spec.Arguments));
            var pi = new PROCESS_INFORMATION();
            var launchedAt = DateTime.Now;

            bool ok = CreateProcess(
                null,
                cmdline,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_NO_WINDOW,
                IntPtr.Zero,
                workDir,
                ref si,
                out pi);

            if (!ok)
            {
                int err = Marshal.GetLastWin32Error();
                throw new VdmException("launch_failed",
                    "启动 " + spec.File + " 失败：CreateProcess 返回错误 " + err + "（" + ExplainWin32(err) + "）");
            }

            try
            {
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            }
            catch { }

            result.Pid = pi.dwProcessId;
            if (result.Pid == 0)
                throw new VdmException("launch_failed", "CreateProcess 没有返回进程 ID。");

            Process proc = null;
            try { proc = Process.GetProcessById(result.Pid); } catch { }

            // hidden 样式下窗口本来就不可见，必须连隐藏窗口一起找，否则永远找不到
            bool includeInvisible = spec.Style == WindowStyleMode.Hidden;
            string exeBase = BaseName(spec.File);

            IntPtr hwnd = IntPtr.Zero;
            bool matchedByPid = false;
            bool exitReported = false;
            DateTime? exitedAt = null;
            var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(0, spec.WaitForWindowMs));
            while (DateTime.UtcNow < deadline)
            {
                hwnd = FindWindowForPid((uint)result.Pid, includeInvisible);
                if (hwnd != IntPtr.Zero)
                {
                    matchedByPid = true;
                    break;
                }

                hwnd = FindWindowByName(exeBase, launchedAt, includeInvisible, (uint)result.Pid);
                if (hwnd != IntPtr.Zero) break;

                if (proc != null && HasExited(proc))
                {
                    if (!exitReported)
                    {
                        exitReported = true;
                        exitedAt = DateTime.UtcNow;
                        result.Warnings.Add("进程 " + result.Pid + " 在窗口出现前就退出了（ExitCode=" + SafeExitCode(proc) + "）。"
                            + "常见于转交给常驻实例的程序、应用商店版程序的转发壳。继续按进程名等 5 秒，看真正的 UI 是否由别的进程建起来。");
                    }
                    // 转发壳退出后真正的 UI 进程才起来，给它 5 秒；再没有就放弃
                    if (exitedAt.HasValue && (DateTime.UtcNow - exitedAt.Value).TotalMilliseconds > 5000) break;
                }

                System.Threading.Thread.Sleep(120);
            }

            result.ForegroundAfter = GetForegroundWindow().ToInt64();
            result.ForegroundStolen = result.ForegroundAfter != result.ForegroundBefore;

            if (hwnd == IntPtr.Zero)
            {
                result.Warnings.Add("在 " + spec.WaitForWindowMs + "ms 内没有找到属于 PID " + result.Pid + " 的顶层窗口。"
                    + "该程序可能仍在初始化、把 UI 放在子进程里、或窗口被隐藏/托盘化。可用 list_windows 复查。");
                return result;
            }

            result.Hwnd = hwnd.ToInt64();
            result.WindowFound = true;
            result.WindowMatchedByPid = matchedByPid;
            result.Window = Windows.Describe(hwnd);

            if (!matchedByPid)
            {
                result.Warnings.Add("PID " + result.Pid + " 自己没建窗口，按进程名 \"" + exeBase
                    + "\" 兜底匹配到了 PID " + result.Window.Pid + " 的窗口。"
                    + "这类程序（应用商店版 / 单实例转交 / 启动器）的实际 UI 在另一个进程里，移动窗口前请确认这就是目标程序。");
            }

            // 判定"请求的窗口样式是否真的生效"——需求里点名要求不能假设启动参数生效
            result.StyleApplied =
                spec.Style == WindowStyleMode.Minimized ? result.Window.Minimized
                : spec.Style == WindowStyleMode.Hidden ? !result.Window.Visible
                : !result.Window.Minimized;

            if (result.StyleApplied == false)
            {
                result.Warnings.Add("请求的窗口样式（" + StyleName(spec.Style) + "）没有生效：实测窗口 "
                    + (result.Window.Minimized ? "处于最小化" : result.Window.Visible ? "以正常状态可见" : "处于隐藏")
                    + "。该程序忽略了启动参数，不要假定它被最小化了。");
            }

            if (result.ForegroundStolen && result.ForegroundAfter == hwnd.ToInt64())
            {
                result.Warnings.Add("这次启动把该窗口激活到了前台（启动参数没能阻止）。这是 Windows 的行为；"
                    + "要彻底避免，应在 AI 工作桌面获得输入焦点时再启动程序。");
            }
            else if (result.ForegroundStolen)
            {
                result.Warnings.Add("启动后前台窗口发生了变化，但不一定是本次启动的窗口。");
            }

            return result;
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

        private static string BaseName(string file)
        {
            try
            {
                string name = Path.GetFileName(file);
                if (string.IsNullOrEmpty(name)) name = file;
                if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                    name = name.Substring(0, name.Length - 4);
                return name;
            }
            catch { return file; }
        }

        private static string BuildCommandLine(string file, string args)
        {
            string exe = file;
            if (exe.IndexOf(' ') >= 0 && !(exe.StartsWith("\"") && exe.EndsWith("\"")))
                exe = "\"" + exe + "\"";
            return string.IsNullOrEmpty(args) ? exe : exe + " " + args;
        }

        private static bool HasExited(Process proc)
        {
            try { return proc.HasExited; } catch { return false; }
        }

        private static int SafeExitCode(Process proc)
        {
            try { return proc.HasExited ? proc.ExitCode : 0; } catch { return 0; }
        }

        private static string ExplainWin32(int err)
        {
            switch (err)
            {
                case 2: return "系统找不到指定的文件，路径可能不对";
                case 3: return "系统找不到指定的路径";
                case 5: return "拒绝访问，可能是需要管理员权限的程序";
                case 193: return "不是有效的 Win32 应用程序（位数或格式不对）";
                case 267: return "目录名无效（cwd 参数可能有问题）";
                case 740: return "这个程序要求提升权限，当前进程无法直接启动它";
                default: return "未知 Win32 错误";
            }
        }

        /// <summary>
        /// 按进程名 + 启动时间兜底找窗口：覆盖"应用商店版 / 单实例转交 / 启动器拉起的子进程"这类情况。
        /// 只接受在本进程启动时刻前后创建、且进程名匹配的窗口，避免误抓用户早就开着的同名程序。
        /// </summary>
        private static IntPtr FindWindowByName(string exeBase, DateTime launchedAt, bool includeInvisible, uint excludePid)
        {
            if (string.IsNullOrEmpty(exeBase) || exeBase.Length < 2) return IntPtr.Zero;

            IntPtr best = IntPtr.Zero;
            int bestScore = -1;
            var earliest = launchedAt.AddSeconds(-2);

            Win32.EnumWindows((hwnd, _) =>
            {
                if (Win32.GetAncestor(hwnd, Win32.GA_ROOT) != hwnd) return true;

                bool visible = Win32.IsWindowVisible(hwnd);
                if (!visible && !includeInvisible) return true;

                int cloaked;
                if (Win32.DwmGetWindowAttribute(hwnd, Win32.DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0)
                    return true;

                long ex = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64();
                if ((ex & Win32.WS_EX_TOOLWINDOW) != 0) return true;

                uint winPid;
                Win32.GetWindowThreadProcessId(hwnd, out winPid);
                if (winPid == 0 || winPid == excludePid) return true;

                string name = Windows.ProcessName(winPid);
                if (string.IsNullOrEmpty(name)) return true;
                if (!string.Equals(StripExe(name), exeBase, StringComparison.OrdinalIgnoreCase)) return true;

                DateTime started;
                if (!TryStartTime(winPid, out started) || started < earliest) return true;

                if (Win32.GetWindowTextLength(hwnd) <= 0) return true;

                int score = 1;
                if (Win32.GetWindow(hwnd, Win32.GW_OWNER) == IntPtr.Zero) score += 1;
                if (visible) score += 1;

                if (score > bestScore)
                {
                    bestScore = score;
                    best = hwnd;
                }
                return true;
            }, IntPtr.Zero);

            return best;
        }

        private static string StripExe(string name)
        {
            return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? name.Substring(0, name.Length - 4)
                : name;
        }

        private static bool TryStartTime(uint pid, out DateTime started)
        {
            started = DateTime.MinValue;
            try
            {
                using (var p = Process.GetProcessById((int)pid))
                {
                    started = p.StartTime;
                    return true;
                }
            }
            catch { return false; }
        }

        /// <summary>
        /// 按 PID 找顶层窗口。优先返回有标题、无 owner 的那个，避免拿到 IME / 提示气泡 / 托盘窗口。
        /// </summary>
        public static IntPtr FindWindowForPid(uint pid, bool includeInvisible = false)
        {
            IntPtr best = IntPtr.Zero;
            int bestScore = -1;
            Win32.EnumWindows((hwnd, _) =>
            {
                uint winPid;
                Win32.GetWindowThreadProcessId(hwnd, out winPid);
                if (winPid != pid) return true;
                if (Win32.GetAncestor(hwnd, Win32.GA_ROOT) != hwnd) return true;

                bool visible = Win32.IsWindowVisible(hwnd);
                if (!visible && !includeInvisible) return true;

                int cloaked;
                if (Win32.DwmGetWindowAttribute(hwnd, Win32.DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0)
                    return true;

                long ex = Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64();
                if ((ex & Win32.WS_EX_TOOLWINDOW) != 0) return true;

                int len = Win32.GetWindowTextLength(hwnd);
                int score = 0;
                if (len > 0) score += 2;
                if (Win32.GetWindow(hwnd, Win32.GW_OWNER) == IntPtr.Zero) score += 1;

                if (score > bestScore)
                {
                    bestScore = score;
                    best = hwnd;
                }
                return true;
            }, IntPtr.Zero);
            return best;
        }
    }
}
