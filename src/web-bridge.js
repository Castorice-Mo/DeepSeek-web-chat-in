/**
 * 官网额度通道（web quota bridge）。
 *
 * chat-demo 会说 Anthropic Messages API；这里把它翻译成 chat.deepseek.com 自己的
 * `/api/v0/chat/completion`，于是请求落在官网账号的额度上（而不是 API 余额）。
 *
 * 通道成立需要三样东西，缺一不可：
 *   1. 站点令牌 —— localStorage.userToken，由 dsh-deepseek-web 时代的只读镜像
 *      落在 ~/.dsh/deepseek-web/token.json（0600）；
 *   2. PoW      —— 每个请求头都要带 `X-DS-PoW-Response: base64({...})`，
 *      答案由官方 sha3_wasm 的 `wasm_solve` 现算；
 *   3. 会话      —— 官网按 chat_session_id/parent_message_id 串历史，本模块负责
 *      把一段对话映射到一个官网会话上。
 *
 * 令牌只在本进程内存里流转，绝不写日志、不回显。
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.DEEPSEEK_WEB_BASE || 'https://chat.deepseek.com'
const COMPLETION_PATH = '/api/v0/chat/completion'

/**
 * 本机存储目录。
 *
 * 必须与 `site-proxy` 的写入位置是**同一个**：DSH_HOME 与 `homedir()` 不是一回事，
 * 自定义过 DSH_HOME 的机器上，写在一处、读在另一处就会得到「令牌明明登录了却不存在」。
 * 所以凡是没显式传 storeDir 的地方，都从这里取，而不是各自拼 `~/.dsh`。
 */
export function defaultStoreDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'deepseek-web')
}
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 每轮都现解一枚 PoW。
 *
 * 官方的挑战是**一次性**的：同一条答案用第二次会得到 40301 INVALID_POW_RESPONSE。
 * 之前这里按 target_path 缓存复用，结果同一会话第二轮起全部空回答——多轮对话其实一直是坏的。
 * 现解一次只要几十毫秒（wasm），不值得为这点开销冒断流的风险。
 */
/** conversation key -> { sessionId, lastMessageId, at } */
const conversations = new Map()

let wasmPromise
export function loadWasm(file) {
  if (!wasmPromise) {
    wasmPromise = WebAssembly.instantiate(fs.readFileSync(file), {}).then(result => result.instance.exports)
  }
  return wasmPromise
}

function putString(wasm, text) {
  const bytes = Buffer.from(text, 'utf8')
  const ptr = wasm.__wbindgen_export_0(bytes.length, 1) || 0
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes)
  return [ptr, bytes.length]
}

/** prefix 必须是 `salt_expire_at_`，否则 wasm 认为无解。 */
function solveChallenge(wasm, challenge) {
  const [cPtr, cLen] = putString(wasm, challenge.challenge)
  const [pPtr, pLen] = putString(wasm, `${challenge.salt}_${challenge.expire_at}_`)
  const ret = wasm.__wbindgen_add_to_stack_pointer(-16)
  try {
    wasm.wasm_solve(ret, cPtr, cLen, pPtr, pLen, challenge.difficulty)
    const view = new DataView(wasm.memory.buffer)
    if (view.getInt32(ret, true) === 0) return undefined
    return view.getFloat64(ret + 8, true)
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

function baseHeaders(token) {
  return {
    'user-agent': UA,
    authorization: `Bearer ${token}`,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: BASE,
    referer: `${BASE}/`,
    'content-type': 'application/json',
  }
}

/**
 * 读取站点令牌。写入方是本站的 `site-proxy`（用户登录官网时从请求头上抄下来的），
 * 这里只读、不改。
 * @returns {string | undefined}
 */
export function readToken(storeDir = defaultStoreDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(join(storeDir, 'token.json'), 'utf8'))
    return typeof raw?.token === 'string' && raw.token.length > 20 ? raw.token : undefined
  } catch {
    return undefined
  }
}

/**
 * 通道事件日志（`channel-log.jsonl`）。
 *
 * 面板那端只会弹一句「消息未能发送」，报障时最想知道的是「卡在哪一步」。
 * 这里只记分类、状态码与一句人话：**不写令牌、不写请求头、不写对话正文**。
 * 上限 200 行，超了从最早的丢。
 */
const CHANNEL_LOG_LIMIT = 200

function channelLogFile(storeDir) {
  return join(storeDir, 'channel-log.jsonl')
}

/** 追加一条通道事件；失败静默（日志坏了不能影响对话）。 */
export function recordChannelEvent(storeDir, event) {
  const dir = storeDir || defaultStoreDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = channelLogFile(dir)
    let lines = []
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-(CHANNEL_LOG_LIMIT - 1))
    } catch {
      lines = []
    }
    const message = event?.message === undefined ? undefined : String(event.message).slice(0, 300)
    lines.push(JSON.stringify({ at: new Date().toISOString(), ...event, ...(message === undefined ? {} : { message }) }))
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 日志是旁路：写不进去也不该改变请求的结果。
  }
}

/** 读最近的通道事件（新的在后）。 */
export function readChannelEvents(storeDir = defaultStoreDir(), limit = 5) {
  try {
    const lines = fs.readFileSync(channelLogFile(storeDir), 'utf8').split('\n').filter(Boolean).slice(-limit)
    const events = []
    for (const line of lines) {
      try {
        events.push(JSON.parse(line))
      } catch {
        // 半行坏字跳过。
      }
    }
    return events
  } catch {
    return []
  }
}

/**
 * 令牌状态：有没有、多久写的、还能不能用。
 *
 * `expired` 不是过期时间的推断——官网的令牌不带宽限信息——而是「上一次真实请求
 * 被官网以令牌无效拒掉、并且之后既没有成功过、也没有换过新令牌」这一事实：
 * channel-log 里最后一条 `kind: 'token'` 晚于令牌落盘时间、且后面没有 `ok` /
 * `token-captured`，才判为过期。
 */
export function tokenStatus(storeDir = defaultStoreDir()) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(join(storeDir, 'token.json'), 'utf8'))
  } catch {
    raw = undefined
  }
  const present = typeof raw?.token === 'string' && raw.token.length > 20
  const status = {
    present,
    length: present ? raw.token.length : 0,
    at: present ? raw.at : undefined,
    expired: false,
  }
  if (present) {
    // 只有「最后一次失败是令牌无效、且之后再没有成功过、也没有换过新令牌」才算过期；
    // 否则偶尔一次 401（风控、瞬时抖动）会让横幅一直挂着「请重新登录」。
    const events = readChannelEvents(storeDir, 30)
    const lastFailure = [...events].reverse().find(event => event.kind === 'token')
    if (lastFailure) {
      const recovered = events.some(
        event => (event.kind === 'ok' || event.kind === 'token-captured') && String(event.at ?? '') > String(lastFailure.at ?? ''),
      )
      if (!recovered && String(lastFailure.at ?? '') > String(raw.at ?? '')) status.expired = true
    }
  }
  return status
}

/** 汇总一条自检口径：令牌、PoW 组件、代理地址、最近事件。 */
export function channelHealth(options = {}) {
  const storeDir = options.storeDir || defaultStoreDir()
  const events = readChannelEvents(storeDir, 6)
  return {
    channel: 'web-quota',
    token: tokenStatus(storeDir),
    wasm: options.wasmFile ? fs.existsSync(options.wasmFile) : false,
    site: options.siteUrl || '',
    // 令牌实际落在哪：自定义过 DSH_HOME 的机器上，这一行能省掉大量猜测。
    store: storeDir,
    last: events.at(-1) ?? null,
    recent: events,
  }
}

async function createSession(token) {
  const res = await fetch(`${BASE}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: baseHeaders(token),
    body: '{}',
  })
  const text = await res.text()
  try {
    const json = JSON.parse(text)
    const id = json?.data?.biz_data?.chat_session?.id
    if (id) return id
  } catch {}
  throw new Error(`建会话失败 HTTP ${res.status}`)
}

export async function powHeader(token, wasm, targetPath) {
  const res = await fetch(`${BASE}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: baseHeaders(token),
    body: JSON.stringify({ target_path: targetPath }),
  })
  const json = JSON.parse(await res.text())
  const challenge = json?.data?.biz_data?.challenge
  if (!challenge) throw new Error(`取 PoW 挑战失败 code=${json?.code} msg=${json?.msg}`)

  const answer = solveChallenge(wasm, challenge)
  if (answer === undefined) throw new Error('PoW 无解')

  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: targetPath,
    }),
  ).toString('base64')
}

/**
 * 删掉一条官网会话（自检与清理临时会话用）。
 * 只对自建的临时会话调用；阁下的旧线程不要碰。
 */
export async function deleteSession(sessionId, options = {}) {
  const storeDir = options.storeDir || defaultStoreDir()
  const token = readToken(storeDir)
  if (!token) return false
  const send = async header => {
    const res = await fetch(`${BASE}/api/v0/chat_session/delete`, {
      method: 'POST',
      headers: { ...baseHeaders(token), ...(header ? { 'x-ds-pow-response': header } : {}) },
      body: JSON.stringify({ chat_session_id: sessionId }),
    })
    if (!res.ok) return false
    const json = await res.json().catch(() => ({}))
    return json?.code === 0
  }
  // 删除接口并非总要求 PoW：先直发，被拒再补一次挑战。
  if (await send()) return true
  const wasm = await loadWasm(options.wasmFile)
  const header = await powHeader(token, wasm, '/api/v0/chat_session/delete')
  return send(header)
}

/** Anthropic 的 content 可能是字符串，也可能是 [{type:'text',text}]。 */function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (typeof part === 'string' ? part : part && part.type === 'text' ? String(part.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * 从官网 SSE 的某个 data 负载里取出"当前完整回答文本"。
 *
 * 官网的形态有两种，长回答会混着用：
 *   1. 快照：`{"v":{"response":{...,"fragments":[{"type":"RESPONSE","content":"..."}]}}}`
 *   2. 增量：`{"p":"response/fragments/-1/content","o":"APPEND","v":"2"}`，
 *      以及更常见的**裸字符串** `{"v":"2"}` —— 没有 p、没有 o，就是往后接一段。
 * 只认带路径的增量会把长回答截成第一段，这是先前答句只剩几个字的根因。
 */
function textFromEvent(payload, state) {
  const view = payload?.v
  if (view && typeof view === 'object' && !Array.isArray(view) && view.response) {
    const parts = []
    for (const fragment of view.response.fragments || []) {
      if (String(fragment?.type || '').toUpperCase() !== 'RESPONSE') continue
      if (fragment.content) parts.push(String(fragment.content))
    }
    if (parts.length > 0) state.text = parts.join('\n')
    return
  }
  if (typeof view !== 'string') return
  const path = typeof payload?.p === 'string' ? payload.p : ''
  // 状态类负载（response/status 等）也带字符串 v，不能当成正文。
  if (path !== '' && !path.endsWith('/content')) return
  if (payload?.o === 'SET') state.text = view
  else state.text += view
}

/**
 * 拉某条官网会话的最新一条消息 id。
 *
 * 导入的历史是旧快照，官网线程之后可能还长过（实测样本：归档 4 条，官网 8 条），
 * 所以「接到哪条后面」不能照抄归档，续聊前现问一次最稳。只读。
 * @returns {Promise<number | undefined>}
 */
async function latestMessageId(token, sessionId) {
  try {
    const res = await fetch(`${BASE}/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`, {
      headers: { ...baseHeaders(token), accept: '*/*' },
    })
    if (!res.ok) return undefined
    const parsed = await res.json()
    const list = parsed?.data?.biz_data?.chat_messages
    if (!Array.isArray(list) || list.length === 0) return undefined
    const id = list.at(-1)?.message_id
    return typeof id === 'number' ? id : Number(id)
  } catch {
    return undefined
  }
}

/**
 * 把官网的非 2xx 翻成一句能照着做的话。
 *
 * 官网的错误体同时带 `code` 与 `msg`（`biz_code` 在少数接口上），令牌无效是
 * `40003`/HTTP 401，PoW 重放是 `40301`。面板那端只会显示通用提示，所以分类与
 * 原文都从这里给出去，并顺手记进通道日志。
 */
function classifyUpstream(status, bodyText) {
  const text = String(bodyText || '')
  let code
  let msg
  try {
    const parsed = JSON.parse(text)
    code = parsed?.code ?? parsed?.biz_code
    msg = parsed?.msg ?? parsed?.message
  } catch {
    // 非 JSON：只留状态码。
  }
  const detail = [status ? `HTTP ${status}` : '', code !== undefined ? `code ${code}` : '', msg ? String(msg).slice(0, 120) : '']
    .filter(Boolean)
    .join(' · ')
  if (status === 401 || code === 40002 || code === 40003 || /missing token|invalid token|token expired/iu.test(text)) {
    return {
      kind: 'token',
      status: 401,
      message: `官网说登录已失效（${detail}）：请点右下角 ⚙ →「登录官网」重新登录一次。`,
    }
  }
  if (code === 40301 || /invalid_pow/iu.test(text)) {
    return { kind: 'pow', status: 502, message: `PoW 校验失败（${detail}）：再发一次通常会自己换一枚挑战。` }
  }
  if (status === 429) {
    return { kind: 'rate', status: 502, message: `官网限流了（${detail}）：等一会儿再发。` }
  }
  return { kind: 'upstream', status: 502, message: `官网对话失败（${detail}）` }
}

/**
 * 跑一轮对话。
 *
 * @param {object} options
 * @param {string} options.prompt 最后一条用户消息
 * @param {string} [options.conversationKey] 用来复用官网会话
 * @param {{ sessionId: string } | undefined} [options.seed] 认出来的旧官网会话（导入的历史）
 * @param {boolean} [options.thinking]
 * @param {boolean} [options.search]
 * @param {string} [options.storeDir]
 * @param {string} options.wasmFile
 * @param {(chunk: string) => void} [options.onDelta]
 * @returns {Promise<{ text: string, sessionId?: string, messageId?: number }>}
 */
export async function complete(options) {
  const { prompt, conversationKey, seed, thinking = false, search = false, wasmFile, onDelta } = options
  // 附件：面板传来的 file id 原样就是官网的 file-…，直接进 ref_file_ids。
  const fileIds = Array.isArray(options.fileIds)
    ? options.fileIds.filter(id => typeof id === 'string' && id.length > 0).slice(0, 50)
    : []
  const storeDir = options.storeDir || defaultStoreDir()
  const startedAt = Date.now()
  const token = readToken(storeDir)
  if (!token) {
    // 这一支最值得记：报障的人往往就是卡在这里（登录窗口没走完、DSH_HOME 换过）。
    recordChannelEvent(storeDir, { kind: 'no-token', status: 401, message: 'token.json 不存在或为空' })
    throw Object.assign(
      new Error('还没有官网令牌：请点右下角 ⚙ →「登录官网」，在弹窗里登录一次再发送。'),
      { status: 401 },
    )
  }

  const wasm = await loadWasm(wasmFile)
  const key = conversationKey || createHash('sha1').update(prompt).digest('hex')
  let state = conversations.get(key)
  // 旧会话：接着官网原来那条线程聊，而不是另起炉灶。
  if (!state && seed?.sessionId) {
    const lastId = await latestMessageId(token, seed.sessionId)
    if (lastId !== undefined) {
      state = { sessionId: seed.sessionId, lastMessageId: lastId, at: Date.now() }
      conversations.set(key, state)
    }
  }
  if (!state) {
    state = { sessionId: await createSession(token), lastMessageId: null, at: Date.now() }
    conversations.set(key, state)
  }
  if (conversations.size > 200) conversations.delete(conversations.keys().next().value)

  const header = await powHeader(token, wasm, COMPLETION_PATH)
  const res = await fetch(`${BASE}${COMPLETION_PATH}`, {
    method: 'POST',
    headers: { ...baseHeaders(token), accept: 'text/event-stream', 'x-ds-pow-response': header },
    body: JSON.stringify({
      chat_session_id: state.sessionId,
      parent_message_id: options.parentMessageId ?? state.lastMessageId ?? null,
      model_type: null,
      prompt,
      ref_file_ids: fileIds,
      thinking_enabled: Boolean(thinking),
      search_enabled: Boolean(search),
      preempt: false,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const failure = classifyUpstream(res.status, text)
    recordChannelEvent(storeDir, { kind: failure.kind, status: failure.status, http: res.status, message: failure.message })
    throw Object.assign(new Error(failure.message), { status: failure.status })
  }

  const acc = { text: '' }
  let sent = 0
  let messageId
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (!raw) continue
        let payload
        try {
          payload = JSON.parse(raw)
        } catch {
          continue
        }
        if (payload?.response?.message_id) messageId = payload.response.message_id
        if (payload?.v?.response?.message_id) messageId = payload.v.response.message_id
        if (typeof options.onEvent === 'function') options.onEvent(payload)
        const before = acc.text
        textFromEvent(payload, acc)
        if (acc.text.length > before.length && typeof onDelta === 'function') {
          const piece = acc.text.slice(sent)
          sent = acc.text.length
          if (piece) onDelta(piece)
        }
      }
    }
  }
  if (acc.text.length > sent && typeof onDelta === 'function') {
    onDelta(acc.text.slice(sent))
  }
  // 空流通常是风控或令牌问题；宁可报错，也不要让面板显示一片空白。
  if (acc.text.length === 0) {
    recordChannelEvent(storeDir, { kind: 'empty', status: 502, message: '官网没有返回任何内容' })
    throw Object.assign(
      new Error('官网这次没有返回任何内容（登录可能已过期，或被风控拦截）：可先在 ⚙ 里重新登录一次。'),
      { status: 502 },
    )
  }
  if (messageId !== undefined) state.lastMessageId = messageId
  state.at = Date.now()
  recordChannelEvent(storeDir, {
    kind: 'ok',
    status: 200,
    chars: acc.text.length,
    files: fileIds.length,
    ms: Date.now() - startedAt,
  })
  return { text: acc.text, sessionId: state.sessionId, messageId }
}

/** 把一次性问答写进 mneme，失败不影响对话。 */
export async function rememberExchange(pair) {
  let auth
  try {
    const raw = JSON.parse(fs.readFileSync(join(homedir(), '.dsh-mneme', 'cli.json'), 'utf8'))
    if (raw?.url && raw?.token) auth = { url: String(raw.url), token: String(raw.token) }
  } catch {
    return { ok: false, reason: 'mneme-not-configured' }
  }
  if (!auth) return { ok: false, reason: 'mneme-not-configured' }

  const flat = (text, size) => {
    const one = String(text || '').replace(/\s+/g, ' ').trim()
    return one.length <= size ? one : `${one.slice(0, size)}…`
  }
  const stamp = new Date().toISOString()
  const body = {
    type: 'history',
    title: `网页版面板 ${stamp.slice(0, 10)} · ${flat(pair.question, 30)}`,
    content: `网页版面板对话 · ${stamp.slice(0, 16).replace('T', ' ')}\n问：${flat(pair.question, 800)}\n答：${flat(pair.answer, 1200)}`,
    importance: 3,
    tags: ['deepseek-panel', 'chat-realtime'],
    source: 'chat-in-dsh/webquota',
    occurred_at: stamp,
  }
  try {
    const res = await fetch(`${auth.url}/memories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
      body: JSON.stringify(body),
    })
    return { ok: res.ok, status: res.status }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

export { textOfContent }
