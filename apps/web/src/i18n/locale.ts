export const supportedLanguages = ['en', 'zh-CN'] as const
export type Language = typeof supportedLanguages[number]
export type LanguagePreference = Language | 'system'
export const languageStorageKey = 'tmc-language'

export function languagePreference(value: unknown): LanguagePreference {
  return value === 'en' || value === 'zh-CN' ? value : 'system'
}

export function resolveLanguage(preference: LanguagePreference, languages: readonly string[]): Language {
  if (preference !== 'system') return preference
  for (const language of languages) {
    try {
      const locale = new Intl.Locale(language)
      if (locale.language === 'en') return 'en'
      if (locale.language !== 'zh' || locale.script === 'Hant') continue
      if (locale.script === 'Hans' || !locale.region || locale.region === 'CN' || locale.region === 'SG') return 'zh-CN'
    } catch { /* Ignore malformed browser tags and try the next preference. */ }
  }
  return 'en'
}
