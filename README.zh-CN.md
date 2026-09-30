# Agent Session

[English](README.md)

一个用 TypeScript 实现的本地 Agent 会话库。通过独立 adapter 将不同 Agent 的会话转换为统一的 **JSONL 事件流**，在 CLI 查看历史，并在本地文件库之间合并同步。无需服务端或数据库，MIT 开源。

MVP 支持 DeepSeek Harness 原生 JSONL / Zstandard 会话日志、会话目录和导出 ZIP、通用 JSON / JSONL、Markdown 会话、CLI 时间线与定时回放、TypeScript SDK 和外部 ESM adapter 插件。需要 **Node.js 24+**。

## 快速开始

### Windows PowerShell

使用 `npm.cmd`，避免 PowerShell 选择可能被脚本执行策略拦截的 `npm.ps1`。无需修改系统执行策略。下面直接用 `node` 运行 CLI，不需要先执行 `npm link`。

```powershell
git clone https://github.com/ZedingZhang/agent-session.git
cd agent-session
npm.cmd ci
npm.cmd --silent run build

node dist/cli.js init
node dist/cli.js import examples/conversation.md
node dist/cli.js import examples/conversation.json
node dist/cli.js import examples/deepseek-session.jsonl
node dist/cli.js history
```

从历史列表复制 ID 前缀，再执行 `node dist/cli.js show YOUR_ID_PREFIX`，将 `YOUR_ID_PREFIX` 替换为实际值。已有本地仓库时，进入仓库目录并跳过 `git clone`。

静默构建会省略 npm 的脚本标题，成功时通常没有输出。等 PowerShell 提示符返回后再输入下一条命令；`$LASTEXITCODE` 应为 `0`。如果希望注册 CLI，可执行 `npm.cmd link`，然后在 PowerShell 使用 `agent-session.cmd`，同样避开其 `.ps1` 启动脚本。

### macOS / Linux

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

### 终端输出重叠

如果构建输出与下一行提示符或输入的命令重叠，PowerShell 可使用 `npm.cmd --silent run build`；macOS/Linux 对应 `npm --silent run build`。这会省略 npm 的脚本标题，TypeScript 编译错误仍会显示。项目同时关闭 npm 的颜色/进度显示和 TypeScript 的格式化诊断，减少终端格式控制。如果仍然重叠，可在新的独立 PowerShell 窗口运行同一命令，对比终端渲染与构建行为。目前未在我们的终端复现重叠现象，这些设置属于绕过方式，尚不能认定修复了特定终端的渲染问题。

## 常用命令

```sh
agent-session --library ./my-library import session.json --adapter json
agent-session import session.v4.jsonl --adapter deepseek-harness
agent-session import session.v4.jsonl.zstd
agent-session import dsh-session-example.zip
agent-session list --adapter deepseek-harness --query README
agent-session list --json
agent-session show <id> --all
agent-session show <id> --replay --speed 4
agent-session show <id> --verbose --timezone UTC
agent-session show <id> --json
agent-session export <id> --output session.jsonl
agent-session export <id> --format markdown --output session.md
agent-session export <id> --format json --output session.json
agent-session --library ./my-library sync ./other-library
agent-session adapters
```

`history` 是 `list` 的别名。会话 ID 支持至少 8 位、无歧义的小写十六进制前缀。`show` 默认显示可读时间线，包含消息、工具、Shell 命令、结果和已记录的 diff；`--all` 还显示源生命周期与未知事件。`show --json` 输出原始统一 JSONL，`list --json` 输出 JSON 数组。导出文件拒绝覆盖已有文件。

默认库目录为 `~/.agent-session`，可用 `AGENT_SESSION_HOME` 环境变量或 `--library` 更改。CLI 不调用 Agent API，也不上传会话。

## 导出选定会话

先用 `history` 找到会话，也可以通过 `--query` 按标题过滤，再把完整 ID 或无歧义前缀传给 `export`：

```powershell
node dist/cli.js history
# 将 YOUR_SESSION_ID 替换为选中的会话 ID 或前缀
node dist/cli.js export YOUR_SESSION_ID --format markdown --output session.md
node dist/cli.js export YOUR_SESSION_ID --format json --output session.json

# 也可以根据文件扩展名自动选择格式
node dist/cli.js export YOUR_SESSION_ID -o session.md --timezone Asia/Singapore
node dist/cli.js export YOUR_SESSION_ID -o session.json
```

| 格式 | 文件内容 | 再导入 |
| --- | --- | --- |
| `markdown`，也可写 `md` | 可读报告：会话信息、带时间的消息、完整工具参数与结果、已记录的 diff | 展示报告；恢复归档请使用 JSON / JSONL |
| `json` | 一个格式化 JSON 文档，包含 `format`、`schemaVersion`、`sessionId`、`metadata` 和所有原始 `events` | 无损，校验并保持原会话 ID |
| `jsonl` | 原有统一事件流，每行一个 JSON 对象 | 无损，兼容原有行为 |

Markdown 不采用 CLI 的工具输出预览截断，消息和工具内容完整导出。`--all` 可加入源生命周期及未知事件，`--timezone UTC` 可指定显示时区。内容放在代码围栏中，避免原始 Markdown 标题、HTML 或嵌套代码围栏破坏报告结构；可读报告会移除终端控制序列，JSON / JSONL 则保留原始内容。Markdown 不推断缺失 diff，也不重建源运行时上下文。

显式 `--format` 优先于文件扩展名。不指定时，`.md` / `.markdown` 选择 Markdown，`.json` 选择 JSON，其余默认 JSONL。不提供 `--output` 时输出到终端。文件使用 UTF-8，父目录需要已存在，拒绝覆盖已有文件。导出的 JSON 可以直接通过 `agent-session import session.json` 再导入，无需指定 adapter。更多规则见 [导出说明](docs/exports.md)。

## 会话过程展示与回放

`show <id>` 会立即按归档顺序打印会话过程，通过 `callId` 关联工具调用和结果，并读取 DSH 的结果 metadata。Shell 即便记录为 `isError: false`，仍会识别输出中的非零退出码。已有导入会话可直接使用，无需重新导入；此功能只增加显示投影，未改变存储 Schema。

可以用虚构的登录修复示例体验：

```powershell
node dist/cli.js import examples/login-replay.jsonl
node dist/cli.js history --query "修复登录跳转问题"
# 将 YOUR_ID_PREFIX 替换为历史列表里的 ID
node dist/cli.js show YOUR_ID_PREFIX --timezone Asia/Singapore
node dist/cli.js show YOUR_ID_PREFIX --replay --speed 4
```

```text
[10:00:01] User: 帮我修复登录跳转问题
[10:00:03] Agent: 我先查看认证逻辑
[10:00:04] Tool: read_file src/auth/login.ts
[10:00:06] Tool result: 245 lines
[10:00:10] Tool: write_file src/auth/login.ts
[10:00:11] Tool result: Updated file
[10:00:11] Diff: src/auth/login.ts
- redirect('/login')
+ redirect('/dashboard')
[10:00:15] Shell: npm test
[10:00:21] Test failed: Expected /dashboard but received /login
[exit code: 1]
```

`--replay` 会按原始时间间隔逐条输出，相邻间隔除以 `--speed`（默认 `1`）。每次等待最多 `--max-delay` 秒（默认 `2`），设为 `0` 可立即播放；Ctrl+C 停止。回放展示记录，不执行 Shell 命令，也不应用文件修改。

默认使用系统时区，可通过 `--timezone Asia/Singapore` 或 `--timezone UTC` 指定。会话跨越多天时，时间戳自动包含日期。缺少时间显示 `[unknown time]`，缺失或倒退的时间戳不会改变事件顺序，也不会增加等待。

工具输出默认摘要显示：读文件行数来自记录的 metadata，较长失败输出优先展示诊断片段。`--verbose` 显示完整工具参数、结果和 diff。Diff 只使用已记录的 `meta.diffs`、明确的 before/after 或结果 patch，不根据调用参数或当前文件内容猜测旧状态。缺少修改数据时不会合成 diff。已识别的测试命令返回非零记录退出码时显示 `Test failed`；没有退出码时依据明确的失败诊断识别。具体规则与限制见 [回放说明](docs/replay.md)。

## 输入格式

| Adapter | 支持内容 |
| --- | --- |
| `deepseek-harness` | 原生 `session[.vN].jsonl[.zstd]`、`{header, events}` JSON、会话目录或导出 ZIP；读取 0–4 版本 header |
| `json` | 消息数组、`{title, messages}`、`{events}`、单条消息、JSONL；消息需要 `role` 和 `content` |
| `markdown` | 使用 `## User`、`## Assistant`、`## System`、`## Developer`、`## Tool` 标题分隔的文本，也支持 `Human` |

优先自动识别 DeepSeek，再匹配通用 JSON。Markdown 代码围栏中的角色标题不会被误切分，消息首尾空白会被裁剪，序言保存在源 metadata 中。JSON 消息的扩展字段保存在 `raw`。

DeepSeek 实现参考官方原生事件与导出源码，测试覆盖 v4 原生工具消息、v3 旧工具结果包装和 v0 紧凑批次。紧凑 chunk 批次以完整 `source.event` 保留原始数组和 `time0` 时间，不展开为合成消息。其他未识别的形状也保留为 `source.event`，不执行 Harness 迁移引擎。

### 直接导入 DeepSeek Harness 本地数据

不需要导出按钮或导出插件，可以直接读取压缩持久化日志，也可以导入整个会话目录：

```powershell
# Windows PowerShell：默认本地 DSH 会话目录
node dist/cli.js import "$env:USERPROFILE\.dsh\sessions"
node dist/cli.js history

# 导入单个文件，替换为实际文件路径
node dist/cli.js import "C:\path\to\session.v4.jsonl.zstd"
```

```sh
# macOS / Linux；自定义安装请改用配置的持久化根目录
node dist/cli.js import "$HOME/.dsh/sessions"
```

目录导入会递归发现 `session[.vN].jsonl[.zstd]`，在每个会话目录中选择最高版本；同版本同时存在压缩和未压缩文件时，优先压缩文件。无关文件会被忽略，不遍历符号链接目录。旧版本仍可通过指定文件路径单独导入。遇到错误会停止目录导入，保留此前成功的会话，重新运行会自动去重。

DSH 压缩日志是多个独立 Zstandard 帧的拼接：一个 header 帧，后续每个 append 批次一个帧。实现按帧头和 block 长度定位边界，调用 Node 自带 `zlib.zstdDecompressSync` **逐帧解压全部数据**，没有新增压缩依赖。受影响的 Node 版本对整个拼接文件只调用一次可能仅返回第一帧。标准可跳过帧会被跳过，尾帧截断、格式损坏和校验失败会明确报错，不会静默保存只有 header 或部分历史的会话。每个文件完整解码、转换后才写入；相同日志的压缩与未压缩形式具有相同 ID。

ZIP 的主会话和子会话分别入库，读取其中未压缩日志。**MVP 不保存附件二进制**，保留原始附件引用，ZIP 导入会显示提示。输入文件、Zstandard 解压后的文本，以及 ZIP 日志解压总大小分别默认限制为 64 MiB，SDK 可通过 `maxBytes` 调整；目录导入按每个选中文件计算上限。更高版本日志会在对应文件或 ZIP 写入前报错。

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

插件会在 Node 进程执行，仅加载信任的插件。参考 [Adapter 开发指南](docs/adapters.md)、[示例插件](examples/custom-adapter.mjs) 和 [贡献指南](CONTRIBUTING.md)。SDK 导出运行时校验 Schema、registry、导入与文件库存储接口，以及 `projectTimeline`、`formatTimelineEntry`、`timelineSpansDays` 和异步 `replayTimeline`。

SDK 的 `exportSession(events, format, {timeZone, all})` 返回 Markdown / JSON / JSONL 文本；`parseSessionJson(text)` 可以恢复无损 JSON 文档，并提供 `sessionJsonSchema` 运行时校验器。

## 开发验证

Windows PowerShell：

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run schema
npm.cmd pack --dry-run
```

macOS/Linux：

```sh
npm ci
npm run check
npm run schema
npm pack --dry-run
```

CI 配置覆盖 Linux、macOS、Windows，使用 Node 24 / 26。后续方向包括增量采集、可重建搜索索引、附件归档、更多社区 adapter 和会话谱系浏览。
