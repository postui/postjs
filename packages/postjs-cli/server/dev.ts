import { EventEmitter } from 'events'
import http from 'http'
import { parse } from 'url'
import { server as WebsocketServer } from 'websocket'
import { getContentType, sendText } from '.'
import { DevWatcher } from '../build/dev'
import utils from '../shared/utils'

export function start(appDir: string, port: number) {
    const emitter = new EventEmitter()
    const watcher = new DevWatcher(appDir)
    const httpServer = http.createServer(async (req, res) => {
        const url = parse(req.url || '/')
        const pathname = utils.cleanPath((url.pathname || '/'))
        const wantContentType = getContentType(pathname)

        console.log('new request:', pathname)

        if (pathname === '/build-manifest.json') {
            sendText(req, res, 200, wantContentType, JSON.stringify(watcher.buildManifest))
            return
        }

        if (pathname.endsWith('.hot-update.json') || pathname.endsWith('.hot-update.js')) {
            const content = watcher.getHotUpdateContent(pathname)
            if (content === null) {
                res.statusCode = 404
                res.end('file not found')
                return
            }

            sendText(req, res, 200, wantContentType, content)
            return
        }

        if (pathname.startsWith('/_post/')) {
            if (pathname.startsWith('/_post/pages/') && pathname.endsWith('.json')) {
                const pagePath = utils.trimPrefix(pathname, '/_post/pages').replace(/(index)?\.json?$/i, '')
                const staticProps = await watcher.getPageStaticProps(pagePath)
                if (!utils.isObject(staticProps)) {
                    res.statusCode = 404
                    res.end('file not found')
                    return
                }

                sendText(req, res, 200, wantContentType, JSON.stringify({ staticProps }))
                return
            }

            const chunk = watcher.getChunk(utils.trimPrefix(pathname, '/_post/'))
            if (chunk === null) {
                res.statusCode = 404
                res.end('file not found')
                return
            }

            sendText(req, res, 200, wantContentType, chunk!.content)
            return
        }

        const [statusCode, html] = await watcher.getPageHtml(pathname.replace(/(index)?\.html?$/i, ''))
        // todo: serve the public static files when statusCode equals 404
        sendText(req, res, statusCode, 'text/html', html)
    })
    const wsServer = new WebsocketServer({ httpServer })

    watcher.watch(emitter)
    wsServer.on('request', req => {
        const conn = req.accept('hot-update', req.origin)
        emitter.on('webpackHotUpdate', async manifest => {
            conn.sendUTF(JSON.stringify(manifest))
        })
    })
    httpServer.listen(port)
}
