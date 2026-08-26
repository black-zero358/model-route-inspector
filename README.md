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

Popup 会统计总请求数、一致/不一致/待确认或冲突次数、模型出现次数，以及每轮历史记录。

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

未知 metadata key 只记录字段名称，不保存对应值，也不会猜测未知字段的具体含义。

---

## 数据导出

Popup 支持：

- JSON 导出
- CSV 导出
- 清空历史
- 悬浮卡开关

历史最多保留最近 1000 轮。

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
node test/run-tests.js
node test/regression-test.js
node test/integration-test.js
```

测试覆盖 SSE 分块、真实字段结构 fixture、generation 识别、模型判定、敏感字段过滤，以及原始响应流不被破坏等场景。

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

https://github.com/Liuxd-1230/model-route-inspector
