using System;
using System.Collections.Generic;
using VdmHost.Interop;
using VdmHost.Support;

namespace VdmHost.Commands
{
    internal static class Desktops
    {
        public static object List(DesktopApi api, List<string> warnings)
        {
            List<DesktopRecord> desktops = api.Desktops(true);
            Guid current = Guid.Empty;
            foreach (var d in desktops) { if (d.IsCurrent) { current = d.Id; break; } }
            if (current == Guid.Empty) current = api.CurrentId();

            // 每个桌面上有多少窗口 —— 比单纯列 GUID 有用得多，也让"这个桌面是不是空的"可判断。
            var counts = new Dictionary<Guid, int>();
            var windowList = Windows.Enumerate(api, false, true);
            foreach (var w in windowList)
            {
                if (!w.DesktopId.HasValue) continue;
                int c;
                counts.TryGetValue(w.DesktopId.Value, out c);
                counts[w.DesktopId.Value] = c + 1;
            }

            var items = new List<object>(desktops.Count);
            foreach (var d in desktops)
            {
                int c;
                counts.TryGetValue(d.Id, out c);
                items.Add(new Dictionary<string, object>
                {
                    { "id", d.Id.ToString() },
                    { "name", string.IsNullOrEmpty(d.Name) ? "(未命名)" : d.Name },
                    { "rawName", d.Name },
                    { "index", d.Index },
                    { "isCurrent", d.Id == current },
                    { "windowCount", c },
                });
            }

            return new Dictionary<string, object>
            {
                { "currentDesktopId", current.ToString() },
                { "desktopCount", desktops.Count },
                { "desktops", items },
                { "note", "id 是虚拟桌面 GUID，是唯一稳定标识；index 只是显示顺序，会随增删变化，不要持久化它。" },
            };
        }

        public static object Current(DesktopApi api, List<string> warnings)
        {
            Guid current = api.CurrentId();
            var all = api.Desktops(true);
            string name = null;
            int index = -1;
            foreach (var d in all)
            {
                if (d.Id != current) continue;
                name = d.Name;
                index = d.Index;
                break;
            }
            return new Dictionary<string, object>
            {
                // id 与 list_desktops 里每个桌面的 id 同名同义，方便调用方直接把两者对上。
                { "id", current.ToString() },
                { "desktopId", current.ToString() },
                { "name", string.IsNullOrEmpty(name) ? "(未命名)" : name },
                { "index", index },
                { "desktopCount", all.Count },
            };
        }

        public static object Create(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            string name = Program.OptString(input, "name");
            bool reuse = Program.OptBool(input, "reuseExistingName", true);

            if (reuse && !string.IsNullOrWhiteSpace(name))
            {
                Guid existing = api.FindDesktopByName(name).GetValueOrDefault();
                if (existing != Guid.Empty)
                {
                    var record = api.Find(existing);
                    return new Dictionary<string, object>
                    {
                        { "created", false },
                        { "reused", true },
                        // 顶层也给一份 GUID：调用方不必为了拿 id 而钻 desktop.id 一层。
                        { "desktopId", existing.ToString() },
                        { "desktop", new Dictionary<string, object>
                            {
                                { "id", existing.ToString() },
                                { "name", name },
                                { "index", record?.Index ?? -1 },
                            } },
                    };
                }
            }

            Guid before = api.CurrentId();
            DesktopRecord created = api.Create(name);
            Guid after = api.CurrentId();

            // CreateDesktop 理论上不切换桌面。如果这里真的变了，说明我们干了干扰用户的事，
            // 必须大声报出来（并在 Node 层记审计日志），绝不能当成正常。
            bool switched = before != after;
            if (switched)
            {
                warnings.Add($"创建桌面后当前桌面从 {before} 变成了 {after}。这不预期，可能干扰了用户；"
                    + "内部 CreateDesktop 在部分构建上会连带切换，请评估是否改用用户预建的桌面。");
            }

            return new Dictionary<string, object>
            {
                { "created", true },
                { "reused", false },
                { "desktopId", created.Id.ToString() },
                { "desktop", new Dictionary<string, object>
                    {
                        { "id", created.Id.ToString() },
                        { "name", string.IsNullOrEmpty(name) ? "(未命名)" : name },
                        { "index", created.Index },
                    } },
                { "currentDesktopChanged", switched },
                { "currentDesktopId", after.ToString() },
            };
        }

        public static object Switch(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            if (!Program.OptBool(input, "authorized", false))
            {
                throw new VdmException("not_authorized",
                    "切换虚拟桌面会把用户的屏幕整个换掉，必须由用户在当次对话中明确授权。"
                    + "确认授权后再以 authorized=true 重试；Game Mode 开启时任何情况下都不允许切换。");
            }

            Guid target = Program.RequiredGuid(input);
            Guid before = api.CurrentId();
            if (before == target)
            {
                return new Dictionary<string, object>
                {
                    { "switched", false },
                    { "reason", "already_current" },
                    { "desktopId", target.ToString() },
                };
            }

            api.Switch(target);

            Guid after = api.CurrentId();
            bool ok = after == target;
            if (!ok)
            {
                warnings.Add($"SwitchDesktop 已调用，但当前桌面仍是 {after}（期望 {target}）。");
            }

            return new Dictionary<string, object>
            {
                { "switched", ok },
                { "desktopId", target.ToString() },
                { "previousDesktopId", before.ToString() },
                { "verified", ok },
            };
        }

        public static object Remove(DesktopApi api, Dictionary<string, object> input, List<string> warnings)
        {
            Guid target = Program.RequiredGuid(input);
            string fallbackRaw = Program.OptString(input, "fallbackDesktopId");
            Guid? fallback = null;
            if (!string.IsNullOrWhiteSpace(fallbackRaw))
            {
                Guid g;
                if (!Guid.TryParse(fallbackRaw, out g))
                    throw new VdmException("invalid_argument", "fallbackDesktopId 不是合法 GUID");
                fallback = g;
            }

            var all = api.Desktops(true);
            if (all.Count <= 1)
                throw new VdmException("last_desktop", "只剩一个虚拟桌面，Windows 不允许删除。");

            DesktopRecord victim = api.Find(target);
            if (victim == null)
                throw new VdmException("desktop_not_found", $"虚拟桌面 {target} 不存在（可能已被用户手动删除）。");

            int windowCount = 0;
            foreach (var w in Windows.Enumerate(api, true, true))
                if (w.DesktopId.HasValue && w.DesktopId.Value == target) windowCount++;

            if (windowCount > 0)
                warnings.Add($"该桌面上还有 {windowCount} 个窗口；删除桌面时 Windows 会把它们迁移到其他桌面，不会关闭。");

            Guid current = api.CurrentId();
            if (current == target)
                warnings.Add("注意：你正在删除当前显示的桌面，Windows 会把用户切到其他桌面。");

            api.Remove(target, fallback);
            api.FlushCache();

            return new Dictionary<string, object>
            {
                { "removed", true },
                { "desktopId", target.ToString() },
                { "fallbackDesktopId", fallback?.ToString() },
                { "displacedWindows", windowCount },
            };
        }
    }
}
