/**
 * 官网小代理：**只为取令牌**，不为看页面。
 *
 * 网页版面板（chat-demo）走的是官网额度，要靠 `Authorization: Bearer <userToken>`
 * 这一枚令牌；它是阁下的浏览器登录官网时存在 localStorage 里的，宿主进程碰不到。
 * 唯一稳妥的取法是让官网自己把请求发出来，我们抄一份头部——所以这里留一个回环代理：
 * 它把 chat.deepseek.com 原样端出来，用户（或我）打开一次、页面发一次接口，令牌就刷新了。
 *
 * 这里刻意不注入皮肤、不做录屏镜像、不转发记忆——那些职责已经在桥里了。
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordSessions } from './history.js'

export const UPSTREAM_HOST = 'chat.deepseek.com'
const CDN_HOST = 'fe-static.deepseek.com'
const CDN_ORIGIN = `https://${CDN_HOST}`
const CDN_PREFIX = '/__ds_static'
const DEFAULT_PORT = 8899
const PORT_ATTEMPTS = 12

/** 不能原样带给上游的请求头。 */
const REQUEST_SKIP = new Set([
  'host', 'connection', 'proxy-connection', 'upgrade', 'keep-alive',
  'accept-encoding', 'origin', 'referer', 'cookie',
])

/** 会让页面无法在别处正常显示的响应头。 */
const RESPONSE_DROP = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'report-to', 'nel',
  'strict-transport-security', 'set-cookie',
])

const jar = new Map()
let saveTimer = null
let lastBearer = ''
let listeningPort = 0
let loaded = false

function storeDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'deepseek-web')
}

function cookieFile() {
  return path.join(storeDir(), 'cookies.json')
}

function tokenFile() {
  return path.join(storeDir(), 'token.json')
}

/** 读一次磁盘上的 Cookie 罐（首次请求时懒加载）。 */
function loadJar() {
  if (loaded) return
  loaded = true
  try {
    const parsed = JSON.parse(fs.readFileSync(cookieFile(), 'utf8'))
    for (const [name, value] of Object.entries(parsed || {})) {
      if (typeof value === 'string') jar.set(name, value)
    }
  } catch {
    // 首次运行没有罐子，空罐才是正常起点。
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const file = cookieFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(jar)), { encoding: 'utf8', mode: 0o600 })
    } catch {
      // 罐子存不下不影响转发。
    }
  }, 400)
  if (typeof saveTimer.unref === 'function') saveTimer.unref()
}

function storeCookies(list) {
  if (!list) return
  for (const raw of list) {
    const parts = String(raw).split(';')
    const pair = parts.shift() || ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!name) continue
    let expired = false
    for (const attribute of parts) {
      const [keyPart, ...rest] = attribute.split('=')
      const key = keyPart.trim().toLowerCase()
      const attributeValue = rest.join('=').trim()
      if (key === 'max-age' && Number(attributeValue) <= 0) expired = true
      if (key === 'expires') {
        const when = Date.parse(attributeValue)
        if (!Number.isNaN(when) && when <= Date.now()) expired = true
      }
    }
    if (expired) jar.delete(name)
    else jar.set(name, value)
    if (jar.size > 300) jar.delete(jar.keys().next().value)
  }
  scheduleSave()
}

function cookieHeader() {
  if (jar.size === 0) return ''
  return Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ')
}

/**
 * 官网的接口用 localStorage 里的 `userToken` 做 Bearer，Cookie 罐单独不够
 * （只给 Cookie 会得到 40002 Missing Token）。凡是经过代理的已登录请求，都把最新令牌
 * 抄到磁盘供宿主使用——它是凭据：0600 落盘，不打日志，不回显。
 */
function rememberBearer(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return
  const token = header.slice(7).trim()
  if (token.length < 20 || token === lastBearer) return
  lastBearer = token
  try {
    fs.mkdirSync(storeDir(), { recursive: true })
    fs.writeFileSync(tokenFile(), JSON.stringify({ token, at: new Date().toISOString() }), {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch {
    // 落盘失败仍可继续转发。
  }
}

function rewriteText(text) {
  return text.split(CDN_ORIGIN).join(CDN_PREFIX)
}

function rewriteLocation(value) {
  return value.split(CDN_ORIGIN).join(CDN_PREFIX).split(`https://${UPSTREAM_HOST}`).join('')
}

function upstreamHeaders(req, targetHost, isCdn) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (REQUEST_SKIP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  headers.host = targetHost
  headers['accept-encoding'] = 'identity'
  if (!isCdn) {
    headers.origin = `https://${UPSTREAM_HOST}`
    const cookies = cookieHeader()
    if (cookies) headers.cookie = cookies
  }
  return headers
}

function forward(req, res) {
  loadJar()
  const rawUrl = req.url || '/'
  const isCdn = rawUrl.startsWith(CDN_PREFIX)
  const targetHost = isCdn ? CDN_HOST : UPSTREAM_HOST
  const targetPath = isCdn ? rawUrl.slice(CDN_PREFIX.length) || '/' : rawUrl

  if (!isCdn) rememberBearer(req)

  const upstream = https.request(
    {
      host: targetHost,
      servername: targetHost,
      port: 443,
      method: req.method,
      path: targetPath,
      headers: upstreamHeaders(req, targetHost, isCdn),
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode || 502
      const headers = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        const key = name.toLowerCase()
        if (RESPONSE_DROP.has(key)) continue
        if (key === 'location' && typeof value === 'string') {
          headers.location = rewriteLocation(value)
          continue
        }
        if (typeof value === 'string') headers[key] = value
        else if (typeof value === 'number') headers[key] = String(value)
        else if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string')) {
          headers[key] = value
        }
      }

      if (!isCdn) {
        try {
          storeCookies(upstreamRes.headers['set-cookie'])
        } catch {
          // 罐子出岔子不能让转发倒下。
        }
      }

      const contentType = String(upstreamRes.headers['content-type'] || '')
      const encoded = Boolean(upstreamRes.headers['content-encoding'])
      const rewritable =
        !encoded &&
        req.method !== 'HEAD' &&
        (/^text\/html\b/i.test(contentType) || /^text\/css\b/i.test(contentType))

      if (!rewritable) {
        // 官网侧栏列表：顺手截一份，公开用户不必额外翻页也能凑齐历史。
        const isSessionList = !isCdn && targetPath.startsWith('/api/v0/chat_session/fetch_page')
        if (isSessionList && !encoded && req.method === 'GET') {
          const chunks = []
          upstreamRes.on('data', (chunk) => chunks.push(chunk))
          upstreamRes.on('end', () => {
            const body = Buffer.concat(chunks)
            try {
              const parsed = JSON.parse(body.toString('utf8'))
              const list = parsed?.data?.biz_data?.chat_sessions
              if (Array.isArray(list)) {
                const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
                recordSessions(home, list)
              }
            } catch {
              // 截获失败不影响页面。
            }
            headers['content-length'] = String(body.length)
            try {
              res.writeHead(status, headers)
            } catch {
              res.writeHead(status)
            }
            res.end(body)
          })
          upstreamRes.on('error', () => {
            try {
              res.destroy()
            } catch {
              // 已经断了。
            }
          })
          return
        }
        try {
          res.writeHead(status, headers)
        } catch {
          res.writeHead(status)
        }
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        upstreamRes.on('error', () => {
          try {
            res.destroy()
          } catch {
            // 已经断了。
          }
        })
        upstreamRes.pipe(res)
        return
      }

      const chunks = []
      upstreamRes.on('data', (chunk) => chunks.push(chunk))
      upstreamRes.on('error', () => {
        try {
          res.writeHead(502, { 'cache-control': 'no-store' })
        } catch {
          // 头已发出。
        }
        try {
          res.end()
        } catch {
          // 无事可做。
        }
      })
      upstreamRes.on('end', () => {
        let text = ''
        try {
          text = rewriteText(Buffer.concat(chunks).toString('utf8'))
        } catch {
          text = Buffer.concat(chunks).toString('utf8')
        }
        if (/^text\/html\b/i.test(contentType)) {
          try {
            // 绝不缓存：皮肤或修丁更新后，旧的副本不该继续生效。
            headers['cache-control'] = 'no-store, must-revalidate'
            delete headers.etag
            delete headers['last-modified']
            // 入口脚本带 SRI 与来源白名单；去掉 crossorigin 保留同源加载。
            text = text.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '')
          } catch {
            // 宁可用原始 HTML，也不要丢页。
          }
        }
        const body = Buffer.from(text, 'utf8')
        headers['content-length'] = String(body.length)
        res.writeHead(status, headers)
        res.end(body)
      })
    },
  )

  upstream.on('error', (error) => {
    if (res.headersSent) {
      try {
        res.destroy()
      } catch {
        // 已经断了。
      }
      return
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`DeepSeek 代理转发失败：${error?.message || error}`)
  })

  req.on('aborted', () => {
    try {
      upstream.destroy()
    } catch {
      // 无事可做。
    }
  })
  res.on('close', () => {
    if (!res.writableEnded) {
      try {
        upstream.destroy()
      } catch {
        // 无事可做。
      }
    }
  })
  req.pipe(upstream)
}

/**
 * 起代理。
 * @param {number} port 首选端口（8899 与旧面板同源，浏览器里既有登录态可以复用）
 * @returns {{ url: () => string, stop: () => void }}
 */
export function startSiteProxy(port = DEFAULT_PORT) {
  const server = http.createServer((req, res) => {
    try {
      forward(req, res)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`DeepSeek 代理故障：${error?.message || error}`)
    }
  })
  // 长回答会流好几分钟，默认 300 秒的窗口会把它拦腰截断。
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.keepAliveTimeout = 65000

  let attempt = 0
  const listen = (candidate) => {
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE' && attempt < PORT_ATTEMPTS) {
        attempt += 1
        listen(candidate + 1)
        return
      }
      console.error('[chat-in-dsh] 官网代理起不来：', error?.message || error)
    })
    server.listen(candidate, '127.0.0.1')
  }
  server.on('listening', () => {
    listeningPort = server.address().port
  })
  listen(port)

  return {
    url: () => (listeningPort ? `http://127.0.0.1:${listeningPort}/` : ''),
    stop: () => {
      listeningPort = 0
      try {
        server.close()
      } catch {
        // 已经关了。
      }
    },
  }
}
