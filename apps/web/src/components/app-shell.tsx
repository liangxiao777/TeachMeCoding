'use client'

import { motion, MotionConfig, useReducedMotion } from 'motion/react'
import { AgentPanel } from '@/components/agent/agent-panel'
import { AssessmentView } from '@/components/assessment/assessment-view'
import { ResultView } from '@/components/assessment/result-view'
import { Onboarding } from '@/components/onboarding'
import { RouteView } from '@/components/route-view'
import { SpaceList } from '@/components/space-list'
import { TopBar } from '@/components/top-bar'
import { Workbench } from '@/components/workbench/workbench'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useApp } from '@/fixtures/store'

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
          transition={{ duration: reducedMotion || current.view !== 'route' ? 0 : 0.2, ease: 'easeInOut' }}
          className="flex min-h-0 shrink-0 overflow-hidden"
        >
          {current.agentOpen && <AgentPanel />}
        </motion.div>
      </div>
    </div>
  )
}

export function AppShell() {
  const { current } = useApp()
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delay={300}>
        <div className="fixture-preview">
          {current ? <SpaceBody key={current.id} /> : <SpaceList />}
          <footer className="flex h-6 items-center border-t bg-muted px-3 text-[10px] text-muted-foreground">
            <a href="/diagnostics" data-testid="fixture-notice">开发夹具 · 内存数据 · 模拟回复与执行</a>
          </footer>
        </div>
      </TooltipProvider>
    </MotionConfig>
  )
}
