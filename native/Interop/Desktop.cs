// Windows 虚拟桌面 COM 互操作。
//
// 公开部分（IVirtualDesktopManager）是微软文档化的，只够查询/移动窗口；
// 枚举、创建、切换、删除桌面必须走 ImmersiveShell 的内部服务
// IVirtualDesktopManagerInternal —— 这些接口的 IID 每代 Windows 都会变。
//
// 下面的 IID 与 vtable 顺序对应 Windows 11 24H2/25H2（build 26100 / 26200），
// 参考 MScholtes/VirtualDesktop（MIT, Copyright (c) 2017 Markus Scholtes）
// 的 VirtualDesktop11-24H2.cs，并已在本机 26200 上实测通过。
// 换到别的 build 上这些 IID 很可能失效，DesktopApi 会先做一次能力探测再报错。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace VdmHost.Interop
{
    internal static class VdGuids
    {
        public static readonly Guid CLSID_ImmersiveShell = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239");
        public static readonly Guid CLSID_VirtualDesktopManagerInternal = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
        public static readonly Guid CLSID_VirtualDesktopManager = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");
        public static readonly Guid IID_IVirtualDesktopManagerInternal = new Guid("53F5CA0B-158F-4124-900C-057158060B27");
        public static readonly Guid IID_IVirtualDesktop = new Guid("3F07F4BE-B107-441A-AF0F-39D82529072C");
        public static readonly Guid IID_IApplicationViewCollection = new Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5");
        public static readonly Guid IID_IApplicationView = new Guid("372E1D3B-38D3-42E4-A15B-8AB2B178F513");
        public static readonly Guid IID_IObjectArray = new Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9");
        public static readonly Guid IID_IVirtualDesktopManager = new Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B");
        public static readonly Guid IID_IServiceProvider = new Guid("6D5140C1-7436-11CE-8034-00AA006009FA");
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    [Guid("372E1D3B-38D3-42E4-A15B-8AB2B178F513")]
    internal interface IApplicationView
    {
        int SetFocus();
        int SwitchTo();
        int TryInvokeBack(IntPtr callback);
        int GetThumbnailWindow(out IntPtr hwnd);
        int GetMonitor(out IntPtr immersiveMonitor);
        int GetVisibility(out int visibility);
        int SetCloak(int cloakType, int unknown);
        int GetPosition(ref Guid guid, out IntPtr position);
        int SetPosition(ref IntPtr position);
        int InsertAfterWindow(IntPtr hwnd);
        int GetExtendedFramePosition(out Rect rect);
        int GetAppUserModelId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int SetAppUserModelId(string id);
        int IsEqualByAppUserModelId(string id, out int result);
        int GetViewState(out uint state);
        int SetViewState(uint state);
        int GetNeediness(out int neediness);
        int GetLastActivationTimestamp(out ulong timestamp);
        int SetLastActivationTimestamp(ulong timestamp);
        int GetVirtualDesktopId(out Guid guid);
        int SetVirtualDesktopId(ref Guid guid);
        int GetShowInSwitchers(out int flag);
        int SetShowInSwitchers(int flag);
        int GetScaleFactor(out int factor);
        int CanReceiveInput(out bool canReceiveInput);
        int GetCompatibilityPolicyType(out int flags);
        int SetCompatibilityPolicyType(int flags);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5")]
    internal interface IApplicationViewCollection
    {
        int GetViews(out IObjectArray array);
        int GetViewsByZOrder(out IObjectArray array);
        int GetViewsByAppUserModelId(string id, out IObjectArray array);
        int GetViewForHwnd(IntPtr hwnd, out IApplicationView view);
        int GetViewForApplication(object application, out IApplicationView view);
        int GetViewForAppUserModelId(string id, out IApplicationView view);
        int GetViewInFocus(out IntPtr view);
        int Unknown1(out IntPtr view);
        void RefreshCollection();
        int RegisterForApplicationViewChanges(object listener, out int cookie);
        int UnregisterForApplicationViewChanges(int cookie);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("3F07F4BE-B107-441A-AF0F-39D82529072C")]
    internal interface IVirtualDesktop
    {
        bool IsViewVisible(IApplicationView view);
        Guid GetId();
        [return: MarshalAs(UnmanagedType.HString)]
        string GetName();
        [return: MarshalAs(UnmanagedType.HString)]
        string GetWallpaperPath();
        bool IsRemote();
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("53F5CA0B-158F-4124-900C-057158060B27")]
    internal interface IVirtualDesktopManagerInternal
    {
        int GetCount();
        void MoveViewToDesktop(IApplicationView view, IVirtualDesktop desktop);
        bool CanViewMoveDesktops(IApplicationView view);
        IVirtualDesktop GetCurrentDesktop();
        void GetDesktops(out IObjectArray desktops);
        [PreserveSig]
        int GetAdjacentDesktop(IVirtualDesktop from, int direction, out IVirtualDesktop desktop);
        void SwitchDesktop(IVirtualDesktop desktop);
        void SwitchDesktopAndMoveForegroundView(IVirtualDesktop desktop);
        IVirtualDesktop CreateDesktop();
        void MoveDesktop(IVirtualDesktop desktop, int nIndex);
        void RemoveDesktop(IVirtualDesktop desktop, IVirtualDesktop fallback);
        IVirtualDesktop FindDesktop(ref Guid desktopid);
        void GetDesktopSwitchIncludeExcludeViews(IVirtualDesktop desktop, out IObjectArray unknown1, out IObjectArray unknown2);
        void SetDesktopName(IVirtualDesktop desktop, [MarshalAs(UnmanagedType.HString)] string name);
        void SetDesktopWallpaper(IVirtualDesktop desktop, [MarshalAs(UnmanagedType.HString)] string path);
        void UpdateWallpaperPathForAllDesktops([MarshalAs(UnmanagedType.HString)] string path);
        void CopyDesktopState(IApplicationView pView0, IApplicationView pView1);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    internal interface IVirtualDesktopManagerPublic
    {
        bool IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow);
        Guid GetWindowDesktopId(IntPtr topLevelWindow);
        void MoveWindowToDesktop(IntPtr topLevelWindow, ref Guid desktopId);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9")]
    internal interface IObjectArray
    {
        void GetCount(out int count);
        void GetAt(int index, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object obj);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
    internal interface IServiceProvider10
    {
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object QueryService(ref Guid service, ref Guid riid);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    internal sealed class DesktopRecord
    {
        public Guid Id;
        public string Name;
        public int Index;
        public bool IsCurrent;
        public IVirtualDesktop Com;
    }

    /// <summary>
    /// 一次进程生命周期内可复用的虚拟桌面访问器。构造失败会抛 <see cref="VdmUnavailableException"/>，
    /// 由调用方转成结构化错误，绝不静默降级。
    /// </summary>
    internal sealed class DesktopApi : IDisposable
    {
        private readonly IServiceProvider10 _shell;
        private readonly IVirtualDesktopManagerInternal _internal;
        private readonly IApplicationViewCollection _views;
        private readonly IVirtualDesktopManagerPublic _public;
        private List<DesktopRecord> _cache;

        public DesktopApi()
        {
            try
            {
                _shell = (IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(VdGuids.CLSID_ImmersiveShell));
            }
            catch (Exception ex)
            {
                throw Explain(ex, "创建 ImmersiveShell 失败");
            }

            Guid service = VdGuids.CLSID_VirtualDesktopManagerInternal;
            Guid iid = VdGuids.IID_IVirtualDesktopManagerInternal;
            try
            {
                _internal = (IVirtualDesktopManagerInternal)_shell.QueryService(ref service, ref iid);
            }
            catch (Exception ex)
            {
                throw Explain(ex, "查询 IVirtualDesktopManagerInternal 失败");
            }

            Guid viewSid = VdGuids.IID_IApplicationViewCollection;
            Guid viewIid = VdGuids.IID_IApplicationViewCollection;
            try
            {
                _views = (IApplicationViewCollection)_shell.QueryService(ref viewSid, ref viewIid);
            }
            catch
            {
                _views = null; // 窗口移动会退回公开接口
            }

            try
            {
                _public = (IVirtualDesktopManagerPublic)Activator.CreateInstance(Type.GetTypeFromCLSID(VdGuids.CLSID_VirtualDesktopManager));
            }
            catch
            {
                _public = null;
            }
        }

        private static VdmUnavailableException Explain(Exception ex, string what)
        {
            int hr = ex is COMException ce ? ce.ErrorCode : ex.HResult;
            string hint;
            switch (unchecked((uint)hr))
            {
                case 0x80070005:
                    hint = "调用进程不是 Medium 完整性级别（典型原因：被 DSH 沙箱降权，或进程以管理员身份提权）。"
                         + "虚拟桌面内部 COM 服务只接受同会话的 Medium 完整性调用。";
                    break;
                case 0x80040154:
                    hint = "ImmersiveShell 服务未注册，可能不是交互式会话，或系统版本过旧。";
                    break;
                default:
                    hint = "当前 Windows 构建可能与内置的 24H2/25H2 接口定义不匹配。";
                    break;
            }
            return new VdmUnavailableException($"{what}：0x{hr:X8}。{hint}", hr);
        }

        public void FlushCache() => _cache = null;

        public List<DesktopRecord> Desktops(bool refresh = false)
        {
            if (!refresh && _cache != null) return _cache;
            _internal.GetDesktops(out IObjectArray array);
            array.GetCount(out int count);
            Guid current = CurrentId();
            var list = new List<DesktopRecord>(count);
            for (int i = 0; i < count; i++)
            {
                Guid iid = VdGuids.IID_IVirtualDesktop;
                array.GetAt(i, ref iid, out object obj);
                var desktop = (IVirtualDesktop)obj;
                Guid id = desktop.GetId();
                list.Add(new DesktopRecord
                {
                    Id = id,
                    Name = SafeName(desktop),
                    Index = i,
                    IsCurrent = id == current,
                    Com = desktop,
                });
            }
            _cache = list;
            return list;
        }

        private static string SafeName(IVirtualDesktop desktop)
        {
            try { return desktop.GetName(); }
            catch { return null; }
        }

        public Guid CurrentId() => _internal.GetCurrentDesktop().GetId();

        public DesktopRecord Find(Guid id, bool refresh = true)
        {
            foreach (var d in Desktops(refresh)) if (d.Id == id) return d;
            return null;
        }

        public DesktopRecord Create(string name)
        {
            IVirtualDesktop created = _internal.CreateDesktop();
            Guid id = created.GetId();
            if (!string.IsNullOrEmpty(name))
            {
                try { _internal.SetDesktopName(created, name); }
                catch { /* 改名是锦上添花，部分构建不支持 */ }
            }
            FlushCache();
            return Find(id) ?? new DesktopRecord { Id = id, Com = created, Name = name };
        }

        public void Switch(Guid id)
        {
            var target = Find(id) ?? throw new VdmException("desktop_not_found", $"虚拟桌面 {id} 不存在");
            _internal.SwitchDesktop(target.Com);
            FlushCache();
        }

        public void Remove(Guid id, Guid? fallback)
        {
            var target = Find(id) ?? throw new VdmException("desktop_not_found", $"虚拟桌面 {id} 不存在");
            DesktopRecord fb = null;
            if (fallback.HasValue) fb = Find(fallback.Value);
            if (fb == null)
            {
                foreach (var d in Desktops()) { if (d.Id != id) { fb = d; break; } }
            }
            if (fb == null) throw new VdmException("last_desktop", "不能删除唯一的虚拟桌面");
            _internal.RemoveDesktop(target.Com, fb.Com);
            FlushCache();
        }

        public Guid? WindowDesktop(IntPtr hwnd)
        {
            if (_public == null) return null;
            try { return _public.GetWindowDesktopId(hwnd); }
            catch { return null; }
        }

        public bool IsOnCurrentDesktop(IntPtr hwnd)
        {
            if (_public == null) return false;
            try { return _public.IsWindowOnCurrentVirtualDesktop(hwnd); }
            catch { return false; }
        }

        /// <summary>
        /// 移动窗口到指定桌面。先走文档化接口，失败再走内部 MoveViewToDesktop。
        /// 返回实际使用的通道，便于日志定位。
        /// </summary>
        public string MoveWindow(IntPtr hwnd, Guid desktopId, out string detail)
        {
            if (Find(desktopId) == null) throw new VdmException("desktop_not_found", $"虚拟桌面 {desktopId} 不存在");

            var errors = new List<string>();

            if (_public != null)
            {
                try
                {
                    Guid id = desktopId;
                    _public.MoveWindowToDesktop(hwnd, ref id);
                    Guid? now = WindowDesktop(hwnd);
                    if (now.HasValue && now.Value == desktopId)
                    {
                        detail = "documented IVirtualDesktopManager.MoveWindowToDesktop";
                        return "public";
                    }
                    errors.Add($"public API 返回成功但窗口仍属于 {now?.ToString() ?? "未知桌面"}");
                }
                catch (Exception ex)
                {
                    errors.Add("public: " + DescribeError(ex));
                }
            }
            else errors.Add("public: 接口不可用");

            if (_views == null)
            {
                detail = string.Join("; ", errors);
                throw new VdmException("move_failed", "内部窗口集合不可用，无法回退。" + detail);
            }

            var desktop = Find(desktopId);
            IApplicationView view = null;
            int hr = _views.GetViewForHwnd(hwnd, out view);
            if (hr != 0 || view == null)
            {
                // 隐藏/未激活窗口可能还没进 shell 的视图集合，这是已知的上游行为。
                errors.Add($"GetViewForHwnd hresult=0x{hr:X8}");
            }
            if (view == null)
            {
                detail = string.Join("; ", errors);
                throw new VdmException("move_failed", "窗口不在 shell 视图集合中，无法移动。" + detail);
            }

            try
            {
                _internal.MoveViewToDesktop(view, desktop.Com);
            }
            catch (Exception ex)
            {
                errors.Add("internal: " + DescribeError(ex));
                detail = string.Join("; ", errors);
                throw new VdmException("move_failed", "两种移动通道都失败。" + detail);
            }

            Guid? after = WindowDesktop(hwnd);
            if (after.HasValue && after.Value != desktopId)
            {
                detail = "internal MoveViewToDesktop 调用成功但窗口仍属于 " + after.Value;
                throw new VdmException("move_unconfirmed", detail);
            }
            detail = "internal IVirtualDesktopManagerInternal.MoveViewToDesktop";
            return "internal";
        }

        public Guid? FindDesktopByName(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            foreach (var d in Desktops(true))
                if (!string.IsNullOrEmpty(d.Name) && string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase))
                    return d.Id;
            return null;
        }

        private static string DescribeError(Exception ex)
        {
            if (ex is COMException ce) return $"0x{ce.ErrorCode:X8} {ce.Message}".Trim();
            return ex.Message;
        }

        public void Dispose()
        {
            if (_internal is ICustomQueryInterface) { }
            foreach (var item in new object[] { _internal, _views, _public, _shell })
            {
                if (item != null && Marshal.IsComObject(item))
                {
                    try { Marshal.ReleaseComObject(item); } catch { }
                }
            }
        }

        private interface ICustomQueryInterface { }
    }

    internal sealed class VdmException : Exception
    {
        public string Code { get; }
        public VdmException(string code, string message) : base(message) { Code = code; }
    }

    internal sealed class VdmUnavailableException : Exception
    {
        public int HResultCode { get; }
        public VdmUnavailableException(string message, int hr) : base(message) { HResultCode = hr; }
    }
}
