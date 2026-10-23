import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeSession, availableUnitIds, canAccessView, conversationMessages, findUnit, nextUnit, recommendedUnit, sessionUnitId } from './selectors'
import type { Message, Session, Space, Unit } from './types'

const unit = (id: string, patch: Partial<Unit> = {}): Unit => ({
  id, title: id, summary: '', goals: [], status: 'not_started', contentState: 'none', lessonKey: id, ...patch,
})
const session = (id: string, unitId: string | null): Session => ({
  id, unitId, title: '', updatedAt: 0, messages: [], composerText: '', composerQuote: null, routeSuggestion: '',
})

/** A route with a skipped first unit, a lesson in progress and unpublished future units. */
function sampleSpace(): Space {
  const ownership = session('sess_ownership', 'ownership')
  return {
    id: 'space', kind: 'generic', name: '', topic: '', requirement: null,
    onboarding: { messages: [], step: 0, agentTyping: false, summaryReady: true },
    routeNote: '',
    stages: [
      { id: 'st1', title: 'st1', units: [unit('basics', { status: 'skipped', contentState: 'ready' }), unit('ownership', { status: 'learning', contentState: 'ready' })] },
      { id: 'st2', title: 'st2', units: [unit('structs'), unit('errors')] },
      { id: 'st3', title: 'st3', units: [unit('cli')] },
    ],
    currentUnitId: 'ownership', view: 'unit',
    sessions: [ownership], activeSessionIds: { 'unit:ownership': ownership.id },
    files: [], directories: [], expandedDirectoryIds: [], selectedEntryId: null, openFileIds: [], activeFileId: null,
    env: 'disconnected', envLabel: '', ideOpen: false, ideFullscreen: false, explorerOpen: true, agentOpen: true,
    draft: null, records: [], viewingRecordId: null, completed: false, lastActive: 0,
  }
}

test('unit access uses published lessons, not skipped status or regeneration state', () => {
  const space = sampleSpace(), first = space.stages[0]!.units[0]!
  assert.deepEqual([...availableUnitIds(space)], ['basics', 'ownership', 'structs'])
  first.contentState = 'none'
  assert.equal(first.status, 'skipped')
  assert.deepEqual(availableUnitIds(space), new Set(['basics', 'ownership']), 'Saved courseware stays accessible beyond a gap')
  for (const state of ['generating', 'failed'] as const) {
    first.contentState = state
    first.hasLesson = true
    assert.deepEqual([...availableUnitIds(space)], ['basics', 'ownership', 'structs'])
    first.hasLesson = false
    assert.deepEqual(availableUnitIds(space), new Set(['basics', 'ownership']))
  }
  assert.equal(canAccessView(space, 'unit', 'ownership'), true)
  assert.equal(canAccessView(space, 'unit', 'structs'), false)
  assert.equal(canAccessView(space, 'route', 'ownership'), true)
  assert.equal(canAccessView(space, 'unit', null), true, 'Code from chat can open an IDE-only workspace without selecting a unit')
  assert.equal(canAccessView(space, 'assessment', null), false)
  assert.equal(canAccessView(space, 'result', null), false)
})

test('an inserted supplement is recommended independently of the viewed unit and its history', () => {
  const space = sampleSpace()
  const originalId = space.currentUnitId
  const current = activeSession(space)
  assert.equal(recommendedUnit(space)?.id, 'ownership', 'Future courseware must not displace unfinished learning')
  assert.equal(recommendedUnit({ ...space, currentUnitId: 'basics' })?.id, 'ownership', 'Viewing a past unit does not change the recommendation')
  const supplement = { ...space.stages[1]!.units[0]!, id: 'supplement', title: '补充基础', contentState: 'none' as const }
  space.stages[0]!.units.unshift(supplement)
  assert.equal(recommendedUnit(space), supplement)
  assert.equal(space.currentUnitId, originalId)
  assert.equal(activeSession(space), current)
  assert.equal(availableUnitIds(space).has('ownership'), true, 'Existing courseware remains accessible after insertion')
})

test('successful retries hide repeated alerts only in their user turn and retain partial content and saved failures', () => {
  const message = (id: string, role: Message['role'], status?: Message['status']): Message => ({ id, role, status, text: '', createdAt: 0 })
  const unrelated = message('unrelated-failure', 'agent', 'error')
  const failures = Array.from({ length: 6 }, (_, index) => message(`failure-${index}`, 'agent', 'error'))
  const partial: Message = { ...message('partial', 'agent', 'error'), text: '保留部分回复', parts: [
    { id: 'reasoning', type: 'reasoning', text: '保留推理', status: 'interrupted' },
    { id: 'tool', type: 'tool', name: 'read', status: 'error' },
  ] }
  const history = [message('older-question', 'user'), message('older-reply', 'agent', 'done'), unrelated,
    message('question', 'user'), ...failures, partial]
  const snapshot = structuredClone(history)
  for (const status of ['thinking', 'streaming', 'stopped', 'error'] as const) {
    const pending = [...history, message('retry', 'agent', status)]
    assert.deepEqual(conversationMessages(pending), pending)
  }
  for (const receipt of [{ sequence: 0 }, { notice: { code: 'LOCAL_ACTION_FAILED' as const } }]) {
    const pending = [...history, { ...message('host-receipt', 'agent', 'done'), ...receipt }]
    assert.deepEqual(conversationMessages(pending), pending, 'A host receipt is not a successful model reply')
  }
  const success = message('retry', 'agent', 'done'), later = message('later-failure', 'agent', 'error')
  assert.deepEqual(conversationMessages([...history, success, later]), [
    ...history.slice(0, 4), { ...partial, status: undefined }, success, later,
  ])
  const revisit = { ...message('revisit', 'agent', 'done'), retryOf: unrelated.id }
  assert.deepEqual(conversationMessages([...history, revisit]), [
    history[0], history[1], ...history.slice(3), revisit,
  ], 'Retrying an older question must not clear errors on the newer question')
  const failedRetry = { ...message('failed-retry', 'agent', 'error'), retryOf: partial.id }
  const newer = [message('newer-question', 'user'), message('newer-error', 'agent', 'error')]
  const recovered = { ...message('recovered', 'agent', 'done'), retryOf: failedRetry.id }
  assert.deepEqual(conversationMessages([...history, failedRetry, ...newer, recovered]), [
    ...history.slice(0, 4), { ...partial, status: undefined }, ...newer, recovered,
  ], 'Success resolves the entire retry chain, not an intervening question')
  const queued = [message('queued-question', 'user'), message('original-error', 'agent', 'error'),
    { ...message('queued-retry', 'agent', 'done'), retryOf: 'original-error' }, message('follow-up', 'user'),
    { ...message('follow-up-error', 'agent', 'error'), runId: 'queued-retry' }]
  assert.deepEqual(conversationMessages(queued), queued, 'A completed segment cannot resolve a retry whose follow-up failed')
  assert.deepEqual(history, snapshot, 'Display cleanup must not rewrite the stored failure or tool history')
})

test('assessment and historical results use their owning unit, not the current lesson', () => {
  const base = sampleSpace(), structs = session('sess_structs', 'structs')
  const space: Space = { ...base, sessions: [...base.sessions, structs], activeSessionIds: { ...base.activeSessionIds, 'unit:structs': structs.id } }
  const assessment: Space = {
    ...space, view: 'assessment', currentUnitId: 'ownership',
    draft: { unitId: 'structs', state: 'ready', q1: '', q2: '', attempt: 1 },
  }
  assert.equal(sessionUnitId(assessment), 'structs')
  assert.equal(activeSession(assessment), structs)
  const result: Space = {
    ...assessment, view: 'result', draft: null, viewingRecordId: 'record-structs',
    records: [{
      id: 'record-structs', unitId: 'structs', unitTitle: '结构体与枚举', attempt: 1,
      result: 'pass', createdAt: 1, answers: { q1: '', q2: '' }, summary: '',
      mastered: [], concerns: [], evidence: [], toVerify: [],
    }],
  }
  assert.equal(sessionUnitId(result), 'structs')
  assert.equal(activeSession(result), structs)
  assert.equal(activeSession({ ...result, view: 'unit' })?.unitId, 'ownership')
})

test('lesson-only historical passes are deferred without treating old evidence as current', () => {
  const space = sampleSpace(), ownership = findUnit(space, 'ownership')!
  ownership.historicalPass = { recordId: 'old-pass', lessonRevision: 1 }
  assert.equal(ownership.status, 'learning')
  assert.equal(recommendedUnit(space)?.id, 'structs')
  assert.equal(nextUnit(space, 'basics')?.id, 'structs')
  assert.equal(canAccessView(space, 'unit', 'ownership'), true, 'Historical learning is still freely accessible')
  ownership.status = 'needs_work'
  assert.equal(recommendedUnit(space)?.id, 'ownership', 'A genuine current needs_work still matters')
  assert.equal(nextUnit(space, 'basics')?.id, 'ownership')
  ownership.status = 'learning'; ownership.historicalPass = null
  assert.equal(recommendedUnit(space)?.id, 'ownership', 'Untrusted/non-pass history cannot defer learning')
})
