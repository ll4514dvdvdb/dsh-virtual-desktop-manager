// 与原生助手 vdmhost.exe 的通信层。
//
// 设计约束（实测得出，勿随意改动）：
// 1. vdmhost.exe 必须由 DSH 宿主进程（Medium 完整性）直接 spawn。沙箱里的 pwsh 是 Low
//    完整性，CoCreateInstance(CLSID_ImmersiveShell) 会返回 0x80070005。
// 2. 一次调用一个进程：命令名走 argv[0]，参数走 stdin 的 JSON，结果走 stdout 的 JSON。
//    不做长驻守护进程，避免状态漂移和句柄泄漏。
// 3. 原生层的错误一律以 {ok:false,error:{code,message,hresult}} 返回，这里翻译成 HostError，
//    让上层能用 code 做 Game Mode / 授权判断，而不是靠匹配中文文案。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const STDIO_LIMIT = 32 * 1024 * 1024

export class HostError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code)
    this.name = 'HostError'
    this.code = code || 'host_error'
    this.hresult = extra.hresult || null
    this.warnings = extra.warnings || []
    this.detail = extra.detail || null
  }
}

export class HostNotFoundError extends HostError {
  constructor(searched, message) {
    super(
      'host_not_found',
      message ||
        '找不到原生助手 vdmhost.exe。请先运行 `npm run build:host` 编译，或把 dist/vdmhost.exe 随插件一起打包。',
      { detail: { searched } },
    )
    this.name = 'HostNotFoundError'
    this.searched = searched
  }
}

/**
 * 定位原生助手。优先级：显式配置 > 包内 dist > 包内 native。
 *
 * 显式配置写错时**不静默回退**：那会让你以为在跑新编译的 exe，实际跑的是包内旧的，
 * 排查起来非常费劲。宁可当场报错，把路径原样打出来。
 *
 * @param {string} pkgDir 插件根目录
 * @param {object} config 插件配置
 * @returns {string} 绝对路径
 */
export function resolveHostPath(pkgDir, config = {}) {
  const explicit = config.hostPath ? String(config.hostPath) : ''
  if (explicit) {
    if (existsSync(explicit)) return explicit
    throw new HostNotFoundError(
      [explicit],
      `配置里指定的 hostPath 不存在：${explicit}\n` +
        '请改对路径（例如 D:/tools/vdmhost.exe），或把它留空让插件自动使用包内 dist/vdmhost.exe。',
    )
  }
  const searched = []
  const push = (p) => {
    if (!p) return
    searched.push(p)
  }
  push(join(pkgDir, 'dist', 'vdmhost.exe'))
  push(join(pkgDir, 'native', 'vdmhost.exe'))
  push(join(pkgDir, 'bin', 'vdmhost.exe'))
  for (const candidate of searched) {
    if (existsSync(candidate)) return candidate
  }
  throw new HostNotFoundError(searched)
}

/**
 * 调一次原生助手。
 *
 * @param {string} hostPath vdmhost.exe 绝对路径
 * @param {string} command 命令名（list_desktops 等）
 * @param {object} payload 参数对象，写进 stdin
 * @param {{timeoutMs?:number, signal?:AbortSignal, env?:object}} [options]
 * @returns {Promise<{data:any, warnings:string[], elapsedMs:number}>}
 */
export function runHost(hostPath, command, payload = {}, options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, 5000, 120000, 20000)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(hostPath, [command], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(options.env || {}) },
      })
    } catch (err) {
      reject(new HostError('host_spawn_failed', `无法启动 vdmhost.exe：${err.message}`, { detail: { code: err.code } }))
      return
    }

    const out = []
    const errchunks = []
    let outBytes = 0
    let settled = false
    let timer = null
    let aborted = false

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      fn(value)
    }

    const onAbort = () => {
      aborted = true
      killTree(child)
    }

    if (options.signal) {
      if (options.signal.aborted) {
        killTree(child)
        finish(reject, new HostError('aborted', '调用被取消'))
        return
      }
      options.signal.addEventListener('abort', onAbort)
    }

    timer = setTimeout(() => {
      killTree(child)
      finish(
        reject,
        new HostError('host_timeout', `原生助手在 ${timeoutMs}ms 内没有返回，已终止（命令 ${command}）`, {
          detail: { command, timeoutMs },
        }),
      )
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.on('error', (err) => {
      finish(
        reject,
        new HostError('host_spawn_failed', `无法启动 vdmhost.exe：${err.message}`, { detail: { code: err.code } }),
      )
    })

    child.stdout?.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > STDIO_LIMIT) {
        killTree(child)
        finish(reject, new HostError('host_output_too_large', '原生助手返回的数据超过 32MB 上限'))
        return
      }
      out.push(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (errchunks.length < 200) errchunks.push(chunk)
    })

    child.on('close', (code) => {
      if (aborted) {
        finish(reject, new HostError('aborted', '调用被取消'))
        return
      }
      const stdout = Buffer.concat(out).toString('utf8').trim()
      const stderr = Buffer.concat(errchunks).toString('utf8').trim()

      if (!stdout) {
        finish(
          reject,
          new HostError('host_no_output', `原生助手没有输出任何结果（退出码 ${code}）`, {
            detail: { command, exitCode: code, stderr: truncate(stderr, 4000) },
          }),
        )
        return
      }

      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch (err) {
        finish(
          reject,
          new HostError('host_bad_output', `原生助手输出不是合法 JSON：${err.message}`, {
            detail: { command, exitCode: code, stdout: truncate(stdout, 4000), stderr: truncate(stderr, 4000) },
          }),
        )
        return
      }

      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => typeof w === 'string') : []
      if (parsed.ok === false) {
        const e = parsed.error || {}
        finish(
          reject,
          new HostError(e.code || 'host_failed', e.message || '原生助手返回失败', {
            hresult: e.hresult || null,
            warnings,
            detail: { command, exitCode: code, data: e.data ?? null },
          }),
        )
        return
      }

      finish(resolve, {
        data: parsed.data ?? null,
        warnings,
        elapsedMs: typeof parsed.elapsedMs === 'number' ? parsed.elapsedMs : 0,
      })
    })

    try {
      child.stdin.end(JSON.stringify(payload ?? {}), 'utf8')
    } catch {
      // stdin 已关闭时会抛；close 事件会给出真正的失败原因
    }
  })
}

function killTree(child) {
  if (!child || child.killed) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try {
      child.kill()
    } catch {
      /* 已经死了 */
    }
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function truncate(text, limit) {
  if (!text) return ''
  return text.length <= limit ? text : `${text.slice(0, limit)}…（截断，共 ${text.length} 字符）`
}

export { delimiter }
