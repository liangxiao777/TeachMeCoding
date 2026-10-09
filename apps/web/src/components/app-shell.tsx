'use client'

import { Activity, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react'
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { useApp } from '@/app/context'
import { uiMotion, uiMotionVariables } from '@/lib/motion'

function SpaceBody() {
  const { current } = useApp()
  const reducedMotion = useReducedMotion()
  if (!current) return null
  if (current.view === 'onboarding' || current.view === 'planning') return <Onboarding />

  return (
    <div className={`flex h-dvh min-w-[1100px] flex-col ${current.ideFullscreen && current.view === 'unit' ? 'dark bg-background text-foreground' : ''}`}>
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">
          {current.view === 'route' && <RouteView />}
          {current.view === 'unit' && <Workbench />}
          {current.view === 'assessment' && <AssessmentView />}
          {current.view === 'result' && <ResultView />}
        </main>
        <motion.div
          initial={false}
          animate={{ width: current.agentOpen ? '24rem' : '0rem' }}
          transition={{ duration: reducedMotion || current.view !== 'route' ? 0 : uiMotion.panel }}
          className="flex min-h-0 shrink-0 overflow-hidden"
        >
          <AnimatePresence initial={false}>
            {current.agentOpen && <AgentPanel />}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  )
}

export function AppShell() {
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
              <Activity mode={libraryOpen || settingsCovered && settingsOpen ? 'hidden' : 'visible'}>
                <div className="app-layout" data-fixture={!persistence || undefined}>
                  {current ? <SpaceBody key={current.id} /> : <SpaceList />}
                  {persistence && (persistence.error || persistence.busy || !persistence.ready) && (
                    <div className="fixed inset-x-3 bottom-8 z-50 mx-auto max-w-xl rounded-lg border bg-background p-3 shadow-sm">
                      {persistence.error ? (
                        <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
                          <span className="flex-1">{persistence.error}</span>
                          <Button variant="outline" size="sm" disabled={persistence.busy} onClick={persistence.retry}>重试</Button>
                        </div>
                      ) : (
                        <p role="status" className="text-xs text-muted-foreground">正在读取或保存…</p>
                      )}
                    </div>
                  )}
                  {!persistence && (
                    <footer className="flex h-6 items-center border-t bg-muted px-3 text-[10px] text-muted-foreground">
                      <a href="/diagnostics" data-testid="fixture-notice">开发夹具 · 内存数据 · 模拟回复与执行</a>
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
