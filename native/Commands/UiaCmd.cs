using System;
using System.Collections.Generic;
using VdmHost.Interop;
using VdmHost.Support;

namespace VdmHost.Commands
{
    /// <summary>
    /// UI Automation 命令。刻意只做两件事：读控件树、按控件调 pattern。
    /// 不做的事情同样重要：不发 SendInput、不按屏幕坐标点击、不要求窗口在前台 ——
    /// 否则"在别的虚拟桌面里测试 GUI"就变成了"抢占用户的键鼠"。
    /// </summary>
    internal static class UiaCmd
    {
        public static object Tree(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            long raw = Program.RequiredHwnd(input);
            IntPtr hwnd = new IntPtr(raw);
            EnsureUsable(hwnd);

            int maxDepth = Program.OptInt(input, "maxDepth", 3);
            int maxNodes = Program.OptInt(input, "maxNodes", 150);
            string nameContains = Program.OptString(input, "nameContains");

            if (maxDepth < 0) maxDepth = 0;
            if (maxDepth > 12) { maxDepth = 12; warnings.Add("maxDepth 上限被压到 12，再深基本只有噪声。"); }
            if (maxNodes <= 0) maxNodes = 150;
            if (maxNodes > 800) { maxNodes = 800; warnings.Add("maxNodes 上限被压到 800，再大会让单次调用变慢很多。"); }

            var data = Uia.Tree(hwnd, maxDepth, maxNodes, nameContains);

            WindowInfo w = Windows.Describe(hwnd);
            if (w != null)
            {
                data["processName"] = w.ProcessName;
                data["title"] = w.Title;
                if (w.Minimized)
                    warnings.Add("目标窗口当前是最小化状态。UIA 一般仍能读到控件树，但某些程序最小化后会丢弃子控件。");
            }

            // 桌面归属要单独问：Windows.Describe 只填窗口自身信息，不查虚拟桌面，
            // 否则 OnCurrentDesktop 会是 null，调用方看不出这个窗口在不在用户的桌面上。
            bool onCurrent = true;
            try
            {
                if (api != null)
                {
                    onCurrent = api.IsOnCurrentDesktop(hwnd);
                    Guid? desktopId = api.WindowDesktop(hwnd);
                    if (desktopId.HasValue && desktopId.Value != Guid.Empty)
                        data["virtualDesktopId"] = desktopId.Value.ToString();
                    data["onCurrentDesktop"] = onCurrent;
                }
            }
            catch (Exception ex)
            {
                warnings.Add("查询窗口所属虚拟桌面失败：" + ex.Message + "（不影响 UIA 结果）。");
            }

            if (!onCurrent)
            {
                data["note"] = "这个窗口在别的虚拟桌面（或已 cloaked）。UIA 读取通常仍然有效，且不需要切换桌面；"
                             + "但如果控件树明显只有外壳，可能是程序在非当前桌面时收起了内容。";
            }

            return data;
        }

        public static object Act(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            long raw = Program.RequiredHwnd(input);
            IntPtr hwnd = new IntPtr(raw);
            EnsureUsable(hwnd);

            string path = Program.OptString(input, "path");
            string action = Program.OptString(input, "action");
            string value = Program.OptString(input, "value");

            if (string.IsNullOrWhiteSpace(action))
                throw new VdmException("invalid_argument",
                    "action 必填：invoke / setvalue / toggle / expand / collapse / select / focus / scroll");

            var data = Uia.Act(hwnd, path ?? string.Empty, action, value);

            if (data.TryGetValue("succeeded", out object okObj) && okObj is bool ok && !ok)
            {
                // 控件存在但不支持该操作 —— 这不是异常，是"此路不通"，必须让调用方看到可用的替代 pattern。
                warnings.Add("控件不支持请求的 " + action + "；请看 supportedPatterns 换一种操作，或改用截图 + 人工确认。");
            }
            else
            {
                warnings.Add("UIA 操作是异步生效的。如果后续要读取结果，请隔一两百毫秒再查，不要立刻断言界面没变。");
            }
            return data;
        }

        /// <summary>
        /// 挂起 / 不可见的窗口在 UIA 上是同步跨进程调用，会连带把 vdmhost 卡住，
        /// 所以宁可明确拒绝，也不要让工具调用一直挂到超时。
        /// </summary>
        private static void EnsureUsable(IntPtr hwnd)
        {
            if (!Win32.IsWindow(hwnd))
                throw new VdmException("invalid_hwnd", "窗口 0x" + hwnd.ToInt64().ToString("X") + " 不存在（可能已关闭）。");
            if (Win32.IsHungAppWindow(hwnd))
                throw new VdmException("target_not_responding",
                    "目标窗口没有响应（IsHungAppWindow 为真）。此时 UIA 的同步调用也会跟着卡住，已拒绝。"
                    + "请先确认程序是否卡死，不要反复重试。");
        }
    }
}
