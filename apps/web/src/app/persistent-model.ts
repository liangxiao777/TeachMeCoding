import { useEffect, useRef, useState } from 'react'
import { applyAgentEvent, type AgentDisplayPart } from '@teach-me-coding/contracts'
import type { ActionProposal, AgentRun, AssessmentDraft as SavedAssessmentDraft, CodeExecution, LearningConclusion, LessonProposalApplication, ProjectEntry, ProjectFile, ProposalRejection, QuestionAnswer, QuestionRound, RequirementState, ResearchDossier, ResearchRef, ResearchSaveResult, RunEvent, RunEvents, RunSubmission, SessionDetail, SpaceSummary, UnitDetail, WorkStatus, Workspace } from '@teach-me-coding/contracts'
import { access, api, streamRun, ApiError } from '@/lib/api'
import type { AppModel, RequirementDraft } from './context'
import { activeSession, availableUnitIds, canAccessView, fileLanguage, needsLearning, nextUnit, sessionScope, sessionUnitId } from './selectors'
import { assessmentNeedsRefresh, lessonProposalStale, lessonView, mergeProposals, mergeUnitDetail, pendingDecision } from './lesson-proposals'
import { useUnsavedWarning } from './request-state'
import type { AssessmentDraft, Session, Space, SpaceView } from './types'
import { LocalTerminal } from '@/lib/terminal'

interface StoredSpace {
  ui: Space
  saved: Workspace
  sessions: Record<string, SessionDetail>
  units: Record<string, UnitDetail>
  drafts: Record<string, AssessmentDraft>
  tree: ProjectEntry[]
  files: Record<string, ProjectFile>
  renamingPath: string | null
  requirementDraft: RequirementDraft | null
  planningError: string | null
  taskParts: Record<string, AgentDisplayPart[]>
  runContexts: NonNullable<AppModel['persistence']>['runContexts']
  actions: ActionProposal[]
  executions: CodeExecution[]
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const latestPlan = (saved: Workspace) => saved.runs.filter((work) => work.kind === 'roadmap').at(-1)
const answers = (d: { q1: string; q2: string }) => ({ q1: d.q1, q2: d.q2 })
type SessionEdit = Partial<Pick<Session, 'composerText' | 'composerQuote' | 'routeSuggestion'>>
const sessionKey = (space: Space) => sessionScope(space) === 'unit' ? `unit:${sessionUnitId(space)}` : sessionScope(space)
const uiSession = (s: SessionDetail): Session => ({ ...s, updatedAt: s.messages.at(-1)?.createdAt ?? 0,
  messages: s.messages.map((m) => ({ ...m, quote: m.quote ?? undefined })),
  // The saved revision still fences sends, but legacy unsent bodies do not hydrate the composer.
  composerText: '', composerQuote: null, routeSuggestion: '' })

// Question state is independent of the composer draft revision. Terminal rounds
// and their original answers must survive an older refresh or idempotent response.
function mergeQuestions(known: QuestionRound[] = [], fresh: QuestionRound[] = []) {
  const rounds = new Map(known.map((round) => [round.id, round]))
  for (const round of fresh) {
    const old = rounds.get(round.id)
    if (!old || old.state === 'pending' || old.state === 'superseded' && round.state === 'answered') rounds.set(round.id, round)
  }
  return [...rounds.values()]
}
function mergeSession(known: SessionDetail | undefined, fresh: SessionDetail, acceptQuestions = true): SessionDetail {
  if (!known) return { ...fresh, questions: acceptQuestions ? fresh.questions : [] }
  const messages = new Map(known.messages.map((message) => [message.id, message]))
  for (const message of fresh.messages) if ((message.sequence ?? 0) >= (messages.get(message.id)?.sequence ?? 0)) messages.set(message.id, message)
  return { ...fresh, draft: known.draft.revision > fresh.draft.revision ? known.draft : fresh.draft,
    messages: [...messages.values()], questions: acceptQuestions ? mergeQuestions(known.questions, fresh.questions) : known.questions }
}
const supersedeQuestions = (sessions: StoredSpace['sessions']) => Object.fromEntries(Object.entries(sessions).map(([id, session]) =>
  [id, { ...session, questions: session.questions?.map((round) => round.state === 'pending' ? { ...round, state: 'superseded' as const } : round) }]))
const requirementDirty = (s: StoredSpace) => !!s.requirementDraft && (!same(
  { ...s.requirementDraft, intake: undefined }, s.saved.requirement.value)
  || s.requirementDraft.intake !== undefined && !same(s.requirementDraft.intake, s.saved.requirement.intake ?? null))

function unitState(detail: UnitDetail, saved: Workspace, executions: CodeExecution[]) {
  const task = saved.tasks.findLast((t) => t.unitId === detail.id && t.kind === 'lesson')
  return { status: detail.status,
    // Regeneration never removes the applied reading surface, even on failure.
    contentState: detail.lesson ? 'ready' as const : task && ['pending', 'running'].includes(task.state) ? 'generating' as const
      : task && ['failed', 'interrupted'].includes(task.state) ? 'failed' as const : 'none' as const,
    hasLesson: !!detail.lesson, started: detail.started, historicalPass: detail.historicalPass, lessonRevision: detail.lesson?.revision,
    active: [...saved.tasks, ...saved.runs].some((work) => work.unitId === detail.id && ['pending', 'running'].includes(work.state))
      || executions.some((execution) => execution.unitId === detail.id && ['pending', 'running'].includes(execution.state)),
    lessonKey: detail.id, lastAdvice: detail.records.find((record) => record.valid !== false)?.concerns }
}
function unitRecords(units: Record<string, UnitDetail>, stages: Space['stages']) {
  const metadata = stages.flatMap((stage) => stage.units)
  return Object.values(units).flatMap((unit) => unit.records.map((record) => ({ ...record,
    unitTitle: metadata.find((m) => m.id === unit.id)?.title ?? '历史单元' }))).sort((a, b) => a.createdAt - b.createdAt || a.attempt - b.attempt)
}

function projectEntries(tree: ProjectEntry[], old: Space['files'] = []) {
  const entries = tree.map((e) => ({ id: e.path, name: e.path.split('/').at(-1)!, parentId: e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : null, kind: e.kind }))
  return {
    directories: entries.filter((e) => e.kind === 'directory'),
    files: entries.filter((e) => e.kind === 'file').map((e) => old.find((file) => file.id === e.id) ?? { ...e, content: '', language: fileLanguage(e.name) }),
  }
}

async function loadSpace(saved: Workspace): Promise<StoredSpace> {
  const metadata = saved.route.content?.stages.flatMap((stage) => stage.units) ?? []
  const completedTasks = [...new Map(saved.tasks.map((task) => [`${task.unitId}:${task.kind}`, task])).values()]
    .filter((task) => !['pending', 'running'].includes(task.state))
  const runContexts: StoredSpace['runContexts'] = {}
  const [sessions, units, tree, taskEntries, actionGroups, executionGroups] = await Promise.all([
    Promise.all(saved.sessions.map((s) => api<SessionDetail>(`/spaces/${saved.id}/sessions/${s.id}`))),
    Promise.all(metadata.map((unit) => api<UnitDetail>(`/spaces/${saved.id}/units/${unit.id}`))),
    api<ProjectEntry[]>(`/spaces/${saved.id}/project/tree`),
    Promise.all(completedTasks.map(async (task): Promise<[string, AgentDisplayPart[]]> => {
      let cursor = 0, parts: AgentDisplayPart[] = []
      while (true) {
        const page = await api<RunEvents>(`/spaces/${saved.id}/runs/${task.id}/events?after=${cursor}`).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return null // Pre-Agent task records have no event stream.
          throw error
        })
        if (!page?.events.length) break
        for (const event of page.events) {
          parts = applyAgentEvent(parts, event); cursor = event.seq
          if (event.data.type === 'context') runContexts[task.id] = { sequence: event.seq, context: event.data.context }
        }
      }
      return [task.id, parts]
    })),
    Promise.all(saved.sessions.map((s) => api<ActionProposal[]>(`/spaces/${saved.id}/sessions/${s.id}/actions`))),
    Promise.all(metadata.map((u) => api<CodeExecution[]>(`/spaces/${saved.id}/units/${u.id}/executions`))),
  ])
  const details = Object.fromEntries(units.map((unit) => [unit.id, unit]))
  for (const session of sessions) for (const message of session.messages) if (message.context)
    runContexts[message.id] = { sequence: message.sequence ?? 0, context: message.context }
  const records = units.flatMap((unit) => unit.records.map((record) => ({ ...record, unitTitle: metadata.find((m) => m.id === unit.id)!.title }))).sort((a, b) => a.createdAt - b.createdAt || a.attempt - b.attempt)
  const drafts = Object.fromEntries(units.map((unit) => {
    const task = saved.tasks.find((t) => t.unitId === unit.id && ['assessment', 'evaluation'].includes(t.kind) && ['pending', 'running'].includes(t.state))
    return [unit.id, { ...answers(unit.draft), unitId: unit.id, state: task?.kind === 'assessment' ? 'generating' as const : task?.kind === 'evaluation' ? 'evaluating' as const : 'ready' as const,
      q2Output: null, q2Running: false, attempt: unit.nextAttempt ?? Math.max(0, ...unit.records.map((record) => record.attempt)) + 1 }]
  }))
  const stages = saved.route.content?.stages.map((stage) => ({ ...stage, units: stage.units.map((unit) => {
    return { ...unit, ...unitState(details[unit.id]!, saved, executionGroups.flat()) }
  }) })) ?? []
  const selectedSessions: Record<string, string> = {}
  for (const session of sessions) {
    const key = session.scope === 'unit' ? `unit:${session.unitId}` : session.scope
    selectedSessions[key] ??= sessionStorage.getItem(`session:${saved.id}:${key}`) ?? session.id
  }
  return { saved, sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), units: details, tree, files: {}, renamingPath: null, drafts, requirementDraft: null, planningError: null, taskParts: Object.fromEntries(taskEntries), runContexts, actions: actionGroups.flat(), executions: executionGroups.flat(),
    ui: {
      id: saved.id, name: saved.name, kind: 'generic', topic: '', requirement: saved.requirement.value,
      onboarding: { messages: [], step: 0, agentTyping: false, summaryReady: true },
      routeNote: saved.route.content?.note ?? '', stages,
      currentUnitId: units.find((unit) => !unit.lesson)?.id ?? stages.flatMap((stage) => stage.units).find(needsLearning)?.id ?? units[0]?.id ?? null,
      // Older successful runs may have left an explicit proposal; keep it reachable.
      view: saved.route.content || latestPlan(saved)?.state === 'succeeded' ? 'route' : latestPlan(saved) ? 'planning' : 'onboarding', sessions: sessions.map(uiSession), activeSessionIds: selectedSessions,
      ...projectEntries(tree), expandedDirectoryIds: [], selectedEntryId: null, openFileIds: [], activeFileId: null,
      terminal: [], terminalDirectoryId: null, running: false, env: 'disconnected', envLabel: '终端尚未接入',
      ideOpen: false, ideFullscreen: false, explorerOpen: true, agentOpen: true, draft: null, records, viewingRecordId: null,
      completed: units.length > 0 && units.every((unit) => unit.status === 'passed' || unit.status === 'skipped'),
      lastActive: Math.max(saved.createdAt, ...sessions.flatMap((s) => s.messages.map((m) => m.createdAt)), ...records.map((r) => r.createdAt)),
    },
  }
}

/** Persistent operations for the existing component model. No rendering or demo runtime. */
export function usePersistentModel(): AppModel {
  const cache = useRef<Record<string, StoredSpace>>({})
  const [spaces, setSpaces] = useState<Space[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [globalView, setGlobalView] = useState<'home' | 'spaces'>('home')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [capabilities, setCapabilities] = useState({ agent: false, terminal: false, assessment: false })
  const refreshCapabilities = () => { void api<AppModel['capabilities']>('/capabilities').then(setCapabilities).catch(() => {}) }
  const subscriptions = useRef(new Map<string, AbortController>())
  const terminals = useRef(new Map<string, LocalTerminal>())
  const errorRef = useRef('')
  const retry = useRef<() => void>(() => {})
  const inFlight = useRef(new Map<string, Promise<unknown>>())
  const fileSaves = useRef(new Map<string, Promise<void>>())
  const fileSaveErrors = useRef(new Map<string, string>())
  // An unacknowledged write is still unsaved after undoing to the old baseline.
  const unsavedFiles = (s: StoredSpace) => s.ui.files.filter((f) => fileSaves.current.has(`${s.ui.id}:${f.id}`)
    || fileSaveErrors.current.has(`${s.ui.id}:${f.id}`) || s.files[f.id] && f.content !== s.files[f.id]!.content)
  const pendingEdits = useRef(new Map<string, SessionEdit>())
  const businessRefresh = useRef(new Map<string, number>())
  const invalidateBusiness = (space: string) => {
    const next = (businessRefresh.current.get(space) ?? 0) + 1
    businessRefresh.current.set(space, next)
    return next
  }
  const booted = useRef(false)
  const publish = () => setSpaces(Object.values(cache.current).map((entry) => entry.ui))
  const change = (id: string, update: (s: StoredSpace) => StoredSpace) => {
    cache.current = { ...cache.current, [id]: update(cache.current[id]!) }
    publish()
  }
  const changeUi = (id: string, update: (s: Space) => Space) => change(id, (s) => ({ ...s, ui: update(s.ui) }))
  const run = <T,>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
    const existing = inFlight.current.get(key)
    if (existing) return existing as Promise<T | undefined>
    retry.current = () => { void run(key, action) }
    setBusy(true); setError(''); errorRef.current = ''
    const promise = Promise.resolve().then(action).catch((cause: unknown) => {
      errorRef.current = cause instanceof Error ? cause.message : '请求失败，请重试。'
      setError(errorRef.current)
      retry.current = () => { void run(key, action) }
      return undefined
    }).finally(() => { inFlight.current.delete(key); setBusy(inFlight.current.size > 0) })
    inFlight.current.set(key, promise)
    return promise
  }
  const selected = currentId ? cache.current[currentId] : undefined
  const current = selected?.ui ?? null
  const session = current ? activeSession(current) : undefined
  if (current && capabilities.terminal && !terminals.current.has(current.id)) {
    const id = current.id
    terminals.current.set(id, new LocalTerminal(id, (connected) => changeUi(id, (s) => ({ ...s,
      env: connected ? 'connected' : 'lost', envLabel: '本机终端 · 非沙箱' })), () => flushFiles(id)))
  }
  const localTerminal = current ? terminals.current.get(current.id) : undefined
  const needsAssessment = (space: string, unit: string) => {
    const entry = cache.current[space]!
    return assessmentNeedsRefresh(entry.units[unit]!, entry.saved.requirement.revision)
  }

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void run('load', async () => {
      // Older running servers can still expose saved work while their watcher is paused.
      const supported = await api<AppModel['capabilities']>('/capabilities').catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return { agent: false, terminal: false, assessment: false }
        throw error
      })
      setCapabilities(supported)
      const summaries = await api<SpaceSummary[]>('/spaces')
      const entries = await Promise.all(summaries.map(async (s) => loadSpace(await api<Workspace>(`/spaces/${s.id}`))))
      cache.current = Object.fromEntries(entries.map((s) => [s.ui.id, s]))
      const params = new URLSearchParams(location.search)
      const id = params.get('space')
      if (id) {
        const entry = cache.current[id]
        if (!entry) throw new Error('学习空间不存在，请返回首页。')
        const tab = params.get('tab')
        const view = tab === 'requirement' ? 'onboarding' : entry.ui.view === 'planning' || tab === 'planning' ? entry.ui.view
          : ['route', 'unit', 'assessment', 'result'].includes(tab ?? '') ? tab as SpaceView : entry.ui.view
        const recordId = params.get('record')
        const unitId = (view === 'result' ? entry.ui.records.find((record) => record.id === recordId)?.unitId : null)
          ?? params.get('unit') ?? entry.ui.currentUnitId
        const blocked = !canAccessView(entry.ui, view, unitId)
        if (blocked) setError('单元尚未解锁或不在当前路线中，已返回学习路线。')
        entry.ui = { ...entry.ui, view: blocked ? 'route' : view, currentUnitId: blocked ? entry.ui.currentUnitId : unitId,
          draft: !blocked && view === 'assessment' && unitId ? entry.drafts[unitId] ?? null : null, viewingRecordId: blocked ? null : recordId }
        setCurrentId(id)
      }
      publish(); setReady(true)
      for (const entry of entries) for (const work of [...entry.saved.runs, ...entry.saved.tasks]) {
        if (['pending', 'running'].includes(work.state) || !entry.saved.route.content && work.id === latestPlan(entry.saved)?.id) watchRun(entry.saved.id, work)
      }
    })
  }, [])
  useEffect(() => () => {
    for (const subscription of subscriptions.current.values()) subscription.abort()
    subscriptions.current.clear()
    for (const terminal of terminals.current.values()) terminal.dispose()
    terminals.current.clear()
  }, [])
  useEffect(() => {
    if (!ready) return
    const updateLocation = () => {
      if (location.pathname === '/library') return
      const params = current ? new URLSearchParams({ space: current.id, tab: current.view === 'onboarding' ? 'requirement' : current.view }) : new URLSearchParams()
      if (current?.currentUnitId) params.set('unit', current.currentUnitId)
      if (current?.viewingRecordId) params.set('record', current.viewingRecordId)
      history.replaceState(null, '', params.size ? `/?${params}` : '/')
    }
    updateLocation()
    window.addEventListener('popstate', updateLocation)
    return () => window.removeEventListener('popstate', updateLocation)
  }, [ready, current?.id, current?.view, current?.currentUnitId, current?.viewingRecordId])

  const dirty = Object.values(cache.current).some((s) => s.ui.name !== s.saved.name || requirementDirty(s)
    || Object.values(s.drafts).some((draft) => !same(answers(draft), answers(s.units[draft.unitId]!.draft)))
    || unsavedFiles(s).length > 0)
  useUnsavedWarning(dirty)
  const navigate = (view: SpaceView, unitId = current?.currentUnitId ?? null) => {
    if (!current) return false
    if (!canAccessView(cache.current[current.id]!.ui, view, unitId)) {
      setError('单元尚未解锁，请先生成并保存全部前序课件。')
      return false
    }
    changeUi(current.id, (s) => ({ ...s, view, currentUnitId: unitId, draft: view === 'assessment' && unitId ? cache.current[s.id]!.drafts[unitId] ?? null : s.draft, ideFullscreen: false }))
    return true
  }
  const viewedUnitId = current ? sessionUnitId(current) : null
  useEffect(() => {
    if (ready && current && !canAccessView(current, current.view, viewedUnitId)) {
      setError('路线顺序已改变，当前单元尚未解锁，已返回学习路线。')
      changeUi(current.id, (s) => ({ ...s, view: 'route', draft: null, viewingRecordId: null, ideFullscreen: false }))
    }
  }, [ready, current?.id, current?.view, viewedUnitId, current?.stages])
  const editSession = (patch: SessionEdit) => {
    if (!current) return
    if (pendingDecision(cache.current[current.id]!.saved)) return
    if (sessionScope(current) === 'unit' && (!viewedUnitId || !availableUnitIds(current).has(viewedUnitId))) return
    const space = current.id, key = sessionKey(current)
    if (session) {
      changeUi(space, (s) => ({ ...s, sessions: s.sessions.map((x) => x.id === session.id ? { ...x, ...patch } : x) }))
      return
    }
    // A newly applied route may not have a unit session yet. Retain a quote on retry.
    const pendingKey = `${space}:${key}`
    pendingEdits.current.set(pendingKey, { ...pendingEdits.current.get(pendingKey), ...patch })
    void run(`new-session:${space}:${key}`, async () => {
      const saved = await api<SessionDetail>(`/spaces/${space}/sessions`, { scope: sessionScope(current), unitId: sessionUnitId(current), title: '新会话' })
      change(space, (s) => ({ ...s, sessions: { ...s.sessions, [saved.id]: saved }, ui: { ...s.ui, sessions: [...s.ui.sessions, { ...uiSession(saved), ...pendingEdits.current.get(pendingKey) }], activeSessionIds: { ...s.ui.activeSessionIds, [key]: saved.id } } }))
      pendingEdits.current.delete(pendingKey)
      sessionStorage.setItem(`session:${space}:${key}`, saved.id)
    })
  }
  useEffect(() => {
    if (ready && capabilities.agent && current && sessionScope(current) === 'unit' && !session) editSession({})
  }, [ready, capabilities.agent, current?.id, current?.view, current?.currentUnitId, session?.id])
  const refreshBusiness = async (space: string) => {
    const ticket = invalidateBusiness(space)
    const currentTicket = () => ticket === businessRefresh.current.get(space)
    let loaded: StoredSpace
    try {
      const saved = await api<Workspace>(`/spaces/${space}`)
      // Fence the route before dependent reads: an older snapshot may contain
      // units that the accepted proposal has already retired.
      if (!currentTicket() || saved.route.revision < cache.current[space]!.saved.route.revision
        || saved.requirement.revision < cache.current[space]!.saved.requirement.revision) return
      loaded = await loadSpace(saved)
    } catch (error) {
      // A decision can supersede a refresh while its child reads are in flight.
      // Their stale failures must not appear beside the successful decision.
      if (!currentTicket()) return
      throw error
    }
    if (!currentTicket()) return
    change(space, (s) => {
      const freshIntake = ticket === businessRefresh.current.get(space) && loaded.saved.requirement.revision >= s.saved.requirement.revision
      const freshRoute = ticket === businessRefresh.current.get(space) && loaded.saved.route.revision >= s.saved.route.revision
      const requirement = freshIntake ? loaded.saved.requirement : s.saved.requirement
      const readiness = freshIntake ? loaded.saved.readiness : s.saved.readiness
      const route = freshRoute ? loaded.saved.route : s.saved.route
      const unitIds = new Set(route.content?.stages.flatMap((stage) => stage.units.map((unit) => unit.id)))
      // A terminal refresh may return after a retry or decision. Neither work
      // states nor a finished proposal may move backwards to pending.
      const mergeWork = (known: WorkStatus[], fresh: WorkStatus[]) => {
        const work = new Map(fresh.map((work) => [work.id, work]))
        for (const old of known) {
          const next = work.get(old.id)
          if (!next || !['pending', 'running'].includes(old.state) || old.state === 'running' && next.state === 'pending') work.set(old.id, old)
        }
        return [...work.values()]
      }
      const runs = mergeWork(s.saved.runs, loaded.saved.runs), tasks = mergeWork(s.saved.tasks, loaded.saved.tasks)
      const proposals = mergeProposals(s.saved.proposals, loaded.saved.proposals)
      const lessonProposals = mergeProposals(s.saved.lessonProposals ?? [], loaded.saved.lessonProposals)
      const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([, session]) => !session.unitId || unitIds.has(session.unitId)))
      for (const [id, fresh] of Object.entries(loaded.sessions))
        if (!fresh.unitId || unitIds.has(fresh.unitId)) sessions[id] = mergeSession(sessions[id], fresh, freshIntake)
      const units = { ...(freshRoute ? loaded.units : s.units) }
      for (const [id, fresh] of Object.entries(units)) {
        units[id] = mergeUnitDetail(s.units[id], fresh)
      }
      const drafts = Object.fromEntries(Object.entries(freshRoute ? loaded.drafts : s.drafts).map(([id, fresh]) =>
        [id, { ...((s.units[id]?.lesson?.revision ?? 0) > (loaded.units[id]?.lesson?.revision ?? 0) ? s.drafts[id] ?? fresh : fresh),
          ...(s.drafts[id] ? answers(s.drafts[id]!) : {}) }]))
      const actions = loaded.actions.map((fresh) => {
        const known = s.actions.find((p) => p.id === fresh.id)
        return known && (!['pending', 'running'].includes(known.state) || known.state === 'running' && fresh.state === 'pending') ? known : fresh
      })
      const executions = loaded.executions.map((fresh) => {
        const known = s.executions.find((e) => e.id === fresh.id)
        return known && (!['pending', 'running'].includes(known.state) || known.state === 'running' && fresh.state === 'pending' || known.results.length > fresh.results.length) ? known : fresh
      })
      // A refresh started before a new execution must not erase its stop control.
      executions.push(...s.executions.filter((known) => !executions.some((e) => e.id === known.id)))
      executions.sort((a, b) => a.createdAt - b.createdAt)
      const runContexts = { ...s.runContexts }
      for (const [id, fresh] of Object.entries(loaded.runContexts))
        if (fresh.sequence >= (runContexts[id]?.sequence ?? 0)) runContexts[id] = fresh
      const uiSessions = Object.values(sessions).map((saved) => {
        const old = s.ui.sessions.find((session) => session.id === saved.id)
        const next = uiSession(saved)
        if (!old) return next
        const messages = new Map(old.messages.map((message) => [message.id, message]))
        for (const message of next.messages)
          if ((message.sequence ?? 0) >= (messages.get(message.id)?.sequence ?? 0)) messages.set(message.id, message)
        return { ...next, messages: [...messages.values()], composerText: old.composerText, composerQuote: old.composerQuote, routeSuggestion: old.routeSuggestion,
          updatedAt: Math.max(old.updatedAt, next.updatedAt) }
      })
      const currentUnitId = s.ui.currentUnitId && unitIds.has(s.ui.currentUnitId) ? s.ui.currentUnitId : loaded.ui.currentUnitId
      const saved = { ...s.saved, requirement, readiness, route, proposals, lessonProposals, runs, tasks }
      const stages = (freshRoute ? loaded.ui.stages : s.ui.stages).map((stage) => ({ ...stage,
        units: stage.units.map((unit) => ({ ...unit, ...unitState(units[unit.id]!, saved, executions) })) }))
      return { ...s, actions, executions, saved: { ...saved,
        sessions: Object.values(sessions), conclusions: freshRoute && freshIntake ? loaded.saved.conclusions : s.saved.conclusions }, units, drafts, taskParts: { ...loaded.taskParts, ...s.taskParts },
        runContexts,
        sessions, ui: { ...s.ui, draft: s.ui.draft ? drafts[s.ui.draft.unitId] ?? null : null,
          ...(freshRoute ? { completed: Object.values(units).every((unit) => unit.status === 'passed' || unit.status === 'skipped'), stages, routeNote: loaded.ui.routeNote, records: unitRecords(units, stages) } : {}),
          ...(s.ui.view === 'planning' && route.content ? { view: 'route', agentOpen: false } : {}),
          ...(pendingDecision(saved) ? { agentOpen: true } : {}),
          currentUnitId, requirement: requirement.value, sessions: uiSessions,
        },
      }
    })
    for (const work of [...cache.current[space]!.saved.runs, ...cache.current[space]!.saved.tasks])
      if (['pending', 'running'].includes(work.state)) watchRun(space, work)
  }
  useEffect(() => {
    if (!ready || !currentId) return
    const refresh = () => {
      if (document.visibilityState === 'visible') void refreshBusiness(currentId).catch((error: unknown) =>
        setError(error instanceof Error ? error.message : '无法刷新学习路线，请重试。'))
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [ready, currentId])
  const watchRun = (space: string, work: WorkStatus) => {
    if (subscriptions.current.has(work.id)) return
    const controller = new AbortController()
    subscriptions.current.set(work.id, controller)
    const saved = cache.current[space]?.ui.sessions.find((s) => s.id === work.sessionId)?.messages.find((m) => m.id === work.id)
    let cursor = saved?.sequence ?? 0, text = saved?.text ?? ''
    let terminal = !['pending', 'running'].includes(work.state) || !!saved?.status && ['done', 'error', 'stopped'].includes(saved.status)
    let parts: AgentDisplayPart[] = saved?.parts ?? []
    const receive = (event: RunEvent) => {
      if (terminal || event.runId !== work.id || event.seq <= cursor) return
      cursor = event.seq
      parts = applyAgentEvent(parts, event)
      if (event.data.type === 'context') {
        const context = event.data.context
        change(space, (s) => (s.runContexts[work.id]?.sequence ?? 0) >= event.seq ? s
          : { ...s, runContexts: { ...s.runContexts, [work.id]: { sequence: event.seq, context } } })
      }
      if (event.data.type === 'text') text += event.data.delta
      if (event.data.type === 'state') terminal = !['pending', 'running'].includes(event.data.state)
      const state = event.data.type === 'state' ? event.data.state : 'running'
      if (terminal && ['intake', 'roadmap'].includes(work.kind)) invalidateBusiness(space)
      if (work.sessionId) change(space, (s) => ({ ...s, saved: { ...s.saved, runs: s.saved.runs.map((r) => r.id === work.id ? { ...r, state } : r) },
        ...(work.id === latestPlan(s.saved)?.id ? {
          planningError: event.data.type === 'state' ? event.data.error : s.planningError,
        } : {}),
      }))
      if (!work.sessionId) {
        change(space, (s) => ({ ...s, taskParts: { ...s.taskParts, [work.id]: parts }, saved: { ...s.saved, tasks: s.saved.tasks.map((t) => t.id === work.id ? { ...t, state } : t) } }))
        if (event.data.type === 'state' && event.data.error) {
          setError(event.data.error)
          retry.current = () => retryTask(space, work.id)
        }
      }
      changeUi(space, (s) => ({ ...s, sessions: s.sessions.map((session) => session.id !== work.sessionId ? session : { ...session,
        messages: session.messages.map((m) => m.id !== work.id || event.seq < (m.sequence ?? 0) ? m : { ...m, text, parts, sequence: event.seq,
          error: event.data.type === 'state' ? event.data.error ?? undefined : m.error,
          status: state === 'succeeded' ? 'done' : state === 'failed' ? 'error' : state === 'interrupted' ? 'stopped' : text ? 'streaming' : 'thinking' }),
      }) }))
    }
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          try {
            if (!terminal) await streamRun(`/spaces/${space}/runs/${work.id}`, cursor, controller.signal, receive)
            if (controller.signal.aborted) return
            if (terminal) {
              refreshCapabilities()
              await refreshBusiness(space)
              if (work.kind === 'evaluation' || work.kind === 'roadmap') {
                const final = await api<AgentRun>(`/spaces/${space}/runs/${work.id}`)
                if (work.kind === 'roadmap') change(space, (s) => latestPlan(s.saved)?.id === work.id ? { ...s, planningError: final.error } : s)
                if (work.kind === 'evaluation' && final.state === 'succeeded' && final.resultId) changeUi(space, (s) => s.view === 'assessment' && s.currentUnitId === work.unitId
                  ? { ...s, view: 'result', viewingRecordId: final.resultId! } : s)
              }
              return
            }
            throw new Error('Disconnected before final event')
          } catch {
            if (controller.signal.aborted) return
            // A dead SSE connection must not hide a durable terminal state. Drain
            // every page before using the run state; a backlog can exceed 500 events.
            try {
              let page: RunEvents
              do {
                page = await api<RunEvents>(`/spaces/${space}/runs/${work.id}/events?after=${cursor}`)
                if (controller.signal.aborted) return
                page.events.forEach(receive)
              } while (!terminal && page.events.length === 500)
              terminal ||= !['pending', 'running'].includes(page.run.state)
            } catch { /* The next subscription/poll resumes from the same cursor. */ }
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        }
      } finally { subscriptions.current.delete(work.id) }
    })()
  }
  const acceptSession = (space: string, fresh: SessionDetail, work?: AgentRun, consumed?: { text: string; quote: Session['composerQuote'] }) => {
    const changesIntake = fresh.scope === 'intake' || work?.kind === 'roadmap'
    if (changesIntake) invalidateBusiness(space)
    change(space, (s) => {
      const saved = mergeSession(s.sessions[fresh.id], fresh)
      const knownRun = work && s.saved.runs.find((run) => run.id === work.id)
      const nextRun = knownRun && !['pending', 'running'].includes(knownRun.state) ? knownRun : work
      const runContexts = { ...s.runContexts }
      for (const message of fresh.messages) if (message.context && (message.sequence ?? 0) >= (runContexts[message.id]?.sequence ?? 0))
        runContexts[message.id] = { sequence: message.sequence ?? 0, context: message.context }
      const update = (old: Session) => {
        const next = uiSession(saved), messages = new Map(old.messages.map((message) => [message.id, message]))
        for (const message of next.messages) if ((message.sequence ?? 0) >= (messages.get(message.id)?.sequence ?? 0)) messages.set(message.id, message)
        return { ...old, messages: [...messages.values()], updatedAt: Math.max(old.updatedAt, next.updatedAt),
          composerText: consumed && old.composerText === consumed.text ? fresh.draft.text : old.composerText,
          composerQuote: consumed && same(old.composerQuote, consumed.quote) ? fresh.draft.quote : old.composerQuote }
      }
      return { ...s, sessions: { ...s.sessions, [saved.id]: saved }, runContexts,
        saved: { ...s.saved, ...(changesIntake ? { readiness: undefined } : {}),
          runs: nextRun ? [...s.saved.runs.filter((run) => run.id !== nextRun.id), nextRun] : s.saved.runs },
        ui: { ...s.ui, sessions: s.ui.sessions.some((old) => old.id === saved.id)
          ? s.ui.sessions.map((old) => old.id === saved.id ? update(old) : old) : [...s.ui.sessions, uiSession(saved)] } }
    })
  }
  const inputAllowed = (route = false) => {
    if (!selected) return false
    if (pendingDecision(cache.current[selected.saved.id]!.saved)) {
      setError('请先接受或拒绝当前路线或课件提案，再继续对话。'); return false
    }
    if (route && selected.saved.runs.some((work) => work.kind === 'roadmap' && ['pending', 'running'].includes(work.state))) {
      setError('正在生成路线调整，请等待完成或停止当前生成。'); return false
    }
    return true
  }
  const sendMessage = (text?: string): Promise<boolean> => {
    if (!current || !session || !inputAllowed(sessionScope(current) === 'route')) return Promise.resolve(false)
    const space = current.id, id = session.id, snapshot = { text: session.composerText, quote: session.composerQuote }
    const stored = cache.current[space]!.sessions[id]!
    const input = { text: text ?? snapshot.text, quote: text === undefined ? snapshot.quote : null, draftRevision: stored.draft.revision }
    if (!input.text.trim() && !input.quote) return Promise.resolve(false)
    let submission: RunSubmission | undefined, saved: SessionDetail | undefined, applied = false
    return run(`session:${id}`, async () => {
      if (!submission && !saved && pendingDecision(cache.current[space]!.saved)) throw new Error('请先接受或拒绝当前提案。')
      if (capabilities.agent) submission ??= await api<RunSubmission>(`/spaces/${space}/sessions/${id}/runs`, input)
      saved ??= submission?.session ?? await api<SessionDetail>(`/spaces/${space}/sessions/${id}/messages`, input)
      // Explicit messages and structured answers never consume the composer. A
      // normal send only clears the exact edit that was submitted, not new input.
      if (!applied) { acceptSession(space, saved, submission?.run, text === undefined ? snapshot : undefined); applied = true }
      if (submission) watchRun(space, submission.run)
      if (saved.scope === 'intake') await refreshBusiness(space)
      return true
    }).then(Boolean)
  }
  const answerQuestions = (round: string, input: QuestionAnswer): Promise<boolean> => {
    if (!current || !session || !capabilities.agent || !inputAllowed()) return Promise.resolve(false)
    const space = current.id, id = session.id
    const snapshot = structuredClone(input)
    let submission: RunSubmission | undefined, applied = false
    return run(`session:${id}`, async () => {
      if (!submission && pendingDecision(cache.current[space]!.saved)) throw new Error('请先接受或拒绝当前提案。')
      submission ??= await api<RunSubmission>(`/spaces/${space}/sessions/${id}/questions/${round}/answer`, snapshot)
      if (!applied) { acceptSession(space, submission.session, submission.run); applied = true }
      watchRun(space, submission.run)
      await refreshBusiness(space)
      return true
    }).then(Boolean)
  }
  const saveRequirement = (draft: RequirementDraft, confirmed: boolean) => {
    if (!current || !selected) return Promise.resolve(false)
    const id = current.id, revision = selected.saved.requirement.revision
    const { intake, ...value } = draft
    let saved: RequirementState | undefined, applied = false
    return run(`requirement:${id}`, async () => {
      saved ??= await api<RequirementState>(`/spaces/${id}/requirement`, { revision, value, confirmed, ...(intake !== undefined ? { intake } : {}) })
      const requirement = saved
      if (!applied) {
        invalidateBusiness(id)
        change(id, (s) => ({ ...s, sessions: supersedeQuestions(s.sessions),
          requirementDraft: same(s.requirementDraft, draft) ? null : s.requirementDraft,
          saved: { ...s.saved, requirement: requirement.revision >= s.saved.requirement.revision ? requirement : s.saved.requirement, readiness: undefined },
          ui: { ...s.ui, requirement: requirement.revision >= s.saved.requirement.revision ? requirement.value : s.ui.requirement } }))
        applied = true
      }
      await refreshBusiness(id)
      return true
    }).then(Boolean)
  }
  const saveResearch = async (ref: ResearchRef, content: string): Promise<ResearchDossier> => {
    if (!current) throw new Error('没有打开的学习空间')
    const id = current.id
    const result = await api<ResearchSaveResult>(`/spaces/${id}/research/${ref.id}/${ref.revision}`, { content })
    invalidateBusiness(id)
    change(id, (s) => result.workspace.requirement.revision <= s.saved.requirement.revision ? s : {
      ...s, sessions: supersedeQuestions(s.sessions),
      saved: { ...s.saved, requirement: result.workspace.requirement, readiness: result.workspace.readiness },
      ui: { ...s.ui, requirement: result.workspace.requirement.value },
    })
    return result.document
  }
  const exportResearch = async (space: string, ref: ResearchRef) => {
    const path = `/api/spaces/${space}/research/${ref.id}/${ref.revision}?format=markdown`
    const fetchMarkdown = async (refresh = false) => fetch(path, { headers: { 'X-TMC-Token': await access(refresh) } })
    let response = await fetchMarkdown()
    if (response.status === 401) response = await fetchMarkdown(true)
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string }
      throw new ApiError(response.status, result.error ?? '资料导出失败，请重试。')
    }
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = url; link.download = `research-${ref.id}-v${ref.revision}.md`
    document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const refreshFiles = async (id: string) => {
    const tree = await api<ProjectEntry[]>(`/spaces/${id}/project/tree`)
    const before = cache.current[id]!
    const loaded = await Promise.all(Object.values(before.files).filter((f) => tree.some((e) => e.path === f.path && e.kind === 'file'))
      .map(async (file) => ({ before: file, disk: await api<ProjectFile>(`/spaces/${id}/project/file?path=${encodeURIComponent(file.path)}`) })))
    change(id, (s) => {
      const entries = projectEntries(tree, s.ui.files), files = { ...s.files }, pending = new Set(unsavedFiles(s).map((f) => f.id))
      // A terminal can delete/rename a file. Never discard an unsaved buffer.
      entries.files.push(...s.ui.files.filter((f) => pending.has(f.id) && !entries.files.some((entry) => entry.id === f.id)))
      for (const { before, disk } of loaded) {
        const file = entries.files.find((f) => f.id === disk.path)
        if (file && !pending.has(disk.path) && files[disk.path]?.version === before.version && file.content === before.content) {
          entries.files = entries.files.map((f) => f.id === disk.path ? { ...f, content: disk.content } : f)
          files[disk.path] = disk
        }
      }
      return { ...s, tree, files, ui: { ...s.ui, ...entries } }
    })
  }
  const saveFile = (space: string, path: string): Promise<void> => {
    const key = `${space}:${path}`, pending = fileSaves.current.get(key)
    if (pending) return pending
    const failure = fileSaveErrors.current.get(key)
    if (failure === errorRef.current) { setError(''); errorRef.current = '' }
    fileSaveErrors.current.delete(key)
    // Start immediately, but allow only one write per file. Edits arriving during
    // a request are picked up from the live buffer after its response, not replayed.
    const promise = (async () => {
      // A failed response may hide a successful write. Re-read before deciding
      // that reverting to the cached baseline needs no further disk write.
      if (failure) {
        const disk = await api<ProjectFile>(`/spaces/${space}/project/file?path=${encodeURIComponent(path)}`)
        change(space, (s) => ({ ...s, files: { ...s.files, [path]: disk } }))
      }
      let conflicts = 0
      while (true) {
        const entry = cache.current[space]!, file = entry.ui.files.find((f) => f.id === path), baseline = entry.files[path]
        if (!file || !baseline || file.content === baseline.content) return
        try {
          const saved = await api<ProjectFile>(`/spaces/${space}/project/save`, { path, content: file.content, version: baseline.version })
          change(space, (s) => ({ ...s, files: { ...s.files, [path]: saved } }))
          conflicts = 0
        } catch (cause) {
          if (!(cause instanceof ApiError) || cause.status !== 409 || ++conflicts > 3) throw cause
          // Latest editor input wins over an external edit. Keep the buffer and
          // retry against a fresh disk version; retain the server's atomic writes.
          const disk = await api<ProjectFile>(`/spaces/${space}/project/file?path=${encodeURIComponent(path)}`)
          change(space, (s) => ({ ...s, files: { ...s.files, [path]: disk } }))
        }
      }
    })().catch((cause: unknown) => {
      const message = `自动保存 ${path} 失败：${cause instanceof Error ? cause.message : '请求失败，请重试。'}`
      fileSaveErrors.current.set(key, message)
      errorRef.current = message; setError(message)
      retry.current = () => { void saveFile(space, path).catch(() => {}) }
      throw cause
    }).finally(() => { fileSaves.current.delete(key); publish() })
    fileSaves.current.set(key, promise)
    return promise
  }
  const flushFiles = async (space: string) => {
    while (true) {
      const files = unsavedFiles(cache.current[space]!)
      if (!files.length) return
      await Promise.all(files.map((file) => saveFile(space, file.id)))
    }
  }
  useEffect(() => {
    const active = Object.values(cache.current).filter((s) => s.actions.some((p) => p.state === 'running') || s.executions.some((e) => ['pending', 'running'].includes(e.state)))
    if (!active.length) return
    const timer = setTimeout(() => {
      void Promise.all(active.map(async (s) => { await refreshBusiness(s.ui.id); await refreshFiles(s.ui.id) }))
        .catch((e: unknown) => { setError(e instanceof Error ? e.message : '无法读取操作结果，请刷新。'); publish() })
    }, 750)
    return () => clearTimeout(timer)
  }, [spaces])
  const readFile = async (space: string, path: string) => {
    const file = await api<ProjectFile>(`/spaces/${space}/project/file?path=${encodeURIComponent(path)}`)
    change(space, (s) => ({ ...s, files: { ...s.files, [path]: file }, ui: { ...s.ui, files: s.ui.files.map((f) => f.id === path ? { ...f, content: file.content } : f) } }))
  }
  const openFile = (path: string) => {
    if (!current) return
    const id = current.id
    void run(`file:${id}:${path}`, async () => {
      if (!cache.current[id]!.files[path]) await readFile(id, path)
      change(id, (s) => ({ ...s, ui: { ...s.ui, ideOpen: true, activeFileId: path, selectedEntryId: path,
        openFileIds: [...new Set([...s.ui.openFileIds, path])],
        expandedDirectoryIds: [...new Set([...s.ui.expandedDirectoryIds, ...path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))])],
      } }))
    })
  }
  const createEntry = async (name: string, kind: 'file' | 'directory', parent: string | null, content?: string) => {
    if (!current) return '没有打开的学习空间'
    const id = current.id, path = parent ? `${parent}/${name}` : name
    let created = false
    const result = await run(`create:${id}:${path}`, async () => {
      if (!created) { await api(`/spaces/${id}/project/create`, { path, kind }); created = true }
      await refreshFiles(id)
      if (kind === 'file') { await readFile(id, path); changeUi(id, (s) => ({ ...s, activeFileId: path, selectedEntryId: path, openFileIds: [...s.openFileIds, path], ideOpen: true })) }
      else changeUi(id, (s) => ({ ...s, selectedEntryId: path }))
      if (content !== undefined) {
        changeUi(id, (s) => ({ ...s, files: s.files.map((file) => file.id === path ? { ...file, content } : file), view: 'unit' }))
        void saveFile(id, path).catch(() => {})
      }
      if (parent) changeUi(id, (s) => ({ ...s, expandedDirectoryIds: [...new Set([...s.expandedDirectoryIds, parent])] }))
      return true
    })
    return result ? null : errorRef.current
  }
  const unavailable = () => { setError('该能力尚未接入，不会执行模拟操作。') }
  const generateLesson = (space: string, unit: string) => {
    const revision = cache.current[space]!.units[unit]?.lesson?.revision ?? 0
    void run(`lesson:${space}:${unit}`, async () => {
      if (pendingDecision(cache.current[space]!.saved)) throw new Error('请先接受或拒绝当前提案，再生成课件。')
      if (!availableUnitIds(cache.current[space]!.ui).has(unit)) throw new Error('单元尚未解锁，请先生成并保存全部前序课件。')
      const task = await api<AgentRun>(`/spaces/${space}/units/${unit}/tasks`, { kind: 'lesson', revision })
      change(space, (s) => ({ ...s, saved: { ...s.saved, tasks: [...s.saved.tasks.filter((t) => t.id !== task.id), task] },
        ui: { ...s.ui, stages: s.ui.stages.map((stage) => ({ ...stage, units: stage.units.map((u) => u.id === unit && !s.units[unit]?.lesson ? { ...u, contentState: 'generating' } : u) })) } }))
      watchRun(space, task)
    })
  }
  const assessmentTask = (space: string, unit: string, kind: 'assessment' | 'evaluation') => {
    const entry = cache.current[space]!, detail = entry.units[unit]!, draft = entry.drafts[unit]!
    const input = kind === 'assessment' ? { kind, revision: detail.assessment?.revision ?? 0 }
      : { kind, revision: detail.draft.revision, specRevision: detail.assessment?.revision, ...answers(draft), execute: detail.assessment?.q2Kind === 'code' && !!detail.assessment.execution }
    void run(`${kind}:${space}:${unit}`, async () => {
      if (pendingDecision(cache.current[space]!.saved)) throw new Error('请先接受或拒绝当前提案，再开始新的测评任务。')
      if (kind === 'evaluation' && needsAssessment(space, unit)) throw new Error('课件已更新，请先根据最新课件重新出题；原答案草稿会保留。')
      const task = await api<AgentRun>(`/spaces/${space}/units/${unit}/tasks`, input)
      change(space, (s) => ({ ...s, saved: { ...s.saved, tasks: [...s.saved.tasks.filter((t) => t.id !== task.id), task] } }))
      watchRun(space, task)
      await refreshBusiness(space)
    })
  }
  const retryTask = (space: string, id: string) => {
    void run(`task-retry:${id}`, async () => {
      if (pendingDecision(cache.current[space]!.saved)) throw new Error('请先接受或拒绝当前提案，再重试生成。')
      const unit = cache.current[space]!.saved.tasks.find((task) => task.id === id)?.unitId
      if (!unit || !availableUnitIds(cache.current[space]!.ui).has(unit)) throw new Error('单元尚未解锁，请先生成并保存全部前序课件。')
      const task = await api<AgentRun>(`/spaces/${space}/tasks/${id}/retry`, {})
      watchRun(space, task)
      await refreshBusiness(space)
    })
  }
  const enterUnit = (id: string) => {
    if (!navigate('unit', id) || !current) return
    const entry = cache.current[current.id]!
    if (capabilities.agent && !pendingDecision(entry.saved) && !entry.units[id]?.lesson && !entry.saved.tasks.some((task) => task.unitId === id && task.kind === 'lesson')) generateLesson(current.id, id)
  }
  const acceptDecision = (space: string, saved: Workspace) => {
    invalidateBusiness(space)
    change(space, (s) => ({ ...s, saved: { ...s.saved,
      route: saved.route.revision >= s.saved.route.revision ? saved.route : s.saved.route,
      proposals: mergeProposals(s.saved.proposals, saved.proposals),
      lessonProposals: mergeProposals(s.saved.lessonProposals ?? [], saved.lessonProposals) } }))
  }
  const acceptLesson = (space: string, receipt: LessonProposalApplication) => {
    acceptDecision(space, receipt.workspace)
    change(space, (s) => {
      const unit = mergeUnitDetail(s.units[receipt.unit.id], receipt.unit)
      const units = { ...s.units, [unit.id]: unit }
      const stages = s.ui.stages.map((stage) => ({ ...stage, units: stage.units.map((old) => old.id === unit.id
        ? { ...old, ...unitState(unit, s.saved, s.executions) } : old) }))
      const draft = { ...s.drafts[unit.id]!, attempt: unit.nextAttempt ?? Math.max(0, ...unit.records.map((record) => record.attempt)) + 1 }
      return { ...s, units, drafts: { ...s.drafts, [unit.id]: draft }, ui: { ...s.ui, stages, records: unitRecords(units, stages),
        completed: Object.values(units).every((detail) => detail.status === 'passed' || detail.status === 'skipped'),
        draft: s.ui.draft?.unitId === unit.id ? draft : s.ui.draft } }
    })
  }
  const recordUnit = current?.view === 'result' ? current.records.find((r) => r.id === current.viewingRecordId)?.unitId ?? current.currentUnitId : current?.currentUnitId
  const activeFile = current?.files.find((file) => file.id === current.activeFileId)
  const uiCurrent = current && { ...current, onboarding: { ...current.onboarding,
    agentTyping: !!session?.messages.some((m) => m.status === 'thinking' || m.status === 'streaming'),
    messages: current.view === 'onboarding' ? session?.messages ?? [] : current.onboarding.messages } }

  return {
    state: { spaces, currentSpaceId: currentId, globalView }, current: uiCurrent, session,
    capabilities, localTerminal,
    refreshCapabilities,
    lesson: (unit) => {
      const lesson = selected?.units[unit.id]?.lesson
      if (!lesson) return null
      return lessonView(lesson)
    },
    assessment: (unit) => {
      const spec = selected?.units[unit.id]?.assessment
      return spec ? { revision: spec.revision, stale: current ? needsAssessment(current.id, unit.id) : false, abilities: unit.goals, q2Kind: spec.q2Kind, execution: spec.execution, q1: { title: '解释题', prompt: spec.q1 }, q2: { title: spec.q2Kind === 'reasoning' ? '分析题' : '代码题', prompt: spec.q2, starter: spec.starter, file: '代码答案' } } : null
    },
    goHome: () => { setCurrentId(null); setGlobalView('home') },
    goSpaces: () => { setCurrentId(null); setGlobalView('spaces') },
    openSpace: (id) => { if (cache.current[id]) setCurrentId(id) },
    createSpace: (goal) => { if (!ready || !goal.trim()) return; let saved: Workspace | undefined
      void run('create-space', async () => {
      saved ??= await api<Workspace>('/spaces', { name: goal.trim().slice(0, 80), goal: goal.trim() })
      const entry = await loadSpace(saved)
      cache.current = { [saved.id]: entry, ...cache.current }; publish(); setCurrentId(saved.id)
      // Creation already saved the first message and started intake. Subscribe even
      // if it finished before the response arrived so its business result refreshes.
      for (const work of saved.runs) watchRun(saved.id, work)
    }) },
    onboardSend: (text) => { void sendMessage(text) },
    updateRequirement: (patch) => saveRequirement({ ...current!.requirement!, ...patch }, false),
    renameSpace: (name) => { if (current) changeUi(current.id, (s) => ({ ...s, name })) },
    confirmRequirement: () => { if (!current?.requirement || !selected || !inputAllowed(true)) return
      if (!selected.saved.readiness?.ready) {
        setError(selected.saved.readiness?.reasons.join(' ') || '请先核对学习对象、版本和资料，再确认需求。')
        return
      }
      if (!capabilities.agent) { void saveRequirement(current.requirement, true); return }
      const space = current.id, input = { revision: selected.saved.requirement.revision, value: current.requirement, confirmed: true }
      let submission: RunSubmission | undefined, applied = false
      void run(`plan:${space}`, async () => {
        submission ??= await api<RunSubmission>(`/spaces/${space}/plan`, input)
        // Only leave intake after the server accepts the confirmation and run.
        if (!applied) {
          acceptSession(space, submission.session, submission.run)
          change(space, (s) => ({ ...s, planningError: null, ui: { ...s.ui, view: s.saved.route.content ? 'route' : 'planning', agentOpen: !!s.saved.route.content } }))
          applied = true
        }
        watchRun(space, submission.run)
        await refreshBusiness(space)
      })
    },
    setView: navigate,
    enterUnit,
    retryGeneration: (id) => { if (current) generateLesson(current.id, id) },
    setComposerText: (text) => editSession({ composerText: text }),
    setRouteSuggestion: (text) => editSession({ routeSuggestion: text }),
    setQuote: (quote) => {
      if (quote && current) {
        const lesson = current.currentUnitId ? selected?.units[current.currentUnitId]?.lesson : null
        quote = { ...quote, provenance: quote.provenance ?? { capturedAt: Date.now(),
          kind: quote.source === 'code' ? 'editor-buffer' : quote.source === 'lesson' ? 'lesson' : quote.source === 'terminal' ? 'terminal' : 'assessment',
          objectId: quote.source === 'code' ? current.activeFileId ?? undefined : current.currentUnitId ?? undefined,
          version: quote.source === 'lesson' ? String(lesson?.revision ?? 0) : undefined,
          range: quote.source === 'code' && activeFile ? `${activeFile.content.indexOf(quote.text)}:${quote.text.length}` : undefined,
        } }
        changeUi(current.id, (s) => ({ ...s, agentOpen: true }))
      }
      editSession({ composerQuote: quote })
    },
    sendMessage: (text) => {
      if (current && text !== undefined && sessionScope(current) === 'route') changeUi(current.id, (s) => ({ ...s, agentOpen: true }))
      return sendMessage(text)
    },
    stopReply: () => { if (!current) return
      const running = current.view === 'planning' ? latestPlan(selected!.saved)
        : sessionScope(current) === 'route' ? selected!.saved.runs.findLast((work) => work.kind === 'roadmap' && ['pending', 'running'].includes(work.state))
        : session?.messages.find((m) => m.status === 'thinking' || m.status === 'streaming')
      if (running) void run(`stop:${running.id}`, () => api(`/spaces/${current.id}/runs/${running.id}/stop`, {}))
    },
    retryReply: (id) => { if (!current || !inputAllowed(selected?.saved.runs.find((work) => work.id === id)?.kind === 'roadmap')) return; const space = current.id
      void run(`retry:${id}`, async () => {
        if (pendingDecision(cache.current[space]!.saved)) throw new Error('请先接受或拒绝当前提案。')
        const submission = await api<RunSubmission>(`/spaces/${space}/runs/${id}/retry`, {})
        acceptSession(space, submission.session, submission.run)
        change(space, (s) => ({ ...s, planningError: null }))
        watchRun(space, submission.run)
      })
    },
    applyRouteAction: unavailable,
    newSession: () => { if (!current) return; const space = current.id, key = sessionKey(current)
      void run(`new-session:${space}:${key}`, async () => {
        const saved = await api<SessionDetail>(`/spaces/${space}/sessions`, { scope: sessionScope(current), unitId: sessionUnitId(current), title: '新会话' })
        invalidateBusiness(space)
        change(space, (s) => ({ ...s, saved: { ...s.saved, sessions: [...s.saved.sessions, saved] }, sessions: { ...s.sessions, [saved.id]: saved }, ui: { ...s.ui, sessions: [...s.ui.sessions, uiSession(saved)], activeSessionIds: { ...s.ui.activeSessionIds, [key]: saved.id } } }))
        sessionStorage.setItem(`session:${space}:${key}`, saved.id)
      })
    },
    switchSession: (id) => { if (!current) return; const key = sessionKey(current)
      changeUi(current.id, (s) => ({ ...s, activeSessionIds: { ...s.activeSessionIds, [key]: id } })); sessionStorage.setItem(`session:${current.id}:${key}`, id)
    },
    toggleAgent: (open) => { if (current) changeUi(current.id, (s) => ({ ...s,
      agentOpen: !!pendingDecision(cache.current[current.id]!.saved) || (open ?? !s.agentOpen) })) },
    toggleIde: (open) => { if (current) changeUi(current.id, (s) => ({ ...s, ideOpen: open ?? !s.ideOpen, ideFullscreen: false })) },
    setIdeFullscreen: (full) => { if (current) changeUi(current.id, (s) => ({ ...s, ideFullscreen: full, ideOpen: true })) },
    toggleExplorer: () => { if (current) changeUi(current.id, (s) => ({ ...s, explorerOpen: !s.explorerOpen })) },
    selectEntry: (id) => { if (current) changeUi(current.id, (s) => ({ ...s, selectedEntryId: id })) },
    toggleDirectory: (id, open) => { if (current) changeUi(current.id, (s) => ({ ...s, expandedDirectoryIds: (open ?? !s.expandedDirectoryIds.includes(id)) ? [...new Set([...s.expandedDirectoryIds, id])] : s.expandedDirectoryIds.filter((x) => x !== id) })) },
    collapseDirectories: () => { if (current) changeUi(current.id, (s) => ({ ...s, expandedDirectoryIds: [], selectedEntryId: null })) },
    createEntry,
    renameEntry: async (path, name) => {
      if (!current || !selected) return '没有打开的学习空间'
      const space = current.id, affected = (p: string) => p === path || p.startsWith(`${path}/`)
      const destination = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/${name}` : name
      const result = await run(`rename:${space}:${path}`, async () => {
        change(space, (s) => ({ ...s, renamingPath: path }))
        try {
          await flushFiles(space)
          await refreshFiles(space)
          const entry = cache.current[space]!.tree.find((e) => e.path === path)!
          await api(`/spaces/${space}/project/rename`, { path, destination, version: entry.version })
          change(space, (s) => ({ ...s, files: Object.fromEntries(Object.entries(s.files).filter(([p]) => !affected(p))), ui: { ...s.ui,
            files: s.ui.files.filter((f) => !affected(f.id)), openFileIds: s.ui.openFileIds.filter((p) => !affected(p)), activeFileId: s.ui.activeFileId && affected(s.ui.activeFileId) ? null : s.ui.activeFileId, selectedEntryId: destination,
          } }))
          await refreshFiles(space); return true
        } finally { change(space, (s) => ({ ...s, renamingPath: null })) }
      })
      return result ? null : errorRef.current
    },
    openFile,
    closeFile: (id) => { if (current) changeUi(current.id, (s) => { const openFileIds = s.openFileIds.filter((x) => x !== id); return { ...s, openFileIds, activeFileId: s.activeFileId === id ? openFileIds[0] ?? null : s.activeFileId } }) },
    createFile: (name) => { void createEntry(name, 'file', null) },
    updateFile: (id, content) => { if (!current) return
      changeUi(current.id, (s) => ({ ...s, files: s.files.map((f) => f.id === id ? { ...f, content } : f) }))
      void saveFile(current.id, id).catch(() => {})
    },
    bringToIde: (code, suggested = 'example.txt') => {
      if (!current || !selected) return
      const base = suggested.split('/').at(-1) || 'example.txt'
      let name = base, index = 1
      while (selected.tree.some((entry) => entry.path === name)) {
        const dot = base.lastIndexOf('.')
        name = dot > 0 ? `${base.slice(0, dot)}-${index++}${base.slice(dot)}` : `${base}-${index++}`
      }
      void createEntry(name, 'file', null, code)
    },
    connectEnv: () => { void localTerminal?.connect() },
    terminalCommand: (command) => { void localTerminal?.input(`${command}\r`) },
    startAssessment: () => { if (!recordUnit || !current) return
      if (!navigate('assessment', recordUnit)) return
      if (capabilities.assessment && !pendingDecision(cache.current[current.id]!.saved) && needsAssessment(current.id, recordUnit)
        && !cache.current[current.id]!.saved.tasks.some((task) => task.unitId === recordUnit && task.kind === 'assessment' && ['pending', 'running'].includes(task.state))) assessmentTask(current.id, recordUnit, 'assessment')
    },
    updateDraft: (patch) => { if (!current?.draft) return; const unit = current.draft.unitId
      change(current.id, (s) => { const draft = { ...s.drafts[unit]!, ...patch }; return { ...s, drafts: { ...s.drafts, [unit]: draft }, ui: { ...s.ui, draft } } })
    },
    runDraft: () => { if (!current?.draft || !selected) return
      const space = current.id, unit = current.draft.unitId, input = { specRevision: selected.units[unit]!.assessment?.revision, code: current.draft.q2 }
      void run(`code:${space}:${unit}`, async () => {
        const execution = await api<CodeExecution>(`/spaces/${space}/units/${unit}/executions`, input)
        change(space, (s) => ({ ...s, executions: [...s.executions.filter((e) => e.id !== execution.id), execution] }))
      })
    },
    submitAssessment: () => { if (current?.draft) assessmentTask(current.id, current.draft.unitId, 'evaluation') },
    leaveAssessment: () => navigate('unit'),
    viewRecord: (id) => { if (!current) return; const record = current.records.find((r) => r.id === id)!
      if (navigate('result', record.unitId)) changeUi(current.id, (s) => ({ ...s, viewingRecordId: id })) },
    goNextUnit: () => { if (current && recordUnit) { const next = nextUnit(current, recordUnit); if (next) enterUnit(next.id) } },
    backToStudy: () => navigate('unit', recordUnit),
    persistence: {
      ready, busy, error, retry: () => retry.current(), requirementConfirmed: selected?.saved.requirement.confirmed ?? false,
      planning: { run: selected ? latestPlan(selected.saved) : undefined, error: selected?.planningError ?? null },
      intake: selected?.saved.requirement.intake ?? null, readiness: selected?.saved.readiness,
      questions: session ? selected?.sessions[session.id]?.questions ?? [] : [],
      answerQuestions,
      loadResearch: (ref) => current ? api<ResearchDossier>(`/spaces/${current.id}/research/${ref.id}/${ref.revision}`) : Promise.reject(new Error('没有打开的学习空间')),
      saveResearch,
      exportResearch: (ref) => current ? exportResearch(current.id, ref) : Promise.reject(new Error('没有打开的学习空间')),
      conclusions: selected?.saved.conclusions ?? [],
      execution: selected?.executions.filter((e) => e.unitId === recordUnit).at(-1),
      stopExecution: (id) => { if (current) void run(`stop-code:${id}`, async () => { await api(`/spaces/${current.id}/executions/${id}/stop`, {}); await refreshBusiness(current.id) }) },
      actions: selected?.actions ?? [],
      decideAction: (id, decision) => { if (!current || !selected) return
        const space = current.id, proposal = selected.actions.find((p) => p.id === id)!
        void run(`action:${id}:${decision}`, async () => {
          if (decision === 'confirm') await flushFiles(space)
          const updated = await api<ActionProposal>(`/spaces/${space}/actions/${id}`, { digest: proposal.digest, decision })
          change(space, (s) => ({ ...s, actions: s.actions.map((p) => p.id === id && ['pending', 'running'].includes(p.state) ? updated : p) }))
          await refreshBusiness(space)
          await refreshFiles(space)
        })
      },
      tasks: selected?.saved.tasks ?? [],
      taskParts: selected?.taskParts ?? {},
      runContexts: selected?.runContexts ?? {},
      generateAssessment: () => { if (current && recordUnit) assessmentTask(current.id, recordUnit, 'assessment') },
      stopTask: (id) => { if (current) void run(`stop:${id}`, () => api(`/spaces/${current.id}/runs/${id}/stop`, {})) },
      retryTask: (id) => { if (current) retryTask(current.id, id) },
      decideConclusion: (id, adopted) => { if (!current || !selected) return
        const space = current.id, conclusion = selected.saved.conclusions.find((c) => c.id === id)!
        void run(`conclusion:${id}`, async () => {
          const conclusions = await api<LearningConclusion[]>(`/spaces/${space}/conclusions/${id}`, { revision: conclusion.revision, adopted })
          change(space, (s) => ({ ...s, saved: { ...s.saved, conclusions } }))
        })
      },
      requirementDraft: selected?.requirementDraft ?? null,
      setRequirementDraft: (value) => { if (current) change(current.id, (s) => ({ ...s, requirementDraft: value })) },
      saveName: () => { if (!current || !selected || current.name === selected.saved.name) return; const id = current.id, name = current.name, previousName = selected.saved.name
        void run(`name:${id}`, async () => { const saved = await api<SpaceSummary>(`/spaces/${id}/name`, { name, previousName }); change(id, (s) => ({ ...s, saved: { ...s.saved, name: saved.name }, ui: { ...s.ui, name: s.ui.name === name ? saved.name : s.ui.name } })) })
      },
      assessmentDirty: !!current?.draft && !same(answers(current.draft), answers(selected!.units[current.draft.unitId]!.draft)),
      fileDirty: !!activeFile && !!selected && unsavedFiles(selected).some((f) => f.id === activeFile.id),
      fileSaveError: activeFile ? fileSaveErrors.current.get(`${currentId}:${activeFile.id}`) ?? null : null,
      fileRenaming: !!activeFile && !!selected?.renamingPath && (activeFile.id === selected.renamingPath || activeFile.id.startsWith(`${selected.renamingPath}/`)),
      filesPending: !!selected && unsavedFiles(selected).length > 0,
      saveAssessment: () => { if (!current?.draft || !selected) return; const id = current.id, draft = current.draft, revision = selected.units[draft.unitId]!.draft.revision
        void run(`assessment:${id}:${draft.unitId}`, async () => {
          const saved = await api<SavedAssessmentDraft>(`/spaces/${id}/units/${draft.unitId}/draft`, { revision, ...answers(draft) })
          change(id, (s) => ({ ...s, units: { ...s.units, [draft.unitId]: { ...s.units[draft.unitId]!, draft: saved } } }))
        })
      },
      refreshFiles: () => { if (current) void run(`tree:${current.id}`, () => refreshFiles(current.id)) },
      proposals: selected?.saved.proposals ?? [],
      lessonProposals: selected?.saved.lessonProposals ?? [],
      lessonVersions: Object.fromEntries(Object.entries(selected?.units ?? {}).map(([id, unit]) => [id, unit.lesson?.revision ?? 0])),
      reviewLessonProposal: (id) => {
        if (!current) return
        const proposal = cache.current[current.id]!.saved.lessonProposals?.find((proposal) => proposal.id === id)
        if (!proposal || !availableUnitIds(cache.current[current.id]!.ui).has(proposal.unitId)) {
          setError('提案的目标单元已不在可用路线中。请拒绝后重新调整。'); return
        }
        // No generation, session retargeting, buffer writes or fullscreen reset.
        changeUi(current.id, (s) => ({ ...s, view: 'unit', currentUnitId: proposal.unitId, agentOpen: true }))
        window.dispatchEvent(new CustomEvent('lesson-proposal-review', { detail: { space: current.id, proposal: id } }))
      },
      applyLessonProposal: (id) => {
        if (!current) return
        const space = current.id
        let receipt: LessonProposalApplication | undefined, applied = false
        void run(`lesson-proposal:${id}`, async () => {
          if (!receipt) {
            const entry = cache.current[space]!, proposal = entry.saved.lessonProposals?.find((proposal) => proposal.id === id)
            const versions = Object.fromEntries(Object.entries(entry.units).map(([id, unit]) => [id, unit.lesson?.revision ?? 0]))
            // A refresh may learn the lost POST already applied. Recover its
            // idempotent receipt rather than treating that as a stale new choice.
            if (!proposal || !['pending', 'applied'].includes(proposal.state) || proposal.state === 'pending' && lessonProposalStale(proposal, entry.saved.requirement.revision,
              entry.saved.route.revision, entry.saved.requirement.confirmed, versions, entry.ui.stages.some((stage) => stage.units.some((unit) => unit.id === proposal.unitId))))
              throw new Error('需求、路线或课件来源已变化，不能接受这份提案。请拒绝后重新调整。')
            receipt = await api<LessonProposalApplication>(`/spaces/${space}/lesson-proposals/${id}/apply`, {})
          }
          if (!applied) { acceptLesson(space, receipt); applied = true }
          await refreshBusiness(space)
        })
      },
      rejectLessonProposal: (id, feedback) => {
        if (!current) return Promise.resolve(false)
        const space = current.id
        let receipt: ProposalRejection | undefined, applied = false
        return run(`lesson-proposal:${id}`, async () => {
          receipt ??= await api<ProposalRejection>(`/spaces/${space}/lesson-proposals/${id}/reject`, { feedback })
          if (!applied) {
            acceptDecision(space, receipt.workspace)
            acceptSession(space, receipt.session, receipt.run ?? undefined)
            if (receipt.run) {
              const key = `unit:${receipt.session.unitId}`
              changeUi(space, (s) => ({ ...s, agentOpen: true, activeSessionIds: { ...s.activeSessionIds, [key]: receipt!.session.id } }))
              sessionStorage.setItem(`session:${space}:${key}`, receipt.session.id)
              watchRun(space, receipt.run)
            }
            applied = true
          }
          await refreshBusiness(space)
          if (receipt.followupError) setError(receipt.followupError)
          return true
        }).then(Boolean)
      },
      routeRevision: selected?.saved.route.revision ?? 0,
      requirementRevision: selected?.saved.requirement.revision ?? 0,
      routeAdjustmentRun: selected?.saved.runs.findLast((work) => work.kind === 'roadmap' && ['pending', 'running'].includes(work.state)),
      applyProposal: (id) => { if (!current) return; const space = current.id
        let receipt: Workspace | undefined
        void run(`proposal:${id}`, async () => {
          receipt ??= await api<Workspace>(`/spaces/${space}/proposals/${id}/apply`, {})
          acceptDecision(space, receipt)
          await refreshBusiness(space)
        })
      },
      rejectProposal: (id, feedback) => {
        if (!current) return Promise.resolve(false)
        const space = current.id
        let receipt: ProposalRejection | undefined, applied = false
        return run(`proposal:${id}`, async () => {
          receipt ??= await api<ProposalRejection>(`/spaces/${space}/proposals/${id}/reject`, { feedback })
          if (!applied) {
            acceptDecision(space, receipt.workspace)
            acceptSession(space, receipt.session, receipt.run ?? undefined)
            if (receipt.run) {
              changeUi(space, (s) => ({ ...s, agentOpen: true, activeSessionIds: { ...s.activeSessionIds, route: receipt!.session.id } }))
              sessionStorage.setItem(`session:${space}:route`, receipt.session.id)
              watchRun(space, receipt.run)
            }
            applied = true
          }
          await refreshBusiness(space)
          if (receipt.followupError) setError(receipt.followupError)
          return true
        }).then(Boolean)
      },
    },
  }
}
