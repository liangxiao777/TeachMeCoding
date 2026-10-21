import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import i18n from './index'
import { languagePreference, languageStorageKey, resolveLanguage, type Language, type LanguagePreference } from './locale'

const LanguageContext = createContext<{ preference: LanguagePreference; setPreference: (value: LanguagePreference) => void } | null>(null)

function savedPreference(): LanguagePreference {
  try { return languagePreference(localStorage.getItem(languageStorageKey)) }
  catch { return 'system' }
}

function applyLanguage(language: Language) {
  void i18n.changeLanguage(language)
  const t = i18n.getFixedT(language, 'common')
  document.documentElement.lang = language
  document.title = t('document.title')
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('document.description'))
}

export function initializeLanguage() {
  applyLanguage(resolveLanguage(savedPreference(), navigator.languages))
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(savedPreference)
  const [languages, setLanguages] = useState(() => [...navigator.languages])
  const language = resolveLanguage(preference, languages)
  useLayoutEffect(() => { applyLanguage(language) }, [language])
  useEffect(() => {
    const updateBrowser = () => setLanguages([...navigator.languages])
    const updatePreference = (event: StorageEvent) => {
      if (event.key === languageStorageKey || event.key === null) setPreference(savedPreference())
    }
    window.addEventListener('languagechange', updateBrowser)
    window.addEventListener('storage', updatePreference)
    return () => {
      window.removeEventListener('languagechange', updateBrowser)
      window.removeEventListener('storage', updatePreference)
    }
  }, [])
  const choose = (value: LanguagePreference) => {
    try {
      if (value === 'system') localStorage.removeItem(languageStorageKey)
      else localStorage.setItem(languageStorageKey, value)
    } catch { /* Keep this page usable when browser storage is unavailable. */ }
    setPreference(value)
  }
  return <LanguageContext value={{ preference, setPreference: choose }}>{children}</LanguageContext>
}

export function useLanguagePreference() {
  const context = useContext(LanguageContext)
  if (!context) throw new Error('useLanguagePreference requires LanguageProvider')
  return context
}
