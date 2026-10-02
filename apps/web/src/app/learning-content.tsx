import { useLayoutEffect, useRef, useState } from 'react';
import { Check, CircleCheck, ClipboardList, Code2, FileQuestion, Lightbulb, MessageSquareQuote, Pencil, Target } from 'lucide-react';
import type { AssessmentDraft, Quote, Requirement, RequirementState, RouteContent, UnitDetail, Workspace } from '@teach-me-coding/contracts';
import { CodeEditor } from '@/components/code-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { RichText, StatusPill } from '@/components/shared';
import { api } from '@/lib/api';
import { RequestState, useRequest, useUnsavedWarning } from './request-state';

export function Requirements({ workspace, update }: { workspace: Workspace; update: (r: RequirementState) => void }) {
  const [draft, setDraft] = useState(workspace.requirement.value);
  const [editing, setEditing] = useState(!workspace.requirement.confirmed);
  const request = useRequest();
  const dirty = JSON.stringify(draft) !== JSON.stringify(workspace.requirement.value);
  useUnsavedWarning(dirty);
  const save = (confirmed: boolean) => request.run(async () => {
    update(await api(`/spaces/${workspace.id}/requirement`, { revision: workspace.requirement.revision, value: draft, confirmed }));
    setEditing(false);
  });
  const fields: [keyof Requirement, string][] = [['goal', '学习目标'], ['background', '已有基础'], ['outcome', '期望达成'], ['schedule', '时间安排']];
  return <section aria-label="学习需求摘要" className="relative isolate mx-auto w-full max-w-2xl">
    <div aria-hidden className="pointer-events-none absolute -inset-x-8 -inset-y-16 -z-10 bg-radial from-foreground/8 via-foreground/3 to-transparent to-70%" />
    <Card className="border bg-card shadow-[0_2px_6px_#00000006,0_16px_40px_#0000000a] ring-0">
      <CardHeader><div className="flex items-center justify-between gap-2"><CardTitle className="flex items-center gap-2"><ClipboardList className="size-4" />学习需求摘要</CardTitle>
        {!editing && <Button variant="ghost" size="sm" aria-label="修改需求" onClick={() => setEditing(true)}><Pencil />修改</Button>}
      </div><CardDescription className="leading-relaxed">先确认目标、基础和时间安排。教学 Agent 接入后将据此规划路线。</CardDescription></CardHeader>
      <CardContent>{editing ? <div className="flex flex-col gap-4">{fields.map(([key, label]) => <label key={key} className="text-xs font-medium text-muted-foreground">{label}<Textarea className="mt-2 resize-none text-foreground" rows={2} value={draft[key]} disabled={request.busy} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></label>)}</div> : <dl className="flex flex-col gap-4">{fields.map(([key, label]) => <div key={key} className="flex flex-col gap-1"><dt className="text-xs font-medium tracking-wider text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap text-sm leading-relaxed">{draft[key] || '尚未填写'}</dd></div>)}</dl>}</CardContent>
      <CardFooter className="flex-col items-stretch gap-3 border-t"><RequestState request={request} />
        {editing && <Button variant="outline" disabled={request.busy || !draft.goal.trim()} onClick={() => save(false)}>保存需求</Button>}
        <Button size="lg" disabled={request.busy || !draft.goal.trim() || (!dirty && workspace.requirement.confirmed)} onClick={() => save(true)}><Check />确认需求</Button>
        <p className="text-center text-xs text-muted-foreground">{dirty ? '需求有未保存修改' : workspace.requirement.confirmed ? '需求已确认并保存' : '需求草稿已保存'}</p>
      </CardFooter>
    </Card>
  </section>;
}

type UnitMetadata = RouteContent['stages'][number]['units'][number];

export function LessonContent({ unit, metadata, quote }: { unit: UnitDetail; metadata?: UnitMetadata; quote: (q: Quote) => void }) {
  return <article className="lesson-prose flex flex-col gap-6">
    <header className="flex flex-col gap-5"><p className="font-mono text-xs tracking-wide text-muted-foreground">当前单元 · 学习课件</p><div className="flex items-center gap-3"><h1 className="text-3xl font-semibold tracking-tight">{unit.lesson?.title ?? metadata?.title ?? '课件尚未生成'}</h1><StatusPill status={unit.status} /></div>
      {!!metadata?.goals.length && <div className="flex flex-col gap-3 rounded-xl border bg-card p-4"><p className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Target className="size-3.5" />本单元目标</p><ul className="flex flex-col gap-1.5">{metadata.goals.map((goal) => <li key={goal} className="flex gap-2 text-sm leading-relaxed"><CircleCheck className="mt-0.5 size-4 shrink-0" />{goal}</li>)}</ul></div>}
    </header>
    {unit.lesson ? <><RichText text={unit.lesson.content} /><Button variant="outline" className="self-start" onClick={() => quote({ source: 'lesson', label: unit.lesson!.title, text: window.getSelection()?.toString() || unit.lesson!.content })}><MessageSquareQuote />引用课件</Button></> : <div className="rounded-xl border border-dashed p-8"><h2 className="font-semibold">课件尚未生成</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">课件生成 Agent 尚未接入。已有学习记录和项目文件仍可读取。</p></div>}
  </article>;
}

export function UnitContent({ initial, space, quote, metadata }: { initial: UnitDetail; space: string; quote: (q: Quote) => void; metadata?: UnitMetadata }) {
  const [unit, setUnit] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const [mode, setMode] = useState<'lesson' | 'assessment' | 'record'>('lesson');
  const [recordId, setRecordId] = useState<string | null>(null);
  const content = useRef<HTMLElement>(null);
  useLayoutEffect(() => { content.current?.scrollIntoView({ block: 'start' }); }, [mode, recordId]);
  const request = useRequest();
  const dirty = JSON.stringify(unit.draft) !== JSON.stringify(draft);
  useUnsavedWarning(dirty);
  const record = unit.records.find((r) => r.id === recordId);
  return <section ref={content} className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-8 lg:px-12">
    <nav className="flex justify-end gap-2"><Button variant={mode === 'lesson' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('lesson')}>课件</Button><Button variant={mode === 'assessment' ? 'secondary' : 'ghost'} size="sm" onClick={() => setMode('assessment')}>测评草稿</Button></nav>
    {mode === 'lesson' && <LessonContent unit={unit} metadata={metadata} quote={quote} />}
    {mode === 'assessment' && <><div><Badge variant="outline">单元测评</Badge><h1 className="mt-4 text-3xl font-semibold tracking-tight">{metadata?.title ?? '测评草稿'}</h1><p className="mt-3 text-sm leading-relaxed text-muted-foreground">出题、评估和代码执行尚未接入。这里只保存本单元作答，不会产生通过结果。</p></div>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><FileQuestion className="size-4" />01 · 解释题</CardTitle><CardDescription>{unit.assessment?.q1 ?? '解释题笔记'}</CardDescription></CardHeader><CardContent><Textarea aria-label="解释题作答" rows={5} placeholder="用自己的话说明你的理解…" value={draft.q1} disabled={request.busy} onChange={(e) => setDraft({ ...draft, q1: e.target.value })} /></CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><Code2 className="size-4" />02 · 代码练习</CardTitle><CardDescription>{unit.assessment?.q2 ?? '代码题笔记'}</CardDescription></CardHeader><CardContent><CodeEditor label="代码题作答" className="h-64 rounded-lg" value={draft.q2} disabled={request.busy} onChange={(value) => setDraft({ ...draft, q2: value })} /></CardContent></Card>
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur"><div><p className="text-xs text-muted-foreground">{dirty ? '测评草稿未保存' : '测评草稿已保存'}</p><RequestState request={request} /></div>
      <Button disabled={request.busy || !dirty} onClick={() => request.run(async () => {
        const saved = await api<AssessmentDraft>(`/spaces/${space}/units/${unit.id}/draft`, { revision: draft.revision, q1: draft.q1, q2: draft.q2 });
        setDraft((current) => JSON.stringify(current) === JSON.stringify(draft) ? saved : { ...current, revision: saved.revision });
        setUnit({ ...unit, draft: saved });
      })}>保存测评草稿</Button></div></>}
    {mode === 'record' && record && <><div className="flex flex-col items-center gap-4 py-6 text-center"><span className="flex size-14 items-center justify-center rounded-full bg-primary/10">{record.result === 'pass' ? <CircleCheck className="size-7" /> : <Lightbulb className="size-7" />}</span><Badge variant="outline">测评记录</Badge><h1 className="text-3xl font-semibold tracking-tight">{record.result === 'pass' ? '测评通过' : '仍需加强'} · 第 {record.attempt} 次</h1><p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{record.summary}</p></div>
      {([['已掌握', record.mastered], ['需加强', record.concerns], ['判断依据', record.evidence], ['尚未验证', record.toVerify]] as const).map(([label, lines]) => <Card key={label}><CardHeader><CardTitle>{label}</CardTitle></CardHeader><CardContent><ul className="flex list-inside list-disc flex-col gap-2 text-sm leading-relaxed">{lines.map((line, i) => <li key={i}>{line}</li>)}</ul></CardContent></Card>)}
      <details className="rounded-xl border p-4"><summary className="cursor-pointer text-sm font-medium">本次作答</summary><pre className="mt-4 whitespace-pre-wrap text-sm">{record.answers.q1}{'\n'}{record.answers.q2}</pre></details>
      <Button variant="outline" className="self-start" onClick={() => quote({ source: 'advice', label: `测评建议 · 第 ${record.attempt} 次`, text: record.concerns.join('\n') || record.summary })}><MessageSquareQuote />引用测评建议</Button></>}
    <div className="mt-4 border-t pt-4"><h2 className="mb-2 text-sm font-medium">本单元测评记录</h2>{unit.records.length ? unit.records.map((r) => <Button key={r.id} variant="ghost" size="sm" onClick={() => { setRecordId(r.id); setMode('record'); }}>第 {r.attempt} 次 · {r.result === 'pass' ? '通过' : '需加强'}</Button>) : <p className="text-xs text-muted-foreground">尚无测评记录</p>}</div>
  </section>;
}
