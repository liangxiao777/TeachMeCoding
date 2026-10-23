import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Lesson, LessonProposal, UnitDetail } from '@teach-me-coding/contracts'
import { assessmentNeedsRefresh, lessonProposalStale, lessonView, mergeProposals, mergeUnitDetail, pendingDecision } from './lesson-proposals'

test('lesson display preserves the lesson title and all legacy fields without changing a route title', () => {
  const unit = { title: '所有权与借用' }, routeTitle = unit.title
  const lesson: Lesson = { title: '课件独立标题', revision: 3, content: '## 正文\r\n\r\n正文  \r\n', intro: '旧版导语', blocks: [
    { type: 'h2', id: 'legacy', text: '## 旧版小节\n\n不可丢失的旧正文' },
    { type: 'code', language: 'rust', file: 'keep.rs', code: 'let fence = "```";\n\n', caption: '不可丢失的说明' },
    { type: 'practice', items: ['旧练习'] },
  ] }
  const snapshot = structuredClone(lesson), view = lessonView(lesson)
  assert.equal(view.title, '课件独立标题')
  assert.equal(unit.title, routeTitle)
  assert.match(view.content!, /正文  \r\n/)
  assert.match(view.content!, /旧版导语/)
  assert.match(view.content!, /不可丢失的旧正文/)
  assert.match(view.content!, /````rust file="keep.rs"\nlet fence = "```";\n\n````/)
  assert.match(view.content!, /不可丢失的说明/)
  assert.match(view.content!, /旧练习/)
  const legacy = lessonView({ ...lesson, content: '' })
  assert.equal(legacy.content, undefined)
  assert.equal(legacy.intro, '旧版导语')
  assert.deepEqual(legacy.blocks, [
    { type: 'h2', id: 'legacy', text: '旧版小节' }, { type: 'markdown', text: '\n不可丢失的旧正文' }, ...lesson.blocks!.slice(1),
  ], 'Block-only lessons keep their existing cards, code captions and directory anchors')
  assert.deepEqual(lesson, snapshot)
})

const lessonProposal = (): LessonProposal => ({ id: 'proposal', unitId: 'target', sessionId: 'session', source: { kind: 'task', id: 'task' },
  baseRevision: 2, requirementRevision: 3, routeRevision: 4, state: 'pending', feedback: '', note: '修改说明',
  content: { title: '提议标题', content: 'new\n' }, baseLesson: { title: '原课件标题', revision: 2, content: 'old\n' }, references: [{ unitId: 'reference', revision: 1 }] })

test('lesson gates are workspace-wide and reject stale target, requirement, route and reference revisions', () => {
  const proposal = lessonProposal(), versions = { target: 2, reference: 1 }
  assert.equal(pendingDecision({ proposals: [], lessonProposals: [proposal] }), true)
  assert.equal(pendingDecision({ proposals: [], lessonProposals: [{ ...proposal, state: 'applied' }] }), false)
  assert.equal(lessonProposalStale(proposal, 3, 4, true, versions, true), false)
  assert.equal(lessonProposalStale(proposal, 3, 4, true, {}, true), false, 'Unavailable client versions defer to server validation')
  for (const [requirement, route, confirmed, nextVersions, exists] of [
    [4, 4, true, versions, true], [3, 5, true, versions, true], [3, 4, false, versions, true],
    [3, 4, true, { ...versions, target: 3 }, true], [3, 4, true, { ...versions, reference: 2 }, true], [3, 4, true, versions, false],
  ] as const) assert.equal(lessonProposalStale(proposal, requirement, route, confirmed, nextVersions, exists), true)
})

test('terminal lesson decisions and authoritative applied snapshots cannot regress on older refreshes', () => {
  const pending = lessonProposal()
  for (const state of ['applied', 'rejected', 'superseded'] as const) {
    const terminal = { ...pending, state, feedback: state === 'rejected' ? '保存的反馈' : '' }
    assert.deepEqual(mergeProposals([terminal], [pending]), [terminal])
    assert.deepEqual(mergeProposals([pending], [terminal]), [terminal])
    assert.deepEqual(mergeProposals([terminal], []), [terminal])
  }
  const applied: UnitDetail = { id: 'target', status: 'learning', started: true, lesson: { title: '新版标题', content: 'new', revision: 3 },
    assessment: null, draft: { unitId: 'target', revision: 7, q1: '保留的旧答案', q2: 'old code' },
    records: [{ id: 'old-pass', unitId: 'target', attempt: 1, result: 'pass', valid: false, verification: 'non-execution', createdAt: 1,
      lessonRevision: 2, answers: { q1: 'q1', q2: 'q2' }, summary: '旧版通过', mastered: [], concerns: [], evidence: [], toVerify: [] }],
    historicalPass: { recordId: 'old-pass', lessonRevision: 2 } }
  const old = { ...applied, status: 'passed' as const, historicalPass: null, lesson: pending.baseLesson,
    records: applied.records.map((record) => ({ ...record, valid: true })) }
  assert.deepEqual(mergeUnitDetail(applied, old), applied)
  assert.equal(mergeUnitDetail(applied, { ...applied, draft: { ...applied.draft, revision: 6, q1: 'stale' } }).draft.q1, '保留的旧答案')
  assert.equal(mergeUnitDetail(old, applied).records[0]!.valid, false, 'Historical pass never becomes valid current evidence')
  const withOldQuestions = { ...applied, assessment: { revision: 4, q1: '旧题', q2: '', q2Kind: 'reasoning' as const, starter: '' } }
  assert.equal(assessmentNeedsRefresh(withOldQuestions, 3), true, 'A retained old question set is not a latest-lesson assessment')
  const freshQuestions = { ...withOldQuestions, assessmentSources: { lesson: 3, requirement: 3 } }
  assert.equal(assessmentNeedsRefresh(freshQuestions, 3), false, 'Server source metadata keeps fresh questions usable after reload, without a grade or local hint')
  assert.equal(assessmentNeedsRefresh(freshQuestions, 4), true)
  assert.equal(assessmentNeedsRefresh({ ...freshQuestions, lesson: { ...applied.lesson!, revision: 4 } }, 3), true)
})
