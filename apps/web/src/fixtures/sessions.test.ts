import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RouteContent } from '@teach-me-coding/contracts'
import { composeReply } from './agent-script'
import { findUnit, newSession, pytorchSpace, rustInProgressSpace } from './demo-data'
import { activeSession, ensureSession, selectSession, sessionUnitId } from './sessions'
import { availableUnitIds, canAccessView, recommendedUnit } from '../app/selectors'
import { diffRoute, routeDiffSummary } from '../app/route-diff'
import type { Space } from './types'

test('unit access uses published lessons, not skipped status or regeneration state', () => {
  const space = rustInProgressSpace(), first = space.stages[0]!.units[0]!
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
  const space = rustInProgressSpace()
  const originalId = space.currentUnitId
  const session = activeSession(space)
  assert.equal(recommendedUnit(space)?.id, 'ownership', 'Future courseware must not displace unfinished learning')
  assert.equal(recommendedUnit({ ...space, currentUnitId: 'basics' })?.id, 'ownership', 'Viewing a past unit does not change the recommendation')
  const supplement = { ...space.stages[1]!.units[0]!, id: 'supplement', title: '补充基础', contentState: 'none' as const }
  space.stages[0]!.units.unshift(supplement)
  assert.equal(recommendedUnit(space), supplement)
  assert.equal(space.currentUnitId, originalId)
  assert.equal(activeSession(space), session)
  assert.equal(availableUnitIds(space).has('ownership'), true, 'Existing courseware remains accessible after insertion')
})

test('route and individual units restore separate sessions, drafts and quotes', () => {
  let space = rustInProgressSpace()
  const course = activeSession(space)!
  course.composerText = '解释这段代码'
  course.composerQuote = { source: 'code', label: 'move_demo.rs', text: 'let s2 = s1;' }

  space = { ...space, view: 'route' }
  assert.equal(activeSession(space), undefined)
  const route = ensureSession(space)
  route.session.composerText = '每周只学三小时'
  route.session.routeSuggestion = '先做项目'
  space = route.space
  assert.equal(route.session.unitId, null)
  assert.equal(route.session.composerQuote, null)
  assert.deepEqual(route.session.messages, [])

  space = ensureSession({ ...space, view: 'unit', currentUnitId: 'structs' }).space
  const otherCourse = activeSession(space)!
  assert.notEqual(otherCourse.id, course.id)
  assert.notEqual(otherCourse.id, route.session.id)
  assert.equal(otherCourse.unitId, 'structs')
  assert.equal(otherCourse.composerText, '')
  assert.equal(otherCourse.composerQuote, null)
  assert.deepEqual(otherCourse.messages, [])

  space = { ...space, currentUnitId: 'ownership' }
  assert.equal(activeSession(space), course)
  assert.equal(activeSession(space)?.composerText, '解释这段代码')
  assert.equal(activeSession(space)?.composerQuote?.text, 'let s2 = s1;')
  space = { ...space, view: 'route' }
  assert.equal(activeSession(space), route.session)
  assert.equal(activeSession(space)?.composerText, '每周只学三小时')
  assert.equal(activeSession(space)?.routeSuggestion, '先做项目')
  // Changing the recommended unit must not change route conversation ownership.
  assert.equal(activeSession({ ...space, currentUnitId: 'basics' }), route.session)
  assert.equal(ensureSession(space).space.sessions.length, 3)
})

test('each scope remembers the selected history item, not simply its newest session', () => {
  let space = rustInProgressSpace()
  const original = activeSession(space)!
  const newer = newSession('ownership')
  space = selectSession({ ...space, sessions: [newer, ...space.sessions] }, newer)
  assert.equal(activeSession(space), newer)
  space = selectSession(space, original)
  space = ensureSession({ ...space, view: 'route' }).space
  const route = activeSession(space)!
  assert.equal(selectSession(space, original), space)
  assert.equal(activeSession(space), route)
  space = { ...space, view: 'unit' }
  assert.equal(activeSession(space), original)
  assert.equal(selectSession(space, route), space)
  assert.equal(activeSession({ ...space, view: 'route' }), route)
})

test('assessment and historical results use their owning unit, not the current lesson', () => {
  let space = rustInProgressSpace()
  space = ensureSession({ ...space, view: 'unit', currentUnitId: 'structs' }).space
  const structs = activeSession(space)!
  const assessment: Space = {
    ...space, view: 'assessment', currentUnitId: 'ownership',
    draft: { unitId: 'structs', state: 'ready', q1: '', q2: '', q2Output: null, q2Running: false, attempt: 1 },
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

test('reply behavior follows the session, even after navigating elsewhere', () => {
  const space = rustInProgressSpace()
  const route = newSession(null)
  const course = activeSession(space)!
  const base = { space, text: '我想先做项目', inAssessment: false }
  assert.equal(composeReply({ ...base, session: route }).action, 'project-first')
  assert.equal(composeReply({ ...base, session: course, unit: findUnit(space, course.unitId) }).action, undefined)
  const routeReply = composeReply({ ...base, session: route, text: '之前的安排怎么样？' })
  assert.match(routeReply.text, /学习路线|这条路线/)
  assert.doesNotMatch(routeReply.text, /理解所有权转移|当前单元|move_demo/)
  const assessmentReply = composeReply({
    ...base, space: { ...space, view: 'route' }, session: course,
    unit: findUnit(space, course.unitId), text: '为什么？', inAssessment: true,
  })
  assert.match(assessmentReply.text, /不直接给出答案/)
})

test('a new conversation does not claim to remember another conversation', () => {
  const space = rustInProgressSpace()
  const reply = composeReply({ space, session: newSession('ownership'), text: '之前那个呢？', inAssessment: false })
  assert.doesNotMatch(reply.text, /理解所有权转移|我们在|当时的结论/)
  const pytorch = pytorchSpace()
  const tensorReply = composeReply({ space: pytorch, session: newSession('tensors'), text: 'RuntimeError', inAssessment: false })
  assert.doesNotMatch(tensorReply.text, /之前|讨论的一样/)
  const routeReply = composeReply({ space: pytorch, session: newSession(null), text: '怎么安排？', inAssessment: false })
  assert.match(routeReply.text, /图像分类模型/)
  assert.doesNotMatch(routeReply.text, /tensor_basics|所有权/)
})

const routeUnit = (id: string) => ({ id, title: id, summary: `${id} 摘要`, goals: [`${id} 目标`] })
const routeStage = (id: string, unitIds: string[]) => ({ id, title: id, units: unitIds.map(routeUnit) })

test('route diff covers initial proposals and unchanged routes without mutating either version', () => {
  const route: RouteContent = { note: '路线说明', stages: [routeStage('s1', ['a', 'b'])] }
  const snapshot = structuredClone(route)
  const initial = diffRoute(null, route)
  assert.equal(initial.stages[0]!.change, 'added')
  assert.deepEqual(initial.stages[0]!.units.map((unit) => unit.change), ['added', 'added'])
  assert.equal(initial.counts.moved, 0)
  assert.equal(routeDiffSummary(initial), '新增阶段 1 · 新增 2 个单元 · 安排说明已修改')
  assert.equal(routeDiffSummary(diffRoute(route, structuredClone(route))), '路线内容未改变')
  assert.deepEqual(route, snapshot)
})

test('route diff retains deletions inline and does not call insertion or deletion a move', () => {
  const before: RouteContent = { note: '', stages: [routeStage('s1', ['a', 'b', 'c']), routeStage('s2', ['d']), routeStage('s3', ['e'])] }
  const after: RouteContent = { note: '', stages: [routeStage('front', ['f']), routeStage('s1', ['n', 'a', 'm', 'c']), routeStage('middle', ['g']), routeStage('s3', ['e'])] }
  const diff = diffRoute(before, after)
  assert.deepEqual(diff.stages.map((stage) => stage.id), ['front', 's1', 'middle', 's2', 's3'])
  assert.deepEqual(diff.stages.find((stage) => stage.id === 's1')!.units.map((unit) => [unit.id, unit.change]), [
    ['n', 'added'], ['a', 'unchanged'], ['m', 'added'], ['b', 'removed'], ['c', 'unchanged'],
  ])
  assert.equal(diff.stages.find((stage) => stage.id === 's2')!.units[0]!.change, 'removed')
  assert.equal(diff.stages.some((stage) => stage.moved), false)
  assert.equal(diff.counts.moved, 0)
  assert.equal(routeDiffSummary(diff), '新增阶段 2 · 删除阶段 1 · 新增 4 个单元 · 删除 2 个单元')
})

test('route diff marks actual stage and unit reorderings rather than every shifted position', () => {
  const before: RouteContent = { note: '', stages: [routeStage('s1', ['a', 'b', 'c']), routeStage('s2', ['d']), routeStage('s3', ['e'])] }
  const after: RouteContent = { note: '', stages: [routeStage('s3', ['e']), routeStage('s1', ['c', 'a', 'b']), routeStage('s2', ['d'])] }
  const diff = diffRoute(before, after)
  assert.deepEqual(diff.stages.filter((stage) => stage.moved).map((stage) => stage.id), ['s3'])
  const units = diff.stages.flatMap((stage) => stage.units)
  assert.deepEqual(units.filter((unit) => unit.movedFrom).map((unit) => unit.id), ['c'])
  assert.match(units.find((unit) => unit.id === 'c')!.movedFrom!, /原第 3 个/)
  assert.equal(routeDiffSummary(diff), '调整阶段 1 · 移动 1 个单元')
})

test('route diff shows transferred units once, including moves out of a deleted stage', () => {
  const before: RouteContent = { note: '', stages: [routeStage('s1', ['a', 'b']), routeStage('s2', ['c'])] }
  const after: RouteContent = { note: '', stages: [routeStage('s2', ['c', 'a']), routeStage('new-group', ['b'])] }
  const diff = diffRoute(before, after)
  assert.equal(diff.stages.find((stage) => stage.id === 's1')!.change, 'removed')
  assert.deepEqual(diff.stages.find((stage) => stage.id === 's1')!.units, [])
  const units = diff.stages.flatMap((stage) => stage.units)
  assert.deepEqual(units.map((unit) => unit.id), ['c', 'a', 'b'])
  for (const id of ['a', 'b']) {
    const unit = units.find((unit) => unit.id === id)!
    assert.equal(unit.change, 'unchanged')
    assert.match(unit.movedFrom!, /从「s1」移入/)
    assert.deepEqual(unit.before?.goals, unit.after?.goals)
  }
  assert.equal(routeDiffSummary(diff), '新增阶段 1 · 删除阶段 1 · 移动 2 个单元')
})

test('route diff includes title, summary, goals, stage names and arrangement-note changes', () => {
  const before: RouteContent = { note: '原说明', stages: [routeStage('s1', ['a', 'b', 'c'])] }
  const after = structuredClone(before)
  after.note = '新说明'
  after.stages[0]!.title = '勘误后的阶段名称'
  after.stages[0]!.units[0]!.title = '勘误后的单元名称'
  after.stages[0]!.units[1]!.summary = '补充边界情况'
  after.stages[0]!.units[2]!.goals = []
  const diff = diffRoute(before, after)
  assert.equal(diff.stages[0]!.change, 'modified')
  assert.deepEqual(diff.stages[0]!.units.map((unit) => unit.change), ['modified', 'modified', 'modified'])
  assert.equal(diff.stages[0]!.units[1]!.before?.summary, 'b 摘要')
  assert.equal(diff.stages[0]!.units[1]!.after?.summary, '补充边界情况')
  assert.deepEqual(diff.stages[0]!.units[2]!.before?.goals, ['c 目标'])
  assert.deepEqual(diff.stages[0]!.units[2]!.after?.goals, [])
  assert.deepEqual(diff.note, { before: '原说明', after: '新说明' })
  assert.equal(routeDiffSummary(diff), '调整阶段 1 · 修改 3 个单元 · 安排说明已修改')
  assert.deepEqual(before.stages[0]!.units.map((unit) => unit.title), ['a', 'b', 'c'])
})
