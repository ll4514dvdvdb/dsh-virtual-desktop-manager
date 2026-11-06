// 窗口级截图：PrintWindow + PW_RENDERFULLCONTENT，并对"抓到一张空白图"做显式判定。
//
// 为什么不用 BitBlt 抓屏幕：BitBlt 只能抓到当前可见桌面，一旦目标窗口在别的虚拟桌面，
// 抓到的就是用户自己的桌面 —— 既不准确，也有隐私问题。PrintWindow 是窗口级 API，
// 由目标窗口自己响应 WM_PRINT，不会把用户桌面内容拍进去。
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using VdmHost.Interop;

namespace VdmHost.Support
{
    internal sealed class CaptureResult
    {
        public int Width;
        public int Height;
        public byte[] Png;
        public uint FlagsUsed;
        public bool PrintWindowOk;
        public double DominantShare;
        public int SampledDistinct;
        public string DominantColor;
        public List<string> Warnings = new List<string>();
        public List<string> Hints = new List<string>();
        public bool SuspectedBlank => !PrintWindowOk || SampledDistinct <= 1 || DominantShare > 0.999;
    }

    internal static class Capture
    {
        private const int MaxDimension = 20000;

        public static CaptureResult CaptureWindow(IntPtr hwnd, bool clientOnly, bool allowRestore)
        {
            if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd))
                throw new VdmException("invalid_hwnd", "窗口句柄无效或窗口已销毁");

            var result = new CaptureResult();

            if (Win32.IsIconic(hwnd))
            {
                if (!allowRestore)
                    throw new VdmException("target_minimized",
                        "目标窗口已最小化，PrintWindow 无法可靠抓取。请传 allowRestore=true 让助手先以不激活的方式恢复窗口，"
                        + "或先由用户/AI 将其还原。");
                // SW_SHOWNOACTIVATE：恢复尺寸但不激活，不会把焦点从用户当前程序抢走。
                Win32.ShowWindow(hwnd, Win32.SW_SHOWNOACTIVATE);
                System.Threading.Thread.Sleep(120);
                result.Warnings.Add("目标窗口此前处于最小化状态，已用 SW_SHOWNOACTIVATE 恢复（不激活）。");
            }

            RECT rect;
            if (!Win32.GetWindowRect(hwnd, out rect))
                throw new VdmException("get_rect_failed", "GetWindowRect 失败，无法确定窗口尺寸。");

            int w = rect.Width;
            int h = rect.Height;
            if (w <= 0 || h <= 0)
                throw new VdmException("invalid_rect", $"窗口尺寸无效（{w}x{h}），窗口可能刚创建或正在销毁。");
            if (w > MaxDimension || h > MaxDimension)
                throw new VdmException("rect_too_large", $"窗口尺寸异常（{w}x{h}），拒绝截图。");

            uint flags = clientOnly ? Win32.PW_CLIENTONLY : Win32.PW_RENDERFULLCONTENT;

            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    try
                    {
                        result.PrintWindowOk = Win32.PrintWindow(hwnd, hdc, flags);
                    }
                    finally
                    {
                        g.ReleaseHdc(hdc);
                    }
                }

                result.FlagsUsed = flags;
                result.Width = w;
                result.Height = h;

                if (!result.PrintWindowOk)
                {
                    int err = Marshal.GetLastWin32Error();
                    result.Warnings.Add($"PrintWindow 返回失败（Win32 错误 {err}）。");
                    result.Hints.Add("窗口可能已销毁、属于其他会话，或该程序拒绝响应 WM_PRINT。");
                }

                Analyze(bmp, result);

                if (result.SuspectedBlank)
                {
                    result.Hints.Add("疑似空白/黑屏截图：该窗口通常由 GPU 直出（DirectComposition / DirectX / 硬件加速的 Electron、"
                        + "浏览器、游戏），PrintWindow 拿不到画面。这不是'软件正常'的证据，请改用 UI Automation 校验控件树，"
                        + "或提请用户授权后切到目标桌面做屏幕级截图。");
                    result.Hints.Add("可尝试 clientOnly=true（抓客户区），个别程序只实现客户区打印。");
                }

                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    result.Png = ms.ToArray();
                }
            }

            return result;
        }

        /// <summary>
        /// 采样像素判断是否"整张图一个颜色"。用 LockBits 直接扫内存，避免 GetPixel 的 GDI+ 开销。
        /// </summary>
        private static void Analyze(Bitmap bmp, CaptureResult result)
        {
            BitmapData data = null;
            try
            {
                Rectangle area = new Rectangle(0, 0, bmp.Width, bmp.Height);
                data = bmp.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                int stride = data.Stride;
                int stepX = Math.Max(1, bmp.Width / 64);
                int stepY = Math.Max(1, bmp.Height / 64);

                var counts = new Dictionary<int, int>();
                int total = 0;
                int rowBytes = bmp.Width * 4;
                byte[] buffer = new byte[rowBytes];
                for (int y = 0; y < bmp.Height; y += stepY)
                {
                    IntPtr src = IntPtr.Add(data.Scan0, y * stride);
                    Marshal.Copy(src, buffer, 0, rowBytes);
                    for (int x = 0; x < bmp.Width; x += stepX)
                    {
                        int o = x * 4;
                        int key = (buffer[o + 3] << 24) | (buffer[o + 2] << 16) | (buffer[o + 1] << 8) | buffer[o];
                        int c;
                        counts.TryGetValue(key, out c);
                        counts[key] = c + 1;
                        total++;
                    }
                }

                int bestKey = 0, bestCount = 0;
                foreach (var kv in counts)
                {
                    if (kv.Value > bestCount) { bestCount = kv.Value; bestKey = kv.Key; }
                }
                result.SampledDistinct = counts.Count;
                result.DominantShare = total == 0 ? 1.0 : (double)bestCount / total;
                int a = (bestKey >> 24) & 0xFF, r = (bestKey >> 16) & 0xFF, g = (bestKey >> 8) & 0xFF, b = bestKey & 0xFF;
                result.DominantColor = $"#{r:X2}{g:X2}{b:X2}";
                if (a != 255 && a != 0) result.DominantColor += $"（alpha={a}）";
            }
            finally
            {
                if (data != null) bmp.UnlockBits(data);
            }
        }
    }
}
