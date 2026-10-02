import { useEffect, useRef, useState } from 'react';
import type { Quote, SessionDetail, SessionSummary, Workspace } from '@teach-me-coding/contracts';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { RequestState, useRequest, useUnsavedWarning } from './request-state';

function SessionEditor({ initial, space, quote, consumeQuote }: { initial: SessionDetail; space: string; quote: Quote | null; consumeQuote: () => void }) {
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
  return <div className="flex flex-col gap-4">
    <p className="text-xs leading-relaxed text-muted-foreground">教学 Agent 尚未接入。可以保存问题、草稿与引用，不会生成回复或执行代码。</p>
    <div className="flex min-h-24 flex-col gap-3" aria-label="会话消息">
      {session.messages.length === 0 && <p className="py-4 text-sm text-muted-foreground">新会话没有历史消息。</p>}
      {session.messages.map((m) => <article key={m.id} className="rounded-xl bg-muted p-3 text-sm">
        <p className="mb-1 text-xs text-muted-foreground">{m.role === 'user' ? '你' : 'Agent'}</p>
        {m.quote && <blockquote className="mb-2 border-l-2 pl-2 text-xs">{m.quote.label} · {m.quote.text}</blockquote>}
        <p className="whitespace-pre-wrap break-words">{m.text}</p>
      </article>)}
    </div>
    {draft.quote && <blockquote className="rounded-lg border p-3 text-sm" data-testid="composer-quote">
      <p className="font-medium">{draft.quote.label}</p><p className="max-h-24 overflow-auto whitespace-pre-wrap text-xs">{draft.quote.text}</p>
      <Button size="sm" variant="ghost" disabled={request.busy} onClick={() => setDraft({ ...draft, quote: null })}>移除引用</Button>
    </blockquote>}
    <label className="text-sm">会话草稿<Textarea value={draft.text} rows={4} disabled={request.busy} onChange={(e) => setDraft({ ...draft, text: e.target.value })} /></label>
    {session.scope === 'route' && <label className="text-sm">路线调整想法<Textarea value={draft.routeSuggestion} disabled={request.busy} onChange={(e) => setDraft({ ...draft, routeSuggestion: e.target.value })} /></label>}
    <RequestState request={request} />
    <p className="text-xs text-muted-foreground">{dirty ? '草稿未保存' : '草稿已保存'}</p>
    <div className="flex gap-2"><Button variant="outline" disabled={request.busy || !dirty} onClick={() => save(false)}>保存草稿</Button>
      <Button disabled={request.busy || (!draft.text.trim() && !draft.quote)} onClick={() => save(true)}>保存问题</Button></div>
  </div>;
}

export function Conversation({ workspace, scope, unitId, quote, consumeQuote, onSessions }: {
  workspace: Workspace; scope: SessionSummary['scope']; unitId: string | null; quote: Quote | null;
  consumeQuote: () => void; onSessions: (session: SessionSummary) => void;
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
  return <aside className="flex h-full w-96 shrink-0 flex-col overflow-y-auto border-l bg-card p-5" aria-label="学习会话">
    <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">学习会话</h2><Button size="sm" variant="outline" disabled={request.busy} onClick={create}>新会话</Button></div>
    <label className="mb-4 text-xs text-muted-foreground">{scope === 'intake' ? '需求' : scope === 'route' ? '路线' : '当前单元'} · 历史会话
      <select aria-label="历史会话" className="mt-2 w-full rounded-md border bg-background p-2 text-sm text-foreground" value={id ?? ''} disabled={request.busy} onChange={(e) => setSelected({ ...selected, [key]: e.target.value })}>
        {!sessions.length && <option value="">尚无会话</option>}{sessions.map((s, index) => <option key={s.id} value={s.id}>{s.title} · {index + 1}</option>)}
      </select>
    </label>
    <RequestState request={request} />
    {Object.values(loaded).map((s) => <div key={s.id} hidden={s.id !== id}><SessionEditor initial={s} space={workspace.id} quote={s.id === id ? quote : null} consumeQuote={consumeQuote} /></div>)}
    {!id && <p className="text-sm text-muted-foreground">点击「新会话」开始记录本单元的问题。</p>}
  </aside>;
}
