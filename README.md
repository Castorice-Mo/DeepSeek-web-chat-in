# chat-in-dsh · 网页额度版

把 DeepSeek 官网的对话界面嵌进 DeepSeek Harness（DSH）的侧栏，**走自己的网页账号额度**，
对话实时写进 mneme 记忆库，外观跟随宿主皮肤与壁纸。

版本 `2.0.0-dshw.1`　|　MIT　|　上游 [YinkaiYu/chat-in-dsh](https://github.com/YinkaiYu/chat-in-dsh)

仓库地址：https://github.com/Castorice-Mo/DeepSeek-web-chat-in

---

## 一、这个项目解决什么问题

DSH 自带的对话走的是 API Key 通道，按 token 计费。但很多人手里同时有 DeepSeek 网页版账号
——那份额度、那段历史、那些「深度思考 / 智能搜索」的开关，用不上就浪费了。

同时把官网页面直接塞进面板会撞上三个现实问题：

| 问题 | 怎么来的 | 本项目的处理 |
|---|---|---|
| 计费走错通道 | 上游 chat-in-dsh 用宿主 API Key 代发 | 改用**网页账号额度**：宿主读站点令牌、现解 PoW，直接打 `chat.deepseek.com` |
| 面板是一块白板 | iframe 默认画布不透明，明暗两套主题对不上 | 与宿主**同源透明**，`color-scheme` 跟随父窗口，深/浅各一套薄玻璃 |
| 历史与记忆是断的 | 面板有自己的存储，与 DSH 会话、记忆库互不相干 | 接入账号历史（可续聊回原线程）+ 每轮问答实时写入 mneme |

一句话：**让面板长得像壁纸的一部分，花的是网页账号的额度，说的话还算进记忆库。**

## 二、主要功能

| 功能 | 说明 | 落点 |
|---|---|---|
| 网页版面板 | 侧栏面板列表里一个「网页版」，内嵌 DeepSeek 官网前端 | `GET /webchat/` |
| 网页额度通道 | 每轮现取 PoW 挑战并求解，调 `/api/v0/chat/completion`；**令牌只在本机** | `src/web-bridge.js` |
| 协议翻译 | 面板说 Anthropic Messages（SSE），宿主翻成官网 SSE 再翻回去 | `POST /webchat/anthropic/v1/messages` |
| 实时记忆 | 每轮问答写一条 `history` 进 mneme（问/答各截断），记忆库可检索 | `rememberExchange()` |
| 账号自助登录 | 右下角 ⚙ →「登录官网」，在弹窗里登自己的账号；令牌由本机回环代理截获并落盘（0600） | 面板内 UI + `src/site-proxy.js` |
| 历史接入 | 截官网会话列表 + 主动拉一次（单次 ≤100），逐条取正文转格式，交给面板导入 | `POST /webchat/api/history/import` |
| 续聊接回原线程 | 用「用户消息序列指纹」认出导入的会话，现拉线程末条 id 后接着聊 | `src/history.js` + `session-index.json` |
| 自适应壁纸 | 底色透明；明暗跟随宿主 `color-scheme`，父页换主题会被观察器跟上 | 注入的 `SKIN_CSS` / `SKIN_SCRIPT` |
| DSH 会话导入 | 会话右键菜单「导入到网页版」，把 DSH 会话一次性复制进面板 | `POST /webchat/api/import/stage` |
| 外观细节 | 面板缩放（Ctrl/Cmd+滚轮、顶部浮条）、麦克风桥、头像同步 | `client.js` |

**不支持（会明确返回 501，不装作成功）**：附件上传、语音输入/朗读。
**联网搜索**：面板上的开关会透传，但网页额度通道对 `search_enabled` 的实际支持以官网为准。

## 三、安装方法

### 前置

- DeepSeek Harness **桌面版或 Web 版**（需要 `webServer` 服务）
- `node >= 22.12`
- `dsh >= 0.1.7-alpha.1 < 0.3.0`

### 方式 A：指向目录（开发/本机推荐，可实时改）

把整个目录放到任意位置，然后在 DSH 的插件安装入口填入：

```
link:<本插件所在目录>
```

（Windows 路径用正斜杠；本机当前就是这样装的，profile 依赖写成
`"@castorice-mo/chat-in-dsh": "link:<本插件所在目录>"`。）

### 方式 B：分发包（给别人用）

```
castorice-mo-chat-in-dsh-2.0.0-dshw.1.tgz   # 约 1.8 MB
```

在插件安装入口填入 tarball 的绝对路径，或写成 pnpm 的 file 规格：

```
file:<下载目录>/castorice-mo-chat-in-dsh-2.0.0-dshw.1.tgz
```

> 本机只跑过方式 A；方式 B 若安装器不认 `file:`，把 tgz 解压后改用方式 A 的 `link:` 指向解压目录即可。

### 装完

重启 DSH（或重载插件），侧栏面板列表出现「**网页版**」。

## 四、使用方法

### 首次三步

1. 点开侧栏「网页版」，右下角有个 **⚙**；
2. 点「**登录官网**」——弹窗里用**你自己的**网页账号登录，回来后状态变 🟢「已登录」；
3. 点「**接入历史**」，读完再点「**重新载入**」，账号里的历史会话就出现在侧栏。

> 令牌是在本机回环代理（`127.0.0.1:8899`，被占用就顺延到 8910）里、从官网自己的请求头上抄下来的。
> 所以登录必须在**能连到本机这个端口**的浏览器里完成——面板里点开的那个窗口就是。
> 换台机器、换个浏览器要各自登一次。

### 日常使用

- **直接聊**：输入框说话即可；同一段对话会一直复用同一条官网会话。
- **多轮**：每轮都现解一枚 PoW，不会因为复用而中途变空。
- **续聊旧会话**：点开导入的历史接着问，桥认得出它对应官网哪条线程，会写回原来那条
  （官网侧也能看到新内容）。
- **导入 DSH 会话**：会话右键菜单 →「导入到网页版」。
- **面板缩放**：面板内 `Ctrl/Cmd + 滚轮`、`Ctrl/Cmd + ±`，或面板顶部居中的百分比浮条（`−` / `+` / 重置），缩放比例会记住。
- **界面文案**：面板在 DSH 插件列表里的名称与描述跟随 DSH 语言（`locale/zh.json`、`locale/en.json`）；
  面板内部的界面语言由官网前端自带。

### 本机落盘都在哪

| 路径 | 内容 |
|---|---|
| `~/.dsh/deepseek-web/token.json` | 官网令牌（0600） |
| `~/.dsh/deepseek-web/cookies.json` | 代理的 Cookie 罐（0600 语义，仅本机） |
| `~/.dsh/deepseek-web/sessions-known.json` | 官网已知会话清单（id / 标题 / 更新时间） |
| `~/.dsh/deepseek-web/session-index.json` | 「用户消息指纹 → 官网线程 id」，续聊用 |
| `~/.dsh/webchat-imports/*.json` | 待面板导入的会话（面板取走后自行删除） |

## 五、输入输出示例

### 1）对话：面板 → 宿主

面板按 Anthropic Messages 发请求：

```http
POST /webchat/anthropic/v1/messages
content-type: application/json

{
  "model": "deepseek-flash",
  "stream": true,
  "thinking": false,
  "search": false,
  "system": "……（面板自带的系统提示）",
  "messages": [
    { "role": "user", "content": "从1数到10" }
  ]
}
```

宿主回 SSE（中间增量已省略；实测这一问是 19 段增量、拼起来 20 个字符）：

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_…","type":"message","role":"assistant","model":"deepseek-web","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\n2"}}
…
event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}

event: message_stop
data: {"type":"message_stop"}
```

宿主 → 官网这一段（真实响应头，每轮一次）：

```text
POST /api/v0/chat/create_pow_challenge   {"target_path":"/api/v0/chat/completion"}
POST /api/v0/chat/completion             {chat_session_id, parent_message_id, model_type, prompt, thinking_enabled, search_enabled, …}

event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}
```

> PoW 的答案是一次性的：同一枚挑战第二次使用会得到 `{"code":40301,"msg":"INVALID_POW_RESPONSE"}`，
> 所以本插件每轮都重新求解，不缓存。

### 2）账号状态：`GET /webchat/api/account`

```json
{
  "token": { "present": true, "length": 64, "at": "2026-11-22T05:35:54.267Z" },
  "site": "http://127.0.0.1:8899/",
  "known": 0,
  "staged": 0
}
```

`known` 是已收集的官网会话条数，`staged` 是还没被面板收下的条数（首次使用都是 0）。

### 3）历史接入：`POST /webchat/api/history/import`

一次真实运行（拿到 100 条会话、550 条消息、78 条可续聊指纹，耗时 5.2 秒）：

```json
{ "ok": true, "sessions": 100, "messages": 550, "indexed": 78, "skipped": 0, "known": 100 }
```

- `sessions`：本次写进暂存的会话数；`messages`：其中可显示的消息数
- `indexed`：能自动接回官网线程的条数（只有回答、没有用户消息的会话无法指纹化）
- `skipped`：空会话或取正文失败的条数

随后面板启动时会自己把暂存导入本地库（`sessions` / `sessionSummaries` 两个 IndexedDB 表），
导完回执并删除暂存文件。

### 4）记忆库写入（旁路，失败不影响对话）

每轮问答落一条 `history`：

```json
{
  "type": "history",
  "title": "网页版面板 2026-11-22 · 从1数到10",
  "content": "网页版面板对话 · 2026-11-22 14:12\n问：从1数到10\n答：1\n2\n…",
  "importance": 3,
  "tags": ["deepseek-panel", "chat-realtime"],
  "source": "chat-in-dsh/webquota",
  "occurred_at": "2026-11-22T06:12:31.204Z"
}
```

写向本机 mneme 守护进程（地址与令牌取自 `~/.dsh-mneme/cli.json`），可用 `memory_search` 检索。

### 5）不支持的能力：明确 501

```http
POST /webchat/anthropic/v1/files
→ 501 {"error":{"message":"网页额度通道暂不支持附件上传"}}

POST /webchat/v1/tools/asr
→ 501 {"error":{"message":"网页额度通道暂不支持语音接口"}}
```

### 6）令牌文件（脱敏示意）

```json
{ "token": "<64 位不透明串>", "at": "2026-11-22T05:35:54.267Z" }
```

文件权限 `0600`；不写日志、不进对话、不上传。

## 六、工作原理

```text
┌──────────── DSH Web GUI（宿主主框架） ────────────┐
│  side panel「网页版」                              │
│   └─ iframe  /webchat/  ← chat-demo（官网前端）    │
│        │ fetch /webchat/anthropic/v1/messages      │
│        ▼                                           │
│   chat-in-dsh 宿主半边（Node）                     │
│     · 读 token.json                                │
│     · create_pow_challenge → wasm 求解 → completion│
│     · 官网 SSE → Anthropic SSE 翻译                │
│     · 每轮 rememberExchange → mneme                │
│   site-proxy 127.0.0.1:8899 ──► chat.deepseek.com  │
│     · 登录窗口、抄令牌、截会话列表                 │
└────────────────────────────────────────────────────┘
```

**外观**：面板与宿主同源，注入的 `SKIN_CSS` 把底面的 `--dsw-*` 变量置空让壁纸透上来，
浮层给一层薄玻璃；`SKIN_SCRIPT` 读父窗口的 `color-scheme` 并保持一致——
这一步同时是「白框」的根治点：父页深色而子页声明 `normal` 时，Chromium 会给这一帧铺一层不透明白底。

## 七、数据与隐私

- 令牌、Cookie、会话清单、指纹表**全部只在本机** `~/.dsh/deepseek-web/`，权限 0600。
- 不收集遥测；不向任何第三方转发对话内容。
- 历史导入是**本地副本**：用于翻看，不改变官网数据；在面板里继续追问才会写回官网线程。
- 面板里的对话与 DSH 自带会话互不干扰（两边系统提示词和工具不同，混合只会失真）。

## 八、已知限制

1. **会话列表单次上限 100 条**：官网列表接口没有可用的翻页参数（各种写法都返回同一页，`count>100` 报 `illegal count`）。历史更多时，在登录窗口里把官网侧栏往下滚一段，代理会顺手截获更多，再点「接入历史」。
2. **附件、语音不支持**（501）；联网搜索结果以官网为准。
3. **模型固定**：面板只认 `deepseek-flash` 这个 id，实际模型由官网决定。
4. **官网改版可能失效**：接口随时可能变，届时更新本插件。
5. **登录态按浏览器/机器**：换环境需重新登录一次。

## 九、目录结构

```text
chat-in-dsh/
├─ index.js              宿主入口：注册 /webchat 路由、启动官网小代理
├─ client.js             浏览器半边：面板、⚙ 账号与历史、缩放/麦克风/头像桥
├─ cordis.patch.yml      插件行（bundle 补丁）
├─ src/
│  ├─ webview.js         /webchat 的 HTTP 面：静态资源、登录引导、协议翻译、皮肤注入
│  ├─ web-bridge.js      网页额度通道：令牌、PoW、SSE、会话续接
│  ├─ site-proxy.js      回环代理：登录窗口、抄令牌、截会话列表
│  ├─ history.js         历史接入：拉列表/取正文/转格式/建指纹
│  ├─ dsh-import.js      DSH 会话 → 面板格式
│  ├─ protocol.js        上游地址与常量
│  └─ sha3_wasm_bg.wasm  官方 PoW 求解 wasm（26 KB）
├─ webview/dist/         官方 chat-demo 构建产物（仅打品牌与转发落点的补丁）
├─ locale/               中英文案
└─ icon.svg              面板图标
```

## 九·五、第三方资产

本包内含两份来自 DeepSeek 的第三方资产，各自的许可与归属如下：

| 资产 | 说明 | 许可 |
|---|---|---|
| `webview/dist/**` | DeepSeek 官方 chat-demo 的构建产物（本项目仅打了品牌与转发落点的补丁） | MIT © 2026 DeepSeek，见 `webview/dist/LICENSE` |
| `src/sha3_wasm_bg.wasm` | 官方 PoW 求解 wasm（26,612 字节），取自 `fe-static.deepseek.com`，仅用于本机计算工作量证明 | 随官网前端分发，此处按原样保留 |

本插件自身的代码以 MIT 发布（见 `LICENSE`）。

## 十、许可

MIT —— 全文见 [LICENSE](./LICENSE)。
上游 © 2026 Yinkai Yu（chat-in-dsh）；本分叉的改动 © 2026 Castorice-Mo，同样以 MIT 发布，上游版权声明原样保留。
