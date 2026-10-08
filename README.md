# Model Route Inspector

一个用于 Chrome / Edge 的 Manifest V3 扩展，用来观察 ChatGPT **每一轮对话的模型路由元数据**。

它会直接读取 ChatGPT 流式响应中的模型字段，对比：

```text
请求模型 → Resolved 模型 → Server 模型
```

例如：

```text
gpt-5-6-thinking
→ gpt-5-6-thinking
→ gpt-5-6-thinking
```

如果请求模型和服务端返回的实际路由模型明确不一致，插件会标记为红色；如果缺少关键字段，则显示“待确认”，不会用请求模型去补齐实际模型。

> **边界说明**
>
> 本插件观察的是 ChatGPT **服务端返回给客户端的模型身份 / 路由元数据**，例如 `resolved_model_slug` 和 `server_ste_metadata.metadata.model_slug`。
>
> 它适合发现客户端可见的模型路由变化，但不能从密码学意义证明服务器底层实际加载的模型权重一定对应这个名称。

---

## 安装

目前使用开发者模式加载，不需要安装依赖，也不需要构建。

### Chrome / Edge

1. 在 GitHub 仓库页面点击 **Code → Download ZIP**

2. 解压 ZIP

3. Chrome 打开：

   ```text
   chrome://extensions/
   ```

   Edge 打开：

   ```text
   edge://extensions/
   ```

4. 打开右上角 **开发者模式**

5. 点击 **加载已解压的扩展程序**

6. 选择解压后的项目根目录（里面应直接能看到 `manifest.json`）

7. 打开或刷新 `https://chatgpt.com/`

完成后，浏览器工具栏会出现 **Model Route Inspector**。

要求 Chrome / Edge 111+。

### 更新

开发者模式加载的扩展不会自动从 GitHub 更新。

更新时重新下载最新版 ZIP（或 `git pull`），然后在扩展管理页点击插件卡片上的 **刷新**，再刷新 ChatGPT 页面即可。

---

## 怎么用

正常使用 ChatGPT，不需要打开 DevTools。

每完成一轮回答，插件会记录：

```text
Requested
Resolved
Server
Judgment
```

例如：

```text
Requested  gpt-5-6-thinking
Resolved   gpt-5-6-thinking
Server     gpt-5-6-thinking
Judgment   match
```

目前真实运行中已经确认可以捕获：

```text
POST /backend-api/f/conversation
Content-Type: text/event-stream
```

并从返回流中识别：

- 请求体中的模型名
- `resolved_model_slug`
- `server_ste_metadata.metadata.model_slug`
- SSE / JSON event 数量
- generation stream 是否成功识别

Popup 会统计总请求数、一致/不一致/待确认或冲突次数、模型出现次数，以及每轮历史记录。统计累计范围为上次清空后，历史仅保留最近 1000 条；两者超过 1000 轮后不会相等。

---

## 判定规则

| 状态       | 含义                                          |
| ---------- | --------------------------------------------- |
| `match`    | 请求模型与实际模型一致                        |
| `mismatch` | 请求模型与实际模型明确不同                    |
| `unknown`  | 缺少关键字段，证据不足                        |
| `conflict` | Resolved 与 Server 两个服务端模型字段互相冲突 |

Requested / Resolved / Server 三个字段独立记录。

如果服务端没有返回 Resolved 或 Server，就保持未知，不会用 Requested 自动补齐。

`mismatch` 只表示**模型路由不一致**，不自动等同于“降级”。

---

## 工作原理

插件在 ChatGPT 页面 MAIN world 中包装 `window.fetch`，读取 `response.clone()` 的副本，因此不会消费网页原本的响应流。

```text
ChatGPT 发起请求
        ↓
监听 fetch
        ↓
筛选 conversation candidate
        ↓
clone response
        ↓
增量解析 SSE
        ↓
确认 generation stream
        ↓
提取 Requested / Resolved / Server
        ↓
判定 match / mismatch / unknown / conflict
        ↓
保存到 chrome.storage.local
```

当前已实际观察到主回答流：

```text
/backend-api/f/conversation
```

同时保留对旧 conversation 路径的兼容，并通过返回流特征进行二次确认，不只依赖固定 URL。

---

## 诊断

如果插件没有产生记录，可以打开 Popup 的 **诊断** 标签。

它会显示：

```text
MAIN world injection
fetch hook installed
fetch calls observed
candidates
generation streams matched
records produced
```

并区分：

### 最近观察请求

- URL / Endpoint
- Method
- HTTP Status
- Content-Type
- Classification
- 请求体中是否发现模型名

### 最近确认生成请求

- Endpoint
- Method
- HTTP Status
- Content-Type
- Transport
- SSE chunks
- SSE events
- JSON events
- `server_ste_metadata` 是否找到
- `resolved_model_slug` 是否找到
- Requested Model
- Parser Error

普通 `application/json` 请求即使带有模型名，也不会因此被当成 generation stream。

---

## 隐私

插件默认只保存模型路由相关元数据。

不会保存：

- 用户输入正文
- Assistant 回复正文
- System Prompt
- Reasoning 正文
- Cookie
- Authorization Header
- Access Token
- `resume_conversation_token`
- 完整 SSE 原始正文

数据仅保存在本地 `chrome.storage.local`。

未知 metadata key 只记录字段名称与类型，不保存对应值，也不会猜测未知字段的具体含义。已知字段同样按类型白名单净化，不保留任意嵌套对象。请求 URL 去除 query/hash，只保留安全接口路径。

历史仅允许扩展可信上下文直接读取。后台验证消息发送者与用途，并在 content script / 后台两层净化数据。网页 MAIN world 中的观测数据仍属于可被页面伪造的客户端证据；消息标记、字段白名单和模型名称都不构成服务器身份认证。

---

## 数据导出

Popup 支持：

- JSON 导出
- CSV 导出
- 清空历史
- 悬浮卡开关

历史最多保留最近 1000 轮。记录、清空、设置与导出按收到的顺序排队，避免并发快照覆盖；写入失败会返回错误，不把未保存的记录计入统计。重复 requestId 在当前保留窗口内去重。

CSV 会对公式前缀添加单引号，以便用电子表格安全打开。JSON 导出保留原有安全标量值，以及字段来源和 null/空字符串/类型异常状态；CSV 是扁平展示，不完整表达字段状态。

采集计时从发起 fetch 前开始：Response headers、First byte、First text、First reasoning、Complete 分别计到对应观测时点；Total 到观察分支运输结束。First delta 为首个回答文本或推理片段出现时点的兼容指标；推理先出现时它等于 First reasoning，应按用途优先查看两个独立指标。`streamComplete` 表示看到了完成标志，`transportCanceled` / `aborted` 表示观察分支的运输取消，两者可以同时为 true。取消原因没有用户行为证据时保持未知，不推断为用户主动停止。服务端 TTFVT 使用独立时钟，不能与浏览器指标相加。

---

## 项目结构

```text
model-route-inspector/
├── manifest.json
├── src/
│   ├── parser.js
│   ├── detector.js
│   ├── injected.js
│   ├── content.js
│   ├── background.js
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── icons/
├── test/
└── README.md
```

项目使用原生 JavaScript / HTML / CSS，无 React、Vue 和构建系统。

---

## 测试

```bash
pnpm exec node test/run-tests.js
pnpm exec node test/regression-test.js
pnpm exec node test/integration-test.js
pnpm exec node test/core-regression.js
pnpm exec node test/storage-regression.js
pnpm exec node test/ui-contract.js
```

测试覆盖 SSE 分块、真实字段结构 fixture、generation 识别、模型判定、敏感字段过滤，以及原始响应流不被破坏等场景。核心回归自带 `test/fixtures/compatibility-2026-10-08.json`，包含六种已观察场景的安全协议结构与路由字段，不依赖上一级证据目录；正文、资源引用和凭据均未纳入该 fixture。存储测试使用模拟 Chrome API 验证并发与失败恢复，不替代真实多标签页和重启持久化验收。

本地合成 UI 预览可运行 `pnpm exec node test/ui-preview.js`，访问 `http://127.0.0.1:4173/popup` 或 `/card`。预览使用合成元数据，不代表已安装扩展验收。`/baseline` 对照依赖原始 `a3f2d82` 提交；ZIP 或浅克隆缺少该提交时，对照明确返回不可用，当前预览仍可使用。

在上一级验证目录运行 `pnpm run test:all`，包括 2026-10-08 的安全结构回放与修复回归。本次为本地源码修改，版本号仍为 0.1.0，未表示发布。原始版在线兼容性结果不能作为修复版在线验收；范围见上一级审查报告。

---

## 已知限制

1. ChatGPT Web 的接口与字段属于前端内部协议，OpenAI 随时可能修改。
2. 当前主要监听 `window.fetch`；如果未来完全更换传输方式，需要增加新的监听方式。
3. 请求模型依赖请求体中的 `model` 字段，读取不到时会显示 `unknown`。
4. 插件只能验证客户端收到的模型路由元数据，不能证明服务器底层真实模型权重。
5. 当前支持 `chatgpt.com` 和 `chat.openai.com`。
6. 当前通过开发者模式安装，需要手动更新。

---

## Repository

https://github.com/black-zero358/model-route-inspector
