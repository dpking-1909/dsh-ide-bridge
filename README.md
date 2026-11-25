# DSH IDE Bridge

Right-sidebar code workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH):
edit workspace files **inside the Web GUI**, keep them **mirrored with your local VS Code / Cursor**, and jump to
changed files in one click.

```
┌──────────────────────────── DSH Web (127.0.0.1:3080) ────────────────────────────┐
│  conversation                 │  right sidebar                                     │
│                               │  ┌──────────────────────────────────────────────┐  │
│                               │  │ name.ts  dir/          [VS Code][Cursor][⟳][⤓]│  │
│                               │  │  1  import ...                                │  │
│                               │  │  2  export function ...   ← mirrored document │  │
│                               │  └──────────────────────────────────────────────┘  │
└───────────────────────────────────────┬──────────────────────────────────────────┘
                                        │ authenticated /api/ide-bridge.mirror*
                                        ▼
                        ┌─────────────────────────────────┐
                        │ DSH Host: dsh-ide-bridge         │
                        │  mirror hub + command queue      │
                        │  bridge.json (URL + token)       │
                        └──────────────┬──────────────────┘
                                       │ loopback /ide-bridge/{push,commands}
                                       ▼
                        ┌─────────────────────────────────┐
                        │ VS Code / Cursor extension       │
                        │  pushes document, cursor, dirty  │
                        │  applies open / edit / save      │
                        └─────────────────────────────────┘
```

## Features

- **In-place code editor in the right sidebar** — line numbers, lightweight syntax highlighting, find-free keyboard
  editing (Tab indent, Enter keeps indentation), `Ctrl+S` to save.
- **Editor-process mirror** — when VS Code or Cursor has the file open, the sidebar shows that document and keeps both
  sides in sync. Sidebar edits are applied to the editor buffer (undoable); editor edits arrive within ~0.5 s.
- **Changed-files panel** — the last few turns' edited files, with `+/−` counts, click to open (and reveal the first
  changed line). Falls back to `write` / `edit` tool calls when the Host keeps no change record.
- **External editor toolbar** — VS Code / Cursor buttons in the editor header, launching the local CLI at the current
  line (`--goto file:line:col --reuse-window`); no shell involved.
- **Stable mirror selection** — the extension polls the bridge as a heartbeat, so an idle editor stays connected; the
  Host prefers the instance whose active document matches the requested path, the browser pins that instance, and a
  three-poll hysteresis keeps the last mirrored content through transient misses.
- **Explanatory fallback** — when no editor can mirror the file the pane says why and offers *open in editor*,
  *read-only preview* and *retry* instead of silently switching editing backends.

## Requirements

| Part | Requirement |
| --- | --- |
| Harness | a Web profile (`dsh web`), Node `^22` or `>=24` |
| Editor | VS Code (tested 1.142) or Cursor (tested 3.32); both are VS Code forks and share the extension |
| Platform | Windows is the tested target; path normalisation is written to stay cross-platform |

## Install

### 1. The DSH plugin (this package)

The package is a local bundle: `package.json` declares `dsh.bundle.patch` and `dsh.client`.

```text
plugin_manager install_bundle  target: <absolute path to this directory>
```

or add it to the profile's `package.json` bundles and `cordis.patch.yml` by hand. It ships:

- a Host half: `index.js` (routes), `mirror.js` (mirror hub), `editors.js` (editor discovery/launch);
- a browser half: `client.js` (tab types, editor pane, changed-files panel, action seats).

After installing, refresh the Web page. Guide entry **变更文件 / Changed files** appears in the right sidebar's
`+` menu; code files opened from the Files tab / chat links / tool results open in the in-place editor.

### 2. The bridge extension (VS Code / Cursor)

```bash
npm run build:vsix
code   --install-extension dist/dsh-ide-mirror-1.0.0.vsix --force
cursor --install-extension dist/dsh-ide-mirror-1.0.0.vsix --force
```

Reload the editor window (`Developer: Reload Window`). The status bar shows `DSH 镜像` / `DSH mirror`; it reconnects
automatically within ~3 s after a Harness restart. Cursor picks the extension up on its next start.

The extension connects to the descriptor the Host writes to `~/.dsh/cache/ide-bridge/bridge.json`
(URL + per-activation random token). No manual configuration is needed.

## Usage

1. Open a code file in VS Code/Cursor.
2. In the DSH right sidebar open the same file (Files tab, a chat file link, or the changed-files panel).
3. The sidebar footer reads **`VS Code 镜像` / `VS Code mirror`**; edit on either side and both stay in sync.
4. `保存 / Save` (or `Ctrl+S`) asks the editor to save; the dirty dot follows the editor document.
5. If the file is not open in the editor, the sidebar opens it there **without stealing focus** and then mirrors it.

When no editor is connected (extension disabled, editor closed, or the file cannot be mirrored) the pane explains the
reason and offers *open in editor*, *read-only preview* and *retry*. The plugin never edits files on disk on its own.

## Configuration

DSH plugin row (`cordis.patch.yml`):

```yaml
- id: ide-bridge
  name: dsh-ide-bridge
  config:
    defaultEditor: vscode   # primary toolbar editor
    maxTurns: 5             # turns merged by the changed-files panel
    # editors:              # optional custom list, replaces the built-in probe
    #   - id: windsurf
    #     label: Windsurf
    #     exe: 'C:\Users\me\AppData\Local\Programs\Windsurf\Windsurf.exe'
```

Extension settings: `dshMirror.enabled` (default `true`), `dshMirror.bridgeFile` (override descriptor path).

## Protocols

Host routes served for the browser (inside the authenticated `/api` fence):

| Route | Purpose |
| --- | --- |
| `GET /api/ide-bridge.mirror` | mirrored document snapshot for a path (optional `instanceId` pin) |
| `POST /api/ide-bridge.mirror-command` | queue `open` / `edit` / `save` for the editor |
| `GET /api/ide-bridge.changes` | changed files merged over recent turns |
| `POST /api/ide-bridge.open` / `.open-folder` | launch the local editor |
| `GET /api/ide-bridge.editors` | detected editors |

Bridge routes for the extension (loopback, `x-dsh-token` guarded): `POST /ide-bridge/push`,
`GET /ide-bridge/commands`, `GET /ide-bridge/health`.

Command payloads the extension understands:

```jsonc
{ "type": "open", "path": "D:/proj/a.ts", "line": 12, "preserveFocus": true }
{ "type": "edit", "path": "D:/proj/a.ts", "text": "...", "expectedVersion": 7, "force": false }
{ "type": "save", "path": "D:/proj/a.ts" }
```

## Security

- The bridge descriptor and its token live in the DSH home (`~/.dsh/cache/ide-bridge/bridge.json`) and are removed when
  the plugin unloads; the token is regenerated every activation.
- Bridge routes are served by the loopback Web server only and reject requests without the token. They are not part of
  the model-facing tool surface; nothing here appends session events or prompt text.
- The extension acts only on commands the Host queues from the authenticated browser surface.
- The plugin never writes workspace files itself: the editor process owns the buffers and performs saves, so the
  session's sandbox policy does not have to be widened for this feature.

## Limitations

- The mirror carries up to **1.5 M characters** per document; larger files mirror metadata only and must be edited in the
  editor.
- The pane cannot edit when no editor is connected; it explains the reason and offers a read-only preview instead.
- The extension targets the VS Code API (both VS Code and Cursor); it is not packaged on a marketplace.
- No iframe embedding is used: VS Code's web server refuses cross-origin framing (`X-Frame-Options: SAMEORIGIN`), so the
  mirror approach was chosen instead.

## Project layout

```
index.js              Host plugin: routes, owners, mirror API
mirror.js             Mirror hub: instances, snapshot, command queue, bridge descriptor
editors.js            Editor probe (CLI wrapper parsing / App Paths / PATH) and shell-free launch
client.js             Browser half: tab types, editor pane, changed-files panel, action seats
extension/            VS Code / Cursor extension source (plain CommonJS, no build step)
scripts/build-vsix.mjs  Minimal VSIX writer (no dependencies)
scripts/verify.mjs      Self-contained verification: host mirror protocol + browser-half registration
locale/{en,zh}.json   Plugin manager display metadata
cordis.patch.yml      Bundle patch inserting the Host row
```

## Verify

```bash
npm run check     # node --check every source file
npm run verify    # host mirror protocol + browser half registration
npm run build:vsix
```

## Uninstall

- DSH: disable/uninstall the `dsh-ide-bridge` bundle from Settings → Plugins.
- Editors: `code --uninstall-extension dsh-local.dsh-ide-mirror` (Cursor likewise).

## License

MIT — see [LICENSE](LICENSE).
