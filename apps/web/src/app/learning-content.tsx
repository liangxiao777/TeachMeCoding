import { useState } from 'react';
import type { AssessmentDraft, Quote, Requirement, RequirementState, UnitDetail, Workspace } from '@teach-me-coding/contracts';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { RichText } from '@/components/shared';
import { api } from '@/lib/api';
import { RequestState, useRequest, useUnsavedWarning } from './request-state';

export function Requirements({ workspace, update }: { workspace: Workspace; update: (r: RequirementState) => void }) {
  const [draft, setDraft] = useState(workspace.requirement.value);
  const request = useRequest();
  const dirty = JSON.stringify(draft) !== JSON.stringify(workspace.requirement.value);
  useUnsavedWarning(dirty);
  const save = (confirmed: boolean) => request.run(async () => update(await api(`/spaces/${workspace.id}/requirement`, {
    revision: workspace.requirement.revision, value: draft, confirmed,
  })));
  const fields: [keyof Requirement, string][] = [['goal', '学习目标'], ['background', '已有基础'], ['outcome', '期望达成'], ['schedule', '时间安排']];
  return <section className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-8">
    <div><p className="mb-2 text-xs text-muted-foreground">学习需求</p><h1 className="text-2xl font-semibold tracking-tight">从你的目标开始</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">手动填写并确认学习需求。路线生成尚未接入，确认不会生成模拟路线。</p></div>
    {fields.map(([key, label]) => <label key={key} className="text-sm font-medium">{label}<Textarea className="mt-2" rows={key === 'goal' ? 2 : 3} value={draft[key]} disabled={request.busy} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
    <RequestState request={request} />
    <p className="text-xs text-muted-foreground">{dirty ? '需求有未保存修改' : workspace.requirement.confirmed ? '需求已确认并保存' : '需求草稿已保存'}</p>
    <div className="flex gap-3"><Button variant="outline" disabled={request.busy || !draft.goal.trim()} onClick={() => save(false)}>保存需求</Button>
      <Button disabled={request.busy || !draft.goal.trim() || (!dirty && workspace.requirement.confirmed)} onClick={() => save(true)}>确认需求</Button></div>
  </section>;
}

export function UnitContent({ initial, space, quote }: { initial: UnitDetail; space: string; quote: (q: Quote) => void }) {
  const [unit, setUnit] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const [mode, setMode] = useState<'lesson' | 'assessment' | 'record'>('lesson');
  const [recordId, setRecordId] = useState<string | null>(null);
  const request = useRequest();
  const dirty = JSON.stringify(unit.draft) !== JSON.stringify(draft);
  useUnsavedWarning(dirty);
  const record = unit.records.find((r) => r.id === recordId);
  return <section className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-8">
    <nav className="flex gap-2"><Button variant={mode === 'lesson' ? 'secondary' : 'ghost'} onClick={() => setMode('lesson')}>课件</Button><Button variant={mode === 'assessment' ? 'secondary' : 'ghost'} onClick={() => setMode('assessment')}>测评草稿</Button></nav>
    {mode === 'lesson' && (unit.lesson ? <><h1 className="text-2xl font-semibold">{unit.lesson.title}</h1><RichText text={unit.lesson.content} /><Button variant="outline" className="self-start" onClick={() => quote({ source: 'lesson', label: unit.lesson!.title, text: window.getSelection()?.toString() || unit.lesson!.content })}>引用课件</Button></> : <><h1 className="text-2xl font-semibold">课件尚未生成</h1><p className="text-sm text-muted-foreground">课件生成 Agent 尚未接入。已有学习记录和项目文件仍可读取。</p></>)}
    {mode === 'assessment' && <><h1 className="text-2xl font-semibold">测评草稿</h1><p className="text-sm text-muted-foreground">出题、评估和代码执行尚未接入。这里只保存本单元作答，不会产生通过结果。</p>
      <label className="text-sm">{unit.assessment?.q1 ?? '解释题笔记'}<Textarea aria-label="解释题作答" className="mt-2" rows={5} value={draft.q1} disabled={request.busy} onChange={(e) => setDraft({ ...draft, q1: e.target.value })} /></label>
      <label className="text-sm">{unit.assessment?.q2 ?? '代码题笔记'}<Textarea aria-label="代码题作答" className="mt-2 font-mono" rows={7} value={draft.q2} disabled={request.busy} onChange={(e) => setDraft({ ...draft, q2: e.target.value })} /></label>
      <p className="text-xs text-muted-foreground">{dirty ? '测评草稿未保存' : '测评草稿已保存'}</p><RequestState request={request} />
      <Button className="self-start" disabled={request.busy || !dirty} onClick={() => request.run(async () => {
        const saved = await api<AssessmentDraft>(`/spaces/${space}/units/${unit.id}/draft`, { revision: draft.revision, q1: draft.q1, q2: draft.q2 });
        setDraft((current) => JSON.stringify(current) === JSON.stringify(draft) ? saved : { ...current, revision: saved.revision });
        setUnit({ ...unit, draft: saved });
      })}>保存测评草稿</Button></>}
    {mode === 'record' && record && <><h1 className="text-2xl font-semibold">{record.result === 'pass' ? '测评通过' : '仍需加强'} · 第 {record.attempt} 次</h1><p>{record.summary}</p>
      {([['已掌握', record.mastered], ['需加强', record.concerns], ['判断依据', record.evidence], ['尚未验证', record.toVerify]] as const).map(([label, lines]) => <div key={label}><h2 className="mb-2 font-medium">{label}</h2><ul className="list-inside list-disc text-sm">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul></div>)}
      <details><summary>本次作答</summary><pre className="whitespace-pre-wrap text-sm">{record.answers.q1}{'\n'}{record.answers.q2}</pre></details>
      <Button variant="outline" className="self-start" onClick={() => quote({ source: 'advice', label: `测评建议 · 第 ${record.attempt} 次`, text: record.concerns.join('\n') || record.summary })}>引用测评建议</Button></>}
    <div className="mt-4 border-t pt-4"><h2 className="mb-2 text-sm font-medium">本单元测评记录</h2>{unit.records.length ? unit.records.map((r) => <Button key={r.id} variant="ghost" size="sm" onClick={() => { setRecordId(r.id); setMode('record'); }}>第 {r.attempt} 次 · {r.result === 'pass' ? '通过' : '需加强'}</Button>) : <p className="text-xs text-muted-foreground">尚无测评记录</p>}</div>
  </section>;
}
