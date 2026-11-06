// 实测需求"必须考虑虚拟桌面被用户手动删除的情况"：
// 1) 删掉 AI 工作桌面  2) ensure 应该按名字重建出新的（GUID 变化，不能沿用旧 id）  3) 再 ensure 应该复用
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'vdm-recreate-'))
process.env.VDM_STATE_DIR = stateDir

const { apply } = await import('../index.js')
const { readState } = await import('../lib/state.js')

const tools = new Map()
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register(t) { tools.set(t.name, t) } },
  get: () => undefined,
  inject() {},
}
apply(ctx, {})

let pass = 0
let fail = 0
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}${detail ? ' → ' + detail : ''}`) }
}
const call = async (name, args = {}) => tools.get(name).execute(args, {})

const NAME = 'AI 工作桌面'

console.log('[1] 先确认现状')
const before = await call('vdm_list_desktops')
const list0 = before.data?.desktops ?? []
const existing = list0.find((d) => d.name === NAME)
ok('桌面上存在 AI 工作桌面', Boolean(existing), JSON.stringify(list0.map((d) => d.name)))
const oldId = existing?.id
console.log(`    旧 GUID: ${oldId}  窗口数: ${existing?.windowCount}`)
if ((existing?.windowCount ?? 0) > 0) {
  console.log('\n跳过：这个桌面里还有窗口，不拿它做实验（删掉会把窗口挤到别的桌面去）。')
  console.log('清空它之后再跑，或临时把 workspaceDesktopName 指到别的名字。')
  rmSync(stateDir, { recursive: true, force: true })
  process.exit(0)
}
if (existing?.isCurrent) {
  console.log('\n跳过：这个桌面正显示给用户，不能删。')
  rmSync(stateDir, { recursive: true, force: true })
  process.exit(0)
}

console.log('[2] 模拟用户手动删除它')
const rm = await call('vdm_remove_desktop', { desktopId: oldId, authorized: true })
ok('删除成功', rm.ok === true && rm.data?.removed === true, JSON.stringify(rm.data ?? rm))
const after = await call('vdm_list_desktops')
const stillThere = (after.data?.desktops ?? []).some((d) => d.id === oldId)
ok('列表里已经没有那个 GUID', stillThere === false)
ok('用户当前桌面没被切走', after.data?.currentDesktopId !== undefined && after.data?.desktops?.some((d) => d.isCurrent))

console.log('[3] ensure 应该按名字重建（而不是报 desktop_not_found）')
const e1 = await call('vdm_ensure_workspace_desktop')
const newId = e1.desktopId ?? e1.data?.desktopId ?? e1.data?.desktop?.id
ok('ensure 成功', e1.ok === true, e1.text?.slice(0, 120))
ok('拿到新 GUID', Boolean(newId))
ok('新 GUID 与旧的不同', newId !== oldId, `${newId} vs ${oldId}`)
ok('名字仍然是 AI 工作桌面', e1.data?.desktop?.name === NAME || e1.data?.name === NAME, JSON.stringify(e1.data))

console.log('[4] state 里的 workspaceDesktopId 被更新成新 GUID')
const st = readState()
ok('state.workspaceDesktopId === 新 GUID', st.workspaceDesktopId === newId, `${st.workspaceDesktopId} vs ${newId}`)

console.log('[5] 再 ensure 一次应该复用，不重复建桌面')
const countBefore = (await call('vdm_list_desktops')).data?.desktops?.length
const e2 = await call('vdm_ensure_workspace_desktop')
const countAfter = (await call('vdm_list_desktops')).data?.desktops?.length
ok('第二次 ensure 成功', e2.ok === true)
ok('桌面数量没变（复用）', countBefore === countAfter, `${countBefore} → ${countAfter}`)
ok('返回的还是同一个 GUID', (e2.desktopId ?? e2.data?.desktopId ?? e2.data?.desktop?.id) === newId)

console.log('[6] 用户当前桌面自始至终都在主页面')
const cur = await call('vdm_get_current_desktop')
const curName = (await call('vdm_list_desktops')).data?.desktops?.find((d) => d.isCurrent)?.name
ok('当前桌面不是 AI 工作桌面', curName !== NAME, `当前在「${curName}」`)
console.log(`    当前桌面: ${curName} (${cur.data?.desktopId})`)

rmSync(stateDir, { recursive: true, force: true })
console.log(`\n结果：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
