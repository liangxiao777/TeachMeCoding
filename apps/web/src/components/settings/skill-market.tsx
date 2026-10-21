import { useEffect, useRef, useState } from 'react'
import { Check, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogSkill, SkillLeaderboard, SkillLeaderboardView, SkillSearch } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { formatNumber } from '@/i18n/format'
import { formatNotice, notice, type UiNotice } from '@/i18n/notice'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const views = ['all-time', 'trending', 'hot'] as const

export function SkillMarket({ active, busy, installing, installed, onInstall }: {
  active: boolean; busy: boolean; installing: string | null
  installed: (skill: CatalogSkill) => boolean | undefined; onInstall: (skill: CatalogSkill) => Promise<Error | UiNotice | null>
}) {
  const { t } = useTranslation('settings')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<{ view: SkillLeaderboardView; search: string | null }>({ view: 'all-time', search: null })
  const [data, setData] = useState<SkillLeaderboard | null>(null)
  const [loading, setLoading] = useState<'initial' | 'more' | null>(null)
  const [error, setError] = useState<Error | UiNotice | null>(null)
  const [installationError, setInstallationError] = useState<{ id: string; notice: Error | UiNotice } | null>(null)
  const revision = useRef(0)
  const load = async (page = 0) => {
    const current = ++revision.current
    setLoading(page ? 'more' : 'initial'); setError(null)
    if (!page) setData(null)
    try {
      const next = selection.search
        ? { ...await api<SkillSearch>(`/settings/skills/search?q=${encodeURIComponent(selection.search)}`), page: 0, hasMore: false, total: 0 }
        : await api<SkillLeaderboard>(`/settings/skills/leaderboard?view=${selection.view}&page=${page}`)
      if (current === revision.current) setData((previous) => page ? { ...next, skills: [...(previous?.skills ?? []), ...next.skills] } : next)
    } catch (error) { if (current === revision.current) setError(error instanceof Error ? error : notice('settings', 'errors.loadMarket')) }
    finally { if (current === revision.current) setLoading(null) }
  }
  useEffect(() => {
    if (active) void load()
    return () => { revision.current++ }
  }, [active, selection])
  const select = (view: SkillLeaderboardView, search: string | null = null) => {
    revision.current++; setData(null); setError(null); setLoading('initial'); setSelection({ view, search })
  }
  const hot = !selection.search && selection.view === 'hot'
  const metric = selection.search || selection.view === 'all-time' ? t('market.installs') : selection.view === 'trending' ? t('market.dailyInstalls') : t('market.hourlyInstalls')
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (query.trim()) select(selection.view, query.trim()) }}>
        <div className="relative min-w-0 flex-1"><Search aria-hidden className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input aria-label={t('market.searchLabel')} className="pr-9 pl-9" placeholder={t('market.searchPlaceholder')} value={query} onChange={(event) => {
            setQuery(event.target.value)
            if (selection.search) select(selection.view)
          }} />
          {query && <Button type="button" variant="ghost" size="icon-sm" aria-label={t('market.clearSearch')} className="absolute top-0.5 right-0.5 size-8" onClick={() => { setQuery(''); select(selection.view) }}><X /></Button>}
        </div>
        <Button type="submit" variant="outline" disabled={!query.trim()}><Search />{t('actions.search')}</Button>
      </form>
      <Tabs value={selection.view} onValueChange={(value) => { setQuery(''); select(value as SkillLeaderboardView) }} className="gap-4">
        <TabsList variant="line" aria-label={t('market.leaderboards')} className="h-10! w-full flex-row! justify-start border-b p-0">
          {views.map((id) => <TabsTrigger key={id} value={id} className="h-10 w-auto! flex-none justify-center! rounded-none px-3 after:inset-x-3! after:top-auto! after:right-3! after:bottom-0! after:h-0.5! after:w-auto!">{t(`market.views.${id}`)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={selection.view} className="flex min-w-0 flex-col gap-4">
          {selection.search && <p className="text-sm text-muted-foreground">{t('market.queryResults', { query: selection.search })}</p>}
          {error && <Alert variant="destructive"><AlertDescription>{formatNotice(error)}<Button variant="outline" size="sm" onClick={() => void load(data ? data.page + 1 : 0)}>{t('actions.retry')}</Button></AlertDescription></Alert>}
          {loading === 'initial' && <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Spinner />{t('market.loading')}</div>}
          {data && (!data.skills.length ? <Empty className="border py-14"><EmptyHeader><EmptyTitle>{selection.search ? t('market.noMatch') : t('market.empty')}</EmptyTitle>
            <EmptyDescription>{selection.search ? t('skills.tryKeyword') : t('market.comeBackLater')}</EmptyDescription></EmptyHeader></Empty> :
            <div className="overflow-hidden rounded-xl border">
              <table className="w-full table-fixed text-sm" aria-label={selection.search ? t('market.searchResults') : t('market.leaderboardLabel', { view: t(`market.views.${selection.view}`) })}>
                <thead className="border-b bg-muted/30 text-xs text-muted-foreground"><tr>
                  <th className="w-9 py-3 text-center font-medium sm:w-12">#</th><th className="py-3 pr-2 text-left font-medium">{t('market.skillSource')}</th>
                  <th className="w-20 py-3 pr-2 text-right font-medium sm:w-32 sm:pr-6" title={hot ? t('market.hourlyDescription') : undefined}>{metric}</th><th className="w-20 py-3 text-center font-medium sm:w-24">{t('market.actions')}</th>
                </tr></thead>
                <tbody>{data.skills.map((skill, index) => <tr key={skill.id} aria-label={skill.name} className="border-b transition-colors last:border-0 hover:bg-muted/30">
                  <td className="py-3 text-center text-xs text-muted-foreground tabular-nums">{formatNumber(index + 1)}</td>
                  <td className="py-3 pr-2"><h3 className="break-words font-medium sm:truncate" title={skill.name}>{skill.name}</h3><p className="mt-1 break-all text-xs text-muted-foreground sm:truncate" title={skill.source}>{skill.source}</p>
                    {installationError?.id === skill.id && <p role="alert" className="mt-2 break-words text-xs text-destructive">{formatNotice(installationError.notice)}</p>}</td>
                  <td className="py-3 pr-2 text-right tabular-nums sm:pr-6"><span aria-label={t('market.installCount', { count: skill.installs, formattedCount: formatNumber(skill.installs) })} title={formatNumber(skill.installs)}>{formatNumber(skill.installs, { notation: 'compact', maximumFractionDigits: 1 })}</span>
                    {hot && <p className="mt-1 text-xs text-muted-foreground" aria-label={t('market.change')}>{formatNumber(skill.change!, { signDisplay: 'exceptZero' })}</p>}</td>
                  <td className="py-3 pr-2 text-center sm:pr-3">{installed(skill) ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" />{t('skills.installed')}</span> :
                    <Button variant="outline" size="sm" disabled={busy} aria-label={t('market.installLabel', { name: skill.name })} onClick={() => {
                      setInstallationError(null)
                      void onInstall(skill).then((notice) => setInstallationError(notice ? { id: skill.id, notice } : null))
                    }}>
                      {installing === skill.id ? <><Spinner /><span className="sr-only sm:not-sr-only">{t('market.installing')}</span></> : t('market.install')}
                    </Button>}</td>
                </tr>)}</tbody>
              </table>
            </div>)}
          {data?.hasMore && !error && <Button variant="outline" className="self-center" disabled={loading === 'more'} onClick={() => void load(data.page + 1)}>{loading === 'more' && <Spinner />}{t('market.loadMore')}</Button>}
        </TabsContent>
      </Tabs>
    </div>
  )
}
