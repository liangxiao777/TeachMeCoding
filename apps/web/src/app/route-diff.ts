import type { RouteContent } from '@teach-me-coding/contracts'

type RouteStage = RouteContent['stages'][number]
type RouteUnit = RouteStage['units'][number]
type Change = 'unchanged' | 'added' | 'removed' | 'modified'
export interface UnitDiff {
  id: string
  before?: RouteUnit
  after?: RouteUnit
  change: Change
  movedFrom?: string
}
export interface StageDiff {
  id: string
  before?: RouteStage
  after?: RouteStage
  change: Change
  moved: boolean
  units: UnitDiff[]
}

// Retain deleted items near their former successors in the same inline view.
function inlineIds(before: readonly { id: string }[], after: readonly { id: string }[]) {
  const result = after.map((item) => item.id)
  const present = new Set(result)
  for (const [index, item] of before.entries()) {
    if (present.has(item.id)) continue
    const successor = before.slice(index + 1).find((next) => present.has(next.id))
    result.splice(successor ? result.indexOf(successor.id) : result.length, 0, item.id)
  }
  return result
}

// Compare surviving IDs, not positions: an insertion is not a move of every
// following item. The longest stable subsequence identifies real reorderings.
function stableIds(before: readonly { id: string }[], after: readonly { id: string }[]) {
  const lengths = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0))
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i]![j] = before[i]!.id === after[j]!.id ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const stable = new Set<string>()
  let i = 0, j = 0
  while (i < before.length && j < after.length) {
    if (before[i]!.id === after[j]!.id) {
      stable.add(before[i]!.id)
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      i++
    } else {
      j++
    }
  }
  return stable
}

export function diffRoute(before: RouteContent | null, after: RouteContent) {
  const oldStages = new Map(before?.stages.map((stage) => [stage.id, stage]))
  const newStages = new Map(after.stages.map((stage) => [stage.id, stage]))
  const oldUnits = new Map(before?.stages.flatMap((stage) => stage.units.map((unit) => [unit.id, { unit, stage }] as const)))
  const newUnits = new Set(after.stages.flatMap((stage) => stage.units.map((unit) => unit.id)))
  const stableStages = stableIds(before?.stages ?? [], after.stages)
  const stages: StageDiff[] = inlineIds(before?.stages ?? [], after.stages).map((id) => {
    const previous = oldStages.get(id)
    const next = newStages.get(id)
    const stableUnits = stableIds(previous?.units ?? [], next?.units ?? [])
    // A transferred unit appears once at its proposed destination, not again as
    // a deletion in the old group (even when that entire stage is removed).
    const retained = previous?.units.filter((unit) => !newUnits.has(unit.id) || next?.units.some((unitAfter) => unitAfter.id === unit.id)) ?? []
    const replacements = new Map(next?.units.map((unit) => [unit.id, unit]))
    const units: UnitDiff[] = inlineIds(retained, next?.units ?? []).map((unitId) => {
      const old = oldUnits.get(unitId)
      const replacement = replacements.get(unitId)
      const change: Change = !old ? 'added' : !replacement ? 'removed'
        : ['title', 'summary', 'goals'].some((field) => JSON.stringify(old.unit[field as keyof RouteUnit]) !== JSON.stringify(replacement[field as keyof RouteUnit])) ? 'modified' : 'unchanged'
      return {
        id: unitId, before: old?.unit, after: replacement, change,
        movedFrom: old && replacement ? old.stage.id !== id ? `从「${old.stage.title}」移入`
          : !stableUnits.has(unitId) ? `单元顺序调整（原第 ${old.stage.units.findIndex((unit) => unit.id === unitId) + 1} 个）` : undefined : undefined,
      }
    })
    return {
      id, before: previous, after: next, units,
      change: !previous ? 'added' : !next ? 'removed' : previous.title !== next.title ? 'modified' : 'unchanged',
      moved: !!previous && !!next && !stableStages.has(id),
    }
  })
  const units = stages.flatMap((stage) => stage.units)
  return {
    stages, note: { before: before?.note ?? '', after: after.note },
    counts: {
      added: units.filter((unit) => unit.change === 'added').length,
      removed: units.filter((unit) => unit.change === 'removed').length,
      modified: units.filter((unit) => unit.change === 'modified').length,
      moved: units.filter((unit) => unit.movedFrom).length,
      addedStages: stages.filter((stage) => stage.change === 'added').length,
      removedStages: stages.filter((stage) => stage.change === 'removed').length,
      changedStages: stages.filter((stage) => stage.change === 'modified' || stage.moved).length,
    },
  }
}

export function routeDiffSummary(diff: ReturnType<typeof diffRoute>) {
  const { counts } = diff
  const units = [['新增', counts.added], ['修改', counts.modified], ['删除', counts.removed], ['移动', counts.moved]] as const
  const stages = [['新增阶段', counts.addedStages], ['删除阶段', counts.removedStages], ['调整阶段', counts.changedStages]] as const
  return [...stages.filter(([, count]) => count).map(([label, count]) => `${label} ${count}`),
    ...units.filter(([, count]) => count).map(([label, count]) => `${label} ${count} 个单元`),
    ...(diff.note.before !== diff.note.after ? ['安排说明已修改'] : [])].join(' · ') || '路线内容未改变'
}
