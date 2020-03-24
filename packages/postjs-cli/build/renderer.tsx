import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { Router, renderHeadToString } from '@postjs/core'

export async function renderPage(router: Router, PageComponent: React.ComponentType) {
    let props: any = {}
    if ('getStaticProps' in PageComponent) {
        const getStaticProps = (PageComponent as any)['getStaticProps']
        if (typeof getStaticProps === 'function') {
            props = await getStaticProps(router.url)
        }
    }

    const body = renderToString(<PageComponent {...props} url={router.url} />)
    const helmet = renderHeadToString()

    return {
        body,
        helmet
    }
}
