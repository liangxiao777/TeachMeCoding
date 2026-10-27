import { useEffect, useRef } from 'react'

// Esc first closes the innermost popup, dialog or field interaction; only then does it leave the page or mode.
const openLayer = '[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"]'
const editable = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

/** Leave a full-page overlay or mode on Esc. Overlays listen in capture so a covered page never sees the key. */
export function useEscape(action: () => void, { enabled = true, capture = false, ignoreFields = false } = {}) {
  const latest = useRef(action)
  useEffect(() => { latest.current = action })
  useEffect(() => {
    if (!enabled) return
    const listener = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || document.querySelector(openLayer)
        || ignoreFields && editable(e.target)) return
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', listener, capture)
    return () => window.removeEventListener('keydown', listener, capture)
  }, [enabled, capture, ignoreFields])
}
