import { diffArrays } from 'diff'
import type { Blockquote, Definition, Nodes, Root, RootContent } from 'mdast'
import { toString } from 'mdast-util-to-string'
import type { Plugin } from 'unified'
import { lessonHeadingId, parseLessonMarkdown } from './lesson-markdown'
import i18n from '../i18n'

export type LessonChange = 'unchanged' | 'removed' | 'added'
export interface LessonToken { source: string; offset: number; node: RootContent | null; key: string }
export interface LessonDiffRow { change: LessonChange; before?: LessonToken; after?: LessonToken }
export interface LessonDiff { before: string; after: string; rows: LessonDiffRow[]; fallback: boolean }
export const lessonDiffAllowedTags = { 'lesson-change': ['change', 'side'], 'lesson-change-note': ['label'] }
const limits = { maxChars: 200_000, maxTokens: 800, timeout: 30, maxEditLength: 256 }
type Bounds = Partial<typeof limits>

function visit(node: Nodes, fn: (node: Nodes) => void) {
  fn(node)
  if ('children' in node) node.children.forEach((child) => visit(child, fn))
}

// Parse whole documents, never independent slices. Token source includes the
// gaps between blocks, leading whitespace and final newline, without rewriting.
export function lessonTokens(source: string): LessonToken[] {
  const tree = parseLessonMarkdown(source)
  const definitions = new Map<string, RootContent>()
  tree.children.forEach((node) => visit(node, (child) => {
    if (child.type === 'definition' || child.type === 'footnoteDefinition') {
      const id = `${child.type}:${child.identifier}`
      if (!definitions.has(id)) definitions.set(id, child)
    }
  }))
  return tree.children.length ? tree.children.map((node, index) => {
    const start = index === 0 ? 0 : node.position!.start.offset!
    const end = tree.children[index + 1]?.position?.start.offset ?? source.length
    const raw = source.slice(start, end)
    const body = source.slice(node.position!.start.offset!, node.position!.end.offset!)
    const dependencies = new Map<string, string>()
    const collect = (child: Nodes) => {
      if (!['linkReference', 'imageReference', 'footnoteReference'].includes(child.type) || !('identifier' in child)) return
      const id = `${child.type === 'footnoteReference' ? 'footnoteDefinition' : 'definition'}:${child.identifier}`
      const definition = definitions.get(id)
      if (!definition || dependencies.has(id)) return
      dependencies.set(id, source.slice(definition.position!.start.offset!, definition.position!.end.offset!))
      visit(definition, collect)
    }
    visit(node, collect)
    // Separators stay lossless in source, but appending a section must not paint
    // the preceding unchanged exercise red/green for its new trailing newline.
    return { source: raw, offset: start, node, key: JSON.stringify([body, [...dependencies].sort()]) }
  }) : [{ source, offset: 0, node: null, key: source }]
}

export function diffLesson(before: string, after: string, bounds: Bounds = {}): LessonDiff {
  const options = { ...limits, ...bounds }
  const fallback = (): LessonDiff => ({ before, after, rows: [], fallback: true })
  if (before.length + after.length > options.maxChars || (before.match(/\n/g)?.length ?? 0) + (after.match(/\n/g)?.length ?? 0) > 4000) return fallback()
  const old = lessonTokens(before), next = lessonTokens(after)
  if (old.length + next.length > options.maxTokens) return fallback()
  const changes = diffArrays(old, next, { comparator: (a, b) => a.key === b.key, timeout: options.timeout, maxEditLength: options.maxEditLength })
  if (!changes) return fallback() // A bounded abort is not an empty diff.
  let oldIndex = 0, nextIndex = 0
  const rows: LessonDiffRow[] = []
  for (const chunk of changes) for (let i = 0; i < chunk.count; i++) {
    // Common chunks contain NEW-side objects. Explicit cursors preserve both
    // versions' offsets even with asymmetric repeated blocks.
    rows.push(chunk.removed ? { change: 'removed', before: old[oldIndex++]! }
      : chunk.added ? { change: 'added', after: next[nextIndex++]! }
      : { change: 'unchanged', before: old[oldIndex++]!, after: next[nextIndex++]! })
  }
  return { before, after, rows, fallback: false }
}

function tokenParts(token: LessonToken) {
  if (!token.node) return { leading: '', body: token.source, trailing: '' }
  const start = token.node.position!.start.offset! - token.offset, end = token.node.position!.end.offset! - token.offset
  return { leading: token.source.slice(0, start), body: token.source.slice(start, end), trailing: token.source.slice(end) }
}

const visibleWhitespace = (source: string) => source.replaceAll(' ', '·').replaceAll('\t', '⇥').replaceAll('\r', '␍').replaceAll('\n', '↵\n') || i18n.t('diff.empty')
const noteValue = (label: string, value: string): RootContent => ({ type: 'paragraph', children: [
  { type: 'text', value: label }, { type: 'inlineCode', value },
] })
const changeNote = (label: string, children: RootContent[]): RootContent => ({ type: 'blockquote', children: children as Blockquote['children'],
  data: { hName: 'lesson-change-note', hProperties: { label } },
})

// Match equivalent rendered blocks only inside a replacement. The main diff
// still compares exact Markdown; this only adds an explanation, never hides it.
function formattingChanges(rows: LessonDiffRow[]) {
  const result = new Set<LessonToken>(), removed = new Map<string, LessonToken[]>()
  const key = (token: LessonToken) => JSON.stringify(token.node, function (name, value) {
    if (name === 'position') return undefined
    if (name === 'value' && typeof value === 'string') {
      if (this.type === 'text') return value.replace(/\s+/g, ' ')
      if (this.type === 'code') return value.replace(/\s/g, '')
    }
    return value
  })
  for (const row of rows) {
    if (row.change === 'unchanged') { removed.clear(); continue }
    const token = (row.before ?? row.after)!, identity = key(token)
    if (row.change === 'removed') removed.set(identity, [...removed.get(identity) ?? [], token])
    else {
      const previous = removed.get(identity)?.shift()
      if (previous && tokenParts(previous).body !== tokenParts(token).body) { result.add(previous); result.add(token) }
    }
  }
  return result
}

function linkDetails(node: RootContent, definitions: Map<string, Definition>) {
  const details: RootContent[] = []
  visit(node, (child) => {
    if (!['link', 'image', 'linkReference', 'imageReference'].includes(child.type)) return
    const target = 'url' in child ? child : 'identifier' in child ? definitions.get(child.identifier) : undefined
    if (!target) return
    const label = child.type === 'image' || child.type === 'imageReference' ? i18n.t('diff.imageAddress', { label: child.alt ?? '' }) : i18n.t('diff.linkAddress', { label: toString(child) })
    details.push(noteValue(label, target.url))
    if (target.title) details.push(noteValue(i18n.t('diff.title'), target.title))
  })
  return details.length ? [changeNote(i18n.t('diff.addresses'), details)] : []
}

function scoped(node: RootContent, scope: string, inDrawer: boolean) {
  const copy = structuredClone(node)
  visit(copy, (child) => {
    if ('identifier' in child) child.identifier = `${scope}-${inDrawer ? 'drawer' : 'main'}-${child.identifier}`
    if (child.type === 'heading') child.data = { ...child.data, hProperties: {
      ...child.data?.hProperties, id: lessonHeadingId(child.position?.start.offset ?? 0, inDrawer, scope),
    } }
  })
  return copy
}

/** Inject a combined AST into the existing static, sanitized teaching renderer.
 * Definitions stay in their original document scope; code/directives/tables are
 * whole nodes. Invisible changes are explained inline, without another view.
 */
export function lessonDiffTree(diff: LessonDiff, proposalId: string, inDrawer: boolean): Root {
  const children: RootContent[] = []
  const definitions = { before: new Map<string, Definition>(), after: new Map<string, Definition>() }
  const formatting = formattingChanges(diff.rows)
  for (const [side, source] of [['before', diff.before], ['after', diff.after]] as const) {
    const seen = new Set<string>()
    for (const token of lessonTokens(source)) if (token.node) visit(token.node, (node) => {
      if (node.type === 'definition' || node.type === 'footnoteDefinition') {
        const id = `${node.type}:${node.identifier}`
        if (!seen.has(id)) {
          seen.add(id)
          if (node.type === 'definition') definitions[side].set(node.identifier, node)
          children.push(scoped(node, `${proposalId}-${side}`, inDrawer))
        }
      }
    })
  }
  for (const row of diff.rows) {
    const side = row.change === 'removed' ? 'before' : 'after'
    const token = (side === 'before' ? row.before : row.after)!
    if (!token.node && !token.source) continue
    const node = token.node && !['definition', 'footnoteDefinition'].includes(token.node.type)
      ? scoped(token.node, `${proposalId}-${side}`, inDrawer)
      : { type: 'code' as const, value: token.source }
    const details = row.change !== 'unchanged' && token.node ? linkDetails(token.node, definitions[side]) : []
    if (formatting.has(token)) details.push(changeNote(i18n.t('diff.formatting'), [
      noteValue(i18n.t('diff.syntax'), visibleWhitespace(token.source)),
    ]))
    if (row.change === 'unchanged') {
      const old = tokenParts(row.before!), next = tokenParts(row.after!)
      for (const part of ['leading', 'trailing'] as const) {
        if (old[part] !== next[part]) details.push(changeNote(i18n.t(`diff.${part}`), [
          noteValue(i18n.t('diff.before'), visibleWhitespace(old[part])), noteValue(i18n.t('diff.after'), visibleWhitespace(next[part])),
        ]))
      }
    }
    children.push({ type: 'blockquote', children: [node, ...details] as Blockquote['children'], data: {
      hName: 'lesson-change', hProperties: { change: row.change, side },
    } })
  }
  return { type: 'root', children }
}

export const lessonDiffRemark: Plugin<[{ diff: LessonDiff; proposalId: string; inDrawer: boolean }], Root> = (options) => (tree) => {
  tree.children = lessonDiffTree(options.diff, options.proposalId, options.inDrawer).children
}
