import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resources } from './resources'

const i18n = createInstance()

// Catalogs ship with the application: no network, remote writes, or loading gap.
void i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: Object.keys(resources),
  ns: Object.keys(resources.en),
  defaultNS: 'common',
  initAsync: false,
  enableSelector: false,
  returnNull: false,
  returnEmptyString: false,
  interpolation: { escapeValue: false }, // React escapes rendered text.
  react: { useSuspense: false },
})

export default i18n
