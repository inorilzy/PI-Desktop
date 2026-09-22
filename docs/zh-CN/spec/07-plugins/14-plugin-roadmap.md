# 14. 插件路线图

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/14-plugin-roadmap) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 指导原则

```text
Local plugins usable → developer-friendly → marketplace distribution → signing and auto-update
```

## 2. 路线图

### R1 — 基础（带 M4）✅
- 清单 v1
- 本地目录加载
- enable/disable/uninstall
- 命令面板集成
- 你好示例插件
- 权限声明显示

### R2 — Agent 扩展（部分 ✅）
- 完整的代理工具管道 ✅
- 技能贡献被激活：声明的技能作为 `# Skills` 到达模型
  授予 `agent.prompt.inject` 时系统提示中的目录，以及模型
  通过 `Skill` 工具按需加载主体 ✅ (ADR 0039, D174)
- 统一命名空间和审计 ✅
- 每个插件设置 API 和生成式设置 UI 已实现。UI 支持字符串、数字、布尔、枚举、JSON
  字段与插件域命令快捷键；操作系统全局插件快捷键暂不在范围内。
  已实施
- 插件日志面板仍在计划中；运行时审计日志的存在没有专用的
  插件日志表面

### R3 — DX 和包装 ✅
- 插件 SDK ✅
- 模板生成✅（`panel-basic`、`agent-tool-basic`、`skill-pack`、
  `full-demo`，来自插件页面、代理或 `pi-plugin init`）
- `pi-plugin check/pack` ✅（`@pi-desktop/plugin-devkit`，也暴露为
  `PluginCheck` / `PluginScaffold` / `PluginPack` 代理工具）
- `.piplug` 安装 ✅
- 开发热重载✅（监视+反跳，并且重载永远不会扩大权限）

### R4 — 市场只读 ✅
- 市场提供商抽象（官方远程 GitHub 目录提供商）
- 来自 `vastsa/pi-desktop-plugins` 的官方来源 browse/search
- 下载+校验和安装
- 更新列表（手动更新）

### R5 — 信任和自动更新（部分✅）
- 发布者验证（目录中的验证标志）
- 签名验证（仍在计划中；现在强制执行校验和）
- 权限差异升级✅
- 自动更新政策✅
- 恶意版本的拉克响应（仍在计划中）

### R6 — 高级生态系统（部分✅）
- MCP 插件类型 ✅ — 通过 stdio 和远程 HTTP 的 `contributes.mcpServers` (D176)
- 后台服务插件 ✅ — `contributes.services` 受监督
  重新启动（D177）
- 插件间消息总线 ✅ — 声明的主题，`pi.bus.*` (D178)
- 主题插件 ✅ — 插件提供 CSS 文件 (D175)
- 企业私人资源（仍在计划中）
- 市场评论/质量评分（可选，仍在计划中）

### R7 — Agent 扩展（v1.1 ✅，D387 / D388）
- v1：Agent sidecar 中的 ExtensionAPI 适配层；工具、命令、生命周期与 provider hooks、
  基础 UI 提示
- v1.1：模块成为插件贡献点（`contributes.agentExtensions`，权限 `agent.extension`）；
  “导入 pi 扩展”把 pi CLI 扩展变成开发插件；没有独立注册表或设置标签
- v2：自定义会话条目、`sessionManager` 只读 shim、编辑器读写、快捷键、markdown 转换器；
  签名到位后开放市场分发
- v3：pi CLI `settings.json` 提示、统一 skill/提示发现、远程控制提示路由
- 规格：[16-trusted-extensions.md](/zh-CN/spec/07-plugins/16-trusted-extensions)；ADR 0214、ADR 0215

### R8 — 受信任渲染器宿主（issue #528，批次 0 ✅）
- `manifest.renderer`：一个在宿主渲染器内运行、把 React 组件注册进宿主持有槽位的
  插件相对 ES 模块 ✅
- `manifest.main` 变为可选，并新增一条规则：必须在 `main`、`renderer`、`ui.panel`、
  `views[].entry`、`settingsDestinations[].entry` 之间至少有一个入口 ✅
- `renderer.extension`（高）是受信任 UI 层级的唯一权限；组件槽位按层级授权，
  绝不逐个授权 ✅
- 组件槽位 id：`entry`、`toolCard`、`codeBlock`、`entryExtra`、`composerControl`、
  `completionSource`、`inlineConfirm`、`modal`、`overlay`、`composerReference` ✅
- 通过 `plugin-renderer` scheme 惰性获取与求值、命名空间样式隔离、React 单例规则、
  逐槽位错误边界，以及插件行上的 `renderer` 能力标记 ✅
- 规格：[16-trusted-extensions.md](/zh-CN/spec/07-plugins/16-trusted-extensions) §2A；ADR 0291

### R9 — 运行时槽位（issue #561）
- 槽位权限模型已交付：ADR 0295 要建的每个 `runtime.*` 名字都已注册，sidecar 会在
  处理器运行前解析该事件的槽位权限，只持有 `agent.extension` 的插件会被拒绝并收到
  `permission_denied` 诊断（规格 13 §2C、ADR 0295 规则 2）。本节此前描述的 D1 偏离
  就此消除。
- ADR 0295 分期中的批次 A 已交付：Abort Turn (3) 有自己的入口（`requestTurnAbort`）
  以及插件任务可观察到的该轮取消信号；Tool Extend (5) 接入工具结果折叠；Turn Facts
  (9) 由 host-core 在架构 v21 上通过 `turn.facts` RPC 回答（04-data-storage §4.16）。
  面向插件的读取入口尚未实现，所以该槽位目前没有插件可调用的东西。
- Turn Closing (7) 仍经 `shouldStopAfterTurn` 到达内核；此前已接线的钩子 —— Turn
  Watch (2) 与 Tool Gate (4) —— 行为保持不变；
  桌面当前触发哪些钩子点，规格 13 §2C 按事件逐一说明。
- 已交付：Before Send (1) —— 运行时的 `input` 钩子在 Electron main 持久化用户消息之后、
  进入队列之前触发，三种内核动作全部采纳；插件所做的每次改写都经 `plugin.rewrites.record`
  RPC 按差异级别存入（04-data-storage §4.15）并在消息行上标出（ADR 0295 规则 5）——
  以及 Session Lifecycle (11) —— 创建、切换、删除与 fork 均以仅告知方式通告，压缩交接保留其取消。
- 尚未交付：Turn Recap (8) 与 Turn Continue (10) —— 只有已注册的名字，背后没有钩子或调用；
  Approval Before (12) —— 未实现。
- Before Request (6) 在交付前已撤回：它的六个事件永远不会被查询，权限也没有在任何地方
  注册；槽位集合、逐槽位权限与实施
  顺序都由
  [ADR 0295](../../../adr/0295-runtime-slots-and-their-permissions.md) 固定。

## 3. 映射到产品里程碑

| 产品里程碑 | 插件目标 |
|---|---|
| M1骷髅 | 保留插件目录和接口存根 |
| M2 聊天运行时 | 非阻塞；可以并行设计 |
| M3工具 | ToolHost保留贡献挂钩 |
| M4 插件基金会 | R1完成 |
| M5硬化 | 插件隔离和稳定性 |
| 后MVP | 分阶段完成 R2 并推进 R3–R6 |

## 4. 成功指标（生态系统）

1. 即使没有新的官方版本，用户也可以通过插件扩展他们的工作流程
2.第三方可独立开发并本地安装插件
3.插件故障不会破坏主应用程序的可用性
4.安装任何插件之前权限可见且可拒绝

## 5. 风险和缓解措施

| 风险 | 缓解措施 |
|---|---|
| 过早建立市场会破坏核心的稳定 | 推迟市场； R1 优先执行本地操作 |
| 插件安全事件 | 默认拒绝+审核+稍后强制签名 |
| API 频繁损坏 | api版本 / schema版本 |
| 开发者门槛高 | 模板+hello示例+SDK |
