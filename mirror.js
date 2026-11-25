/**
 * Host-side hub of the editor mirror.
 *
 * The VS Code / Cursor extension and this Harness live in different processes,
 * so the bridge has two faces:
 *
 *   - plain `/ide-bridge/*` HTTP routes for the extension (loopback only),
 *     guarded by a random token published in a bridge descriptor file next to
 *     the DSH home directory;
 *   - authenticated `/api/ide-bridge.mirror*` routes for the browser half,
 *     which poll the mirrored document and enqueue commands.
 *
 * The hub keeps one record per connected editor instance (last writer wins for
 * the browser) and a small per-instance command queue the extension drains.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize } from 'node:path'

/** Largest document text accepted from the editor; larger files mirror as metadata only. */
export const MAX_MIRROR_CONTENT_CHARS = 1_500_000
/** An instance with no push for this long is dropped from the browser surface. */
const INSTANCE_TTL_MS = 20000
/** Commands retained per instance before the oldest are discarded. */
const MAX_QUEUE_LENGTH = 200

/** Normalize a workspace path for identity comparisons. */
export function normalizePathKey(path) {
  const text = String(path || '')
  if (!text) return ''
  let normalized
  try {
    normalized = normalize(text)
  } catch {
    normalized = text
  }
  normalized = normalized.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** The bridge descriptor the extension reads: URL, token, and owning process. */
export function bridgeFilePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'cache', 'ide-bridge', 'bridge.json')
}

/** Generate the per-activation bridge token. */
export function createBridgeToken() {
  return randomBytes(24).toString('hex')
}

/** Read one small JSON body from an IncomingMessage. */
export function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Write one JSON response for a plain route. */
export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Whether one plain request carries the bridge token. */
export function hasBridgeToken(req, url, token) {
  const header = req.headers['x-dsh-token']
  if (typeof header === 'string' && header === token) return true
  return url.searchParams.get('token') === token
}

/** One connected editor instance, as the hub keeps it. */
function createInstance(id) {
  return {
    id,
    editor: 'vscode',
    editorVersion: '',
    lastSeen: Date.now(),
    activePath: '',
    selection: null,
    document: null,
    queue: [],
    nextSeq: 1,
  }
}

/** The editor mirror hub. */
export class MirrorHub {
  constructor(options) {
    this.origin = options.origin
    this.token = options.token || createBridgeToken()
    this.bridgeFile = options.bridgeFile || bridgeFilePath()
    this.instances = new Map()
    this.pruneTimer = undefined
  }

  /** Publish the bridge descriptor and start pruning stale instances. */
  start() {
    mkdirSync(dirname(this.bridgeFile), { recursive: true })
    const descriptor = {
      url: this.origin,
      token: this.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }
    const temporary = `${this.bridgeFile}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(descriptor, null, 2), 'utf8')
    renameSync(temporary, this.bridgeFile)
    this.pruneTimer = setInterval(() => this.prune(), 5000)
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref()
  }

  /** Remove the descriptor and the prune timer. */
  dispose() {
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.pruneTimer = undefined
    try {
      rmSync(this.bridgeFile, { force: true })
    } catch {
      /* the file may already be gone */
    }
  }

  /** Drop instances that stopped pushing. */
  prune() {
    const now = Date.now()
    for (const [id, instance] of this.instances) {
      if (now - instance.lastSeen > INSTANCE_TTL_MS) this.instances.delete(id)
    }
  }

  /** Apply one push from an editor extension. */
  push(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid payload')
    const instanceId = String(payload.instanceId || '')
    if (!instanceId) throw new Error('`instanceId` is required')
    let instance = this.instances.get(instanceId)
    if (!instance) {
      instance = createInstance(instanceId)
      this.instances.set(instanceId, instance)
    }
    instance.lastSeen = Date.now()
    if (typeof payload.editor === 'string' && payload.editor) instance.editor = payload.editor
    if (typeof payload.editorVersion === 'string') instance.editorVersion = payload.editorVersion
    if (typeof payload.activePath === 'string') instance.activePath = payload.activePath
    if (payload.selection && typeof payload.selection === 'object') {
      instance.selection = {
        line: Number.isInteger(payload.selection.line) ? payload.selection.line : 1,
        character: Number.isInteger(payload.selection.character) ? payload.selection.character : 1,
      }
    }
    if (payload.document && typeof payload.document === 'object') {
      const source = payload.document
      const rawText = typeof source.text === 'string' ? source.text : ''
      const truncated = rawText.length > MAX_MIRROR_CONTENT_CHARS
      instance.document = {
        path: typeof source.path === 'string' ? source.path : '',
        languageId: typeof source.languageId === 'string' ? source.languageId : '',
        version: Number.isInteger(source.version) ? source.version : 0,
        dirty: source.dirty === true,
        size: Number.isInteger(source.size) ? source.size : rawText.length,
        text: truncated ? '' : rawText,
        truncated,
        tooLarge: source.tooLarge === true,
        receivedAt: Date.now(),
      }
      if (!instance.activePath) instance.activePath = instance.document.path
    }
    if (payload.closed === true) {
      instance.document = null
      instance.activePath = ''
    }
    return { ok: true }
  }

  /** The most recently active instance, if any. */
  preferred() {
    let best
    for (const instance of this.instances.values()) {
      if (!best || instance.lastSeen > best.lastSeen) best = instance
    }
    return best
  }

  /** The browser-facing snapshot for one requested path. */
  snapshot(requestedPath) {
    const instance = this.preferred()
    if (!instance) {
      return { connected: false, instance: null, document: null, matching: false, instances: [] }
    }
    const document = instance.document
    const matching = Boolean(document && document.path && requestedPath && normalizePathKey(document.path) === normalizePathKey(requestedPath))
    return {
      connected: true,
      instance: {
        id: instance.id,
        editor: instance.editor,
        editorVersion: instance.editorVersion,
        activePath: instance.activePath,
        selection: instance.selection,
      },
      document: matching
        ? {
            path: document.path,
            languageId: document.languageId,
            version: document.version,
            dirty: document.dirty,
            size: document.size,
            truncated: document.truncated,
            tooLarge: document.tooLarge,
            text: document.text,
          }
        : null,
      matching,
      instances: [...this.instances.values()].map((entry) => ({ id: entry.id, editor: entry.editor, activePath: entry.activePath })),
    }
  }

  /** Queue one command for an instance (defaults to the preferred one). */
  enqueue(instanceId, command) {
    const instance = instanceId ? this.instances.get(String(instanceId)) : this.preferred()
    if (!instance) return { ok: false, error: 'no editor instance is connected' }
    const entry = { seq: instance.nextSeq, command: { ...command } }
    instance.nextSeq += 1
    instance.queue.push(entry)
    if (instance.queue.length > MAX_QUEUE_LENGTH) instance.queue.splice(0, instance.queue.length - MAX_QUEUE_LENGTH)
    return { ok: true, instanceId: instance.id, seq: entry.seq }
  }

  /** Drain the commands one extension has not received yet. */
  poll(instanceId, since) {
    const instance = this.instances.get(String(instanceId || ''))
    if (!instance) return { ok: false, error: 'unknown instance', commands: [], next: 0 }
    const from = Number.isFinite(Number(since)) ? Number(since) : 0
    const commands = instance.queue.filter((entry) => entry.seq > from).map((entry) => ({ seq: entry.seq, ...entry.command }))
    const next = commands.length > 0 ? commands[commands.length - 1].seq : from
    return { ok: true, commands, next }
  }
}
