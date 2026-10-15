import { lessonMarkdown, type Lesson, type LessonProposal, type Proposal, type UnitDetail, type Workspace } from '@teach-me-coding/contracts'
import type { LessonBlock } from './types'

export function lessonView(lesson: Lesson) {
  if (!lesson.blocks) return { title: lesson.title, intro: lesson.intro ?? '', blocks: [], content: lesson.content }
  // Mixed historical formats need the complete normalized document. Ordinary
  // block-only lessons keep their original cards, code captions and anchors.
  if (lesson.content) return { title: lesson.title, intro: '', blocks: [], content: lessonMarkdown(lesson) }
  return { title: lesson.title, intro: lesson.intro ?? '', blocks: lesson.blocks.flatMap((block): LessonBlock[] => {
    if (block.type !== 'h2') return [block]
    const [heading = '', ...lines] = block.text.split(/\r\n?|\n/)
    const body = lines.join('\n')
    return [{ ...block, text: heading.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim() },
      ...(body.trim() ? [{ type: 'markdown' as const, text: body }] : [])]
  }) }
}

export function assessmentNeedsRefresh(unit: UnitDetail, requirement: number) {
  if (!unit.assessment) return true
  if (unit.assessmentSources) return unit.assessmentSources.lesson !== unit.lesson?.revision || unit.assessmentSources.requirement !== requirement
  // Legacy questions have no source metadata. Keep initial read compatibility,
  // but never present them as a measurement of an edited lesson.
  return (unit.lesson?.revision ?? 0) > 1
}

export const pendingDecision = (saved: Pick<Workspace, 'proposals' | 'lessonProposals'>) =>
  saved.proposals.some((proposal) => proposal.state === 'pending') || !!saved.lessonProposals?.some((proposal) => proposal.state === 'pending')

// Shared by route and lesson gates. Terminal receipts cannot be undone by a
// pre-decision refresh (including snapshots arriving from another session).
export function mergeProposals<T extends Proposal | LessonProposal>(known: T[], fresh: T[] = []): T[] {
  const proposals = new Map(known.map((proposal) => [proposal.id, proposal]))
  for (const proposal of fresh) {
    const old = proposals.get(proposal.id)
    if (!old || old.state === 'pending') proposals.set(proposal.id, proposal)
  }
  return [...proposals.values()]
}

export function lessonProposalStale(proposal: LessonProposal, requirementRevision: number, routeRevision: number,
  confirmed: boolean, versions: Readonly<Record<string, number | undefined>>, targetExists: boolean) {
  return !confirmed || !targetExists || proposal.requirementRevision !== requirementRevision || proposal.routeRevision !== routeRevision
    || versions[proposal.unitId] !== undefined && versions[proposal.unitId] !== proposal.baseRevision
    || proposal.references.some((ref) => versions[ref.unitId] !== undefined && versions[ref.unitId] !== ref.revision)
}

export function mergeUnitDetail(known: UnitDetail | undefined, fresh: UnitDetail): UnitDetail {
  if (!known) return fresh
  // The apply receipt's lesson and dependent assessment/record validity are one
  // snapshot. Never replace them with the old body from an in-flight read.
  if ((known.lesson?.revision ?? 0) > (fresh.lesson?.revision ?? 0)) return known
  return { ...fresh, draft: known.draft.revision > fresh.draft.revision ? known.draft : fresh.draft }
}
