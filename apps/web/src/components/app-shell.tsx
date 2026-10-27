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
  const [libraryOpen, setLibraryOpen] = useState(() => location.pathname === '/library')
  const libraryOpenRef = useRef(libraryOpen)
  const libraryTrigger = useRef<HTMLElement | null>(null)
  const libraryScroll = useRef({ x: 0, y: 0 })
  const [settingsOpen, setSettingsOpen] = useState(() => location.pathname === '/settings')
  const [settingsCovered, setSettingsCovered] = useState(false)
  const settingsOpenRef = useRef(settingsOpen)
  const settingsTrigger = useRef<HTMLElement | null>(null)
  const learningScroll = useRef({ x: 0, y: 0 })
  // Library and settings are pages with their own paths, so browser Back closes them.
  const enter = (path: string, state: object) => history.pushState(state, '', `${path}${location.search}`)
  const leave = (key: 'tmcLibrary' | 'tmcSettings') => {
    if (history.state?.[key]) history.back()
    else {
      history.replaceState(null, '', `/${location.search}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  }
  const showLibrary = () => {
    libraryTrigger.current = document.activeElement as HTMLElement | null
    libraryScroll.current = { x: window.scrollX, y: window.scrollY }
    libraryOpenRef.current = true
    setLibraryOpen(true)
  }
  const hideLibrary = () => {
    libraryOpenRef.current = false
    setLibraryOpen(false)
    requestAnimationFrame(() => {
      libraryTrigger.current?.focus({ preventScroll: true })
      window.scrollTo({ left: libraryScroll.current.x, top: libraryScroll.current.y, behavior: 'instant' })
    })
  }
  const showSettings = () => {
    settingsTrigger.current = document.activeElement as HTMLElement | null
    learningScroll.current = { x: window.scrollX, y: window.scrollY }
    settingsOpenRef.current = true
    setSettingsCovered(false)
    setSettingsOpen(true)
  }
  const hideSettings = () => {
    settingsOpenRef.current = false
    setSettingsOpen(false)
    setSettingsCovered(false)
    requestAnimationFrame(() => {
      if (settingsOpenRef.current) return
      settingsTrigger.current?.focus({ preventScroll: true })
      window.scrollTo({ left: learningScroll.current.x, top: learningScroll.current.y, behavior: 'instant' })
    })
  }
  const openLibrary = () => { enter('/library', { tmcLibrary: true }); showLibrary() }
  const closeLibrary = () => leave('tmcLibrary')
  const openSettings = () => { enter('/settings', { tmcSettings: true }); showSettings() }
  const closeSettings = () => leave('tmcSettings')
  useEffect(() => {
    const navigate = () => {
      const library = location.pathname === '/library', settings = location.pathname === '/settings'
      // Only an overlay that actually closes restores focus and scroll; in-space history moves do not.
      if (library !== libraryOpenRef.current) (library ? showLibrary : hideLibrary)()
      if (settings !== settingsOpenRef.current) (settings ? showSettings : hideSettings)()
    }
    window.addEventListener('popstate', navigate)
    return () => window.removeEventListener('popstate', navigate)
  }, [])
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: uiMotion.content, ease: uiMotion.ease }}>
      <TooltipProvider delay={300}>
        <SettingsNavigation value={openSettings}>
        <LibraryNavigation value={openLibrary}>
          <div className="min-h-dvh" style={uiMotionVariables}>
            <div inert={settingsOpen || libraryOpen} aria-hidden={settingsOpen || libraryOpen}>
              <Activity mode={libraryOpen ? 'hidden' : 'visible'}>
                {/* Settings hide the surface without destroying editor/terminal Effects. */}
                <div className="app-layout" style={{ display: settingsCovered && settingsOpen ? 'none' : undefined }}>
                  {current ? <LessonDrawerProvider key={current.id}><SpaceBody /></LessonDrawerProvider> : <SpaceList />}
                  {(persistence.error || persistence.busy || !persistence.ready) && (
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
