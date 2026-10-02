'use client'

import { useLayoutEffect, useRef } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { IdePanel } from '@/components/workbench/ide-panel'
import { LeftRail } from '@/components/workbench/left-rail'
import { LessonReader } from '@/components/workbench/lesson-reader'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useSpace } from '@/fixtures/store'

export function Workbench() {
  const space = useSpace()
  const ide = usePanelRef()
  const explorer = usePanelRef()
  const normalHeight = useRef(40)
  const explorerWidth = useRef(240)
  useLayoutEffect(() => {
    // Apply the remembered size after the panels have registered their new constraints.
    const frame = requestAnimationFrame(() =>
      ide.current?.resize(`${!space.ideOpen ? 0 : space.ideFullscreen ? 100 : normalHeight.current}%`),
    )
    return () => cancelAnimationFrame(frame)
  }, [space.ideFullscreen, space.ideOpen, ide])
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() =>
      explorer.current?.resize(`${space.explorerOpen ? explorerWidth.current : 0}px`),
    )
    return () => cancelAnimationFrame(frame)
  }, [space.explorerOpen, explorer])
  return (
    <div className="flex min-h-0 flex-1">
      <ResizablePanelGroup
        orientation="horizontal"
        onLayoutChanged={(_, meta) => {
          if (meta.isUserInteraction && space.explorerOpen)
            explorerWidth.current = explorer.current?.getSize().inPixels ?? 240
        }}
      >
        <ResizablePanel
          id="explorer"
          panelRef={explorer}
          defaultSize="240px"
          minSize={space.explorerOpen ? '200px' : 0}
          maxSize={space.explorerOpen ? '35%' : 0}
        >
          <div className="h-full" inert={!space.explorerOpen} aria-hidden={!space.explorerOpen}>
            <LeftRail />
          </div>
        </ResizablePanel>
        <ResizableHandle
          aria-label="调整文件目录宽度"
          disabled={!space.explorerOpen}
          className={!space.explorerOpen ? 'hidden' : ''}
        />
        <ResizablePanel id="workspace" minSize="400px" className="flex min-w-0 flex-1 flex-col">
          <ResizablePanelGroup
            orientation="vertical"
            onLayoutChanged={(layout, meta) => {
              if (meta.isUserInteraction && !space.ideFullscreen && space.ideOpen) normalHeight.current = layout.ide!
            }}
          >
            <ResizablePanel
              id="lesson"
              className="flex flex-col"
              minSize={space.ideFullscreen ? 0 : '40%'}
              maxSize={space.ideFullscreen ? 0 : '100%'}
              inert={space.ideFullscreen}
              aria-hidden={space.ideFullscreen}
            >
              <LessonReader key={space.currentUnitId} />
            </ResizablePanel>
            <ResizableHandle
              aria-label="调整 IDE 高度"
              disabled={space.ideFullscreen || !space.ideOpen}
              className={
                space.ideFullscreen || !space.ideOpen
                  ? 'hidden'
                  : 'z-10 h-0! shrink-0 before:absolute before:top-1 before:h-0.5 before:w-10 before:rounded-full before:bg-ide-foreground/40 after:top-0 after:h-2 after:translate-y-0! hover:before:bg-primary focus-visible:before:bg-primary'
              }
            />
            <ResizablePanel
              id="ide"
              panelRef={ide}
              defaultSize="40%"
              minSize={space.ideOpen ? '20%' : 0}
              maxSize={!space.ideOpen ? 0 : space.ideFullscreen ? '100%' : '50vh'}
              inert={!space.ideOpen}
              aria-hidden={!space.ideOpen}
            >
              <IdePanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
