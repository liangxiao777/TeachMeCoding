import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeReply } from './agent-script'
import { findUnit, newSession, pytorchSpace, rustInProgressSpace } from './demo-data'
import { activeSession, ensureSession, selectSession, sessionUnitId } from './sessions'
import type { Space } from './types'

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
