import i18n from './index'

export function currentLocale() {
  return i18n.resolvedLanguage ?? 'en'
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(currentLocale(), options).format(value)
}

export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(currentLocale(), options).format(value)
}

export function formatRelativeTime(timestamp: number, now = Date.now()) {
  const minutes = Math.floor((now - timestamp) / 60_000)
  if (minutes >= 0 && minutes < 1) return i18n.t('time.justNow')
  const elapsed = Math.abs(minutes)
  const value = elapsed < 60 ? minutes : elapsed < 1440 ? Math.trunc(minutes / 60) : Math.trunc(minutes / 1440)
  const unit = elapsed < 60 ? 'minute' : elapsed < 1440 ? 'hour' : 'day'
  return new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'always' }).format(-value, unit)
}
