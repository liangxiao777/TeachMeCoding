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
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { LessonReader } from '@/components/workbench/lesson-reader'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Brand } from '@/components/shared'
import { SettingsButton } from '@/components/settings/settings-page'
import { LibraryButton } from '@/components/library-page'
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
import { pendingDecision } from '@/app/lesson-proposals'
import { useApp, useSpace } from '@/app/context'
import { useLessonDrawer } from '@/app/lesson-drawer'
import { ThemeToggle } from '@/app/theme'
import { cn } from '@/lib/utils'

function SpaceSwitcher() {
  const { t } = useTranslation('learning')
  const { state, openSpace, goHome, goSpaces } = useApp()
  const space = useSpace()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="font-semibold" />}>
        {space.name}
        <ChevronsUpDown data-icon="inline-end" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('topBar.switchSpace')}</DropdownMenuLabel>
          {state.spaces.map((s) => {
            const u = findUnit(s, s.currentUnitId)
            return (
              <DropdownMenuItem key={s.id} onClick={() => openSpace(s.id)} className="items-start gap-2 py-2">
                <Check className={cn('mt-0.5', s.id === space.id ? 'opacity-100' : 'opacity-0')} aria-hidden />
                <span className="flex flex-col">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {u ? t('topBar.studying', { title: u.title }) : s.view === 'onboarding' || s.view === 'planning' ? t('topBar.confirming') : t('topBar.noUnit')}
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
            {t('topBar.viewSpaces')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={goHome}>
            <Plus />
            {t('topBar.createSpace')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TopBar() {
  const { t } = useTranslation('learning')
  const space = useSpace()
  const { goHome, setView, enterUnit, toggleAgent, toggleIde, startAssessment, toggleExplorer, capabilities, assessment, persistence } = useApp()
  const { open: lessonOpen, setOpen: setLessonOpen } = useLessonDrawer()
  const unit = findUnit(space, space.currentUnitId)
  const proposal = persistence.lessonProposals.findLast((proposal) => proposal.state === 'pending' && proposal.unitId === unit?.id)
  const awaitingDecision = !!pendingDecision(persistence)
  const onRoute = space.view === 'route'
  const hasDraft = space.draft && space.draft.unitId === unit?.id
  const canAssess = capabilities.assessment || !!(unit && assessment(unit))

  useEffect(() => {
    const review = (event: Event) => {
      if (space.ideFullscreen && (event as CustomEvent<{ space: string }>).detail.space === space.id) setLessonOpen(true)
    }
    window.addEventListener('lesson-proposal-review', review)
    return () => window.removeEventListener('lesson-proposal-review', review)
  }, [space.id, space.ideFullscreen, setLessonOpen])

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
  }, [space.ideFullscreen, lessonOpen, toggleIde, setLessonOpen])

  if (space.ideFullscreen && space.view === 'unit')
    return (
      <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-sidebar px-3 text-sm">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('topBar.toggleExplorer')}
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
          <LibraryButton />
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={() => setLessonOpen(true)}>
            <BookOpen data-icon="inline-start" />
            {proposal ? t('topBar.viewChanges') : t('topBar.viewLesson')}
          </Button>
          <Toggle pressed={space.agentOpen} disabled={awaitingDecision} onPressedChange={() => toggleAgent()} aria-label="Agent">
            <MessageSquare />
            Agent
          </Toggle>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <Button variant="outline" size="sm" onClick={() => toggleIde(false)}>
            <ArrowLeft data-icon="inline-start" />
            {t('topBar.backToStudy')}
          </Button>
        </div>
        <Sheet modal={!proposal} open={lessonOpen} onOpenChange={setLessonOpen}>
          <SheetContent
            side="left"
            showOverlay={!proposal}
            className="dark w-[720px]! max-w-[80vw]! gap-0 bg-background text-foreground"
            aria-describedby={proposal ? undefined : 'ide-lesson-description'}
          >
            <SheetHeader className="border-b">
              <SheetTitle>{proposal ? t('topBar.lessonPreview') : t('topBar.currentLesson')}</SheetTitle>
              {!proposal && <SheetDescription id="ide-lesson-description">{t('topBar.drawerHint')}</SheetDescription>}
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

      <Breadcrumb aria-label={t('topBar.navigation')}>
        <BreadcrumbList>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {onRoute ? (
              <BreadcrumbPage>{t('controls.learningPath')}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<button type="button" onClick={() => setView('route')} />}>
                {t('controls.learningPath')}
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
                  {space.view === 'assessment' ? t('topBar.assessment') : t('topBar.results')}
                  {space.view === 'assessment' && (
                    <Badge variant="secondary" className="bg-accent text-accent-foreground">
                      {t('topBar.inProgress')}
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
              aria-label={t('topBar.toggleExplorer')}
              title={t('topBar.explorerHint')}
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
                    aria-label={t('topBar.ide')}
                    className="px-2.5"
                  />
                }
              >
                <Code2 />
                IDE
              </TooltipTrigger>
              <TooltipContent>{capabilities.terminal ? t('topBar.ideHint') : t('topBar.ideUnavailableHint')}</TooltipContent>
            </Tooltip>
            <Button onClick={startAssessment} disabled={!canAssess || persistence.busy || awaitingDecision} className="ml-1.5">
              <ClipboardCheck data-icon="inline-start" />
              {!canAssess ? t('topBar.assessmentUnavailable') : hasDraft ? t('topBar.continueAssessment') : t('topBar.startAssessment')}
            </Button>
          </>
        )}
        <Separator orientation="vertical" className="mx-1.5 h-5" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                pressed={space.agentOpen}
                disabled={awaitingDecision}
                onPressedChange={() => toggleAgent()}
                aria-label="Agent"
                className="px-2.5"
              />
            }
          >
            <MessageSquare />
            Agent
          </TooltipTrigger>
          <TooltipContent>{capabilities.agent ? t('topBar.agentHint') : t('topBar.agentUnavailableHint')}</TooltipContent>
        </Tooltip>
        <LibraryButton iconOnly />
        <SettingsButton iconOnly />
      </div>
    </header>
  )
}
