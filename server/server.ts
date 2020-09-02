import { createHtml } from '../html.ts'
import log from '../log.ts'
import Project from '../project.ts'
import { route } from '../router.ts'
import { existsSync, path, serve, ws } from '../std.ts'
import util from '../util.ts'
import { PostAPIRequest, PostAPIResponse } from './api.ts'
import { getContentType } from './mime.ts'

export async function start(appDir: string, port: number, isDev = false) {
    const project = new Project(appDir, 'development')
    await project.ready

    try {
        const s = serve({ port })
        log.info(`Server ready on http://localhost:${port}`)
        for await (const req of s) {
            let [pathname, search] = util.splitBy(req.url, '?')
            pathname = util.cleanPath(pathname)

            try {
                if (pathname.startsWith('/_hmr')) {
                    const { conn, r: bufReader, w: bufWriter, headers } = req;
                    ws.acceptWebSocket({ conn, bufReader, bufWriter, headers }).then(async socket => {
                        for await (const e of socket) {
                            if (typeof e === 'string') {
                                console.log(e)
                            } else if (ws.isWebSocketCloseEvent(e)) {

                            }
                        }
                    })
                    continue
                }

                //serve apis
                if (pathname.startsWith('/api/')) {
                    const { pagePath, params, query } = route(
                        project.config.baseUrl,
                        project.apiPaths,
                        { location: { pathname, search } }
                    )
                    const handle = await project.getAPIHandle(pagePath)
                    if (handle) {
                        handle(
                            new PostAPIRequest(req, params, query),
                            new PostAPIResponse(req)
                        )
                    } else {
                        req.respond({
                            status: 404,
                            headers: new Headers({ 'Content-Type': `application/javascript; charset=utf-8` }),
                            body: 'page not found'
                        })
                    }
                    continue
                }

                // serve js files
                if (pathname.endsWith('.js') || pathname.endsWith('.js.map')) {
                    const reqSourceMap = pathname.endsWith('.js.map')
                    const { baseUrl } = project.config
                    let modname = pathname
                    if (baseUrl !== '/') {
                        modname = util.trimPrefix(modname, baseUrl)
                    }
                    if (modname.startsWith('/_dist/')) {
                        modname = util.trimPrefix(modname, '/_dist')
                    }
                    if (modname.startsWith('/-/')) {
                        modname = util.trimPrefix(modname, '/-/')
                    } else {
                        modname = '.' + modname
                        if (/\.[0-9a-f]{9}\.js$/.test(modname)) {
                            modname = modname.slice(0, modname.length - 13) + '.js'
                        }
                    }
                    if (reqSourceMap) {
                        modname = modname.slice(0, -4)
                    }
                    const mod = project.getModule(modname)
                    if (mod) {
                        const etag = req.headers.get('If-None-Match')
                        if (etag && etag === mod.hash) {
                            req.respond({
                                status: 304
                            })
                            continue
                        }
                        let { jsContent } = mod
                        if (modname === './app.js' || modname.startsWith('./pages/')) {
                            const { staticProps } = await project.importModuleAsComponent(modname)
                            if (staticProps) {
                                jsContent = 'export const __staticProps = ' + JSON.stringify(staticProps) + ';\n\n' + jsContent
                            }
                        }
                        if (modname === './app.js' || modname.startsWith('./pages/') || modname.startsWith('./components/')) {
                            let hmrImportPath = path.relative(
                                path.dirname(path.resolve('/', modname)),
                                '/-/postjs.io/hmr.js'
                            )
                            if (!hmrImportPath.startsWith('.') && !hmrImportPath.startsWith('/')) {
                                hmrImportPath = './' + hmrImportPath
                            }
                            jsContent = 'import { createHotContext } from ' + JSON.stringify(hmrImportPath) + ';\nimport.meta.hot = createHotContext(import.meta.url);\n\n' + jsContent
                        }
                        req.respond({
                            status: 200,
                            headers: new Headers({
                                'Content-Type': `application/${reqSourceMap ? 'json' : 'javascript'}; charset=utf-8`,
                                'ETag': mod.hash
                            }),
                            body: reqSourceMap ? mod.sourceMap : jsContent
                        })
                        continue
                    }
                }

                // serve public files
                if (path.basename(pathname).includes('.')) {
                    const filePath = path.join(project.rootDir, 'public', pathname)
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

                const [status, html] = await project.getPageHtml({ pathname, search })
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
    } catch (err) {
        if (err instanceof Deno.errors.AddrInUse) {
            log.error(`address :${port} already in use`)
        } else {
            console.log(err)
        }
        Deno.exit(1)
    }
}
