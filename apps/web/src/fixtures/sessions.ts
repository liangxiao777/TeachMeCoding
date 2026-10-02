import { newSession } from './demo-data'
import type { Session, Space } from './types'

const scopeKey = (unitId: string | null) => unitId === null ? 'route' : `unit:${unitId}`

export function sessionUnitId(space: Space): string | null {
  if (space.view === 'result') return space.records.find((r) => r.id === space.viewingRecordId)?.unitId ?? null
  if (space.view === 'assessment') return space.draft?.unitId ?? space.currentUnitId
  return space.view === 'unit' ? space.currentUnitId : null
}

export function activeSession(space: Space): Session | undefined {
  const unitId = sessionUnitId(space)
  const id = space.activeSessionIds[scopeKey(unitId)]
  return space.sessions.find((s) => s.id === id && s.unitId === unitId)
}

export function selectSession(space: Space, session: Session): Space {
  if (session.unitId !== sessionUnitId(space)) return space
  return { ...space, activeSessionIds: { ...space.activeSessionIds, [scopeKey(session.unitId)]: session.id } }
}

export function ensureSession(space: Space): { space: Space; session: Session } {
  const active = activeSession(space)
  if (active) return { space, session: active }
  const session = newSession(sessionUnitId(space))
  return { space: selectSession({ ...space, sessions: [session, ...space.sessions] }, session), session }
}
