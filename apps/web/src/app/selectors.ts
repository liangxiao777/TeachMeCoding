import { unlockedUnitIds } from '@teach-me-coding/contracts'
import type { CodeFile, Session, Space, SpaceView, Unit } from './types'

export const allUnits = (space: Space): Unit[] => space.stages.flatMap((stage) => stage.units)
export const findUnit = (space: Space, id: string | null): Unit | undefined => allUnits(space).find((unit) => unit.id === id)
export const needsLearning = (unit: Unit) => unit.status !== 'passed' && unit.status !== 'skipped'
  && !(unit.status === 'learning' && unit.historicalPass)
export function availableUnitIds(space: Space): Set<string> {
  const units = allUnits(space)
  return unlockedUnitIds(units, new Set(units.filter((unit) => unit.hasLesson ?? unit.contentState === 'ready').map((unit) => unit.id)),
    new Set(units.filter((unit) => unit.started || unit.active).map((unit) => unit.id)))
}
function unpublishedGap(units: Unit[], available: ReadonlySet<string>): Unit | undefined {
  const lastStarted = units.findLastIndex((unit) => unit.started || unit.active || (unit.hasLesson ?? unit.contentState === 'ready'))
  // Catch up an inserted gap before retained learning; ordinary future units
  // must not take priority over the unfinished unit the learner already began.
  return units.slice(0, lastStarted).find((unit) => available.has(unit.id) && !(unit.hasLesson ?? unit.contentState === 'ready') && unit.status !== 'skipped')
}
export function recommendedUnit(space: Space): Unit | undefined {
  const available = availableUnitIds(space), units = allUnits(space)
  // Recommendation follows learning progress, not the unit currently viewed.
  return unpublishedGap(units, available)
    ?? units.find((unit) => available.has(unit.id) && needsLearning(unit))
}
export function canAccessView(space: Space, view: SpaceView, unitId: string | null): boolean {
  if (!['unit', 'assessment', 'result'].includes(view)) return true
  // The workspace also hosts code from chat before any learning unit exists.
  if (!unitId) return view === 'unit'
  return availableUnitIds(space).has(unitId)
}
export function nextUnit(space: Space, id: string): Unit | undefined {
  const units = allUnits(space)
  const available = availableUnitIds(space)
  const gap = unpublishedGap(units, available)
  return gap && gap.id !== id ? gap
    : units.slice(units.findIndex((unit) => unit.id === id) + 1).find((unit) => available.has(unit.id) && needsLearning(unit))
}
export function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hours = Math.floor(min / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}
export function sessionUnitId(space: Space): string | null {
  if (space.view === 'result') return space.records.find((record) => record.id === space.viewingRecordId)?.unitId ?? null
  if (space.view === 'assessment') return space.draft?.unitId ?? space.currentUnitId
  return space.view === 'unit' ? space.currentUnitId : null
}
export const sessionScope = (space: Space) => space.view === 'onboarding' || space.view === 'planning' ? 'intake' : sessionUnitId(space) ? 'unit' : 'route'
export function scopedSessions(space: Space): Session[] {
  return space.sessions.filter((session) => session.unitId === sessionUnitId(space) && (session.scope ?? (session.unitId ? 'unit' : 'route')) === sessionScope(space))
}
export function activeSession(space: Space): Session | undefined {
  const key = sessionScope(space) === 'unit' ? `unit:${sessionUnitId(space)}` : sessionScope(space)
  const sessions = scopedSessions(space)
  return sessions.find((session) => session.id === space.activeSessionIds[key]) ?? sessions[0]
}
export const fileLanguage = (name: string): CodeFile['language'] => name.endsWith('.rs') ? 'rust' : name.endsWith('.py') ? 'python' : 'text'
export function entryPath(space: Space, id: string | null): string {
  const entry = [...space.directories, ...space.files].find((entry) => entry.id === id)
  if (!entry) return ''
  const parent = entryPath(space, entry.parentId)
  return parent ? `${parent}/${entry.name}` : entry.name
}
export function projectChildren(space: Space, parentId: string | null) {
  return [
    ...space.directories.filter((entry) => entry.parentId === parentId).map((entry) => ({ ...entry, kind: 'directory' as const })),
    ...space.files.filter((entry) => entry.parentId === parentId).map((entry) => ({ ...entry, kind: 'file' as const })),
  ].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'directory' ? -1 : 1)
}
