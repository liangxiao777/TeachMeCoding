import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

type Theme = 'light' | 'dark'
const storageKey = 'tmc-theme'
const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null)

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(storageKey)
    return value === 'light' || value === 'dark' ? value : null
  } catch { return null }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.classList.toggle('light', theme === 'light')
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    meta.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff')
  })
}

export function initializeTheme() {
  applyTheme(savedTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(savedTheme)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const theme = preference ?? (systemDark ? 'dark' : 'light')
  useLayoutEffect(() => { applyTheme(theme) }, [theme])
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const updateSystem = () => setSystemDark(query.matches)
    const updatePreference = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) setPreference(savedTheme())
    }
    updateSystem()
    query.addEventListener('change', updateSystem)
    window.addEventListener('storage', updatePreference)
    return () => {
      query.removeEventListener('change', updateSystem)
      window.removeEventListener('storage', updatePreference)
    }
  }, [])
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(storageKey, next) } catch { /* Still switch for this page when storage is unavailable. */ }
    setPreference(next)
  }
  return <ThemeContext value={{ theme, toggle }}>{children}</ThemeContext>
}

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { theme, toggle } = useContext(ThemeContext)!
  const label = t(theme === 'dark' ? 'theme.light' : 'theme.dark')
  return (
    <Button className={className} variant="ghost" size="icon" aria-label={label} title={label} onClick={toggle}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  )
}
