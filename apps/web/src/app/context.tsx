import { createContext, useContext, type ReactNode } from 'react'
import type { ActionProposal, AgentContext, AgentDisplayPart, CodeExecution, IntakeMetadata, IntakeReadiness, LearningConclusion, LessonProposal, Proposal, QuestionAnswer, QuestionRound, ResearchDossier, ResearchRef, WorkStatus } from '@teach-me-coding/contracts'
import type { AppState, AssessmentDraft, AssessmentSpec, Lesson, Quote, Requirement, Session, Space, SpaceView, Unit } from './types'
import type { LocalTerminal } from '@/lib/terminal'
import type { NoticeValue } from '@/i18n/notice'

type Action = () => void
type EntryResult = NoticeValue | null | Promise<NoticeValue | null>
export type RequirementDraft = Requirement & { intake?: IntakeMetadata | null }

/** Data and actions consumed by the original UI, independent of storage or demo scripts. */
export interface AppModel {
  state: Pick<AppState, 'spaces' | 'currentSpaceId' | 'globalView'>
  current: Space | null
  session?: Session
  localTerminal?: LocalTerminal
  capabilities: { agent: boolean; terminal: boolean; assessment: boolean }
  /** Re-read server capabilities after model settings change. Absent in the isolated preview. */
  refreshCapabilities?: () => void
  lesson: (unit: Unit) => Lesson | null
  assessment: (unit: Unit) => AssessmentSpec | null
  goHome: Action
  goSpaces: Action
  openSpace: (id: string) => void
  createSpace: (goal: string) => void
  onboardSend: (text: string) => void
  updateRequirement: (value: Partial<RequirementDraft>) => void | Promise<boolean>
  renameSpace: (name: string) => void
  confirmRequirement: Action
  setView: (view: SpaceView) => void
  enterUnit: (id: string) => void
  retryGeneration: (id: string) => void
  setComposerText: (text: string) => void
  setRouteSuggestion: (text: string) => void
  setQuote: (quote: Quote | null) => void
  sendMessage: (text?: string) => boolean | Promise<boolean>
  stopReply: Action
  retryReply: (id: string) => void
  applyRouteAction: (id: string) => void
  newSession: Action
  switchSession: (id: string) => void
  toggleAgent: (open?: boolean) => void
  toggleIde: (open?: boolean) => void
  setIdeFullscreen: (full: boolean) => void
  toggleExplorer: Action
  selectEntry: (id: string | null) => void
  toggleDirectory: (id: string, open?: boolean) => void
  collapseDirectories: Action
  createEntry: (name: string, kind: 'file' | 'directory', parent: string | null) => EntryResult
  renameEntry: (id: string, name: string) => EntryResult
  openFile: (id: string) => void
  closeFile: (id: string) => void
  createFile: (name: string) => void
  updateFile: (id: string, content: string) => void
  bringToIde: (code: string, name?: string) => void
  connectEnv: Action
  terminalCommand: (command: string) => void
  startAssessment: Action
  updateDraft: (patch: Partial<AssessmentDraft>) => void
  runDraft: Action
  submitAssessment: Action
  leaveAssessment: Action
  viewRecord: (id: string) => void
  goNextUnit: Action
  backToStudy: Action
  /** Real storage state and operations. Absent in the isolated preview. */
  persistence?: {
    ready: boolean
    busy: boolean
    error: NoticeValue
    retry: Action
    setYolo: (enabled: boolean, sessionId?: string) => void
    dequeuePrompt: (id: string) => Promise<boolean>
    requirementConfirmed: boolean
    planning: { run?: WorkStatus; error: NoticeValue | null }
    intake: IntakeMetadata | null
    readiness?: IntakeReadiness
    questions: QuestionRound[]
    answerQuestions: (round: string, answers: QuestionAnswer) => Promise<boolean>
    loadResearch: (ref: ResearchRef) => Promise<ResearchDossier>
    saveResearch: (ref: ResearchRef, content: string) => Promise<ResearchDossier>
    exportResearch: (ref: ResearchRef) => Promise<void>
    requirementDraft: RequirementDraft | null
    setRequirementDraft: (value: RequirementDraft | null) => void
    saveName: Action
    assessmentDirty: boolean
    fileDirty: boolean
    fileSaveError: NoticeValue
    fileRenaming: boolean
    filesPending: boolean
    saveAssessment: Action
    refreshFiles: Action
    proposals: Proposal[]
    routeRevision: number
    requirementRevision: number
    routeAdjustmentRun?: WorkStatus
    applyProposal: (id: string) => void
    rejectProposal: (id: string, feedback: string) => Promise<boolean>
    lessonProposals: LessonProposal[]
    lessonVersions: Record<string, number | undefined>
    reviewLessonProposal: (id: string) => void
    applyLessonProposal: (id: string) => void
    rejectLessonProposal: (id: string, feedback: string) => Promise<boolean>
    conclusions: LearningConclusion[]
    decideConclusion: (id: string, adopted: boolean) => void
    actions: ActionProposal[]
    decideAction: (id: string, decision: 'confirm' | 'reject' | 'cancel') => void
    execution?: CodeExecution
    stopExecution: (id: string) => void
    tasks: WorkStatus[]
    taskParts: Record<string, AgentDisplayPart[]>
    runContexts: Record<string, { sequence: number; context: AgentContext }>
    generateAssessment: Action
    retryTask: (id: string) => void
    stopTask: (id: string) => void
  }
}

const Context = createContext<AppModel | null>(null)
export function AppModelProvider({ value, children }: { value: AppModel; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useApp() {
  const model = useContext(Context)
  if (!model) throw new Error('useApp requires AppModelProvider')
  return model
}
export function useSpace() {
  const { current } = useApp()
  if (!current) throw new Error('No current space')
  return current
}
