import { ArrowLeft, Blocks, BookOpen, Globe, Plug, Settings2 } from 'lucide-react'
import { motion, useIsPresent, useReducedMotion } from 'motion/react'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEscape } from '@/app/escape'
import { ThemeToggle } from '@/app/theme'
import { useLanguagePreference } from '@/i18n/language'
import { languagePreference } from '@/i18n/locale'
import { uiMotion } from '@/lib/motion'
import { ModelSettingsForm } from './model-settings'
import { McpSettingsForm } from './mcp-settings'
import { SkillsSettingsForm } from './skills-settings'
import { SearchSettingsForm } from './search-settings'

export const SettingsNavigation = createContext<(() => void) | null>(null)

export function SettingsButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const { t } = useTranslation('settings')
  const open = useContext(SettingsNavigation)
  if (!open) return null
  return (
    <Button variant="ghost" size={iconOnly ? 'icon-sm' : 'sm'} aria-label={t('openSettings')} title={t('openSettings')} onClick={open}>
      <Settings2 data-icon={iconOnly ? undefined : 'inline-start'} />
      {!iconOnly && <span className="max-sm:hidden">{t('title')}</span>}
    </Button>
  )
}

const categories = [
  { id: 'model', icon: Blocks },
  { id: 'mcp', icon: Plug },
  { id: 'skills', icon: BookOpen },
  { id: 'search', icon: Globe },
] as const

export function SettingsPage({ onBack, onEntered }: { onBack: () => void; onEntered: () => void }) {
  const { t } = useTranslation(['settings', 'common'])
  const { preference, setPreference } = useLanguagePreference()
  const [category, setCategory] = useState('model')
  const [desktop, setDesktop] = useState(() => matchMedia('(min-width: 768px)').matches)
  const isPresent = useIsPresent()
  const reducedMotion = useReducedMotion()
  const title = useRef<HTMLHeadingElement>(null)
  useEscape(onBack, { enabled: isPresent, capture: true, ignoreFields: true })
  useEffect(() => {
    title.current?.focus()
    const query = matchMedia('(min-width: 768px)')
    const resize = () => setDesktop(query.matches)
    query.addEventListener('change', resize)
    return () => query.removeEventListener('change', resize)
  }, [])

  return (
    <motion.section
      aria-label={t('openSettings')}
      aria-hidden={!isPresent}
      inert={!isPresent}
      initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reducedMotion ? 0 : 4 }}
      transition={{ duration: reducedMotion ? 0 : uiMotion.content }}
      onAnimationComplete={() => { if (isPresent) onEntered() }}
      className="fixed inset-0 z-50 flex h-dvh min-w-0 flex-col bg-background text-foreground"
    >
      <header className="flex h-16 shrink-0 items-center gap-4 border-b px-4 md:px-6">
        <Button variant="ghost" onClick={onBack}><ArrowLeft data-icon="inline-start" />{t('back')}</Button>
        <span className="h-5 border-l" aria-hidden />
        <h1 ref={title} tabIndex={-1} className="text-base font-semibold outline-none">{t('title')}</h1>
        <div className="ml-auto flex items-center gap-2">
          <Select value={preference} onValueChange={(value) => { if (value) setPreference(languagePreference(value)) }}>
            <SelectTrigger aria-label={t('common:language.label')}>
              <SelectValue>{preference === 'system' ? t('common:language.system') : preference === 'en' ? 'English' : '简体中文'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('common:language.system')}</SelectItem>
              <SelectItem value="en" lang="en">English</SelectItem>
              <SelectItem value="zh-CN" lang="zh-CN">简体中文</SelectItem>
            </SelectContent>
          </Select>
          <ThemeToggle />
        </div>
      </header>
      <Tabs value={category} onValueChange={(value) => setCategory(String(value))} orientation={desktop ? 'vertical' : 'horizontal'}
        className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 border-b bg-sidebar p-3 md:w-56 md:border-r md:border-b-0 md:p-4">
          <TabsList aria-label={t('navigationLabel')} className="h-auto! w-full gap-1 bg-transparent p-0">
            {categories.map(({ id, icon: Icon }) => (
              <TabsTrigger key={id} value={id} className="h-10 flex-none px-3 max-md:flex-1 max-sm:px-1.5 max-sm:[&_svg]:hidden data-active:bg-background">
                <Icon />{t(`categories.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {categories.map(({ id }) => (
          <TabsContent key={id} value={id} keepMounted className="min-h-0 min-w-0 overflow-y-auto p-5 md:p-10">
            <div className={`mx-auto flex w-full flex-col gap-6 ${id === 'skills' ? 'max-w-5xl' : 'max-w-3xl'}`}>
              {id === 'model' && <div className="flex flex-col gap-2">
                <h2 className="text-2xl font-semibold tracking-tight">{t(`categories.${id}`)}</h2>
                <p className="text-sm text-muted-foreground">{t('modelDescription')}</p>
              </div>}
              {id === 'model' && <ModelSettingsForm active={category === id && isPresent} />}
              {id === 'mcp' && <McpSettingsForm active={category === id && isPresent} />}
              {id === 'skills' && <SkillsSettingsForm active={category === id && isPresent} />}
              {id === 'search' && <SearchSettingsForm active={category === id && isPresent} />}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </motion.section>
  )
}
