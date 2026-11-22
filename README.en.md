# chat-in-dsh · web-quota edition

Embed the official DeepSeek web chat UI in the DeepSeek Harness (DSH) sidebar,
**billing your own web-account quota**, streaming every reply into the memory store,
and adapting to whatever theme and wallpaper the host uses.

Version `2.0.0-dshw.4` · MIT · a local fork of [YinkaiYu/chat-in-dsh](https://github.com/YinkaiYu/chat-in-dsh)

Repository: https://github.com/Castorice-Mo/DeepSeek-web-chat-in

---

## What problem it solves

DSH's built-in chat goes through an API key and bills per token. Many people also have a
DeepSeek **web account** — that quota, that history, and the *deep thinking / smart search*
toggles were simply unreachable. Dropping the site into a panel directly hits three walls:

| Problem | Cause | What this fork does |
|---|---|---|
| Wrong billing channel | Upstream calls DSH's own API key | Uses the **web account**: reads the site token, solves PoW per turn, talks to `chat.deepseek.com` |
| The panel is a white slab | An iframe paints an opaque canvas; theme mismatch | Same-origin **transparency**, `color-scheme` mirrors the host, one glass palette per mode |
| History and memory are disconnected | The panel keeps its own store | Imports account history (and continues it in the original thread) + writes each exchange to mneme |

## Features

| Feature | Notes | Where |
|---|---|---|
| Web chat panel | One sidebar entry, official DeepSeek front-end inside | `GET /webchat/` |
| Web-quota channel | Fresh PoW per turn, `POST /api/v0/chat/completion`; token never leaves the machine | `src/web-bridge.js` |
| Protocol translation | Anthropic Messages (SSE) ⇄ official SSE | `POST /webchat/anthropic/v1/messages` |
| Real-time memory | Every exchange becomes a `history` entry in mneme | `rememberExchange()` |
| Self-service sign-in | ⚙ → “Sign in”; the loopback proxy captures the token (0600) | `src/site-proxy.js` |
| History import | Captures the site's own session list + one active fetch (≤100), converts and stages it | `POST /webchat/api/history/import` |
| Incremental sync | On panel open / window refocus, fetches only sessions the site changed since last pickup; an idle run costs one list request | `POST /webchat/api/sync` |
| Continue old threads | Fingerprints the user-message sequence to resume the original official thread | `src/history.js` |
| Attachments | The panel uploads a photo/file; the host solves PoW, calls the official `upload_file`, waits for parsing, then sends the id as `ref_file_ids` | `POST /webchat/anthropic/v1/files` |
| Visible failures | A red banner in the panel names the real reason (not signed in / token expired / upstream 502); sanitised `channel-log.jsonl` behind it | injected `CHANNEL_SCRIPT`, `GET /webchat/api/channel` |
| Adaptive wallpaper | Transparent surfaces; light/dark glass follows the host | injected `SKIN_CSS` / `SKIN_SCRIPT` |

**Not supported (returns 501, never pretends)**: voice input / TTS.

## Install

Requires `node >= 22.12` and `dsh >= 0.1.7-alpha.1 < 0.3.0`.

Point the DSH plugin installer at the directory (development):

```
link:<path-to-this-directory>
```

or at the packaged tarball:

```
file:<download-dir>/castorice-mo-chat-in-dsh-2.0.0-dshw.4.tgz
```

Restart DSH (or reload the plugin). A “网页版 / DeepSeek web” entry appears in the sidebar.

### Path C: download the Release (recommended for end users)

Grab `castorice-mo-chat-in-dsh-<version>.tgz` from
[Releases](https://github.com/Castorice-Mo/DeepSeek-web-chat-in/releases) and point the DSH plugin
installer at it (`file:<download-dir>/...tgz`). The tarball **bundles the front-end build** — no
Node, no build step, no download on install.

### The repository holds code only

`webview/dist` (the official chat-demo build — **153 files, 4.25 MB**) is **not tracked**. Fetch it after cloning:

```bash
npm install            # the prepare hook fetches the build automatically
npm run fetch:webview  # or fetch it explicitly
```

Verified: the fetched tree is byte-identical (SHA-256 per file) to the one shipped inside the upstream npm package `chat-in-dsh@1.3.2`.

> Installing with a `github:` spec makes pnpm block the `prepare` script (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`); approve that build once in DSH, or prefer: clone → `npm install` → point DSH at the directory with `link:`.

## Usage

1. Open the panel, click the **⚙** in the bottom-right corner.
2. **Sign in** — log in with *your own* web account in the window that opens, then **stay on that
   page for a second or two**. The token is captured by the local loopback proxy
   (`127.0.0.1:8899`, falling forward to 8910) from the first `Authorization: Bearer` request the
   site itself sends after login; skip that and sends fail with nothing but a generic error.
3. **Import history** once for the full backfill (worth doing on an old account). After that you
   do not need to click it again: opening the panel or switching back to DSH runs an incremental
   sync, which brings in conversations created or continued on the official site.

Everything persistent stays local under `~/.dsh/deepseek-web/` (token, cookie jar, session
list, thread fingerprints, `channel-log.jsonl`) and `~/.dsh/webchat-imports/` (staging for the
panel import). `~/.dsh` here means `$DSH_HOME`; on a machine with a custom `DSH_HOME` everything
lives under `$DSH_HOME/deepseek-web/`, and the plugin reads and writes that same place.

Daily use: type to chat, attach photos or files with the composer's attachment button (the host
waits for the official parser, usually 2–4 s for images, then sends it as `ref_file_ids`), resume
imported threads, and use `Ctrl/Cmd + wheel` (or the top-centre zoom bubble) to scale the panel.

## Input / output examples

Panel → host:

```http
POST /webchat/anthropic/v1/messages
{
  "model": "deepseek-flash",
  "stream": true,
  "messages": [{ "role": "user", "content": "count from 1 to 10" }]
}
```

Host → panel (SSE, deltas collapsed):

```text
event: message_start
data: {"type":"message_start","message":{"role":"assistant","model":"deepseek-web"}}
event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}}
event: content_block_stop
event: message_stop
```

Account status:

```json
{ "token": { "present": true, "length": 64, "at": "2026-11-22T05:35:54.267Z", "expired": false },
  "wasm": true,
  "last": { "at": "2026-11-22T11:40:02.311Z", "kind": "ok", "status": 200, "chars": 6, "ms": 2180 },
  "site": "http://127.0.0.1:8899/", "known": 100, "staged": 0 }
```

Channel self-check (no quota spent, no real upstream request):

```json
GET /webchat/api/channel
{ "channel": "web-quota",
  "token": { "present": true, "length": 64, "expired": false },
  "wasm": true, "site": "http://127.0.0.1:8899/",
  "store": "C:\\Users\\<you>\\.dsh\\deepseek-web",
  "last": { "at": "…", "kind": "ok", "status": 200, "chars": 6, "ms": 2180 },
  "recent": [ { "at": "…", "kind": "token-captured", "status": 200 }, { "at": "…", "kind": "ok", "status": 200 } ] }
```

- `token.present=false` → no token yet: ⚙ → *Sign in*, then wait a second on the login page
- `token.expired=true` → the last real request was rejected as an invalid token: sign in again
- `wasm=false` → the bundled PoW component is missing: reinstall
- `store` → where the token actually lives (handy when `DSH_HOME` is custom)

History import (a real run):

```json
{ "ok": true, "sessions": 100, "messages": 550, "indexed": 78, "skipped": 0, "known": 100 }
```

Incremental sync (real runs: 100 uncached sessions pending, then nothing new):

```json
{ "ok": true, "sessions": 30, "messages": 215, "known": 100, "candidates": 90, "more": 60, "pending": 30 }
{ "ok": true, "sessions": 0,  "messages": 0,   "known": 100, "candidates": 0,  "more": 0,  "pending": 0 }
```

Sessions already picked up are recorded in `~/.dsh/deepseek-web/sync-state.json`, so an
unchanged `updated_at` is never fetched twice.

Attachment upload (real run: a 64×64 solid-red PNG, then “what colour is this image?”):

```json
POST /webchat/anthropic/v1/files (multipart: file)
→ 200 { "id": "file-c4c079b0-…", "type": "file", "filename": "dsh-red-final.png",
        "mime_type": "image/png", "size": 181, "model_kind": "VISION", "is_image": true }
→ model answer: 红色        (upload + parse took 3.5 s; a txt file took 2.1 s and answered 42)
```

The host waits until the official side reports the file as `SUCCESS`; sending a `ref_file_id`
while it is still `PARSING` is rejected upstream with `biz_code 9 invalid ref file id`.

Unsupported endpoints answer honestly:

```json
501 {"error":{"message":"网页额度通道暂不支持语音接口"}}
```

## Privacy

Tokens, cookies, session lists and fingerprints live only under `~/.dsh/deepseek-web/`
(mode 0600). No telemetry, no third-party uploads. Imported history is a local copy;
only a follow-up message is written back to the official thread.

Sync always reads **the account you signed in with on this machine**: the token and cookie jar
come from that one login, the plugin holds no other credential and cannot reach anyone else's
account. Incremental sync only issues read requests to `chat.deepseek.com` (list + messages);
conversation content is never uploaded anywhere else, and nothing server-side is created or
modified by it.

## Known limitations

- The session-list endpoint has no working pagination (`count` is capped at 100). Auto-sync
  therefore only covers additions and updates inside the newest 100 sessions; for older ones,
  scroll the site sidebar in the sign-in window so the proxy captures more, or run a full import.
- Sync is not realtime: no polling and no long-lived connection. It is triggered on panel mount
  and on window refocus (throttled to 5 minutes), so a conversation just created on the site
  arrives when you switch back.
- Voice endpoints are unsupported (501); search results depend on the site.
- Attachments land in your own official account storage: uploads use the site's own
  `upload_file`, and the site front-end exposes no delete-file endpoint (only upload / fetch /
  fork), so the plugin cannot remove them either.
- Uploads must be parsed before use: `PENDING` → `PARSING` → `SUCCESS`. The host waits up to
  90 s and then reports “file is still being parsed” instead of letting the panel say “server busy”.
- One request body is capped at 64 MB, with at most 50 attachment ids per turn.
- The model id is fixed to `deepseek-flash`; the actual model is chosen upstream.
- Site redesigns may break the interfaces — update the plugin when that happens.

## Troubleshooting: a message would not send

The panel now shows a red banner with the actual reason instead of the generic
"消息未能发送，请稍后重试". Without the banner, open ⚙ (last failure there) or read
`~/.dsh/deepseek-web/channel-log.jsonl` — every line is a sanitised one-liner.

| Symptom | Cause | Fix |
|---|---|---|
| Banner: **未登录官网** (not signed in) | `token.json` was never captured | ⚙ → *Sign in*, stay on the page for a second |
| Banner: **登录已过期** (login expired) | upstream rejected the last request as an invalid token | ⚙ → sign in again |
| Banner: **缺少 PoW 组件** | the bundled `sha3_wasm_bg.wasm` is gone | reinstall / `npm run fetch:webview` |
| Banner: **HTTP 429** | rate limited | wait a moment and resend |
| Banner: **HTTP 502 · code XXX** | upstream error, passed through verbatim | retry; if it persists the site changed — update the plugin |
| Panel keeps saying "server busy" | the attachment is still being parsed upstream | wait for `SUCCESS` (up to 90 s) |

What people ask most:

1. **When exactly is the token written?** Not at "login succeeded", but at the first request the
   site itself sends with `Authorization: Bearer` afterwards — the loopback proxy copies it into
   `$DSH_HOME/deepseek-web/token.json` (0600). Hence "stay a second on the login page".
2. **Can "not signed in" be told apart from "send failed"?** Yes: `token.present` says whether a
   token exists, `token.expired` says whether the last real request was rejected as invalid; the
   banner phrases the two separately, and any other failure carries the upstream message.
3. **Is the upstream status/code surfaced?** Yes — the host folds it into one readable line
   (`HTTP 401 · code 40003`), sends it as the SSE `error` event and writes it to the channel log;
   the banner shows exactly that line.

The log holds categories, status codes and one plain sentence: **no token, no cookie, no request
headers, no message bodies**.

## Third-party assets

| Asset | Notes | License |
|---|---|---|
| `webview/dist/**` | Official DeepSeek chat-demo build (only branding and forwarding patched) | MIT © 2026 DeepSeek, see `webview/dist/LICENSE` |
| `src/sha3_wasm_bg.wasm` | Official PoW solver wasm (26,612 bytes) from `fe-static.deepseek.com` | shipped as-is with the site front-end |

## License

MIT — see [LICENSE](./LICENSE). Upstream © 2026 Yinkai Yu; fork changes © 2026 Castorice-Mo.
