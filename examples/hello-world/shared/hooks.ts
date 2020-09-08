import { useState } from 'https://esm.sh/react'

export function useCount(initial: number) {
    const [count, setCount] = useState(initial)

    return {
        count,
        increase: () => setCount(n => n + 1),
        decrease: () => setCount(n => n - 1)
    }
}