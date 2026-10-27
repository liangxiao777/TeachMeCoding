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
import { useEscape } from '@/app/escape'
import { useLessonDrawer } from '@/app/lesson-drawer'
import { ThemeToggle } from '@/app/theme'
import { cn } from '@/lib/utils'

/** The one way up a level, always at the far left of a space header. */
export function BackButton() {
  const { t } = useTranslation(['learning', 'assessment'])
  const space = useSpace()
  const { goSpaces, setView, leaveAssessment, backToStudy } = useApp()
  const [label, back] =
    space.view === 'unit' ? [t('topBar.backToPath'), () => setView('route')]
      : space.view === 'assessment' ? [t('assessment:controls.backWithAnswers'), leaveAssessment]
        : space.view === 'result' ? [t('assessment:result.backToUnit'), backToStudy]
          : [t('topBar.backToSpaces'), goSpaces]
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={back} />}>
        <ArrowLeft />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

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
          <DropdownMenuItem onClick={goSpaces}>
            <LayoutGrid />
            {t('controls.allSpaces')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
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
          <DropdownMenuItem onClick={goHome}>
            <Plus />
            {t('topBar.createSpace')}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Ancestor levels read as buttons, not as muted labels.
const crumbLink = '-mx-1.5 rounded-md px-1.5 py-1 text-foreground/70 hover:bg-muted hover:text-foreground'

function SpaceBreadcrumb() {
  const { t } = useTranslation('learning')
  const space = useSpace()
  const { setView, enterUnit } = useApp()
  const unit = findUnit(space, space.currentUnitId)
  const onRoute = space.view === 'route'
  return (
    <Breadcrumb aria-label={t('topBar.navigation')} className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          {onRoute ? (
            <BreadcrumbPage>{t('controls.learningPath')}</BreadcrumbPage>
          ) : (
            <BreadcrumbLink className={crumbLink} render={<button type="button" onClick={() => setView('route')} />}>
              {t('controls.learningPath')}
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        {unit && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              {space.view === 'unit' ? (
                <BreadcrumbPage className="truncate">{unit.title}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink
                  className={cn(crumbLink, 'truncate')}
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
              <BreadcrumbPage className="flex items-center gap-2 whitespace-nowrap">
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
  )
}

export function TopBar() {
  const { t } = useTranslation('learning')
  const space = useSpace()
  const { toggleAgent, toggleIde, setIdeFullscreen, startAssessment, toggleExplorer, capabilities, assessment, persistence } = useApp()
  const { open: lessonOpen, setOpen: setLessonOpen } = useLessonDrawer()
  const unit = findUnit(space, space.currentUnitId)
  const proposal = persistence.lessonProposals.findLast((proposal) => proposal.state === 'pending' && proposal.unitId === unit?.id)
  const awaitingDecision = !!pendingDecision(persistence)
  const hasDraft = space.draft && space.draft.unitId === unit?.id
  const canAssess = capabilities.assessment || !!(unit && assessment(unit))
  const fullscreen = space.ideFullscreen && space.view === 'unit'

  useEffect(() => {
    const review = (event: Event) => {
      if (space.ideFullscreen && (event as CustomEvent<{ space: string }>).detail.space === space.id) setLessonOpen(true)
    }
    window.addEventListener('lesson-proposal-review', review)
    return () => window.removeEventListener('lesson-proposal-review', review)
  }, [space.id, space.ideFullscreen, setLessonOpen])

  useEffect(() => {
    if (!space.ideFullscreen) setLessonOpen(false)
  }, [space.ideFullscreen, setLessonOpen])
  // Esc leaves fullscreen back to the split IDE it came from.
  useEscape(() => setIdeFullscreen(false), { enabled: space.ideFullscreen && !lessonOpen })

  const explorerToggle = (
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
  )
  const agentToggle = (
    <Toggle pressed={space.agentOpen} disabled={awaitingDecision} onPressedChange={() => toggleAgent()} aria-label="Agent" className="px-2.5" />
  )

  return (
    <header
      className={cn(
        'flex shrink-0 items-center gap-3 border-b',
        fullscreen ? 'h-12 bg-sidebar px-3 text-sm' : 'h-14 bg-background/80 px-4 backdrop-blur',
      )}
    >
      <BackButton />
      <Separator orientation="vertical" className="h-5" />
      <SpaceSwitcher />
      <SpaceBreadcrumb />

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <ThemeToggle />
        {space.view === 'unit' && explorerToggle}
        {fullscreen ? (
          <Button variant="ghost" size="sm" onClick={() => setLessonOpen(true)}>
            <BookOpen data-icon="inline-start" />
            {proposal ? t('topBar.viewChanges') : t('topBar.viewLesson')}
          </Button>
        ) : space.view === 'unit' && (
          <>
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
          <TooltipTrigger render={agentToggle}>
            <MessageSquare />
            Agent
          </TooltipTrigger>
          <TooltipContent>{capabilities.agent ? t('topBar.agentHint') : t('topBar.agentUnavailableHint')}</TooltipContent>
        </Tooltip>
        <LibraryButton iconOnly />
        <SettingsButton iconOnly />
      </div>
      {fullscreen && (
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
      )}
    </header>
  )
}
