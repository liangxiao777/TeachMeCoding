import { useEffect, useRef, useState } from 'react'
import { applyAgentEvent, type AgentDisplayPart } from '@teach-me-coding/contracts'
import type { ActionProposal, AgentRun, AssessmentDraft as SavedAssessmentDraft, CodeExecution, LearningConclusion, ProjectEntry, ProjectFile, QuestionAnswer, QuestionRound, RequirementState, ResearchDossier, ResearchRef, ResearchSaveResult, RunEvent, RunEvents, RunSubmission, SessionDetail, SpaceSummary, UnitDetail, WorkStatus, Workspace } from '@teach-me-coding/contracts'
import { access, api, streamRun, ApiError } from '@/lib/api'
import type { AppModel, RequirementDraft } from './context'
import { activeSession, availableUnitIds, canAccessView, fileLanguage, nextUnit, sessionScope, sessionUnitId } from './selectors'
import { useUnsavedWarning } from './request-state'
import type { AssessmentDraft, LessonBlock, Session, Space, SpaceView } from './types'
import { LocalTerminal } from '@/lib/terminal'

interface StoredSpace {
  ui: Space
  saved: Workspace
  sessions: Record<string, SessionDetail>
  units: Record<string, UnitDetail>
  drafts: Record<string, AssessmentDraft>
  tree: ProjectEntry[]
  files: Record<string, ProjectFile>
  disk: ProjectFile | null
  requirementDraft: RequirementDraft | null
  planningError: string | null
  taskParts: Record<string, AgentDisplayPart[]>
  actions: ActionProposal[]
  executions: CodeExecution[]
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const latestPlan = (saved: Workspace) => saved.runs.filter((work) => work.kind === 'roadmap').at(-1)
const answers = (d: { q1: string; q2: string }) => ({ q1: d.q1, q2: d.q2 })
const unsavedFiles = (s: StoredSpace) => s.ui.files.filter((f) => s.files[f.id] && f.content !== s.files[f.id]!.content)
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
        for (const event of page.events) { parts = applyAgentEvent(parts, event); cursor = event.seq }
      }
      return [task.id, parts]
    })),
    Promise.all(saved.sessions.map((s) => api<ActionProposal[]>(`/spaces/${saved.id}/sessions/${s.id}/actions`))),
    Promise.all(metadata.map((u) => api<CodeExecution[]>(`/spaces/${saved.id}/units/${u.id}/executions`))),
  ])
  const details = Object.fromEntries(units.map((unit) => [unit.id, unit]))
  const records = units.flatMap((unit) => unit.records.map((record) => ({ ...record, unitTitle: metadata.find((m) => m.id === unit.id)!.title }))).sort((a, b) => a.createdAt - b.createdAt || a.attempt - b.attempt)
  const drafts = Object.fromEntries(units.map((unit) => {
    const task = saved.tasks.find((t) => t.unitId === unit.id && ['assessment', 'evaluation'].includes(t.kind) && ['pending', 'running'].includes(t.state))
    return [unit.id, { ...answers(unit.draft), unitId: unit.id, state: task?.kind === 'assessment' ? 'generating' as const : task?.kind === 'evaluation' ? 'evaluating' as const : 'ready' as const,
      q2Output: null, q2Running: false, attempt: unit.nextAttempt ?? Math.max(0, ...unit.records.map((record) => record.attempt)) + 1 }]
  }))
  const stages = saved.route.content?.stages.map((stage) => ({ ...stage, units: stage.units.map((unit) => {
    const task = saved.tasks.filter((t) => t.unitId === unit.id && t.kind === 'lesson').at(-1)
    return { ...unit, status: details[unit.id]!.status, contentState: task && ['pending', 'running'].includes(task.state) ? 'generating' as const
      : task && ['failed', 'interrupted'].includes(task.state) ? 'failed' as const : details[unit.id]!.lesson ? 'ready' as const : 'none' as const,
      hasLesson: !!details[unit.id]!.lesson,
      lessonKey: unit.id, lastAdvice: details[unit.id]!.records[0]?.concerns }
  }) })) ?? []
  const selectedSessions: Record<string, string> = {}
  for (const session of sessions) {
    const key = session.scope === 'unit' ? `unit:${session.unitId}` : session.scope
    selectedSessions[key] ??= sessionStorage.getItem(`session:${saved.id}:${key}`) ?? session.id
  }
  return { saved, sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), units: details, tree, files: {}, disk: null, drafts, requirementDraft: null, planningError: null, taskParts: Object.fromEntries(taskEntries), actions: actionGroups.flat(), executions: executionGroups.flat(),
    ui: {
      id: saved.id, name: saved.name, kind: 'generic', topic: '', requirement: saved.requirement.value,
      onboarding: { messages: [], step: 0, agentTyping: false, summaryReady: true },
      routeNote: saved.route.content?.note ?? '', stages,
      currentUnitId: units.find((unit) => !unit.lesson)?.id ?? units.find((unit) => unit.status !== 'passed' && unit.status !== 'skipped')?.id ?? units[0]?.id ?? null,
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
  const subscriptions = useRef(new Map<string, AbortController>())
  const terminals = useRef(new Map<string, LocalTerminal>())
  const errorRef = useRef('')
  const retry = useRef<() => void>(() => {})
  const inFlight = useRef(new Map<string, Promise<unknown>>())
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
      env: connected ? 'connected' : 'lost', envLabel: '本机终端 · 非沙箱' })), () => unsavedFiles(cache.current[id]!).length === 0))
  }
  const localTerminal = current ? terminals.current.get(current.id) : undefined

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
    || s.ui.files.some((file) => !!s.files[file.id] && file.content !== s.files[file.id]!.content))
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
    const loaded = await loadSpace(await api<Workspace>(`/spaces/${space}`))
    change(space, (s) => {
      const freshIntake = ticket === businessRefresh.current.get(space) && loaded.saved.requirement.revision >= s.saved.requirement.revision
      const requirement = freshIntake ? loaded.saved.requirement : s.saved.requirement
      const readiness = freshIntake ? loaded.saved.readiness : s.saved.readiness
      // A terminal refresh may return after the user has already retried the run.
      const runs = [...loaded.saved.runs]
      for (const known of s.saved.runs) {
        const index = runs.findIndex((r) => r.id === known.id)
        if (index < 0) runs.push(known)
        else if (!['pending', 'running'].includes(known.state) || known.state === 'running' && runs[index]!.state === 'pending') runs[index] = known
      }
      const sessions = { ...s.sessions }
      for (const [id, fresh] of Object.entries(loaded.sessions)) sessions[id] = mergeSession(sessions[id], fresh, freshIntake)
      const units = { ...loaded.units }
      for (const [id, fresh] of Object.entries(units)) {
        const known = s.units[id]?.draft
        if (known && known.revision > fresh.draft.revision) units[id] = { ...fresh, draft: known }
      }
      const drafts = { ...s.drafts }
      for (const [id, fresh] of Object.entries(loaded.drafts)) drafts[id] = { ...fresh, ...(s.drafts[id] ? answers(s.drafts[id]!) : {}) }
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
      return { ...s, actions, executions, saved: { ...loaded.saved, requirement, readiness, runs }, units, drafts, taskParts: { ...loaded.taskParts, ...s.taskParts },
        sessions, ui: { ...s.ui, draft: s.ui.draft ? drafts[s.ui.draft.unitId] ?? s.ui.draft : null, completed: loaded.ui.completed,
          ...(s.ui.view === 'planning' && loaded.saved.route.content ? { view: 'route', agentOpen: false } : {}),
          currentUnitId: s.ui.currentUnitId ?? loaded.ui.currentUnitId,
          requirement: requirement.value, stages: loaded.ui.stages, routeNote: loaded.ui.routeNote, records: loaded.ui.records,
          sessions: s.ui.sessions.map((old) => {
            const fresh = loaded.ui.sessions.find((next) => next.id === old.id)
            if (!fresh) return old
            const messages = new Map(old.messages.map((m) => [m.id, m]))
            for (const message of fresh.messages) if ((message.sequence ?? 0) >= (messages.get(message.id)?.sequence ?? 0)) messages.set(message.id, message)
            return { ...old, messages: [...messages.values()], updatedAt: Math.max(old.updatedAt, fresh.updatedAt) }
          }),
        },
      }
    })
  }
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
      const update = (old: Session) => {
        const next = uiSession(saved), messages = new Map(old.messages.map((message) => [message.id, message]))
        for (const message of next.messages) if ((message.sequence ?? 0) >= (messages.get(message.id)?.sequence ?? 0)) messages.set(message.id, message)
        return { ...old, messages: [...messages.values()], updatedAt: Math.max(old.updatedAt, next.updatedAt),
          composerText: consumed && old.composerText === consumed.text ? fresh.draft.text : old.composerText,
          composerQuote: consumed && same(old.composerQuote, consumed.quote) ? fresh.draft.quote : old.composerQuote }
      }
      return { ...s, sessions: { ...s.sessions, [saved.id]: saved },
        saved: { ...s.saved, ...(changesIntake ? { readiness: undefined } : {}),
          runs: nextRun ? [...s.saved.runs.filter((run) => run.id !== nextRun.id), nextRun] : s.saved.runs },
        ui: { ...s.ui, sessions: s.ui.sessions.some((old) => old.id === saved.id)
          ? s.ui.sessions.map((old) => old.id === saved.id ? update(old) : old) : [...s.ui.sessions, uiSession(saved)] } }
    })
  }
  const sendMessage = (text?: string): Promise<boolean> => {
    if (!current || !session) return Promise.resolve(false)
    const space = current.id, id = session.id, snapshot = { text: session.composerText, quote: session.composerQuote }
    const stored = cache.current[space]!.sessions[id]!
    const input = { text: text ?? snapshot.text, quote: text === undefined ? snapshot.quote : null, draftRevision: stored.draft.revision }
    if (!input.text.trim() && !input.quote) return Promise.resolve(false)
    let submission: RunSubmission | undefined, saved: SessionDetail | undefined, applied = false
    return run(`session:${id}`, async () => {
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
    if (!current || !session || !capabilities.agent) return Promise.resolve(false)
    const space = current.id, id = session.id
    const snapshot = structuredClone(input)
    let submission: RunSubmission | undefined, applied = false
    return run(`session:${id}`, async () => {
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
      const entries = projectEntries(tree, s.ui.files), files = { ...s.files }
      // A terminal can delete/rename a file. Never discard an unsaved buffer.
      entries.files.push(...unsavedFiles(s).filter((f) => !entries.files.some((entry) => entry.id === f.id)))
      for (const { before, disk } of loaded) {
        const file = entries.files.find((f) => f.id === disk.path)
        if (file && files[disk.path]?.version === before.version && file.content === before.content) {
          entries.files = entries.files.map((f) => f.id === disk.path ? { ...f, content: disk.content } : f)
          files[disk.path] = disk
        }
      }
      return { ...s, tree, files, ui: { ...s.ui, ...entries } }
    })
  }
  const saveFile = async (space: string, path: string) => {
    const entry = cache.current[space]!, content = entry.ui.files.find((f) => f.id === path)!.content, version = entry.files[path]!.version
    const saved = await api<ProjectFile>(`/spaces/${space}/project/save`, { path, content, version })
    change(space, (s) => ({ ...s, disk: null, files: { ...s.files, [path]: saved } }))
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
      change(id, (s) => ({ ...s, disk: null, ui: { ...s.ui, ideOpen: true, activeFileId: path, selectedEntryId: path,
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
      if (content !== undefined) changeUi(id, (s) => ({ ...s, files: s.files.map((file) => file.id === path ? { ...file, content } : file), view: 'unit' }))
      if (parent) changeUi(id, (s) => ({ ...s, expandedDirectoryIds: [...new Set([...s.expandedDirectoryIds, parent])] }))
      return true
    })
    return result ? null : errorRef.current
  }
  const unavailable = () => { setError('该能力尚未接入，不会执行模拟操作。') }
  const generateLesson = (space: string, unit: string) => {
    const revision = cache.current[space]!.units[unit]?.lesson?.revision ?? 0
    void run(`lesson:${space}:${unit}`, async () => {
      if (!availableUnitIds(cache.current[space]!.ui).has(unit)) throw new Error('单元尚未解锁，请先生成并保存全部前序课件。')
      const task = await api<AgentRun>(`/spaces/${space}/units/${unit}/tasks`, { kind: 'lesson', revision })
      change(space, (s) => ({ ...s, saved: { ...s.saved, tasks: [...s.saved.tasks.filter((t) => t.id !== task.id), task] },
        ui: { ...s.ui, stages: s.ui.stages.map((stage) => ({ ...stage, units: stage.units.map((u) => u.id === unit ? { ...u, contentState: 'generating' } : u) })) } }))
      watchRun(space, task)
    })
  }
  const assessmentTask = (space: string, unit: string, kind: 'assessment' | 'evaluation') => {
    const entry = cache.current[space]!, detail = entry.units[unit]!, draft = entry.drafts[unit]!
    const input = kind === 'assessment' ? { kind, revision: detail.assessment?.revision ?? 0 }
      : { kind, revision: detail.draft.revision, specRevision: detail.assessment?.revision, ...answers(draft), execute: detail.assessment?.q2Kind === 'code' && !!detail.assessment.execution }
    void run(`${kind}:${space}:${unit}`, async () => {
      const task = await api<AgentRun>(`/spaces/${space}/units/${unit}/tasks`, input)
      change(space, (s) => ({ ...s, saved: { ...s.saved, tasks: [...s.saved.tasks.filter((t) => t.id !== task.id), task] } }))
      await refreshBusiness(space)
      watchRun(space, task)
    })
  }
  const retryTask = (space: string, id: string) => {
    void run(`task-retry:${id}`, async () => {
      const unit = cache.current[space]!.saved.tasks.find((task) => task.id === id)?.unitId
      if (!unit || !availableUnitIds(cache.current[space]!.ui).has(unit)) throw new Error('单元尚未解锁，请先生成并保存全部前序课件。')
      const task = await api<AgentRun>(`/spaces/${space}/tasks/${id}/retry`, {})
      await refreshBusiness(space); watchRun(space, task)
    })
  }
  const enterUnit = (id: string) => {
    if (!navigate('unit', id) || !current) return
    const entry = cache.current[current.id]!
    if (capabilities.agent && !entry.units[id]?.lesson && !entry.saved.tasks.some((task) => task.unitId === id && task.kind === 'lesson')) generateLesson(current.id, id)
  }
  const recordUnit = current?.view === 'result' ? current.records.find((r) => r.id === current.viewingRecordId)?.unitId ?? current.currentUnitId : current?.currentUnitId
  const activeFile = current?.files.find((file) => file.id === current.activeFileId)
  const uiCurrent = current && { ...current, onboarding: { ...current.onboarding,
    agentTyping: !!session?.messages.some((m) => m.status === 'thinking' || m.status === 'streaming'),
    messages: current.view === 'onboarding' ? session?.messages ?? [] : current.onboarding.messages } }

  return {
    state: { spaces, currentSpaceId: currentId, globalView }, current: uiCurrent, session,
    capabilities, localTerminal,
    refreshCapabilities: () => { void api<AppModel['capabilities']>('/capabilities').then(setCapabilities).catch(() => {}) },
    lesson: (unit) => {
      const lesson = selected?.units[unit.id]?.lesson
      if (!lesson) return null
      if (!lesson.blocks) return { intro: lesson.intro ?? '', blocks: [], content: lesson.content }
      // Earlier model output stored entire Markdown sections as h2.text. Split
      // only the display model, preserving saved content and stable TOC anchors.
      return { intro: lesson.intro ?? '', blocks: lesson.blocks.flatMap((block): LessonBlock[] => {
        if (block.type !== 'h2') return [block]
        const [heading = '', ...lines] = block.text.split(/\r\n?|\n/)
        const body = lines.join('\n')
        return [{ ...block, text: heading.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim() },
          ...(body.trim() ? [{ type: 'markdown' as const, text: body }] : [])]
      }) }
    },
    assessment: (unit) => {
      const spec = selected?.units[unit.id]?.assessment
      return spec ? { abilities: unit.goals, q2Kind: spec.q2Kind, execution: spec.execution, q1: { title: '解释题', prompt: spec.q1 }, q2: { title: spec.q2Kind === 'reasoning' ? '分析题' : '代码题', prompt: spec.q2, starter: spec.starter, file: '代码答案' } } : null
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
    confirmRequirement: () => { if (!current?.requirement || !selected) return
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
      const running = current.view === 'planning' ? latestPlan(selected!.saved) : session?.messages.find((m) => m.status === 'thinking' || m.status === 'streaming')
      if (running) void run(`stop:${running.id}`, () => api(`/spaces/${current.id}/runs/${running.id}/stop`, {}))
    },
    retryReply: (id) => { if (!current) return; const space = current.id
      void run(`retry:${id}`, async () => {
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
        change(space, (s) => ({ ...s, saved: { ...s.saved, sessions: [...s.saved.sessions, saved] }, sessions: { ...s.sessions, [saved.id]: saved }, ui: { ...s.ui, sessions: [...s.ui.sessions, uiSession(saved)], activeSessionIds: { ...s.ui.activeSessionIds, [key]: saved.id } } }))
        sessionStorage.setItem(`session:${space}:${key}`, saved.id)
      })
    },
    switchSession: (id) => { if (!current) return; const key = sessionKey(current)
      changeUi(current.id, (s) => ({ ...s, activeSessionIds: { ...s.activeSessionIds, [key]: id } })); sessionStorage.setItem(`session:${current.id}:${key}`, id)
    },
    toggleAgent: (open) => { if (current) changeUi(current.id, (s) => ({ ...s, agentOpen: open ?? !s.agentOpen })) },
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
      if (current.files.some((f) => affected(f.id) && selected.files[f.id] && f.content !== selected.files[f.id]!.content)) return '重命名前请先保存该文件或目录中的编辑内容。'
      const destination = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/${name}` : name
      const entry = selected.tree.find((e) => e.path === path)!
      const result = await run(`rename:${space}:${path}`, async () => {
        await api(`/spaces/${space}/project/rename`, { path, destination, version: entry.version })
        change(space, (s) => ({ ...s, disk: null, files: Object.fromEntries(Object.entries(s.files).filter(([p]) => !affected(p))), ui: { ...s.ui,
          files: s.ui.files.filter((f) => !affected(f.id)), openFileIds: s.ui.openFileIds.filter((p) => !affected(p)), activeFileId: s.ui.activeFileId && affected(s.ui.activeFileId) ? null : s.ui.activeFileId, selectedEntryId: destination,
        } }))
        await refreshFiles(space); return true
      })
      return result ? null : errorRef.current
    },
    openFile,
    closeFile: (id) => { if (current) changeUi(current.id, (s) => { const openFileIds = s.openFileIds.filter((x) => x !== id); return { ...s, openFileIds, activeFileId: s.activeFileId === id ? openFileIds[0] ?? null : s.activeFileId } }) },
    createFile: (name) => { void createEntry(name, 'file', null) },
    updateFile: (id, content) => { if (current) changeUi(current.id, (s) => ({ ...s, files: s.files.map((f) => f.id === id ? { ...f, content } : f) })) },
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
    terminalCommand: (command) => { localTerminal?.send('input', { data: `${command}\r` }) },
    startAssessment: () => { if (!recordUnit || !current) return
      if (!navigate('assessment', recordUnit)) return
      if (capabilities.assessment && !selected?.units[recordUnit]?.assessment) assessmentTask(current.id, recordUnit, 'assessment')
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
          if (decision === 'confirm' && unsavedFiles(cache.current[space]!).length) throw new Error('请先保存所有编辑器文件，再确认执行。')
          const updated = await api<ActionProposal>(`/spaces/${space}/actions/${id}`, { digest: proposal.digest, decision })
          change(space, (s) => ({ ...s, actions: s.actions.map((p) => p.id === id && ['pending', 'running'].includes(p.state) ? updated : p) }))
          await refreshBusiness(space)
          await refreshFiles(space)
        })
      },
      tasks: selected?.saved.tasks ?? [],
      taskParts: selected?.taskParts ?? {},
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
      fileDirty: !!activeFile && !!selected?.files[activeFile.id] && activeFile.content !== selected.files[activeFile.id]!.content,
      unsavedFiles: selected ? unsavedFiles(selected).map((f) => f.id) : [],
      saveFiles: () => { if (!current) return; const id = current.id
        void run(`files:${id}`, async () => { for (const file of unsavedFiles(cache.current[id]!)) await saveFile(id, file.id); await refreshFiles(id) })
      },
      saveAssessment: () => { if (!current?.draft || !selected) return; const id = current.id, draft = current.draft, revision = selected.units[draft.unitId]!.draft.revision
        void run(`assessment:${id}:${draft.unitId}`, async () => {
          const saved = await api<SavedAssessmentDraft>(`/spaces/${id}/units/${draft.unitId}/draft`, { revision, ...answers(draft) })
          change(id, (s) => ({ ...s, units: { ...s.units, [draft.unitId]: { ...s.units[draft.unitId]!, draft: saved } } }))
        })
      },
      saveFile: () => { if (!current || !activeFile) return; const id = current.id, path = activeFile.id
        void run(`file:${id}:${path}`, async () => { await saveFile(id, path); await refreshFiles(id) })
      },
      compareFile: () => { if (!current || !activeFile) return; const id = current.id, path = activeFile.id
        void run(`file:${id}:${path}`, async () => { const disk = await api<ProjectFile>(`/spaces/${id}/project/file?path=${encodeURIComponent(path)}`); change(id, (s) => ({ ...s, disk })) })
      },
      refreshFiles: () => { if (current) void run(`tree:${current.id}`, () => refreshFiles(current.id)) },
      disk: selected?.disk ?? null,
      resolveFile: (keepLocal) => { if (!current || !selected?.disk) return; const disk = selected.disk
        change(current.id, (s) => ({ ...s, disk: null, files: { ...s.files, [disk.path]: disk }, ui: { ...s.ui, files: s.ui.files.map((file) => file.id === disk.path && !keepLocal ? { ...file, content: disk.content } : file) } }))
      },
      proposals: selected?.saved.proposals ?? [],
      applyProposal: (id) => { if (!current) return; const space = current.id
        void run(`proposal:${id}`, async () => {
          const saved = await api<Workspace>(`/spaces/${space}/proposals/${id}/apply`, {})
          const loaded = await loadSpace(saved)
          change(space, (s) => ({ ...s, units: { ...loaded.units, ...s.units }, drafts: { ...loaded.drafts, ...s.drafts }, saved: { ...s.saved, route: saved.route, proposals: saved.proposals }, ui: { ...s.ui, currentUnitId: s.ui.currentUnitId ?? loaded.ui.currentUnitId, stages: loaded.ui.stages, routeNote: loaded.ui.routeNote } }))
        })
      },
    },
  }
}
