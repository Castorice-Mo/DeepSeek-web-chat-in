/**
 * `/webchat` 的 HTTP 面：
 *   - 静态资源：托管官方 chat-demo 的构建产物（只打了品牌与转发落点的补丁）；
 *   - 接口转发：浏览器不持有 API Key，由宿主用 DSH 的账户凭据代发；
 *   - 自检：把浏览器实际会走的几条路径跑一遍。
 *
 * 网页版有自己的一套存储（上游的 IndexedDB），与 DSH 会话互不相干——
 * 这是产品决定：两边的系统提示词和工具都不同，混合只会让双方都失真。
 *
 * 注意：DSH 的 `resource` 路由只接 GET/HEAD，聊天是 POST，所以用 `handler`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BASE_URL, TOKEN_HEADER, apiRoot, isInside } from './protocol.js'
import { ackPending, listPending, readDshSession, stageImport } from './dsh-import.js'
import { complete, readToken, rememberExchange, textOfContent, tokenStatus } from './web-bridge.js'
import { importHistory, readKnown, syncHistory } from './history.js'

/** 构建产物位置（包内自带，安装即可用）。 */
const DIST = fileURLToPath(new URL('../webview/dist/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

const MAX_BODY = 64 * 1024 * 1024

/**
 * 页面启动前的准备。
 *
 * chat-demo 的主题偏好默认是 `system`；父窗口若开着天光这类深色皮肤，
 * 面板就会整套白底，跟壁纸打架。所以在应用启动之前，先看一眼父窗口的明暗，
 * 把偏好定成对应的那一档——这一步必须早于应用读偏好。
 */
const BOOTSTRAP = `<script>(function(){
function parentDark(){
  try{
    var t=window.top,d=t&&t.document;
    if(!d||!d.documentElement)return true;
    var cs=getComputedStyle(d.documentElement).colorScheme||"";
    if(cs.indexOf("dark")>=0)return true;
    if(cs.indexOf("light")>=0)return false;
    var b=d.body;
    if(b&&(b.hasAttribute("data-ds-dark-theme")||b.classList.contains("dark")))return true;
    return getComputedStyle(b||d.documentElement).colorScheme.indexOf("dark")>=0;
  }catch(e){return true}
}
try{var s=window.localStorage;
if(!s.getItem('chat-demo:api-key'))s.setItem('chat-demo:api-key','dsh');
if(!s.getItem('chat-demo:locale'))s.setItem('chat-demo:locale','zh-CN');
if(!s.getItem('chat-demo:thinking'))s.setItem('chat-demo:thinking','true');
/* 跟随父窗口的明暗，别跟浏览器偏好走。 */
s.setItem('chat-demo:theme-preference',parentDark()?'dark':'light');
}catch(e){}})();</script>`

/** 统一 JSON 响应。 */
export function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读取请求体。 */
export async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 读取并解析 JSON 请求体。 */
async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  return JSON.parse(raw.toString('utf8'))
}
/**
 * 皮肤：让面板真正长在壁纸上。
 *
 * chat-demo 与 DSH 共用同一套 `--dsw-*` 设计变量，所以不必重做配色：
 * 把底面的几层变量让空，父窗口的壁纸就透上来了；其余浮层给一层薄玻璃。
 *
 * 两条铁律，都是实测出来的：
 *   1. `color-scheme` 必须与父页一致。父页深色而子页声明 normal（或不设）时，
 *      Chromium 会给这一帧铺一层不透明白底，怎么设透明都无效。
 *   2. 明暗两套玻璃分别挂在 `body[data-ds-dark-theme]` 与其余情况上，
 *      这样浅色壁纸的宿主也不会得到一片深色块。
 */
const SKIN_CSS = `<style id="chat-in-dsh-skin">
html,html body{background-color:transparent!important}
html body,#root{background:transparent!important;background-image:none!important}
html body{
--dsw-alias-bg-base:transparent!important;
--dsw-alias-bg-layer-1:transparent!important;
--dsw-alias-bg-layer-2:transparent!important;
--dsw-specific-sidebar-fill:transparent!important;
--dsw-alias-bg-mask-1:rgba(3,8,16,.5)!important;
--dsw-alias-bg-mask-drop:rgba(3,8,16,.6)!important;
}
/* 深色壁纸：冷色薄玻璃 */
html body[data-ds-dark-theme]{
--dsw-alias-bg-overlay:rgba(12,22,38,.84)!important;
--dsw-specific-menu:rgba(12,22,38,.84)!important;
--dsw-alias-tooltip-bg:rgba(12,22,38,.9)!important;
--dsw-specific-bubble:rgba(18,30,48,.42)!important;
--dsw-specific-tip:rgba(18,30,48,.46)!important;
--dsw-alias-bg-layer-3:rgba(18,30,48,.36)!important;
--dsw-alias-bg-module-platform:rgba(18,30,48,.34)!important;
--dsw-alias-interactive-bg-hover:rgba(127,182,255,.16)!important;
--dsw-alias-interactive-bg-active:rgba(127,182,255,.16)!important;
--dsw-alias-interactive-bg-hover-solid:rgba(70,118,170,.28)!important;
--dsw-alias-fill-l1:rgba(20,34,54,.46)!important;
--dsw-alias-fill-l2:rgba(20,34,54,.36)!important;
--dsw-alias-fill-tertiary:rgba(20,34,54,.32)!important;
--dsw-specific-input-major:rgba(16,26,42,.38)!important;
--dsw-specific-selector:rgba(18,30,48,.46)!important;
--dsw-alias-markdown-code-block:rgba(10,20,34,.44)!important;
--dsw-alias-markdown-code-block-banner:rgba(10,20,34,.46)!important;
--dsw-alias-settings-card-fill:rgba(16,26,42,.38)!important;
--dsw-alias-onboarding-card-fill:rgba(16,26,42,.38)!important;
--dsw-alias-bg-skeleton:rgba(126,178,232,.26)!important;
--dsw-alias-border-l1:rgba(126,178,232,.26)!important;
--dsw-alias-border-l2:rgba(142,194,246,.4)!important;
}
/* 浅色壁纸：暖白薄玻璃 */
html body:not([data-ds-dark-theme]){
--dsw-alias-bg-overlay:rgba(255,255,255,.92)!important;
--dsw-specific-menu:rgba(255,255,255,.92)!important;
--dsw-alias-tooltip-bg:rgba(255,255,255,.94)!important;
--dsw-specific-bubble:rgba(255,255,255,.5)!important;
--dsw-specific-tip:rgba(255,255,255,.56)!important;
--dsw-alias-bg-layer-3:rgba(255,255,255,.42)!important;
--dsw-alias-bg-module-platform:rgba(255,255,255,.4)!important;
--dsw-alias-interactive-bg-hover:rgba(64,120,200,.12)!important;
--dsw-alias-interactive-bg-active:rgba(64,120,200,.16)!important;
--dsw-alias-interactive-bg-hover-solid:rgba(64,120,200,.18)!important;
--dsw-alias-fill-l1:rgba(255,255,255,.5)!important;
--dsw-alias-fill-l2:rgba(255,255,255,.4)!important;
--dsw-alias-fill-tertiary:rgba(255,255,255,.36)!important;
--dsw-specific-input-major:rgba(255,255,255,.5)!important;
--dsw-specific-selector:rgba(255,255,255,.55)!important;
--dsw-alias-markdown-code-block:rgba(255,255,255,.46)!important;
--dsw-alias-markdown-code-block-banner:rgba(255,255,255,.5)!important;
--dsw-alias-settings-card-fill:rgba(255,255,255,.46)!important;
--dsw-alias-onboarding-card-fill:rgba(255,255,255,.46)!important;
--dsw-alias-bg-skeleton:rgba(120,150,190,.28)!important;
--dsw-alias-border-l1:rgba(80,110,150,.2)!important;
--dsw-alias-border-l2:rgba(60,90,130,.28)!important;
}
</style>`

const SKIN_SCRIPT = `<script>(function(){var r=document.documentElement;
/*
 * 明暗跟着父窗口走：父页深色就给 body 挂 dark 标记，浅色就摘掉。
 * chat-demo 自己的主题开关是 body 上的 class="dark" 与 data-ds-dark-theme（不是 html），
 * 而且它会在合上主题后的一刻重设，所以这里既抢在前面设，也用观察器兜住。
 */
function parentDark(){
  try{
    var t=window.top,d=t&&t.document;
    if(!d||!d.documentElement)return null;
    var cs=getComputedStyle(d.documentElement).colorScheme||"";
    if(cs.indexOf("dark")>=0)return true;
    if(cs.indexOf("light")>=0)return false;
    var b=d.body;
    if(b&&(b.hasAttribute("data-ds-dark-theme")||b.classList.contains("dark")))return true;
    return false;
  }catch(e){return null}
}
function pin(){
  var dark=parentDark();
  if(dark===null)dark=true;
  try{r.style.setProperty("color-scheme",dark?"dark":"light","important")}catch(e){}
  try{var b=document.body;if(b){
    if(dark){
      if(b.getAttribute("data-ds-dark-theme")!=="dark")b.setAttribute("data-ds-dark-theme","dark");
      if(!b.classList.contains("dark"))b.classList.add("dark");
      if(b.classList.contains("light"))b.classList.remove("light");
    }else{
      if(b.hasAttribute("data-ds-dark-theme"))b.removeAttribute("data-ds-dark-theme");
      if(b.classList.contains("dark"))b.classList.remove("dark");
      if(!b.classList.contains("light"))b.classList.add("light");
    }
  }}catch(e){}
}
pin();
document.addEventListener("DOMContentLoaded",pin);
try{new MutationObserver(pin).observe(r,{attributes:true,subtree:true,attributeFilter:["class","data-ds-dark-theme"]})}catch(e){}
try{
  var topd=window.top.document;
  new MutationObserver(pin).observe(topd.documentElement,{attributes:true,attributeFilter:["class","style","data-theme","data-ds-dark-theme"]});
  if(topd.body)new MutationObserver(pin).observe(topd.body,{attributes:true,attributeFilter:["class","style","data-ds-dark-theme"]});
}catch(e){}
setTimeout(pin,300);setTimeout(pin,1200);
})();</script>`

/** 读取入口页并注入引导脚本与皮肤；每次现读，避免插件升级后仍引用旧的资源名。 */
export function readIndex() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  return html.replace(/<head>/iu, `<head>${BOOTSTRAP}${SKIN_CSS}${SKIN_SCRIPT}`)
}

async function sendFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size })
  await pipeline(fs.createReadStream(file), res)
}

/** DSH 里模型设置默认使用的凭据名；安装可自定义 apiKeyEnv，优先按设置里的名字取。 */
const DEFAULT_API_KEY_REF = 'DEEPSEEK_API_KEY'

/** 从 DSH 设置描述里找 DeepSeek API Key 提供方配置的凭据名。 */
function findApiKeyRef(ctx) {
  try {
    const descriptors = ctx.get('settings')?.describe?.() ?? []
    const stack = descriptors.map(descriptor => descriptor?.value)
    while (stack.length > 0) {
      const value = stack.pop()
      if (value === null || typeof value !== 'object') continue
      for (const [key, entry] of Object.entries(value)) {
        if (/apikeyenv/iu.test(key) && typeof entry === 'string' && entry.length > 0) return entry
        if (entry !== null && typeof entry === 'object') stack.push(entry)
      }
    }
  } catch {
    // 设置服务不可读时退回约定名
  }
  return DEFAULT_API_KEY_REF
}

/** 解析一次上游请求的鉴权头：账户登录用 x-dsh-auth-token，API Key 路由用 x-api-key。 */
export async function resolveUpstreamAuth(ctx, baseURL) {
  const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
  if (token !== undefined) return { source: 'account', headers: { [TOKEN_HEADER]: token } }
  const ref = findApiKeyRef(ctx)
  let key
  try {
    const hit = await ctx.get('credentials')?.resolve(ref)
    key = hit?.value
  } catch {
    key = undefined
  }
  if (key === undefined || key.length === 0) {
    const ambient = process.env[ref]
    if (typeof ambient === 'string' && ambient.length > 0) key = ambient
  }
  if (key === undefined || key.length === 0) return undefined
  return { source: 'api-key', headers: { 'x-api-key': key } }
}

/** 官网 PoW wasm，随包分发，安装即用。 */
const WASM_FILE = fileURLToPath(new URL('./sha3_wasm_bg.wasm', import.meta.url))

/**
 * Anthropic Messages ⇄ 官网额度通道。
 *
 * 浏览器不持钥匙：宿主读站点令牌、现算 PoW，把一轮用户消息发给
 * `/api/v0/chat/completion`，再把官网 SSE 翻译回 Anthropic 事件。
 * 对话按「首条用户消息」映射到一个官网会话，历史由官网自己保存。
 */
/**
 * 旧会话指纹表（导入的历史 → 官网线程 id）。
 *
 * 面板点开一条导入的对话接着问时，它带的是完整历史；把本次提问去掉，
 * 剩下的用户消息序列就是这条会话的身份。命中即说明「官网有一条对应线程」。
 * 文件由插件外的归档转换脚本生成，这里只读，按 mtime 缓存。
 */
let sessionIndex = { at: 0, map: {} }
function lookupOldSession(home, key) {
  if (!key) return undefined
  const file = path.join(home, 'deepseek-web', 'session-index.json')
  try {
    const stat = fs.statSync(file)
    if (stat.mtimeMs !== sessionIndex.at) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      sessionIndex = { at: stat.mtimeMs, map: parsed?.index ?? {} }
    }
  } catch {
    return undefined
  }
  const hit = sessionIndex.map[key]
  return typeof hit?.id === 'string' && hit.id.length > 0 ? { sessionId: hit.id } : undefined
}

async function handleMessages(ctx, config, home, req, res) {
  let body
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
  } catch {
    sendJson(res, { error: { message: '请求体不是合法 JSON' } }, 400)
    return
  }

  const messages = Array.isArray(body.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find(message => message && message.role === 'user')
  const question = textOfContent(lastUser?.content).trim()
  if (!question) {
    sendJson(res, { error: { message: '没有可发送的用户消息' } }, 400)
    return
  }

  const firstUser = messages.find(message => message && message.role === 'user')
  const conversationKey = createHash('sha1')
    .update(`${textOfContent(body.system)}\u0000${textOfContent(firstUser?.content)}`)
    .digest('hex')

  // 这条会话是不是从官网导入的旧历史？是的话，续聊要接回原来那条线程。
  const userTexts = messages.filter(message => message && message.role === 'user').map(message => textOfContent(message.content))
  const historyKey = userTexts.length > 1
    ? createHash('sha1').update(userTexts.slice(0, -1).join('\u0000')).digest('hex')
    : ''
  const seed = lookupOldSession(home, historyKey)

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const streamId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  send('message_start', {
    type: 'message_start',
    message: {
      id: streamId,
      type: 'message',
      role: 'assistant',
      model: 'deepseek-web',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })

  let answer = ''
  try {
    const result = await complete({
      prompt: question,
      conversationKey,
      seed,
      thinking: Boolean(body.thinking) || /reason/iu.test(String(body.model ?? '')),
      search: Boolean(body.search),
      wasmFile: WASM_FILE,
      onDelta: chunk => {
        answer += chunk
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } })
      },
    })
    if (!answer && result.text) {
      answer = result.text
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } })
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: Math.max(1, Math.round(answer.length / 2)) },
    })
    send('message_stop', { type: 'message_stop' })
    res.end()
    // 记忆库是旁路：写失败不影响这轮对话。
    void rememberExchange({ question, answer })
  } catch (error) {
    send('error', { type: 'error', error: { type: 'api_error', message: String(error?.message ?? error) } })
    res.end()
  }
}

/** 附件上传转发：网页额度通道暂不支持附件，明确告知而不是静默失败。 */
async function proxyFiles(ctx, config, req, res, pathname) {
  sendJson(res, { error: { message: '网页额度通道暂不支持附件上传' } }, 501)
}
/** 语音输入 / 朗读：网页额度通道暂不支持，明确告知。 */
async function proxyTools(ctx, config, req, res, pathname) {
  sendJson(res, { error: { message: '网页额度通道暂不支持语音接口' } }, 501)
}

/** 自检：入口页、静态资源、一次真实生成。 */
async function selfTest(ctx, config) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  try {
    add('index', readIndex().includes('chat-demo:api-key'), `${readIndex().length} bytes`)
  } catch (error) {
    add('index', false, String(error?.message ?? error))
  }
  const main = (() => {
    try {
      return /src="(static\/js\/[^"]+\.js)"/u.exec(readIndex())?.[1]
    } catch {
      return undefined
    }
  })()
  add('static', main !== undefined && fs.existsSync(path.join(DIST, main)), main ?? 'not found')
  const token = readToken()
  add('token', Boolean(token), token ? '站点令牌已镜像（本地只读）' : '还没有站点令牌：请先打开一次 DeepSeek 面板')
  add('wasm', fs.existsSync(WASM_FILE), 'sha3_wasm_bg.wasm')
  return { ok: checks.every(check => check.ok), checks }
}

/**
 * 插件路由不在 DSH 的 /api 信任栅栏内，必须自己调用 Connection 的
 * Host/Origin 校验和浏览器认证；否则任何网页都能借已登录的 DSH 调用转发接口。
 * 桌面 App 自身窗口（dsh-app:）不走浏览器 Cookie，直接放行。
 * @returns {number | undefined} 拒绝状态码，放行时为 undefined
 */
function untrustedRejection(ctx, req) {
  const origin = String(req.headers?.origin ?? '')
  if (origin.startsWith('dsh-app:')) return undefined
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    return undefined
  }
  if (connection === undefined || typeof connection.requestRejection !== 'function') return undefined
  try {
    return connection.requestRejection(req)
  } catch {
    return 401
  }
}
/**
 * 建立请求处理器（Node 原生 req/res）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseURL?: string }} config
 * @param {string} home DSH_HOME，用来读 DSH 会话与存放待导入暂存
 */
export function createWebview(ctx, config, home) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const { pathname } = url
    const method = (req.method ?? 'GET').toUpperCase()
    const isGet = method === 'GET' || method === 'HEAD'

    // 与 DSH 自己的 /api 一样要求可信 Host/Origin 与已登录浏览器凭据。
    const rejection = untrustedRejection(ctx, req)
    if (rejection !== undefined) {
      sendJson(res, { error: { message: rejection === 403 ? '请求来源不受信任' : '需要 DSH 登录' } }, rejection)
      return
    }

    // ---- 从 DSH 一次性导入 ----
    if (pathname === '/webchat/api/import/stage' && method === 'POST') {
      const body = await readJsonBody(req)
      const sessionId = String(body.sessionId ?? '')
      const session = readDshSession(home, sessionId)
      if (session === undefined) {
        sendJson(res, { ok: false, error: '找不到这条会话，或它没有可导入的内容' }, 404)
        return
      }
      const staged = stageImport(home, session)
      sendJson(res, { ok: true, id: session.id, title: session.title, messages: session.messages.length, importId: staged.importId })
      return
    }
    if (pathname === '/webchat/api/import/pending' && isGet) {
      sendJson(res, listPending(home))
      return
    }
    if (pathname === '/webchat/api/import/ack' && method === 'POST') {
      const body = await readJsonBody(req)
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      // 新前端带 imports（含 importId）；兼容旧版只有 ids 的确认请求。
      const imports = Array.isArray(body.imports)
        ? body.imports
        : ids.map(id => ({ id }))
      sendJson(res, { removed: ackPending(home, imports) })
      return
    }
    if (pathname === '/webchat/api/self-test' && isGet) {
      try {
        sendJson(res, await selfTest(ctx, config))
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
      }
      return
    }

    // 账号与历史：面板右上角那个小齿轮读的就这两条。
    if (pathname === '/webchat/api/account' && isGet) {
      const dir = path.join(home, 'deepseek-web')
      let staged = 0
      try {
        staged = fs.readdirSync(path.join(home, 'webchat-imports')).filter(name => name.endsWith('.json')).length
      } catch {
        staged = 0
      }
      let known = 0
      try {
        known = Object.keys(readKnown(home)).length
      } catch {
        known = 0
      }
      sendJson(res, {
        token: tokenStatus(dir),
        site: typeof config.siteUrl === 'function' ? config.siteUrl() : '',
        known,
        staged,
      })
      return
    }

    if (pathname === '/webchat/api/history/import' && method === 'POST') {
      try {
        sendJson(res, { ok: true, ...(await importHistory(home)) })
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, error?.status ?? 500)
      }
      return
    }

    // 增量同步：面板打开前、窗口重新获焦时由浏览器半边调用。
    // 只抓官网有更新、我们还没收的会话；没新东西时开销就是一次列表请求。
    if (pathname === '/webchat/api/sync' && method === 'POST') {
      try {
        const result = await syncHistory(home, { limit: 30, budgetMs: 15000 })
        let pending = 0
        try {
          pending = fs.readdirSync(path.join(home, 'webchat-imports')).filter(name => name.endsWith('.json')).length
        } catch {
          pending = 0
        }
        sendJson(res, { ok: true, ...result, pending })
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, error?.status ?? 500)
      }
      return
    }

    // 通道自检：令牌、wasm 是否就位（不打真实请求，不耗额度）。
    if (pathname === '/webchat/api/channel' && isGet) {
      sendJson(res, {
        channel: 'web-quota',
        token: tokenStatus(),
        wasm: fs.existsSync(WASM_FILE),
        // 令牌过期时的刷新入口：打开它，官网会用自己的登录态再发一次令牌。
        site: typeof config.siteUrl === 'function' ? config.siteUrl() : '',
      })
      return
    }

    // 上游前端用一个 Key 做入口校验，宿主给个假的即可。
    if (pathname === '/webchat/models' && isGet) {
      sendJson(res, { object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] })
      return
    }

    if (pathname === '/webchat/anthropic/v1/messages' && method === 'POST') {
      try {
        await handleMessages(ctx, config, home, req, res)
      } catch (error) {
        if (!res.headersSent) sendJson(res, { error: { message: String(error?.message ?? error) } }, 502)
        else res.destroy()
      }
      return
    }

    if (pathname.startsWith('/webchat/anthropic/v1/files')) {
      try {
        await proxyFiles(ctx, config, req, res, pathname)
      } catch (error) {
        if (!res.headersSent) sendJson(res, { error: { message: String(error?.message ?? error) } }, 502)
        else res.destroy()
      }
      return
    }

    // 语音输入 / 回答朗读：/webchat/v1/tools/asr、/webchat/v1/tools/tts
    if (pathname.startsWith('/webchat/v1/tools/') && method === 'POST') {
      try {
        await proxyTools(ctx, config, req, res, pathname)
      } catch (error) {
        if (!res.headersSent) sendJson(res, { error: { message: String(error?.message ?? error) } }, 502)
        else res.destroy()
      }
      return
    }

    if (pathname === '/webchat' || pathname === '/webchat/') {
      // 仓库只保存自有代码，前端产物要单独取回；缺了就明说，别丢一个空白页。
      if (!fs.existsSync(path.join(DIST, 'index.html'))) {
        const hint = '<meta charset="utf-8"><p style="font:14px/1.7 system-ui;padding:24px">'
          + '缺少前端产物（<code>webview/dist</code>）。请在插件目录执行 '
          + '<code>npm run fetch:webview</code>，然后重载本插件。</p>'
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(hint) })
        res.end(method === 'HEAD' ? undefined : hint)
        return
      }
      const html = readIndex()
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(html),
      })
      res.end(method === 'HEAD' ? undefined : html)
      return
    }

    if (pathname === '/webchat/brand-mark.svg') {
      await sendFile(res, path.join(DIST, '..', 'brand-mark.svg'))
      return
    }

    if (pathname.startsWith('/webchat/')) {
      const target = path.resolve(DIST, pathname.slice('/webchat/'.length))
      if (!isInside(path.resolve(DIST), target)) {
        res.writeHead(403).end('forbidden')
        return
      }
      await sendFile(res, target)
      return
    }

    res.writeHead(404).end('not found')
  }
}



