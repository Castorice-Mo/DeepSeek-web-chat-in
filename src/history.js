/**
 * 历史接入：把官网账号里的会话，转成面板能直接导入的暂存格式。
 *
 * 两条来源：
 *   1. 代理截下的列表（用户登录时，官网自己发出的 fetch_page 响应）——没有条数上限；
 *   2. 我们主动拉一次列表（count 上限 100，够普通账号）。
 * 消息正文一条条取 `/api/v0/chat/history_messages`，转换后写进 `${home}/webchat-imports/`，
 * 面板启动时自己就导进去了；同时建「旧会话指纹表」，让导入的会话能被续聊接回原线程。
 *
 * 并发度刻意压低（3），避免把阁下的账号打成异常流量。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const BASE = process.env.DEEPSEEK_WEB_BASE || 'https://chat.deepseek.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const CONCURRENCY = 3

function storeDir(home) {
  return path.join(home, 'deepseek-web')
}

export function readToken(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(storeDir(home), 'token.json'), 'utf8'))
    return typeof raw?.token === 'string' && raw.token.length > 20 ? raw.token : undefined
  } catch {
    return undefined
  }
}

function headers(token) {
  return {
    'user-agent': UA,
    authorization: `Bearer ${token}`,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'x-app-version': '20241129.1',
    'x-client-platform': 'web',
    'x-client-version': '1.0.0-always',
    origin: BASE,
    referer: `${BASE}/`,
  }
}

/** 已知会话清单（代理截获 + 主动拉取合并去重）。 */
function knownFile(home) {
  return path.join(storeDir(home), 'sessions-known.json')
}

export function readKnown(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(knownFile(home), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 记下一批会话条目（来自官网列表响应）。
 * @param {string} home
 * @param {Array<{id?: string, title?: string, updated_at?: number}>} list
 */
export function recordSessions(home, list) {
  if (!Array.isArray(list) || list.length === 0) return 0
  const known = readKnown(home)
  let added = 0
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id : ''
    if (id === '') continue
    if (!known[id]) added += 1
    known[id] = {
      title: String(item.title ?? '').slice(0, 200),
      at: Number(item.updated_at ?? 0),
    }
  }
  try {
    fs.mkdirSync(storeDir(home), { recursive: true })
    fs.writeFileSync(knownFile(home), JSON.stringify(known))
  } catch {
    // 清单落盘失败不影响收会话。
  }
  return added
}

/** 主动拉一次列表（上限 100，多了官网报 illegal count）。 */
async function fetchList(token) {
  const res = await fetch(`${BASE}/api/v0/chat_session/fetch_page?count=100`, { headers: headers(token) })
  if (!res.ok) return []
  const json = await res.json().catch(() => ({}))
  return json?.data?.biz_data?.chat_sessions ?? []
}

async function fetchMessages(token, sessionId) {
  const res = await fetch(
    `${BASE}/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`,
    { headers: headers(token) },
  )
  if (!res.ok) return undefined
  const json = await res.json().catch(() => ({}))
  return json?.data?.biz_data?.chat_messages
}

/** 片段 → 块：同类型连续合并，只取可显示的思考与正文。 */
function toBlocks(fragments) {
  const blocks = []
  for (const fragment of fragments ?? []) {
    const text = typeof fragment?.content === 'string' ? fragment.content : ''
    if (text.length === 0) continue
    if (fragment.type === 'THINK') {
      const last = blocks.at(-1)
      if (last?.type === 'thinking') last.thinking += text
      else blocks.push({ type: 'thinking', thinking: text })
    } else if (fragment.type === 'RESPONSE' || fragment.type === 'TEMPLATE_RESPONSE') {
      const last = blocks.at(-1)
      if (last?.type === 'text') last.text += text
      else blocks.push({ type: 'text', text })
    }
  }
  return blocks
}

/** 官网消息数组 → 面板能吃的会话（与插件自带导入用的同一套形状）。 */
export function convertSession(session, messages) {
  const out = []
  for (const message of messages ?? []) {
    const createdAt = Math.round(Number(message.inserted_at ?? 0) * 1000)
    const id = String(message.message_id ?? `${session.id}-${out.length}`)
    if (message.role === 'USER') {
      const text = (message.fragments ?? [])
        .map(fragment => (typeof fragment?.content === 'string' ? fragment.content : ''))
        .join('')
      if (text.trim().length === 0) continue
      out.push({ id, role: 'user', content: text, files: [], createdAt })
    } else if (message.role === 'ASSISTANT') {
      const blocks = toBlocks(message.fragments)
      if (blocks.length === 0) continue
      out.push({
        id,
        role: 'assistant',
        createdAt,
        model: 'deepseek-flash',
        thinking: blocks.some(block => block.type === 'thinking'),
        search: message.search_enabled === true,
        prefix: false,
        status: 'done',
        blocks,
        stopReason: 'end_turn',
      })
    }
  }
  if (out.length === 0) return undefined
  return {
    id: String(session.id),
    title: String(session.title ?? '') || '未命名对话',
    createdAt: out[0].createdAt,
    updatedAt: Math.round(Number(session.updated_at ?? 0) * 1000) || out.at(-1).createdAt,
    messages: out,
  }
}

/** 旧会话指纹：这条会话的全部用户消息依次哈希，续聊时面板带着同样序列来对。 */
function fingerprint(converted) {
  const users = converted.messages.filter(message => message.role === 'user').map(message => message.content)
  return users.length === 0 ? undefined : createHash('sha1').update(users.join('\u0000')).digest('hex')
}

/** 增量同步的「已收」记录：每个会话最后一次收下的官网时间戳（秒）。 */
function syncStateFile(home) {
  return path.join(storeDir(home), 'sync-state.json')
}

export function readSyncState(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStateFile(home), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSyncState(home, state) {
  try {
    fs.mkdirSync(storeDir(home), { recursive: true })
    fs.writeFileSync(syncStateFile(home), JSON.stringify(state))
  } catch {
    // 记不住只会让下次多抓一遍，不影响正确性。
  }
}

function loadIndex(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(storeDir(home), 'session-index.json'), 'utf8'))?.index ?? {}
  } catch {
    return {}
  }
}

function saveIndex(home, index) {
  try {
    fs.mkdirSync(storeDir(home), { recursive: true })
    fs.writeFileSync(
      path.join(storeDir(home), 'session-index.json'),
      JSON.stringify({ at: new Date().toISOString(), index }),
    )
  } catch {
    // 索引写不下去时，续聊退化为「新起一条线程」，不影响导入本身。
  }
}

/** 把一条官网会话暂存给面板，并记下指纹（续聊要靠它找回原线程）。 */
function stageOne(home, converted, staging, index) {
  const key = fingerprint(converted)
  if (key !== undefined) index[key] = { id: converted.id, title: converted.title, at: converted.updatedAt }
  fs.writeFileSync(
    path.join(staging, `${converted.id}.json`),
    JSON.stringify({ ...converted, importId: createHash('sha1').update(`${converted.id}:${Date.now()}`).digest('hex') }),
  )
  return converted.messages.length
}

/**
 * 并发抓一批会话并暂存。
 * @param {number} [deadline] 到点就不再开新的会话（已发出的请求照常收尾）。
 */
async function drain(token, queue, known, home, staging, index, state, deadline) {
  const counters = { sessions: 0, messages: 0, skipped: 0 }
  const worker = async () => {
    while (queue.length > 0) {
      if (deadline !== undefined && Date.now() > deadline) return
      const id = queue.shift()
      if (id === undefined) return
      let list
      try {
        list = await fetchMessages(token, id)
      } catch {
        list = undefined
      }
      if (!Array.isArray(list) || list.length === 0) {
        counters.skipped += 1
        continue
      }
      const converted = convertSession({ id, title: known[id]?.title, updated_at: (known[id]?.at ?? 0) }, list)
      if (converted === undefined) {
        counters.skipped += 1
        continue
      }
      try {
        counters.messages += stageOne(home, converted, staging, index)
        counters.sessions += 1
        state[id] = { at: Number(known[id]?.at ?? 0), title: String(known[id]?.title ?? '') }
      } catch {
        counters.skipped += 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  return counters
}

/**
 * 全量导入（⚙ →「接入历史」）。known 里的每个会话都会重抓一遍。
 * @returns {Promise<{sessions:number, messages:number, indexed:number, skipped:number, known:number}>}
 */
export async function importHistory(home) {
  const token = readToken(home)
  if (!token) throw Object.assign(new Error('还没有官网令牌：请先点「登录官网」'), { status: 401 })

  // 先把官网列表再拉一次，和截获的清单合并。
  const listed = await fetchList(token).catch(() => [])
  recordSessions(home, listed)
  const known = readKnown(home)
  const ids = Object.keys(known)
  if (ids.length === 0) {
    return { sessions: 0, messages: 0, indexed: 0, skipped: 0, known: 0 }
  }

  const staging = path.join(home, 'webchat-imports')
  fs.mkdirSync(staging, { recursive: true })
  const index = loadIndex(home)
  const state = readSyncState(home)
  const counters = await drain(token, [...ids], known, home, staging, index, state)
  saveIndex(home, index)
  writeSyncState(home, state)
  return { ...counters, indexed: Object.keys(index).length, known: ids.length }
}

/**
 * 增量同步：面板打开前、窗口重新获焦时调它。
 *
 * 只抓「官网更新过、而我们还没收」的会话——没有新东西时只花一次列表请求；
 * 有新的才按 limit 条数抓正文，到 deadline 就收手，剩下的留给下次。
 * 这样既不轮询、也不至于把账号打成异常流量。
 */
export async function syncHistory(home, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 30
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 20000
  const token = readToken(home)
  if (!token) {
    return { token: false, sessions: 0, messages: 0, skipped: 0, known: Object.keys(readKnown(home)).length, candidates: 0, more: 0 }
  }

  const listed = await fetchList(token).catch(() => [])
  recordSessions(home, listed)
  const known = readKnown(home)
  const state = readSyncState(home)
  const candidates = Object.entries(known)
    .filter(([id, meta]) => state[id] === undefined || Number(meta?.at ?? 0) > Number(state[id]?.at ?? 0))
    .sort((left, right) => Number(right[1]?.at ?? 0) - Number(left[1]?.at ?? 0))
  const batch = candidates.slice(0, limit).map(([id]) => id)
  const more = Math.max(0, candidates.length - batch.length)
  if (batch.length === 0) {
    return { token: true, sessions: 0, messages: 0, skipped: 0, known: Object.keys(known).length, candidates: 0, more: 0 }
  }

  const staging = path.join(home, 'webchat-imports')
  fs.mkdirSync(staging, { recursive: true })
  const index = loadIndex(home)
  const counters = await drain(token, batch, known, home, staging, index, state, Date.now() + budgetMs)
  saveIndex(home, index)
  writeSyncState(home, state)
  return { token: true, ...counters, known: Object.keys(known).length, candidates: candidates.length, more }
}
