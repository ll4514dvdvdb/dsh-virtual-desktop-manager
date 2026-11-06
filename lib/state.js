// 插件自身的持久化状态：Game Mode、AI 工作桌面标识、等待队列、审计日志。
//
// 落盘位置刻意放在 ~/.dsh/virtual-desktop-manager/ 而不是系统 %TEMP%：
// 受限启动的进程可能继承写限制，用户目录下的固定路径更可靠，也方便用户自己翻日志。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_STATE = {
  version: 1,
  gameMode: false,
  gameModeReason: '',
  gameModeSince: null,
  workspaceDesktopId: null,
  workspaceDesktopName: 'AI 工作桌面',
  pending: [],
  updatedAt: null,
}

export function stateDir() {
  return process.env.VDM_STATE_DIR || join(homedir(), '.dsh', 'virtual-desktop-manager')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function stateFile() {
  return join(stateDir(), 'state.json')
}

export function auditFile() {
  return join(stateDir(), 'audit.log')
}

export function capturesDir() {
  return ensureDir(join(stateDir(), 'captures'))
}

/**
 * 读状态。文件损坏时不让插件起不来：退化成默认状态并在返回值的 _warning 里说明。
 */
export function readState() {
  const file = stateFile()
  if (!existsSync(file)) return { ...DEFAULT_STATE, pending: [] }
  try {
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_STATE,
      ...parsed,
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    }
  } catch (err) {
    // 保守处理：文件坏了就当 Game Mode 开着。宁可少做动作，也不要因为状态读不出来
    // 就在用户游戏期间去切桌面/抢前台。用户可以用 vdm_game_mode off 显式恢复。
    return {
      ...DEFAULT_STATE,
      gameMode: true,
      gameModeReason: '状态文件损坏，保守按 Game Mode 开启处理',
      pending: [],
      _warning: `状态文件 ${file} 解析失败（${err.message}），已按"Game Mode 开启"的保守状态继续。确认后再显式关闭。`,
    }
  }
}

/**
 * 合并写入状态。用临时文件 + rename 保证不会写出半截 JSON。
 */
export function writeState(patch) {
  const dir = ensureDir(stateDir())
  const next = { ...readState(), ...patch, updatedAt: new Date().toISOString() }
  delete next._warning
  const file = join(dir, 'state.json')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    try {
      unlinkSync(tmp)
    } catch {
      /* tmp 留着也无害 */
    }
  }
  return next
}

/**
 * 追加一条审计记录（JSONL）。审计失败不能影响主流程，所以整体吞异常——
 * 但会把失败写进最后一条记录的 _auditError 之外，仅通过返回 false 告知调用方。
 */
export function audit(entry) {
  try {
    ensureDir(stateDir())
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    appendFileSync(auditFile(), `${line}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

export function pushPending(item) {
  const state = readState()
  const list = state.pending.slice()
  list.push({ ts: new Date().toISOString(), ...item })
  // 队列封顶 200 条，防止长期开着 Game Mode 把状态文件撑大
  while (list.length > 200) list.shift()
  writeState({ pending: list })
  return list.length
}

export function clearPending() {
  writeState({ pending: [] })
}

export { DEFAULT_STATE }
