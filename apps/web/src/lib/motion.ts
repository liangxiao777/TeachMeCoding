import type { CSSProperties } from 'react'

export const uiMotion = {
  content: 0.2,
  panel: 0.24,
  ease: [0.22, 1, 0.36, 1] as const,
}

export const uiMotionVariables = {
  '--ui-motion-content': `${uiMotion.content * 1000}ms`,
  '--ui-motion-ease': `cubic-bezier(${uiMotion.ease.join(',')})`,
} as CSSProperties
