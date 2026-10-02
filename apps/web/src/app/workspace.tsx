import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Code2, MessageSquare, Plus } from 'lucide-react';
import type { Quote, SpaceSummary, UnitDetail, Workspace } from '@teach-me-coding/contracts';
import { Brand } from '@/components/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { Conversation } from './conversation';
import { Requirements, UnitContent } from './learning-content';
import { ProjectEditor } from './project-editor';
import { RequestState, useRequest } from './request-state';

function WorkspaceScreen({ initial, home, active }: { initial: Workspace; home: () => void; active: boolean }) {
  const [workspace, setWorkspace] = useState(initial);
  const [tab, setTab] = useState<'requirement' | 'route' | 'unit'>(() => {
    const tab = new URLSearchParams(location.search).get('tab');
    return tab === 'route' || tab === 'unit' ? tab : 'requirement';
  });
  const [unitId, setUnitId] = useState<string | null>(() => new URLSearchParams(location.search).get('unit'));
  const [units, setUnits] = useState<Record<string, UnitDetail>>({});
  const [agentOpen, setAgentOpen] = useState(true);
  const [ideOpen, setIdeOpen] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const clearQuote = useCallback(() => setQuote(null), []);
  const request = useRequest();
  const attempted = useRef<string | null>(null);
  const select = (next: typeof tab, unit: string | null = unitId) => {
    setTab(next); setUnitId(unit); setQuote(null);
  };
  useEffect(() => {
    if (!active) return;
    const params = new URLSearchParams({ space: workspace.id, tab });
    if (unitId) params.set('unit', unitId);
    history.replaceState(null, '', `/?${params}`);
  }, [active, workspace.id, tab, unitId]);
  useEffect(() => {
    if (tab !== 'unit' || !unitId || units[unitId] || request.busy || attempted.current === unitId) return;
    attempted.current = unitId;
    void request.run(async () => { const unit = await api<UnitDetail>(`/spaces/${workspace.id}/units/${unitId}`); setUnits((all) => ({ ...all, [unitId]: unit })); });
  }, [tab, unitId, units, workspace.id, request.run, request.busy]);
  const scope = tab === 'requirement' ? 'intake' : tab === 'route' ? 'route' : 'unit';
  const addQuote = (q: Quote) => { setQuote(q); setAgentOpen(true); };
  return <div className="flex h-dvh min-w-[1100px] flex-col">
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-5"><Button variant="ghost" size="sm" onClick={home}><ArrowLeft />全部空间</Button><span className="text-sm font-semibold">{workspace.name}</span>
      <nav className="ml-5 flex gap-2"><Button variant={tab === 'requirement' ? 'secondary' : 'ghost'} size="sm" onClick={() => select('requirement')}>学习需求</Button><Button variant={tab === 'route' ? 'secondary' : 'ghost'} size="sm" onClick={() => select('route')}>学习路线</Button></nav>
      <div className="ml-auto flex gap-2"><Button variant="outline" size="sm" onClick={() => setIdeOpen(!ideOpen)}><Code2 />项目 IDE</Button><Button variant="outline" size="sm" onClick={() => setAgentOpen(!agentOpen)}><MessageSquare />学习会话</Button></div>
    </header>
    <div className="flex min-h-0 flex-1"><aside className="w-56 shrink-0 overflow-y-auto border-r bg-muted/20 p-4">
      <h2 className="mb-4 text-xs font-medium text-muted-foreground">学习路线</h2>
      {workspace.route.content ? workspace.route.content.stages.map((stage) => <div key={stage.id} className="mb-5"><h3 className="mb-2 text-xs font-semibold">{stage.title}</h3>{stage.units.map((u) => <button key={u.id} disabled={request.busy} onClick={() => select('unit', u.id)} className={`mb-1 w-full rounded-lg p-2 text-left text-sm hover:bg-muted ${unitId === u.id && tab === 'unit' ? 'bg-muted' : ''}`}>{u.title}</button>)}</div>) : <p className="text-xs leading-relaxed text-muted-foreground">尚无路线。先保存需求，路线生成将在后续接入。</p>}
    </aside><main className="flex min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div hidden={tab !== 'requirement'}><Requirements workspace={workspace} update={(requirement) => setWorkspace({ ...workspace, requirement })} /></div>
        {tab === 'route' && <section className="mx-auto max-w-3xl p-8"><h1 className="mb-4 text-2xl font-semibold">学习路线</h1><p className="text-sm leading-relaxed text-muted-foreground">{workspace.route.content?.note ?? '路线尚未生成。当前不会使用预设路线代替真实生成结果。'}</p>
          {workspace.route.content?.stages.map((stage) => <article key={stage.id} className="my-6 rounded-xl border p-5"><h2 className="mb-4 font-semibold">{stage.title}</h2>{stage.units.map((unit) => <button key={unit.id} className="flex w-full flex-col gap-1 rounded-lg p-3 text-left hover:bg-muted" onClick={() => select('unit', unit.id)}><strong className="text-sm">{unit.title}</strong><span className="text-xs text-muted-foreground">{unit.summary}</span></button>)}</article>)}
          {workspace.proposals.filter((p) => p.state === 'pending').map((p) => <article key={p.id} className="my-4 rounded-xl border p-4"><h2 className="font-medium">待确认路线提案</h2><p className="my-2 text-sm">{p.content.note}</p>{p.content.stages.map((s) => <p key={s.id} className="my-2 text-xs">{s.title}：{s.units.map((u) => u.title).join(' → ')}</p>)}<Button disabled={request.busy} onClick={() => request.run(async () => setWorkspace(await api(`/spaces/${workspace.id}/proposals/${p.id}/apply`, {})))}>确认应用提案</Button></article>)}
        </section>}
        {Object.values(units).map((unit) => <div key={unit.id} hidden={tab !== 'unit' || unitId !== unit.id}><UnitContent initial={unit} space={workspace.id} quote={addQuote} /></div>)}
        <div className="px-8"><RequestState request={request} /></div>
      </div>
      <ProjectEditor space={workspace.id} open={ideOpen} close={() => setIdeOpen(false)} quote={addQuote} />
    </main><div hidden={!agentOpen}><Conversation workspace={workspace} scope={scope} unitId={scope === 'unit' ? unitId : null} quote={quote} consumeQuote={clearQuote} onSessions={(session) => setWorkspace((s) => ({ ...s, sessions: [...s.sessions, session] }))} /></div></div>
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-muted px-4 text-[10px] text-muted-foreground"><span>本地持久化 · 手动保存 · Agent / 终端未接入</span><a href="/diagnostics">运行诊断</a><a href="/preview">隔离演示</a></footer>
  </div>;
}

export default function PersistentApp() {
  const request = useRequest();
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [loaded, setLoaded] = useState<Record<string, Workspace>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [goal, setGoal] = useState('');
  const open = async (id: string) => {
    const workspace = loaded[id] ?? await api<Workspace>(`/spaces/${id}`);
    setLoaded((all) => ({ ...all, [id]: workspace })); setSelected(id);
    if (new URLSearchParams(location.search).get('space') !== id) history.replaceState(null, '', `/?space=${id}`);
  };
  useEffect(() => { void request.run(async () => {
    setSpaces(await api('/spaces')); setReady(true);
    const id = new URLSearchParams(location.search).get('space'); if (id) await open(id);
  }); }, [request.run]);
  const home = () => { setSelected(null); history.replaceState(null, '', '/'); };
  return <>
    <div hidden={selected !== null} className="min-h-dvh">
      <header className="flex h-14 items-center justify-between border-b px-8"><Brand /><div className="flex gap-4 text-xs text-muted-foreground"><a href="/diagnostics">运行诊断</a><a href="/preview">界面演示</a></div></header>
      <main className="mx-auto max-w-4xl px-8 py-16"><p className="mb-4 text-xs text-muted-foreground">你的本地学习空间</p><h1 className="text-4xl font-semibold tracking-tight">你想学会什么？</h1><p className="mt-5 text-sm leading-relaxed text-muted-foreground">需求、会话和学习记录保存在本机。项目文件可直接编辑；教学 Agent 与终端尚未接入。</p>
        <form className="my-8 flex gap-3 rounded-xl border bg-card p-4 shadow-sm" onSubmit={(e) => { e.preventDefault(); void request.run(async () => {
          const workspace = await api<Workspace>('/spaces', { name: goal.trim().slice(0, 80), goal: goal.trim() });
          setSpaces((all) => all.some((s) => s.id === workspace.id) ? all : [workspace, ...all]);
          setLoaded((all) => ({ ...all, [workspace.id]: workspace })); setSelected(workspace.id); setGoal(''); history.replaceState(null, '', `/?space=${workspace.id}`);
        }); }}><Input aria-label="学习目标" value={goal} maxLength={200} disabled={request.busy || !ready} placeholder="比如：学习 Rust，写一个命令行工具" onChange={(e) => setGoal(e.target.value)} /><Button disabled={request.busy || !ready || !goal.trim()} type="submit"><Plus />创建学习空间</Button></form>
        <RequestState request={request} />
        <h2 className="mb-4 mt-10 text-lg font-semibold">全部学习空间</h2>{ready && !spaces.length && <p className="text-sm text-muted-foreground">还没有学习空间，写下目标开始。</p>}
        <div className="grid grid-cols-2 gap-4">{spaces.map((space) => <button key={space.id} disabled={request.busy} onClick={() => request.run(() => open(space.id))} className="rounded-xl border p-6 text-left hover:bg-muted"><h3 className="font-semibold">{space.name}</h3><p className="mt-2 text-xs text-muted-foreground">保存在本机 · 打开空间</p></button>)}</div>
      </main>
    </div>
    {Object.values(loaded).map((workspace) => <div key={workspace.id} hidden={selected !== workspace.id}><WorkspaceScreen initial={workspace} home={home} active={selected === workspace.id} /></div>)}
  </>;
}
