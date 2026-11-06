// 进程完整性级别。这不是为了炫技：ImmersiveShell 的内部 COM 服务只接受 Medium 完整性调用，
// 被降权到 Low（DSH 沙箱里的 pwsh 就是这样）会直接 E_ACCESSDENIED，
// 而提权到 High（以管理员运行）同样失败。所以把真实级别报出来，能让排障一眼定位。
using System;
using System.Runtime.InteropServices;

namespace VdmHost.Support
{
    internal static class Integrity
    {
        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenIntegrityLevel = 25;

        [StructLayout(LayoutKind.Sequential)]
        private struct SID_AND_ATTRIBUTES
        {
            public IntPtr Sid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_MANDATORY_LABEL
        {
            public SID_AND_ATTRIBUTES Label;
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returnLength);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthority(IntPtr sid, int index);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LocalFree(IntPtr hMem);

        public static int RawLevel()
        {
            IntPtr token = IntPtr.Zero;
            IntPtr info = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) return -1;
                int size;
                GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out size);
                if (size <= 0) return -1;
                info = Marshal.AllocHGlobal(size);
                if (!GetTokenInformation(token, TokenIntegrityLevel, info, size, out size)) return -1;
                var label = (TOKEN_MANDATORY_LABEL)Marshal.PtrToStructure(info, typeof(TOKEN_MANDATORY_LABEL));
                IntPtr countPtr = GetSidSubAuthorityCount(label.Label.Sid);
                int count = Marshal.ReadByte(countPtr);
                IntPtr subPtr = GetSidSubAuthority(label.Label.Sid, count - 1);
                return Marshal.ReadInt32(subPtr);
            }
            catch
            {
                return -1;
            }
            finally
            {
                if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);
                if (token != IntPtr.Zero) CloseHandleSafe(token);
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private static void CloseHandleSafe(IntPtr h) { try { CloseHandle(h); } catch { } }

        public static string Describe()
        {
            int rid = RawLevel();
            string name;
            switch (rid)
            {
                case 0x0000: name = "Untrusted"; break;
                case 0x1000: name = "Low"; break;
                case 0x2000: name = "Medium"; break;
                case 0x2100: name = "Medium Plus"; break;
                case 0x3000: name = "High"; break;
                case 0x4000: name = "System"; break;
                case 0x5000: name = "Protected"; break;
                default: name = "Unknown"; break;
            }
            if (rid < 0) return "Unknown";
            string hint = rid == 0x2000 || rid == 0x2100
                ? "（可以调用虚拟桌面内部 COM）"
                : "（虚拟桌面内部 COM 预期会失败：只有 Medium 完整性可调用）";
            return $"{name} (0x{rid:X4}){hint}";
        }
    }
}
