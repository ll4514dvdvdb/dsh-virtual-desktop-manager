// vdmhost —— 单次调用式原生助手。
//
// 约定：
//   用法   vdmhost <command>   参数从 stdin 读一个 JSON 对象
//   输出   stdout 恰好一个 JSON 对象；日志一律走 stderr
//   退出码 0 = ok，1 = 业务错误，2 = 用法错误
//
// 为什么是"单次调用"而不是常驻服务：DSH 的每个工具调用都很短，进程启动约 15~40ms，
// 换来的是完全没有 IPC 生命周期、端口占用、僵尸进程问题。COM 在每次调用里重新初始化。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using VdmHost.Interop;
using VdmHost.Support;

namespace VdmHost
{
    internal static class Program
    {
        private const string HostVersion = "0.1.1";

        [STAThread]
        private static int Main(string[] args)
        {
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
            var sw = Stopwatch.StartNew();

            if (args.Length == 0)
            {
                WriteError("missing_command", "用法：vdmhost <command>，JSON 参数从 stdin 读取。已知命令见 capabilities。", null, sw);
                return 2;
            }

            string command = args[0];
            Dictionary<string, object> input;
            try
            {
                input = ReadInput();
            }
            catch (Exception ex)
            {
                WriteError("bad_input_json", "stdin 不是合法 JSON 对象：" + ex.Message, null, sw);
                return 2;
            }

            var warnings = new List<string>();
            var api = new AnonymousDesktop();
            try
            {
                object data = Dispatch(command, input, api, warnings);
                WriteOk(data, warnings, sw);
                return 0;
            }
            catch (VdmException ex)
            {
                WriteError(ex.Code, ex.Message, null, sw, warnings);
                return 1;
            }
            catch (VdmUnavailableException ex)
            {
                WriteError("com_unavailable", ex.Message, ex.HResultCode, sw, warnings);
                return 1;
            }
            catch (Exception ex)
            {
                Log("未处理异常：" + ex);
                WriteError("internal_error", ex.Message, ex.HResult, sw, warnings);
                return 1;
            }
            finally
            {
                api.Dispose();
            }
        }

        /// <summary>DesktopApi 的惰性持有者：非桌面命令（如 ping）不该因为 COM 不可用而失败。</summary>
        private sealed class AnonymousDesktop : IDisposable
        {
            private DesktopApi _api;
            public DesktopApi Get()
            {
                if (_api == null) _api = new DesktopApi();
                return _api;
            }
            public void Dispose()
            {
                if (_api != null) { try { _api.Dispose(); } catch { } _api = null; }
            }
        }

        private static object Dispatch(string command, Dictionary<string, object> input, AnonymousDesktop api, List<string> warnings)
        {
            switch (command.ToLowerInvariant())
            {
                case "ping":
                    return new Dictionary<string, object> { { "pong", true }, { "host", HostVersion }, { "pid", Process.GetCurrentProcess().Id } };

                case "capabilities":
                    return Capabilities(api, warnings);

                case "list_desktops":
                    return Commands.Desktops.List(api.Get(), warnings);

                case "get_current_desktop":
                    return Commands.Desktops.Current(api.Get(), warnings);

                case "create_desktop":
                    return Commands.Desktops.Create(api.Get(), input, warnings);

                case "switch_desktop":
                    return Commands.Desktops.Switch(api.Get(), input, warnings);

                case "remove_desktop":
                    return Commands.Desktops.Remove(api.Get(), input, warnings);

                case "list_windows":
                    return Commands.WindowOps.List(api.Get(), input, warnings);

                case "window_info":
                    return Commands.WindowOps.Info(api.Get(), input, warnings);

                case "move_window":
                    return Commands.WindowOps.Move(api.Get(), input, warnings);

                case "capture_window":
                    return Commands.WindowOps.CaptureTo(api.Get(), input, warnings);

                case "close_window":
                    return Commands.WindowOps.Close(api.Get(), input, warnings);

                case "launch":
                    return Commands.LaunchCmd.Run(api.Get(), input, warnings);

                default:
                    throw new VdmException("unknown_command", $"未知命令 {command}。已知命令见 capabilities。");
            }
        }

        private static object Capabilities(AnonymousDesktop api, List<string> warnings)
        {
            var osv = Environment.OSVersion;
            var caps = new Dictionary<string, object>
            {
                { "hostVersion", HostVersion },
                { "clr", Environment.Version.ToString() },
                { "osVersion", osv.Version.ToString() },
                { "osBuild", osv.Version.Build },
                { "osDescription", osv.VersionString },
                { "is64BitProcess", Environment.Is64BitProcess },
                { "sessionId", Process.GetCurrentProcess().SessionId },
                { "integrity", Support.Integrity.Describe() },
                { "isInteractiveSession", Environment.UserInteractive },
                { "buildSupported", IsBuildSupported(osv.Version.Build) },
                { "commands", new[]
                    {
                        "ping", "capabilities", "list_desktops", "get_current_desktop", "create_desktop",
                        "switch_desktop", "remove_desktop", "list_windows", "window_info",
                        "move_window", "capture_window", "close_window", "launch",
                    } },
            };

            if (!IsBuildSupported(osv.Version.Build))
            {
                warnings.Add($"当前构建 {osv.Version.Build} 未被验证。内置 COM vtable 针对 24H2/25H2（26100/26200）标定，"
                    + "枚举/创建/切换桌面很可能返回 E_NOINTERFACE 或行为错乱；请以 list_desktops 的实测结果为准。");
            }

            try
            {
                var d = api.Get();
                var list = d.Desktops(true);
                caps["desktopApiAvailable"] = true;
                caps["desktopCount"] = list.Count;
            }
            catch (Exception ex)
            {
                caps["desktopApiAvailable"] = false;
                caps["desktopApiError"] = ex is VdmUnavailableException ? ex.Message : ex.Message;
                warnings.Add("虚拟桌面 COM 接口不可用，仅公开 API 的命令仍然可用（但本版本未提供降级路径）。");
            }

            return caps;
        }

        private static bool IsBuildSupported(int build) => build >= 26100;

        // ---------- IO ----------

        private static Dictionary<string, object> ReadInput()
        {
            string raw;
            using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
            {
                raw = reader.ReadToEnd();
            }
            if (string.IsNullOrWhiteSpace(raw)) return new Dictionary<string, object>();
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
            var obj = serializer.DeserializeObject(raw) as Dictionary<string, object>;
            if (obj == null) throw new VdmException("bad_input_json", "stdin 必须是 JSON 对象");
            return obj;
        }

        private static void WriteOk(object data, List<string> warnings, Stopwatch sw)
        {
            var payload = new Dictionary<string, object>
            {
                { "ok", true },
                { "data", data },
                { "warnings", warnings.ToArray() },
                { "elapsedMs", sw.ElapsedMilliseconds },
            };
            Emit(payload);
        }

        private static void WriteError(string code, string message, int? hresult, Stopwatch sw, List<string> warnings = null)
        {
            var err = new Dictionary<string, object>
            {
                { "code", code },
                { "message", message },
            };
            if (hresult.HasValue) err["hresult"] = "0x" + unchecked((uint)hresult.Value).ToString("X8");

            var payload = new Dictionary<string, object>
            {
                { "ok", false },
                { "error", err },
                { "warnings", warnings == null ? new object[0] : warnings.ToArray() },
                { "elapsedMs", sw.ElapsedMilliseconds },
            };
            Emit(payload);
        }

        private static void Emit(Dictionary<string, object> payload)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
            Console.Out.Write(serializer.Serialize(payload));
            Console.Out.Flush();
        }

        internal static void Log(string message)
        {
            try { Console.Error.WriteLine("[vdmhost] " + message); } catch { }
        }

        // ---------- 参数读取（Node 层已校验一次，这里只做类型兜底） ----------

        internal static string OptString(IDictionary<string, object> input, string key, string fallback = null)
        {
            object v;
            if (!input.TryGetValue(key, out v) || v == null) return fallback;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        internal static bool OptBool(IDictionary<string, object> input, string key, bool fallback = false)
        {
            object v;
            if (!input.TryGetValue(key, out v) || v == null) return fallback;
            if (v is bool b) return b;
            string s = Convert.ToString(v, CultureInfo.InvariantCulture);
            return s == "1" || string.Equals(s, "true", StringComparison.OrdinalIgnoreCase);
        }

        internal static int OptInt(IDictionary<string, object> input, string key, int fallback)
        {
            object v;
            if (!input.TryGetValue(key, out v) || v == null) return fallback;
            if (v is int i) return i;
            if (v is long l) return (int)l;
            if (v is double d) return (int)d;
            int parsed;
            return int.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out parsed) ? parsed : fallback;
        }

        /// <summary>接受十进制、"0x" 前缀十六进制，或纯十六进制字符串。</summary>
        internal static long RequiredHwnd(IDictionary<string, object> input, string key = "hwnd")
        {
            object v;
            if (!input.TryGetValue(key, out v) || v == null)
                throw new VdmException("invalid_argument", $"{key} 必填");
            string s = Convert.ToString(v, CultureInfo.InvariantCulture).Trim();
            long value;
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                if (!long.TryParse(s.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out value))
                    throw new VdmException("invalid_argument", $"{key} 不是合法的十六进制句柄：{s}");
            }
            else if (!long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
            {
                throw new VdmException("invalid_argument", $"{key} 不是合法句柄：{s}");
            }
            if (value <= 0) throw new VdmException("invalid_argument", $"{key} 必须为正整数");
            return value;
        }

        internal static Guid RequiredGuid(IDictionary<string, object> input, string key = "desktopId")
        {
            string s = OptString(input, key);
            if (string.IsNullOrWhiteSpace(s)) throw new VdmException("invalid_argument", $"{key} 必填（虚拟桌面 GUID）");
            Guid g;
            if (!Guid.TryParse(s, out g))
                throw new VdmException("invalid_argument", $"{key} 不是合法 GUID：{s}。虚拟桌面必须用 GUID 标识，不要用序号。");
            return g;
        }
    }
}
