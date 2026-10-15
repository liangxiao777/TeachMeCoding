import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Lesson, LessonProposal, RouteContent, UnitDetail } from '@teach-me-coding/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { math } from '@streamdown/math'
import type { Nodes } from 'mdast'
import { composeReply } from './agent-script'
import { findUnit, newSession, pytorchSpace, rustInProgressSpace } from './demo-data'
import { activeSession, ensureSession, selectSession, sessionUnitId } from './sessions'
import { availableUnitIds, canAccessView, nextUnit, recommendedUnit } from '../app/selectors'
import { diffRoute, routeDiffSummary } from '../app/route-diff'
import { assessmentNeedsRefresh, lessonProposalStale, lessonView, mergeProposals, mergeUnitDetail, pendingDecision } from '../app/lesson-proposals'
import { diffLesson, lessonDiffAllowedTags, lessonDiffRemark, lessonDiffTree, lessonTokens } from '../lib/lesson-diff'
import { lessonAllowedTags, lessonHeadings, lessonRemarkPlugins } from '../lib/lesson-markdown'
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

test('lesson-only historical passes are deferred without treating old evidence as current', () => {
  const space = rustInProgressSpace(), ownership = findUnit(space, 'ownership')!
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

test('lesson display preserves the lesson title and all legacy fields without changing a route title', () => {
  const route = rustInProgressSpace(), unit = findUnit(route, 'ownership')!, routeTitle = unit.title
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

const teachingSource = [
  '## 重复标题', '重复正文', '重复正文', '[跨段链接][ref] 和脚注[^ref]',
  '```rust file="demo.rs"\nlet a = "```";\n  keep_spaces();\n```',
  '> [!TIP]\n> 提示里的 [引用][ref]', '> [!WARNING]\n> 不要遗漏警告',
  '::::practice\n练习题 [引用][ref]\n\n:::hint\n提示内容\n:::\n\n:::solution\n参考讲解\n:::\n::::',
  '| 列一 | 列二 |\n| --- | --- |\n| 值 | [引用][ref] |',
  '$$\nx^2 + y^2\n$$', '```mermaid\ngraph LR\nA-->B\n```',
  '[ref]: https://example.com/old "旧定义"', '[^ref]: 旧脚注 [引用][ref]',
].join('\n\n') + '\n'

function allNodes(node: Nodes): Nodes[] {
  return [node, ...('children' in node ? node.children.flatMap(allNodes) : [])]
}

test('lesson block diff is lossless with asymmetric repeated blocks, definitions, code and teaching grammar', () => {
  const before = '\n' + teachingSource
  const after = ('新增开头\n\n' + teachingSource).replace('重复正文\n\n重复正文', '重复正文')
    .replace('keep_spaces();', 'new_code();').replace('example.com/old', 'example.com/new').replace('旧脚注', '新脚注')
  const diff = diffLesson(before, after), snapshot = structuredClone(diff)
  assert.equal(diff.fallback, false)
  assert.equal(diff.rows.filter((row) => row.before).map((row) => row.before!.source).join(''), before)
  assert.equal(diff.rows.filter((row) => row.after).map((row) => row.after!.source).join(''), after)
  assert.equal(lessonTokens(before).map((token) => token.source).join(''), before)
  assert.equal(diff.rows.some((row) => row.change === 'removed' && row.before?.node?.type === 'code' && row.before.node.value.includes('keep_spaces();')), true)
  assert.equal(diff.rows.some((row) => row.change === 'added' && row.after?.node?.type === 'code' && row.after.node.value.includes('new_code();')), true)
  assert.equal(diff.rows.some((row) => row.change === 'unchanged' && row.after?.source.includes('跨段链接')), false, 'Definition-only changes affect the rendered reference block too')
  const tree = lessonDiffTree(diff, 'proposal', false), nodes = allNodes(tree)
  assert.equal(nodes.some((node) => node.data?.hName === 'lesson-practice'), true)
  assert.equal(nodes.some((node) => node.data?.hName === 'lesson-hint'), true)
  assert.equal(nodes.some((node) => node.data?.hName === 'lesson-solution'), true)
  assert.equal(nodes.some((node) => node.type === 'table'), true)
  assert.equal(nodes.some((node) => String(node.type) === 'math'), true)
  assert.equal(nodes.some((node) => node.type === 'code' && node.lang === 'mermaid' && node.value.includes('A-->B')), true)
  assert.equal(nodes.filter((node) => node.type === 'definition').length >= 2, true)
  assert.equal(nodes.filter((node) => node.type === 'footnoteDefinition').length >= 2, true, 'Link and footnote namespaces can use the same identifier')
  const ids = nodes.filter((node) => node.type === 'heading').map((node) => String(node.data?.hProperties?.id))
  const drawerIds = allNodes(lessonDiffTree(diff, 'proposal', true)).filter((node) => node.type === 'heading').map((node) => String(node.data?.hProperties?.id))
  assert.equal(new Set([...ids, ...drawerIds]).size, ids.length + drawerIds.length)
  assert.deepEqual(diff, snapshot, 'Rendering never mutates the immutable review snapshot')
})

test('combined lesson AST renders old/new cross-block reference scopes and matching TOC anchors', () => {
  const before = '## 相同标题\n\n[引用][ref]\n\n## 相同标题\n\n[ref]: https://example.com/old\n'
  const after = '插入开头\n\n' + before.replace('example.com/old', 'example.com/new')
  const diff = diffLesson(before, after)
  const html = renderToStaticMarkup(createElement(Streamdown, { mode: 'static', parseIncompleteMarkdown: false, controls: false,
    normalizeHtmlIndentation: false, plugins: { cjk, math }, children: after, linkSafety: { enabled: false },
    allowedTags: { ...lessonAllowedTags, ...lessonDiffAllowedTags },
    remarkPlugins: [...lessonRemarkPlugins, [lessonDiffRemark, { diff, proposalId: 'test-proposal', inDrawer: false }]],
  }))
  assert.match(html, /href="https:\/\/example.com\/old"/)
  assert.match(html, /href="https:\/\/example.com\/new"/)
  for (const heading of lessonHeadings(after, false, 'test-proposal-after')) assert.equal(html.includes(`id="${heading.id}"`), true)
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length)
  assert.match(html, /change="removed"/)
  assert.match(html, /change="added"/)
})

test('single-panel lesson review exposes link targets, separator whitespace and equivalent Markdown inline', () => {
  const before = '\n## 保留上下文\n\n[参数资料](https://docs.example.org/old "旧说明")\n\n**保留正文**\r\n\r\n末段'
  const after = '\n\n## 保留上下文\n\n\n[参数资料](https://docs.example.org/new "新说明")\n\n__保留正文__\n\n末段\n'
  const html = renderToStaticMarkup(createElement(Streamdown, { mode: 'static', parseIncompleteMarkdown: false, controls: false,
    normalizeHtmlIndentation: false, plugins: { cjk, math }, children: after, linkSafety: { enabled: false },
    allowedTags: { ...lessonAllowedTags, ...lessonDiffAllowedTags },
    remarkPlugins: [...lessonRemarkPlugins, [lessonDiffRemark, { diff: diffLesson(before, after), proposalId: 'inline', inDrawer: false }]],
  }))
  assert.equal((html.match(/>保留上下文<\/h2>/g) ?? []).length, 1, 'Unchanged context stays rendered once')
  assert.match(html, /lesson-change-note/)
  assert.match(html, />https:\/\/docs.example.org\/old</, 'The old target is visible text, not only a hidden href')
  assert.match(html, />https:\/\/docs.example.org\/new</, 'The new target is visible without opening a link')
  assert.match(html, /段前空白/)
  assert.match(html, /段后空白/)
  assert.match(html, /␍↵/)
  assert.match(html, /\*\*保留正文\*\*/)
  assert.match(html, /__保留正文__/)
  assert.match(html, />保留正文<\//, 'Formatting notes supplement the rendered lesson')
})

test('lesson diff preserves whitespace, CRLF, empty documents and final newline', () => {
  for (const [before, after] of [['a  \r\n\tb\r\n', 'a \nb\n'], ['', 'new\n'], ['gone\n', ''], ['same', 'same\n']]) {
    const diff = diffLesson(before!, after!)
    assert.equal(diff.rows.filter((row) => row.before).map((row) => row.before!.source).join(''), before)
    assert.equal(diff.rows.filter((row) => row.after).map((row) => row.after!.source).join(''), after)
  }
})

test('bounded lesson diff aborts and large-input guards retain both complete documents', () => {
  for (const bounds of [{ maxEditLength: 0 }, { timeout: -1 }, { maxChars: 1 }, { maxTokens: 1 }]) {
    const result = diffLesson('old\n', 'new\n', bounds)
    assert.equal(result.fallback, true)
    assert.equal(result.before, 'old\n')
    assert.equal(result.after, 'new\n')
  }
  const large = 'x'.repeat(200_001), manyLines = '\n'.repeat(4001)
  for (const before of [large, manyLines]) {
    const result = diffLesson(before, 'complete-new-end')
    assert.equal(result.fallback, true)
    assert.equal(result.before, before)
    assert.equal(result.after, 'complete-new-end')
  }
  assert.equal(diffLesson('same', 'same').rows.every((row) => row.change === 'unchanged'), true)
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
