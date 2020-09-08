// @deno-types="../vendor/typescript/lib/typescript.d.ts"
import ts from '../vendor/typescript/lib/typescript.js'
import transformImportPathRewrite from './transform-import-path-rewrite.ts'
import transformReactJsxSource from './transform-react-jsx-source.ts'
import transformReactRefresh from './transform-react-refresh.ts'
import { CreatePlainTransformer, CreateTransformer } from './transformer.ts'

export interface CompileOptions {
    mode?: 'development' | 'production'
    rewriteImportPath?: (importPath: string) => string
    reactRefresh?: boolean
    transformers?: (ts.TransformerFactory<ts.SourceFile> | ts.CustomTransformerFactory)[]
}

export function createSourceFile(fileName: string, source: string) {
    return ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.ES2015,
    )
}

export function compile(fileName: string, source: string, { mode, rewriteImportPath, reactRefresh }: CompileOptions) {
    const transformers: ts.CustomTransformers = {
        before: [],
        after: []
    }
    if (mode === 'development') {
        transformers.before!.push(CreatePlainTransformer(transformReactJsxSource))
    }
    if (rewriteImportPath) {
        transformers.after!.push(CreatePlainTransformer(transformImportPathRewrite, rewriteImportPath))
    }
    if (reactRefresh) {
        transformers.after!.push(CreateTransformer(transformReactRefresh))
    }

    return ts.transpileModule(source, {
        reportDiagnostics: true,
        fileName,
        compilerOptions: {
            target: ts.ScriptTarget.ES2015,
            module: ts.ModuleKind.ES2015,
            allowJs: true,
            jsx: ts.JsxEmit.React,
            experimentalDecorators: true,
            importHelpers: true,
            importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
            alwaysStrict: true,
            sourceMap: true,
            inlineSources: true,
        },
        transformers,
    })
}