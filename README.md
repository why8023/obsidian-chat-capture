# OBAR

OBAR 是一个 Obsidian 桌面端社区插件，用来把 Obsidian 内置 **Web Viewer** 中的 ChatGPT 会话保存成 Markdown 记录。

它不是浏览器扩展，也不是通过网络 API 拉取聊天内容。当前实现是在 Web Viewer 页面内注入轻量采集脚本，提取消息壳和消息 HTML，再由插件侧用 Defuddle 清洗成 Markdown，最后写回 Vault。

## 功能概览

- 打开或绑定一个匹配规则中的 ChatGPT Web Viewer 标签页
- 在后台自动监控当前会话，并在内容变化后增量采集
- 优先通过回复完成动作判断 Assistant 已结束输出，减少流式输出中的中间态覆盖
- 将每个会话保存为单独的 Markdown 记录，并根据 frontmatter 重新识别已有记录
- 支持按 URL 前缀配置不同保存目录，匹配时使用最长前缀优先
- 支持在记录中插入自定义 note 区块，后续同步时保留这些人工内容
- 支持保存后顺序执行一组 Obsidian 命令，方便做自动整理或二次处理
- 提供状态栏提示、通知、原始快照和运行时错误转储，便于排查问题

## 当前实现特点

- 当前内置 DOM 选择器面向 ChatGPT Web 页面，默认规则是 `https://chatgpt.com/ -> chatgpt/`
- 设置页里虽然支持配置多个 URL 前缀规则，但“能匹配 URL”不等于“已经适配该站点 DOM”
- 插件自身不上传会话内容，也不依赖外部云服务
- 仅支持桌面端，`manifest.json` 已声明 `isDesktopOnly: true`

## 工作流程

1. 在设置中配置一个或多个 URL 前缀和保存目录。
2. 运行 `Open configured chat web viewer`，或手动打开一个匹配规则的 Web Viewer 后运行 `Bind current chat web viewer`。
3. 插件定位到对应 `webview`，在页面中注入采集脚本，并持续监听页面变化。
4. 页面侧只维护“消息壳 + 内容 HTML”快照；插件侧再把 HTML 转成 Markdown，并做归一化和稳定性判定。
5. 当快照可保存时，OBAR 会创建或更新对应 Markdown 记录，并按需打开笔记或执行后处理命令。

## 快速开始

1. 将发布产物放到：

```text
<Vault>/.obsidian/plugins/obar/
```

需要的文件：

- `main.js`
- `manifest.json`
- `styles.css`

2. 在 Obsidian 中前往 **Settings → Community plugins** 启用插件。
3. 打开插件设置，确认至少有一条有效规则，例如：

```text
https://chatgpt.com/ -> chatgpt
```

4. 执行以下任一命令：

- `Open configured chat web viewer`
- `Bind current chat web viewer`

5. 正常使用 ChatGPT。开启 `Auto capture` 时，插件会自动在后台保存；也可以手动执行 `Save current session`。

## 命令

- `Open configured chat web viewer`
  打开第一条有效规则的 URL，并将该 Web Viewer 设为当前优先采集对象。
- `Bind current chat web viewer`
  将当前活动标签页绑定为采集目标。只有 URL 命中已配置规则时才会成功。
- `Save current session`
  强制执行一次采集并尝试立即保存。它会跳过回复判稳等待，但如果页面还没有稳定的 session ID，仍然不会写盘。
- `Open current session record`
  打开当前会话对应的 Markdown 记录；如果还没有记录，会先保存再打开。
- `Insert custom note`
  在当前编辑器插入自定义 note 标记；如果有选中文本，会直接用 note 标记包裹选中内容。
- `Pause auto capture`
  暂停后台自动采集。
- `Resume auto capture`
  恢复后台自动采集。

## 设置项

### 常规

- `AI match rules`
  为每个 URL 前缀配置一个保存目录。匹配时使用最长前缀优先。
- `File name template`
  支持 `{{date}}`、`{{title}}`、`{{key}}` 三个占位符。

### 输出格式

- `Message heading summary length`
  控制每条消息标题里追加到 `USER` / `AI` 后的摘要长度。
- `Open note after save`
  每次创建或更新记录后自动打开该 Markdown 笔记。

### 保存后处理

- `Run post-processing commands`
  启用后，会在保存完成后按顺序执行已配置的 Obsidian 命令。
- `Post-processing commands`
  从 Obsidian 当前已注册命令里选择命令 ID，执行顺序与列表顺序一致。
- `Open generated note before running`
  如果后处理命令依赖当前活动笔记或编辑器，建议开启。

### 自动采集

- `Auto capture`
  后台持续轮询当前受控的 Web Viewer。
- `Poll interval`
  自动采集轮询间隔，默认 `1500ms`。
- `Settle repeat count`
  如果页面上没有检测到回复完成动作，回退到文本判稳时需要重复采到相同内容的次数，默认 `2`。
- `Settle timeout`
  如果页面上没有检测到回复完成动作，最多等待多久后按稳定处理，默认 `3000ms`。

### 调试与诊断

- `Save raw snapshots`
  保存最近一次原始快照和归一化快照。
- `HTML snippet limit`
  每条消息最多保留多少原始 HTML 调试片段。
- `Debug mode`
  记录更详细的日志，并在出错时转储更多运行时状态。

## 输出文件格式

### 保存目录与文件名

- 保存目录由命中的 URL 规则决定
- 默认保存目录是 `chatgpt/`
- 文件名模板默认是 `{{date}}_{{title}}`
- 如果文件名冲突，会自动追加 `session key` 的短前缀

### frontmatter

每条记录至少会写入这些字段：

```yaml
---
obar_source: "obar-chatgpt-webviewer"
obar_session_key: "..."
obar_session_title: "..."
obar_session_url: "https://chatgpt.com/c/..."
obar_record_created_at: "2026-03-29T19:47:12.345+08:00"
obar_record_updated_at: "2026-03-29T19:50:43.012+08:00"
obar_record_message_count: 12
obar_extractor_version: "0.4.0"
obar_session_state: "session"
obar_session_id: "..."
---
```

OBAR 现在通过这些 frontmatter 字段和记录索引来判断某个会话是否已经存在，而不是在 `data.json` 里维护一份持久化的 session 表。

### 正文结构

正文按消息块写入。每条消息都会带一对隐藏锚点注释，用来帮助后续增量匹配和保留自定义 note：

```md
<!-- OBAR-RECORD-START:{"matchKey":"...","role":"user","contentHtmlHash":"..."} -->
# USER: 帮我总结一下这个插件

这里是消息正文。
<!-- OBAR-RECORD-END -->

<!-- OBAR-RECORD-START:{"matchKey":"...","role":"ai","contentHtmlHash":"..."} -->
# AI: 这是插件的总结

这里是回复正文。
<!-- OBAR-RECORD-END -->
```

说明：

- 每条消息标题是 `# USER: ...` 或 `# AI: ...`
- 标题摘要来自消息正文提取出的单行摘要
- 消息正文里原本的一级标题会自动下调一级，避免和消息标题冲突
- 如果你希望后续同步更稳定，不要手动删除 `OBAR-RECORD-START` / `OBAR-RECORD-END` 注释

### 自定义 note 区块

如果你想在记录中插入“由用户维护、后续更新时尽量保留”的内容，可以使用：

```md
<!-- obar-note-start:7K4M9Q2X8D2M-->
这里的内容会在后续同步时尽量保留。
<!-- obar-note-end:7K4M9Q2X8D2M-->
```

最方便的方式是直接运行 `Insert custom note` 命令。

## 调试输出

开启 `Save raw snapshots` 或 `Debug mode` 后，插件会在自身目录下写出调试文件：

```text
.obsidian/plugins/obar/debug/
```

常见文件：

- `last-raw-snapshot.json`
- `last-normalized-snapshot.json`
- `runtime-state.json`

其中 `runtime-state.json` 主要用于记录采集失败时的运行时上下文和最近日志。

## 数据持久化

`data.json` 目前只保存：

- 插件设置
- 自动采集是否处于暂停状态

真正的会话记录是否存在、对应到哪个文件，主要以保存目录中的 Markdown 记录和 frontmatter 为准。

## 当前限制

- 仅支持桌面端 Obsidian
- 仅支持通过 Obsidian Web Viewer 打开的页面
- 当前默认采集器只适配 ChatGPT Web 页面结构
- 页面 DOM 大改版后，可能需要更新选择器或采集逻辑
- 目前没有对图片、附件、复杂富文本和分支对话树做专门建模
- 自动同步以“当前稳定快照”为准，不保留逐次流式中间版本

## 项目结构

```text
src/
  capture/
  commands/
  debug/
  persistence/
  post-processing/
  runtime/
  settings/
  ui/
  webviewer/
  constants.ts
  main.ts
  message-anchor.ts
  types.ts
```

## 开发

安装依赖：

```bash
npm install
```

开发模式：

```bash
npm run dev
```

生产构建：

```bash
npm run build
```

Lint：

```bash
npm run lint
```

## 发布

当前仓库包含自动发布流程，常见步骤如下：

1. 更新版本号：

```bash
npm version patch
```

也可以改用 `minor` 或 `major`。

2. 推送代码和 tag：

```bash
git push origin main --follow-tags
```

3. GitHub Actions 会执行构建、校验版本一致性，并上传：

- `main.js`
- `manifest.json`
- `styles.css`

## 许可证

`0-BSD`
