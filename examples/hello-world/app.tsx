import React, { Fragment, PropsWithChildren } from 'https://esm.sh/react/mod.js'
import Head from 'https://postjs.io/head.ts'

export default function App({ children }: PropsWithChildren<{}>) {
    return (
        <Fragment>
            <Head>
                <title>Welcome - postjs</title>
            </Head>
            {children}
        </Fragment>
    )
}
