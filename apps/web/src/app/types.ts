import type { CodeExecution, CodePlan } from '@teach-me-coding/contracts'

export type UnitStatus = 'not_started' | 'learning' | 'needs_work' | 'passed' | 'skipped'
export type ContentState = 'none' | 'generating' | 'ready' | 'failed'

export interface Unit {
  id: string
  title: string
  summary: string
  goals: string[]
  status: UnitStatus
  contentState: ContentState
  hasLesson?: boolean
  started?: boolean
  active?: boolean
  historicalPass?: import('@teach-me-coding/contracts').UnitDetail['historicalPass']
  lessonRevision?: number
  lessonKey: string
  lastAdvice?: string[]
}

export interface Stage {
  id: string
  title: string
  units: Unit[]
}

export type QuoteSource = 'lesson' | 'code' | 'terminal' | 'advice'

export interface Quote {
  source: QuoteSource
  text: string
  label: string
  caption?: import('@teach-me-coding/contracts').Quote['caption']
  provenance?: import('@teach-me-coding/contracts').Quote['provenance']
}

export type RouteActionKind = 'skip-basics' | 'project-first'

export interface RouteAction {
  kind: RouteActionKind
  applied: boolean
}

export type MessageStatus = 'thinking' | 'streaming' | 'done' | 'stopped' | 'error'

export interface Message {
  id: string
  runId?: string
  queuedPrompts?: import('@teach-me-coding/contracts').QueuedPrompt[]
  role: 'user' | 'agent'
  text: string
  parts?: import('@teach-me-coding/contracts').AgentDisplayPart[]
  full?: string
  quote?: Quote
  status?: MessageStatus
  error?: import('@teach-me-coding/contracts').BusinessErrorDetail
  notice?: import('@teach-me-coding/contracts').BusinessErrorResponse
  sequence?: number
  inAssessment?: boolean
  action?: RouteAction
  createdAt: number
}

export interface Session {
  id: string
  unitId: string | null
  scope?: 'intake' | 'route' | 'unit'
  settings?: import('@teach-me-coding/contracts').SessionDetail['settings']
  title: string
  updatedAt: number
  messages: Message[]
  composerText: string
  composerQuote: Quote | null
  routeSuggestion: string
}

export interface CodeFile {
  id: string
  name: string
  parentId: string | null
  content: string
  language: 'rust' | 'python' | 'text'
}

export interface ProjectDirectory {
  id: string
  name: string
  parentId: string | null
}

export interface TermLine {
  id: string
  runId: string
  kind: 'cmd' | 'out' | 'err' | 'info'
  text: string
  notice?: import('@/i18n/notice').UiNotice
}

export type EnvStatus = 'disconnected' | 'connecting' | 'connected' | 'lost'

export interface AssessmentDraft {
  unitId: string
  state: 'generating' | 'ready' | 'evaluating'
  q1: string
  q2: string
  q2Output: TermLine[] | null
  q2Running: boolean
  attempt: number
}

export interface AssessmentRecord {
  id: string
  unitId: string
  unitTitle: string
  attempt: number
  result: 'pass' | 'needs_work' | 'unverified'
  createdAt: number
  answers: { q1: string; q2: string }
  summary: string
  mastered: string[]
  concerns: string[]
  evidence: string[]
  toVerify: string[]
  valid?: boolean
  verification?: string
  lessonRevision?: number
  specRevision?: number
  q2Kind?: 'code' | 'reasoning'
  execution?: CodeExecution
}

export type SpaceView = 'onboarding' | 'planning' | 'route' | 'unit' | 'assessment' | 'result'

export interface OnboardMsg {
  id: string
  role: 'user' | 'agent'
  text: string
  parts?: import('@teach-me-coding/contracts').AgentDisplayPart[]
  status?: MessageStatus
}

export type Requirement = import('@teach-me-coding/contracts').Requirement

export interface Space {
  id: string
  kind: 'rust' | 'pytorch' | 'generic'
  name: string
  topic: string
  requirement: Requirement | null
  onboarding: {
    messages: OnboardMsg[]
    step: number
    agentTyping: boolean
    summaryReady: boolean
  }
  routeNote: string
  stages: Stage[]
  currentUnitId: string | null
  view: SpaceView
  sessions: Session[]
  activeSessionIds: Record<string, string>
  files: CodeFile[]
  directories: ProjectDirectory[]
  expandedDirectoryIds: string[]
  selectedEntryId: string | null
  openFileIds: string[]
  activeFileId: string | null
  terminal: TermLine[]
  terminalDirectoryId: string | null
  running: boolean
  env: EnvStatus
  envLabel: string
  ideOpen: boolean
  ideFullscreen: boolean
  explorerOpen: boolean
  agentOpen: boolean
  draft: AssessmentDraft | null
  records: AssessmentRecord[]
  viewingRecordId: string | null
  completed: boolean
  lastActive: number
}

export interface Controls {
  failNextReply: boolean
  failNextGeneration: boolean
  assessmentOverride: 'auto' | 'pass' | 'needs_work'
}

export interface AppState {
  spaces: Space[]
  currentSpaceId: string | null
  globalView: 'home' | 'spaces'
  controls: Controls
}

export type LessonBlock =
  | { type: 'h2'; id: string; text: string }
  | { type: 'p'; text: string }
  | { type: 'markdown'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'code'; file: string; language: string; code: string; caption?: string }
  | { type: 'callout'; title: string; text: string }
  | { type: 'practice'; items: string[] }
  | { type: 'diagram-move' }

export interface Lesson {
  title?: string
  intro: string
  blocks: LessonBlock[]
  content?: string
}

export interface AssessmentSpec {
  revision?: number
  stale?: boolean
  abilities: string[]
  q2Kind?: 'code' | 'reasoning'
  execution?: CodePlan
  q1: { title: string; prompt: string; code?: string }
  q2: { title: string; prompt: string; starter: string; file: string; expected?: string }
}
