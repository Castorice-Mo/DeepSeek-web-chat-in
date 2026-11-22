/**
 * 附件上传：把面板的 Anthropic Files API 请求翻成官网自己的上传接口。
 *
 * 官网这条路比对话多一道坎：
 *   1. `POST /api/v0/file/upload_file` 要带 PoW（`target_path` 就是这条路径），
 *      multipart 字段名固定 `file`；
 *   2. 上传完文件只是 `PENDING`，服务端解析完才是 `SUCCESS`；
 *   3. 解析完成之前把 id 放进对话的 `ref_file_ids` 会被拒：`biz_code 9 invalid ref file id`。
 *
 * 所以这里上传后要轮询 `/api/v0/file/fetch_files` 直到 `SUCCESS` 才把 id 交回去。
 * 面板拿到 id 之后自己会拼成 `{type:'image'|'document', source:{type:'file', file_id}}`。
 */
import { loadWasm, powHeader, readToken } from './web-bridge.js'

const BASE = process.env.DEEPSEEK_WEB_BASE || 'https://chat.deepseek.com'
const UPLOAD_PATH = '/api/v0/file/upload_file'
const FETCH_PATH = '/api/v0/file/fetch_files'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const READY = 'SUCCESS'

function headers(token) {
  return {
    'user-agent': UA,
    authorization: `Bearer ${token}`,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    origin: BASE,
    referer: `${BASE}/`,
  }
}

function biz(payload) {
  return payload?.data?.biz_data
}

/**
 * 上传一份文件，返回官网的文件信息（此时通常还是 PENDING/PARSING）。
 * @returns {Promise<{ id: string, status?: string, file_name?: string, file_size?: number, is_image?: boolean, model_kind?: string }>}
 */
export async function uploadFile(options) {
  const { buffer, filename, mimeType } = options
  const storeDir = options.storeDir
  const token = readToken(storeDir)
  if (!token) throw Object.assign(new Error('还没有官网令牌：请先点「登录官网」'), { status: 401 })

  const wasm = await loadWasm(options.wasmFile)
  const pow = await powHeader(token, wasm, UPLOAD_PATH)

  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), filename || 'file')

  const res = await fetch(`${BASE}${UPLOAD_PATH}`, {
    method: 'POST',
    headers: { ...headers(token), 'x-ds-pow-response': pow },
    body: form,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw Object.assign(new Error(`上传失败 HTTP ${res.status}`), { status: 502 })
  }
  const data = biz(json)
  if (!data?.id) {
    throw Object.assign(new Error(`上传被拒：${json?.msg || json?.data?.biz_msg || `code ${json?.code}`}`), { status: 502 })
  }
  return data
}

/** 问一次文件状态（官网的解析进度就在这个接口里）。 */
async function fetchFile(token, fileId) {
  const res = await fetch(`${BASE}${FETCH_PATH}?file_ids=${encodeURIComponent(fileId)}`, { headers: headers(token) })
  const json = await res.json().catch(() => ({}))
  const list = biz(json)?.files
  return Array.isArray(list) ? list.find(item => item?.id === fileId) : undefined
}

function failed(file) {
  const status = String(file?.status ?? '')
  if (file?.error_code !== null && file?.error_code !== undefined) return `官网解析失败：${file.error_code}`
  if (/FAIL|ERROR|REJECT|BLOCK/iu.test(status)) return `官网解析失败：${status}`
  return undefined
}

/**
 * 等文件解析到 SUCCESS。
 * @returns {Promise<object>} 最终的文件信息
 */
export async function waitReady(fileId, options = {}) {
  const token = readToken(options.storeDir)
  if (!token) throw Object.assign(new Error('还没有官网令牌'), { status: 401 })
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 90000
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 800
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const file = await fetchFile(token, fileId)
    if (file !== undefined) {
      const bad = failed(file)
      if (bad !== undefined) throw Object.assign(new Error(bad), { status: 502 })
      if (String(file.status ?? '').toUpperCase() === READY) return file
    }
    if (Date.now() > deadline) {
      throw Object.assign(
        new Error('文件还在官网解析中，稍等片刻再发（附件在服务器那边解析完才能用）'),
        { status: 504 },
      )
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/**
 * 面板一次上传的完整流程：上传 → 等解析 → 交出 Anthropic Files API 形状。
 * `id` 直接就用官网的 `file-…`；发消息时原样进 `ref_file_ids`。
 */
export async function uploadForPanel(options) {
  const uploaded = await uploadFile(options)
  const ready = await waitReady(uploaded.id, {
    storeDir: options.storeDir,
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
  })
  return {
    id: ready.id,
    type: 'file',
    filename: ready.file_name ?? options.filename ?? 'file',
    mime_type: options.mimeType || (ready.is_image ? 'image/*' : 'application/octet-stream'),
    size: Number(ready.file_size ?? options.buffer?.length ?? 0),
    created_at: new Date().toISOString(),
    // 官网自己的信息，面板用不到，调试时好用。
    model_kind: ready.model_kind,
    is_image: ready.is_image === true,
  }
}
