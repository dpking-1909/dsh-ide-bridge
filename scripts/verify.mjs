#!/usr/bin/env node
/**
 * Dependency-free verification for the IDE bridge.
 *
 * Part 1 exercises the browser half: the module wrapper, `apply()` registrations,
 * tab-type claims and injected helpers, all against a fake Cordis context.
 * Part 2 exercises the Host mirror protocol: the token-guarded bridge, relative
 * path resolution, command queue and bridge descriptor lifecycle.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assertions = []
const failures = []

function check(name, condition, detail) {
  assertions.push(name)
  if (!condition) failures.push(detail ? `${name}: ${detail}` : name)
}

function checkEqual(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** Part 1: the browser half. */
async function verifyClientHalf() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn) => fn,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => fn(),
  }
  globalThis.document = {
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { appendChild() {} },
  }

  const reactStub = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    Fragment: 'fragment',
  }
  const requireStub = (name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require: ${name}`)
  }

  await import(`${pathToFileURL(join(root, 'client.js')).href}?verify=${Date.now()}`)
  check('client module registered with the loader', Boolean(captured))
  if (!captured) return
  checkEqual('client module id', captured.id, 'dsh-ide-bridge')

  const tabDefinitions = []
  const slotRegistrations = []
  const effects = []
  const workspaceFiles = { read: async () => ({ text: '', version: 'v1', lines: 1, eof: true }), stat: async () => ({ version: 'v1' }) }
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    effect(callback, label) {
      effects.push(label)
      const dispose = callback()
      if (typeof dispose !== 'function') throw new Error(`effect ${label} returned no disposer`)
      return dispose
    },
    sidebarRightTabs: {
      register(definition) {
        tabDefinitions.push(definition)
        return () => {}
      },
    },
    slots: {
      inject: (name, callback) => callback(),
      register(options, component) {
        slotRegistrations.push({ options, component })
        return () => {}
      },
    },
    sidebarRight: { openResource: () => {} },
    remote: { workspaceFiles },
  }

  const plugin = captured.factory(requireStub)
  for (const service of ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles']) {
    check(`injects ${service}`, plugin.inject.includes(service))
  }
  plugin.apply(ctx)
  check('registers ten effects', effects.length === 10)

  const codeType = tabDefinitions.find((definition) => definition.kind === 'ide-open')
  const changesType = tabDefinitions.find((definition) => definition.kind === 'ide-changes')
  check('registers the editor tab type', Boolean(codeType))
  check('registers the changed-files tab type', Boolean(changesType))
  if (codeType) {
    checkEqual('editor type uses the extension band', codeType.priority, 'extension')
    check('editor type claims a .ts file', codeType.canOpen('dsh-resource://file/session/s1/src/a.ts') === true)
    check('editor type ignores a .md file', codeType.canOpen('dsh-resource://file/session/s1/README.md') === false)
    checkEqual('editor tab title is the basename', codeType.title('dsh-resource://file/session/s1/src/a.ts'), 'a.ts')
  }
  if (changesType) check('changed-files type has a guide entry', Boolean(changesType.guide && changesType.guide[0]))

  const editorBody = slotRegistrations.find((entry) => entry.options.key === 'dsh-ide-bridge/open')
  check('registers the editor body', Boolean(editorBody))
  if (editorBody) {
    checkEqual('editor body component', editorBody.component.name, 'MirrorCodeEditor')
    const injected = editorBody.options.inject()
    check('editor body receives workspaceFiles', Boolean(injected && injected.workspaceFiles))
    check('editor body receives navigation helpers', typeof injected.openResource === 'function' && typeof injected.openPreview === 'function')
  }
  const slotNames = slotRegistrations.map((entry) => entry.options.name)
  for (const slot of ['sidebar.right.pane.tab', 'sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable', 'sidebar.right.tab.files.actions']) {
    check(`contributes to ${slot}`, slotNames.includes(slot))
  }
}

/** Part 2: the Host mirror protocol. */
async function verifyHostHalf() {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-ide-bridge-verify-'))
  process.env.DSH_HOME = dshHome
  try {
    const { apply, inject } = await import(`${pathToFileURL(join(root, 'index.js')).href}?verify=${Date.now()}`)
    check('host injects webServer', inject.includes('webServer'))

    const routes = new Map()
    const disposers = []
    let bridgeRoute
    const session = { id: 'session-1', header: { cwd: 'D:\\proj' }, seq: 0, eventAt: () => undefined }
    const ctx = {
      connection: { fetch: { register: (route) => routes.set(`${route.methods.join(',')} ${route.path}`, route) } },
      sessions: { get: (id) => (id === 'session-1' ? session : undefined) },
      get: () => undefined,
      fs: {
        resolve: async (path) => ({ targetKey: path, displayPath: path }),
        writeText: async () => {
          throw new Error('unexpected write')
        },
        processPath: (target) => target.displayPath,
      },
      sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'D:\\proj' }) },
      webServer: {
        getOrigin: () => 'http://127.0.0.1:3080',
        register: (route) => {
          bridgeRoute = route
          return () => {}
        },
      },
      effect(callback) {
        const dispose = callback()
        disposers.push(dispose)
        return dispose
      },
    }

    apply(ctx, { defaultEditor: 'vscode' })
    check('host registers the bridge prefix route', Boolean(bridgeRoute && bridgeRoute.kind === 'prefix' && bridgeRoute.path === '/ide-bridge'))

    const descriptorPath = join(dshHome, 'cache', 'ide-bridge', 'bridge.json')
    check('bridge descriptor written', existsSync(descriptorPath))
    const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
    check('bridge descriptor carries the web origin', descriptor.url === 'http://127.0.0.1:3080')
    check('bridge descriptor carries a token', typeof descriptor.token === 'string' && descriptor.token.length > 20)

    /** Minimal IncomingMessage/ServerResponse doubles. */
    function plain(method, url, { token, body } = {}) {
      return new Promise((settle) => {
        const req = new EventEmitter()
        req.method = method
        req.url = url
        req.headers = token ? { 'x-dsh-token': token } : {}
        req.destroy = () => {}
        const res = {
          statusCode: 0,
          body: '',
          writeHead(status) {
            this.statusCode = status
          },
          end(payload) {
            this.body = payload || ''
            settle({ status: this.statusCode, body: this.body })
          },
        }
        void bridgeRoute.handler(req, res)
        if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
        req.emit('end')
      })
    }

    const api = (key, url, init) =>
      routes
        .get(key)
        .fetch(new Request(url, init))
        .then(async (response) => ({ status: response.status, body: await response.json() }))

    const unauthorized = await plain('GET', '/ide-bridge/health')
    check('bridge rejects a missing token', unauthorized.status === 401)

    const pushed = await plain('POST', '/ide-bridge/push', {
      token: descriptor.token,
      body: {
        instanceId: 'instance-1',
        editor: 'vscode',
        editorVersion: '1.142.0',
        type: 'document',
        activePath: 'D:\\proj\\src\\a.ts',
        document: { path: 'D:\\proj\\src\\a.ts', languageId: 'typescript', version: 7, dirty: false, size: 12, text: 'const a = 1\n' },
      },
    })
    checkEqual('bridge accepts a token-guarded push', JSON.parse(pushed.body), { ok: true })

    const relative = await api('GET /api/ide-bridge.mirror', 'http://x/api/ide-bridge.mirror?sessionId=session-1&path=src/a.ts')
    checkEqual('mirror resolves a relative path against the session cwd', relative.body.matching, true)
    checkEqual('mirror returns the mirrored text', relative.body.document && relative.body.document.text, 'const a = 1\n')

    const absolute = await api('GET /api/ide-bridge.mirror', 'http://x/api/ide-bridge.mirror?sessionId=session-1&path=D%3A%5Cproj%5Csrc%5Ca.ts')
    checkEqual('mirror matches an absolute path', absolute.body.matching, true)

    const other = await api('GET /api/ide-bridge.mirror', 'http://x/api/ide-bridge.mirror?sessionId=session-1&path=src/b.ts')
    checkEqual('mirror reports a non-active file as non-matching', other.body.matching, false)

    const queued = await api('POST /api/ide-bridge.mirror-command', 'http://x/api/ide-bridge.mirror-command', {
      method: 'POST',
      body: JSON.stringify({ instanceId: 'instance-1', sessionId: 'session-1', command: { type: 'open', path: 'src/a.ts', line: 3 } }),
    })
    check('mirror command is queued', queued.status === 200 && queued.body.ok === true)

    const firstPoll = JSON.parse((await plain('GET', '/ide-bridge/commands?instanceId=instance-1&since=0', { token: descriptor.token })).body)
    checkEqual('queued command carries an absolute path', firstPoll.commands[0] && firstPoll.commands[0].path, 'D:\\proj\\src\\a.ts')
    const secondPoll = JSON.parse((await plain('GET', `/ide-bridge/commands?instanceId=instance-1&since=${firstPoll.next}`, { token: descriptor.token })).body)
    checkEqual('command cursor drains the queue', secondPoll.commands, [])

    for (const dispose of [...disposers].reverse()) {
      try {
        if (typeof dispose === 'function') await dispose()
      } catch {
        /* best effort */
      }
    }
    check('bridge descriptor removed on dispose', !existsSync(descriptorPath))
  } finally {
    rmSync(dshHome, { recursive: true, force: true })
  }
}

try {
  await verifyClientHalf()
  await verifyHostHalf()
} catch (error) {
  failures.push(`unexpected error: ${error && error.stack ? error.stack : error}`)
}

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}/${assertions.length + failures.length} checks`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`OK ${assertions.length} checks passed`)
