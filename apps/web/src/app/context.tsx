import { createContext, useContext, type ReactNode } from 'react'
import type { AgentDisplayPart, LearningConclusion, ProjectFile, Proposal, WorkStatus } from '@teach-me-coding/contracts'
import type { AppState, AssessmentDraft, AssessmentSpec, Lesson, Quote, Requirement, Session, Space, SpaceView, Unit } from './types'
import type { LocalTerminal } from '@/lib/terminal'

type Action = () => void
type EntryResult = string | null | Promise<string | null>

/** Data and actions consumed by the original UI, independent of storage or demo scripts. */
export interface AppModel {
  state: Pick<AppState, 'spaces' | 'currentSpaceId' | 'globalView'>
  current: Space | null
  session?: Session
  localTerminal?: LocalTerminal
  capabilities: { agent: boolean; terminal: boolean; assessment: boolean }
  lesson: (unit: Unit) => Lesson | null
  assessment: (unit: Unit) => AssessmentSpec | null
  goHome: Action
  goSpaces: Action
  openSpace: (id: string) => void
  createSpace: (goal: string) => void
  onboardSend: (text: string) => void
  updateRequirement: (value: Partial<Requirement>) => void | Promise<boolean>
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
  /** Only real storage has manual-save/conflict states. Absent in the isolated preview. */
  persistence?: {
    ready: boolean
    busy: boolean
    error: string
    retry: Action
    requirementConfirmed: boolean
    planning: { run?: WorkStatus; error: string | null }
    requirementDraft: Requirement | null
    setRequirementDraft: (value: Requirement | null) => void
    saveName: Action
    assessmentDirty: boolean
    fileDirty: boolean
    unsavedFiles: string[]
    saveFiles: Action
    saveAssessment: Action
    saveFile: Action
    compareFile: Action
    refreshFiles: Action
    disk: ProjectFile | null
    resolveFile: (keepLocal: boolean) => void
    proposals: Proposal[]
    applyProposal: (id: string) => void
    conclusions: LearningConclusion[]
    decideConclusion: (id: string, adopted: boolean) => void
    tasks: WorkStatus[]
    taskParts: Record<string, AgentDisplayPart[]>
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
