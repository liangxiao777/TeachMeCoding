import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RouteContent } from '@teach-me-coding/contracts'
import { diffRoute, routeDiffSummary } from './route-diff'
import i18n from '../i18n'

await i18n.changeLanguage('zh-CN')

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
