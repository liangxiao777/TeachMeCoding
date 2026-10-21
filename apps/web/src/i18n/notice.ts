import type { ParseKeys } from 'i18next'
import type { BusinessErrorResponse } from '@teach-me-coding/contracts'
import i18n from './index'
import { resources, type TranslationNamespace } from './resources'

type Values = Record<string, string | number | UiNotice | Error | BusinessErrorResponse>
export interface UiNotice {
  namespace: TranslationNamespace
  key: string
  values: Values
}
export type NoticeValue = UiNotice | Error | BusinessErrorResponse | null

export function notice<Ns extends TranslationNamespace>(namespace: Ns, key: ParseKeys<Ns>, values: Values = {}): UiNotice {
  return { namespace, key: String(key), values }
}

/** A thrown client failure keeps its translation identity, not a captured string. */
export class NoticeError extends Error {
  constructor(readonly notice: UiNotice | BusinessErrorResponse) { super() }
  override get message() { return formatNotice(this.notice) }
}

/** Translate at render time, never when an error first enters transient state. */
export function formatNotice(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof NoticeError) return formatNotice(value.notice)
  if (typeof value === 'object' && 'namespace' in value && 'key' in value && 'values' in value) {
    const message = value as UiNotice
    const values = Object.fromEntries(Object.entries(message.values).map(([key, entry]) =>
      [key, typeof entry === 'string' || typeof entry === 'number' ? entry : formatNotice(entry)]))
    return i18n.t(message.key as ParseKeys<TranslationNamespace>, { ns: message.namespace, replace: values })
  }
  if (typeof value === 'object' && 'code' in value && typeof value.code === 'string'
    && Object.hasOwn(resources.en.errors, value.code)) {
    const params = 'params' in value && value.params && typeof value.params === 'object' ? value.params : {}
    return i18n.t(value.code as keyof typeof resources.en.errors, { ns: 'errors', replace: params })
  }
  return i18n.t('errors.requestFailed')
}
