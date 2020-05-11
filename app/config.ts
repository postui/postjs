import { fs, path } from '../deps.ts'
import log from '../log.ts'
import util from '../util.ts'

export interface AppConfig {
    readonly framework: 'react' | 'preact' | 'vue'
    readonly rootDir: string
    readonly srcDir: string
    readonly outputDir: string
    readonly downloadRemoteModules: boolean
    readonly baseUrl: string
    readonly lang: string
    readonly locales: Map<string, Map<string, string>>
}

export function loadAppConfig(appDir: string) {
    const config: AppConfig = {
        framework: 'react',
        rootDir: path.resolve(appDir),
        srcDir: '/',
        outputDir: '/dist',
        downloadRemoteModules: true,
        baseUrl: '/',
        lang: 'en',
        locales: new Map()
    }

    try {
        const configFile = path.join(appDir, 'post.config.json')
        if (fs.existsSync(configFile)) {
            const {
                srcDir,
                ouputDir,
                baseUrl,
                downloadRemoteModules,
                lang,
                locales,
            } = fs.readJsonSync(configFile) as any
            if (util.isNEString(srcDir)) {
                Object.assign(config, { srcDir: util.cleanPath(srcDir) })
            }
            if (util.isNEString(ouputDir)) {
                Object.assign(config, { ouputDir: util.cleanPath(ouputDir) })
            }
            if (util.isNEString(baseUrl)) {
                Object.assign(config, { baseUrl: util.cleanPath(encodeURI(baseUrl)) })
            }
            if (util.isNEString(lang)) {
                Object.assign(config, { lang })
            }
            if (downloadRemoteModules === false) {
                Object.assign(config, { downloadRemoteModules: false })
            }
            if (util.isObject(locales)) {
                Object.keys(locales).forEach(locale => {
                    const value = locales[locale]
                    if (util.isObject(value)) {
                        const dictMap = new Map<string, string>()
                        Object.entries(value).forEach(([key, text]) => {
                            if (util.isNEString(text)) {
                                dictMap.set(key, text)
                            }
                        })
                        config.locales.set(locale, dictMap)
                    }
                })
            }
        }
    } catch (err) {
        log.error('bad app config: ', err)
    }
    return config
}
