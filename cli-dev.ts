import { start } from './server/dev.ts'
import { version } from './version.ts'

const helpMessage = `postjs v${version}
Starts the postjs app in development mode

Usage:
    deno --allow-all https://postjs.io/cli.ts dev <dir> [...options]

<dir> represents the directory of the postjs app,
if the <dir> is empty, the current directory will be used.

Options:
    --port, -p  A port number to start the postjs app, default is 8080
    --help, -h  Prints help message
`

export default function Dev(appDir: string, options: Record<string, string|boolean>) {
    if (options.h || options.help) {
        console.log(helpMessage)
        Deno.exit(0)
    }

    start(appDir, parseInt(String(options.port || options.p)) || 8080)
}
