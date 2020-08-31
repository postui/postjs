import { renderToTags } from '../head.ts'
import { createHtml } from '../html.ts'
import log from '../log.ts'
import { ILocation, route, RouterURL } from '../router.ts'
import { colors, existsSync, path, ServerRequest, Sha1, walk } from '../std.ts'
import { compile, createSourceFile } from '../ts/compile.ts'
import transformImportPathRewrite from '../ts/transform-import-path-rewrite.ts'
import { traverse } from '../ts/traverse.ts'
import util from '../util.ts'
import AnsiUp from '../vendor/ansi-up/ansi-up.ts'
import { PostAPIRequest, PostAPIResponse } from './api.ts'
import { AppConfig, loadAppConfigSync } from './config.ts'

const reHttp = /^https?:\/\//i
const reModuleExt = /\.(m?jsx?|tsx?)$/i

interface Module {
    name: string
    sourceFile: string
    sourceType: string
    sourceHash: string
    sourceMap: string
    sourceContent: string
    isRemote: boolean
    deps: { path: string, hash: string }[]
    jsFile: string
    jsContent: string
    hash: string
}

export class App {
    readonly config: AppConfig
    readonly mode: 'development' | 'production'
    readonly ready: Promise<void>

    private _deps: Map<string, Module> = new Map()
    private _modules: Map<string, Module> = new Map()
    private _pageModules: Record<string, string> = {}
    private _fsWatchQueue: Map<string, any> = new Map()

    constructor(appDir: string, mode: 'development' | 'production') {
        this.mode = mode
        this.config = loadAppConfigSync(appDir)
        this.ready = new Promise((resolve, reject) => {
            this._init().then(resolve).catch(reject)
        })
    }

    get isDev() {
        return this.mode === 'development'
    }

    get srcDir() {
        const { rootDir, srcDir } = this.config
        return path.join(rootDir, srcDir)
    }

    async build() {

    }

    async getPageHtml(location: ILocation): Promise<[number, string]> {
        const { baseUrl, defaultLocale } = this.config
        const url = route(
            baseUrl,
            Object.keys(this._pageModules),
            {
                location,
                defaultLocale,
                fallback: '/404'
            }
        )
        const { code, head, body, ssrData } = await this._renderPage(url)
        const html = createHtml({
            lang: url.locale,
            head: head,
            scripts: [
                { type: 'application/json', id: 'ssr-data', innerText: JSON.stringify(ssrData) },
                { src: path.join(baseUrl, 'main.js') + `?t=${Date.now()}`, type: 'module' },
            ],
            body
        })
        return [code, html]
    }

    async getPageStaticProps(location: ILocation) {
        const { baseUrl, defaultLocale } = this.config
        const url = route(
            baseUrl,
            Object.keys(this._pageModules),
            {
                location,
                defaultLocale,
                fallback: '/404'
            }
        )
        if (url.pagePath in this._pageModules) {
            const { staticProps } = await this._loadComponentModule(this._pageModules[url.pagePath])
            if (staticProps) {
                return staticProps
            }
        }
        return null
    }

    getModule(filename: string): Module | null {
        filename = util.cleanPath(util.trimPrefix(filename, this.config.baseUrl))
        if (filename.startsWith('/-/')) {
            filename = util.trimPrefix(filename, '/-/')
            if (this._deps.has(filename)) {
                return this._deps.get(filename)!
            }
        } else {
            filename = '.' + filename
            if (this._modules.has(filename)) {
                return this._modules.get(filename)!
            }
            filename = filename.replace(/\.[0-9a-f]{40}\.js$/, '.js')
            if (this._modules.has(filename)) {
                return this._modules.get(filename)!
            }
        }
        return null
    }

    async callAPI(req: ServerRequest, location: ILocation) {
        const { pagePath, params, query } = route(
            this.config.baseUrl,
            Array.from(this._modules.keys()).filter(p => p.startsWith('./api/')).map(p => p.slice(1).replace(reModuleExt, '')),
            { location }
        )
        if (pagePath) {
            const importPath = '.' + pagePath + '.js'
            if (this._modules.has(importPath)) {
                const { default: handle } = await import(this._modules.get(importPath)!.jsFile)
                handle(new PostAPIRequest(req, params, query), new PostAPIResponse(req))
                return
            }
        }

        req.respond({
            status: 404,
            headers: new Headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
                error: {
                    status: 404,
                    message: 'page not found'
                }
            })
        })
    }

    private async _init() {
        const walkOptions = { includeDirs: false, exts: ['.js', '.jsx', '.mjs', '.ts', '.tsx'], skip: [/\.d\.ts$/i] }
        const { baseUrl, defaultLocale } = this.config
        const bootstrapConfig: Record<string, any> = {
            baseUrl,
            defaultLocale,
            pageModules: {},
            hmr: this.isDev
        }
        const w1 = walk(path.join(this.srcDir), { ...walkOptions, maxDepth: 1 })
        const w2 = walk(path.join(this.srcDir, 'pages'), walkOptions)
        const w3 = walk(path.join(this.srcDir, 'api'), walkOptions)

        for await (const { path: p } of w1) {
            const name = path.basename(p)
            if (name.replace(reModuleExt, '') === 'app') {
                const mod = await this._compile('./' + name)
                bootstrapConfig.appModule = { hash: mod.hash }
            }
        }

        for await (const { path: p } of w2) {
            const name = path.basename(p)
            const pagePath = '/' + name.replace(reModuleExt, '').replace(/\s+/g, '-').replace(/\/?index$/i, '')
            this._pageModules[pagePath] = './pages/' + name.replace(reModuleExt, '') + '.js'
            await this._compile('./pages/' + name)
        }

        for (const p in this._pageModules) {
            bootstrapConfig.pageModules[p] = {
                path: this._pageModules[p]
            }
        }
        await this._compile('./main.js', {
            sourceCode: `
                import { bootstrap } from 'https://postjs.io/app.ts'
                bootstrap(${JSON.stringify(bootstrapConfig)})
            `
        })

        await this._compile('./renderer.js', {
            sourceCode: `
                export * from 'https://postjs.io/app.ts'
            `
        })

        for await (const { path: p } of w3) {
            const name = path.basename(p)
            await this._compile('./api/' + name)
        }

        log.info(colors.bold('Pages'))
        for (const path in this._pageModules) {
            const isIndex = path == '/'
            log.info('○', path, isIndex ? colors.dim('(index)') : '')
        }
        for (const path of this._modules.keys()) {
            if (path.startsWith('./api/')) {
                log.info('λ', path.slice(1).replace(reModuleExt, ''))
            }
        }

        if (this.isDev) {
            // this._watch()
        }
    }

    private async _watch() {
        const w = Deno.watchFs(this.srcDir, { recursive: true })
        log.info('Start watching code changes...')
        for await (const event of w) {
            for (const p of event.paths) {
                const { rootDir, outputDir } = this.config
                const rp = util.trimPrefix(util.trimPrefix(p, rootDir), '/')
                if (reModuleExt.test(rp) && !rp.startsWith('.postjs/') && !rp.startsWith(outputDir.slice(1))) {
                    const moduleName = `./${rp.replace(reModuleExt, '')}.js`
                    if (this._fsWatchQueue.has(moduleName)) {
                        clearTimeout(this._fsWatchQueue.get(moduleName)!)
                    }
                    this._fsWatchQueue.set(moduleName, setTimeout(() => {
                        this._fsWatchQueue.delete(moduleName)
                        if (rp.startsWith('api/')) {
                            console.log(rp)
                            // todo: re-import api
                            return
                        }
                        if (rp.split('.', 1)[0] === 'app') {
                            // todo: re-import custom app
                        }
                        if (existsSync(p)) {
                            this._compile('./' + rp, { transpileOnly: true })
                            if (this._modules.has(moduleName)) {
                                log.info('modify', './' + rp)
                            } else {
                                log.info('add', './' + rp)
                            }
                        } else if (this._modules.has(moduleName)) {
                            this._modules.delete(moduleName)
                            log.info('remove', './' + rp)
                        }
                    }, 150))
                }
            }
        }
    }

    private async _compile(sourceFile: string, options?: { sourceCode?: string, transpileOnly?: boolean }) {
        const { cacheDeps, rootDir, importMap } = this.config
        const mod: Module = {
            name: path.basename(sourceFile).replace(reModuleExt, ''),
            sourceFile,
            sourceType: reModuleExt.test(sourceFile) ? path.extname(sourceFile).slice(1).replace('mjs', 'js') : 'js',
            sourceMap: '',
            sourceHash: '',
            sourceContent: '',
            isRemote: reHttp.test(sourceFile) || (sourceFile in importMap.imports && reHttp.test(importMap.imports[sourceFile])),
            hash: '',
            deps: [],
            jsFile: '',
            jsContent: '',
        }
        const moduleId = mod.sourceFile.replace(reHttp, '').replace(reModuleExt, '') + '.js'
        const saveDir = path.join(rootDir, '.postjs', path.dirname(mod.isRemote ? sourceFile.replace(reHttp, '/-/') : sourceFile))

        // compile the deps only once
        if (mod.isRemote && this._deps.has(mod.sourceFile)) {
            return this._deps.get(mod.sourceFile)!
        }

        // do not re-compile the local modules when not transpileOnly
        if (!mod.isRemote && this._modules.has(mod.sourceFile) && !options?.transpileOnly) {
            return this._deps.get(mod.sourceFile)!
        }

        const metaFile = path.join(saveDir, `${mod.name}.meta.json`)
        if (existsSync(metaFile)) {
            const { sourceHash, hash, deps } = JSON.parse(await Deno.readTextFile(metaFile))
            if (util.isNEString(sourceHash) && util.isNEString(hash) && util.isArray(deps)) {
                mod.sourceHash = sourceHash
                mod.hash = hash
                mod.deps = deps
                mod.jsFile = path.join(saveDir, mod.name + (mod.isRemote ? '' : `.${hash}`)) + '.js'
                mod.jsContent = await Deno.readTextFile(mod.jsFile)
                try {
                    mod.sourceMap = await Deno.readTextFile(mod.jsFile + '.map')
                } catch (e) { }
            }
        }

        if (mod.isRemote) {
            let url = sourceFile
            for (const importPath in importMap.imports) {
                const alias = importMap.imports[importPath]
                if (importPath === url) {
                    url = alias
                    break
                } else if (importPath.endsWith('/') && url.startsWith(importPath)) {
                    url = util.trimSuffix(alias, '/') + '/' + util.trimPrefix(url, importPath)
                    break
                }
            }
            if (mod.sourceHash === '') {
                log.info('Download', sourceFile, url != sourceFile ? colors.dim(`• ${url}`) : '')
                try {
                    mod.sourceContent = await fetch(url).then(resp => {
                        if (resp.status == 200) {
                            if (mod.sourceType === 'js') {
                                const ct = resp.headers.get('Content-Type')
                                if (ct === 'text/typescript') {
                                    mod.sourceType = 'ts'
                                } else if (ct === 'text/jsx') {
                                    mod.sourceType = 'jsx'
                                }
                            }
                            return resp.text()
                        }
                        return Promise.reject(new Error(`${resp.status} - ${resp.statusText}`))
                    })
                    mod.sourceHash = (new Sha1()).update(mod.sourceContent).hex()
                } catch (err) {
                    throw new Error(`Download ${sourceFile}: ${err.message}`)
                }
            } else if (/^http:\/\/(localhost|127.0.0.1)(:\d+)?\//.test(url)) {
                try {
                    const text = await fetch(url).then(resp => {
                        if (resp.status == 200) {
                            return resp.text()
                        }
                        return Promise.reject(new Error(`${resp.status} - ${resp.statusText}`))
                    })
                    const sourceHash = (new Sha1()).update(text).hex()
                    if (mod.sourceHash !== sourceHash) {
                        mod.sourceContent = text
                        mod.sourceHash = sourceHash
                    }
                } catch (err) {
                    throw new Error(`Download ${sourceFile}: ${err.message}`)
                }
            }
        } else if (options?.sourceCode) {
            const sourceHash = (new Sha1()).update(options.sourceCode).hex()
            if (mod.sourceHash === '' || mod.sourceHash !== sourceHash) {
                mod.sourceContent = options.sourceCode
                mod.sourceHash = sourceHash
            }
        } else {
            const filepath = path.join(this.srcDir, sourceFile)
            const fileinfo = await Deno.stat(filepath)

            // 10mb limit
            if (fileinfo.size > 10 * (1 << 20)) {
                throw new Error(`ignored module '${sourceFile}': too large(${(fileinfo.size / (1 << 20)).toFixed(2)}mb)`)
            }

            const text = await Deno.readTextFile(filepath)
            const sourceHash = (new Sha1()).update(text).hex()
            if (mod.sourceHash === '' || mod.sourceHash !== sourceHash) {
                mod.sourceContent = text
                mod.sourceHash = sourceHash
            }
        }

        let fsync = false

        // compile source
        if (mod.sourceContent != '') {
            const deps: Array<{ path: string, hash: string }> = []
            const rewriteImportPath = (importPath: string): string => {
                let rewrittenPath: string
                if (importPath in importMap.imports) {
                    importPath = importMap.imports[importPath]
                }
                if (reHttp.test(importPath)) {
                    if (cacheDeps || /\.(jsx|tsx?)$/i.test(importPath)) {
                        if (mod.isRemote) {
                            rewrittenPath = path.relative(
                                path.dirname(path.resolve('/', sourceFile.replace(reHttp, '-/'))),
                                path.resolve('/', importPath.replace(reHttp, '-/'))
                            )
                        } else {
                            rewrittenPath = path.relative(
                                path.dirname(path.resolve('/', sourceFile)),
                                '/' + importPath.replace(reHttp, '-/')
                            )
                        }
                    } else {
                        rewrittenPath = importPath
                    }
                } else {
                    if (mod.isRemote) {
                        const sourceUrl = new URL(sourceFile)
                        let pathname = importPath
                        if (!pathname.startsWith('/')) {
                            pathname = path.join(path.dirname(sourceUrl.pathname), importPath)
                        }
                        rewrittenPath = path.relative(
                            path.dirname(path.resolve('/', sourceFile.replace(reHttp, '-/'))),
                            '/' + path.join('-', sourceUrl.host, pathname)
                        )
                    } else {
                        rewrittenPath = importPath.replace(reModuleExt, '') + '.' + 'x'.repeat(40)
                    }
                }
                if (reHttp.test(importPath)) {
                    deps.push({ path: importPath, hash: '' })
                } else {
                    if (mod.isRemote) {
                        const sourceUrl = new URL(sourceFile)
                        let pathname = importPath
                        if (!pathname.startsWith('/')) {
                            pathname = path.join(path.dirname(sourceUrl.pathname), importPath)
                        }
                        deps.push({ path: sourceUrl.protocol + '//' + sourceUrl.host + pathname, hash: '' })
                    } else {
                        deps.push({ path: '.' + path.resolve('/', path.dirname(sourceFile), importPath), hash: '' })
                    }
                }

                if (reHttp.test(rewrittenPath)) {
                    return rewrittenPath
                }

                if (!rewrittenPath.startsWith('.')) {
                    rewrittenPath = '.' + path.resolve('/', rewrittenPath)
                }
                return rewrittenPath.replace(reModuleExt, '') + '.js'
            }

            if (mod.isRemote && mod.sourceType === 'js') {
                const sf = createSourceFile(mod.sourceFile, mod.sourceContent)
                const rewrittenPaths: Record<string, string> = {}
                traverse(sf, node => transformImportPathRewrite(sf, node, path => {
                    const rewrittenPath = rewriteImportPath(path)
                    rewrittenPaths[path] = rewrittenPath
                    return rewrittenPath
                }))
                mod.deps = deps
                mod.jsContent = mod.sourceContent.replace(/ from ("|')(.+?)("|');?/g, (s, ql, importPath, qr) => {
                    if (importPath in rewrittenPaths) {
                        return ` from ${ql}${rewrittenPaths[importPath]}${qr};`
                    }
                    return s
                })
                mod.hash = (new Sha1()).update(mod.jsContent).hex()
                mod.sourceMap = ''
            } else {
                const t = performance.now()
                const { diagnostics, outputText, sourceMapText } = compile(sourceFile, mod.sourceContent, { mode: this.mode, rewriteImportPath })
                if (diagnostics && diagnostics.length) {
                    throw new Error(`compile ${sourceFile}: ${JSON.stringify(diagnostics)}`)
                }
                mod.deps = deps
                mod.hash = (new Sha1()).update(outputText).hex()
                mod.jsContent = outputText
                mod.sourceMap = sourceMapText!

                log.debug(`${sourceFile} compiled in ${(performance.now() - t).toFixed(3)}ms`)
            }

            if (!fsync) {
                fsync = true
            }
        }

        if (!options?.transpileOnly) {
            for (let dep of mod.deps) {
                const depmod = await this._compile(dep.path)
                if (dep.hash !== depmod.hash) {
                    dep.hash = depmod.hash
                    if (!dep.path.startsWith('http')) {
                        const depImportPath = path.relative(
                            path.dirname(path.resolve('/', sourceFile)),
                            path.resolve('/', dep.path.replace(reModuleExt, ''))
                        )
                        mod.jsContent = mod.jsContent.replace(/ from ("|')(.+?)("|');?/g, (s, ql, importPath, qr) => {
                            if (
                                /\.[0-9a-fx]{40}\.js$/.test(importPath) &&
                                importPath.slice(0, importPath.length - 44) === depImportPath
                            ) {
                                return ` from ${ql}${depImportPath}.${dep.hash}.js${qr};`
                            }
                            return s
                        })
                        mod.hash = (new Sha1()).update(mod.jsContent).hex()
                    }
                    if (!fsync) {
                        fsync = true
                    }
                }
            }
        }

        if (fsync) {
            mod.jsFile = path.join(saveDir, mod.name + (mod.isRemote ? '' : `.${mod.hash}`)) + '.js'
            await Promise.all([
                this._writeTextFile(metaFile, JSON.stringify({
                    sourceFile,
                    sourceHash: mod.sourceHash,
                    hash: mod.hash,
                    deps: mod.deps,
                }, undefined, 4)),
                this._writeTextFile(mod.jsFile, mod.jsContent),
                mod.sourceMap !== '' ? this._writeTextFile(mod.jsFile + '.map', mod.sourceMap) : (async () => { })()
            ])
        }

        if (mod.isRemote) {
            this._deps.set(moduleId, mod)
        } else {
            this._modules.set(moduleId, mod)
        }

        return mod
    }

    private async _loadComponentModule(name: string, ...args: any[]) {
        if (this._modules.has(name)) {
            const { default: Component, getStaticProps } = await import(this._modules.get(name)!.jsFile)
            const fn = [Component.getStaticProps, getStaticProps].filter(util.isFunction)[0]
            const data = fn ? await fn(...args) : null
            return { Component, staticProps: util.isObject(data) ? data : null }
        }
        return {}
    }

    private async _renderPage(url: RouterURL) {
        const ret = {
            code: 404,
            head: ['<title>404 - page not found</title>'],
            body: '<p><strong><code>404</code></strong><small> - </small><span>page not found</span></p>',
            ssrData: { url, staticProps: null } as Record<string, any>,
        }
        if (url.pagePath in this._pageModules) {
            try {
                const [
                    { renderPage },
                    App,
                    Page
                ] = await Promise.all([
                    import(this._modules.get('./renderer.js')!.jsFile),
                    this._loadComponentModule('./app.js'),
                    this._loadComponentModule(this._pageModules[url.pagePath], url)
                ])
                if (util.isFunction(Page.Component)) {
                    const html = renderPage(url, util.isFunction(App.Component) ? App : undefined, Page)
                    ret.code = 200
                    ret.head = renderToTags()
                    ret.body = `<main>${html}</main>`
                    if (util.isObject(App.staticProps)) {
                        ret.ssrData.appStaticProps = App.staticProps
                    }
                    ret.ssrData.staticProps = util.isObject(Page.staticProps) ? Page.staticProps : null
                } else {
                    ret.code = 500
                    ret.head = ['<title>500 - render error</title>']
                    ret.body = `<p><strong><code>500</code></strong><small> - </small><span>render error: bad page component</span></p>`
                }
            } catch (err) {
                ret.code = 500
                ret.head = ['<title>500 - render error</title>']
                ret.body = `<pre>${AnsiUp.ansi_to_html(err.message)}</pre>`
                log.error(err.message)
            }
        }
        return ret
    }

    private async _writeTextFile(filepath: string, content: string) {
        const dir = path.dirname(filepath)
        if (!existsSync(dir)) {
            await Deno.mkdir(dir, { recursive: true })
        }
        await Deno.writeTextFile(filepath, content)
    }
}
