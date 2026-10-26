import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import type { Nodes } from 'mdast'
import { diffLesson, lessonDiffAllowedTags, lessonDiffRemark, lessonDiffTree, lessonTokens } from './lesson-diff'
import { lessonAllowedTags, lessonHeadings, lessonMath, lessonRemarkPlugins } from './lesson-markdown'
import i18n from '../i18n'

await i18n.changeLanguage('zh-CN')

const teachingSource = [
  '## 重复标题', '重复正文', '重复正文', '[跨段链接][ref] 和脚注[^ref]',
  '```rust file="demo.rs"\nlet a = "```";\n  keep_spaces();\n```',
  '> [!TIP]\n> 提示里的 [引用][ref]', '> [!WARNING]\n> 不要遗漏警告',
  '::::practice\n练习题 [引用][ref]\n\n:::hint\n提示内容\n:::\n\n:::solution\n参考讲解\n:::\n::::',
  '| 列一 | 列二 |\n| --- | --- |\n| 值 | [引用][ref] |',
  '行内公式 $a_1+b_2$ 与正文一起保留。', '$$\nx^2 + y^2\n$$', '```mermaid\ngraph LR\nA-->B\n```',
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
  assert.equal(nodes.some((node) => String(node.type) === 'inlineMath'), true)
  assert.equal(nodes.some((node) => node.type === 'code' && node.lang === 'mermaid' && node.value.includes('A-->B')), true)
  assert.equal(nodes.filter((node) => node.type === 'definition').length >= 2, true)
  assert.equal(nodes.filter((node) => node.type === 'footnoteDefinition').length >= 2, true, 'Link and footnote namespaces can use the same identifier')
  const ids = nodes.filter((node) => node.type === 'heading').map((node) => String(node.data?.hProperties?.id))
  const drawerIds = allNodes(lessonDiffTree(diff, 'proposal', true)).filter((node) => node.type === 'heading').map((node) => String(node.data?.hProperties?.id))
  assert.equal(new Set([...ids, ...drawerIds]).size, ids.length + drawerIds.length)
  assert.deepEqual(diff, snapshot, 'Rendering never mutates the immutable review snapshot')
})

test('lesson review renders changed inline formulas without interpreting escaped dollars or code as math', () => {
  const before = '## 计算 $x^2$\n\n结果是 $x^2$。金额 \\$5，代码 `$not_math$`。\n'
  const after = before.replaceAll('x^2', 'x^3')
  const html = renderToStaticMarkup(createElement(Streamdown, { mode: 'static', parseIncompleteMarkdown: false, controls: false,
    plugins: { cjk, math: lessonMath }, children: after,
    allowedTags: { ...lessonAllowedTags, ...lessonDiffAllowedTags },
    remarkPlugins: [...lessonRemarkPlugins, [lessonDiffRemark, { diff: diffLesson(before, after), proposalId: 'math', inDrawer: false }]],
  }))
  assert.equal((html.match(/class="katex"/g) ?? []).length, 4)
  assert.equal((html.match(/<annotation encoding="application\/x-tex">x\^2<\/annotation>/g) ?? []).length, 2)
  assert.equal((html.match(/<annotation encoding="application\/x-tex">x\^3<\/annotation>/g) ?? []).length, 2)
  assert.match(html, /金额 \$5/)
  assert.match(html, />\$not_math\$<\/code>/)
  assert.deepEqual(lessonHeadings(after).map((heading) => heading.text), ['计算 x^3'])
})

test('combined lesson AST renders old/new cross-block reference scopes and matching TOC anchors', () => {
  const before = '## 相同标题\n\n[引用][ref]\n\n## 相同标题\n\n[ref]: https://example.com/old\n'
  const after = '插入开头\n\n' + before.replace('example.com/old', 'example.com/new')
  const diff = diffLesson(before, after)
  const html = renderToStaticMarkup(createElement(Streamdown, { mode: 'static', parseIncompleteMarkdown: false, controls: false,
    normalizeHtmlIndentation: false, plugins: { cjk, math: lessonMath }, children: after, linkSafety: { enabled: false },
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
    normalizeHtmlIndentation: false, plugins: { cjk, math: lessonMath }, children: after, linkSafety: { enabled: false },
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
