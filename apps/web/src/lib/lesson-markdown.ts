import type { Nodes, Root } from 'mdast'
import { toString } from 'mdast-util-to-string'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { defaultRemarkPlugins } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import { unified, type Plugin, type PluggableList } from 'unified'

const plainMarkdown = unified().use(remarkParse).use(remarkGfm)
export const lessonMath = createMathPlugin({ singleDollarTextMath: true })

export const lessonHeadingId = (offset: number, inDrawer = false, scope?: string) => `lesson-${inDrawer ? 'drawer' : 'main'}-${scope ? `${scope}-` : ''}${offset}`

// An incomplete or unknown teaching marker remains readable Markdown. Never
// hide content merely because a model forgot a container's closing fence.
function completeContainer(node: Nodes, source: string) {
  if (node.type !== 'containerDirective') return false
  const raw = source.slice(node.position!.start.offset!, node.position!.end.offset!)
  const opening = /^\s*(:{3,})/.exec(raw)?.[1]?.length ?? 0
  const closing = /(?:^|\r?\n)[ \t]*(:{3,})[ \t]*$/.exec(raw)?.[1]?.length ?? 0
  return closing >= opening && opening >= 3
    && (node.children.at(-1)?.position?.end.offset ?? 0) < node.position!.end.offset!
}

function fallback(node: Nodes, source: string): Nodes[] {
  const offset = node.position!.start.offset!
  const raw = source.slice(offset, node.position!.end.offset!)
  if (node.type === 'textDirective') return [{ type: 'text', value: raw, position: node.position }]
  const tree = plainMarkdown.parse(raw)
  const relocate = (child: Nodes) => {
    if (child.position) {
      child.position.start.offset = child.position.start.offset! + offset
      child.position.end.offset = child.position.end.offset! + offset
    }
    if ('children' in child) child.children.forEach(relocate)
  }
  tree.children.forEach(relocate)
  return tree.children
}

const teachingBlocks: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file)
  const transform = (node: Nodes, inPractice = false): Nodes[] => {
    if (node.type === 'containerDirective' || node.type === 'leafDirective' || node.type === 'textDirective') {
      const name = node.name.toLowerCase()
      const practice = name === 'practice' && !inPractice
      const disclosure = (name === 'hint' || name === 'solution') && inPractice
      if (!completeContainer(node, source) || (!practice && !disclosure)) return fallback(node, source)
      if (node.type !== 'containerDirective') return fallback(node, source)
      const question = practice ? node.children.filter((child) => !(child.type === 'containerDirective'
        && ['hint', 'solution'].includes(child.name.toLowerCase()) && completeContainer(child, source)))
        .map((child) => source.slice(child.position!.start.offset!, child.position!.end.offset!)).join('\n\n') : ''
      node.data = { ...node.data, hName: `lesson-${name}`, hProperties: practice ? { question } : {} }
      Object.assign(node, { children: node.children.flatMap((child) => transform(child, practice)) })
      return [node]
    }
    if (node.type === 'blockquote') {
      const first = node.children[0]
      const marker = first?.type === 'paragraph' ? first.children[0] : undefined
      const match = marker?.type === 'text' ? /^\[!(TIP|WARNING)\](?:\r?\n|$)/i.exec(marker.value) : null
      if (match && marker?.type === 'text' && first?.type === 'paragraph') {
        marker.value = marker.value.slice(match[0].length)
        if (!toString(first).trim()) node.children.shift()
        node.data = { ...node.data, hName: 'lesson-callout', hProperties: { kind: match[1]!.toLowerCase() } }
      }
    }
    if ('children' in node) Object.assign(node, { children: node.children.flatMap((child) => transform(child)) })
    return [node]
  }
  tree.children = tree.children.flatMap((node) => transform(node)) as Root['children']
}

// The directory and renderer use the same grammar and fallback rules. Only
// top-level h2 headings belong to the directory, not code or folded answers.
export const lessonRemarkPlugins: PluggableList = [...Object.values(defaultRemarkPlugins), remarkDirective, teachingBlocks]
const lessonParser = unified().use(remarkParse).use(cjk.remarkPluginsBefore).use(lessonRemarkPlugins).use(cjk.remarkPluginsAfter).use([lessonMath.remarkPlugin])
export function parseLessonMarkdown(content: string): Root {
  return lessonParser.runSync(lessonParser.parse(content), { value: content }) as Root
}
export function lessonHeadings(content: string, inDrawer = false, scope?: string) {
  const tree = parseLessonMarkdown(content)
  return tree.children.flatMap((node) => node.type === 'heading' && node.depth === 2
    ? [{ id: lessonHeadingId(node.position!.start.offset!, inDrawer, scope), text: toString(node) }] : [])
}

export const scopedLessonHeadings: Plugin<[{ scope: string; inDrawer: boolean }], Root> = ({ scope, inDrawer }) => (tree) => {
  const visit = (node: Nodes) => {
    if ('identifier' in node) node.identifier = `${scope}-${inDrawer ? 'drawer' : 'main'}-${node.identifier}`
    if (node.type === 'heading') node.data = { ...node.data, hProperties: {
      ...node.data?.hProperties, id: lessonHeadingId(node.position?.start.offset ?? 0, inDrawer, scope),
    } }
    if ('children' in node) node.children.forEach(visit)
  }
  tree.children.forEach(visit)
}

export const lessonAllowedTags = {
  'lesson-callout': ['kind'],
  'lesson-practice': ['question'],
  'lesson-hint': [],
  'lesson-solution': [],
}
