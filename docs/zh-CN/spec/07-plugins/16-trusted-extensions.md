# 16. 受信任扩展

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/16-trusted-extensions) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 状态：v1.1 已实现（D387 / D388、ADR 0214 / ADR 0215 / ADR 0244）；实现说明标注为“v1 说明”。§2A 记录受信任渲染器宿主（issue #528、ADR 0291）。
> 范围：v1.1 加上受信任渲染器宿主。v2 与 v3 事项列于 §12，不构成承诺。

## 1. 目的与术语

插件（[01-plugin-system.md](/zh-CN/spec/07-plugins/01-plugin-system)）是 PI-Desktop
唯一的扩展面。agent 宿主是一种插件贡献点 `contributes.agentExtensions`：在 Agent
sidecar 内运行的 TypeScript 或 JavaScript 模块，接收一个 `ExtensionAPI` 对象，直接在
agent 循环上注册工具、命令和事件处理器。`ExtensionAPI` 契约即
`@earendil-works/pi-coding-agent` 定义的契约，PI-Desktop 与 `pi-ai`、`pi-agent-core`
内核（ADR 0002）一起采纳，因此为 pi CLI 写的扩展就是插件贡献的模块。D388 把此前
独立的“受信任扩展”注册表并入了这个贡献点；下文的引擎部分不变。

本文覆盖两个受信任执行宿主：agent sidecar
（`contributes.agentExtensions`，下文 §2 至 §14）与宿主渲染器（`manifest.renderer`，
§2A）。`main`、`ui.panel`、`views` 和 `settingsDestinations` 入口仍留在各自的沙箱
宿主里，规格见 [04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security)。

| 术语 | 含义 |
|---|---|
| Agent 扩展 | 插件在 `contributes.agentExtensions` 中列出的一个模块，面向 `ExtensionAPI` 编写，以 Agent sidecar 的信任级别运行 |
| 插件 | 带 manifest 的 PI-Desktop 插件，在独立进程中、权限网关之下运行（ADR 0008）；是其 agent 扩展的拥有者、安装者和启用记录 |
| 适配层 | `packages/agent-runtime` 中在桌面运行时之上实现 `ExtensionAPI` 的层 |
| Runner | 绑定到一个桌面会话的一个桌面自有 `TrustedExtensionRunner` 实例（v1 说明：不复用 pi-coding-agent 的 `ExtensionRunner`，因为它绑定终端主题；其 `ExtensionAPI` 类型仅作类型依赖） |
| 渲染器扩展 | 插件在 `manifest.renderer` 中指定的一个模块，在宿主渲染器内运行并把组件注册进宿主持有的槽位（§2A） |

## 2. 受信任 agent 宿主：定位与信任模型

1. Agent 扩展随其插件一起安装、启用、限定范围、更新和移除。没有第二个列表、存储或
   设置页。
2. Agent 扩展是受信任代码。它在 Agent sidecar 内执行，而 sidecar 已持有 bash、edit
   和 write 工具，因此授予 `agent.extension` 权限授予的正是运行 agent 已经授予的东西。
   [04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security) 的插件沙箱不
   覆盖这些模块，这正是该权限作为独立高风险授权、而非 `agent.tool.register` 隐含
   部分的原因。
3. 没有授权就不运行。声明了 `contributes.agentExtensions` 却没有 `agent.extension` 的
   manifest 校验不通过；记录的授权中缺少该权限的插件照常加载但跳过其模块并记审计
   （`plugin.agentExtensions.skipped`）。D007 继续有效：PI-Desktop 永不自动导入 `~/.pi`。
4. 项目范围就是插件的激活范围。限定到某些项目的插件只向这些项目的会话贡献模块。v1
   说明：没有独立的项目信任状态，插件范围即信任决定，`project_trust` 不触发。
5. v1.1 不开放持有 `agent.extension` 的插件在市场分发：该权限只接受本地导入和开发
   插件。市场上架等签名机制（规格 08）到位后再定。

## 2A. 受信任渲染器宿主（issue #528）

在 agent sidecar 旁边，还有第二个受信任执行宿主：`manifest.renderer`，一个插件相对的
ES 模块，由宿主渲染器在应用自己的窗口内获取并求值，在那里把 React 组件注册进宿主
持有的槽位。决定记录在 ADR 0291；本节就是契约。

### 2A.1 信任层级与权限

| 入口 | 代码运行位置 | 权限 | 组件槽位 |
|---|---|---|---|
| `main` / `ui.panel` / `views[].entry` / `settingsDestinations[].entry` | 插件 `utilityProcess` / 插件 `webContents` | 清单自身声明的权限 | 无 |
| `renderer` | 宿主渲染器，与宿主 UI 同一 JavaScript realm | `renderer.extension`（高） | 有，按层级 |
| `contributes.agentExtensions` | agent sidecar | `agent.extension`（高） | 无 |

信任跟随入口，且各层级正交而非阶梯：声明一个层级不会在另一个层级获得任何东西，
一个插件也可以任意组合多个层级。

- `renderer.extension` 是覆盖整个层级的唯一权限。槽位绝不逐个授权（#545 D1）；
  声明是请求，安装审查是授权上限。
- 声明了 `renderer` 却没有该权限会令 manifest 校验失败
  （`manifest.renderer requires the renderer.extension permission`；host-core：
  `PLUGIN_INVALID: renderer requires the renderer.extension permission`）。
  在清单里申请了该权限、但记录的授权中没有它的插件照常加载，只是跳过该入口并记
  审计，与 `agentExtensions` 完全一致。
- 分发不做门控：带 `renderer` 入口的插件走普通的本地、开发与市场路径安装。它的
  插件行会与其他能力并列显示一个 `renderer` 能力标记。
- 没有声明 `renderer` 却试图注册槽位的插件不会被静默服务：注册被跳过并作为诊断
  上报。

### 2A.2 加载

- 入口是惰性获取与求值的：它的某个槽位第一次真正渲染时才加载。加载期间不预留、
  也不显示任何东西，因此当前界面永远不渲染其槽位的插件在启动时不产生任何成本。
- 字节经 `plugin-renderer` scheme 提供。它只为已加载**且**声明了 `renderer` 的插件
  作答，只服务插件包内的路径，且只服务 `js` / `mjs` / `css` / `json` / `map`。
  既有的 `plugin-asset` scheme 不放宽：它的 MIME 白名单刻意只有图片与字体。
- 生产渲染器是 `file://` origin，因此生产 CSP 必须为脚本与连接放行
  `plugin-renderer`，构建期的 CSP 收紧也必须在同一次改动里包含它 —— 否则该入口只在
  开发环境可用，打包后才坏。
- 模块的 `onLoad(pi)` 钩子是必需的，注册就发生在那里；`onUnload()` 可选。`pi` 对象
  只携带 `plugin.id` / `plugin.version`、`pi.slots.register`、
  `pi.functions.register` 与 `pi.ui.injectStyle`，别无其他 —— 槽位组件的宿主数据与
  它的 `dispatch` 方法以 props 交给组件，不经过该对象（§2A.7）。
- React 是单例：宿主注入自己的 React，并把裸标识符 `react`、`react-dom`、
  `react-dom/client` 映射到它；自带 React 副本的插件在加载时被拒绝并记录诊断，
  因为两份副本会破坏 hooks 与 context。

### 2A.3 同一 realm 与样式隔离

没有 `iframe`，没有 worker，也没有第二层沙箱：模块与宿主渲染器共享全局对象、模块图
和 React 树。随之交付的缓解措施：

- import map 只解析 §2A.2 列出的宿主模块，因此模块无法导入任意宿主模块。

realm 本身不是边界，全局桥句柄始终可达：`contextBridge` 把 `window.piDesktop`
定义为不可配置的自有属性，应用无法删除它，模块因此可以触及宿主的整个 preload
面——243 个白名单通道（220 个 invoke 与 23 个 event），且没有任何按调用方的检查。
插件是有意被信任并授予宽泛权限的：边界是市场审核加安装时同意，而不是隔离。

样式隔离是宿主 auto-scope 方案，不是 Shadow DOM：

- 每个槽位都包在 `data-pi-plugin="<plugin-id>"` 容器里，并携带
  `data-pi-theme="light|dark"`；
- 插件样式必须走 `pi.ui.injectStyle(css)`，宿主在卸载时移除这些样式表；
- 宿主在下发前会把**选择器改写**到插件自己的容器下（改写时记
  `PLUGIN_STYLE_SCOPED`）。`:root` 会被改写为插件容器，主题分支仍可书写；
- 含顶层 `html`、`body`、`*` 选择器，或含 `@import` 的样式表会被整个拒绝
  （`PLUGIN_STYLE_REFUSED`）；
- `@keyframes` / `@font-face` 名会被改写为 `pi-<pluginId>-<name>`；
- 公开设计令牌是挂在 `.pi-plugin-slot` 上的 `--pi-slot-*` 别名（SDK 中的
  `PLUGIN_SLOT_DESIGN_TOKENS`）。宿主内部 `--ds-*` 名**不是**插件契约；引用
  它们会记 `PLUGIN_STYLE_PRIVATE_TOKEN`（软诊断，不拒载）。仅槽内容器内可用
  的原语是 `.pi-slot-btn` / `.pi-slot-chip` / `.pi-slot-field`，它们不是宿主
  chrome 的 class 名。

替换型槽位（`entry`、`toolCard`、`inlineConfirm`、`modal`）至多一个注册
（先 claim 者占用）。后来的注册以 `PLUGIN_SLOT_DUPLICATE` 拒绝。叠加型槽位
按注册顺序堆叠（D8）；`composerControl` 在其两条控制行上属于叠加型，而在
`beforeSend` 上是单 claim 的整体交出位置（见下）。`codeBlock` 仍按语言 claim。

替换型位置会把所取代的宿主 surface 原本要显示的数据交给占用它的组件
（ADR 0291）：`entry` 拿到宿主那一行原本会画的消息（`message.text`、
`message.attachments`、时间戳、斜杠调用形式、是否仍在流式输出，以及该位置
代替的宿主 `actions`）；`toolCard` 拿到它取代的工具调用（`tool.name`、
`tool.args`、`tool.result`、`tool.status`、`tool.durationMs`）；`inlineConfirm`
拿到宿主确认卡原本会显示的待决请求（`confirm.toolName`、`confirm.args`、
`confirm.risk`、`confirm.reason`、`confirm.queued`）。占用即意味着用组件自己的
形式重新渲染这些数据，并把组件自己的控件放在其**旁边**，而不是交出一张隐藏了
所获内容的空卡。`modal` 与 `overlay` 是例外：它们是插件自己打开的层 —— 注册一个
层就是让它出现，宿主在该位置没有自己的内容可交，因此只传 session。宿主的 Escape
与插件自己的 `ui.closeModal` / `ui.closeOverlay` 会在这份注册仍然存在时把层收起，
而 `ui.openModal` / `ui.openOverlay` 会让它重新出现（§2A.7）。这些 props 是纯增量的：按更早宿主
编写的组件只是拿到的键更少；叠加型的 `entryExtra` 位置刻意保持只有身份的形状
（`{ entry: { id, role, pluginId? }, sessionId }`）。

发送键左侧的那块区域是一个独立的整体交出位置：`composerControl` 的
`beforeSend`。宿主把它本来会在那里绘制的东西整体交出 —— 自己的模型选择器、上下文
占用显示与提示增强控件，都是**宿主自己的元素**，外加它们背后的数据（`modelControl` /
`modelSelection`、`contextControl` / `contextUsage`、`enhanceControl` /
`enhancement`）—— 三者的顺序由插件决定，插件可以添加自己的控件，也可以省略某一块：
组件没有渲染的那一块就不会出现，而组件渲染了的那一块宿主不会再画第二份。没有插件占用
该位置时，宿主按自己的顺序绘制自己的三块，与之前完全一致；组件抛错则位置回到宿主手中
（§2A.4）。`composerControl` 的注册只会被问到它声明的位置（`options.positions`，
取值为 `left | right | beforeSend` 之一）；不声明即保持两条控制行，因此
`beforeSend` 出现之前写成的组件永远不会被塞进一块它没有要求的区域。`beforeSend`
是单 claim：第二个声明它的注册会以 `PLUGIN_SLOT_DUPLICATE` 拒绝，取值不在已发布
位置集合内的则以 `PLUGIN_SLOT_INVALID_POSITION` 拒绝。

选择拒绝 Shadow DOM 的原因：被 portal 的插件 UI 会逃出 shadow root
（渲染层 18 个文件、41 处 `createPortal` 调用）。

### 2A.4 崩溃兜底与拒绝

- 每个槽位都位于一个 React 错误边界之后：抛错的槽位塌缩为空白，邻居不受影响，
  宿主会上报这次崩溃。若宿主在该位置有自己的默认渲染，则回退到默认值。
- 渲染器宿主的崩溃半径是被接受的：无限循环、内存泄漏或全局污染不会被错误边界兜住，
  卸载也不保证回滚全局改动（ADR 0291）。
- 拒绝：自带 React 的插件在加载时被拒绝并记录诊断；声明的 `renderer` 文件缺失会报
  `PLUGIN_LOAD_FAILED: renderer entry missing`；不导出 `onLoad` 的模块报
  `PLUGIN_INVALID: renderer entry must export onLoad`；缺少权限则是 manifest 校验
  失败，或者在该权限从未被授予时跳过入口并记审计；加载时抛错的模块其槽位保持空白
  并记录诊断。

### 2A.5 组件槽位

| 槽位 | 渲染内容 |
|---|---|
| `entry` | 一条整体转录消息：消息是对象而不是段落时 |
| `toolCard` | 插件自有工具的回合 / 工具卡片主体 |
| `codeBlock` | 按语言的围栏代码块渲染器 |
| `entryExtra` | 某条转录条目下方的附加块 |
| `composerControl` | composer 两条控制行，以及发送键左侧的整体交出区域 |
| `completionSource` | composer 补全弹层的候选项来源 |
| `inlineConfirm` | 内联确认卡 |
| `modal` | 阻塞式、应用级对话框 |
| `overlay` | 窗口内浮层 |
| `composerReference` | composer 引用芯片 |

同一 issue 中的非组件能力 —— Markdown 转换器、附件来源、草稿改写和插件文案本地化
—— 是独立的 API，不是槽位。

### 2A.6 明确不构建

本轮刻意不构建的 issue #545 §5 事项：侧边栏入口、整页工作区路由、声明式槽位形状、
以沙箱页面作为槽位实现、Shadow DOM、任何宿主提供的草稿改写 UI，以及任何对插件危险
操作文案的宿主侧校验。

### 2A.7 声明的数据与操作

渲染器模块在运行时不会索取清单里没有声明的东西。两个可选的根级列表
`rendererData` 与 `rendererActions` 分别列出模块读取的宿主数据和派发的宿主操作，
取值都来自宿主持有的词表
（[02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema) §2
与 §7 规则 21）。凡是审查手上已经持有它所询问的那份清单的地方（目前是开发者文件夹的加载
与重载审查），两份列表都会展示；如果某个界面要展示的版本清单还没读到，它就什么都不显示 ——
本地包导入根本没有安装前审查，插件中心目录也不携带这两份列表。它们是声明，不授予任何东西：
不是权限、不出现在权限列表中、不改变授权；只声明它们而不声明 `renderer` 的清单
依然通过校验。

在派发时消费这些名字的中继随受信任渲染器宿主一并交付（ADR 0294）。挂载的槽位组件以
props 拿到它的宿主数据和一个方法 `dispatch(action, payload)`；没有任何东西是隐式的。
宿主会拒绝插件没有声明的操作，而声明了、宿主却还没有处理器的操作会以带错误码的
拒绝而不是解析为 `undefined` —— 每次拒绝同时也会作为诊断记在插件的行上。
十个名字中有八个已实现；调用其余两个（`composer.insertText`、`composer.attachPath`）
会以带错误码的 `PLUGIN_ACTION_UNROUTED` 拒绝。

- `plugin.call { method: string, args?: unknown }` 转发到调用插件自己的 headless
  入口，该入口通过 SDK 钩子 `onRendererCall(method, args)` 作答，答案原样返回给
  调用方：只接受 JSON 可序列化的值，缺失的答案以 `null` 到达。Electron main 会
  用自己已加载的清单复查这次调用，渲染层只提供 id 与参数。这是正常情形下的正确性
  措施，不是安全边界（ADR 0291）。
- `ui.toast { message: string, variant?: "info" | "success" | "error" }` 触发外壳
  已有的 toast。
- `composer.replaceDraft { text: string }` 写入当前会话的整份草稿，并且只在某个已
  挂载的 composer 消费了这次写入后才 resolve；如果 500 ms 内没有任何 composer
  消费，写入会被清除，调用以 `PLUGIN_ACTION_DRAFT_UNCONSUMED` 拒绝。
- `ui.openModal` / `ui.closeModal` / `ui.openOverlay` / `ui.closeOverlay`
  收起或恢复调用插件自己的层位置。层的出现**就是**它的注册（§2A.5），所以这四个
  都无法凭空造出一层：`open*` 让本插件已经注册的 `modal` 或 `overlay` 重新显示 ——
  在此之前它被 `close*` 或宿主自己的 Escape 收起了 —— 无论哪种情况，被注册的组件
  都原样绘制。插件 id 来自 dispatch 而非 payload，因此一次调用只能触达发起它的那个
  插件自己的层；如果本插件没有任何对应注册，调用会以
  `PLUGIN_ACTION_LAYER_NOT_REGISTERED` 拒绝，而不是静默地什么都不做。
  payload 被忽略，返回值为 `{ ok: true, slot, visible }`。

`rendererData` —— 模块声明读取的宿主数据。角色拆分如下：

- **声明 / 安装审查**：下列名字均为合法的清单元数据。
- **槽契约 props**（`draft`、`entry`、`references`、`mode`、`query`、
  `position`、`code` 等）始终来自该槽自己的挂载，不受本列表门控。
- **ambient props**：仅当插件已声明**且**宿主已持有该值时，`SlotOutlet` 会
  注入 `theme` 与 `locale`（`PLUGIN_RENDERER_AMBIENT_DATA`）。这是窄合并，
  不是实时订阅引擎。
- `selection` 本周期可声明但不服务；宿主会记 `PLUGIN_DATA_UNSERVED`，而不是
  静默忽略声明（`PLUGIN_RENDERER_UNSERVED_DATA`）。

- `entry`
- `session`
- `code`
- `theme`
- `selection`
- `draft`
- `attachments`
- `locale`

`rendererActions` —— 模块声明派发的宿主操作：

- `plugin.call`
- `composer.replaceDraft`
- `composer.readDraft`
- `composer.insertText`
- `composer.attachPath`
- `ui.openOverlay`
- `ui.closeOverlay`
- `ui.openModal`
- `ui.closeModal`
- `ui.toast`

### 2A.8 宿主可调用的插件函数

有些位置需要插件在宿主渲染时给出答案 —— 一个转录必须在布局前就知道其高度的逐消息
块、一个代码块装饰、一个在计算 composer 控件时读取的值。异步往返无法服务这些位置，
否则界面会在之后闪烁或重排，因此模块还会注册宿主可在渲染层内调用的纯同步函数
（ADR 0294 决策 6）。

- `pi.functions.register(name, fn)` 返回 `{ name, remove() }`。名字按插件划分、不是
  全局的，且必须匹配 `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$` 并不超过 64 个字符。
  不符合该语法的名字会被带错误码地拒绝并记录一条诊断
  （`PLUGIN_FUNCTION_INVALID_NAME`），同一插件已注册过的名字同样被拒
  （`PLUGIN_FUNCTION_DUPLICATE_NAME`）；两种情况都不会注册任何函数。
- `fn` 由宿主在渲染时调用，任何一次渲染都可能调用 —— 不是每次插件加载调用一次，
  也不按计划调用。它必须是纯同步的：没有 I/O、没有网络、不做 DOM 变更、不做耗时
  工作。
- 宿主以 `callRendererFunction(pluginId, name, input)` 调用，得到的是判别式结果而不是
  异常：
  - `{ ok: true, value }` —— 函数在一帧内返回。
  - `{ ok: false, code: "PLUGIN_FUNCTION_MISSING" }` —— 不存在这样的函数，插件卸载后
    也包括在内。
  - `{ ok: false, code: "PLUGIN_FUNCTION_THREW" }` —— 函数抛出了异常。
  - `{ ok: false, code: "PLUGIN_FUNCTION_OVER_BUDGET" }` —— 函数返回了，但耗时超过
    一帧（16 ms）的预算；**返回值被丢弃**，宿主在没有它的前提下渲染。
  - `{ ok: false, code: "PLUGIN_FUNCTION_DISABLED" }` —— 连续三次超预算或抛出调用
    （一次成功会重置计数）使该函数自己的断路器跳闸；此后宿主在插件本次加载的剩余
    生命周期内不再调用该函数。
- 同步调用无法被抢占。预算通过丢弃答案和断路器来执行，绝不通过取消调用来执行：宿主
  会等调用返回，然后把来得太晚的答案丢弃。它不会在返回之前就“当作插件没有意见”
  继续。
- 上述每种失败都作为诊断记在插件的行上（§2A.7）。
- 这是渲染层本地路径，不是 IPC 通道：没有任何 host-core 或 Electron main 消息承载
  函数调用，函数本身也不得发起，因为它不得执行 I/O。
- 目前还没有任何宿主位置调用已注册的函数。§2A.5 所列的十个组件槽位现在都已挂载，但每个
  位置都以普通 props 把数据交给组件 —— 包括当初为同步答案设计的那些位置（代码块与
  composer 控件）。因此已注册函数目前的调用方只有测试，唯一的入口是
  `callRendererFunction`。

## 3. 贡献与导入

### 3.1 Manifest

```json
{
  "id": "acme.git-helper",
  "name": "Git helper",
  "version": "1.0.0",
  "main": "main.js",
  "permissions": ["agent.extension"],
  "contributes": { "agentExtensions": ["src/index.ts"] }
}
```

规则：最多八个条目；每个条目是插件目录内的相对 `.ts`、`.mts`、`.js` 或 `.mjs` 路径；
加载时文件必须存在；列出条目却没有权限的 manifest 无效
（[02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema) §4 与 §7）。
当插件不贡献其他内容时，`main` 可以是空操作模块。

### 3.2 导入 pi CLI 扩展或技能包

插件页 →“导入 pi 扩展”打开原生选择器（main 拥有路径，D344），由用户明确选择本地
文件或目录。main 把所选源码复制到 `<dataDir>/plugins/imported/<slug>/src/`，生成空操作
CommonJS `main.cjs` 和 id 为 `imported.<slug>` 的 manifest（重复导入时追加唯一后缀），再通过
既有本地插件流程注册。选择器之前的确认仍是信任决定；生成的 manifest 只声明实际贡献
所需的权限。无论源包的 `type` 为何，manifest 的 `main` 都指向 `main.cjs`；
两份复制的包声明保留原有模块语义。加载时若导入插件的 `main` 仍是生成的 CommonJS
`main.js` 空包装器，则就地改写为 `main.cjs` 并更新 manifest；复制的包文件、授权和
激活范围保持不变。只匹配生成的空操作（含最初的注释文本）。自定义过的 `main.js`
不会改动。不删除就重新导入仍会创建带唯一后缀的独立插件，不会从旧副本复制授权或
激活范围。

扩展文件及未声明 `pi.skills` 的包保持既有 `pi-coding-agent` 入口发现规则：先取
`package.json` 的 `pi.extensions`，否则取 `index.ts` / `index.js`，再否则取一层深度内
的松散 `*.ts` / `*.js` 文件。明确声明 `pi.skills` 且没有 `pi.extensions`（或该数组为空）
的包视为仅技能包：包括 `index.js` 在内的附带脚本作为资源复制，不会被提升为可执行的
Agent 扩展。

目录若自带 `package.json`，会（连同其 npm lockfile）一并复制到插件根并剥离 `workspaces` 字段。
若声明了生产或可选依赖，main 会在首次加载前执行有界的两阶段安装：先运行
`npm install --package-lock-only --omit=dev --legacy-peer-deps --no-audit --no-fund
--ignore-scripts` 并校验完整生成的 lockfile，再使用相同安全参数运行 `npm ci`。
`dependencies`、`optionalDependencies`、`devDependencies` 和 `peerDependencies` 中的
直接 spec 都必须来自 registry，因为 npm 可能检查全部四者；git resolver 会被禁用。
不会运行生命周期脚本。安装失败会清理部分依赖/cache、上报渲染层且不阻塞导入。确认对话框
会与技能披露一并说明 npm 安装步骤。

| 来源 | 结果 |
|---|---|
| 一个 pi 扩展目录或文件 | `plugins/imported` 下的本地插件，id 为 `imported.<slug>` |
| 声明了 `contributes.agentExtensions` 的插件包 | 像其他插件一样安装；安装时询问该授权 |
| 带 `pi.extensions` 的 `package.json` | `src/` 下的入口，通过 `contributes.agentExtensions` 贡献，需 `agent.extension` |
| 带 `pi.skills` 的 `package.json` | `src/` 下的 Markdown 文档，通过 `contributes.skills` 贡献，需 `agent.prompt.inject` |
| 仅技能包 | 持有 `agent.prompt.inject` 的空操作插件，不授予 `agent.extension` |

`pi.skills` 是最多含 32 条非空路径的数组，每条路径相对于包目录，指向 Markdown 文件
或目录。明确指定的 `.md` 文件直接作为技能。对于目录，优先使用其自身的 `SKILL.md`；
若不存在，则纳入该目录直接包含的 `.md` 文件，并在子目录中查找 `SKILL.md`。
嵌套技能目录找到自身的 `SKILL.md` 后停止向下扫描，避免把支持文档变成额外技能。
扫描跳过点号开头的条目和 `node_modules`，对文档去重，目录扫描预算为 256。
发现超过 32 个技能、声明的路径不存在或路径类型不受支持时，导入失败，不会静默生成
不完整目录。每项贡献都按包内相对路径生成明确、稳定的插件内 ID，不同目录下同名的
`SKILL.md` 保持独立。既有插件技能正文解析、大小限制、权限与卸载行为保持不变。

复制时按所选包的相对路径判断排除项。包的祖先路径含 `node_modules` 不影响复制，
只排除包自身依赖目录中的 `node_modules` 路径段。引用文档、素材、辅助脚本及其他
普通源码文件保留在 `src/` 下，使技能的相对资源引用仍然成立。凭据文件（`.env*`、
`.npmrc`、`.netrc`、`.pypirc`、私钥和证书文件）及仓库元数据目录不会被复制。所选
根目录先解析为真实路径；贡献路径必须位于根目录内，不能包含 `..` 穿越，也不能指向
包内依赖目录。绝对 `pi.skills` 路径与后代符号链接会被拒绝；复制保留资源时也拒绝
符号链接，复制失败会清理部分生成的目录。生成目标以原子方式创建，不能位于所选源目录内。

这是显式本地导入，不是 pi CLI 包管理器：不会自动扫描或导入 `~/.pi`，不会读取 CLI
已安装包注册表，也不会执行 npm 生命周期脚本。声明依赖时，有界安装器只接受 registry
版本说明和 registry 来源的 npm lockfile，拒绝不安全的包路径和嵌套依赖 spec，禁用 git
解析，并隔离 npm 的配置/cache 与用户凭据和代理设置。导入包不代表其所有第三方扩展依赖都能执行。

## 4. 加载与运行时

### 4.1 扩展在哪里运行

扩展在 Agent sidecar 进程（`packages/agent-runtime`）内加载，永远不在 Electron
main、渲染层或插件宿主进程中。

### 4.2 Loader

- sidecar 以与 `pi-ai`、`pi-agent-core` 完全相同的锁定版本依赖
  `@earendil-works/pi-coding-agent`，仅作类型依赖。三者版本必须一致；漂移时 CI 失败。
- loader 镜像 `pi-coding-agent` 的发现规则，使用带 `virtualModules` 的
  `jiti/static`，babel 转换被打进包内，运行时不做路径解析。打包步骤由一个在仓库
  之外运行打包产物的契约测试验证（E2E-245）。
- 导入别名：`pi-ai`、`pi-agent-core` 和 `typebox` 解析到 sidecar 自带的副本；
  `@earendil-works/pi-coding-agent` 解析到一个运行时 shim，导出 `defineTool` 和
  工具结果类型守卫。`@earendil-works/pi-tui` 解析到一个桩
  模块，它把每个符号导出为惰性值，使顶层 import 永不失败。调用被桩替代的
  符号时在调用点产生一条诊断。

### 4.3 每会话一个 Runner

- 每个桌面会话拥有自己的 Runner。Runner 随会话运行时创建，随其丢弃而销毁。
- 由于 jiti 缓存模块，模块实例在 Runner 之间共享。因此模块级状态在会话之间
  共享，这与扩展作者在 pi 单进程运行多会话时看到的一致。v1 记录这一点而不
  绕开它。
- 启用、禁用或重新扫描会使所有 Runner 失效；受影响的会话在下一个回合边界重新
  加载扩展。进行中的回合永不被重新加载打断。

### 4.4 加载失败

加载错误永不导致会话失败。该扩展在诊断中标记为 `error` 并附消息和堆栈，其余
扩展继续加载，回合照常进行。当某个已启用扩展在当前会话加载失败时，composer
显示一行提示。

## 5. API 支持矩阵（v1）

每个 `ExtensionAPI` 成员恰好落入一个类别。不支持的成员仍存在于对象上，不做
任何事，返回文档规定的中性值，并按扩展、按成员各产生一条诊断。它们永不抛出，
因此只使用受��持成员的扩展即使同时触碰了不支持的成员也能工作。

| 类别 | 成员 |
|---|---|
| 支持 | `registerTool`、`registerCommand`、§6 中每个事件的 `on(...)`、`exec`、`getActiveTools`、`getAllTools`、`setActiveTools`、`getCommands`、`setModel`（v1 说明：返回 `false`，桌面拥有会话的 provider 绑定）、`getThinkingLevel`、`setThinkingLevel`、`setSessionName`、`getSessionName`、`continueTurn`（Host 队列，槽位 10；需要 `runtime.turn.continue`；携带插件 provenance）、`getFlag`、`requestTurnAbort`（槽位 3；需要 `runtime.turn.abort`） |
| 上下文上支持 | `ui.notify`、`ui.confirm`、`ui.select`、`ui.input`、`ui.setStatus`、`ui.setWorkingMessage`、`cwd`、`modelRegistry`、`isIdle`、`signal`、`abort`、`hasPendingMessages`、`getContextUsage`、`compact`、`getSystemPrompt`、`waitForIdle`、`newSession`、`fork` |
| 推迟到 v2 | `sendMessage`、`appendEntry`、`setLabel`、`sessionManager` 只读 API、`switchSession`、`registerShortcut`、`registerMarkdownTransformer`、`ui.setEditorText`、`ui.getEditorText`、`ui.addAutocompleteProvider`、`registerFlag` 值编辑 |
| 不支持 | `ui.setWidget`、`ui.setFooter`、`ui.setHeader`、`ui.setTitle`、`ui.custom`、`ui.overlay`、`ui.onTerminalInput`、`ui.setWorkingVisible`、`ui.setWorkingIndicator`、`ui.setHiddenThinkingLabel`、`ui.pasteToEditor`、`ui.editor`、`registerMessageRenderer`、`registerEntryRenderer`、`navigateTree`、`shutdown` |

中性值：`getFlag` 返回声明的默认值；`registerFlag` 记录声明使 `getFlag` 可用，
但 v1 不暴露 CLI 或 UI；`sessionManager` 访问器返回空结果；UI setter 返回空操作
的 `dispose`。

## 6. 事件映射

事件从桌面运行时现有的 hook 点触发。凡事件类型定义了返回结果的，处理器结果
均被采纳。槽位 6（`runtime.request.before`）已撤回，它的六个事件均为惰性：
注册的处理器会被静默接受，永远不会运行。

| 事件 | 桌面 hook 点 | 是否采纳结果 |
|---|---|---|
| `session_start`、`session_shutdown` | Runner 创建与销毁 | 否 |
| `session_info_changed` | 经 `setSessionName` 的会话改名 | 否 |
| `project_trust` | v1 说明：不触发；按项目启用即信任决定 | 否 |
| `resources_discover` | v1 说明：不触发；skills 与提示发现留在 Electron main | 不适用 |
| `before_agent_start` | 随槽位 6（`runtime.request.before`）撤回：注册的处理器会被静默接受，永远不会被咨询 | 否 |
| `context` | 随槽位 6 撤回：注册的处理器会被静默接受，永远不会被咨询 | 否 |
| `before_provider_request`、`before_provider_headers` | 随槽位 6 撤回：注册的处理器会被静默接受，永远不会被咨询 | 否 |
| `after_provider_response` | provider 调用包装 | 否 |
| `agent_start`、`agent_end`、`agent_settled` | Agent 循环边界 | 否 |
| `turn_start`、`turn_end` | 回合边界 | 否 |
| `turn_closing` | `shouldStopAfterTurn`（运行时槽 7，issue #561；由 `runtime.turn.closing` 门禁 —— 规格 13 §2C） | 是：`{ continue: true, message? }` 让本回合继续，按运行次数上限约束 |
| `message_start`、`message_update`、`message_end` | Agent 消息事件 | v1 说明：否，pi-agent-core 不提供事后替换 |
| `tool_call` | `beforeToolCall` | 是，可带理由阻止。修改该调用的参数不可用，且已被永久排除（ADR 0295 规则 4） |
| `tool_execution_start`、`tool_execution_update`、`tool_execution_end` | 工具执行流 | 否 |
| `tool_result` | `afterToolCall` | 是，替换结果 |
| `model_select`、`thinking_level_select` | 随槽位 6 撤回：注册的处理器会被静默接受，永远不会被咨询 | 否 |
| `session_before_compact`、`session_compact`、`session_compact_failed` | 压缩流水线 | `session_before_compact` 为是 |
| `input` | Electron main 持久化消息之后、进入模型队列之前（运行时槽 1，issue #561；由 `runtime.send.before` 门禁 —— 规格 13 §2C） | 是：`{ action: "continue" \| "transform" \| "handled", text?, reason? }`；`transform` 替换模型读到的内容，并按差异级别记录（ADR 0295 规则 5） |
| `session_before_switch` | 会话切换：被离开的会话，在新会话打开之前通告（运行时槽 11，仅告知 —— ADR 0295 规则 11） | 否 |
| `session_before_fork` | 会话 fork：源会话，在子会话存在之前通告（运行时槽 11，仅告知） | 否 |
| `session_lifecycle` | 会话创建/删除 —— 内核没有 hook 的两个时刻，由宿主通告（运行时槽 11，仅告知） | 否 |
| `user_bash`、`session_before_tree`、`session_tree`、`ui_prompt_start`、`ui_prompt_end` | v1 不触发 | 不适用 |

处理器只有在扩展所属插件持有其事件背后的槽位权限时才会运行（ADR 0295 规则 2）：
`turn_closing` 需要 `runtime.turn.closing`，`tool_call` 与 `tool_result` 需要
`runtime.tool.gate`，上表中其他写明槽位的事件同理。该映射覆盖每一个会改变轮次的已接线
事件；`session_start`、`session_shutdown` 与 `session_info_changed` 没有槽位。所有槽位
权限都已注册，因此门禁对所有插件都是严格的：`agent.extension` 只说明代码在哪里运行，
绝不隐含授权，高信任层级也不例外。映射到桌面尚未触发的事件（`project_trust`、
`resources_discover`）按映射保留门禁，因此不会从不触发的钩子点运行任何处理器。
槽位 6 的六个事件没有任何映射：注册会被接受，之后永远不会被咨询。生命周期通告均为仅告知：
`session_before_switch`、`session_before_fork` 与 `session_lifecycle` 会被发出且从不等待，
因此插件无法拖延切换、fork 或删除（ADR 0295 规则 11）。

runner 会拿到该插件被授予的权限清单 —— 没有记录授权的扩展不持有任何权限 —— 对无权运行的
处理器直接跳过，并把跳过作为插件行上 kind 为 `permission_denied`、写明权限名的扩展诊断
上报。被跳过的处理器不会阻塞回合：与抛错的处理器一样，它只是没有意见。

有两类调用是扩展为自己发出的、并非事件，因此同一份契约改为给调用本身命名（`@pi-desktop/shared`
中的 `TRUSTED_EXTENSION_API_PERMISSIONS`）：`requestTurnAbort` 需要 `runtime.turn.abort`，
§7.6 的工具结果能力需要 `runtime.tool.extend`。两个名字都已注册，因此与事件完全一样受门禁并上报：调用返回
拒绝值（`requestTurnAbort` 返回 `false`），插件行得到一条写明权限与调用名的 `permission_denied`
诊断 —— 既不静默跳过，也不抛错。

### 6.1 中止回合与取消信号（槽位 3）

`requestTurnAbort()` 请求宿主停止当前回合。插件自己的长任务会在同一槽位内得知本次运行已被取消，
因为只有中止、没有信号会让这些任务在回合消失后继续运行：

- 扩展上下文带有 `signal`，即当前运行回合的 `AbortSignal`（没有回合在跑时为 `undefined`）；
- 插件工具的执行上下文同样带有 `signal`（见 §7.7），它在用户停止、插件请求中止、或宿主放弃回合时触发；
- 对插件工作而言，用户 Stop 与 `requestTurnAbort` 走同一条路：Electron main 取消该会话的插件调用
  （sidecar 自身无法触达），运行时照常发出 `TURN_ABORTED` 终结事件，回合被记录为已中止。

`pi-agent-core` 还暴露两个上下文钩子 —— `transformContext` 与 `prepareNextTurn`
—— 插件目前都无法触及：桌面只设置了 `prepareNextTurnWithContext`，上表的
`context` 事件就走这条路径。面向插件的入口是 ADR 0295 的 Phasing 第 3 步；那里的
规则 3 让它面向普通插件，而不只是高信任层级。

抛出异常的处理器记为诊断并视为返回 `undefined`。带返回结果的事件若处理器超过
30 秒，则放弃并记诊断，回合以未修改的值继续。

## 7. 工具

1. 注册的工具以其声明名称加入会话工具目录。与核心工具、插件工具或用户 MCP
   工具同名的注册被拒绝并记诊断；先注册者胜出。
2. 扩展工具是非核心工具：与插件工具遵循相同的模式门控和 ToolSearch 延迟。它们
   在 Agent 模式可用，其他模式遵循现有的按模式白名单。
3. 执行在 sidecar 内按 `ExtensionAPI` 的 `execute` 签名进行。不弹出宿主权限提示；信任决定已
   在启用时做出。`onUpdate` 流映射到工具执行更新事件。
4. 每次执行写一条审计记录，含扩展 id、工具名和耗时。不记录参数。
5. `exec` 在 sidecar 内以会话工作目录、会话代理和环境设置运行。
6. **槽位 5 —— 工具结果在内容之外还能做什么。** 扩展工具的 `AgentToolResult` 可以带
   `addedToolNames`、`usage` 和 `terminate`，经 `pi.agent.registerTool` 注册的插件工具也可以
   用 `PluginToolResult` 返回同样的三个字段。三者都需要 `runtime.tool.extend`；未获授权的
   插件被拒绝而不是被默默信任，拒绝会记为 `permission_denied` 诊断（扩展工具，落在插件行）
   或审计记录（`agent.toolResult.extend`，插件工具，在 Electron main）：
   - `addedToolNames` 在运行时引入工具。每个名字必须已在会话目录中 —— 一个模型尚未激活的
     按需工具，包括其他插件的工具 —— 并从下一次 provider 请求起可用。目录之外的名字被忽略，
     宿主工具的结果永远不能引入工具：`addedToolNames` 是槽位 5 的能力，只有插件持有该槽位。
     被引入的工具在展示目录的地方被标注：模型系统提示词中的按需工具列表、激活它的那次
     ToolSearch 回复，以及 `getAllTools()`（行字段 `introducedBy: "plugin"`）。只要引入它的
     那处转录上下文仍在，这个标注就一直跟随该工具。
   - `usage` 是本次调用自己的花费。它作为已完成回合的独立组成部分记录
     （`turn_end.pluginToolUsage` → host-core 中该回合记录的用量），绝不并入模型的
     `inputTokens` / `outputTokens`，因此成本界面可以把它单列一行。
   - `terminate` 请求在本次批次之后停止。内核规则不变：只有批次内**每一条**已定稿结果都请求
     停止时才停止，因此单个工具的请求不会截断批次。被拒绝的插件该提示会被显式清除，因为内核
     把字段缺失理解为“保留原值”。
   插件工具的结果只要带上其中任一字段就同时选用了内核形状：`content` 会作为内容抵达模型，
   而不是 JSON 串。不带这些字段的结果保持原有渲染。三个字段都随插件消失：它引入的工具属于会话
   目录，而目录由 `rebuildToolCatalog` 依据已加载插件重建。
7. 插件工具在插件自己的进程中执行（规格 04）。其执行上下文（`PluginToolExecContext`）带有
   `sessionId`、`turnId`、`mode`、`modelKey`、`thinkingLevel`、`log` 与 `signal` —— 本回合的
   取消令牌（§6.1）。`signal` 在用户停止、插件请求中止、或宿主放弃回合时触发；长任务应把它
   传给 `fetch` 或监听它并停止。宿主仍持有的每个插件调用都会在插件卸载、会话回合替换和关闭时被取消。
## 8. 命令

1. `registerCommand` 条目出现在全局搜索的 Commands 区（见
   [09-plugin-command-palette.md](/zh-CN/spec/07-plugins/09-plugin-command-palette)），
   形式为 `/<name>`，来源显示扩展标签，排在内置和插件命令之后。
2. 命令在 sidecar 内运行，扩展命令上下文绑定到当前会话。它需要一个在本次应用
   运行中已加载扩展的活动会话；否则 composer 提示需先开始对话。
3. composer 中输入的 `/<name>` 按此顺序解析：内置、提示模板、插件、扩展。冲突
   记为诊断。
4. 运行中的命令与插件命令一样阻止 composer 提交，可从状态栏取消。

## 9. UI 桥接

交互式上下文调用经 sidecar → Electron main → 渲染层往返。

| 调用 | 渲染层界面 | 超时 | 中止时 |
|---|---|---|---|
| `ui.notify` | Toast | 无 | 丢弃 |
| `ui.confirm` | 双动作模态框 | 5 分钟 | 解析为 `false` |
| `ui.select` | 模态列表 | 5 分钟 | 解析为 `undefined` |
| `ui.input` | 模态文本框 | 5 分钟 | 解析为 `undefined` |
| `ui.setStatus`、`ui.setWorkingMessage` | 当前会话的浮动状态行（v1 说明：不在 composer 内） | 无 | 清空 |

规则：

- 每会话同一时刻只有一个待处理交互提示。第二个调用排在第一个之后。
- 中止回合时以上述中止值取消待处理提示。
- 远程控制（MVP 后）下提示立即以 `UNSUPPORTED` 失败，直到远程协议路由它；该
  路由属于 v3。
- 提示显示扩展标签和来源路径，让用户知道是谁在询问。

## 10. 协议与 IPC 新增

v1 不改任何 host-core RPC 方法、协议版本或 SQLite schema。

### 10.1 sidecar → main（host.proxy 白名单）

| 方法 | 用途 |
|---|---|
| `extensions.commands.publish` | 替换会话已注册的命令列表 |
| `extensions.ui.request` | §9 中的一次交互或状态调用 |
| `extensions.diagnostics.publish` | 替换会话的诊断列表 |
| `extensions.model.configure` | 校验插件自有的 provider/模型绑定，经 `session.configure` 持久化，然后广播 `session:modelChanged` |
| `session.rename`、`session.create`、`session.fork`、`session.queuePush`、`session.queuePrioritize` | 已有方法，现可从适配层到达 |

### 10.2 main ↔ 渲染层（Electron IPC）

| 通道 | 方向 | 用途 |
|---|---|---|
| `plugin/importExtension` | 请求 | 原生选择器、生成插件、注册为开发插件 |
| `extensions/commands/run` | 请求 | 在当前会话运行已注册命令 |
| `extensions/ui/respond` | 请求 | 回答一个待处理提示 |
| `extensions/ui/prompt` | 事件 | 有提示待处理 |
| `extensions/event/status` | 事件 | `ui.setStatus` / `ui.setWorkingMessage` 文本变化 |
| `plugin/list` | 请求 | 插件行携带 `agentExtension` 状态、工具与命令名和诊断 |
| `event/pluginChanged` | 事件 | 会话发布命令或诊断时同样触发 |
| `plugin/renderer/call` | 请求 | 一次转发的渲染器操作（`plugin.call`）：载荷 `{ pluginId, method, args }`；结果是调用插件自己入口的应答 |

所有通道像其他插件通道一样做 sender 校验。MCP 控制面暴露 `extensions/commands/run`
（写）和 `extensions/ui/respond`（危险，需 confirm）；导入是原生选择器，保持本地。
main 在 `logs/app/plugin.log` 审计每个提示 id。

## 11. 插件行界面

插件页在所属插件的行上展示 agent 扩展：

- `agentExtension` 能力标记和 `agent.extension` 权限标记（高风险），与其他能力和权限
  并列。
- 详情区含状态标记（`enabled` 直到本次应用运行中有会话加载模块、`loaded`、`error`）、
  已注册的工具与斜杠命令名，以及诊断：加载错误、带计数的不支持 API 调用、被拒绝的
  注册、处理器超时。
- 页面溢出菜单中的“导入 pi 扩展”，前置一个说明授权含义的确认。

## 12. 分阶段

| 阶段 | 内容 | 承诺 |
|---|---|---|
| v1 | loader、每会话 Runner、支持矩阵、事件、工具、命令、UI 桥接 | 已交付（D387） |
| v1.1 | 模块成为带 `agent.extension` 授权的 `contributes.agentExtensions`；把 pi CLI 扩展导入为开发插件；独立注册表和设置标签移除 | 已交付（D388） |
| v2 | 自定义会话条目（`sendMessage`、`appendEntry`）含 schema 升版和通用渲染、`sessionManager` 只读 shim、`switchSession`、编辑器读写、补全 provider、`registerShortcut`、markdown 转换器 | 已规划，需先决定条目持久化与压缩 |
| v2 | 自定义会话条目（`sendMessage`、`appendEntry`）与一次 schema 升级及通用渲染层、`sessionManager` 只读 shim、`switchSession`、编辑器读写、自动补全 provider、`registerShortcut`、markdown 转换器 | 计划中，需要就条目持久化与压缩作出决定 |
| v3 | `pi` 包 manifest 与安装、pi CLI `settings.json` 的只读提示、统一 skill 与提示发现、提示的远程控制路由、市场列出 | 未排期 |

v1 交付顺序：打包 spike（E2E-245）、shared 协议类型，然后运行时、main、渲染层
三条线并行。

## 13. 版本策略

- 升级任一 pi 包即同时升级三个包。
- 一组覆盖每个受支持成员的样例扩展在每次升级时作为契约测试运行。
- 新增的 `ExtensionAPI` 成员先落入“不支持”类别并产生诊断，直到后续决策
  移动它们。
- 对外文档只承诺 §5 中“支持”和“上下文上支持”两个类别。

## 14. 待决事项

| 问题 | 决定前的默认 |
|---|---|
| v2 自定义条目是否持久化到 host-core 并参与压缩？ | 持久化；不进入压缩摘要 |
| v3 是否把 pi CLI `settings.json` 的启用路径作为发现提示读取？ | 只读提示，永不写入 |
| 扩展工具是否像插件工具一样按项目可选？ | §3.2 的范围是唯一门控 |
