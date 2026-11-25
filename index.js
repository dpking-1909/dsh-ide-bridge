/**
 * Host half of the IDE bridge.
 *
 * Serves authenticated routes on the API channel for the browser half:
 *   GET  /api/ide-bridge.editors          detected local editors
 *   POST /api/ide-bridge.open             open one workspace file at a line
 *   POST /api/ide-bridge.open-folder      open a directory (or a file's folder)
 *   GET  /api/ide-bridge.changes          changed files merged over recent turns
 *   POST /api/ide-bridge.save             write one file's edited text back to disk
 *   GET  /api/ide-bridge.mirror           the mirrored editor document
 *   POST /api/ide-bridge.mirror-command   queue one command for the editor
 *
 * It also hosts the editor-mirror bridge the VS Code / Cursor extension talks
 * to (`/ide-bridge/*`, loopback and token-guarded), and publishes the bridge
 * descriptor next to the DSH home directory.
 *
 * Nothing here talks to the model, and no shell is involved in launching an
 * editor: the argument list is passed to the process as an array. Writes go
 * through `ctx.fs` with the Session's resolved sandbox policy, so the same
 * read-only / workspace-write boundary that guards the agent's tools also
 * guards this route.
 */
import { statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { detectEditors, launchEditor, normalizeSpecs, resolveEditorById } from './editors.js'
import { MirrorHub, bridgeFilePath, createBridgeToken, hasBridgeToken, readRequestBody, sendJson } from './mirror.js'

const ROUTE_EDITORS = '/api/ide-bridge.editors'
const ROUTE_OPEN = '/api/ide-bridge.open'
const ROUTE_OPEN_FOLDER = '/api/ide-bridge.open-folder'
const ROUTE_CHANGES = '/api/ide-bridge.changes'
const ROUTE_SAVE = '/api/ide-bridge.save'
const ROUTE_MIRROR = '/api/ide-bridge.mirror'
const ROUTE_MIRROR_COMMAND = '/api/ide-bridge.mirror-command'
const MIRROR_PREFIX = '/ide-bridge'
const MAX_BRIDGE_BODY_BYTES = 8 * 1024 * 1024

/** Host services this plugin needs before it can activate. */
export const inject = ['connection', 'sessions', 'fs', 'sandboxPolicy', 'webServer']



/** Tools whose successful call names a file the agent changed. */
const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'multi_edit'])

/** A failure the route answers with a specific status. */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** ISO-ish error message for a response body. */
function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/** JSON response helper with no-store cache policy. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Wrap a route body with JSON error translation. */
function handle(run) {
  return async (request) => {
    try {
      return await run(request)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      return json({ error: messageOf(error) }, status)
    }
  }
}

/** Read one JSON object body. */
async function readJson(request) {
  let text
  try {
    text = await request.text()
  } catch {
    throw new HttpError(400, 'request body is not readable')
  }
  if (!text) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body is not JSON')
  }
  return value && typeof value === 'object' ? value : {}
}

/** Normalize one positive integer or return 0. */
function positiveInteger(value) {
  const number = typeof value === 'string' ? Number(value) : value
  return Number.isInteger(number) && number > 0 ? number : 0
}

/** Clamp an integer config value. */
function clampInteger(value, minimum, maximum, fallback) {
  const number = typeof value === 'string' ? Number(value) : value
  if (!Number.isInteger(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

/** Read the row config into the settings the routes use. */
function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    specs: normalizeSpecs(source.editors),
    defaultEditor: typeof source.defaultEditor === 'string' && source.defaultEditor ? source.defaultEditor : 'vscode',
    maxTurns: clampInteger(source.maxTurns, 1, 20, 5),
  }
}

/** The client-facing shape of one probed editor. */
function publicEditor(editor) {
  return { id: editor.id, label: editor.label, icon: editor.icon, available: editor.available === true }
}

/** Pick an available editor or answer 409. */
function pickEditor(editors, requestedId, fallbackId) {
  const editor = resolveEditorById(editors, requestedId, fallbackId)
  if (!editor) {
    throw new HttpError(
      409,
      'No local editor was detected. Start VS Code or Cursor once, or configure `editors` in the ide-bridge plugin config.',
    )
  }
  return editor
}

/** Resolve a request path to an absolute path, relative paths against the live session cwd. */
function resolveTarget(ctx, sessionId, inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) throw new HttpError(400, '`path` is required')
  const session = typeof sessionId === 'string' && sessionId ? ctx.sessions.get(sessionId) : undefined
  const cwd = session && session.header ? session.header.cwd : undefined
  if (isAbsolute(inputPath)) return inputPath
  if (!cwd) throw new HttpError(400, 'A relative path needs a live Session; pass an absolute path instead')
  return resolve(cwd, inputPath)
}

/** Stat one path, translating a missing target into 404. */
function statTarget(absolutePath) {
  try {
    return statSync(absolutePath)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      throw new HttpError(404, `Not found: ${absolutePath}`)
    }
    throw new HttpError(500, `Cannot stat ${absolutePath}: ${messageOf(error)}`)
  }
}

/** The live Session for a request, or undefined. */
function sessionOf(ctx, sessionId) {
  return typeof sessionId === 'string' && sessionId ? ctx.sessions.get(sessionId) : undefined
}

/** Translate one guarded-write failure into its HTTP status and client code. */
function writeFailure(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  if (code === 'FS_STALE_VERSION') return { status: 409, code: 'stale' }
  if (code === 'FS_SANDBOX_DENIED' || code === 'FS_PERMISSION_DENIED') return { status: 403, code: 'denied' }
  if (code === 'FS_NOT_FOUND') return { status: 404, code: 'not-found' }
  if (code === 'FS_NOT_REGULAR_FILE' || code === 'FS_NOT_TEXT' || code === 'FS_TOO_LARGE' || code === 'FS_ABORTED') {
    return { status: 400, code: 'write-failed' }
  }
  return { status: 500, code: 'write-failed' }
}

/** The plain-HTTP bridge the editor extension talks to (loopback, token guarded). */
function createMirrorHttpHandler(hub) {
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (!hasBridgeToken(req, url, hub.token)) {
        sendJson(res, 401, { error: 'missing or invalid bridge token' })
        return
      }
      if (req.method === 'GET' && url.pathname === `${MIRROR_PREFIX}/health`) {
        sendJson(res, 200, { ok: true, instances: hub.instances.size })
        return
      }
      if (req.method === 'GET' && url.pathname === `${MIRROR_PREFIX}/commands`) {
        sendJson(res, 200, hub.poll(url.searchParams.get('instanceId'), url.searchParams.get('since')))
        return
      }
      if (req.method === 'POST' && url.pathname === `${MIRROR_PREFIX}/push`) {
        const text = await readRequestBody(req, MAX_BRIDGE_BODY_BYTES)
        const payload = text ? JSON.parse(text) : {}
        sendJson(res, 200, hub.push(payload))
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 400, { error: messageOf(error) })
    }
  }
}



/** Normalize a path for duplicate detection. */
function pathKey(path) {
  const normalized = String(path).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Display one path relative to the Session working directory when it sits inside it. */
function displayPath(cwd, path) {
  if (typeof cwd !== 'string' || cwd.length === 0) return String(path)
  const normalizedRoot = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedPath = String(path).replace(/\\/g, '/')
  const caseInsensitive = process.platform === 'win32'
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath
  if (comparablePath === comparableRoot) return '.'
  if (comparablePath.startsWith(comparableRoot + '/')) return normalizedPath.slice(normalizedRoot.length + 1)
  return normalizedPath
}

/** Read one tool call's path argument. */
function pathArgument(rawArguments) {
  if (typeof rawArguments !== 'string') return undefined
  let parsed
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const value = parsed.file_path || parsed.path || parsed.filePath
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Files named by the most recent mutating tool calls, used when the Host keeps
 * no workspace/changes summaries (the Coding Tools preference is off).
 */
function deriveToolFiles(session, turns, cwd) {
  const files = []
  const seen = new Set()
  let turnsSeen = 0
  const lowestSeq = Math.max(1, Number(session.seq) - 20000)
  for (let seq = Number(session.seq) - 1; seq >= lowestSeq; seq -= 1) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'turn/start') {
      turnsSeen += 1
      if (turnsSeen > turns) break
      continue
    }
    if (event.type !== 'tool/call') continue
    const data = event.data
    if (!data || !MUTATING_TOOLS.has(String(data.name || ''))) continue
    const argumentPath = pathArgument(data.arguments)
    if (!argumentPath) continue
    const key = pathKey(argumentPath)
    if (seen.has(key)) continue
    seen.add(key)
    files.push({
      path: argumentPath,
      display: displayPath(cwd, argumentPath),
      added: 0,
      deleted: 0,
      turn: 0,
      seq: Number(event.seq),
      index: -1,
      source: 'tool',
    })
  }
  return files
}

/**
 * Merge the recorded changed-file summaries of the most recent turns.
 * @param ctx - Host context carrying `sessions` and the optional `workspaceChanges`.
 * @param session - the live Session whose changes are read.
 * @param turns - how many recent announcements to merge.
 * @returns the panel payload: merged files, plus whether the Host recorded them.
 */
function changedFiles(ctx, session, turns) {
  const sessionId = session.id
  const cwd = session && session.header ? session.header.cwd : undefined
  const workspaceChanges = ctx.get('workspaceChanges')
  const summaries = []
  const lowestSeq = Math.max(1, Number(session.seq) - 20000)
  for (let seq = Number(session.seq) - 1; seq >= lowestSeq && summaries.length < turns; seq -= 1) {
    const event = session.eventAt(seq)
    if (!event || event.type !== 'workspace/changes') continue
    const summary = workspaceChanges ? workspaceChanges.summary(sessionId, event.seq) : undefined
    if (!summary) continue
    summaries.push({ seq: Number(event.seq), summary })
  }
  const files = []
  const seen = new Set()
  for (const entry of summaries) {
    const summaryFiles = Array.isArray(entry.summary.files) ? entry.summary.files : []
    for (let index = 0; index < summaryFiles.length; index += 1) {
      const file = summaryFiles[index]
      if (!file || typeof file.path !== 'string' || file.path.length === 0) continue
      const key = pathKey(file.path)
      if (seen.has(key)) continue
      seen.add(key)
      files.push({
        path: file.path,
        display: typeof file.display === 'string' && file.display ? file.display : displayPath(cwd, file.path),
        added: Number.isInteger(file.added) ? file.added : 0,
        deleted: Number.isInteger(file.deleted) ? file.deleted : 0,
        binary: file.binary === true ? true : undefined,
        oversized: file.oversized === true ? true : undefined,
        turn: Number.isInteger(entry.summary.turn) ? entry.summary.turn : 0,
        seq: entry.seq,
        index,
        source: 'changes',
      })
    }
  }
  const recorded = summaries.length > 0
  const derived = recorded ? [] : deriveToolFiles(session, turns, cwd)
  const merged = recorded ? files : derived
  return {
    sessionId,
    cwd,
    recorded,
    turns: summaries.map((entry) => entry.summary.turn),
    files: merged,
    total: merged.length,
  }
}

/**
 * Register the IDE bridge routes for the caller's lifetime.
 * @param ctx - Host context with `connection`, `sessions`, and optional `workspaceChanges`.
 * @param config - the plugin row config (`defaultEditor`, `maxTurns`, `editors`).
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  let editorCache

  const currentEditors = (force) => {
    if (!editorCache || force) editorCache = detectEditors(settings.specs)
    return editorCache
  }

  const hub = new MirrorHub({ origin: '', token: createBridgeToken(), bridgeFile: bridgeFilePath() })
  ctx.effect(() => {
    let stopped = false
    let attempts = 0
    const start = () => {
      if (stopped) return
      try {
        hub.origin = ctx.webServer.getOrigin()
        hub.start()
      } catch {
        attempts += 1
        if (attempts < 100) setTimeout(start, 200)
      }
    }
    start()
    return () => {
      stopped = true
      hub.dispose()
    }
  }, 'ide-bridge: mirror hub')
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: MIRROR_PREFIX, handler: createMirrorHttpHandler(hub) }),
    'ide-bridge: mirror bridge routes',
  )

  ctx.connection.fetch.register({
    path: ROUTE_EDITORS,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: handle(async (request) => {
      const url = new URL(request.url)
      const editors = currentEditors(url.searchParams.get('refresh') === '1')
      return json({ editors: editors.map(publicEditor), defaultEditor: settings.defaultEditor })
    }),
  })

  ctx.connection.fetch.register({
    path: ROUTE_OPEN,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handle(async (request) => {
      const body = await readJson(request)
      const editor = pickEditor(currentEditors(false), body.editorId, settings.defaultEditor)
      const absolutePath = resolveTarget(ctx, body.sessionId, body.path)
      const info = statTarget(absolutePath)
      if (!info.isFile()) throw new HttpError(400, `Not a regular file: ${absolutePath}`)
      const line = positiveInteger(body.line)
      const column = positiveInteger(body.column)
      await launchEditor(editor, { file: absolutePath, line, column })
      return json({ ok: true, editor: editor.id, path: absolutePath, line })
    }),
  })

  ctx.connection.fetch.register({
    path: ROUTE_OPEN_FOLDER,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handle(async (request) => {
      const body = await readJson(request)
      const editor = pickEditor(currentEditors(false), body.editorId, settings.defaultEditor)
      const absolutePath = resolveTarget(ctx, body.sessionId, body.path)
      const info = statTarget(absolutePath)
      const folder = info.isDirectory() ? absolutePath : dirname(absolutePath)
      await launchEditor(editor, { folder })
      return json({ ok: true, editor: editor.id, path: folder })
    }),
  })

  ctx.connection.fetch.register({
    path: ROUTE_SAVE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handle(async (request) => {
      const body = await readJson(request)
      if (typeof body.content !== 'string') throw new HttpError(400, '`content` must be a string')
      const absolutePath = resolveTarget(ctx, body.sessionId, body.path)
      const info = statTarget(absolutePath)
      if (!info.isFile()) throw new HttpError(400, `Not a regular file: ${absolutePath}`)
      const session = sessionOf(ctx, body.sessionId)
      const cwd = session && session.header ? session.header.cwd : undefined
      const target = await ctx.fs.resolve(absolutePath, cwd ? { cwd, signal: request.signal } : { signal: request.signal })
      const force = body.force === true
      const baseVersion = typeof body.baseVersion === 'string' && body.baseVersion ? body.baseVersion : ''
      const intent = !force && baseVersion ? { kind: 'replaceIfVersion', version: baseVersion } : undefined
      let policy
      try {
        policy = ctx.sandboxPolicy.resolve({ session })
      } catch {
        policy = undefined
      }
      let outcome
      try {
        outcome = await ctx.fs.writeText(target, body.content, intent, request.signal, policy)
      } catch (error) {
        const failure = writeFailure(error)
        return json({ error: messageOf(error), code: failure.code }, failure.status)
      }
      const resolved = typeof ctx.fs.processPath === 'function' ? ctx.fs.processPath(target) : absolutePath
      return json({ ok: true, path: resolved, version: String(outcome.version), operation: outcome.operation })
    }),
  })

  ctx.connection.fetch.register({
    path: ROUTE_MIRROR,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: handle(async (request) => {
      const url = new URL(request.url)
      const requestedPath = url.searchParams.get('path') || ''
      const requestedSession = sessionOf(ctx, url.searchParams.get('sessionId'))
      const cwd = requestedSession && requestedSession.header ? requestedSession.header.cwd : undefined
      // File addresses carry workspace-relative paths while the editor pushes
      // absolute ones; resolve the requested path before comparing identities.
      const resolvedPath = requestedPath && !isAbsolute(requestedPath) && cwd ? resolve(cwd, requestedPath) : requestedPath
      return json(hub.snapshot(resolvedPath))
    }),
  })

  ctx.connection.fetch.register({
    path: ROUTE_MIRROR_COMMAND,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handle(async (request) => {
      const body = await readJson(request)
      const sourceCommand = body.command && typeof body.command === 'object' ? body.command : undefined
      if (!sourceCommand || typeof sourceCommand.type !== 'string' || sourceCommand.type.length === 0) {
        throw new HttpError(400, '`command` with a `type` is required')
      }
      // Commands target editor documents by absolute path, so resolve the
      // workspace-relative path the browser address carried.
      let command = { ...sourceCommand }
      if (typeof command.path === 'string' && command.path && !isAbsolute(command.path)) {
        const commandSession = sessionOf(ctx, body.sessionId)
        const commandCwd = commandSession && commandSession.header ? commandSession.header.cwd : undefined
        if (commandCwd) command = { ...command, path: resolve(commandCwd, command.path) }
      }
      const result = hub.enqueue(typeof body.instanceId === 'string' ? body.instanceId : '', command)
      if (!result.ok) throw new HttpError(409, result.error)
      return json(result)
    }),
  })

  ctx.connection.fetch.register({
    path: ROUTE_CHANGES,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: handle(async (request) => {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('sessionId')
      const session = typeof sessionId === 'string' && sessionId ? ctx.sessions.get(sessionId) : undefined
      if (!session) throw new HttpError(404, 'The Session is not live; reopen it and retry')
      const turns = clampInteger(url.searchParams.get('turns'), 1, 20, settings.maxTurns)
      return json(changedFiles(ctx, session, turns))
    }),
  })
}
