// 通信层测试：定位原生助手、正常调用、错误翻译。
// 这些用例会真的 spawn dist/vdmhost.exe，所以需要先 npm run build:host。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { HostError, HostNotFoundError, resolveHostPath, runHost } from '../lib/bridge.js'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const HOST = join(PKG_DIR, 'dist', 'vdmhost.exe')
const hostBuilt = existsSync(HOST)

test('resolveHostPath 在包内找到 dist/vdmhost.exe', () => {
  if (!hostBuilt) {
    assert.throws(() => resolveHostPath(PKG_DIR, {}), (err) => err instanceof HostNotFoundError)
    return
  }
  assert.equal(resolveHostPath(PKG_DIR, {}), HOST)
})

test('resolveHostPath 支持显式 hostPath 覆盖', () => {
  if (!hostBuilt) return
  assert.equal(resolveHostPath(PKG_DIR, { hostPath: HOST }), HOST)
})

test('找不到助手时抛 HostNotFoundError，并列出搜过的路径', () => {
  const err = (() => {
    try {
      resolveHostPath(join(PKG_DIR, '__nope__'), {})
      return null
    } catch (e) {
      return e
    }
  })()
  assert.ok(err instanceof HostNotFoundError)
  assert.equal(err.code, 'host_not_found')
  assert.ok(Array.isArray(err.searched))
  assert.ok(err.searched.length >= 2)
  assert.match(err.message, /build:host/)
})

test('ping 能跑通，返回 pong 与版本', async (t) => {
  if (!hostBuilt) return t.skip('dist/vdmhost.exe 不存在，先 npm run build:host')
  const r = await runHost(HOST, 'ping', {})
  assert.equal(r.data.pong, true)
  assert.ok(r.data.host)
  assert.ok(Array.isArray(r.warnings))
})

test('未知命令返回 unknown_command，而不是崩溃或空输出', async (t) => {
  if (!hostBuilt) return t.skip('dist/vdmhost.exe 不存在')
  await assert.rejects(
    () => runHost(HOST, 'nope_command', {}),
    (err) => err instanceof HostError && err.code === 'unknown_command',
  )
})

test('参数错误翻译成 invalid_argument（原生层自己校验，不靠文案匹配）', async (t) => {
  if (!hostBuilt) return t.skip('dist/vdmhost.exe 不存在')
  await assert.rejects(
    () => runHost(HOST, 'window_info', {}),
    (err) => err instanceof HostError && err.code === 'invalid_argument',
  )
})

test('spawn 失败时抛 host_spawn_failed', async () => {
  await assert.rejects(
    () => runHost(join(PKG_DIR, '__nope__', 'vdmhost.exe'), 'ping', {}),
    (err) => err instanceof HostError && (err.code === 'host_spawn_failed' || err.code === 'host_no_output'),
  )
})

test('signal 已中止时直接抛 aborted', async (t) => {
  if (!hostBuilt) return t.skip('dist/vdmhost.exe 不存在')
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(
    () => runHost(HOST, 'ping', {}, { signal: ac.signal }),
    (err) => err instanceof HostError && err.code === 'aborted',
  )
})
