/**
 * chat-in-dsh 宿主半边。
 *
 * 只做一件事：在 `/webchat` 下托管官方 chat-demo，并替浏览器把请求转发给 DeepSeek
 * （浏览器不持有 API Key，用户也不需要登录）。
 *
 * 网页版与 DSH 会话互不干涉：网页版用上游自带的本地存储，DSH 的会话不会出现在里面，
 * 网页版的对话也不会写进 DSH。两边的系统提示词与工具都不同，混合只会让双方都失真。
 */
import os from 'node:os'
import path from 'node:path'
import { createWebview } from './src/webview.js'
import { startSiteProxy } from './src/site-proxy.js'

export const name = 'chat-in-dsh'
export const inject = ['webServer']

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseURL?: string, sitePort?: number }} config
 */
export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  // 官网小代理：面板走官网额度需要浏览器里的令牌，这是唯一能把它抄下来的路径。
  // 同源（8899）意味着浏览器里既有的登录态可以直接复用，打开一次就能刷新。
  const site = startSiteProxy(Number(config.sitePort) || 8899)
  const webview = createWebview(ctx, { ...config, siteUrl: () => site.url() }, home)
  ctx.effect(() => () => site.stop(), 'webchat.site-proxy')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/webchat',
    handler: (req, res) => webview(req, res),
  }), 'webchat.routes')
}


