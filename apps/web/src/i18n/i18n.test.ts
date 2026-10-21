import assert from 'node:assert/strict'
import { test } from 'node:test'
import { businessErrorResponse, type ActionProposal, type CodeExecution } from '@teach-me-coding/contracts'
import i18n from './index'
import { languagePreference, resolveLanguage } from './locale'
import { formatNotice, notice, NoticeError } from './notice'
import { localizedAssessmentSummary, localizedExecutionFeedback } from './execution'
import { localizedActionReceipt, quoteLabel, receiptProposal, sessionTitle } from './presentation'
import { formatDate, formatNumber, formatRelativeTime } from './format'
import { ApiError } from '../lib/api'

test('language selection respects explicit preferences, browser order, scripts and English fallback', () => {
  for (const [languages, expected] of [
    [['fr-FR', 'en-GB', 'zh-CN'], 'en'], [['ja-JP', 'zh-SG', 'en'], 'zh-CN'],
    [['zh'], 'zh-CN'], [['zh-Hans-TW'], 'zh-CN'], [['ZH-cn'], 'zh-CN'],
    [['zh-TW', 'zh-HK', 'zh-Hant-CN', 'en-AU'], 'en'], [['bad_tag', 'zh-Hans'], 'zh-CN'], [[], 'en'],
  ] as const) assert.equal(resolveLanguage('system', languages), expected)
  assert.equal(resolveLanguage('en', ['zh-CN']), 'en')
  assert.equal(resolveLanguage('zh-CN', ['en-US']), 'zh-CN')
  for (const value of [null, 'fr', 'en-GB', {}, 'system']) assert.equal(languagePreference(value), 'system')
})

test('current notices use only semantic identity and never treat raw failures or params as translation options', async () => {
  const locked = new ApiError(409, { code: 'UNIT_LOCKED', params: { title: '所有权 <T>', lng: 'zh-CN', ns: 'common' } })
  const saving = notice('common', 'errors.autosave', { path: '原始文件.rs', error: locked })
  const thrown = new NoticeError(saving)
  await i18n.changeLanguage('en')
  assert.equal(formatNotice(locked), 'This unit is locked. Generate and save the lesson for “所有权 <T>” first.')
  assert.equal(formatNotice(thrown), 'Autosave failed for 原始文件.rs: This unit is locked. Generate and save the lesson for “所有权 <T>” first.')
  await i18n.changeLanguage('zh-CN')
  assert.equal(formatNotice(locked), '单元尚未解锁，请先生成并保存「所有权 <T>」的课件。')
  assert.match(formatNotice(thrown), /^自动保存 原始文件.rs 失败：/)
  for (const language of ['en', 'zh-CN']) {
    await i18n.changeLanguage(language)
    const generic = language === 'en' ? 'Request failed. Please try again.' : '请求失败，请重试。'
    assert.equal(formatNotice(new ApiError(503, { code: 'FUTURE_ERROR' })), generic)
    assert.equal(formatNotice({ code: 'FUTURE_ERROR', error: '旧中文提示不得回退显示' }), generic)
    assert.equal(formatNotice(new Error('旧中文提示不得回退显示')), generic)
    assert.equal(formatNotice('旧中文提示不得回退显示'), generic)
    assert.equal(formatNotice({ error: '旧中文提示不得回退显示' }), generic)
  }
  assert.deepEqual(businessErrorResponse({ code: 'UNIT_LOCKED', params: { title: '所有权', secret: 'must-not-cross' } } as never),
    { code: 'UNIT_LOCKED', params: { title: '所有权' } })
})

test('plural execution feedback and locale formats change only the presentation, not saved evidence', async () => {
  const execution: CodeExecution = { id: 'run', unitId: 'unit', submissionId: null, specRevision: 3, createdAt: 1,
    code: 'print("原始代码")', codeHash: 'hash', commands: ['python3 answer.py'], state: 'succeeded',
    plan: { language: 'python', cases: [{ args: [], expected: 'a' }, { args: ['b'], expected: 'b' }] },
    results: [true, false].map((matches, index) => ({ command: 'python3 answer.py', expected: index ? 'b' : 'a', matches,
      result: { status: 'succeeded', output: '程序原文', exitCode: 0, signal: null } })) }
  const original = structuredClone(execution)
  await i18n.changeLanguage('en')
  assert.equal(localizedExecutionFeedback(execution).summary, 'Output from 1 check did not match the question’s requirements.')
  assert.equal(localizedExecutionFeedback({ ...execution, results: execution.results.map((result) => ({ ...result, matches: false })) }).summary,
    'Output from 2 checks did not match the question’s requirements.')
  assert.equal(localizedAssessmentSummary({ result: 'needs_work', summary: '', execution }), 'Output from 1 check did not match the question’s requirements.')
  assert.equal(localizedAssessmentSummary({ result: 'needs_work', summary: '模型反馈：再解释借用边界', execution }), '模型反馈：再解释借用边界')
  assert.equal(localizedAssessmentSummary({ result: 'pass', summary: '' }), 'Your answers meet the requirements for this assessment.')
  assert.equal(localizedAssessmentSummary({ result: 'unverified', summary: '模型误报：通过' }),
    'No usable code execution result is available. It is not yet possible to determine whether the code meets the requirements.')
  assert.equal(formatRelativeTime(0, 120_000), '2 minutes ago')
  assert.equal(formatNumber(12345.6), '12,345.6')
  const date = new Date('2026-10-20T12:00:00Z')
  assert.equal(formatDate(date, { month: 'long', timeZone: 'UTC' }), 'October')
  await i18n.changeLanguage('zh-CN')
  assert.equal(localizedExecutionFeedback(execution).summary, '有 1 项检查的输出与题目要求不一致。')
  assert.equal(localizedAssessmentSummary({ result: 'pass', summary: '' }), '本次作答符合题目要求。')
  assert.equal(localizedAssessmentSummary({ result: 'needs_work', summary: '模型反馈：再解释借用边界', execution }), '模型反馈：再解释借用边界')
  assert.equal(formatRelativeTime(0, 120_000), '2分钟前')
  assert.equal(formatDate(date, { month: 'long', timeZone: 'UTC' }), '十月')
  assert.deepEqual(execution, original)
  await i18n.changeLanguage('fr')
  assert.equal(i18n.t('actions.copy'), 'Copy', 'An unavailable language falls back to bundled English')
})

test('host receipt and caption presentation preserves captured text, authored names and program output', async () => {
  const quote = { source: 'lesson' as const, label: '所有权 · 课件', caption: { kind: 'lesson' as const, name: '所有权' }, text: '引用原文' }
  const proposal: ActionProposal = { id: 'action', sessionId: 'session', runId: 'run', digest: 'digest', createdAt: 1, expiresAt: 2,
    receiptId: 'receipt', state: 'failed', action: { kind: 'command', command: 'printf output', projectVersion: 'version', reason: '原因原文', cwd: '/project' },
    result: { status: 'failed', output: '中文程序输出\n', stdout: '中文程序输出\n', exitCode: 7, signal: null } }
  const original = structuredClone({ quote, proposal })
  await i18n.changeLanguage('en')
  assert.equal(quoteLabel(quote), '所有权 · Lesson')
  assert.equal(quoteLabel({ source: 'terminal', label: '终端输出', caption: { kind: 'terminal' }, text: '引用原文' }), 'Terminal output')
  assert.equal(quoteLabel({ source: 'code', label: 'src/中文.rs · 选中代码', caption: { kind: 'selection', name: 'src/中文.rs' }, text: '引用原文' }), 'src/中文.rs · Selected code')
  assert.equal(quoteLabel({ source: 'terminal', label: '终端输出', text: '引用原文' }), '终端输出', 'Captured text without semantic metadata is content, not a template to guess')
  assert.equal(quoteLabel({ source: 'lesson', label: '自定义引用名称', text: '引用原文' }), '自定义引用名称')
  assert.equal(sessionTitle({ title: '', scope: 'route' }), 'Learning roadmap')
  assert.equal(sessionTitle({ title: '', scope: 'route' }, false), 'New conversation')
  assert.equal(sessionTitle({ title: '', scope: 'intake' }), 'Learning requirements')
  assert.equal(sessionTitle({ title: '', scope: 'intake' }, false), 'New conversation')
  assert.equal(sessionTitle({ title: '', scope: 'unit' }), 'New conversation')
  assert.equal(sessionTitle({ title: '学习需求', scope: 'intake' }), '学习需求', 'Nonempty titles are authored content in every scope')
  assert.equal(sessionTitle({ title: '学习路线', scope: 'route' }), '学习路线')
  assert.equal(sessionTitle({ title: '新会话', scope: 'route' }), '新会话')
  assert.equal(sessionTitle({ title: '学习需求', scope: 'unit' }), '学习需求')
  assert.equal(sessionTitle({ title: '新会话 · 自定义', scope: 'unit' }), '新会话 · 自定义')
  assert.equal(localizedActionReceipt(proposal), 'Command execution failed. Exit code 7.\n中文程序输出\n')
  const message = { id: 'receipt', text: 'Durable compatibility text' }
  assert.equal(receiptProposal(message, [proposal]), proposal)
  assert.equal(receiptProposal({ ...message, id: 'authored', text: localizedActionReceipt(proposal) }, [proposal]), undefined)
  const { receiptId: _, ...legacy } = proposal
  assert.equal(receiptProposal({ ...message, text: localizedActionReceipt(legacy) }, [legacy]), undefined, 'No prose-based legacy matching remains')
  assert.equal(localizedActionReceipt({ ...proposal, result: { ...proposal.result!, error: { code: 'ACTION_FILE_CHANGED' } } }),
    'Command execution failed. Exit code 7.\nThe file has changed. Generate a new proposal.')
  assert.equal(localizedActionReceipt({ ...proposal, result: { ...proposal.result!, error: { code: 'FUTURE_ERROR' } as never } }),
    'Command execution failed. Exit code 7.\nRequest failed. Please try again.', 'Unknown host failures never fall back to raw strings')
  await i18n.changeLanguage('zh-CN')
  assert.equal(quoteLabel(quote), '所有权 · 课件')
  assert.equal(localizedActionReceipt(proposal), '命令执行失败。 退出码 7。\n中文程序输出\n')
  assert.equal(sessionTitle({ title: '', scope: 'unit' }), '新会话')
  assert.deepEqual({ quote, proposal }, original)
})
