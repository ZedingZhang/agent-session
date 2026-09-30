# Agent Session

[English](README.md)

一个用 TypeScript 实现的本地 Agent 会话库。通过独立 adapter 将不同 Agent 的会话转换为统一的 **JSONL 事件流**，在 CLI 查看历史，并在本地文件库之间合并同步。无需服务端或数据库，MIT 开源。

MVP 支持 DeepSeek Harness 原生会话日志 / Web 导出 ZIP、通用 JSON / JSONL、Markdown 会话、TypeScript SDK 和外部 ESM adapter 插件。需要 **Node.js 24+**。

## 快速开始

```sh
git clone https://github.com/ZedingZhang/agent-session.git
cd agent-session
npm ci
npm run build
npm link

agent-session init
agent-session import examples/conversation.md
agent-session import examples/conversation.json
agent-session import examples/deepseek-session.jsonl
agent-session history
agent-session show <会话ID前缀>
```

暂未发布 npm 包，通过源码安装；也可以将 `agent-session` 替换为 `node dist/cli.js`。

## 常用命令

```sh
agent-session --library ./my-library import session.json --adapter json
agent-session import session.v4.jsonl --adapter deepseek-harness
agent-session import dsh-session-example.zip
agent-session list --adapter deepseek-harness --query README
agent-session list --json
agent-session show <id> --all
agent-session show <id> --json
agent-session export <id> --output session.jsonl
agent-session --library ./my-library sync ./other-library
agent-session adapters
```

`history` 是 `list` 的别名。会话 ID 支持至少 8 位、无歧义的小写十六进制前缀。默认显示消息和工具事件，`--all` 还显示源生命周期与未知事件。`show --json` 输出 JSONL，`list --json` 输出 JSON 数组。导出文件拒绝覆盖已有文件。

默认库目录为 `~/.agent-session`，可用 `AGENT_SESSION_HOME` 环境变量或 `--library` 更改。CLI 不调用 Agent API，也不上传会话。

## 输入格式

| Adapter | 支持内容 |
| --- | --- |
| `deepseek-harness` | `session[.vN].jsonl`、`{header, events}` JSON、Web 导出 ZIP；读取 1–4 版本 header |
| `json` | 消息数组、`{title, messages}`、`{events}`、单条消息、JSONL；消息需要 `role` 和 `content` |
| `markdown` | 使用 `## User`、`## Assistant`、`## System`、`## Developer`、`## Tool` 标题分隔的文本，也支持 `Human` |

优先自动识别 DeepSeek，再匹配通用 JSON。Markdown 代码围栏中的角色标题不会被误切分，消息首尾空白会被裁剪，序言保存在源 metadata 中。JSON 消息的扩展字段保存在 `raw`。

DeepSeek 实现参考官方原生事件与导出源码，测试覆盖 v4 原生工具消息和 v3 旧工具结果包装。旧版本或未识别的形状保留为 `source.event`，不执行 Harness 迁移引擎。ZIP 的主会话和子会话分别入库；**MVP 不保存附件二进制**，保留原始附件引用并显示提示。不支持直接读取 `.jsonl.zstd`，请使用 Harness 导出日志。默认文件大小及 ZIP 日志解压总大小上限为 64 MiB。更高版本的日志会在写入前报错。

## 统一 Schema 与存储

每个事件包含 `schemaVersion`、`sessionId`、`eventId`、`seq`、`timestamp`、`type`、`data`。顺序以 `seq` 为准，没有历史时间时使用 `null`。

事件类型：`session.imported`、`message`、`tool.call`、`tool.result`、`source.event`。第 0 条记录保存标题、adapter 名称与版本、源格式与摘要、源会话 ID 以及 metadata。未知事件、工具元数据、推理与用量等保留在原始数据中。详见 [Schema 设计](docs/session-schema.md) 和 [JSON Schema](schema/session-event.v1.schema.json)。

```text
<library>/sessions/<sha256-session-id>.jsonl
```

会话以不可变导入快照保存，内容哈希标识快照，相同内容、标题与 adapter 版本重复导入会去重；文件名作为默认标题时，重命名源文件会影响 ID。会话继续增长后再次导入产生新快照。统一格式导出再导入保持 ID。

`sync` 在两个本地文件库之间双向合并，验证顺序与哈希，不删除会话，不覆盖冲突。临时文件通过硬链接原子发布，支持并发去重。需要支持硬链接的文件系统，如 NTFS、ext4、APFS；不支持 FAT/exFAT 或某些网络挂载。多文件合并不具备整体事务性，I/O 失败后可以安全重试。跨设备可以先使用文件传输工具复制库，再合并本地副本。

历史查看展示按源顺序归档的事件；fork 继承和 `surfaceOp` 编辑保留在原始字段中，MVP 不重建 Agent 运行时的最终可见上下文。

## 社区 Adapter

每个 adapter 实现 `SessionAdapter` 接口：`id`、`version`、`description`、`detect(input)`、`parse(input)`。可加载 ESM 文件或已安装的 npm 包：

```sh
agent-session --plugin ./examples/custom-adapter.mjs import notes.txt --adapter notes
```

插件会在 Node 进程执行，仅加载信任的插件。参考 [Adapter 开发指南](docs/adapters.md)、[示例插件](examples/custom-adapter.mjs) 和 [贡献指南](CONTRIBUTING.md)。SDK 导出运行时校验 Schema、registry、导入与文件库存储接口。

## 开发验证

```sh
npm ci
npm run check
npm run schema
npm pack --dry-run
```

CI 配置覆盖 Linux、macOS、Windows，使用 Node 24 / 26。后续方向包括增量采集、可重建搜索索引、附件归档、更多社区 adapter 和会话谱系浏览。
