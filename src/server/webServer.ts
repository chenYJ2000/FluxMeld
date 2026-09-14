/**
 * Headless web server.
 *
 * Serves the built renderer, exposes the IPC channels over HTTP
 * (`POST /api/invoke`), pushes backend events over SSE (`GET /api/events`) and
 * reverse-proxies the OpenAI/proxy + management API paths to the in-process
 * proxy server.
 */

import Koa, { type Context, type Next } from 'koa'
import Router from '@koa/router'
import bodyParser from 'koa-bodyparser'
import http from 'http'
import { createReadStream, existsSync, readFileSync, statSync } from 'fs'
import { join, normalize, resolve, sep } from 'path'
import mime from 'mime-types'
import { ipcMain } from './stubs/electron'
import { subscribeToEvents } from './eventBus'

const PROXY_PATH_PREFIXES = ['/v1', '/v0', '/health', '/stats']

const BRIDGE_SCRIPT = `<script src="/__bridge.js"></script>`

export interface WebServerOptions {
  port: number
  host: string
  rendererDir?: string
  bridgePath?: string
  proxyPort: number
  accessPassword?: string
}

function resolveRendererDir(explicit?: string): string {
  return explicit || process.env.FLUXMELD_RENDERER_DIR || join(__dirname, '../renderer')
}

function resolveBridgePath(explicit?: string): string {
  return explicit || process.env.FLUXMELD_BRIDGE_PATH || join(__dirname, '__bridge.js')
}

function injectBridge(html: string): string {
  if (html.includes('/__bridge.js')) return html
  if (html.includes('</head>')) {
    return html.replace('</head>', `  ${BRIDGE_SCRIPT}\n</head>`)
  }
  return `${BRIDGE_SCRIPT}\n${html}`
}

function proxyToProxyServer(proxyPort: number) {
  return (ctx: Context): Promise<void> =>
    new Promise<void>((resolvePromise) => {
      const target = {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: ctx.url,
        method: ctx.method,
        headers: { ...ctx.headers, host: `127.0.0.1:${proxyPort}` },
      }

      const proxyReq = http.request(target, (proxyRes) => {
        ctx.status = proxyRes.statusCode || 502
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (value !== undefined) {
            ctx.set(key, value as string | string[])
          }
        }
        ctx.body = proxyRes
        resolvePromise()
      })

      proxyReq.on('error', (error) => {
        ctx.status = 502
        ctx.body = {
          error: {
            message: `Proxy server is not reachable on 127.0.0.1:${proxyPort}: ${error.message}`,
            type: 'proxy_unavailable',
          },
        }
        resolvePromise()
      })

      ctx.req.pipe(proxyReq)
    })
}

export async function startWebServer(options: WebServerOptions): Promise<http.Server> {
  const rendererDir = resolve(resolveRendererDir(options.rendererDir))
  const bridgePath = resolveBridgePath(options.bridgePath)
  const app = new Koa()
  app.keys = ['fluxmeld-web']
  const router = new Router()

  // Optional access password (disabled unless WEB_ACCESS_PASSWORD is set).
  if (options.accessPassword) {
    app.use(async (ctx: Context, next: Next) => {
      const provided =
        ctx.get('x-access-password') ||
        ctx.cookies.get('fluxmeld_access') ||
        (ctx.query.access as string | undefined)

      if (provided && provided === options.accessPassword) {
        if (ctx.query.access) {
          ctx.cookies.set('fluxmeld_access', options.accessPassword, {
            httpOnly: true,
            sameSite: 'lax',
          })
        }
        await next()
        return
      }

      ctx.status = 401
      ctx.body = 'Unauthorized'
    })
  }

  app.use(bodyParser({ jsonLimit: '100mb', formLimit: '100mb', textLimit: '100mb' }))

  router.post('/api/invoke', async (ctx: Context) => {
    const body = (ctx.request.body || {}) as { channel?: string; args?: unknown[] }
    const channel = body.channel
    const args = Array.isArray(body.args) ? body.args : []

    if (!channel || typeof channel !== 'string') {
      ctx.status = 400
      ctx.body = { ok: false, error: { message: 'Missing channel' } }
      return
    }

    if (!ipcMain.hasHandler(channel)) {
      ctx.status = 404
      ctx.body = { ok: false, error: { message: `Unsupported channel: ${channel}` } }
      return
    }

    try {
      const data = await ipcMain.invokeHandler(channel, ...args)
      ctx.body = { ok: true, data }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.status = 200
      ctx.body = { ok: false, error: { message } }
    }
  })

  router.get('/api/events', (ctx: Context) => {
    ctx.respond = false
    const res = ctx.res
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')

    const unsubscribe = subscribeToEvents((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n')
    }, 25000)

    ctx.req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })

  router.get('/__bridge.js', (ctx: Context) => {
    if (!existsSync(bridgePath)) {
      ctx.status = 404
      ctx.body = '// bridge not built'
      return
    }
    ctx.type = 'application/javascript'
    ctx.body = createReadStream(bridgePath)
  })

  const proxyMiddleware = async (ctx: Context, next: Next) => {
    if (
      PROXY_PATH_PREFIXES.some(
        (prefix) => ctx.path === prefix || ctx.path.startsWith(`${prefix}/`),
      )
    ) {
      await proxyToProxyServer(options.proxyPort)(ctx)
      return
    }
    await next()
  }

  app.use(proxyMiddleware)
  app.use(router.routes())
  app.use(router.allowedMethods())

  // Static renderer + SPA fallback.
  app.use(async (ctx: Context, next: Next) => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      await next()
      return
    }

    let relativePath: string
    try {
      relativePath = normalize(decodeURIComponent(ctx.path))
    } catch {
      relativePath = '/'
    }
    relativePath = relativePath.replace(/^([/\\])+/, '')

    let filePath = resolve(join(rendererDir, relativePath))
    if (filePath !== rendererDir && !filePath.startsWith(rendererDir + sep)) {
      ctx.status = 403
      ctx.body = 'Forbidden'
      return
    }

    if (!relativePath || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      filePath = join(rendererDir, 'index.html')
    }

    if (!existsSync(filePath)) {
      ctx.status = 404
      ctx.body = 'Not found. Did you run the web build?'
      return
    }

    if (filePath.endsWith('index.html')) {
      ctx.type = 'html'
      ctx.body = injectBridge(readFileSync(filePath, 'utf-8'))
      return
    }

    ctx.type = mime.lookup(filePath) || 'application/octet-stream'
    ctx.body = createReadStream(filePath)
  })

  return new Promise<http.Server>((resolvePromise, reject) => {
    const server = http.createServer(app.callback())
    server.on('error', reject)
    server.listen(options.port, options.host, () => {
      console.log(`[web] FluxMeld web UI available at http://${options.host}:${options.port}`)
      resolvePromise(server)
    })
  })
}
