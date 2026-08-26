# Model Route Inspector

一个 Chrome / Edge Manifest V3 扩展，自动检测 ChatGPT 每一轮对话**请求了什么模型**、**服务端流式响应里实际返回了什么模型**，用于发现静默降级、fallback 或模型路由变化。

> **重要边界**
> 本插件检测的是“服务端返回给客户端的模型身份 / 路由元数据”（`resolved_model_slug`、`server_ste_metadata.metadata.model_slug` 等）。
> 它可以发现**客户端可见**的静默路由变化，但**不能**从密码学意义上证明服务端实际运行的模型权重一定对应这个名称。
> 不要把 ChatGPT 页面 UI 上显示的模型名当作实际模型证据——核心证据来自服务端流式响应体里的模型元数据。

---

## 工作原理

1. `injected.js` 在页面 **MAIN world**（`document_start`）包装 `window.fetch`。
2. **两阶段识别**（不硬编码具体接口版本）：
   - 第一阶段粗筛：同域 + `POST` + 路径含 `conversation` + `response.body` 存在 → `response.clone()` 读副本。
   - 第二阶段确认：流中出现 generation 特征（`server_ste_metadata`、`message_marker`、`message_stream_complete`、`conversation_detail_metadata`、`delta_encoding`、`resume_conversation_token`、`resolved_model_slug`、`default_model_slug`）才认定为 ChatGPT 回答流并产出记录。
   - 因此同时支持 `/backend-api/conversation`、`/backend-api/f/conversation`，未来 `/backend-api/v2/conversation` 也不会直接死掉。
3. 只读取 `response.clone()` 的副本，原始响应原样返回页面——不破坏页面自身的 fetch、stream、AbortController、错误处理和响应速度。
4. 副本流用增量 SSE 解析器逐块解析，从 JSON 事件中提取模型路由字段。
5. 流结束后做一致性判定，结果经 `window.postMessage` → content script → service worker 写入 `chrome.storage.local`，并更新工具栏徽章、页面悬浮卡。
6. 不依赖 DevTools 打开。

### SSE 解析器特性

- 一个 JSON 被拆在多个 chunk 里也能正确重组
- 一个 chunk 包含多条 SSE 事件
- `event:` 与 `data:` 分行、多行 `data:`
- 以空行作为事件边界（兼容 `\n` 与 `\r\n`）
- 非 JSON 数据、`[DONE]`、malformed event 不抛异常
- 未来协议增加未知字段不会崩溃
- 命中前有 512KB 缓冲上限，避免把非 SSE 的大 JSON 整个读进内存
- 任何解析失败都被隔离，不影响 ChatGPT 本身

---

## 判定规则

| 情况 | status | 颜色 |
|---|---|---|
| 请求模型 == 实际模型（server 优先，resolved 次之，message.model 兜底） | `match` | 绿色 |
| 请求模型与实际模型**明确不同** | `mismatch` | 红色 |
| `resolved_model_slug` 与 `server_ste_metadata.metadata.model_slug` 互相矛盾 | `conflict` | 橙色 |
| 缺少关键字段，证据不足 | `unknown` | 黄色 |

**不会**因为只缺一个字段就误报降级：例如缺少 `resolved_model_slug` 但 `server_ste_metadata.metadata.model_slug` 与请求一致，仍判为 `match`；两者都缺才判 `unknown`。

---

## 捕获的字段

每条记录包含以下分类字段（全部来自服务端流式元数据，不含正文/凭据）：

- **身份**：`conversationId`、`messageId`、`serverRequestId`、`turnExchangeId`、`turnTraceId`、`endpoint`
- **路由**：`requestedModel`、`defaultModel`、`resolvedModel`、`serverModel`、`messageModel`、`modelSlug`
- **模式**：`requestedExperience`、`thinkingEffort`、`productExperience`、`turnMode`、`turnUseCase`
- **自动切换器**：`isAutoswitcherEnabled`、`didAutoSwitchToReasoning`、`autoSwitcherRaceWinner`、`modelSwitcherDeny`
- **服务端调度**：`fastConvo`、`warmupState`、`conduitPrewarmed`、`isFirstTurn`
- **账户**：`planType`、`planTypeBucket`
- **基础设施**：`clusterRegion`、`region`（两者分开保留）、`serverTtfvt`
- **传输**：`transport`（`sse`）、`responseStatus`、`contentType`、`resumeWithWebsockets`
- **任务类型**：`toolInvoked`、`toolName`、`isSearch`、`searchToolCallCount`、`searchToolQueryTypes`、`isMultimodal`、`didPromptContainImage`
- **性能**：`firstByteMs`、`firstDeltaMs`、`totalMs`、`reasoningStartTime`、`reasoningEndTime`、`reasoningDurationMs`、`finishedDurationSec`
- **结果**：`status`、`reason`、`conflict`、`fieldSources`（每个字段的 JSON 路径证据）

`requestedModel` 从请求体 `model` 字段读取（用 `request.clone()` 读取，不消耗原始请求体）。

---

## 诊断页（Popup「诊断」标签）

当“0 条记录”时，诊断页能在 5 秒内告诉你卡在哪一步：

- MAIN world injection / fetch hook 是否安装
- `fetch calls observed` / `conversation candidates` / `matched generation stream` / `records produced`
- 最近一次候选的 URL、Endpoint、Method、HTTP 状态、Content-Type、Transport
- SSE chunks / events / JSON events 计数
- `server_ste_metadata`、`resolved_model_slug`、requested model 是否找到
- 最近 parser error / error
- 最近判定结果与三个模型字段
- 未知 metadata key 名称列表（如 `a32e6ebcb`，只记名不记值不猜含义）

诊断数据通过 content script 实时向页面注入脚本查询，不落盘。

---

## 隐私

默认**不保存、不上传**以下任何内容：

- 用户输入正文、assistant 回复正文、system prompt、reasoning 内容
- `resume_conversation_token`、access token、authorization header、cookie 等任何认证凭据
- 完整请求/响应 headers

只保存模型路由相关元数据。存储采用白名单（`background.js` 的 `ALLOWED_FIELDS`），敏感字段名（`resume_conversation_token`、`token`、`cookie` 等）在提取阶段即被跳过。数据仅保存在本地 `chrome.storage.local`。

---

## 安装（开发者模式加载）

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目的 `model-route-inspector/` 目录
4. 打开或刷新 `https://chatgpt.com/`

要求 Chrome / Edge 111+（使用了 MV3 的 `world: "MAIN"` content script）。

---

## 如何验证是否发生模型切换

1. 在 ChatGPT 正常发送一条消息。
2. 观察工具栏徽章：绿色 `5.6`=一致，红色 `5.5m`=切换，黄色=待确认，橙色=冲突。
3. 点图标打开 Popup：
   - 「记录」标签：每轮的请求→实际模型、状态、统计（总数/一致/切换比例/各模型出现次数），点开看完整字段分组（路由/模式/自动切换器/调度/账户/传输/任务/基础设施/性能/追踪）和**判定依据**。
   - 「诊断」标签：如果没有记录，看这里定位卡在哪一步。
4. 页面右下角悬浮卡：切换时显示 `● GPT-5.5 Mini / from GPT-5.6 Thinking`，可关闭。
5. 模型发生变化时会发送系统通知。

### 手动构造判定验证

```js
// requested=5.6, resolved=5.5-mini, server=5.5-mini  => 必须判为 mismatch
```

真实环境下，当 ChatGPT 服务端因负载、配额或策略把请求路由到不同模型时，插件会自动捕获并标红。

---

## 数据导出与管理

Popup 顶部按钮：**JSON** 导出、**CSV** 导出、**清空**历史、**悬浮卡**开关。历史最多保存最近 **1000** 轮，超过自动删除最旧记录。

---

## 项目结构

```
model-route-inspector/
├── manifest.json
├── src/
│   ├── parser.js      # 增量 SSE 解析器（无浏览器依赖，可在 Node 中测试）
│   ├── detector.js    # 字段提取 + generation 特征识别 + 一致性判定
│   ├── injected.js    # MAIN world：包装 window.fetch，两阶段识别，诊断计数
│   ├── content.js     # ISOLATED world：桥接 + 悬浮卡 + 诊断查询
│   ├── background.js  # service worker：存储 / 徽章 / 通知 / 导出
│   ├── popup.html / popup.js / popup.css
├── icons/             # 图标（make_icons.py）
├── test/
│   ├── fixtures/real-conversation.js   # 基于真实字段结构的 SSE fixture（已脱敏）
│   ├── run-tests.js                    # parser + detector 单元测试
│   ├── regression-test.js              # fixture 回归测试
│   └── integration-test.js             # fetch 包装 / 两阶段识别 / 诊断 集成测试
└── README.md
```

无构建系统、无依赖、无 React/Vue，纯原生 JS/HTML/CSS。

---

## 测试

解析器、判定与 fetch 包装可在 Node 中直接跑（不依赖浏览器）：

```bash
node test/run-tests.js          # 51 项：SSE 边界 + 判定 + 敏感字段
node test/regression-test.js    # 47 项：真实字段结构 fixture 回归
node test/integration-test.js   # 35 项：/f/conversation、两阶段识别、诊断、原流完整性
```

`test/fixtures/real-conversation.js` 是基于真实 `/backend-api/f/conversation` 响应字段结构构造的 fixture（所有 ID/token/正文均为伪造），覆盖 `server_ste_metadata.metadata` 下的 `fast_convo`、`warmup_state`、`plan_type`、`cluster_region`、`server_ttfvt_ms`、`reasoning_start_time`、未知 key `a32e6ebcb` 等字段。ChatGPT 协议变化导致字段消失时，回归测试会第一时间炸掉，而不是插件悄悄失效。

已覆盖的关键场景：

- JSON 被拆成 1 字节 / 3 字节极小 chunk、单 chunk 多事件、CRLF、`[DONE]`、malformed JSON
- `/backend-api/f/conversation` 与旧 `/backend-api/conversation` 都能捕获
- 非 generation 流（如 title 接口返回 JSON）不产生记录
- `match` / `mismatch`（5.6 → 5.5-mini）/ `conflict` / `unknown`
- 缺少 `resolved` 字段时**不误报降级**
- `resume_conversation_token` 等敏感字段名和值都不落盘
- 多轮记录互不串、新建 conversation 可区分
- 页面原始响应体仍能被完整读取（`response.clone()` 不影响原流）
- 流中途 abort / 网络错误不抛异常
- 诊断计数可查询

---

## 已知限制

1. **未在真实登录态 ChatGPT 上端到端验证**：自动化测试覆盖了 SSE 解析、字段提取、判定、两阶段识别和 fetch 包装逻辑，但真实 ChatGPT 会话需要登录态，无法在无人值守环境下完成。请按「如何验证」在你自己的登录会话中确认；若有字段没抓到，用「诊断」标签定位后反馈。
2. **字段名跟随 ChatGPT 前端协议**：如果 OpenAI 更改 SSE 事件结构或字段名，对应字段会缺失，状态会显示为「待确认」而不是误报。解析器对未知字段向前兼容，但新字段需要显式添加提取规则；fixture 回归会在字段消失时报警。
3. **只包装了 `window.fetch`**：当前 ChatGPT 网页使用 fetch。`resume_with_websockets` 字段表示流支持 WebSocket 恢复/续传，但当前主回答仍通过 `/backend-api/f/conversation` 的 SSE 返回；若未来正文改走 WebSocket，需要补充对应拦截。
4. **请求模型来自请求体 `model` 字段**：读不到时 `requestedModel` 为空，状态为 `unknown` 而非 `mismatch`。
5. **不能证明服务端真实权重**：如顶部边界说明，元数据是客户端可见的“服务端自称”，不是密码学证明。
6. **仅匹配 `chatgpt.com` 与 `chat.openai.com`**：其它镜像站 / 企业自定义域名需在 `manifest.json` 的 `matches` 中添加。
7. **系统通知权限**：首次 mismatch 通知时浏览器可能请求通知权限；被禁用时记录与徽章照常工作。

---

## 许可证

仅供个人学习与研究使用。请遵守 ChatGPT 服务条款与当地法律法规。
