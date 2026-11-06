// UI Automation：只针对"指定 HWND"做控件级读取与操作。
//
// 为什么坚持 UIA 而不是 SendInput / 全局坐标点击：
//   1. 全局输入会打到当前前台窗口，用户正在游戏时等于直接抢他的操作；
//   2. 坐标点击依赖屏幕位置与 DPI，窗口在别的虚拟桌面、或被遮挡时就会点错；
//   3. UIA 的 Invoke/SetValue 是发给元素所在进程的消息，不需要窗口在前台。
//
// 代价与边界（都写进返回值，不藏着）：
//   - 有的程序不实现 UIA（自绘 UI、部分游戏/远程桌面），只能靠截图 + 人眼，或者改用其他方式；
//   - 跨进程调用是同步的，目标程序卡住时调用也会卡住 —— 所以调用前先用 IsHungAppWindow 挡一道；
//   - 索引路径不稳定：界面一变，同一条路径指向的控件可能就换了，不能当持久标识。
using System;
using System.Collections.Generic;
using System.Windows.Automation;

namespace VdmHost.Interop
{
    internal static class Uia
    {
        /// <summary>读不到 UIA 树（窗口没实现 UIA、已销毁、权限不足等）。</summary>
        public const string NoTreeCode = "uia_unavailable";

        public static Dictionary<string, object> Tree(IntPtr hwnd, int maxDepth, int maxNodes, string nameContains)
        {
            if (maxDepth < 0) maxDepth = 0;
            if (maxNodes <= 0) maxNodes = 150;

            // 不用 CacheRequest：实测在 Chromium/Electron 窗口（Chrome_WidgetWin_1）上，
            // 无论 CacheRequest 在 FromHandle 之前还是之后激活，访问 el.Cached 都会抛
            // InvalidOperationException（"不能请求未缓存的属性或模式"）。
            // 而 PowerShell 里直接读 el.Current 完全正常，所以这里统一走 Current 实时读取：
            // 每个属性一次跨进程往返，实测每节点 1~3ms，80 节点约 200ms，可以接受。
            var nodes = new List<object>();
            bool truncated = false;
            string rootName = string.Empty;
            string rootType = "Unknown";
            TreeWalker walker = TreeWalker.ControlViewWalker;

            AutomationElement root;
            try { root = AutomationElement.FromHandle(hwnd); }
            catch (Exception ex) { throw new VdmException(NoTreeCode, "这个窗口读不到 UI Automation 树：" + ex.Message); }
            if (root == null)
                throw new VdmException(NoTreeCode, "这个窗口读不到 UI Automation 树（可能已销毁，或该程序不提供 UIA）。");

            try
            {
                rootName = root.Current.Name ?? string.Empty;
                rootType = TypeName(root.Current.ControlType);
            }
            catch (ElementNotAvailableException)
            {
                throw new VdmException(NoTreeCode, "窗口在读取过程中消失了。");
            }
            catch (Exception) { }

            {

                var queue = new Queue<Tuple<AutomationElement, string, int>>();
                queue.Enqueue(Tuple.Create(root, string.Empty, 0));

                while (queue.Count > 0)
                {
                    if (nodes.Count >= maxNodes) { truncated = true; break; }
                    var item = queue.Dequeue();
                    AutomationElement el = item.Item1;
                    string path = item.Item2;
                    int depth = item.Item3;

                    Dictionary<string, object> node;
                    try { node = Describe(el, path, depth); }
                    catch (ElementNotAvailableException) { continue; } // 遍历过程中窗口被关了

                    if (string.IsNullOrEmpty(nameContains)
                        || Contains(node, nameContains))
                        nodes.Add(node);
                    else if (depth == 0)
                        nodes.Add(node); // 根节点永远保留，否则调用方看不到自己在看谁

                    if (depth >= maxDepth) continue;

                    AutomationElement child = null;
                    try { child = walker.GetFirstChild(el); }
                    catch (ElementNotAvailableException) { continue; }

                    int index = 0;
                    while (child != null)
                    {
                        string childPath = path.Length == 0
                            ? index.ToString()
                            : path + "/" + index.ToString();
                        queue.Enqueue(Tuple.Create(child, childPath, depth + 1));
                        index++;
                        try { child = walker.GetNextSibling(child); }
                        catch (ElementNotAvailableException) { child = null; }
                    }
                }
            }

            return new Dictionary<string, object>
            {
                { "hwnd", "0x" + hwnd.ToInt64().ToString("X") },
                { "rootName", rootName },
                { "rootType", rootType },
                { "nodeCount", nodes.Count },
                { "maxDepth", maxDepth },
                { "maxNodes", maxNodes },
                { "truncated", truncated },
                { "nodes", nodes },
                { "note", "path 是「从根节点往下数的子节点索引」（如 0/2/1），只在当前这一瞬间有效；"
                        + "界面一变就可能指向别的控件，绝不能当持久标识存起来。"
                        + "offscreen 为 true 表示控件在可视区域外，通常需要先滚动或展开父节点。" },
            };
        }

        /// <summary>
        /// 按索引路径定位元素并调用它自己支持的 pattern。
        /// 绝不发全局鼠标键盘事件：能调就调，调不了就明确报错让调用方换策略。
        /// </summary>
        public static Dictionary<string, object> Act(IntPtr hwnd, string path, string action, string value)
        {
            AutomationElement el = Resolve(hwnd, path);
            if (el == null)
                throw new VdmException("uia_element_not_found",
                    "按 path=" + (path ?? string.Empty) + " 找不到控件。界面可能已经变了，请重新跑 uia_tree 取最新路径。");

            string requested = (action ?? string.Empty).Trim().ToLowerInvariant();
            string used = null;
            string before = Safe(() => el.Current.Name);
            object extra = null;

            try
            {
                switch (requested)
                {
                    case "invoke":
                        {
                            object p;
                            if (!el.TryGetCurrentPattern(InvokePattern.Pattern, out p))
                                return NotSupported(el, "Invoke", "这个控件不支持 Invoke（不是按钮/菜单项一类）。");
                            used = "Invoke";
                            ((InvokePattern)p).Invoke();
                            break;
                        }
                    case "setvalue":
                        {
                            object p;
                            if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out p))
                                return NotSupported(el, "Value", "这个控件不支持设置值（通常只有编辑框可以）。");
                            used = "Value";
                            ((ValuePattern)p).SetValue(value ?? string.Empty);
                            break;
                        }
                    case "toggle":
                        {
                            object p;
                            if (!el.TryGetCurrentPattern(TogglePattern.Pattern, out p))
                                return NotSupported(el, "Toggle", "这个控件不是开关/复选框。");
                            var toggle = (TogglePattern)p;
                            string was = toggle.Current.ToggleState.ToString();
                            used = "Toggle";
                            toggle.Toggle();
                            System.Threading.Thread.Sleep(120);
                            extra = new Dictionary<string, object> { { "toggleStateBefore", was }, { "toggleStateAfter", SafeObject(() => toggle.Current.ToggleState.ToString()) } };
                            break;
                        }
                    case "expand":
                    case "collapse":
                        {
                            object p;
                            if (!el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p))
                                return NotSupported(el, "ExpandCollapse", "这个控件不可展开/折叠。");
                            var ec = (ExpandCollapsePattern)p;
                            used = "ExpandCollapse";
                            if (requested == "expand") ec.Expand(); else ec.Collapse();
                            break;
                        }
                    case "select":
                        {
                            object p;
                            if (!el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p))
                                return NotSupported(el, "SelectionItem", "这个控件不是可选中项（列表项/单选/标签页）。");
                            used = "SelectionItem";
                            ((SelectionItemPattern)p).Select();
                            break;
                        }
                    case "focus":
                        used = "SetFocus";
                        el.SetFocus();
                        break;
                    case "scroll":
                        {
                            object p;
                            if (!el.TryGetCurrentPattern(ScrollPattern.Pattern, out p))
                                return NotSupported(el, "Scroll", "这个控件不可滚动。");
                            used = "Scroll";
                            ((ScrollPattern)p).SetScrollPercent(ScrollPattern.NoScroll, double.Parse(value ?? "0"));
                            break;
                        }
                    default:
                        throw new VdmException("invalid_argument",
                            "action 必须是 invoke / setvalue / toggle / expand / collapse / select / focus / scroll 之一，收到：" + action);
                }
            }
            catch (ElementNotAvailableException)
            {
                throw new VdmException("uia_element_not_found", "控件在操作过程中消失了（窗口被关或被重建），请重新跑 uia_tree。");
            }
            catch (InvalidOperationException ex)
            {
                throw new VdmException("uia_action_failed", "UIA 拒绝了这次操作：" + ex.Message);
            }

            System.Threading.Thread.Sleep(150);

            var data = new Dictionary<string, object>
            {
                { "hwnd", "0x" + hwnd.ToInt64().ToString("X") },
                { "path", path },
                { "action", requested },
                { "pattern", used },
                { "succeeded", true },
                { "elementName", before },
                { "elementType", Safe(() => TypeName(el.Current.ControlType)) },
                { "note", "操作是通过 UI Automation 发给该控件所在进程的，没有移动鼠标、没有模拟键盘、没有把窗口切到前台。" },
            };
            if (extra != null) data["detail"] = extra;
            return data;
        }

        private static Dictionary<string, object> NotSupported(AutomationElement el, string pattern, string why)
        {
            var supports = new List<string>();
            try
            {
                foreach (AutomationPattern p in el.GetSupportedPatterns())
                    supports.Add(p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", string.Empty));
            }
            catch { /* 拿不到支持列表就算了，不要因此把整个调用弄失败 */ }

            var data = new Dictionary<string, object>
            {
                { "succeeded", false },
                { "pattern", pattern },
                { "reason", why },
                { "supportedPatterns", supports.ToArray() },
                { "elementName", Safe(() => el.Current.Name) },
                { "elementType", Safe(() => TypeName(el.Current.ControlType)) },
            };
            return data;
        }

        private static AutomationElement Resolve(IntPtr hwnd, string path)
        {
            if (!Win32.IsWindow(hwnd)) return null;
            AutomationElement el = AutomationElement.FromHandle(hwnd);
            if (el == null) return null;
            string p = (path ?? string.Empty).Trim();
            if (p.Length == 0) return el;

            TreeWalker walker = TreeWalker.ControlViewWalker;
            foreach (string seg in p.Split('/'))
            {
                int index;
                if (!int.TryParse(seg, out index) || index < 0)
                    throw new VdmException("invalid_argument", "path 段 \"" + seg + "\" 不是非负整数；path 应形如 0/2/1 或留空表示窗口根节点。");
                AutomationElement child = walker.GetFirstChild(el);
                for (int i = 0; i < index && child != null; i++)
                    child = walker.GetNextSibling(child);
                if (child == null) return null;
                el = child;
            }
            return el;
        }

        private static Dictionary<string, object> Describe(AutomationElement el, string path, int depth)
        {
            // 用 Current 实时属性（不用 Cached）：见 Tree() 顶部的说明，Cached 在 Chromium 窗口上必抛。
            AutomationElement.AutomationElementInformation c = el.Current;
            System.Windows.Rect rect;
            try { rect = c.BoundingRectangle; }
            catch (Exception) { rect = System.Windows.Rect.Empty; }
            var node = new Dictionary<string, object>
            {
                { "path", path },
                { "depth", depth },
                { "type", TypeName(c.ControlType) },
                { "name", c.Name ?? string.Empty },
                { "automationId", c.AutomationId ?? string.Empty },
                { "className", c.ClassName ?? string.Empty },
                { "enabled", c.IsEnabled },
                { "offscreen", c.IsOffscreen },
            };

            // 注意：这里刻意不调用 GetSupportedPatterns()。
            // 逐个控件查 pattern 会让 150 个节点的遍历慢好几倍，而且有的控件在查 pattern 时会长时间阻塞。
            // 哪些能操作，交给 uia_act 现场判断并回报。
            string type = TypeName(c.ControlType);
            if (type == "Button" || type == "Edit" || type == "CheckBox" || type == "RadioButton"
                || type == "ComboBox" || type == "MenuItem" || type == "ListItem" || type == "TabItem"
                || type == "TreeItem" || type == "Hyperlink" || type == "SplitButton")
            {
                node["interactive"] = true;
            }

            if (!rect.IsEmpty && rect.Width > 0 && rect.Height > 0)
                node["rect"] = new Dictionary<string, object>
                {
                    { "x", (int)rect.X }, { "y", (int)rect.Y },
                    { "width", (int)rect.Width }, { "height", (int)rect.Height },
                };

            return node;
        }

        private static bool Contains(Dictionary<string, object> node, string needle)
        {
            foreach (string key in new[] { "name", "automationId", "className", "type" })
            {
                object v;
                if (node.TryGetValue(key, out v) && v != null
                    && v.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                    return true;
            }
            return false;
        }

        private static string TypeName(ControlType type)
        {
            if (type == null) return "Unknown";
            string n = type.ProgrammaticName ?? string.Empty;
            int dot = n.LastIndexOf('.');
            return dot >= 0 ? n.Substring(dot + 1) : n;
        }

        private static string Safe(Func<string> f)
        {
            try { return f() ?? string.Empty; } catch { return string.Empty; }
        }

        private static string SafeObject(Func<string> f)
        {
            try { return f() ?? string.Empty; } catch { return string.Empty; }
        }
    }
}
