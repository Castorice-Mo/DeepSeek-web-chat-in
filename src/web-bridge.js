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
function loadWasm(file) {
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
export function readToken(storeDir = join(homedir(), '.dsh', 'deepseek-web')) {
  try {
    const raw = JSON.parse(fs.readFileSync(join(storeDir, 'token.json'), 'utf8'))
    return typeof raw?.token === 'string' && raw.token.length > 20 ? raw.token : undefined
  } catch {
    return undefined
  }
}

export function tokenStatus(storeDir = join(homedir(), '.dsh', 'deepseek-web')) {
  try {
    const raw = JSON.parse(fs.readFileSync(join(storeDir, 'token.json'), 'utf8'))
    return { present: true, length: String(raw.token || '').length, at: raw.at }
  } catch {
    return { present: false }
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

async function powHeader(token, wasm, targetPath) {
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
  const storeDir = options.storeDir || join(homedir(), '.dsh', 'deepseek-web')
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
  const storeDir = options.storeDir || join(homedir(), '.dsh', 'deepseek-web')
  const token = readToken(storeDir)
  if (!token) throw Object.assign(new Error('还没有官网令牌：请先打开一次 DeepSeek 面板'), { status: 401 })

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
      ref_file_ids: [],
      thinking_enabled: Boolean(thinking),
      search_enabled: Boolean(search),
      preempt: false,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw Object.assign(new Error(`官网对话失败 HTTP ${res.status} ${text.slice(0, 160)}`), { status: 502 })
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
    throw Object.assign(new Error('官网没有返回任何内容（令牌失效或被风控拦截）'), { status: 502 })
  }
  if (messageId !== undefined) state.lastMessageId = messageId
  state.at = Date.now()
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
