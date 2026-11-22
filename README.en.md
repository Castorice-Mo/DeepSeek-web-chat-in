# chat-in-dsh · web-quota edition

Embed the official DeepSeek web chat UI in the DeepSeek Harness (DSH) sidebar,
**billing your own web-account quota**, streaming every reply into the memory store,
and adapting to whatever theme and wallpaper the host uses.

Version `2.0.0-dshw.1` · MIT · a local fork of [YinkaiYu/chat-in-dsh](https://github.com/YinkaiYu/chat-in-dsh)

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
| Continue old threads | Fingerprints the user-message sequence to resume the original official thread | `src/history.js` |
| Adaptive wallpaper | Transparent surfaces; light/dark glass follows the host | injected `SKIN_CSS` / `SKIN_SCRIPT` |

**Not supported (returns 501, never pretends)**: attachments, voice input / TTS.

## Install

Requires `node >= 22.12` and `dsh >= 0.1.7-alpha.1 < 0.3.0`.

Point the DSH plugin installer at the directory (development):

```
link:<path-to-this-directory>
```

or at the packaged tarball:

```
file:<download-dir>/castorice-mo-chat-in-dsh-2.0.0-dshw.1.tgz
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
2. **Sign in** — log in with *your own* web account in the window that opens. The token is
   captured by the local loopback proxy (`127.0.0.1:8899`, falling forward to 8910).
3. **Import history**, then **Reload** — your account's conversations show up, and asking
   a follow-up continues the original official thread.

Everything persistent stays local under `~/.dsh/deepseek-web/` (token, cookie jar, session
list, thread fingerprints) and `~/.dsh/webchat-imports/` (staging for the panel import).

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
{ "token": { "present": true, "length": 64, "at": "2026-11-22T05:35:54.267Z" },
  "site": "http://127.0.0.1:8899/", "known": 0, "staged": 0 }
```

History import (a real run):

```json
{ "ok": true, "sessions": 100, "messages": 550, "indexed": 78, "skipped": 0, "known": 100 }
```

Unsupported endpoints answer honestly:

```json
501 {"error":{"message":"网页额度通道暂不支持附件上传"}}
```

## Privacy

Tokens, cookies, session lists and fingerprints live only under `~/.dsh/deepseek-web/`
(mode 0600). No telemetry, no third-party uploads. Imported history is a local copy;
only a follow-up message is written back to the official thread.

## Known limitations

- The session-list endpoint has no working pagination (`count` is capped at 100). Scroll the
  site sidebar in the sign-in window so the proxy captures more, then import again.
- Attachment / voice endpoints are unsupported (501); search results depend on the site.
- The model id is fixed to `deepseek-flash`; the actual model is chosen upstream.
- Site redesigns may break the interfaces — update the plugin when that happens.

## Third-party assets

| Asset | Notes | License |
|---|---|---|
| `webview/dist/**` | Official DeepSeek chat-demo build (only branding and forwarding patched) | MIT © 2026 DeepSeek, see `webview/dist/LICENSE` |
| `src/sha3_wasm_bg.wasm` | Official PoW solver wasm (26,612 bytes) from `fe-static.deepseek.com` | shipped as-is with the site front-end |

## License

MIT — see [LICENSE](./LICENSE). Upstream © 2026 Yinkai Yu; fork changes © 2026 Castorice-Mo.
