'use client'

import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronsUpDown,
  ClipboardCheck,
  Code2,
  LayoutGrid,
  MessageSquare,
  PanelLeft,
  Plus,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { LessonReader } from '@/components/workbench/lesson-reader'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Brand } from '@/components/shared'
import { SettingsButton } from '@/components/settings/settings-page'
import { Badge } from '@/components/ui/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { findUnit } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'
import { ThemeToggle } from '@/app/theme'
import { cn } from '@/lib/utils'

function SpaceSwitcher() {
  const { state, openSpace, goHome, goSpaces, persistence } = useApp()
  const space = useSpace()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="font-semibold" />}>
        {space.name}
        <ChevronsUpDown data-icon="inline-end" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>切换学习空间</DropdownMenuLabel>
          {state.spaces.map((s) => {
            const u = findUnit(s, s.currentUnitId)
            return (
              <DropdownMenuItem key={s.id} onClick={() => openSpace(s.id)} className="items-start gap-2 py-2">
                <Check className={cn('mt-0.5', s.id === space.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
                <span className="flex flex-col">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {u ? `正在学习「${u.title}」` : !persistence || s.view === 'onboarding' || s.view === 'planning' ? '确认学习需求中' : '尚无学习单元'}
                  </span>
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={goSpaces}>
            <LayoutGrid />
            查看全部学习空间
          </DropdownMenuItem>
          <DropdownMenuItem onClick={goHome}>
            <Plus />
            创建学习空间
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TopBar() {
  const space = useSpace()
  const { goHome, setView, enterUnit, toggleAgent, toggleIde, startAssessment, toggleExplorer, capabilities, assessment, persistence } = useApp()
  const [lessonOpen, setLessonOpen] = useState(false)
  const unit = findUnit(space, space.currentUnitId)
  const onRoute = space.view === 'route'
  const hasDraft = space.draft && space.draft.unitId === unit?.id
  const canAssess = capabilities.assessment || !!(unit && assessment(unit))

  useEffect(() => {
    if (!space.ideFullscreen) {
      setLessonOpen(false)
      return
    }
    function escape(e: KeyboardEvent) {
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        lessonOpen ||
        document.querySelector('[role="menu"], [role="dialog"]')
      )
        return
      e.preventDefault()
      toggleIde(false)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [space.ideFullscreen, lessonOpen, toggleIde])

  if (space.ideFullscreen && space.view === 'unit')
    return (
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-sidebar px-3 text-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="切换文件目录"
          aria-pressed={space.explorerOpen}
          onClick={toggleExplorer}
        >
          <PanelLeft />
        </Button>
        <Code2 className="size-4 text-primary" aria-hidden />
        <span className="font-medium">{space.name}</span>
        <span className="text-muted-foreground">/</span>
        <span className="truncate text-xs text-muted-foreground">{unit?.title}</span>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={() => setLessonOpen(true)}>
            <BookOpen data-icon="inline-start" />
            查看课件
          </Button>
          <Toggle pressed={space.agentOpen} onPressedChange={() => toggleAgent()} aria-label="Agent">
            <MessageSquare />
            Agent
          </Toggle>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <Button variant="outline" size="sm" onClick={() => toggleIde(false)}>
            <ArrowLeft data-icon="inline-start" />
            返回学习
          </Button>
        </div>
        <Sheet open={lessonOpen} onOpenChange={setLessonOpen}>
          <SheetContent
            side="left"
            className="dark w-[720px]! max-w-[80vw]! gap-0 bg-background text-foreground"
            aria-describedby="ide-lesson-description"
          >
            <SheetHeader className="border-b">
              <SheetTitle>当前课件</SheetTitle>
              <SheetDescription id="ide-lesson-description">查阅后关闭，继续编写代码。</SheetDescription>
            </SheetHeader>
            <LessonReader inDrawer onAsk={() => setLessonOpen(false)} />
          </SheetContent>
        </Sheet>
      </header>
    )

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur">
      <Brand onClick={goHome} />
      <Separator orientation="vertical" className="h-5" />
      <SpaceSwitcher />

      <Breadcrumb aria-label="空间导航">
        <BreadcrumbList>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {onRoute ? (
              <BreadcrumbPage>学习路线</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<button type="button" onClick={() => setView('route')} />}>
                学习路线
              </BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {unit && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {space.view === 'unit' ? (
                  <BreadcrumbPage>{unit.title}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    render={<button type="button" onClick={() => (onRoute ? enterUnit(unit.id) : setView('unit'))} />}
                  >
                    {unit.title}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </>
          )}
          {(space.view === 'assessment' || space.view === 'result') && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="flex items-center gap-2">
                  {space.view === 'assessment' ? '单元测评' : '测评结果'}
                  {space.view === 'assessment' && (
                    <Badge variant="secondary" className="bg-accent text-accent-foreground">
                      进行中
                    </Badge>
                  )}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-1.5">
        <ThemeToggle />
        {space.view === 'unit' && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="切换文件目录"
              title="显示或收起文件目录"
              aria-pressed={space.explorerOpen}
              onClick={toggleExplorer}
            >
              <PanelLeft />
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    pressed={space.ideOpen}
                    onPressedChange={() => toggleIde()}
                    aria-label="IDE 与终端"
                    className="px-2.5"
                  />
                }
              >
                <Code2 />
                IDE
              </TooltipTrigger>
              <TooltipContent>{capabilities.terminal ? '显示或收起 IDE 与终端' : '显示或收起 IDE · 终端暂不可用'}</TooltipContent>
            </Tooltip>
            <Button onClick={startAssessment} disabled={!canAssess || persistence?.busy} className="ml-1.5">
              <ClipboardCheck data-icon="inline-start" />
              {!canAssess ? '测评暂不可用' : hasDraft ? '继续测评' : '开始单元测评'}
            </Button>
          </>
        )}
        <Separator orientation="vertical" className="mx-1.5 h-5" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                pressed={space.agentOpen}
                onPressedChange={() => toggleAgent()}
                aria-label="Agent"
                className="px-2.5"
              />
            }
          >
            <MessageSquare />
            Agent
          </TooltipTrigger>
          <TooltipContent>{capabilities.agent ? '显示或收起 Agent 面板' : '显示或收起会话面板 · Agent 暂不可用，仅保存问题'}</TooltipContent>
        </Tooltip>
        <SettingsButton iconOnly />
      </div>
    </header>
  )
}
