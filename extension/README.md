# DSH IDE Mirror

把当前 VS Code / Cursor 编辑的文档实时镜像到 DeepSeek Harness 右侧栏，并把右侧栏的编辑、保存、定位命令应用回本编辑器。

- 由 DSH 插件 `dsh-ide-bridge` 自动生成连接描述文件：`~/.dsh/cache/ide-bridge/bridge.json`（URL + 随机 token），扩展启动后自动读取并重连。
- 状态栏出现 `$(radio-tower) DSH 镜像` 表示已连接；`$(debug-disconnect) DSH 镜像` 表示 DSH 未运行并会在后台重试。
- 命令面板：`DSH: 重新连接编辑器镜像`、`DSH: 查看编辑器镜像状态`。
- 设置：`dshMirror.enabled`（默认 true）、`dshMirror.bridgeFile`（自定义描述文件路径）。

卸载：`code --uninstall-extension dsh-local.dsh-ide-mirror`（Cursor 同理，去掉 `--uninstall-extension` 前的编辑器名即可）。
