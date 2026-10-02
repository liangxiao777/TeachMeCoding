import { useEffect, useRef, useState } from 'react';
import { ArrowUp, History, Plus, X } from 'lucide-react';
import type { Quote, SessionDetail, SessionSummary, Workspace } from '@teach-me-coding/contracts';
import { BrandMark, RichText } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import { api } from '@/lib/api';
import { RequestState, useRequest, useUnsavedWarning } from './request-state';

function SessionEditor({ initial, space, quote, consumeQuote, intake }: { initial: SessionDetail; space: string; quote: Quote | null; consumeQuote: () => void; intake: boolean }) {
  const [session, setSession] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const request = useRequest();
  const dirty = JSON.stringify(draft) !== JSON.stringify(session.draft);
  useUnsavedWarning(dirty);
  useEffect(() => { if (quote) { setDraft((d) => ({ ...d, quote })); consumeQuote(); } }, [quote, consumeQuote]);
  const save = (send: boolean) => request.run(async () => {
    const next = await api<SessionDetail>(`/spaces/${space}/sessions/${session.id}/${send ? 'messages' : 'draft'}`,
      send ? { text: draft.text, quote: draft.quote, draftRevision: draft.revision } : draft);
    setSession(next);
    setDraft((current) => JSON.stringify(current) === JSON.stringify(draft) ? next.draft : { ...current, revision: next.draft.revision });
  });
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className={`flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto ${intake ? 'py-8' : 'p-4'}`} aria-label="会话消息">
      {session.messages.length === 0 && <div className={`flex flex-col gap-4 ${intake ? '' : 'mt-auto'}`}>
        <BrandMark className="size-9" />
        {intake ? <h1 className="text-xl font-semibold tracking-tight">从你的目标开始</h1> : <h3 className="text-base font-semibold">有什么想问的？</h3>}
        <p className="max-w-lg text-sm leading-relaxed text-muted-foreground">{intake ? '在右侧填写并确认学习需求，也可以在这里记录问题和想法。' : '围绕当前学习内容记录问题，也可以从课件或代码中引用内容。'}</p>
        <p className="text-xs text-muted-foreground">新会话没有历史消息。</p>
      </div>}
      {session.messages.map((m) => <article key={m.id} className={`flex max-w-[90%] flex-col gap-2 text-sm leading-relaxed ${m.role === 'user' ? 'self-end rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-primary-foreground shadow-sm' : 'self-start py-2'}`}>
        <span className="sr-only">{m.role === 'user' ? '你' : 'Agent'}</span>
        {m.quote && <blockquote className="rounded-lg border border-current/20 bg-current/5 p-3 text-xs"><p className="mb-1 font-medium">{m.quote.label}</p><p className="whitespace-pre-wrap">{m.quote.text}</p></blockquote>}
        <RichText text={m.text} />
      </article>)}
    </div>
    <div className={`flex shrink-0 flex-col gap-3 ${intake ? 'pb-6' : 'p-3'}`}>
      <p className="text-xs leading-relaxed text-muted-foreground">教学 Agent 尚未接入。问题仅保存，不会生成回复或执行代码。</p>
      <RequestState request={request} />
      {session.scope === 'route' && <details open className="rounded-xl border bg-background p-3"><summary className="cursor-pointer text-xs text-muted-foreground">路线调整想法 · 独立草稿</summary><textarea aria-label="路线调整想法" rows={2} className="mt-2 w-full resize-none bg-transparent text-sm outline-none" value={draft.routeSuggestion} disabled={request.busy} onChange={(e) => setDraft({ ...draft, routeSuggestion: e.target.value })} placeholder="说说你想怎么调整学习路线…" /></details>}
      <InputGroup className="rounded-xl bg-background shadow-sm">
        {draft.quote && <InputGroupAddon align="block-start" className="pb-0"><blockquote className="w-full rounded-lg border bg-muted/60 px-3 py-2" data-testid="composer-quote"><div className="flex items-center justify-between gap-2"><p className="text-xs font-medium">{draft.quote.label}</p><Button size="icon-xs" variant="ghost" aria-label="移除引用" disabled={request.busy} onClick={() => setDraft({ ...draft, quote: null })}><X /></Button></div><p className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed">{draft.quote.text}</p></blockquote></InputGroupAddon>}
        <InputGroupTextarea aria-label="会话草稿" placeholder={draft.quote ? '针对引用的内容，你想问什么？' : '说说你的想法…'} value={draft.text} rows={intake ? 3 : 4} disabled={request.busy} onChange={(e) => setDraft({ ...draft, text: e.target.value })} className="min-h-16 leading-relaxed" />
        <InputGroupAddon align="block-end"><span className="text-[10px]">{dirty ? '草稿未保存' : '草稿已保存'}</span><Button size="xs" variant="ghost" className="ml-auto" disabled={request.busy || !dirty} onClick={() => save(false)}>保存草稿</Button><Button size="icon-sm" className="rounded-full" aria-label="保存问题" title="保存问题（暂不调用 Agent）" disabled={request.busy || (!draft.text.trim() && !draft.quote)} onClick={() => save(true)}><ArrowUp /></Button></InputGroupAddon>
      </InputGroup>
    </div>
  </div>;
}

export function Conversation({ workspace, scope, unitId, quote, consumeQuote, onSessions, intake, close }: {
  workspace: Workspace; scope: SessionSummary['scope']; unitId: string | null; quote: Quote | null;
  consumeQuote: () => void; onSessions: (session: SessionSummary) => void;
  intake: boolean; close: () => void;
}) {
  const request = useRequest();
  const attempted = useRef<string | undefined>(undefined);
  const [loaded, setLoaded] = useState<Record<string, SessionDetail>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const key = `${scope}:${unitId ?? ''}`;
  const sessions = workspace.sessions.filter((s) => s.scope === scope && s.unitId === unitId);
  const remembered = selected[key] ?? sessionStorage.getItem(`session:${workspace.id}:${key}`);
  const id = sessions.find((s) => s.id === remembered)?.id ?? sessions[0]?.id;
  useEffect(() => { if (id) sessionStorage.setItem(`session:${workspace.id}:${key}`, id); }, [id, key, workspace.id]);
  useEffect(() => {
    if (!id || loaded[id] || request.busy || attempted.current === id) return;
    attempted.current = id;
    void request.run(async () => {
      const session = await api<SessionDetail>(`/spaces/${workspace.id}/sessions/${id}`);
      setLoaded((all) => ({ ...all, [id]: session }));
    });
  }, [id, loaded, workspace.id, request.run, request.busy]);
  const create = () => request.run(async () => {
    const session = await api<SessionDetail>(`/spaces/${workspace.id}/sessions`, { scope, unitId, title: '新会话' });
    onSessions(session); setLoaded((all) => ({ ...all, [session.id]: session })); setSelected((all) => ({ ...all, [key]: session.id }));
  });
  return <aside className={`flex h-full min-h-0 shrink-0 flex-col ${intake ? 'w-full' : 'w-96 border-l bg-sidebar'}`} aria-label="学习会话">
    <div className={`flex h-12 shrink-0 items-center gap-1 ${intake ? 'border-b' : 'border-b px-2'}`}>
      <History className="mx-1 size-3.5 shrink-0 text-muted-foreground" />
      <select aria-label="历史会话" className="min-w-0 flex-1 rounded-md bg-transparent py-2 text-sm text-foreground outline-none" value={id ?? ''} disabled={request.busy} onChange={(e) => setSelected({ ...selected, [key]: e.target.value })}>
        {!sessions.length && <option value="">尚无会话</option>}{sessions.map((s, index) => <option key={s.id} value={s.id}>{s.title} · {index + 1}</option>)}
      </select>
      <Button size="icon-sm" variant="ghost" aria-label="新会话" title="新会话" disabled={request.busy} onClick={create}><Plus /></Button>
      {!intake && <Button size="icon-sm" variant="ghost" aria-label="收起 Agent" onClick={close}><X /></Button>}
    </div>
    <div className="px-3"><RequestState request={request} /></div>
    {Object.values(loaded).map((s) => <div key={s.id} hidden={s.id !== id} className="flex min-h-0 flex-1 flex-col"><SessionEditor initial={s} space={workspace.id} quote={s.id === id ? quote : null} consumeQuote={consumeQuote} intake={intake} /></div>)}
    {!id && <div className="mt-auto flex flex-col gap-4 p-4"><BrandMark className="size-9" /><h3 className="font-semibold">有什么想问的？</h3><p className="text-sm leading-relaxed text-muted-foreground">点击「新会话」开始记录本单元的问题。教学 Agent 尚未接入。</p></div>}
  </aside>;
}
