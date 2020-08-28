import { App } from '../app/app.ts'
import { createHtml } from '../html.ts'
import log from '../log.ts'
import { existsSync, path, serve, ws } from '../std.ts'
import util from '../util.ts'
import { getContentType } from './mime.ts'

export async function start(appDir: string, port: number, isDev = false) {
    const app = new App(appDir, 'development')
    await app.ready

    const s = serve({ port })
    log.info(`Server ready on http://localhost:${port}`)
    for await (const req of s) {
        let [pathname, search] = util.splitBy(req.url, '?')
        pathname = util.cleanPath(pathname)

        try {
            if (pathname.startsWith('/_hmr')) {
                const socket = ws.createWebSocket({ conn: req.conn })
                for await (const e of socket) {
                    if (ws.isWebSocketCloseEvent(e)) {

                    }
                }
                continue
            }

            //serve apis
            if (pathname.startsWith('/api/')) {
                await app.callAPI(req, { pathname, search })
                continue
            }

            // serve js files
            if (pathname.endsWith('.js') || pathname.endsWith('.js.map')) {
                const requestMap = pathname.endsWith('.js.map')
                const mod = app.getModule(requestMap ? pathname.slice(0, -4) : pathname)
                if (mod) {
                    const etag = req.headers.get('If-None-Match')
                    if (etag && etag === mod.hash) {
                        req.respond({
                            status: 304
                        })
                        continue
                    }
                    req.respond({
                        status: 200,
                        headers: new Headers({
                            'Content-Type': `application/${requestMap ? 'json' : 'javascript'}; charset=utf-8`,
                            'ETag': mod.hash
                        }),
                        body: requestMap ? mod.sourceMap : mod.js
                    })
                    continue
                }
            }

            // serve public files
            if (path.basename(pathname).includes('.')) {
                const filePath = path.join(app.config.rootDir, 'public', pathname)
                if (existsSync(filePath)) {
                    const body = await Deno.readFile(filePath)
                    req.respond({
                        status: 200,
                        headers: new Headers({ 'Content-Type': getContentType(filePath) }),
                        body
                    })
                    continue
                }
            }

            const [status, html] = await app.getPageHtml({ pathname, search })
            req.respond({
                status,
                headers: new Headers({ 'Content-Type': 'text/html' }),
                body: html
            })
        } catch (err) {
            req.respond({
                status: 500,
                headers: new Headers({ 'Content-Type': 'text/html' }),
                body: createHtml({
                    lang: 'en',
                    head: ['<title>500 - internal server error</title>'],
                    body: `<p><strong><code>500</code></strong><small> - </small><span>${err.message}</span></p>`
                })
            })
        }
    }
}
