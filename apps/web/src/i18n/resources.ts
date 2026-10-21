import type { BusinessErrorCode } from '@teach-me-coding/contracts'
import commonEn from './locales/en/common.json'
import homeEn from './locales/en/home.json'
import settingsEn from './locales/en/settings.json'
import learningEn from './locales/en/learning.json'
import workbenchEn from './locales/en/workbench.json'
import assessmentEn from './locales/en/assessment.json'
import libraryEn from './locales/en/library.json'
import errorsEn from './locales/en/errors.json'
import previewEn from './locales/en/preview.json'
import commonZh from './locales/zh-CN/common.json'
import homeZh from './locales/zh-CN/home.json'
import settingsZh from './locales/zh-CN/settings.json'
import learningZh from './locales/zh-CN/learning.json'
import workbenchZh from './locales/zh-CN/workbench.json'
import assessmentZh from './locales/zh-CN/assessment.json'
import libraryZh from './locales/zh-CN/library.json'
import errorsZh from './locales/zh-CN/errors.json'
import previewZh from './locales/zh-CN/preview.json'

export const resources = {
  en: { common: commonEn, home: homeEn, settings: settingsEn, learning: learningEn, workbench: workbenchEn, assessment: assessmentEn, library: libraryEn, errors: errorsEn satisfies Record<BusinessErrorCode, string>, preview: previewEn },
  'zh-CN': { common: commonZh, home: homeZh, settings: settingsZh, learning: learningZh, workbench: workbenchZh, assessment: assessmentZh, library: libraryZh, errors: errorsZh, preview: previewZh },
}

export type TranslationNamespace = keyof typeof resources.en
