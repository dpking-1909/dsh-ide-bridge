/**
 * Browser half of the IDE bridge.
 *
 * Registers one right-Sidebar tab type that edits workspace code files in
 * place, plus a changed-files panel and three small action contributions:
 *
 *   - `ide-open`: claims workspace file addresses (extension priority) and
 *     renders an in-place code editor with a top toolbar carrying the local
 *     VS Code / Cursor buttons and Ctrl+S saving through the Host.
 *   - `ide-changes`: the changed-files panel that merges the last few turns.
 *   - document-preview header / unpreviewable / files-tree header buttons.
 *
 * It never imports another Harness Client package: slots, the tab registry,
 * the file Remote and locale copy arrive as Cordis services, and everything is
 * plain React.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ide-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** This plugin's copy namespace. */
    const NS = 'ideBridge'
    /** Composed resource addresses always start here. */
    const FILE_PREFIX = 'dsh-resource://file/'
    /** Where the last used external editor is remembered. */
    const EDITOR_STORAGE_KEY = 'dsh.ide-bridge.editor'
    /** The in-place editor tab type: one tab per opened workspace file. */
    const CODE_ID = 'dsh-ide-bridge/open'
    const CODE_KIND = 'ide-open'
    /** The changed-files page type. */
    const CHANGES_ID = 'dsh-ide-bridge/changes'
    const CHANGES_KIND = 'ide-changes'
    /** How many recent turns the panel merges. */
    const MAX_TURNS = 5
    /** Host routes served by the node half. */
    const ROUTE_EDITORS = '/api/ide-bridge.editors'
    const ROUTE_OPEN = '/api/ide-bridge.open'
    const ROUTE_OPEN_FOLDER = '/api/ide-bridge.open-folder'
    const ROUTE_CHANGES = '/api/ide-bridge.changes'
    const ROUTE_MIRROR = '/api/ide-bridge.mirror'
    const ROUTE_MIRROR_COMMAND = '/api/ide-bridge.mirror-command'
    const ROUTE_CHANGES_DIFF = '/api/changes.diff'
    /** Files above this size or line count lose syntax colouring. */
    const HIGHLIGHT_MAX_CHARS = 200000
    const HIGHLIGHT_MAX_LINES = 4000
    /** Line height shared by the gutter, the highlight layer and the input. */
    const LINE_HEIGHT = 20
    /** Extensions whose files are edited in place instead of previewed. */
    const CODE_EXTENSIONS = new Set([
      '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
      '.py', '.pyw', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift',
      '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.php', '.scala',
      '.lua', '.dart', '.ex', '.exs', '.erl', '.clj', '.fs', '.fsx', '.pl',
      '.vue', '.svelte', '.astro',
      '.json', '.jsonc', '.json5', '.css', '.scss', '.sass', '.less', '.styl',
      '.html', '.htm', '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg',
      '.properties', '.gradle', '.groovy', '.sh', '.bash', '.zsh', '.fish',
      '.ps1', '.psm1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.proto',
      '.mk', '.cmake', '.tex', '.r', '.jl', '.sol', '.zig', '.nim', '.v', '.sv',
      '.vhd', '.tcl', '.ahk', '.env',
    ])
    /** Extensionless code files that are still edited in place. */
    const CODE_NAMES = new Set(['dockerfile', 'makefile', 'cmakelists.txt', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.prettierrc', '.eslintrc'])

    /** C-family keyword set (JS/TS and friends). */
    const C_LIKE_KEYWORDS = new Set([
      'abstract', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
      'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
      'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
      'instanceof', 'interface', 'keyof', 'let', 'namespace', 'new', 'of', 'package',
      'private', 'protected', 'public', 'readonly', 'return', 'satisfies', 'set', 'static',
      'super', 'switch', 'this', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while',
      'with', 'yield', 'as', 'fn', 'impl', 'struct', 'trait', 'mut', 'pub', 'use', 'mod',
      'where', 'match', 'loop', 'unsafe', 'extern', 'crate', 'self', 'Self', 'dyn', 'move',
      'func', 'go', 'defer', 'chan', 'select', 'range', 'map', 'int', 'string', 'bool',
      'byte', 'error', 'nil', 'true', 'false', 'null', 'undefined', 'this',
    ])
    /** Python keyword set. */
    const PY_KEYWORDS = new Set([
      'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
      'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
      'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while',
      'with', 'yield', 'match', 'case', 'None', 'True', 'False', 'self', 'cls',
    ])
    /** Shell / PowerShell keyword set. */
    const SHELL_KEYWORDS = new Set([
      'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case',
      'esac', 'function', 'return', 'exit', 'export', 'local', 'readonly', 'declare', 'set',
      'unset', 'shift', 'source', 'alias', 'echo', 'printf', 'cd', 'pwd', 'test', 'read',
      'param', 'begin', 'process', 'end', 'try', 'catch', 'finally', 'throw', 'foreach',
      'switch', 'break', 'continue', 'where', 'filter', 'in', 'not', 'and', 'or',
    ])
    /** SQL keyword set. */
    const SQL_KEYWORDS = new Set([
      'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
      'create', 'table', 'alter', 'drop', 'index', 'view', 'join', 'left', 'right',
      'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset',
      'distinct', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'exists', 'between',
      'like', 'case', 'when', 'then', 'else', 'end', 'union', 'all', 'primary', 'key',
      'foreign', 'references', 'default', 'constraint', 'unique', 'transaction', 'commit',
      'rollback', 'begin', 'with', 'asc', 'desc',
    ])

    /** Tokenizer spec per language family. */
    const LANGUAGE_SPECS = {
      clike: { keywords: C_LIKE_KEYWORDS, lineComments: ['//'], blockCommentStart: '/*', blockCommentEnd: '*/', quotes: ['"', "'", '`'] },
      hash: { keywords: PY_KEYWORDS, lineComments: ['#'], quotes: ['"', "'"] },
      shell: { keywords: SHELL_KEYWORDS, lineComments: ['#'], quotes: ['"', "'", '`'] },
      config: { keywords: new Set(), lineComments: ['#', ';'], quotes: ['"', "'"] },
      css: { keywords: new Set(), lineComments: [], blockCommentStart: '/*', blockCommentEnd: '*/', quotes: ['"', "'"] },
      markup: { keywords: new Set(), lineComments: [], blockCommentStart: '<!--', blockCommentEnd: '-->', quotes: ['"', "'"] },
      sql: { keywords: SQL_KEYWORDS, lineComments: ['--'], blockCommentStart: '/*', blockCommentEnd: '*/', quotes: ["'", '"'], caseInsensitive: true },
    }

    /** Map one file path to a tokenizer family. */
    function languageOf(path) {
      const extension = extensionOf(path || '')
      if (['.sql'].includes(extension)) return 'sql'
      if (['.py', '.pyw', '.rb', '.ex', '.exs', '.jl', '.r', '.pl', '.pm'].includes(extension)) return 'hash'
      if (['.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd'].includes(extension)) return 'shell'
      if (['.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.properties', '.env', '.mk'].includes(extension)) return 'config'
      if (['.css', '.scss', '.sass', '.less', '.styl'].includes(extension)) return 'css'
      if (['.html', '.htm', '.xml', '.svg', '.vue', '.svelte', '.astro'].includes(extension)) return 'markup'
      if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.json5', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.go', '.rs', '.php', '.scala', '.dart', '.sol', '.zig', '.fs', '.fsx'].includes(extension)) return 'clike'
      return 'plain'
    }

    const ZH = {
      'action.openIn': '在 {name} 中打开',
      'action.openFolder': '在 {name} 中打开此目录',
      'editor.loading': '正在连接编辑器镜像…',
      'editor.unsupported': '这个地址不是工作区文件，无法在右侧镜像',
      'editor.unavailableDisconnected': '未连接编辑器。请在 VS Code / Cursor 中确认 DSH 镜像扩展已启用，然后重试。',
      'editor.unavailableElsewhere': '编辑器当前打开的是 {path}。',
      'editor.tooLarge': '文件较大，镜像只同步元数据；请在编辑器中编辑。',
      'editor.openInEditor': '在编辑器中打开此文件',
      'editor.previewOnly': '只读预览',
      'editor.retry': '重试',
      'editor.aria': '代码编辑区',
      'editor.save': '保存',
      'editor.saving': '保存中…',
      'editor.saved': '已请求编辑器保存',
      'editor.reload': '重新载入',
      'editor.dirty': '有未保存的修改',
      'editor.mirrorBadge': '{name} 镜像',
      'editor.mirrorConflict': '编辑器里的内容已被修改。',
      'editor.mirrorTakeRemote': '以编辑器为准',
      'editor.mirrorOverwrite': '用侧栏内容覆盖编辑器',
      'editor.mirrorLocate': '在编辑器中定位',
      'editor.saveFailed': '同步失败：{message}',
      'editor.readFailed': '操作失败：{message}',
      'editor.cursor': '行 {line}，列 {column}',
      'editor.lines': '{count} 行',
      'editor.hint': '在侧栏编辑会写回编辑器缓冲区；Ctrl+S 让编辑器保存',
      'editor.modeIdle': '未连接',
      'changes.title': '变更文件',
      'changes.description': '最近几轮改过的文件，点击在右侧编辑',
      'changes.refresh': '刷新',
      'changes.loading': '正在读取变更记录…',
      'changes.failed': '读取失败：{message}',
      'changes.retry': '重试',
      'changes.empty': '最近几轮没有记录到文件变更',
      'changes.emptyHint': '可以先从右侧「文件」标签打开文件；或让助手改一次文件后再刷新。',
      'changes.notRecorded': '本会话没有变更快照（Coding Tools 的变更记录未启用），以下列表来自 write / edit 工具调用。',
      'changes.openFolder': '打开工作区目录',
      'changes.openAt': '在右侧打开 {path}',
      'changes.preview': '只读预览',
      'changes.binary': '二进制',
      'changes.oversized': '过大',
      'changes.turn': '第 {turn} 轮',
      'changes.foot': '共 {count} 个文件（最近几轮合并）',
      'changes.opening': '打开中…',
    }

    const EN = {
      'action.openIn': 'Open in {name}',
      'action.openFolder': 'Open this folder in {name}',
      'editor.loading': 'Connecting to the editor mirror…',
      'editor.unsupported': 'This address is not a workspace file and cannot be mirrored',
      'editor.unavailableDisconnected': 'No editor is connected. Make sure the DSH mirror extension is enabled in VS Code / Cursor, then retry.',
      'editor.unavailableElsewhere': 'The editor currently has {path} open.',
      'editor.tooLarge': 'The file is large, so the mirror only carries metadata; edit it in the editor.',
      'editor.openInEditor': 'Open this file in the editor',
      'editor.previewOnly': 'Read-only preview',
      'editor.retry': 'Retry',
      'editor.aria': 'Code editor',
      'editor.save': 'Save',
      'editor.saving': 'Saving…',
      'editor.saved': 'Asked the editor to save',
      'editor.reload': 'Reload',
      'editor.dirty': 'Unsaved changes',
      'editor.mirrorBadge': '{name} mirror',
      'editor.mirrorConflict': 'The editor content changed elsewhere.',
      'editor.mirrorTakeRemote': 'Use the editor content',
      'editor.mirrorOverwrite': 'Overwrite the editor with my content',
      'editor.mirrorLocate': 'Reveal in editor',
      'editor.saveFailed': 'Sync failed: {message}',
      'editor.readFailed': 'Failed: {message}',
      'editor.cursor': 'Ln {line}, Col {column}',
      'editor.lines': '{count} line(s)',
      'editor.hint': 'Edits here write back to the editor buffer; Ctrl+S asks the editor to save',
      'editor.modeIdle': 'Not connected',
      'changes.title': 'Changed files',
      'changes.description': 'Files changed over the last turns; click one to edit it here',
      'changes.refresh': 'Refresh',
      'changes.loading': 'Reading the change record…',
      'changes.failed': 'Read failed: {message}',
      'changes.retry': 'Retry',
      'changes.empty': 'No file changes recorded in the last turns',
      'changes.emptyHint': 'Open a file from the Files tab, or let the assistant change a file and refresh.',
      'changes.notRecorded': 'This Session has no change snapshots (the Coding Tools change record is off); the list below comes from write / edit tool calls.',
      'changes.openFolder': 'Open workspace folder',
      'changes.openAt': 'Open {path} here',
      'changes.preview': 'Read-only preview',
      'changes.binary': 'binary',
      'changes.oversized': 'too large',
      'changes.turn': 'turn {turn}',
      'changes.foot': '{count} file(s), merged over recent turns',
      'changes.opening': 'Opening…',
    }

    const STYLE_TEXT = `
.dsh-ide-bridge-editor-pane{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-ide-bridge-editor-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;min-width:0;flex-wrap:wrap}
.dsh-ide-bridge-editor-path{display:flex;align-items:baseline;gap:6px;min-width:0;flex:1 1 140px;overflow:hidden}
.dsh-ide-bridge-editor-name{font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ide-bridge-editor-dir{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}
.dsh-ide-bridge-dirty{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);flex:0 0 auto;box-shadow:0 0 0 3px transparent}
.dsh-ide-bridge-toolbar{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.dsh-ide-bridge-editor-body{flex:1 1 auto;min-height:0;display:flex;position:relative;background:var(--dsw-alias-bg-base);overflow:hidden}
.dsh-ide-bridge-gutter{flex:0 0 auto;overflow:hidden;border-right:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:12.5px;line-height:20px;padding:10px 8px 10px 10px;text-align:right;user-select:none}
.dsh-ide-bridge-gutter-inner{will-change:transform}
.dsh-ide-bridge-code{position:relative;flex:1 1 auto;min-width:0;overflow:hidden}
.dsh-ide-bridge-highlight{position:absolute;inset:0;margin:0;overflow:hidden;pointer-events:none;font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:12.5px;line-height:20px;padding:10px 12px;white-space:pre;tab-size:4;color:var(--dsw-alias-label-primary)}
.dsh-ide-bridge-line{width:max-content;min-width:100%;height:20px}
.dsh-ide-bridge-input{position:absolute;inset:0;margin:0;resize:none;border:0;outline:none;background:transparent;color:transparent;caret-color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;font-size:12.5px;line-height:20px;padding:10px 12px;white-space:pre;overflow:auto;tab-size:4;scrollbar-width:none;box-sizing:border-box}
.dsh-ide-bridge-input::-webkit-scrollbar{display:none}
.dsh-ide-bridge-input::selection{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent)}
.dsh-ide-bridge-input.is-composing{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.dsh-ide-bridge-banner{padding:8px 10px;font-size:12px;color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:0 0 auto}
.dsh-ide-bridge-banner-text{flex:1 1 160px}
.dsh-ide-bridge-notice{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;flex:0 0 auto;flex-wrap:wrap}
.dsh-ide-bridge-notice.is-warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-ide-bridge-notice-text{flex:1 1 160px;min-width:0;word-break:break-all}
.dsh-ide-bridge-mode{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:11px;flex:0 0 auto}
.dsh-ide-bridge-error{padding:6px 10px;font-size:12px;color:var(--dsw-alias-state-error-primary);flex:0 0 auto}
.dsh-ide-bridge-foot{display:flex;align-items:center;gap:10px;padding:4px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;flex:0 0 auto;flex-wrap:wrap}
.dsh-ide-bridge-spacer{flex:1 1 auto}
.dsh-ide-bridge-state{padding:24px 16px;color:var(--dsw-alias-label-secondary);text-align:center;font-size:12px;display:flex;flex-direction:column;gap:8px;align-items:center}
.dsh-ide-bridge-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;flex:0 0 auto}
.dsh-ide-bridge-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-ide-bridge-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-ide-bridge-btn[disabled]{opacity:.6;cursor:default}
.dsh-ide-bridge-btn.is-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dsh-ide-bridge-btn.is-primary:hover{opacity:.9;background:var(--dsw-alias-brand-primary)}
.dsh-ide-bridge-btn.is-failed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-ide-bridge-btn-compact{width:24px;height:24px;padding:0}
.dsh-ide-bridge-inline{display:inline-flex;gap:4px;align-items:center}
.tok-comment{color:var(--dsw-alias-label-secondary);font-style:italic}
.tok-string{color:var(--dsw-alias-state-success-primary)}
.tok-number{color:var(--dsw-alias-state-warn-primary)}
.tok-keyword{color:var(--dsw-alias-brand-primary)}
.tok-punct{color:var(--dsw-alias-label-secondary)}
.dsh-ide-bridge-changes{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-ide-bridge-changes-header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;min-width:0}
.dsh-ide-bridge-changes-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ide-bridge-changes-count{color:var(--dsw-alias-label-secondary);font-size:12px;flex:0 0 auto}
.dsh-ide-bridge-changes-list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px 14px;display:flex;flex-direction:column;gap:2px}
.dsh-ide-bridge-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;border:0;background:transparent;text-align:left;color:inherit;font:inherit;width:100%}
.dsh-ide-bridge-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-ide-bridge-row.is-busy{opacity:.6}
.dsh-ide-bridge-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-ide-bridge-row-main{display:flex;align-items:baseline;gap:6px;min-width:0;flex:1 1 auto;overflow:hidden}
.dsh-ide-bridge-row-name{font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
.dsh-ide-bridge-row-dir{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}
.dsh-ide-bridge-row-meta{display:flex;align-items:center;gap:6px;flex:0 0 auto;font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace}
.dsh-ide-bridge-added{color:var(--dsw-alias-state-success-primary)}
.dsh-ide-bridge-deleted{color:var(--dsw-alias-state-error-primary)}
.dsh-ide-bridge-turn{color:var(--dsw-alias-label-secondary);font-size:10px}
.dsh-ide-bridge-tag{color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px;font-size:10px}
.dsh-ide-bridge-row-actions{display:flex;gap:4px;opacity:0;flex:0 0 auto}
.dsh-ide-bridge-row:hover .dsh-ide-bridge-row-actions,.dsh-ide-bridge-row:focus-within .dsh-ide-bridge-row-actions{opacity:1}
.dsh-ide-bridge-foot-note{padding:8px 12px 14px;color:var(--dsw-alias-label-secondary);font-size:11px}
`

    /** Install the plugin stylesheet; the disposer removes it. */
    function installStyles() {
      const element = document.createElement('style')
      element.id = 'dsh-ide-bridge-styles'
      element.textContent = STYLE_TEXT
      document.head.appendChild(element)
      return () => {
        element.remove()
      }
    }

    /** Decode one URI segment without throwing. */
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    }

    /** Encode one URI segment, keeping the address grammar's literal colon. */
    function encodeSegment(segment) {
      try {
        return encodeURIComponent(segment).replace(/%3A/gi, ':')
      } catch {
        return segment
      }
    }

    /** Read a `dsh-resource://file/session/<id>/<path>` address. */
    function splitAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined
      const parts = address.slice(FILE_PREFIX.length).split('/')
      if (parts[0] !== 'session') return undefined
      const sessionId = decodeSegment(parts[1] || '')
      if (!sessionId) return undefined
      const path = parts.slice(2).map(decodeSegment).join('/')
      if (!path) return undefined
      return { sessionId, path }
    }

    /** Build the file address for one Session path. */
    function fileAddressFor(sessionId, path) {
      const segments = String(path).replace(/\\/g, '/').split('/').map(encodeSegment)
      return FILE_PREFIX + 'session/' + encodeSegment(sessionId) + '/' + segments.join('/')
    }

    /** The final path segment. */
    function basenameOf(path) {
      const text = String(path).replace(/\\/g, '/')
      const index = text.lastIndexOf('/')
      return index < 0 ? text : text.slice(index + 1)
    }

    /** Everything before the final path segment. */
    function dirnameOf(path) {
      const text = String(path).replace(/\\/g, '/')
      const index = text.lastIndexOf('/')
      return index <= 0 ? '' : text.slice(0, index)
    }

    /** The lower-cased extension including its dot, or ''. */
    function extensionOf(path) {
      const name = basenameOf(path).toLowerCase()
      const index = name.lastIndexOf('.')
      return index <= 0 ? '' : name.slice(index)
    }

    /** Whether the editor type claims this address. */
    function isCodeAddress(address) {
      const target = splitAddress(address)
      if (!target) return false
      const name = basenameOf(target.path).toLowerCase()
      if (CODE_NAMES.has(name)) return true
      return CODE_EXTENSIONS.has(extensionOf(target.path))
    }

    /** One readable error message. */
    function messageOf(error) {
      if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
      return String(error)
    }

    /** Read a JSON body from a response without throwing. */
    async function responseJson(response) {
      try {
        return await response.json()
      } catch {
        return undefined
      }
    }

    /** Fetch JSON and translate a non-OK answer into an Error carrying `code`. */
    async function requestJson(url, init) {
      let response
      try {
        response = await fetch(url, init)
      } catch (error) {
        throw new Error(messageOf(error))
      }
      const data = await responseJson(response)
      if (!response.ok) {
        const failure = new Error((data && data.error) || `HTTP ${response.status}`)
        failure.code = data && data.code
        failure.status = response.status
        throw failure
      }
      return data || {}
    }

    let editorsValue = []
    let editorsLoaded = false
    let editorsPromise

    /** Load the detected external editors once per page. */
    function loadEditors() {
      if (editorsPromise) return editorsPromise
      editorsPromise = requestJson(ROUTE_EDITORS, { headers: { accept: 'application/json' } })
        .then((data) => {
          editorsValue = Array.isArray(data.editors) ? data.editors : []
          editorsLoaded = true
          return editorsValue
        })
        .catch(() => {
          editorsLoaded = true
          return editorsValue
        })
      return editorsPromise
    }

    /** Subscribe one component to the detected external editors. */
    function useEditors() {
      const [snapshot, setSnapshot] = useState({ editors: editorsValue, loaded: editorsLoaded })
      useEffect(() => {
        let active = true
        loadEditors().then((editors) => {
          if (active) setSnapshot({ editors, loaded: true })
        })
        return () => {
          active = false
        }
      }, [])
      return snapshot
    }

    /** Editors the Host reported as installed. */
    function availableEditors(editors) {
      return editors.filter((editor) => editor.available !== false)
    }

    /** The remembered external editor id. */
    function readRememberedEditor() {
      try {
        return window.localStorage.getItem(EDITOR_STORAGE_KEY) || 'vscode'
      } catch {
        return 'vscode'
      }
    }

    /** Remember the last successful external editor choice. */
    function rememberEditor(id) {
      try {
        window.localStorage.setItem(EDITOR_STORAGE_KEY, id)
      } catch {
        /* storage may be disabled */
      }
    }

    /** The external editor the primary toolbar button uses. */
    function primaryEditor(editors) {
      const available = availableEditors(editors)
      const remembered = readRememberedEditor()
      return available.find((editor) => editor.id === remembered) || available.find((editor) => editor.id === 'vscode') || available[0]
    }

    /** Every external editor except the primary one. */
    function otherEditors(editors) {
      const primary = primaryEditor(editors)
      return availableEditors(editors).filter((editor) => !primary || editor.id !== primary.id)
    }

    /** Open one file path in one external editor. */
    function openInEditor(editor, sessionId, path, line, column) {
      return requestJson(ROUTE_OPEN, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editorId: editor.id, sessionId, path, line: line || undefined, column: column || undefined }),
      })
    }

    /** Open one folder (or a file's folder) in one external editor. */
    function openFolderInEditor(editor, sessionId, path) {
      return requestJson(ROUTE_OPEN_FOLDER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editorId: editor.id, sessionId, path }),
      })
    }

    /** Read the merged changed-file panel payload. */
    function fetchChangedFiles(sessionId, turns) {
      const query = new URLSearchParams({ sessionId, turns: String(turns || MAX_TURNS) })
      return requestJson(ROUTE_CHANGES + '?' + query.toString(), { headers: { accept: 'application/json' } })
    }

    /** Read the editor-mirror snapshot for one workspace file. */
    function fetchMirror(sessionId, path, signal, instanceId) {
      const query = new URLSearchParams({ sessionId, path })
      if (instanceId) query.set('instanceId', instanceId)
      return requestJson(ROUTE_MIRROR + '?' + query.toString(), { headers: { accept: 'application/json' }, signal })
    }

    /** Queue one command for the editor mirror. */
    function sendMirrorCommand(instanceId, command, sessionId) {
      return requestJson(ROUTE_MIRROR_COMMAND, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: instanceId || undefined, sessionId, command }),
      })
    }

    /** The first changed line of one recorded file, or 0 when unknown. */
    function firstChangedLine(sessionId, seq, index) {
      if (!Number.isInteger(seq) || seq <= 0 || !Number.isInteger(index) || index < 0) return Promise.resolve(0)
      const query = new URLSearchParams({ sessionId, seq: String(seq), index: String(index) })
      return requestJson(ROUTE_CHANGES_DIFF + '?' + query.toString(), { headers: { accept: 'application/json' } })
        .then((diff) => {
          if (!diff || diff.kind !== 'text' || !Array.isArray(diff.hunks) || diff.hunks.length === 0) return 0
          const hunk = diff.hunks[0]
          if (diff.after && Number.isInteger(hunk.newStart)) return Math.max(1, hunk.newStart)
          if (Number.isInteger(hunk.oldStart)) return Math.max(1, hunk.oldStart)
          return 0
        })
        .catch(() => 0)
    }

    /** Tokenize one line into `{ kind, text }` runs. */
    function tokenizeLine(line, spec) {
      const tokens = []
      const push = (kind, text) => {
        if (!text) return
        const last = tokens[tokens.length - 1]
        if (last && last.kind === kind) {
          last.text += text
          return
        }
        tokens.push({ kind, text })
      }
      if (line.length === 0) return tokens
      const trimmed = line.trimStart()
      for (const prefix of spec.lineComments || []) {
        if (trimmed.startsWith(prefix)) {
          return [{ kind: 'comment', text: line }]
        }
      }
      const quotes = spec.quotes || []
      let index = 0
      while (index < line.length) {
        if (spec.blockCommentStart && line.startsWith(spec.blockCommentStart, index)) {
          const endIndex = line.indexOf(spec.blockCommentEnd, index + spec.blockCommentStart.length)
          const stop = endIndex < 0 ? line.length : endIndex + spec.blockCommentEnd.length
          push('comment', line.slice(index, stop))
          index = stop
          continue
        }
        const character = line[index]
        if (quotes.includes(character)) {
          let cursor = index + 1
          while (cursor < line.length) {
            if (line[cursor] === '\\') {
              cursor += 2
              continue
            }
            if (line[cursor] === character) {
              cursor += 1
              break
            }
            cursor += 1
          }
          push('string', line.slice(index, Math.min(cursor, line.length)))
          index = Math.min(cursor, line.length)
          continue
        }
        if (character >= '0' && character <= '9') {
          let cursor = index + 1
          while (cursor < line.length && /[0-9a-fA-FxXoObB._eE]/.test(line[cursor])) cursor += 1
          push('number', line.slice(index, cursor))
          index = cursor
          continue
        }
        if (/[A-Za-z_$@]/.test(character)) {
          let cursor = index + 1
          while (cursor < line.length && /[A-Za-z0-9_$]/.test(line[cursor])) cursor += 1
          const word = line.slice(index, cursor)
          const normalized = spec.caseInsensitive ? word.toLowerCase() : word
          push(spec.keywords.has(normalized) ? 'keyword' : 'plain', word)
          index = cursor
          continue
        }
        if (character === ' ' || character === '\t') {
          let cursor = index + 1
          while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t')) cursor += 1
          push('plain', line.slice(index, cursor))
          index = cursor
          continue
        }
        push('punct', character)
        index += 1
      }
      return tokens
    }

    /** Tokenize a whole file; returns one token array per line, or null when too large. */
    function highlightTextLines(text, language) {
      if (language === 'plain') return null
      if (text.length > HIGHLIGHT_MAX_CHARS) return null
      const spec = LANGUAGE_SPECS[language]
      if (!spec) return null
      const lines = text.split('\n')
      if (lines.length > HIGHLIGHT_MAX_LINES) return null
      return lines.map((line) => tokenizeLine(line, spec))
    }

    /** Render one line's tokens; empty lines keep their height with a zero-width space. */
    function renderTokens(tokens) {
      if (!tokens || tokens.length === 0) return '\u200b'
      const children = []
      tokens.forEach((token, index) => {
        if (token.kind === 'plain' || token.kind === 'punct') children.push(token.text)
        else children.push(h('span', { key: index, className: 'tok-' + token.kind }, token.text))
      })
      return children
    }

    /** The external-editor glyph shown on toolbar buttons. */
    function EditorGlyph(props) {
      const size = props.size || 15
      if (props.icon === 'cursor') {
        return h(
          'svg',
          { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M3.2 2.4 12.9 8.3l-4.2.9-2.1 4.2z', fill: 'currentColor' }),
        )
      }
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M5.6 4.4 2.3 8l3.3 3.6',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
        h('path', {
          d: 'M10.4 4.4 13.7 8l-3.3 3.6',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      )
    }

    /** The preview glyph. */
    function PreviewGlyph(props) {
      const size = props.size || 15
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M1.8 8S4.1 3.6 8 3.6 14.2 8 14.2 8 11.9 12.4 8 12.4 1.8 8 1.8 8Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }),
        h('circle', { cx: 8, cy: 8, r: 1.9, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }),
      )
    }

    /** The refresh glyph. */
    function RefreshGlyph(props) {
      const size = props.size || 15
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7M13 3.6V7h-3.4',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.5,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
      )
    }

    /** The guide glyph for the changed-files entry. */
    function GuideIcon(props) {
      return EditorGlyph({ icon: 'code', size: (props && props.size) || 16 })
    }

    /** One external-editor toolbar button with its own busy/failed state. */
    function EditorActionButton(props) {
      const { editor, label, title, compact, className, onRun } = props
      const [state, setState] = useState('idle')
      const [failure, setFailure] = useState('')
      const disabled = state === 'pending'
      const classes = 'dsh-ide-bridge-btn' + (compact ? ' dsh-ide-bridge-btn-compact' : '') + (state === 'failed' ? ' is-failed' : '') + (className ? ' ' + className : '')
      const click = (event) => {
        if (event) {
          event.preventDefault()
          event.stopPropagation()
        }
        if (disabled) return
        setState('pending')
        setFailure('')
        Promise.resolve()
          .then(() => onRun())
          .then(() => {
            rememberEditor(editor.id)
            setState('done')
            window.setTimeout(() => setState((current) => (current === 'done' ? 'idle' : current)), 1600)
          })
          .catch((error) => {
            setFailure(messageOf(error))
            setState('failed')
            window.setTimeout(() => setState((current) => (current === 'failed' ? 'idle' : current)), 3600)
          })
      }
      return h(
        'button',
        {
          type: 'button',
          className: classes,
          disabled,
          onClick: click,
          title: state === 'failed' ? failure : title || label,
          'aria-label': label,
        },
        h(EditorGlyph, { icon: editor.icon }),
        compact ? null : h('span', null, label),
      )
    }

    /**
     * The in-place code editor, entirely backed by the connected editor's mirror.
     *
     * The editor process owns the buffer: this pane renders the mirrored document,
     * sends local edits back as commands, and degrades to an explanatory empty
     * state when no editor can mirror the file. There is no second editing mode.
     */
    function MirrorCodeEditor(props) {
      const { useTabInfo, sessionId, t, openPreview } = props
      const { tab } = useTabInfo()
      const target = useMemo(() => splitAddress(tab.contentId), [tab.contentId])
      const editorSessionId = target ? target.sessionId || sessionId : sessionId
      const navigationLine = tab.navigation && tab.navigation.params && Number.isInteger(tab.navigation.params.line) ? tab.navigation.params.line : 0
      const navigationRevision = tab.navigation ? tab.navigation.revision : 0
      const editorSnapshot = useEditors()
      const editors = editorSnapshot.editors
      const primary = primaryEditor(editors)
      const others = otherEditors(editors)

      const [mode, setMode] = useState('connecting')
      const modeRef = useRef('connecting')
      const [text, setText] = useState('')
      const textRef = useRef('')
      textRef.current = text
      const [mirror, setMirror] = useState(null)
      const mirrorRef = useRef(null)
      const [pendingActive, setPendingActive] = useState(false)
      const pendingRef = useRef({ active: false, text: '', expectedVersion: 0, force: false })
      const [mirrorDirty, setMirrorDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [status, setStatus] = useState('')
      const [error, setError] = useState('')
      const [banner, setBanner] = useState(null)
      const [composing, setComposing] = useState(false)
      const [cursor, setCursor] = useState({ line: 1, column: 1 })
      const [highlightText, setHighlightText] = useState('')
      const textareaRef = useRef(null)
      const preRef = useRef(null)
      const gutterRef = useRef(null)
      const editTimerRef = useRef(null)
      const autoOpenRef = useRef({ path: '', requested: false, polls: 0 })
      const unusableRef = useRef(0)
      const pinRef = useRef('')
      const pollNowRef = useRef(() => {})
      const language = useMemo(() => languageOf(target ? target.path : ''), [target])
      const dirty = mirror ? mirrorDirty || pendingActive : false
      const lines = useMemo(() => text.split('\n'), [text])
      const lineCount = lines.length
      const digitCount = String(lineCount).length
      const editorName = (kind) => (kind === 'cursor' ? 'Cursor' : kind === 'vscode-insiders' ? 'VS Code Insiders' : 'VS Code')

      /** Switch surface mode, keeping the ref in sync immediately. */
      const changeMode = useCallback((next) => {
        modeRef.current = next
        setMode(next)
      }, [])

      /** Apply the current textarea scroll to the highlight layer and gutter. */
      const syncScroll = useCallback(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        if (preRef.current) {
          preRef.current.scrollTop = textarea.scrollTop
          preRef.current.scrollLeft = textarea.scrollLeft
        }
        if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-textarea.scrollTop}px)`
      }, [])

      /** Publish the caret position in the footer. */
      const positionCursor = useCallback(() => {
        const textarea = textareaRef.current
        if (!textarea) return
        const before = textarea.value.slice(0, textarea.selectionStart)
        const line = before.split('\n').length
        const column = before.length - before.lastIndexOf('\n')
        setCursor({ line, column })
      }, [])

      /** Queue the pending sidebar edit for the editor. */
      const flushMirrorEdit = useCallback(() => {
        const pending = pendingRef.current
        if (!pending.active || !target) return Promise.resolve()
        if (editTimerRef.current) {
          window.clearTimeout(editTimerRef.current)
          editTimerRef.current = null
        }
        const current = mirrorRef.current
        const instanceId = current && current.instance ? current.instance.id : pinRef.current
        const document = current && current.document
        const force = pending.force || Boolean(document && document.version !== pending.expectedVersion)
        pending.force = true
        return sendMirrorCommand(
          instanceId,
          {
            type: 'edit',
            path: target.path,
            text: pending.text,
            expectedVersion: pending.expectedVersion,
            force,
          },
          editorSessionId,
        ).catch((failure) => {
          setError(t('editor.saveFailed', { message: messageOf(failure) }))
        })
      }, [target, editorSessionId, t])

      /** Update local text and mirror the change to the editor when connected. */
      const applyLocalEdit = useCallback(
        (next) => {
          setText(next)
          setStatus('')
          if (modeRef.current !== 'mirror') return
          const current = mirrorRef.current
          const document = current && current.document
          const pending = pendingRef.current
          const expectedVersion = pending.active ? pending.expectedVersion : document ? document.version : 0
          pendingRef.current = { active: true, text: next, expectedVersion, force: pending.active }
          setPendingActive(true)
          if (editTimerRef.current) window.clearTimeout(editTimerRef.current)
          editTimerRef.current = window.setTimeout(() => {
            editTimerRef.current = null
            flushMirrorEdit()
          }, 220)
        },
        [flushMirrorEdit],
      )

      /** Ask the editor to open this file (optionally at a line) without stealing focus. */
      const openInConnectedEditor = useCallback(
        (line, instanceId) => {
          const current = mirrorRef.current
          const id = instanceId || (current && current.instance ? current.instance.id : pinRef.current)
          if (!target || !id) {
            setError(t('editor.unavailableDisconnected'))
            return Promise.resolve()
          }
          return sendMirrorCommand(id, { type: 'open', path: target.path, line: line || 0, preserveFocus: true }, editorSessionId).catch((failure) => setError(messageOf(failure)))
        },
        [target, editorSessionId, t],
      )

      /** Reconcile one mirror snapshot into the surface. */
      const applyMirrorSnapshot = useCallback(
        (nextSnapshot) => {
          mirrorRef.current = nextSnapshot
          setMirror(nextSnapshot)
          if (nextSnapshot && nextSnapshot.instance && nextSnapshot.instance.id) pinRef.current = nextSnapshot.instance.id
          const document = nextSnapshot && nextSnapshot.matching ? nextSnapshot.document : null
          const usable = Boolean(nextSnapshot && nextSnapshot.connected && document && document.tooLarge !== true && document.truncated !== true)
          if (!usable) {
            unusableRef.current += 1
            // Hysteresis: a transient miss keeps the last mirrored content.
            if (modeRef.current === 'mirror' && unusableRef.current < 3) return
            if (nextSnapshot && nextSnapshot.connected && nextSnapshot.instance && target) {
              const key = target.path
              if (autoOpenRef.current.path !== key) autoOpenRef.current = { path: key, requested: false, polls: 0 }
              const auto = autoOpenRef.current
              if (!auto.requested) {
                auto.requested = true
                openInConnectedEditor(0, nextSnapshot.instance.id)
              }
              auto.polls += 1
              if (auto.polls <= 10) {
                changeMode('connecting')
                return
              }
            }
            changeMode('unavailable')
            if (document && (document.tooLarge === true || document.truncated === true)) setError(t('editor.tooLarge'))
            return
          }
          autoOpenRef.current = { path: '', requested: false, polls: 0 }
          unusableRef.current = 0
          if (modeRef.current !== 'mirror') {
            changeMode('mirror')
            setError('')
          }
          setMirrorDirty(document.dirty === true)
          const pending = pendingRef.current
          if (pending.active) {
            if (document.version > pending.expectedVersion && document.text === pending.text) {
              pendingRef.current = { active: false, text: '', expectedVersion: 0, force: false }
              setPendingActive(false)
              if (document.text !== textRef.current) setText(document.text)
              setBanner(null)
            } else if (document.version > pending.expectedVersion && document.text !== pending.text) {
              setBanner({ kind: 'conflict', remoteText: document.text })
            }
          } else if (document.text !== textRef.current) {
            setText(document.text)
          }
        },
        [changeMode, target, t, openInConnectedEditor],
      )

      // Poll the mirror while this tab is visible.
      useEffect(() => {
        if (!target || !tab.visible) return undefined
        let active = true
        let timer
        const poll = () => {
          fetchMirror(editorSessionId, target.path, tab.signal, pinRef.current)
            .then((nextSnapshot) => {
              if (active && !tab.signal.aborted) applyMirrorSnapshot(nextSnapshot)
            })
            .catch(() => {
              /* keep the last known surface */
            })
            .then(() => {
              if (active) timer = window.setTimeout(poll, 450)
            })
        }
        pollNowRef.current = poll
        poll()
        return () => {
          active = false
          window.clearTimeout(timer)
          pollNowRef.current = () => {}
        }
      }, [target, tab.visible, tab.signal, editorSessionId, applyMirrorSnapshot])

      useEffect(() => {
        return () => {
          if (editTimerRef.current) window.clearTimeout(editTimerRef.current)
        }
      }, [])

      /** Scroll the requested source line into view and place the caret on it. */
      const revealLine = useCallback(
        (line) => {
          const textarea = textareaRef.current
          if (!textarea) return
          const allLines = textarea.value.split('\n')
          const wanted = Math.max(1, Math.min(line, allLines.length))
          let index = 0
          for (let cursorIndex = 0; cursorIndex < wanted - 1; cursorIndex += 1) index += allLines[cursorIndex].length + 1
          const lineEnd = index + allLines[wanted - 1].length
          try {
            textarea.focus({ preventScroll: true })
          } catch {
            textarea.focus()
          }
          textarea.selectionStart = index
          textarea.selectionEnd = lineEnd
          textarea.scrollTop = Math.max(0, (wanted - 1) * LINE_HEIGHT - textarea.clientHeight / 2 + LINE_HEIGHT)
          syncScroll()
          positionCursor()
        },
        [syncScroll, positionCursor],
      )

      const revealedRef = useRef('')
      useEffect(() => {
        if (mode !== 'mirror' || navigationLine <= 0 || !target) return
        const key = target.path + ':' + navigationRevision
        if (revealedRef.current === key) return
        revealedRef.current = key
        revealLine(navigationLine)
      }, [mode, navigationLine, navigationRevision, target, revealLine])

      // Focus the editor surface once when the tab becomes visible and ready.
      useEffect(() => {
        if (mode !== 'mirror' || !tab.visible) return
        const textarea = textareaRef.current
        if (!textarea) return
        const active = document.activeElement
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return
        try {
          textarea.focus({ preventScroll: true })
        } catch {
          /* focus is best effort */
        }
      }, [mode, tab.visible])

      // Debounced highlight input: typing renders plain text until the timer settles.
      useEffect(() => {
        const handle = window.setTimeout(() => setHighlightText(text), 90)
        return () => window.clearTimeout(handle)
      }, [text])

      const highlightLines = useMemo(() => (text === highlightText ? highlightTextLines(highlightText, language) : null), [text, highlightText, language])

      /** Ask the editor to save the mirrored document. */
      const save = useCallback(async () => {
        if (!target || saving || modeRef.current !== 'mirror') return
        setSaving(true)
        setError('')
        try {
          await flushMirrorEdit()
          const current = mirrorRef.current
          const instanceId = current && current.instance ? current.instance.id : pinRef.current
          await sendMirrorCommand(instanceId, { type: 'save', path: target.path }, editorSessionId)
          setStatus(t('editor.saved'))
          window.setTimeout(() => setStatus(''), 1800)
        } catch (failure) {
          setError(t('editor.saveFailed', { message: messageOf(failure) }))
        } finally {
          setSaving(false)
        }
      }, [target, saving, t, editorSessionId, flushMirrorEdit])

      /** Re-sync with the editor: clear pending edits, reveal the current line. */
      const reload = () => {
        setBanner(null)
        if (modeRef.current !== 'mirror') {
          unusableRef.current = 0
          autoOpenRef.current = { path: '', requested: false, polls: 0 }
          pollNowRef.current()
          return
        }
        pendingRef.current = { active: false, text: '', expectedVersion: 0, force: false }
        setPendingActive(false)
        openInConnectedEditor(cursor.line)
      }

      /** Keyboard behaviour: Ctrl/Cmd+S saves, Tab indents, Enter keeps the indentation. */
      const onKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 's') {
          event.preventDefault()
          save()
          return
        }
        if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          const textarea = event.currentTarget
          const start = textarea.selectionStart
          const end = textarea.selectionEnd
          const next = textarea.value.slice(0, start) + '  ' + textarea.value.slice(end)
          applyLocalEdit(next)
          window.requestAnimationFrame(() => {
            const element = textareaRef.current
            if (!element) return
            element.selectionStart = element.selectionEnd = start + 2
            positionCursor()
          })
          return
        }
        if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          const textarea = event.currentTarget
          const start = textarea.selectionStart
          const end = textarea.selectionEnd
          const before = textarea.value.slice(0, start)
          const lineStart = before.lastIndexOf('\n') + 1
          const indentation = /^[ \t]*/.exec(before.slice(lineStart))
          const insertion = '\n' + (indentation ? indentation[0] : '')
          const next = textarea.value.slice(0, start) + insertion + textarea.value.slice(end)
          applyLocalEdit(next)
          window.requestAnimationFrame(() => {
            const element = textareaRef.current
            if (!element) return
            element.selectionStart = element.selectionEnd = start + insertion.length
            positionCursor()
          })
        }
      }

      const resolveConflict = (takeRemote) => {
        const conflict = banner
        setBanner(null)
        if (!conflict) return
        pendingRef.current = { active: false, text: '', expectedVersion: 0, force: false }
        setPendingActive(false)
        if (takeRemote) {
          if (typeof conflict.remoteText === 'string') setText(conflict.remoteText)
          return
        }
        const current = mirrorRef.current
        if (!current || !current.document) return
        const instanceId = current.instance ? current.instance.id : pinRef.current
        pendingRef.current = { active: true, text: textRef.current, expectedVersion: current.document.version, force: true }
        setPendingActive(true)
        sendMirrorCommand(
          instanceId,
          {
            type: 'edit',
            path: target.path,
            text: textRef.current,
            expectedVersion: current.document.version,
            force: true,
          },
          editorSessionId,
        ).catch((failure) => setError(messageOf(failure)))
      }

      if (!target) {
        return h('div', { className: 'dsh-ide-bridge-state' }, t('editor.unsupported'))
      }

      const mirrorInstance = mirror && mirror.instance ? mirror.instance : null
      const mirrorConnected = Boolean(mirror && mirror.connected && mirrorInstance)
      const unavailableMessage = !mirrorConnected
        ? t('editor.unavailableDisconnected')
        : mirror.matching
          ? t('editor.tooLarge')
          : mirrorInstance.activePath
            ? t('editor.unavailableElsewhere', { path: mirrorInstance.activePath })
            : t('editor.unavailableDisconnected')

      const toolbar = []
      for (const editor of [primary, ...others]) {
        if (!editor) continue
        toolbar.push(
          h(EditorActionButton, {
            key: editor.id,
            editor,
            label: t('action.openIn', { name: editor.label }),
            title: t('action.openIn', { name: editor.label }),
            onRun: () => openInEditor(editor, editorSessionId, target.path, cursor.line, cursor.column),
          }),
        )
      }
      if (mode === 'mirror') {
        toolbar.push(
          h(
            'button',
            { key: 'locate', type: 'button', className: 'dsh-ide-bridge-btn', onClick: () => openInConnectedEditor(cursor.line), title: t('editor.mirrorLocate') },
            h(EditorGlyph, { icon: mirrorInstance && mirrorInstance.editor === 'cursor' ? 'cursor' : 'code' }),
            h('span', null, t('editor.mirrorLocate')),
          ),
        )
      }
      toolbar.push(
        h(
          'button',
          { key: 'reload', type: 'button', className: 'dsh-ide-bridge-btn', onClick: reload, title: t('editor.reload'), 'aria-label': t('editor.reload') },
          h(RefreshGlyph),
          h('span', null, t('editor.reload')),
        ),
      )
      toolbar.push(
        h(
          'button',
          {
            key: 'save',
            type: 'button',
            className: 'dsh-ide-bridge-btn' + (dirty ? ' is-primary' : ''),
            onClick: () => save(),
            title: dirty ? t('editor.dirty') : t('editor.save'),
            'aria-label': t('editor.save'),
            disabled: mode !== 'mirror' || saving || !dirty,
          },
          h('span', null, saving ? t('editor.saving') : t('editor.save')),
        ),
      )

      const bannerNodes = banner
        ? h(
            'div',
            { className: 'dsh-ide-bridge-banner' },
            h('span', { className: 'dsh-ide-bridge-banner-text' }, t('editor.mirrorConflict')),
            h('button', { type: 'button', className: 'dsh-ide-bridge-btn', onClick: () => resolveConflict(true) }, t('editor.mirrorTakeRemote')),
            h('button', { type: 'button', className: 'dsh-ide-bridge-btn', onClick: () => resolveConflict(false) }, t('editor.mirrorOverwrite')),
          )
        : null

      const notices = []
      if (mode === 'unavailable') {
        notices.push(
          h(
            'div',
            { className: 'dsh-ide-bridge-notice is-warn', key: 'notice' },
            h('span', { className: 'dsh-ide-bridge-notice-text' }, unavailableMessage),
            mirrorConnected
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ide-bridge-btn',
                    onClick: () => {
                      unusableRef.current = 0
                      autoOpenRef.current = { path: '', requested: false, polls: 0 }
                      changeMode('connecting')
                      openInConnectedEditor(0)
                    },
                  },
                  t('editor.openInEditor'),
                )
              : null,
            h('button', { type: 'button', className: 'dsh-ide-bridge-btn', onClick: () => openPreview(tab.contentId) }, t('editor.previewOnly')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-ide-bridge-btn',
                onClick: () => {
                  unusableRef.current = 0
                  autoOpenRef.current = { path: '', requested: false, polls: 0 }
                  pollNowRef.current()
                },
              },
              t('editor.retry'),
            ),
          ),
        )
      }

      let body
      if (mode === 'connecting') {
        body = h('div', { className: 'dsh-ide-bridge-state' }, t('editor.loading'))
      } else if (mode === 'unavailable') {
        body = h('div', { className: 'dsh-ide-bridge-state' }, unavailableMessage)
      } else {
        const highlightNodes = highlightLines
          ? highlightLines.map((tokens, index) => h('div', { key: index, className: 'dsh-ide-bridge-line' }, renderTokens(tokens)))
          : null
        const gutterNumbers = []
        for (let index = 0; index < lineCount; index += 1) gutterNumbers.push(h('div', { key: index }, String(index + 1)))
        body = [
          h(
            'div',
            { key: 'gutter', className: 'dsh-ide-bridge-gutter', style: { width: 'calc(' + digitCount + 'ch + 20px)' } },
            h('div', { ref: gutterRef, className: 'dsh-ide-bridge-gutter-inner' }, gutterNumbers),
          ),
          h(
            'div',
            { key: 'code', className: 'dsh-ide-bridge-code' },
            h('pre', { ref: preRef, className: 'dsh-ide-bridge-highlight', 'aria-hidden': 'true' }, highlightNodes || text + '\u200b'),
            h('textarea', {
              ref: textareaRef,
              className: 'dsh-ide-bridge-input' + (composing ? ' is-composing' : ''),
              value: text,
              onChange: (event) => applyLocalEdit(event.target.value),
              onKeyDown,
              onScroll: syncScroll,
              onSelect: positionCursor,
              onKeyUp: positionCursor,
              onClick: positionCursor,
              onCompositionStart: () => setComposing(true),
              onCompositionEnd: (event) => {
                setComposing(false)
                applyLocalEdit(event.currentTarget.value)
              },
              spellCheck: false,
              autoCapitalize: 'off',
              autoCorrect: 'off',
              autoComplete: 'off',
              wrap: 'off',
              'aria-label': t('editor.aria'),
            }),
          ),
        ]
      }

      return h(
        'div',
        { className: 'dsh-ide-bridge-editor-pane' },
        h(
          'div',
          { className: 'dsh-ide-bridge-editor-head' },
          h(
            'div',
            { className: 'dsh-ide-bridge-editor-path' },
            h('span', { className: 'dsh-ide-bridge-editor-name' }, basenameOf(target.path)),
            h('span', { className: 'dsh-ide-bridge-editor-dir' }, dirnameOf(target.path)),
            dirty ? h('span', { className: 'dsh-ide-bridge-dirty', title: t('editor.dirty'), 'aria-label': t('editor.dirty') }) : null,
          ),
          h('div', { className: 'dsh-ide-bridge-toolbar' }, toolbar),
        ),
        notices,
        bannerNodes,
        error ? h('div', { className: 'dsh-ide-bridge-error' }, error) : null,
        h('div', { className: 'dsh-ide-bridge-editor-body' }, body),
        h(
          'div',
          { className: 'dsh-ide-bridge-foot' },
          h('span', { className: 'dsh-ide-bridge-mode' }, mode === 'mirror' && mirrorInstance ? t('editor.mirrorBadge', { name: editorName(mirrorInstance.editor) }) : t('editor.modeIdle')),
          h('span', null, t('editor.cursor', { line: cursor.line, column: cursor.column })),
          h('span', { className: 'dsh-ide-bridge-spacer' }),
          status ? h('span', null, status) : null,
          mode === 'mirror' ? h('span', null, t('editor.lines', { count: lineCount })) : null,
          h('span', null, t('editor.hint')),
        ),
      )
    }


    /** The changed-files page body. */
    function ChangesPanel(props) {
      const { useTabInfo, sessionId, t, openPreview, openResource } = props
      const { tab } = useTabInfo()
      const snapshot = useEditors()
      const primary = primaryEditor(snapshot.editors)
      const [state, setState] = useState({ kind: 'loading' })
      const [busyPath, setBusyPath] = useState('')
      const [error, setError] = useState('')
      const aliveRef = useRef(true)
      useEffect(() => {
        return () => {
          aliveRef.current = false
        }
      }, [])
      const actionsRef = useRef(tab.actions)
      actionsRef.current = tab.actions
      const load = useCallback(() => {
        setError('')
        setState((previous) => (previous.kind === 'ready' ? { ...previous, refreshing: true } : { kind: 'loading' }))
        return fetchChangedFiles(sessionId, MAX_TURNS)
          .then((data) => {
            if (aliveRef.current) setState({ kind: 'ready', data })
          })
          .catch((failure) => {
            if (aliveRef.current) setState({ kind: 'failed', message: messageOf(failure) })
          })
      }, [sessionId])
      useEffect(() => {
        load()
        const actions = actionsRef.current
        const dispose = actions && actions.bindCommands ? actions.bindCommands({ refresh: load }) : undefined
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, [load])
      const visible = Boolean(tab.visible)
      const firstVisibilityRef = useRef(true)
      useEffect(() => {
        if (firstVisibilityRef.current) {
          firstVisibilityRef.current = false
          return
        }
        if (visible) load()
      }, [visible, load])
      const openRow = useCallback(
        (file) => {
          setBusyPath(file.path)
          setError('')
          const lineTask = file.source === 'changes' ? firstChangedLine(sessionId, file.seq, file.index) : Promise.resolve(0)
          lineTask
            .then((line) => {
              if (aliveRef.current) setBusyPath('')
              if (openResource) openResource(fileAddressFor(sessionId, file.path), line)
            })
            .catch((failure) => {
              if (aliveRef.current) {
                setBusyPath('')
                setError(messageOf(failure))
              }
            })
        },
        [sessionId, openResource],
      )
      const previewRow = useCallback(
        (file) => {
          if (openPreview) openPreview(fileAddressFor(sessionId, file.path))
        },
        [openPreview, sessionId],
      )
      const data = state.kind === 'ready' ? state.data : undefined
      const files = data && Array.isArray(data.files) ? data.files : []
      const openWorkspace = () => {
        if (!data || !data.cwd) return
        const editor = primary || availableEditors(snapshot.editors)[0]
        if (!editor) {
          setError(t('editor.readFailed', { message: t('changes.preview') }))
          return
        }
        openFolderInEditor(editor, sessionId, data.cwd)
          .then(() => rememberEditor(editor.id))
          .catch((failure) => setError(messageOf(failure)))
      }
      const refreshButton = h(
        'button',
        { type: 'button', className: 'dsh-ide-bridge-btn dsh-ide-bridge-btn-compact', onClick: load, title: t('changes.refresh'), 'aria-label': t('changes.refresh') },
        h(RefreshGlyph),
      )
      const folderButton =
        data && data.cwd
          ? h(
              'button',
              { type: 'button', className: 'dsh-ide-bridge-btn dsh-ide-bridge-btn-compact', onClick: openWorkspace, title: t('changes.openFolder'), 'aria-label': t('changes.openFolder') },
              h(EditorGlyph, { icon: (primary && primary.icon) || 'code', size: 15 }),
            )
          : null
      let body
      if (state.kind === 'loading') {
        body = h('div', { className: 'dsh-ide-bridge-state' }, t('changes.loading'))
      } else if (state.kind === 'failed') {
        body = h(
          'div',
          { className: 'dsh-ide-bridge-state' },
          t('changes.failed', { message: state.message }),
          h('button', { type: 'button', className: 'dsh-ide-bridge-btn', onClick: load }, t('changes.retry')),
        )
      } else if (files.length === 0) {
        body = h(
          'div',
          { className: 'dsh-ide-bridge-state' },
          t('changes.empty'),
          h('span', null, t('changes.emptyHint')),
          data && data.recorded === false ? h('span', null, t('changes.notRecorded')) : null,
        )
      } else {
        body = h(
          'div',
          { className: 'dsh-ide-bridge-changes-list' },
          files.map((file) =>
            h(
              'div',
              {
                key: file.path,
                className: 'dsh-ide-bridge-row' + (busyPath === file.path ? ' is-busy' : ''),
                role: 'button',
                tabIndex: 0,
                title: t('changes.openAt', { path: file.path }),
                onClick: () => openRow(file),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openRow(file)
                  }
                },
              },
              h(
                'div',
                { className: 'dsh-ide-bridge-row-main' },
                h('span', { className: 'dsh-ide-bridge-row-name' }, basenameOf(file.display || file.path)),
                h('span', { className: 'dsh-ide-bridge-row-dir' }, dirnameOf(file.display || file.path)),
              ),
              h(
                'div',
                { className: 'dsh-ide-bridge-row-meta' },
                file.binary
                  ? h('span', { className: 'dsh-ide-bridge-tag' }, t('changes.binary'))
                  : file.oversized
                    ? h('span', { className: 'dsh-ide-bridge-tag' }, t('changes.oversized'))
                    : h('span', { className: 'dsh-ide-bridge-added' }, '+' + file.added),
                file.binary || file.oversized ? null : h('span', { className: 'dsh-ide-bridge-deleted' }, '−' + file.deleted),
                file.turn > 0 ? h('span', { className: 'dsh-ide-bridge-turn' }, t('changes.turn', { turn: file.turn })) : null,
                busyPath === file.path ? h('span', { className: 'dsh-ide-bridge-turn' }, t('changes.opening')) : null,
              ),
              h(
                'div',
                { className: 'dsh-ide-bridge-row-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ide-bridge-btn dsh-ide-bridge-btn-compact',
                    title: t('changes.preview'),
                    'aria-label': t('changes.preview'),
                    onClick: (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      previewRow(file)
                    },
                  },
                  h(PreviewGlyph, { size: 15 }),
                ),
              ),
            ),
          ),
          data && data.recorded === false ? h('div', { className: 'dsh-ide-bridge-foot-note' }, t('changes.notRecorded')) : null,
          h('div', { className: 'dsh-ide-bridge-foot-note' }, t('changes.foot', { count: files.length })),
        )
      }
      return h(
        'div',
        { className: 'dsh-ide-bridge-changes' },
        h(
          'div',
          { className: 'dsh-ide-bridge-changes-header' },
          h('span', { className: 'dsh-ide-bridge-changes-title' }, t('changes.title')),
          files.length > 0 ? h('span', { className: 'dsh-ide-bridge-changes-count' }, String(files.length)) : null,
          h('span', { className: 'dsh-ide-bridge-spacer' }),
          folderButton,
          refreshButton,
        ),
        error ? h('div', { className: 'dsh-ide-bridge-error' }, error) : null,
        body,
      )
    }

    /** Document-preview header contribution: open the previewed file externally. */
    function DocumentEditorActions(props) {
      const { absolutePath, sessionId, t } = props
      const snapshot = useEditors()
      if (!absolutePath) return null
      const editors = availableEditors(snapshot.editors)
      if (editors.length === 0) return null
      return h(
        'div',
        { className: 'dsh-ide-bridge-inline' },
        editors.map((editor) =>
          h(EditorActionButton, {
            key: editor.id,
            editor,
            compact: true,
            label: t('action.openIn', { name: editor.label }),
            title: t('action.openIn', { name: editor.label }),
            onRun: () => openInEditor(editor, sessionId, absolutePath),
          }),
        ),
      )
    }

    /** Files-tree header contribution: open the displayed folder externally. */
    function FolderEditorAction(props) {
      const { absolutePath, sessionId, t } = props
      const snapshot = useEditors()
      const editor = primaryEditor(snapshot.editors)
      if (!absolutePath || !editor) return null
      const label = t('action.openFolder', { name: editor.label })
      return h(EditorActionButton, {
        editor,
        compact: true,
        label,
        title: label,
        onRun: () => openFolderInEditor(editor, sessionId, absolutePath),
      })
    }

    /** Services this plugin needs before it can activate. */
    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

    /**
     * Client plugin body: register dictionaries, the two tab types, their bodies,
     * and the small action seats that open a known file externally.
     * @param ctx - client root context carrying the slot, locale, tab and Remote registries.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      const openPreview = (address) => {
        try {
          ctx.sidebarRight.openResource(address, { kind: 'text' })
        } catch {
          /* the shipped text preview does not claim this address */
        }
      }
      const openResource = (address, line) => {
        try {
          ctx.sidebarRight.openResource(address, Number.isInteger(line) && line > 0 ? { params: { line } } : undefined)
        } catch {
          /* no controller surface for this address */
        }
      }
      const bodyInject = () => ({ openPreview, openResource })
      ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'ide-bridge: zh dictionary')
      ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'ide-bridge: en dictionary')
      ctx.effect(() => installStyles(), 'ide-bridge: styles')
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: CODE_ID,
            kind: CODE_KIND,
            keepMounted: true,
            patterns: ['dsh-resource://file/**'],
            priority: 'extension',
            canOpen: (address) => isCodeAddress(address),
            title: (address) => {
              const parsed = splitAddress(address)
              return parsed ? basenameOf(parsed.path) : 'File'
            },
          }),
        'ide-bridge: code tab type',
      )
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: CHANGES_ID,
            kind: CHANGES_KIND,
            keepMounted: true,
            title: () => t('changes.title'),
            guide: [
              {
                id: 'changes',
                order: 40,
                icon: GuideIcon,
                title: () => t('changes.title'),
                description: () => t('changes.description'),
              },
            ],
          }),
        'ide-bridge: changes tab type',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: CODE_ID,
                locale: NS,
                inject: bodyInject,
              },
              MirrorCodeEditor,
            ),
          ),
        'ide-bridge: code tab body',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: CHANGES_ID,
                locale: NS,
                inject: bodyInject,
              },
              ChangesPanel,
            ),
          ),
        'ide-bridge: changes tab body',
      )
      for (const slot of ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document.unpreviewable']) {
        ctx.effect(
          () =>
            ctx.slots.inject(slot, () =>
              ctx.slots.register({ name: slot, id: 'ide-bridge', order: 20, locale: NS }, DocumentEditorActions),
            ),
          'ide-bridge: ' + slot,
        )
      }
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.tab.files.actions', () =>
            ctx.slots.register({ name: 'sidebar.right.tab.files.actions', id: 'ide-bridge', order: 20, locale: NS }, FolderEditorAction),
          ),
        'ide-bridge: files actions',
      )
    }

    return { inject, apply }
  },
})
