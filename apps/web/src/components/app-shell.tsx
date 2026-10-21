'use client'

import { Activity, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatNotice } from '@/i18n/notice'
import { AnimatePresence, MotionConfig, useReducedMotion } from 'motion/react'
import { usePanelRef } from 'react-resizable-panels'
import { AgentPanel } from '@/components/agent/agent-panel'
import { AssessmentView } from '@/components/assessment/assessment-view'
import { ResultView } from '@/components/assessment/result-view'
import { Onboarding } from '@/components/onboarding'
import { RouteView } from '@/components/route-view'
import { LibraryNavigation, LibraryPage } from '@/components/library-page'
import { SettingsNavigation, SettingsPage } from '@/components/settings/settings-page'
import { SpaceList } from '@/components/space-list'
import { TopBar } from '@/components/top-bar'
import { Workbench } from '@/components/workbench/workbench'
import { Button } from '@/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useApp } from '@/app/context'
import { LessonDrawerProvider } from '@/app/lesson-drawer'
import { uiMotion, uiMotionVariables } from '@/lib/motion'

const agentWidths = new Map<string, number>()

function SpaceBody() {
  const { t } = useTranslation()
  const { current } = useApp()
  const reducedMotion = useReducedMotion()
  const group = useRef<HTMLDivElement>(null)
  const agent = usePanelRef()
  const agentWidth = useRef(agentWidths.get(current?.id ?? '') ?? 384)
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => agent.current?.resize(`${current?.agentOpen ? agentWidth.current : 0}px`))
    return () => cancelAnimationFrame(frame)
  }, [current?.agentOpen, current?.view, agent])
  if (!current) return null
  if (current.view === 'onboarding' || current.view === 'planning') return <Onboarding />
  const transition = { transition: `flex-grow ${reducedMotion || current.view !== 'route' ? 0 : uiMotion.panel}s var(--ui-motion-ease)` }

  return (
    <div className={`flex h-dvh min-w-[1100px] flex-col ${current.ideFullscreen && current.view === 'unit' ? 'dark bg-background text-foreground' : ''}`}>
      <TopBar />
      <ResizablePanelGroup
        orientation="horizontal"
        elementRef={group}
        style={transition}
        className="min-h-0 flex-1 [&>[data-panel]]:[transition:inherit] [&:has(>[data-separator=active])>[data-panel]]:transition-none! [&:has(>[data-separator]:focus-visible)>[data-panel]]:transition-none!"
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction && current.agentOpen) {
            // Keyboard callbacks can run before the DOM reflects the new width.
            agentWidth.current = group.current!.clientWidth * layout.agent! / 100
            agentWidths.set(current.id, agentWidth.current)
          }
        }}
      >
        <ResizablePanel id="learning" minSize="640px">
          <main className="flex h-full min-h-0 min-w-0 flex-col">
            {current.view === 'route' && <RouteView />}
            {current.view === 'unit' && <Workbench />}
            {current.view === 'assessment' && <AssessmentView />}
            {current.view === 'result' && <ResultView />}
          </main>
        </ResizablePanel>
        <ResizableHandle
          aria-label={t('chat.resize')}
          disabled={!current.agentOpen}
          className={current.agentOpen ? 'z-10 w-0! after:w-2 hover:after:bg-primary/15 data-[separator=active]:after:bg-primary/25' : 'hidden'}
        />
        <ResizablePanel
          id="agent"
          panelRef={agent}
          defaultSize="384px"
          minSize={current.agentOpen ? '320px' : 0}
          maxSize={current.agentOpen ? '50%' : 0}
          groupResizeBehavior="preserve-pixel-size"
        >
          <div className="flex h-full min-h-0 overflow-hidden">
            <AnimatePresence initial={false}>
              {current.agentOpen && <AgentPanel />}
            </AnimatePresence>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

export function AppShell() {
  const { t } = useTranslation()
  const { current, persistence } = useApp()
  const [libraryOpen, setLibraryOpen] = useState(() => !!persistence && location.pathname === '/library')
  const libraryTrigger = useRef<HTMLElement | null>(null)
  const libraryScroll = useRef({ x: 0, y: 0 })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsCovered, setSettingsCovered] = useState(false)
  const settingsOpenRef = useRef(false)
  const settingsTrigger = useRef<HTMLElement | null>(null)
  const learningScroll = useRef({ x: 0, y: 0 })
  const openLibrary = () => {
    libraryTrigger.current = document.activeElement as HTMLElement | null
    libraryScroll.current = { x: window.scrollX, y: window.scrollY }
    history.pushState({ tmcLibrary: true }, '', `/library${location.search}`)
    setLibraryOpen(true)
  }
  const closeLibrary = () => {
    if (history.state?.tmcLibrary) history.back()
    else {
      history.replaceState(null, '', `/${location.search}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  }
  useEffect(() => {
    if (!persistence) return
    const navigate = () => {
      const open = location.pathname === '/library'
      setLibraryOpen(open)
      if (!open) requestAnimationFrame(() => {
        libraryTrigger.current?.focus({ preventScroll: true })
        window.scrollTo({ left: libraryScroll.current.x, top: libraryScroll.current.y, behavior: 'instant' })
      })
    }
    window.addEventListener('popstate', navigate)
    return () => window.removeEventListener('popstate', navigate)
  }, [!!persistence])
  const openSettings = () => {
    settingsTrigger.current = document.activeElement as HTMLElement | null
    learningScroll.current = { x: window.scrollX, y: window.scrollY }
    settingsOpenRef.current = true
    setSettingsCovered(false)
    setSettingsOpen(true)
  }
  const closeSettings = () => {
    settingsOpenRef.current = false
    setSettingsOpen(false)
    setSettingsCovered(false)
    requestAnimationFrame(() => {
      if (settingsOpenRef.current) return
      settingsTrigger.current?.focus({ preventScroll: true })
      window.scrollTo({ left: learningScroll.current.x, top: learningScroll.current.y, behavior: 'instant' })
    })
  }
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: uiMotion.content, ease: uiMotion.ease }}>
      <TooltipProvider delay={300}>
        <SettingsNavigation value={persistence ? openSettings : null}>
        <LibraryNavigation value={persistence ? openLibrary : null}>
          <div className="min-h-dvh" style={uiMotionVariables}>
            <div inert={settingsOpen || libraryOpen} aria-hidden={settingsOpen || libraryOpen}>
              <Activity mode={libraryOpen ? 'hidden' : 'visible'}>
                {/* Settings hide the surface without destroying editor/terminal Effects. */}
                <div className="app-layout" data-fixture={!persistence || undefined} style={{ display: settingsCovered && settingsOpen ? 'none' : undefined }}>
                  {current ? <LessonDrawerProvider key={current.id}><SpaceBody /></LessonDrawerProvider> : <SpaceList />}
                  {persistence && (persistence.error || persistence.busy || !persistence.ready) && (
                    <div className="fixed inset-x-3 bottom-8 z-50 mx-auto max-w-xl rounded-lg border bg-background p-3 shadow-sm">
                      {persistence.error ? (
                        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
                          <span className="flex-1">{formatNotice(persistence.error)}</span>
                          <Button variant="outline" size="sm" disabled={persistence.busy} onClick={persistence.retry}>{t('actions.retry')}</Button>
                        </div>
                      ) : (
                        <p role="status" className="text-xs text-muted-foreground">{t('status.saving')}</p>
                      )}
                    </div>
                  )}
                  {!persistence && (
                    <footer className="flex h-6 items-center border-t bg-muted px-3 text-[10px] text-muted-foreground">
                      <a href="/diagnostics" data-testid="fixture-notice">{t('fixture')}</a>
                    </footer>
                  )}
                </div>
              </Activity>
            </div>
            {libraryOpen && <LibraryPage onBack={closeLibrary} />}
            <AnimatePresence initial={false}>
              {settingsOpen && <SettingsPage onBack={closeSettings} onEntered={() => {
                if (settingsOpenRef.current) setSettingsCovered(true)
              }} />}
            </AnimatePresence>
          </div>
        </LibraryNavigation>
        </SettingsNavigation>
      </TooltipProvider>
    </MotionConfig>
  )
}
