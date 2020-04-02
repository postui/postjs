import { Head, SEO } from '@postjs/core'
import React from 'react'
import Nav from '../components/nav'

export async function getStaticProps() {
    return {
        name: 'postjs',
        description: 'The Post-Front-End Framework'
    }
}

export default ({ name, description }: any) => {
    return (
        <div>
            <Head>
                <meta http-equiv="X-UA-Compatible" content="IE=edge, chrome=1" />
            </Head>
            <SEO
                title={`About ${name}`}
                description={description}
                keywords={`react, ${name}`}
            />
            <Nav />
            <h1>About {name}</h1>
        </div>
    )
}