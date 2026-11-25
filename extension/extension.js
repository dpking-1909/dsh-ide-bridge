'use strict'

/**
 * DSH IDE Mirror extension.
 *
 * Pushes the active editor document to the local DeepSeek Harness bridge and
 * applies the commands the Harness right-sidebar mirror queues: open a file at
 * a line, replace the document text, and save. The bridge descriptor (URL and
 * token) is written by the DSH plugin to `~/.dsh/cache/ide-bridge/bridge.json`
 * and re-read whenever the connection is lost.
 */
const vscode = require('vscode')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const POLL_INTERVAL_MS = 350
const RECONNECT_INTERVAL_MS = 3000
const MAX_PUSH_CHARS = 1500000
const REQUEST_TIMEOUT_MS = 4000

const state = {
  instanceId: randomId(),
  bridge: null,
  connected: false,
  editorKind: 'vscode',
  editorVersion: '',
  since: 0,
  disposed: false,
  pollTimer: undefined,
  pushTimer: undefined,
  statusItem: undefined,
  activePath: '',
}

/** One opaque instance identity for this editor window. */
function randomId() {
  try {
    return require('node:crypto').randomUUID()
  } catch {
    return `ext-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

/** The editor flavor reported to the browser half. */
function editorKind() {
  const name = String(vscode.env.appName || '')
  if (/cursor/i.test(name)) return 'cursor'
  if (/insiders/i.test(name)) return 'vscode-insiders'
  return 'vscode'
}

/** The bridge descriptor path, honoring the user setting. */
function bridgeFile() {
  const configured = vscode.workspace.getConfiguration('dshMirror').get('bridgeFile')
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  return path.join(os.homedir(), '.dsh', 'cache', 'ide-bridge', 'bridge.json')
}

/** Read the descriptor DSH publishes, or undefined. */
function readBridge() {
  try {
    const parsed = JSON.parse(fs.readFileSync(bridgeFile(), 'utf8'))
    if (!parsed || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return undefined
    return { url: parsed.url.replace(/\/+$/, ''), token: parsed.token }
  } catch {
    return undefined
  }
}

/** POST/GET one JSON request against the loopback bridge. */
function requestJson(method, urlString, body, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(urlString)
    } catch (error) {
      reject(error)
      return
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = { accept: 'application/json' }
    if (token) headers['x-dsh-token'] = token
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: timeoutMs || REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              resolve(text ? JSON.parse(text) : {})
            } catch {
              resolve({})
            }
          } else {
            reject(new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`))
          }
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error('bridge request timed out')))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

/** The document payload pushed to the mirror. */
function documentPayload(document) {
  const text = document.getText()
  const tooLarge = text.length > MAX_PUSH_CHARS
  return {
    path: document.uri.fsPath,
    languageId: document.languageId,
    version: document.version,
    dirty: document.isDirty,
    size: text.length,
    text: tooLarge ? '' : text,
    tooLarge,
  }
}

/** Send one push message; a failed push marks the bridge disconnected. */
function push(payload) {
  if (!state.bridge || !state.connected) return Promise.resolve()
  const message = { ...payload, instanceId: state.instanceId, editor: state.editorKind, editorVersion: state.editorVersion }
  return requestJson('POST', `${state.bridge.url}/ide-bridge/push`, message, state.bridge.token).catch(() => {
    markDisconnected()
  })
}

/** Push the active editor document, or an empty active path. */
function pushActive() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    state.activePath = ''
    push({ type: 'active', activePath: '', document: null })
    return
  }
  const position = editor.selection.active
  state.activePath = editor.document.uri.fsPath
  push({
    type: 'document',
    activePath: editor.document.uri.fsPath,
    selection: { line: position.line + 1, character: position.character + 1 },
    document: documentPayload(editor.document),
  })
}

/** Debounce a push so typing does not flood the bridge. */
function schedulePush(delay) {
  if (state.disposed) return
  if (state.pushTimer) clearTimeout(state.pushTimer)
  state.pushTimer = setTimeout(() => {
    state.pushTimer = undefined
    pushActive()
  }, typeof delay === 'number' ? delay : 90)
}

/** Update the status bar item. */
function updateStatus() {
  if (!state.statusItem) return
  if (state.connected) {
    state.statusItem.text = '$(radio-tower) DSH 镜像'
    state.statusItem.tooltip = '已连接到 DSH 右侧栏镜像；点击查看状态'
  } else {
    state.statusItem.text = '$(debug-disconnect) DSH 镜像'
    state.statusItem.tooltip = '未连接到 DSH，后台重试中；点击重试'
  }
  state.statusItem.show()
}

/** Stop polling and retry the connection after the bridge descriptor appears. */
function markDisconnected() {
  state.connected = false
  state.bridge = undefined
  updateStatus()
  if (state.pollTimer) clearTimeout(state.pollTimer)
  state.pollTimer = setTimeout(connect, RECONNECT_INTERVAL_MS)
}

/** Find or open one document by path. */
async function findDocument(filePath) {
  const normalized = path.normalize(String(filePath))
  const open = vscode.workspace.textDocuments.find((document) => path.normalize(document.uri.fsPath) === normalized)
  if (open) return open
  return vscode.workspace.openTextDocument(vscode.Uri.file(normalized))
}

/** Show one file, optionally revealing a 1-based line. */
async function openFile(filePath, line, preserveFocus) {
  const document = await findDocument(filePath)
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: preserveFocus === true })
  if (Number.isInteger(line) && line > 0) {
    const position = new vscode.Position(Math.max(0, line - 1), 0)
    editor.selection = new vscode.Selection(position, position)
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
  }
  schedulePush(0)
}

/** Replace the whole document with the mirrored text. */
async function applyEdit(command) {
  if (typeof command.text !== 'string') return
  const document = await findDocument(command.path)
  if (typeof command.expectedVersion === 'number' && command.force !== true && document.version !== command.expectedVersion) {
    push({ type: 'document', activePath: document.uri.fsPath, document: documentPayload(document), rejectedEdit: true })
    return
  }
  if (document.getText() === command.text) {
    schedulePush(0)
    return
  }
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true })
  const last = document.positionAt(document.getText().length)
  const fullRange = new vscode.Range(document.positionAt(0), last)
  await editor.edit((builder) => builder.replace(fullRange, command.text), { undoStopBefore: false, undoStopAfter: false })
  schedulePush(0)
}

/** Save one document through the editor. */
async function saveDocument(filePath) {
  const document = await findDocument(filePath)
  await document.save()
  push({ type: 'document', activePath: document.uri.fsPath, document: documentPayload(document), saved: true })
}

/** Execute one command queued by the Harness. */
async function execute(command) {
  if (!command || typeof command.type !== 'string') return
  if (command.type === 'ping') return
  try {
    if (command.type === 'open') {
      await openFile(command.path, command.line, command.preserveFocus)
      return
    }
    if (command.type === 'edit') {
      await applyEdit(command)
      return
    }
    if (command.type === 'save') {
      await saveDocument(command.path)
    }
  } catch (error) {
    push({ type: 'notice', level: 'error', message: String((error && error.message) || error) })
  }
}

/** Drain queued commands, then poll again. */
async function pollLoop() {
  if (state.disposed) return
  if (!state.bridge || !state.connected) {
    markDisconnected()
    return
  }
  try {
    const query = new URLSearchParams({ instanceId: state.instanceId, since: String(state.since) })
    const response = await requestJson('GET', `${state.bridge.url}/ide-bridge/commands?${query.toString()}`, undefined, state.bridge.token)
    if (!response || response.ok === false) throw new Error('bridge rejected the instance')
    if (Number.isInteger(response.next) && response.next >= state.since) state.since = response.next
    for (const command of Array.isArray(response.commands) ? response.commands : []) await execute(command)
    updateStatus()
    state.pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS)
  } catch {
    markDisconnected()
  }
}

/** Connect to the bridge descriptor and start polling. */
async function connect() {
  if (state.disposed) return
  state.bridge = readBridge()
  if (!state.bridge) {
    updateStatus()
    state.pollTimer = setTimeout(connect, RECONNECT_INTERVAL_MS)
    return
  }
  try {
    await requestJson('GET', `${state.bridge.url}/ide-bridge/health`, undefined, state.bridge.token, 3000)
    state.connected = true
    state.since = 0
    await push({ type: 'hello' })
    pushActive()
    updateStatus()
    pollLoop()
  } catch {
    markDisconnected()
  }
}

/** Register the editor events that feed the mirror. */
function registerEvents(context) {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => schedulePush(0)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor
      if (editor && event.document === editor.document) schedulePush(90)
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor) schedulePush(150)
    }),
    vscode.workspace.onDidSaveTextDocument(() => schedulePush(0)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.fsPath === state.activePath) schedulePush(0)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dshMirror')) {
        state.bridge = undefined
        state.connected = false
        if (state.pollTimer) clearTimeout(state.pollTimer)
        connect()
      }
    }),
  )
}

/**
 * Extension entry point.
 * @param {import('vscode').ExtensionContext} context - the extension context.
 */
function activate(context) {
  if (vscode.workspace.getConfiguration('dshMirror').get('enabled') === false) return
  state.editorKind = editorKind()
  state.editorVersion = String(vscode.version || '')
  state.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98)
  state.statusItem.command = 'dshMirror.status'
  context.subscriptions.push(state.statusItem)
  context.subscriptions.push({
    dispose() {
      state.disposed = true
      if (state.pollTimer) clearTimeout(state.pollTimer)
      if (state.pushTimer) clearTimeout(state.pushTimer)
    },
  })
  context.subscriptions.push(
    vscode.commands.registerCommand('dshMirror.reconnect', () => {
      state.bridge = undefined
      state.connected = false
      if (state.pollTimer) clearTimeout(state.pollTimer)
      connect()
    }),
    vscode.commands.registerCommand('dshMirror.status', () => {
      vscode.window.showInformationMessage(`DSH 镜像：${state.connected ? '已连接' : '未连接'}（${state.editorKind} ${state.editorVersion}）`)
    }),
  )
  registerEvents(context)
  updateStatus()
  connect()
}

/** Extension teardown. */
function deactivate() {
  state.disposed = true
  if (state.pollTimer) clearTimeout(state.pollTimer)
  if (state.pushTimer) clearTimeout(state.pushTimer)
  if (state.statusItem) state.statusItem.dispose()
}

module.exports = { activate, deactivate }
