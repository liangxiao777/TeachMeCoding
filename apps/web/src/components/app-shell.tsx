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
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useApp } from '@/app/context'

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
  const { current, persistence, capabilities } = useApp()
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider delay={300}>
        <div className="app-layout">
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
          <footer className="flex h-6 items-center border-t bg-muted px-3 text-[10px] text-muted-foreground">
            {persistence ? (
              <span data-testid="workspace-notice">真实工作区 · {capabilities.agent ? '教学 Agent 已接入' : 'Agent 暂不可用'} · {capabilities.terminal ? '本机执行 · 非沙箱' : '终端暂不可用'}</span>
            ) : (
              <a href="/diagnostics" data-testid="fixture-notice">开发夹具 · 内存数据 · 模拟回复与执行</a>
            )}
          </footer>
        </div>
      </TooltipProvider>
    </MotionConfig>
  )
}
