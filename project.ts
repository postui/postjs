import { APIHandle } from './api.ts'
import { EventEmitter } from './events.ts'
import { createHtml } from './html.ts'
import log from './log.ts'
import { ILocation, route, RouterURL } from './router.ts'
import { colors, exists, existsSync, Md5, path, Sha1, walk } from './std.ts'
import { compile, createSourceFile } from './ts/compile.ts'
import transformImportPathRewrite from './ts/transform-import-path-rewrite.ts'
import { traverse } from './ts/traverse.ts'
import util from './util.ts'
import AnsiUp from './vendor/ansi-up/ansi-up.ts'

const reHttp = /^https?:\/\//i
const reModuleExt = /\.(m?jsx?|tsx?)$/i
const reHashJS = /\.[0-9a-fx]{9}\.js$/i

interface Module {
    id: string
    isRemote: boolean
    deps: { path: string, hash: string }[]
    sourceFile: string
    sourceType: string
    sourceHash: string
    jsFile: string
    jsContent: string
    jsSourceMap: string
    hash: string
}

interface Config {
    readonly rootDir: string
    readonly srcDir: string
    readonly outputDir: string
    readonly baseUrl: string
    readonly defaultLocale: string
    readonly cacheDeps: boolean
    readonly importMap: {
        imports: Record<string, string>
    }
}

interface BuildManifest {
    baseUrl: string
    defaultLocale: string
    locales: Record<string, Record<string, string>>
    appModule: { hash: string } | null
    pageModules: Record<string, { path: string, hash: string }>
}

export default class Project {
    readonly mode: 'development' | 'production'
    readonly config: Config
    readonly ready: Promise<void>

    private _deps: Map<string, Module> = new Map()
    private _modules: Map<string, Module> = new Map()
    private _pageModules: Record<string, string> = {}
    private _fsWatchQueue: Map<string, number> = new Map()
    private _fsWatchListeners: Array<EventEmitter> = []

    constructor(dir: string, mode: 'development' | 'production') {
        this.mode = mode
        this.config = {
            rootDir: path.resolve(dir),
            srcDir: '/',
            outputDir: '/out',
            cacheDeps: true,
            baseUrl: '/',
            defaultLocale: 'en',
            importMap: {
                imports: {}
            }
        }
        this.ready = (async () => {
            await this._loadConfig()
            await this._init()
        })()
    }

    get rootDir() {
        return this.config.rootDir
    }

    get srcDir() {
        const { rootDir, srcDir } = this.config
        return path.join(rootDir, srcDir)
    }

    get apiPaths() {
        return Array.from(this._modules.keys()).filter(p => p.startsWith('./api/')).map(p => p.slice(1).replace(reModuleExt, ''))
    }

    get isDev() {
        return this.mode === 'development'
    }

    get manifest() {
        const { baseUrl, defaultLocale } = this.config
        const manifest: BuildManifest = {
            baseUrl,
            defaultLocale,
            locales: {},
            appModule: null,
            pageModules: {}
        }
        if (this._modules.has('./app.js')) {
            manifest.appModule = {
                hash: this._modules.get('./app.js')!.hash
            }
        }
        for (const p in this._pageModules) {
            const path = this._pageModules[p]
            const { hash } = this._modules.get(path)!
            manifest.pageModules[p] = { path, hash }
        }
        return manifest
    }

    async build() {

    }

    getModule(id: string): Module | null {
        if (this._deps.has(id)) {
            return this._deps.get(id)!
        }
        if (this._modules.has(id)) {
            return this._modules.get(id)!
        }
        return null
    }

    getModuleByPath(pathname: string): Module | null {
        const { baseUrl } = this.config
        let modId = pathname
        if (baseUrl !== '/') {
            modId = util.trimPrefix(modId, baseUrl)
        }
        if (modId.startsWith('/_dist/')) {
            modId = util.trimPrefix(modId, '/_dist')
        }
        if (modId.startsWith('/-/')) {
            modId = util.trimPrefix(modId, '/-/')
        } else {
            modId = '.' + modId
            if (/\.[0-9a-f]{9}\.js$/.test(modId)) {
                modId = modId.slice(0, modId.length - 13) + '.js'
            }
        }
        return this.getModule(modId)
    }

    async getAPIHandle(path: string): Promise<APIHandle | null> {
        if (path) {
            const importPath = '.' + path + '.js'
            if (this._modules.has(importPath)) {
                const { default: handle } = await import(this._modules.get(importPath)!.jsFile)
                return handle
            }
        }

        return null
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
        const mainMod = this._modules.get('./main.js')!
        const { code, head, body } = await this._renderPage(url)
        const html = createHtml({
            lang: url.locale,
            head: head,
            scripts: [
                { type: 'application/json', id: 'ssr-data', innerText: JSON.stringify({ url }) },
                { src: path.join(baseUrl, `/_dist/main.${mainMod.hash.slice(0, 9)}.js`), type: 'module' },
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
            const { staticProps } = await this.importModuleAsComponent(this._pageModules[url.pagePath])
            if (staticProps) {
                return staticProps
            }
        }
        return null
    }

    async importModuleAsComponent(name: string, ...args: any[]) {
        if (this._modules.has(name)) {
            const { default: Component, getStaticProps } = await import(this._modules.get(name)!.jsFile)
            const fn = [Component.getStaticProps, getStaticProps].filter(util.isFunction)[0]
            const data = fn ? await fn(...args) : null
            return { Component, staticProps: util.isObject(data) ? data : null }
        }
        return {}
    }

    private async _loadConfig() {
        const { POSTJS_IMPORT_MAP } = globalThis as any
        if (POSTJS_IMPORT_MAP) {
            const { imports } = POSTJS_IMPORT_MAP
            Object.assign(this.config.importMap, { imports: Object.assign({}, this.config.importMap.imports, imports) })
        }

        const importMapFile = path.join(this.config.rootDir, 'import_map.json')
        if (await exists(importMapFile)) {
            const { imports } = JSON.parse(await Deno.readTextFile(importMapFile))
            Object.assign(this.config.importMap, { imports: Object.assign({}, this.config.importMap.imports, imports) })
        }

        const configFile = path.join(this.config.rootDir, 'post.config.json')
        if (await exists(configFile)) {
            const {
                srcDir,
                ouputDir,
                baseUrl,
                cacheDeps,
                lang
            } = JSON.parse(await Deno.readTextFile(configFile))
            if (util.isNEString(srcDir)) {
                Object.assign(this.config, { srcDir: util.cleanPath(srcDir) })
            }
            if (util.isNEString(ouputDir)) {
                Object.assign(this.config, { ouputDir: util.cleanPath(ouputDir) })
            }
            if (util.isNEString(baseUrl)) {
                Object.assign(this.config, { baseUrl: util.cleanPath(encodeURI(baseUrl)) })
            }
            if (util.isNEString(lang)) {
                Object.assign(this.config, { defaultLocale: lang })
            }
            if (typeof cacheDeps === 'boolean') {
                Object.assign(this.config, { cacheDeps })
            }
        }
    }

    private async _init() {
        const walkOptions = { includeDirs: false, exts: ['.js', '.jsx', '.mjs', '.ts', '.tsx'], skip: [/\.d\.ts$/i] }
        const w1 = walk(path.join(this.srcDir), { ...walkOptions, maxDepth: 1 })
        const w2 = walk(path.join(this.srcDir, 'api'), walkOptions)
        const w3 = walk(path.join(this.srcDir, 'pages'), walkOptions)

        for await (const { path: p } of w1) {
            const name = path.basename(p)
            if (name.replace(reModuleExt, '') === 'app') {
                await this._compile('./' + name)
            }
        }

        for await (const { path: p } of w2) {
            const name = path.basename(p)
            await this._compile('./api/' + name)
        }

        for await (const { path: p } of w3) {
            const name = path.basename(p)
            const pagePath = '/' + name.replace(reModuleExt, '').replace(/\s+/g, '-').replace(/\/?index$/i, '')
            this._pageModules[pagePath] = './pages/' + name.replace(reModuleExt, '') + '.js'
            await this._compile('./pages/' + name)
        }

        const innerModules: Record<string, string> = {
            './main.js': [
                `import { bootstrap } from 'https://postjs.io/app.ts'`,
                `bootstrap(${JSON.stringify(this.manifest)})`
            ].join('\n'),
            './renderer.js': `export * from 'https://postjs.io/renderer.ts'`
        }
        for (const path in innerModules) {
            await this._compile(path, { sourceCode: innerModules[path] })
        }

        await this._compile('https://postjs.io/hmr.ts')

        log.info(colors.bold('Pages'))
        for (const path in this._pageModules) {
            const isIndex = path == '/'
            log.info('○', path, isIndex ? colors.dim('(index)') : '')
        }
        for (const path of this.apiPaths) {
            log.info('λ', path)
        }

        if (this.isDev) {
            this._watch()
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
                    const moduleId = `./${rp.replace(reModuleExt, '')}.js`
                    if (this._fsWatchQueue.has(moduleId)) {
                        clearTimeout(this._fsWatchQueue.get(moduleId)!)
                    }
                    this._fsWatchQueue.set(moduleId, setTimeout(() => {
                        this._fsWatchQueue.delete(moduleId)
                        if (existsSync(p)) {
                            let type = 'modify'
                            if (!this._modules.has(moduleId)) {
                                type = 'add'
                            }
                            log.info(type, './' + rp)
                            this._compile('./' + rp, { forceCompile: true }).then(({ hash }) => {
                                this._fsWatchListeners.forEach(e => e.emit(moduleId, type, hash))
                                this._updateDependency('./' + rp, hash, mod => {
                                    this._fsWatchListeners.forEach(e => e.emit(mod.id, 'modify', mod.hash))
                                })
                            })
                        } else if (this._modules.has(moduleId)) {
                            this._modules.delete(moduleId)
                            this._fsWatchListeners.forEach(e => e.emit(moduleId, 'remove'))
                            log.info('remove', './' + rp)
                        }
                    }, 150))
                }
            }
        }
    }

    createFSWatcher(): EventEmitter {
        const e = new EventEmitter()
        this._fsWatchListeners.push(e)
        return e
    }

    removeFSWatcher(e: EventEmitter) {
        e.removeAllListeners()
        const index = this._fsWatchListeners.indexOf(e)
        if (index > -1) {
            this._fsWatchListeners.splice(index, 1)
        }
    }

    private async _compile(sourceFile: string, options?: { sourceCode?: string, forceCompile?: boolean }) {
        const { rootDir, importMap } = this.config
        const isRemote = reHttp.test(sourceFile) || (sourceFile in importMap.imports && reHttp.test(importMap.imports[sourceFile]))
        const id = (isRemote ? util.trimPrefix(this._renameRemotePath(sourceFile), '/-/') : sourceFile).replace(reModuleExt, '') + '.js'

        if (this._deps.has(id) && !options?.forceCompile) {
            return this._deps.get(id)!
        }

        const mod: Module = {
            id,
            isRemote,
            sourceFile,
            sourceType: reModuleExt.test(sourceFile) ? path.extname(sourceFile).slice(1).replace('mjs', 'js') : 'js',
            sourceHash: '',
            deps: [],
            jsFile: '',
            jsContent: '',
            jsSourceMap: '',
            hash: '',
        }
        const name = path.basename(sourceFile).replace(reModuleExt, '')
        const saveDir = path.join(rootDir, '.postjs', path.dirname(mod.isRemote ? this._renameRemotePath(sourceFile) : sourceFile))
        const metaFile = path.join(saveDir, `${name}.meta.json`)

        if (existsSync(metaFile)) {
            const { sourceHash, hash, deps } = JSON.parse(await Deno.readTextFile(metaFile))
            if (util.isNEString(sourceHash) && util.isNEString(hash) && util.isArray(deps)) {
                mod.sourceHash = sourceHash
                mod.hash = hash
                mod.deps = deps
                mod.jsFile = path.join(saveDir, name + (mod.isRemote ? '' : '.' + hash.slice(0, 9))) + '.js'
                mod.jsContent = await Deno.readTextFile(mod.jsFile)
                try {
                    mod.jsSourceMap = await Deno.readTextFile(mod.jsFile + '.map')
                } catch (e) { }
            }
        }

        let sourceContent = ''
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
                    sourceContent = await fetch(url).then(resp => {
                        if (resp.status == 200) {
                            if (mod.sourceType === 'js') {
                                const t = resp.headers.get('Content-Type')
                                if (t?.startsWith('text/typescript')) {
                                    mod.sourceType = 'ts'
                                } else if (t?.startsWith('text/jsx')) {
                                    mod.sourceType = 'jsx'
                                }
                            }
                            return resp.text()
                        }
                        return Promise.reject(new Error(`${resp.status} - ${resp.statusText}`))
                    })
                    mod.sourceHash = (new Sha1()).update(sourceContent).hex()
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
                        sourceContent = text
                        mod.sourceHash = sourceHash
                    }
                } catch (err) {
                    throw new Error(`Download ${sourceFile}: ${err.message}`)
                }
            }
        } else if (options?.sourceCode) {
            const sourceHash = (new Sha1()).update(options.sourceCode).hex()
            if (mod.sourceHash === '' || mod.sourceHash !== sourceHash) {
                sourceContent = options.sourceCode
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
                sourceContent = text
                mod.sourceHash = sourceHash
            }
        }

        let fsync = false

        // compile source
        if (sourceContent != '') {
            const t = performance.now()
            mod.deps = []
            if (mod.isRemote && mod.sourceType === 'js') {
                const sf = createSourceFile(mod.sourceFile, sourceContent)
                const rewrittenPaths: Record<string, string> = {}
                traverse(sf, node => transformImportPathRewrite(sf, node, path => {
                    const rewrittenPath = this._rewriteImportPath(mod, path)
                    rewrittenPaths[path] = rewrittenPath
                    return rewrittenPath
                }))
                mod.jsContent = sourceContent.replace(/ from ("|')(.+?)("|');?/g, (s, ql, importPath, qr) => {
                    if (importPath in rewrittenPaths) {
                        return ` from ${ql}${rewrittenPaths[importPath]}${qr};`
                    }
                    return s
                })
                mod.jsSourceMap = ''
                mod.hash = this._hash(mod.jsContent)
            } else {
                const compileOptions = {
                    mode: this.mode,
                    reactRefresh: this.isDev && !mod.isRemote,
                    rewriteImportPath: (path: string) => this._rewriteImportPath(mod, path)
                }
                const { diagnostics, outputText, sourceMapText } = compile(mod.sourceFile, sourceContent, compileOptions)
                if (diagnostics && diagnostics.length) {
                    throw new Error(`compile ${sourceFile}: ${JSON.stringify(diagnostics)}`)
                }
                mod.jsContent = outputText
                mod.jsSourceMap = sourceMapText!
                mod.hash = this._hash(outputText)
            }
            log.debug(`${sourceFile} compiled in ${(performance.now() - t).toFixed(3)}ms`)

            if (!fsync) {
                fsync = true
            }
        }

        // compile deps
        for (const dep of mod.deps) {
            const depMod = await this._compile(dep.path)
            if (dep.hash !== depMod.hash) {
                dep.hash = depMod.hash
                if (!dep.path.startsWith('http')) {
                    const depImportPath = path.relative(
                        path.dirname(path.resolve('/', sourceFile)),
                        path.resolve('/', dep.path.replace(reModuleExt, ''))
                    )
                    mod.jsContent = mod.jsContent.replace(/ from ("|')([^'"]+)("|');?/g, (s, ql, importPath, qr) => {
                        if (
                            reHashJS.test(importPath) &&
                            importPath.slice(0, importPath.length - 13) === depImportPath
                        ) {
                            return ` from ${ql}${depImportPath}.${dep.hash.slice(0, 9)}.js${qr};`
                        }
                        return s
                    })
                    mod.hash = this._hash(mod.jsContent)
                }
                if (!fsync) {
                    fsync = true
                }
            }
        }

        if (fsync) {
            mod.jsFile = path.join(saveDir, name + (mod.isRemote ? '' : `.${mod.hash.slice(0, 9)}`)) + '.js'
            await Promise.all([
                this._writeTextFile(metaFile, JSON.stringify({
                    sourceFile,
                    sourceHash: mod.sourceHash,
                    hash: mod.hash,
                    deps: mod.deps,
                }, undefined, 4)),
                this._writeTextFile(mod.jsFile, mod.jsContent),
                mod.jsSourceMap !== '' ? this._writeTextFile(mod.jsFile + '.map', mod.jsSourceMap) : Promise.resolve()
            ])
        }

        if (mod.isRemote) {
            this._deps.set(mod.id, mod)
        } else {
            this._modules.set(mod.id, mod)
        }

        return mod
    }

    private _updateDependency(depPath: string, depHash: string, callback: (mod: Module) => void) {
        this._modules.forEach(mod => {
            mod.deps.forEach(dep => {
                if (dep.path === depPath && dep.hash !== depHash) {
                    const depImportPath = path.relative(
                        path.dirname(path.resolve('/', mod.sourceFile)),
                        path.resolve('/', dep.path.replace(reModuleExt, ''))
                    )
                    dep.hash = depHash
                    mod.jsContent = mod.jsContent.replace(/ from ("|')([^'"]+)("|');?/g, (s, ql, importPath, qr) => {
                        if (
                            reHashJS.test(importPath) &&
                            importPath.slice(0, importPath.length - 13) === depImportPath
                        ) {
                            return ` from ${ql}${depImportPath}.${dep.hash.slice(0, 9)}.js${qr};`
                        }
                        return s
                    })
                    mod.hash = this._hash(mod.jsContent)
                    this._writeTextFile(mod.jsFile.replace(reHashJS, '') + '.meta.json', JSON.stringify({
                        sourceFile: mod.sourceFile,
                        sourceHash: mod.sourceHash,
                        hash: mod.hash,
                        deps: mod.deps,
                    }, undefined, 4))
                    this._writeTextFile(`${mod.jsFile.replace(reHashJS, '')}.${mod.hash.slice(0, 9)}.js`, mod.jsContent)
                    this._writeTextFile(`${mod.jsFile.replace(reHashJS, '')}.${mod.hash.slice(0, 9)}.js.map`, mod.jsSourceMap)
                    callback(mod)
                    this._updateDependency(mod.sourceFile, mod.hash, callback)
                    log.debug('update dependency:', mod.sourceFile, '<-', depPath, depHash)
                }
            })
        })
    }

    private _rewriteImportPath(mod: Module, importPath: string): string {
        const { cacheDeps, importMap } = this.config
        let rewrittenPath: string
        if (importPath in importMap.imports) {
            importPath = importMap.imports[importPath]
        }
        if (reHttp.test(importPath)) {
            if (cacheDeps || /\.(jsx|tsx?)$/i.test(importPath)) {
                if (mod.isRemote) {
                    rewrittenPath = path.relative(
                        path.dirname(path.resolve('/', mod.sourceFile.replace(reHttp, '-/').replace(/:(\d+)/, `/$1`))),
                        this._renameRemotePath(importPath)
                    )
                } else {
                    rewrittenPath = path.relative(
                        path.dirname(path.resolve('/', mod.sourceFile)),
                        this._renameRemotePath(importPath)
                    )
                }
            } else {
                rewrittenPath = importPath
            }
        } else {
            if (mod.isRemote) {
                const sourceUrl = new URL(mod.sourceFile)
                let pathname = importPath
                if (!pathname.startsWith('/')) {
                    pathname = path.join(path.dirname(sourceUrl.pathname), importPath)
                }
                rewrittenPath = path.relative(
                    path.dirname(this._renameRemotePath(mod.sourceFile)),
                    '/' + path.join('-', sourceUrl.host, pathname)
                )
            } else {
                rewrittenPath = importPath.replace(reModuleExt, '') + '.' + 'x'.repeat(9)
            }
        }
        if (reHttp.test(importPath)) {
            mod.deps.push({ path: importPath, hash: '' })
        } else {
            if (mod.isRemote) {
                const sourceUrl = new URL(mod.sourceFile)
                let pathname = importPath
                if (!pathname.startsWith('/')) {
                    pathname = path.join(path.dirname(sourceUrl.pathname), importPath)
                }
                mod.deps.push({ path: sourceUrl.protocol + '//' + sourceUrl.host + pathname, hash: '' })
            } else {
                mod.deps.push({ path: '.' + path.resolve('/', path.dirname(mod.sourceFile), importPath), hash: '' })
            }
        }

        if (reHttp.test(rewrittenPath)) {
            return rewrittenPath
        }

        if (!rewrittenPath.startsWith('.') && !rewrittenPath.startsWith('/')) {
            rewrittenPath = './' + rewrittenPath
        }
        return rewrittenPath.replace(reModuleExt, '') + '.js'
    }

    private _renameRemotePath(path: string): string {
        return path.replace(reHttp, '/-/').replace(/:(\d+)/, '/$1')
    }

    private async _renderPage(url: RouterURL) {
        const ret = {
            code: 404,
            head: ['<title>404 - page not found</title>'],
            body: '<p><strong><code>404</code></strong><small> - </small><span>page not found</span></p>',
        }
        if (url.pagePath in this._pageModules) {
            try {
                Object.assign(globalThis, {
                    $RefreshReg$: () => { },
                    $RefreshSig$: () => (type: any) => type,
                })
                const [
                    { renderPage, renderHead },
                    App,
                    Page
                ] = await Promise.all([
                    import(this._modules.get('./renderer.js')!.jsFile),
                    this.importModuleAsComponent('./app.js'),
                    this.importModuleAsComponent(this._pageModules[url.pagePath], url)
                ])
                if (util.isFunction(Page.Component)) {
                    const html = renderPage(url, util.isFunction(App.Component) ? App : undefined, Page)
                    ret.code = 200
                    ret.head = renderHead()
                    ret.body = `<main>${html}</main>`
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

    private _hash(content: string): string {
        const md5 = new Md5()
        md5.update(content)
        md5.update(Date.now().toString())
        return md5.toString('hex')
    }

    private async _writeTextFile(filepath: string, content: string) {
        const dir = path.dirname(filepath)
        if (!existsSync(dir)) {
            await Deno.mkdir(dir, { recursive: true })
        }
        await Deno.writeTextFile(filepath, content)
    }
}
