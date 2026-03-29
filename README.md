# OBAR

将 Obsidian 内置 **Web Viewer** 里的 ChatGPT `session` 抓取为 Markdown `record`，并持续增量更新。

当前实现不是浏览器扩展，也不是通过网络 API 拉取聊天记录，而是由插件在 Obsidian 桌面端绑定一个 ChatGPT Web Viewer，向其中注入轻量采集脚本，在页面内只维护“消息壳 + 内容 HTML”快照，再由宿主用低频心跳拉取结果，并在插件侧用 Defuddle 清洗成最终 Markdown 后写回文件。

## 功能概览

- 打开或绑定一个 ChatGPT Web Viewer 标签页
- 自动监控当前 `session` 内容，并在变化时增量采集
- 优先根据回复完成动作判定 Assistant 已完成，并保留文本判稳兜底，避免流式输出过程中频繁覆盖
- 将每个 `session` 保存为独立 Markdown `record`
- 通过 Markdown frontmatter + 内存 `session` 缓存做增量更新，避免重复写入
- 支持在记录文件中插入自定义 note 区域，并在后续更新时保留这些用户内容
- 提供日志、原始快照和运行时诊断，便于调试 DOM 选择器或 Web Viewer 问题

## 当前实现方案

### 1. 总体架构

代码按职责拆成了几层：

- `src/main.ts`
  负责插件生命周期、依赖装配、状态栏、Ribbon 图标、命令注册、设置页注册。
- `src/webviewer/`
  负责打开 Web Viewer、发现可用的 ChatGPT viewer、定位真正的 `webview` DOM 节点、监听导航和控制台事件。
- `src/capture/`
  负责构造注入脚本、在页面内收集消息壳、用 Defuddle 解析消息内容、规范化快照、判断回复是否稳定。
- `src/runtime/`
  负责自动采集主循环，包括绑定、注入、健康检查、事件驱动调度、回退重试、状态切换。
- `src/persistence/`
  负责文件路径生成、frontmatter 渲染、Markdown 写入、基于 record 元数据的索引维护。
- `src/debug/`
  负责内存日志和调试快照落盘。
- `src/settings/`
  负责设置模型、默认值和设置页 UI。

### 2. 运行流程

插件启动后的主流程如下：

1. `onload()` 读取 `data.json`，恢复设置和少量运行偏好。
2. 初始化 `Logger`、`DebugDumpWriter`、`RecordIndex`、`SessionIndex`、`MarkdownWriter`、`ViewerManager`、`RuntimeController`。
3. 注册命令、Ribbon 图标、设置页，以及 `active-leaf-change` 和 `layout-change` 监听。
4. 启动时扫描保存目录中的 Markdown 笔记，并通过 `MetadataCache` / `Vault` 事件持续维护内存索引。
5. 如果开启了 `autoCapture` 且没有暂停，运行时控制器开始低频心跳，并在页面变化、导航、重新激活时立即补采。
6. 每次采集都会经历：定位 Web Viewer -> 注入或复用采集脚本 -> 先做轻量健康检查 -> 必要时收集快照 -> 归一化 -> 稳定性判定 -> 写入 Markdown -> 更新索引。

这套设计的关键点是：插件并不直接依赖某个固定 DOM 节点，而是先定位 Web Viewer，再在页面上下文内执行采集脚本，因此后续适配页面结构时只需要调整 `capture/` 层。

### 3. Web Viewer 绑定方案

当前实现基于 Obsidian 的 `webviewer` 视图类型，只支持桌面端，`manifest.json` 里已经声明 `isDesktopOnly: true`。

绑定逻辑在 `src/webviewer/viewer-manager.ts`：

- `openChatGPTInWebViewer()` 新开一个 `webviewer` leaf，并导航到设置中的 ChatGPT URL。
- `bindLeaf()` 仅把当前 leaf 设为本次运行的优先 viewer，不再持久化到 `data.json`。
- `locateBestWebview()` 会在所有已打开的 ChatGPT Web Viewer 中动态选择最值得优先处理的一个：
  - 当前激活叶子优先
  - 最近发生导航 / DOM ready 的叶子优先
  - 手动 `Bind current chat web viewer` 选中的叶子优先

`src/webviewer/webview-locator.ts` 采用“打分定位”而不是硬编码单个元素引用：

- 与目标 leaf 属于同一工作区区域的优先
- 当前可见的优先
- URL 命中 `https://chatgpt.com/` 的优先

这样可以降低 Obsidian 布局切换、标签页切换或 Web Viewer 重建后的绑定丢失问题。

### 4. 页面采集方案

页面采集分成两部分：

- 插件侧：`src/capture/bootstrap-script.ts`
- 页面侧：`src/capture/dom-extractor.ts`

#### 4.1 注入机制

运行时会先执行健康检查脚本：

- 如果页面里已经存在同版本 `window.__OBAR_CAPTURE__`，则直接复用
- 如果不存在，或发生了布局变化需要强制重注入，则执行 bootstrap 脚本重新安装

注入成功后，页面上会暴露：

- `window.__OBAR_CAPTURE__.health()`
- `window.__OBAR_CAPTURE__.collect()`

这意味着插件和页面的通信边界很清晰：插件只调用 `health` 和 `collect`，页面内部自己维护观察器、脏标记和缓存快照，宿主不再每个心跳都做一次全量 DOM 扫描。

#### 4.2 DOM 抽取策略

`src/capture/` 现在拆成了更清晰的两层：

- 页面侧
  - `page-probe.ts` 负责判断 `pageState`、标题和 `session ID`
  - `turn-shell-collector.ts` 只负责定位消息壳、识别角色、提取 `contentHtml`、动作信号和稳定 `domKey`
- 插件侧
  - `defuddle-adapter.ts` 用 `defuddle/node` + `linkedom` 把每条消息的 HTML 转成 Markdown

页面内的运行模式仍然是“观察变化 + 按需重建快照”，但不再手写正文 Markdown 拼装。当前逻辑只做这些事：

- 通过 `selector-profiles.ts` 的候选选择器定位主区域、消息节点和内容根节点
- 对每个消息节点：
  - 识别角色 `user / assistant / system / unknown`
  - 提取一个稳定 `domKey`
  - 提取清理过 UI 噪声的 `contentHtml`
  - 提取 `contentTextHint` 作为标题和兜底文本
  - 识别 Assistant 回复完成动作是否已出现
  - 截取一段 `rawHtmlSnippet` 供调试
- 根据页面结构推断当前页面状态：
  - `login`
  - `chat-list`
  - `session`
  - `unknown`
- 在页面内安装 `MutationObserver`
- DOM 变化后只标记 `dirty`，并通过 debounce + `requestIdleCallback`/`setTimeout` 异步刷新缓存快照
- `health()` 只返回轻量运行态，不主动重复扫描整页 DOM
- `collect()` 在页面未变化时直接返回缓存快照

当前默认 selector profile 是 `chatgpt-web-basic`，选择器已经缩到最小必要范围，主要依赖：

- `main`
- `[data-message-author-role]`
- `article[data-testid*='conversation-turn']`
- `.markdown` / `.prose` / `[data-testid='conversation-turn-content']`

### 5. 归一化与会话标识

原始 DOM 快照会进入 `src/capture/snapshot-normalizer.ts` 做统一归一化。这个阶段会按消息逐条调用 `DefuddleAdapter`，并按 `contentHtmlHash` 复用解析缓存，避免轮询时重复解析未变化内容。

- 统一换行和空白字符
- 清除零宽字符
- 规范 role 和 pageState
- 将每条消息的 `contentHtml` 转成最终 Markdown
- 保留 plain text 作为标题和调试用途
- 过滤空消息
- 为每条消息计算：
  - `domKey`
  - `textHash`
  - `uid`
- 为整份快照计算：
  - `sessionKey`
  - `snapshotHash`

其中：

- `sessionKey` 用来识别同一 `session`
- `uid` 基于 `domKey` 生成，用来识别消息在序列中的稳定身份
- `textHash` 基于最终 Markdown 生成，用来表示消息内容是否变化
- `snapshotHash` 用来判断当前快照是否与上次完全一致

这层的作用是把“页面 DOM 形态”转换成“稳定的数据模型”，为后续增量写入提供基础。

### 6. 稳定性判定方案

自动采集不是每次心跳都落盘，而是先走 `src/capture/stability-detector.ts`：

- 如果最后一条消息不是 Assistant，允许直接保存
- 如果最后一条消息是 Assistant：
  - 如果最后一条消息内部已经出现复制/点赞/点踩这类回复完成动作，允许直接保存
  - 如果还没有出现完成动作，则回退到文本稳定判定
  - 首次看到这条回复时先不保存
  - 后续连续采到相同 `uid + textHash` 时，累计稳定次数
  - 达到 `settleRepeatCount` 或超过 `settleTimeoutMs` 后才判定为稳定

默认参数：

- `pollIntervalMs = 1500`
- `settleRepeatCount = 2`
- `settleTimeoutMs = 3000`

这套机制的目的是优先贴近 ChatGPT 的真实完成态，同时在 DOM 信号缺失时，仍然避免写出大量中间态版本。

### 7. 自动采集主循环

`src/runtime/runtime-controller.ts` 是整个插件的核心调度器。

每一轮 `captureOnce()` 的处理顺序：

1. `ensureBinding()` 在当前工作区里选择最合适的 ChatGPT Web Viewer
2. `ensureBootstrap()` 执行健康检查，必要时重注入
3. 如果页面标记为 `dirty`、处于判稳阶段，或尚无缓存快照，则执行 `collect`
4. 归一化并可选写出调试快照
5. 调用稳定性检测器判断是否可以持久化
6. 在 `session ID` 还没稳定前，自动模式先等待，不立即落盘
7. 通过 `RecordIndex` 判断对应 `record` 是否已存在，再由内存 `SessionIndex` 做本次运行内的增量 / skip / regression 判断
8. 通过 `MarkdownWriter` 写入 Obsidian Vault
9. 更新状态栏文本和内部索引

遇到错误时：

- 记录错误上下文、绑定信息和页面诊断
- 写 `debug/runtime-state.json`
- 按指数退避延长下次轮询时间，最大 10 秒

运行时还处理了一些事件驱动场景：

- `layout-change` 后强制下次重注入
- `dom-ready`、`did-navigate`、`did-navigate-in-page` 等 webview 生命周期事件会触发快速补采
- 任意 ChatGPT Web Viewer 重新激活时，缩短下一次心跳延迟
- 没有活动 ChatGPT Web Viewer 时，自动切回低频后台心跳
- 设置更新后立即按新参数恢复或暂停采集

### 8. `Session` 索引与增量更新

当前实现将“长期真相源”和“运行态缓存”拆开：

- `src/persistence/record-index.ts`
  - 以保存目录中的 Markdown/frontmatter `record` 作为真相源
  - 通过 `MetadataCache` / `Vault` 事件维护 `sessionId -> filePath`
- `src/persistence/session-index.ts`
  - 只维护本次运行期间的轻量合并缓存
  - 不再持久化到 `data.json`

运行态 `session` 缓存包含：

- `sessionKey`
- `filePath`
- `sessionUrl`
- `sessionTitle`
- `createdAt`
- `updatedAt`
- `lastStableMessageCount`
- `lastSnapshotHash`
- 已保存消息的轻量索引列表

合并策略：

- 以前没见过的 `session`：新建 Markdown `record`
- `snapshotHash` 未变化：跳过写入
- 新快照比已保存消息更短：跳过，避免回退到旧状态
- 新快照只是尾部追加：更新文件
- 前缀不一致：允许整篇重写，保证最终内容与当前稳定快照一致

这意味着当前实现更偏向“最终一致性”，而不是对 Markdown 做段落级 patch。

### 9. Markdown 落盘方案

`src/persistence/markdown-writer.ts` 负责真正写文件。

- 将 frontmatter 和正文渲染为完整 Markdown 文档
- 更新时使用单次 `Vault.process()` / `Vault.create()` 写入，避免前后两次写入带来的索引竞态
- 显式 custom note 区域会在更新时按原位置尽量回填
- frontmatter 至少包含：
  - `obar_session_id`
  - `obar_session_key`
  - `obar_session_url`

文件名生成规则在 `src/persistence/file-path.ts`：

- 默认目录：`chatgpt`
- 默认模板：`{{date}}_{{title}}`
- 支持占位符：
  - `{{date}}`
  - `{{title}}`
  - `{{key}}`

如果目标路径已被占用，会自动在文件名后追加 `session key` 的短前缀，避免冲突。

Markdown 内容由 `src/persistence/frontmatter.ts` 生成，结构如下：

```md
---
obar_source: "obar-chatgpt-webviewer"
obar_session_key: "..."
obar_session_url: "..."
obar_record_created_at: "..."
obar_record_updated_at: "..."
obar_record_message_count: 12
obar_extractor_version: "0.4.0"
obar_session_state: "session"
---

# USER: 帮我总结一下这个插件的存储逻辑
...

## 用户正文里的一级标题会自动下调
...

# AI: 这个插件会先把页面里的 session 轮次归一化，再写入带 frontmatter 的 record
...

---

# USER: 现在再补一个文件名冲突处理
...
```

代码块会保留 fenced code block，并尽量保留语言标记。每条消息的一级标题会保留 `USER / AI` 前缀，并追加一段从消息内容提取出的单行摘要，方便在大纲里区分不同轮次；摘要会压缩空白、去掉常见的 Markdown 起始标记，并在过长时按设置里的摘要长度截断，默认值为 `40`，避免破坏标题语法。消息正文里只有一级标题会下调一级，二级及以下标题保持原样。

如果希望明确声明一段内容由用户维护，可以使用下面的语法：

```md
<!-- OBAR-CUSTOM-NOTE-START:UUID-->
这里的内容在后续更新时会保留。
<!-- OBAR-CUSTOM-NOTE-END:UUID-->
```

插件提供 `Insert custom note` 命令在当前光标位置插入这个结构。要保留用户内容，请显式使用这个包裹语法。

### 10. 设置与命令

设置项定义在 `src/settings/setting-tab.ts`，当前支持：

- Chat targets
- File name template
- Message heading summary length
- Open note after save
- Post-processing
- Poll interval
- Settle repeat count
- Settle timeout
- Auto capture
- Save raw snapshots
- HTML snippet limit
- Debug mode

命令定义在 `src/commands/index.ts`，当前有：

- `Open configured chat web viewer`
- `Bind current chat web viewer`
- `Save current session`
- `Open current session record`
- `Insert custom note`
- `Pause auto capture`
- `Resume auto capture`

其中：

- `Save current session` 会强制执行一次采集并直接进入保存流程
- `Insert custom note` 会在当前编辑器光标位置插入一个带随机 UUID 的 custom note 区域；如果当前有选中文本，则会直接包裹选中内容

### 11. 调试与诊断

调试能力分为三层：

- 内存日志
  - `Logger` 保存最近 500 条日志
  - 最近日志会在运行时错误快照里一起写出
- 快照文件
  - 开启 `saveRawSnapshot` 或 `debugMode` 后，写出：
    - `debug/last-raw-snapshot.json`
    - `debug/last-normalized-snapshot.json`
- 运行时错误快照
  - 出错时写出 `debug/runtime-state.json`

这些文件默认位于：

- `.obsidian/plugins/obar/debug/`

### 12. 当前实现的边界

当前版本的能力和限制都比较明确：

- 仅支持桌面端 Obsidian
- 仅支持通过 Obsidian Web Viewer 打开的 ChatGPT 页面
- 仅匹配 `chatgpt.com`
- 页面抽取仍然依赖 DOM 结构和选择器，ChatGPT 前端大改版后可能需要更新 selector profile
- Defuddle 解决的是“消息内容清洗”，不会替代消息边界识别、角色识别和完成态识别
- 自动采集现在是“页面内 MutationObserver 驱动 + 宿主低频心跳”的混合模式，不再持续高频空轮询
- Markdown 写入仍以“当前稳定快照”为主，但会优先保留用户显式声明的 custom note 区域
- 目前没有针对图片、附件、复杂富文本、分支对话树做专门建模

## 目录结构

```text
src/
  capture/
    bootstrap-script.ts
    dom-extractor.ts
    defuddle-adapter.ts
    page-probe.ts
    selector-profiles.ts
    snapshot-normalizer.ts
    stability-detector.ts
    turn-shell-collector.ts
  commands/
    bind-current-viewer.ts
    index.ts
    insert-custom-note.ts
    open-current-session-record.ts
    open-chatgpt.ts
    save-now.ts
  debug/
    debug-dump.ts
    logger.ts
  persistence/
    file-path.ts
    frontmatter.ts
    markdown-writer.ts
    record-index.ts
    session-index.ts
  runtime/
    runtime-controller.ts
  settings/
    setting-tab.ts
    settings.ts
  webviewer/
    viewer-manager.ts
    webview-locator.ts
  constants.ts
  main.ts
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

## GitHub 自动发版

仓库已经补好了 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

推荐发布流程：

1. 本地升级版本号：

```bash
npm version patch
```

也可以用 `minor` 或 `major`。这个命令会同时完成几件事：

- 更新 `package.json`
- 通过 `version-bump.mjs` 同步 `manifest.json` 和 `versions.json`
- 创建一个不带 `v` 前缀的 Git tag（仓库里的 `.npmrc` 已经配置好）

2. 推送代码和 tag：

```bash
git push origin main --follow-tags
```

3. GitHub Actions 的 `Release` 工作流会自动执行：

- 按 `mise.toml` 中声明的 Node.js 版本安装环境
- 执行 `npm ci`、`npm run build`
- 校验 tag、`package.json`、`manifest.json`、`versions.json` 的版本是否一致
- 自动创建或更新同名 GitHub Release
- 上传 `main.js`、`manifest.json`、`styles.css` 作为 release assets

如果你不想本地推 tag，也可以在 GitHub 的 **Actions → Release → Run workflow** 里手动触发，默认会读取 `manifest.json` 里的版本号来发布。

## 手动安装

将以下文件复制到你的 Vault：

```text
<Vault>/.obsidian/plugins/obar/
```

需要的发布产物：

- `main.js`
- `manifest.json`
- `styles.css`

然后在 Obsidian 中前往 **Settings → Community plugins** 启用插件。

## 状态持久化

插件通过 `loadData()` / `saveData()` 读写 `data.json`，主要保存两类信息：

- `settings`
  - 插件配置项
- `state`
  - 自动采集是否暂停

某个 `session` 对应的 `record` 是否已存在，不再依赖 `data.json` 中的持久化 session 表，而是直接以保存目录中的 Markdown/frontmatter 为准。

## 后续可演进方向

基于当前实现，后续最自然的演进方向包括：

- 扩展 selector profile，适配更多 ChatGPT 页面变体
- 引入更细粒度的消息块模型，例如图片、表格、附件
- 细化宿主调度策略，例如按页面可见性和消息活跃度调整心跳
- 为“会话切换”和“分支回复”建立更强的识别逻辑
- 提供导出格式选项，例如更适合知识库整理的 frontmatter 字段

## 许可证

`0-BSD`
