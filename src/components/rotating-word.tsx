'use client'

import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * The changing end of a hero headline (Chai Prep's RotatingWord). Every word
 * sits in the same grid cell, so the line keeps the width of the longest and
 * nothing below it jumps; the next word rises in out of a blur. Screen
 * readers get the first word and no live region, because a headline that
 * keeps announcing itself is noise. Reduced motion shows the first word only.
 */
export function RotatingWord({ words, interval = 2600, className }: { words: string[]; interval?: number; className?: string }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setI((n) => (n + 1) % words.length), interval)
    return () => clearInterval(t)
  }, [words.length, interval])

  return (
    <span className="inline-grid align-top">
      <span className="sr-only">{words[0]}</span>
      {words.map((w, n) => (
        <span
          key={w}
          aria-hidden="true"
          className={cn('col-start-1 row-start-1 transition-all duration-500 ease-out', className)}
          style={{
            opacity: n === i ? 1 : 0,
            transform: n === i ? 'none' : n === (i + words.length - 1) % words.length ? 'translateY(-0.4em)' : 'translateY(0.4em)',
            filter: n === i ? 'none' : 'blur(4px)',
          }}
        >
          {w}
        </span>
      ))}
    </span>
  )
}
