/**
 * Local editor discovery and shell-free launch for the IDE bridge plugin.
 *
 * Editors are resolved through their official CLI wrapper (`code.cmd` /
 * `cursor.cmd` on Windows, `code` / `cursor` on POSIX), because that wrapper
 * names both the executable and its `cli.js`. The launch reproduces what the
 * wrapper does — `ELECTRON_RUN_AS_NODE=1 <exe> <cli.js> --goto <file>:<line>:<col>`
 * — with an argv array, so no shell ever parses a path.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
const PATH_SEPARATOR = IS_WINDOWS ? ';' : ':'

/** Build a path from one environment variable, or undefined when it is unset. */
function envPath(name, ...segments) {
  const base = process.env[name]
  return base ? join(base, ...segments) : undefined
}

/** The editors probed when the plugin config names none. */
const DEFAULT_SPECS = [
  {
    id: 'vscode',
    label: 'VS Code',
    icon: 'code',
    cli: 'code',
    appPath: 'Code.exe',
    args: ['--goto', '{file}:{line}:{column}', '--reuse-window'],
    candidates: [
      () => envPath('LOCALAPPDATA', 'Programs', 'Microsoft VS Code', 'Code.exe'),
      () => envPath('ProgramFiles', 'Microsoft VS Code', 'Code.exe'),
      () => envPath('ProgramW6432', 'Microsoft VS Code', 'Code.exe'),
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    icon: 'cursor',
    cli: 'cursor',
    appPath: 'Cursor.exe',
    args: ['--goto', '{file}:{line}:{column}', '--reuse-window'],
    candidates: [
      () => envPath('LOCALAPPDATA', 'Programs', 'cursor', 'Cursor.exe'),
      () => envPath('LOCALAPPDATA', 'Programs', 'Cursor', 'Cursor.exe'),
    ],
  },
]

/** Whether a path exists and is a regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The live PATH directories, in search order. */
function searchDirectories() {
  const raw = process.env.PATH || process.env.Path || ''
  return raw
    .split(PATH_SEPARATOR)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
}

/** Find a CLI name in the live PATH; the Windows wrapper (.cmd) wins over a bare exe. */
function findOnPath(cli) {
  const extensions = IS_WINDOWS ? ['.cmd', '.exe', ''] : ['']
  for (const directory of searchDirectories()) {
    for (const extension of extensions) {
      const candidate = join(directory, cli + extension)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Read a Windows CLI wrapper and recover the executable and `cli.js` it runs.
 * @param wrapper - absolute wrapper path such as `...\bin\code.cmd`.
 * @returns the resolved pair, or undefined when the file is not a recognized wrapper.
 */
function readCliWrapper(wrapper) {
  let text
  try {
    text = readFileSync(wrapper, 'utf8')
  } catch {
    return undefined
  }
  if (!text.includes('%~dp0')) return undefined
  const wrapperDirectory = dirname(wrapper) + sep
  const tokens = Array.from(text.matchAll(/"([^"]+)"/g), (match) => match[1])
  let executable
  let cliJs
  for (const token of tokens) {
    if (!/%~dp0/i.test(token)) continue
    const absolute = resolve(token.replace(/%~dp0/gi, wrapperDirectory))
    if (!existsSync(absolute)) continue
    if (/\.exe$/i.test(absolute)) executable = executable || absolute
    else if (/cli\.js$/i.test(absolute)) cliJs = cliJs || absolute
  }
  return executable ? { executable, cliJs } : undefined
}

/** Read the Windows `App Paths` registration for one executable. */
function readWindowsAppPath(executableName) {
  if (!IS_WINDOWS || !executableName) return undefined
  for (const root of ['HKCU', 'HKLM']) {
    const key = `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executableName}`
    try {
      const output = execFileSync('reg', ['query', key, '/ve'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const match = /REG_SZ\s+(.+)/.exec(output)
      if (!match) continue
      const path = match[1].trim().replace(/^"|"$/g, '')
      if (isFile(path)) return path
    } catch {
      /* the key is absent or unreadable */
    }
  }
  return undefined
}

/**
 * Probe one editor spec.
 * @param spec - normalized editor spec.
 * @returns the editor record the routes serve.
 */
function probeEditor(spec) {
  const base = {
    id: spec.id,
    label: spec.label,
    icon: spec.icon || 'code',
    available: false,
    mode: undefined,
    executable: undefined,
    cliJs: undefined,
    command: undefined,
    args: spec.args,
    folderArgs: spec.folderArgs,
  }
  if (spec.exe && isFile(spec.exe)) {
    const withCli = spec.cliJs && isFile(spec.cliJs)
    return { ...base, available: true, mode: withCli ? 'cli' : 'exe', executable: spec.exe, cliJs: withCli ? spec.cliJs : undefined }
  }
  const found = typeof spec.cli === 'string' && spec.cli ? findOnPath(spec.cli) : undefined
  if (found) {
    if (IS_WINDOWS && /\.(cmd|bat)$/i.test(found)) {
      const parsed = readCliWrapper(found)
      if (parsed && parsed.executable && parsed.cliJs) {
        return { ...base, available: true, mode: 'cli', executable: parsed.executable, cliJs: parsed.cliJs, wrapper: found }
      }
      if (parsed && parsed.executable) {
        return { ...base, available: true, mode: 'exe', executable: parsed.executable, wrapper: found }
      }
    } else if (IS_WINDOWS && /\.exe$/i.test(found)) {
      return { ...base, available: true, mode: 'exe', executable: found }
    } else if (!IS_WINDOWS) {
      return { ...base, available: true, mode: 'command', command: found }
    }
  }
  const appPath = readWindowsAppPath(spec.appPath)
  if (appPath) return { ...base, available: true, mode: 'exe', executable: appPath }
  for (const candidate of spec.candidates || []) {
    const path = typeof candidate === 'function' ? candidate() : candidate
    if (path && isFile(path)) return { ...base, available: true, mode: 'exe', executable: path }
  }
  return base
}

/**
 * Normalize configured editor specs; the caller's list replaces the built-ins.
 * @param specs - raw `editors` config entries, or undefined for the built-ins.
 * @returns normalized specs.
 */
export function normalizeSpecs(specs) {
  const source = Array.isArray(specs) && specs.length > 0 ? specs : DEFAULT_SPECS
  return source.map((entry, index) => {
    const record = entry && typeof entry === 'object' ? entry : {}
    const id = typeof record.id === 'string' && record.id ? record.id : `editor-${index + 1}`
    return {
      id,
      label: typeof record.label === 'string' && record.label ? record.label : id,
      icon: typeof record.icon === 'string' ? record.icon : 'code',
      cli: typeof record.cli === 'string' ? record.cli : id,
      exe: typeof record.exe === 'string' ? record.exe : undefined,
      cliJs: typeof record.cliJs === 'string' ? record.cliJs : undefined,
      appPath: typeof record.appPath === 'string' ? record.appPath : undefined,
      args: Array.isArray(record.args) ? record.args.map(String) : DEFAULT_SPECS[0].args,
      folderArgs: Array.isArray(record.folderArgs) ? record.folderArgs.map(String) : undefined,
      candidates: Array.isArray(record.candidates) ? record.candidates.filter((value) => typeof value === 'string') : [],
    }
  })
}

/** Probe every spec, caching nothing; the caller owns the cache. */
export function detectEditors(specs) {
  return normalizeSpecs(specs).map(probeEditor)
}

/** Pick one available editor by id, falling back to the configured id then the first available. */
export function resolveEditorById(editors, requestedId, fallbackId) {
  const available = editors.filter((editor) => editor.available)
  if (available.length === 0) return undefined
  const byRequest = typeof requestedId === 'string' && requestedId ? available.find((editor) => editor.id === requestedId) : undefined
  if (byRequest) return byRequest
  const byFallback = typeof fallbackId === 'string' && fallbackId ? available.find((editor) => editor.id === fallbackId) : undefined
  return byFallback || available[0]
}

/** Expand `{file}`, `{line}`, `{column}` and `{folder}` placeholders in one argument list. */
function expandTemplate(template, values) {
  return template.map((argument) => String(argument).replace(/\{(file|line|column|folder)\}/g, (_, key) => (values[key] === undefined ? '' : String(values[key]))))
}

/** Build the argument list for one launch target. */
function buildArguments(editor, target) {
  if (target.folder) {
    const template = Array.isArray(editor.folderArgs) && editor.folderArgs.length > 0 ? editor.folderArgs : ['--reuse-window', '{folder}']
    return expandTemplate(template, { folder: target.folder })
  }
  const line = Number.isInteger(target.line) && target.line > 0 ? target.line : 0
  if (line === 0) {
    const template = Array.isArray(editor.args) && editor.args.length > 0 ? editor.args : ['--reuse-window', '{file}']
    return expandTemplate(template, { file: target.file })
  }
  const template = Array.isArray(editor.args) && editor.args.length > 0 ? editor.args : ['--goto', '{file}:{line}:{column}', '--reuse-window']
  return expandTemplate(template, {
    file: target.file,
    line,
    column: Number.isInteger(target.column) && target.column > 0 ? target.column : 1,
  })
}

/**
 * Launch one editor process detached, without a shell.
 * @param editor - the probed editor.
 * @param target - `{ file, line, column }` for a file, or `{ folder }` for a directory.
 * @returns resolves once the process spawned; rejects when spawning failed.
 */
export function launchEditor(editor, target) {
  if (!editor || !editor.available) return Promise.reject(new Error('editor is not available'))
  const args = buildArguments(editor, target)
  const env = { ...process.env }
  let command
  let argv
  if (editor.mode === 'cli') {
    command = editor.executable
    argv = [editor.cliJs, ...args]
    env.ELECTRON_RUN_AS_NODE = '1'
    env.VSCODE_DEV = ''
  } else if (editor.mode === 'command') {
    command = editor.command
    argv = args
  } else {
    command = editor.executable
    argv = args
  }
  return new Promise((settle, fail) => {
    let done = false
    let child
    try {
      child = spawn(command, argv, { env, detached: true, stdio: 'ignore', windowsHide: true })
    } catch (error) {
      fail(error)
      return
    }
    child.once('spawn', () => {
      if (done) return
      done = true
      try {
        child.unref()
      } catch {
        /* already gone */
      }
      settle()
    })
    child.once('error', (error) => {
      if (done) return
      done = true
      fail(error)
    })
  })
}
