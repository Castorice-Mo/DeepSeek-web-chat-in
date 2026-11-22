/**
 * 取回前端构建产物。
 *
 * 仓库只保存自有代码；`webview/dist`（DeepSeek 官方 chat-demo 的构建，153 个文件、
 * 约 4.25 MB）不入库。它们与上游 npm 包 `chat-in-dsh` 里那份逐文件相同，
 * 所以这里直接按版本从 npm 取回，不做任何改动。
 *
 * 用法：
 *   node scripts/fetch-webview.mjs            # 目标目录已存在时跳过
 *   node scripts/fetch-webview.mjs --force    # 覆盖
 *   CHAT_DEMO_VERSION=1.3.2 node scripts/...  # 指定上游版本
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const UPSTREAM_PKG = 'chat-in-dsh'
const VERSION = process.env.CHAT_DEMO_VERSION || '1.3.2'
const TARBALL = `https://registry.npmjs.org/${UPSTREAM_PKG}/-/${UPSTREAM_PKG}-${VERSION}.tgz`
const DIST_PREFIX = 'package/webview/dist/'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const TARGET = path.join(ROOT, 'webview', 'dist')
const force = process.argv.includes('--force')

function readString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString('utf8').replace(/\u0000.*$/u, '').trim()
}

/** 最小 tar 解析：posix ustar + pax 长路径（上游产物用不到，但别在这里翻车）。 */
function parseTar(buffer) {
  const entries = []
  let offset = 0
  let pendingPath
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    const name = readString(header, 0, 100)
    if (name === '') {
      offset += 512
      continue
    }
    const size = Number.parseInt(readString(header, 124, 12) || '0', 8) || 0
    const type = String.fromCharCode(header[156] || 48)
    const prefix = readString(header, 345, 155)
    const dataStart = offset + 512
    const data = buffer.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512

    if (type === 'x') {
      // pax 扩展头：下一条目的真实路径在 "路径长度 path=..." 里。
      const text = data.toString('utf8')
      const match = /\d+ path=([^\n]+)\n/u.exec(text)
      if (match) pendingPath = match[1]
      continue
    }
    if (type === 'g') continue

    const full = pendingPath ?? (prefix ? `${prefix}/${name}` : name)
    pendingPath = undefined
    entries.push({ path: full, type, data })
  }
  return entries
}

async function main() {
  if (fs.existsSync(TARGET) && fs.readdirSync(TARGET).length > 0 && !force) {
    console.log(`已存在：${TARGET}`)
    console.log('（加 --force 覆盖）')
    return
  }

  console.log(`取回 ${UPSTREAM_PKG}@${VERSION} 的 webview/dist …`)
  const response = await fetch(TARBALL)
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${TARBALL}`)
  const gz = Buffer.from(await response.arrayBuffer())
  const tar = zlib.gunzipSync(gz)
  const entries = parseTar(tar)

  const wanted = entries.filter(entry => entry.path.startsWith(DIST_PREFIX))
  if (wanted.length === 0) throw new Error(`包里没有 ${DIST_PREFIX}，上游结构可能变了`)

  fs.rmSync(TARGET, { recursive: true, force: true })
  let files = 0
  for (const entry of wanted) {
    const relative = entry.path.slice(DIST_PREFIX.length)
    if (relative === '') continue
    const destination = path.resolve(TARGET, relative)
    // 防目录穿越：任何解析结果都必须落在 TARGET 之内。
    if (!destination.startsWith(path.resolve(TARGET) + path.sep)) {
      throw new Error(`可疑路径，已中止：${entry.path}`)
    }
    if (entry.type === '5') {
      fs.mkdirSync(destination, { recursive: true })
      continue
    }
    if (entry.type !== '0') continue
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, entry.data)
    files += 1
  }

  const index = path.join(TARGET, 'index.html')
  const html = fs.readFileSync(index, 'utf8')
  // 原始入口页里没有 "chat-demo" 字样（那是宿主注入时才加的），认挂载点与入口脚本。
  if (!html.includes('id="root"') || !/static\/js\/main\.[^"]+\.js/u.test(html)) {
    throw new Error('index.html 看起来不是 chat-demo 的构建')
  }
  const mainJs = fs.readdirSync(path.join(TARGET, 'static', 'js')).filter(name => /^main\..+\.js$/u.test(name))
  if (mainJs.length === 0) throw new Error('缺少 static/js/main.*.js')

  console.log(`完成：${files} 个文件 → ${path.relative(ROOT, TARGET)}`)
  console.log(`入口：${mainJs[0]}／index.html ${html.length} 字节`)
}

main().catch(error => {
  console.error(`取件失败：${error?.message || error}`)
  process.exitCode = 1
})
