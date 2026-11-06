// 状态层测试：Game Mode、等待队列、审计日志。
// 全部在临时目录里跑（VDM_STATE_DIR 覆盖），不碰用户真实的 ~/.dsh。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  audit,
  auditFile,
  capturesDir,
  clearPending,
  pushPending,
  readState,
  stateDir,
  stateFile,
  writeState,
} from '../lib/state.js'

const root = mkdtempSync(join(tmpdir(), 'vdm-state-'))
process.env.VDM_STATE_DIR = join(root, 'state')

after(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
})

test('stateDir 跟随 VDM_STATE_DIR，而不是写死 ~/.dsh', () => {
  assert.equal(stateDir(), join(root, 'state'))
})

test('没有状态文件时返回默认值（Game Mode 关闭）', () => {
  const s = readState()
  assert.equal(s.gameMode, false)
  assert.deepEqual(s.pending, [])
  assert.equal(s.version, 1)
})

test('writeState 合并写入并能读回', () => {
  writeState({ gameMode: true, gameModeReason: '用户在打 Unturned' })
  const s = readState()
  assert.equal(s.gameMode, true)
  assert.equal(s.gameModeReason, '用户在打 Unturned')
  assert.ok(s.updatedAt)
  assert.ok(existsSync(stateFile()))

  // 局部更新不丢其他字段
  writeState({ workspaceDesktopId: 'bbbb' })
  const t = readState()
  assert.equal(t.gameMode, true)
  assert.equal(t.workspaceDesktopId, 'bbbb')
})

test('状态文件损坏时保守按 Game Mode 开启处理，并给出 _warning', () => {
  writeFileSync(stateFile(), '{ 这不是 JSON', 'utf8')
  const s = readState()
  // 安全优先：状态读不出来时不能假设"用户没在玩游戏"
  assert.equal(s.gameMode, true)
  assert.equal(s.gameModeReason, '状态文件损坏，保守按 Game Mode 开启处理')
  assert.deepEqual(s.pending, [])
  assert.match(s._warning, /解析失败/)
})

test('pushPending 追加、保序、封顶 200 条，clearPending 清空', () => {
  writeState({ pending: [] })
  for (let i = 0; i < 205; i += 1) pushPending({ action: 'vdm_move_window', reason: `r${i}` })
  const s = readState()
  assert.equal(s.pending.length, 200)
  assert.equal(s.pending[0].reason, 'r5')
  assert.equal(s.pending[199].reason, 'r204')
  assert.ok(s.pending[0].ts)

  clearPending()
  assert.deepEqual(readState().pending, [])
})

test('audit 以 JSONL 追加，字段可解析', () => {
  writeState({ pending: [] })
  assert.equal(audit({ tool: 'vdm_list_desktops', ok: true, elapsedMs: 12 }), true)
  assert.equal(audit({ tool: 'vdm_switch_desktop', ok: false, code: 'not_authorized' }), true)

  const lines = readFileSync(auditFile(), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.tool, 'vdm_list_desktops')
  assert.equal(first.ok, true)
  assert.ok(first.ts)
  const second = JSON.parse(lines[1])
  assert.equal(second.code, 'not_authorized')
})

test('capturesDir 自动创建截图目录', () => {
  const dir = capturesDir()
  assert.ok(existsSync(dir))
  assert.equal(dir, join(stateDir(), 'captures'))
})
