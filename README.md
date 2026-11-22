# chat-in-dsh · 网页额度版

把 DeepSeek 官网的对话界面嵌进 DeepSeek Harness（DSH）的侧栏，**走自己的网页账号额度**，
对话实时写进 mneme 记忆库，外观跟随宿主皮肤与壁纸。

版本 `2.0.0-dshw.4`　|　MIT　|　上游 [YinkaiYu/chat-in-dsh](https://github.com/YinkaiYu/chat-in-dsh)

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
| 自动增量同步 | 打开面板、窗口重新获焦时只抓「官网更新过、还没收」的会话；没新东西就只花一次列表请求 | `POST /webchat/api/sync` |
| 续聊接回原线程 | 用「用户消息序列指纹」认出导入的会话，现拉线程末条 id 后接着聊 | `src/history.js` + `session-index.json` |
| 自适应壁纸 | 底色透明；明暗跟随宿主 `color-scheme`，父页换主题会被观察器跟上 | 注入的 `SKIN_CSS` / `SKIN_SCRIPT` |
| DSH 会话导入 | 会话右键菜单「导入到网页版」，把 DSH 会话一次性复制进面板 | `POST /webchat/api/import/stage` |
| 附件上传 | 面板发照片/文件 → 宿主现解 PoW 调官网 `upload_file`，轮询到解析完成再交回 id；发消息时进 `ref_file_ids` | `POST /webchat/anthropic/v1/files` |
| 失败看得见 | 未登录 / 令牌过期 / 上游 502 时，面板顶部红色横幅写出真实原因；背后是脱敏的 `channel-log.jsonl` 与 `channel` 自检接口 | 注入的 `CHANNEL_SCRIPT`、`GET /webchat/api/channel` |
| 外观细节 | 面板缩放（Ctrl/Cmd+滚轮、顶部浮条）、麦克风桥、头像同步 | `client.js` |

**不支持（会明确返回 501，不装作成功）**：语音输入 / 朗读。
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
castorice-mo-chat-in-dsh-2.0.0-dshw.4.tgz   # 约 1.8 MB
```

在插件安装入口填入 tarball 的绝对路径，或写成 pnpm 的 file 规格：

```
file:<下载目录>/castorice-mo-chat-in-dsh-2.0.0-dshw.4.tgz
```

> 本机只跑过方式 A；方式 B 若安装器不认 `file:`，把 tgz 解压后改用方式 A 的 `link:` 指向解压目录即可。

### 方式 C：从 Release 下载（推荐给普通用户）

到 [Releases](https://github.com/Castorice-Mo/DeepSeek-web-chat-in/releases) 下载
`castorice-mo-chat-in-dsh-<版本>.tgz`，在 DSH 的插件安装入口填它的绝对路径，或写成
`file:<下载目录>/castorice-mo-chat-in-dsh-<版本>.tgz`。

这个包**自带前端产物**，不需要 Node、不需要构建、不需要联网取件，装完重启 DSH 即可。

### 源码仓库只含代码

`webview/dist`（DeepSeek 官方 chat-demo 的构建，**153 个文件、4.25 MB**）**不入库**——仓库里只保留自有代码。
克隆后先把它取回来：

```bash
npm install                      # 会自动执行 prepare 钩子完成取件
npm run fetch:webview            # 也可手动指定版本重取
CHAT_DEMO_VERSION=1.3.2 npm run fetch:webview
```

已核对：取回的产物与上游 npm 包 `chat-in-dsh@1.3.2` 内那份**逐文件 SHA256 相同**，本仓库未做任何改动。

> 用 `github:` 规格安装时，pnpm 会拦截这个 `prepare` 脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），
> 需要在 DSH 的安装提示里批准一次构建；最稳的路径仍是「克隆 → `npm install` → 在 DSH 里用 `link:` 指向该目录」。

### 装完

重启 DSH（或重载插件），侧栏面板列表出现「**网页版**」。

## 四、使用方法

### 首次三步

1. 点开侧栏「网页版」，右下角有个 **⚙**；
2. 点「**登录官网**」——弹窗里用**你自己的**网页账号登录，回来后状态变 🟢「已登录」；
   登录成功后请在弹窗里**停留一两秒**：令牌是官网自己发出请求的那一刻被回环代理抄下来的，
   这一步没走完，发送只会得到一句通用错误；
3. 点「**接入历史**」做一次全量导入（老账号第一次用，这一步值得做）。
   之后**不必再手动点**：每次打开面板、或从别的窗口切回来时，插件会自己增量同步官网新增的会话。

> 令牌是在本机回环代理（`127.0.0.1:8899`，被占用就顺延到 8910）里、从官网自己的请求头上抄下来的。
> 所以登录必须在**能连到本机这个端口**的浏览器里完成——面板里点开的那个窗口就是。
> 换台机器、换个浏览器要各自登一次。

### 日常使用

- **直接聊**：输入框说话即可；同一段对话会一直复用同一条官网会话。
- **多轮**：每轮都现解一枚 PoW，不会因为复用而中途变空。
- **续聊旧会话**：点开导入的历史接着问，桥认得出它对应官网哪条线程，会写回原来那条
  （官网侧也能看到新内容）。
- **导入 DSH 会话**：会话右键菜单 →「导入到网页版」。
- **发附件**：输入框旁的附件按钮选照片或文件。上传后宿主要等官网把文件解析完才交回 id
  （图片通常 2–4 秒），期间面板显示上传中；解析一完成就能连同提问一起发出。
  单次请求体上限 64 MB，一次最多带 50 个附件 id。
- **面板缩放**：面板内 `Ctrl/Cmd + 滚轮`、`Ctrl/Cmd + ±`，或面板顶部居中的百分比浮条（`−` / `+` / 重置），缩放比例会记住。
- **界面文案**：面板在 DSH 插件列表里的名称与描述跟随 DSH 语言（`locale/zh.json`、`locale/en.json`）；
  面板内部的界面语言由官网前端自带。
- **发不出去时看得见原因**：未登录、令牌过期、上游报错时，面板顶部会出现一条红色横幅写出真实原因
  （可 × 收起），不再只剩一句「消息未能发送，请稍后重试」；⚙ 里也能看到「最近一次失败」。

### 本机落盘都在哪

> 下表的 `~/.dsh` 就是 `$DSH_HOME`（默认值）。自定义过 `DSH_HOME` 的机器上，一切都在
> `$DSH_HOME/deepseek-web/`；插件读写用的是同一处，不会一边写一边读空。

| 路径 | 内容 |
|---|---|
| `~/.dsh/deepseek-web/token.json` | 官网令牌（0600） |
| `~/.dsh/deepseek-web/cookies.json` | 代理的 Cookie 罐（0600 语义，仅本机） |
| `~/.dsh/deepseek-web/sessions-known.json` | 官网已知会话清单（id / 标题 / 更新时间） |
| `~/.dsh/deepseek-web/session-index.json` | 「用户消息指纹 → 官网线程 id」，续聊用 |
| `~/.dsh/deepseek-web/channel-log.jsonl` | 通道事件（抄到令牌 / 缺令牌 / 上游报错 / 附件上传失败 / 成功一轮），最多 200 行 |
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
  "token": { "present": true, "length": 64, "at": "2026-11-22T05:35:54.267Z", "expired": false },
  "wasm": true,
  "last": { "at": "2026-11-22T11:40:02.311Z", "kind": "ok", "status": 200, "chars": 6, "ms": 2180 },
  "site": "http://127.0.0.1:8899/",
  "known": 100,
  "staged": 0
}
```

`known` 是已收集的官网会话条数，`staged` 是还没被面板收下的条数；`last` 是通道日志里的最后一条事件。

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

### 3·5）自动增量同步：`POST /webchat/api/sync`

面板打开前、窗口重新获焦时，浏览器半边会调它一次（5 分钟内不重复）。真机实测：

```json
// 官网有 100 条还没收，一轮最多抓 30 条
{ "ok": true, "token": true, "sessions": 30, "messages": 215, "skipped": 0,
  "known": 100, "candidates": 90, "more": 60, "pending": 30 }

// 没有任何更新时，只花一次列表请求
{ "ok": true, "token": true, "sessions": 0, "messages": 0, "skipped": 0,
  "known": 100, "candidates": 0, "more": 0, "pending": 0 }
```

- `candidates`：官网自上次收下后**有更新**的会话数；`more`：本轮因 `limit` / 时间预算没抓完、留给下次的条数
- 幂等：收过的会话记在 `~/.dsh/deepseek-web/sync-state.json`，`updated_at` 没变就不再抓
- 抓到东西后，插件会让面板 iframe 重挂一次——面板启动时本来就会读 `/webchat/api/import/pending`，
  于是新会话自然出现；若阁下正在面板里打字（焦点在面板内），这次不打扰，留到下次打开再收

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

### 5）附件上传：`POST /webchat/anthropic/v1/files`

面板上传照片或文件时走这里。宿主现解一枚 PoW 调官网 `upload_file`，再轮询
`/api/v0/file/fetch_files` 直到文件解析完成（`SUCCESS`）才把 id 交回去——
**解析完成前把 id 放进对话的 `ref_file_ids` 会被官网拒绝**（`biz_code 9 invalid ref file id`）。

```http
POST /webchat/anthropic/v1/files   (multipart: file)
→ 200 {"id":"file-c4c079b0-…","type":"file","filename":"dsh-red-final.png",
       "mime_type":"image/png","size":181,"created_at":"…","model_kind":"VISION","is_image":true}
```

真机实测：64×64 纯红 PNG 上传 + 等解析共 3.5 秒；随后带 `ref_file_ids` 问「这张图是什么颜色」，
模型答「红色」。txt 文档同样走这条：2.1 秒，问文件里的数字，答「42」。

### 6）不支持的能力：明确 501

```http
POST /webchat/v1/tools/asr
→ 501 {"error":{"message":"网页额度通道暂不支持语音接口"}}
```

### 7）通道自检：`GET /webchat/api/channel`

不耗额度、不打真实请求，只回答「卡在哪一步」。

```json
{
  "channel": "web-quota",
  "token": { "present": true, "length": 64, "at": "2026-11-22T05:35:54.267Z", "expired": false },
  "wasm": true,
  "site": "http://127.0.0.1:8899/",
  "store": "C:\\Users\\<你>\\.dsh\\deepseek-web",
  "last": { "at": "2026-11-22T11:40:02.311Z", "kind": "ok", "status": 200, "chars": 6, "ms": 2180 },
  "recent": [
    { "at": "2026-11-22T11:39:41.006Z", "kind": "token-captured", "status": 200 },
    { "at": "2026-11-22T11:40:02.311Z", "kind": "ok", "status": 200, "chars": 6, "files": 0, "ms": 2180 }
  ]
}
```

- `token.present=false`：令牌还没抄到 —— 点 ⚙ →「登录官网」，登录后在弹窗里停一两秒
- `token.expired=true`：上一轮真实请求被官网以令牌无效拒掉 —— 点 ⚙ →「重新登录」
- `wasm=false`：随包的 PoW 组件丢了 —— 重装插件
- `store`：令牌**实际**落在哪。自定义过 `DSH_HOME` 的机器上，看这一行比猜快

### 8）令牌文件（脱敏示意）

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
│     · 失败分类 + channel-log（脱敏）               │
│   site-proxy 127.0.0.1:8899 ──► chat.deepseek.com  │
│     · 登录窗口、抄令牌、截会话列表                 │
└────────────────────────────────────────────────────┘
```

**外观**：面板与宿主同源，注入的 `SKIN_CSS` 把底面的 `--dsw-*` 变量置空让壁纸透上来，
浮层给一层薄玻璃；`SKIN_SCRIPT` 读父窗口的 `color-scheme` 并保持一致——
这一步同时是「白框」的根治点：父页深色而子页声明 `normal` 时，Chromium 会给这一帧铺一层不透明白底。

**看得见原因**：同一个入口页还注入了 `CHANNEL_SCRIPT`——它问一次 `/webchat/api/channel`，
令牌缺失就挂一条中文横幅（写着该点哪里），并给 `fetch` 包一层、只盯 messages 接口：
非 2xx 读正文、SSE 里的 `error` 事件读 `message`。它只读、只显示，不改写面板的请求与响应。

## 七、数据与隐私

- 令牌、Cookie、会话清单、指纹表**全部只在本机** `~/.dsh/deepseek-web/`，权限 0600。
- **同步的永远是阁下自己的账号**：令牌与 Cookie 都来自本机这一次登录，插件没有别的凭据，也碰不到别人账号。
  自动增量同步只向 `chat.deepseek.com` 发读请求（列表 + 正文），会话内容不外发、不上传任何第三方；
  服务端那边本来就存着这些会话，插件不新增、不修改它们。
- 不收集遥测；不向任何第三方转发对话内容。
- **附件只往官网送**：照片与文件经官网自己的 `upload_file` 上传，落在阁下账号的存储里；
  插件不在本地另存副本，也无法删除它们（官网前端没有删文件接口）。
- 历史导入是**本地副本**：用于翻看，不改变官网数据；在面板里继续追问才会写回官网线程。
- 面板里的对话与 DSH 自带会话互不干扰（两边系统提示词和工具不同，混合只会失真）。

## 八、已知限制

1. **会话列表单次上限 100 条**：官网列表接口没有可用的翻页参数（各种写法都返回同一页，`count>100` 报 `illegal count`）。所以自动同步只能覆盖「最近 100 条」里的新增与更新；更老的会话要靠登录窗口里把官网侧栏往下滚、让代理截获，或手动点「接入历史」。
2. **同步不是实时的**：没有长连接或轮询，触发点只有两个——面板挂载、窗口重新获焦（5 分钟节流）。官网刚开的新对话，切回来时才被收。
3. **语音不支持**（501）；联网搜索结果以官网为准。
4. **附件会存进官网账号**：上传走的是官网自己的 `upload_file`，文件落在阁下的账号存储里；
   官网前端没有任何删文件接口（只有 upload / fetch / fork），所以插件也删不掉。
5. **附件解析要等**：上传后文件先是 `PENDING`、再 `PARSING`，解析成 `SUCCESS` 才能用；
   超时 90 秒会明确回报「文件还在解析中」，而不是让面板显示「服务器繁忙」。
6. **模型固定**：面板只认 `deepseek-flash` 这个 id，实际模型由官网决定。
7. **官网改版可能失效**：接口随时可能变，届时更新本插件。
8. **登录态按浏览器/机器**：换环境需重新登录一次。

## 八·五、排障：发送失败怎么办

先看面板顶部那条红色横幅——它现在写着真实原因，而不是「消息未能发送，请稍后重试」。
横幅看不到时，点 ⚙ 看「最近一次失败」，或读 `~/.dsh/deepseek-web/channel-log.jsonl`（都是脱敏的一行话）。

| 现象 | 原因 | 处理 |
|---|---|---|
| 横幅：**未登录官网** | `token.json` 还没被抄到 | ⚙ →「登录官网」，登录后在弹窗里停一两秒 |
| 横幅：**登录已过期** | 官网以令牌无效拒掉了上一轮请求 | ⚙ →「重新登录」 |
| 横幅：**缺少 PoW 组件** | 随包的 `sha3_wasm_bg.wasm` 丢失 | 重装插件 / `npm run fetch:webview` |
| 横幅：**官网限流 / HTTP 429** | 发得太密 | 等一会儿再发 |
| 横幅：**HTTP 502 · code XXX** | 官网接口报错（原样透出） | 稍后重试；持续出现说明官网改版，更新插件 |
| 面板一直显示「服务器繁忙」 | 附件还停在官网解析中 | 等解析完成（最多 90 秒）再发 |

三个常被问到的点：

1. **令牌什么时候落盘？** 不是「登录成功」那一刻，而是登录后官网自己发出第一个带
   `Authorization: Bearer` 的请求那一刻——回环代理从请求头上抄下来，写进
   `$DSH_HOME/deepseek-web/token.json`（0600）。所以登录窗口里要停一两秒、让它把首页数据拉完。
   之后每次再次打开登录窗口都会刷新这枚令牌。
2. **「未登录」和「发送失败」能分清吗？** 能。`/webchat/api/channel` 的 `token.present`
   是「有没有令牌」，`token.expired` 是「上一轮真实请求有没有被官网以令牌无效拒掉」，
   面板顶部的横幅按这两项分别提示；两者都不是时，失败原因来自上游原文。
3. **上游的 status / code 会透出吗？** 会。宿主把它整理成一句中文
   （`HTTP 401 · code 40003 · 登录已失效` 之类）同时写进 SSE 的 `error` 事件与
   `channel-log.jsonl`，面板顶部横幅显示的就是这句。

> 日志里只有分类、状态码与一句人话：**不含令牌、Cookie、请求头或对话正文**。

## 九、目录结构

```text
chat-in-dsh/
├─ index.js              宿主入口：注册 /webchat 路由、启动官网小代理
├─ client.js             浏览器半边：面板、⚙ 账号与历史、缩放/麦克风/头像桥
├─ cordis.patch.yml      插件行（bundle 补丁）
├─ src/
│  ├─ webview.js         /webchat 的 HTTP 面：静态资源、登录引导、协议翻译、皮肤注入、通道横幅脚本
│  ├─ web-bridge.js      网页额度通道：令牌、PoW、SSE、会话续接、失败分类与通道日志
│  ├─ files.js           附件上传：upload_file + PoW + 等解析到 SUCCESS
│  ├─ site-proxy.js      回环代理：登录窗口、抄令牌、截会话列表
│  ├─ history.js         历史接入：拉列表/取正文/转格式/建指纹
│  ├─ dsh-import.js      DSH 会话 → 面板格式
│  ├─ protocol.js        上游地址与常量
│  └─ sha3_wasm_bg.wasm  官方 PoW 求解 wasm（26 KB）
├─ scripts/fetch-webview.mjs  取回 webview/dist（该目录不入库）
├─ webview/dist/         官方 chat-demo 构建产物（不入库，由上面的脚本取回）
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
