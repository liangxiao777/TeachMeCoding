import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, Code2, LayoutGrid, MessageSquare, PanelLeft, Plus, Sparkles } from 'lucide-react';
import type { Quote, SpaceSummary, UnitDetail, Workspace } from '@teach-me-coding/contracts';
import { LearningHome } from '@/components/learning-home';
import { Brand, isComposing, StatusIcon, StatusPill } from '@/components/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { Conversation } from './conversation';
import { LessonContent, Requirements, UnitContent } from './learning-content';
import { ProjectEditor } from './project-editor';
import { RequestState, useRequest } from './request-state';

function AppFooter() {
  return <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-muted px-3 text-[10px] text-muted-foreground">
    <span>本地持久化 · 手动保存 · Agent / 终端未接入</span><a href="/diagnostics">运行诊断</a><a href="/preview">隔离演示</a>
  </footer>;
}

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
  const [full, setFull] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [lessonOpen, setLessonOpen] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const clearQuote = useCallback(() => setQuote(null), []);
  const closeIde = useCallback(() => { setFull(false); setIdeOpen(false); }, []);
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
  const intake = tab === 'requirement' && !ideOpen;
  const routeUnits = workspace.route.content?.stages.flatMap((stage) => stage.units) ?? [];
  const currentUnit = routeUnits.find((unit) => unit.id === unitId);
  const resume = currentUnit ?? routeUnits[0];
  return <div className={`flex h-dvh min-w-[1100px] flex-col ${full ? 'dark bg-background text-foreground' : ''}`}>
    <header className="shrink-0 border-b bg-background/80 backdrop-blur">
      <div className={`flex h-14 items-center gap-3 ${intake ? 'mx-auto max-w-6xl px-6' : 'px-4'}`}>
        {intake ? <Button variant="ghost" size="sm" onClick={home}><ArrowLeft />全部空间</Button> : <Brand onClick={home} />}
        <span className="h-5 w-px bg-border" />
        <Button variant="ghost" size="sm" onClick={home} title="全部空间" aria-label={intake ? undefined : '全部空间'}>{workspace.name}</Button>
        {!full && <nav aria-label="空间导航" className="flex min-w-0 items-center gap-1 text-sm">
          <ChevronRight className="size-3 text-muted-foreground" />
          <Button variant="ghost" size="sm" onClick={() => select(tab === 'requirement' ? 'route' : 'requirement')}>{tab === 'requirement' ? '学习路线' : '学习需求'}</Button>
          {tab !== 'requirement' && <Button variant="ghost" size="sm" onClick={() => select('route')}>学习路线</Button>}
          {tab === 'unit' && <><ChevronRight className="size-3 text-muted-foreground" /><span className="truncate">{currentUnit?.title}</span></>}
        </nav>}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {intake && <Badge variant="outline" className="mr-2">第 1 步 · 确认学习需求</Badge>}
          {full && currentUnit && <Button variant="ghost" size="sm" onClick={() => setLessonOpen(true)}><BookOpen />查看课件</Button>}
          {!full && <>
            {(tab === 'unit' || ideOpen) && <Button variant="ghost" size="icon-sm" aria-label="切换文件目录" aria-pressed={explorerOpen} onClick={() => setExplorerOpen(!explorerOpen)}><PanelLeft /></Button>}
            <Button variant={ideOpen ? 'secondary' : 'ghost'} size="sm" aria-label="项目 IDE" onClick={() => ideOpen ? closeIde() : setIdeOpen(true)}><Code2 />IDE</Button>
          </>}
          {!intake && <Button variant={agentOpen ? 'secondary' : 'ghost'} size="sm" aria-label="学习会话" onClick={() => setAgentOpen(!agentOpen)}><MessageSquare />Agent</Button>}
          {full && <Button variant="outline" size="sm" onClick={closeIde}><ArrowLeft />返回学习</Button>}
        </div>
      </div>
    </header>
    <div className={intake ? 'mx-auto grid min-h-0 w-full max-w-6xl flex-1 grid-cols-[1fr_380px] gap-10 px-6' : 'flex min-h-0 flex-1'}>
      <main className={`flex min-h-0 min-w-0 flex-1 flex-col ${intake ? 'col-start-2 row-start-1' : ''}`}>
        <ProjectEditor space={workspace.id} open={ideOpen} close={closeIde} quote={addQuote} full={full} setFull={setFull}
          explorer={(tab === 'unit' || ideOpen) && explorerOpen}
          materials={tab === 'unit' && !full ? <details open className="border-b pb-3">
            <summary className="cursor-pointer px-2 py-2 text-xs font-medium text-muted-foreground">学习单元</summary>
            {routeUnits.map((unit) => <button key={unit.id} onClick={() => select('unit', unit.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent ${unit.id === unitId ? 'bg-sidebar-accent' : 'text-muted-foreground'}`}><BookOpen className="size-3.5 shrink-0" />{unit.title}</button>)}
          </details> : null}>
          <div hidden={tab !== 'requirement'} className="py-8"><Requirements workspace={workspace} update={(requirement) => setWorkspace((current) => ({ ...current, requirement }))} /></div>
          {tab === 'route' && <div data-testid="route-content" className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-8 py-10">
            <section className="flex flex-col gap-6">
              <div className="flex flex-col gap-3"><Badge variant="outline" className="w-fit font-mono">学习路线</Badge><h1 aria-label="学习路线" className="text-balance text-4xl font-semibold tracking-tight">{workspace.name}</h1><p className="max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">{workspace.requirement.value.goal}</p></div>
              {resume && <Card className="bg-primary text-primary-foreground ring-0"><CardHeader><CardDescription className="text-primary-foreground/75">{currentUnit ? '从这里继续' : '从这里开始'}</CardDescription><CardTitle className="text-xl">{resume.title}</CardTitle><CardAction><Button variant="secondary" size="lg" onClick={() => select('unit', resume.id)}>继续学习<ArrowRight /></Button></CardAction></CardHeader><CardContent><p className="text-sm leading-relaxed text-primary-foreground/85">{resume.summary}</p><p className="mt-3 font-mono text-xs text-primary-foreground/75">{routeUnits.length} 个学习单元</p></CardContent></Card>}
              <dl className="grid grid-cols-3 overflow-hidden rounded-xl border bg-card text-sm">{([['已有基础', workspace.requirement.value.background], ['期望达成', workspace.requirement.value.outcome], ['时间安排', workspace.requirement.value.schedule]] as const).map(([label, value], i) => <div key={label} className={`flex flex-col gap-1.5 p-4 ${i ? 'border-l' : ''}`}><dt className="text-xs font-medium tracking-wider text-muted-foreground">{label}</dt><dd className="leading-relaxed">{value || '尚未填写'}</dd></div>)}</dl>
              <div className="flex gap-3 rounded-xl border p-4"><Sparkles className="mt-0.5 size-4 shrink-0" /><div className="text-sm"><h2 className="mb-1 font-medium">{workspace.route.content ? '为什么这样安排' : '等待学习路线'}</h2><p className="leading-relaxed text-muted-foreground">{workspace.route.content?.note ?? '路线尚未生成。教学 Agent 尚未接入，已保存的需求不会被预设路线替代。'}</p></div></div>
            </section>
            <div data-testid="route-timeline" className="flex flex-col gap-10">{workspace.route.content?.stages.map((stage, si) => <section key={stage.id} className="flex flex-col gap-5">
              <h2 className="flex items-center gap-3 text-lg font-semibold tracking-tight"><span className="rounded-md bg-foreground px-2 py-1 font-mono text-xs text-background">阶段 {si + 1}</span>{stage.title}</h2>
              <ol>{stage.units.map((unit, ui) => <li key={unit.id} className="relative flex gap-4"><div className="flex flex-col items-center">{units[unit.id] ? <StatusIcon status={units[unit.id]!.status} /> : <span className="flex size-7 items-center justify-center rounded-full border bg-card font-mono text-xs text-muted-foreground">{ui + 1}</span>}{ui < stage.units.length - 1 && <span className="my-1 w-px flex-1 bg-border" />}</div>
                <Card className={`mb-4 flex-1 ${unitId === unit.id ? 'shadow-md ring-2 ring-primary/60' : 'hover:shadow-sm'}`}><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-normal text-muted-foreground">{si + 1}.{ui + 1}</span>{unit.title}{units[unit.id] && <StatusPill status={units[unit.id]!.status} />}</CardTitle><CardDescription className="leading-relaxed">{unit.summary}</CardDescription><CardAction><Button variant="outline" size="sm" aria-label={unit.title} onClick={() => select('unit', unit.id)}>进入<ArrowRight /></Button></CardAction></CardHeader><CardContent><ul className="flex flex-wrap gap-1.5">{unit.goals.map((goal) => <li key={goal}><Badge variant="secondary" className="font-normal">{goal}</Badge></li>)}</ul></CardContent></Card>
              </li>)}</ol>
            </section>)}</div>
            {workspace.proposals.filter((p) => p.state === 'pending').map((p) => <Card key={p.id}><CardHeader><CardTitle>待确认路线提案</CardTitle><CardDescription>{p.content.note}</CardDescription></CardHeader><CardContent>{p.content.stages.map((s) => <p key={s.id} className="my-2 text-sm">{s.title}：{s.units.map((u) => u.title).join(' → ')}</p>)}</CardContent><CardFooter><Button disabled={request.busy} onClick={() => request.run(async () => setWorkspace(await api(`/spaces/${workspace.id}/proposals/${p.id}/apply`, {})))}>确认应用提案</Button></CardFooter></Card>)}
          </div>}
          {Object.values(units).map((unit) => <div key={unit.id} hidden={tab !== 'unit' || unitId !== unit.id}><UnitContent initial={unit} space={workspace.id} quote={addQuote} metadata={routeUnits.find((u) => u.id === unit.id)} /></div>)}
          <div className="px-4"><RequestState request={request} /></div>
        </ProjectEditor>
      </main>
      <div hidden={!intake && !agentOpen} className={intake ? 'col-start-1 row-start-1 flex min-h-0' : 'flex min-h-0 shrink-0'}>
        <Conversation workspace={workspace} scope={scope} unitId={scope === 'unit' ? unitId : null} quote={quote} consumeQuote={clearQuote} intake={intake} close={() => setAgentOpen(false)} onSessions={(session) => setWorkspace((s) => ({ ...s, sessions: [...s.sessions, session] }))} />
      </div>
    </div>
    <Sheet open={lessonOpen} onOpenChange={setLessonOpen}><SheetContent side="left" className="dark w-[720px]! max-w-[80vw]! gap-0 bg-background text-foreground"><SheetHeader className="border-b"><SheetTitle>当前课件</SheetTitle><SheetDescription>查阅后关闭，继续编写代码。</SheetDescription></SheetHeader><div className="overflow-y-auto px-8 py-8">{unitId && units[unitId] && <LessonContent unit={units[unitId]!} metadata={currentUnit} quote={(value) => { addQuote(value); setLessonOpen(false); }} />}</div></SheetContent></Sheet>
    <AppFooter />
  </div>;
}

export default function PersistentApp() {
  const request = useRequest();
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [loaded, setLoaded] = useState<Record<string, Workspace>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [goal, setGoal] = useState('');
  const [view, setView] = useState<'home' | 'spaces'>('home');
  const open = async (id: string) => {
    const workspace = loaded[id] ?? await api<Workspace>(`/spaces/${id}`);
    setLoaded((all) => ({ ...all, [id]: workspace })); setSelected(id);
    if (new URLSearchParams(location.search).get('space') !== id) history.replaceState(null, '', `/?space=${id}`);
  };
  useEffect(() => { void request.run(async () => {
    setSpaces(await api('/spaces')); setReady(true);
    const id = new URLSearchParams(location.search).get('space'); if (id) await open(id);
  }); }, [request.run]);
  const home = () => { setSelected(null); setView('spaces'); history.replaceState(null, '', '/'); };
  const start = (text: string) => {
    if (!text.trim() || !ready) return;
    void request.run(async () => {
      const workspace = await api<Workspace>('/spaces', { name: text.trim().slice(0, 80), goal: text.trim() });
      setSpaces((all) => all.some((s) => s.id === workspace.id) ? all : [workspace, ...all]);
      setLoaded((all) => ({ ...all, [workspace.id]: workspace })); setSelected(workspace.id); setGoal(''); history.replaceState(null, '', `/?space=${workspace.id}`);
    });
  };
  return <div className="persistent-app">
    <div hidden={selected !== null}>
      <div className="min-h-[calc(100dvh-24px)]">
        <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur"><div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6"><Brand onClick={() => setView('home')} />{view === 'home' ? <Button variant="outline" onClick={() => setView('spaces')}><LayoutGrid />我的学习空间</Button> : <Button onClick={() => setView('home')}><Plus />创建学习空间</Button>}</div></header>
        <main className="mx-auto max-w-6xl px-6">
          {view === 'home' ? <LearningHome><div className="flex flex-col gap-3">
            <form className="rounded-xl bg-background" onSubmit={(e) => { e.preventDefault(); start(goal); }}><InputGroup className="h-14 rounded-xl bg-card shadow-sm"><InputGroupAddon><Sparkles className="text-primary" /></InputGroupAddon><InputGroupInput id="goal-input" aria-label="学习目标" autoFocus value={goal} maxLength={200} disabled={request.busy || !ready} placeholder="说说你想学什么，比如：我想学习 Rust，最后能写一个命令行工具" className="text-base" onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && isComposing(e)) e.preventDefault(); }} /><InputGroupAddon align="inline-end"><InputGroupButton type="submit" size="sm" variant="default" aria-label="创建学习空间" disabled={request.busy || !ready || !goal.trim()}>开始<ArrowRight /></InputGroupButton></InputGroupAddon></InputGroup></form>
            <div className="flex flex-wrap items-center justify-center gap-2"><span className="text-xs text-muted-foreground">试试：</span>{['我想学习 Rust，最后能写一个命令行工具', '我想用 PyTorch 训练一个图像分类模型', '我想学会用 Go 写后端服务'].map((example) => <Button key={example} variant="outline" size="sm" className="rounded-full" disabled={request.busy || !ready} onClick={() => { setGoal(example); start(example); }}>{example}</Button>)}</div>
            <RequestState request={request} />
          </div></LearningHome> : <div className="flex flex-col gap-8 py-12"><div className="flex flex-col gap-1.5"><h1 className="text-3xl font-semibold tracking-tight">我的学习空间</h1><p className="text-muted-foreground">{spaces.length ? '选择一个空间，从上次离开的地方继续。' : '还没有学习空间，先创建一个，开始你的学习之旅。'}</p></div><RequestState request={request} />
            <div className="grid grid-cols-2 gap-5 xl:grid-cols-3">{spaces.map((space) => <Card key={space.id} className="transition-shadow hover:shadow-md"><CardHeader><CardTitle className="text-lg tracking-tight"><h2>{space.name}</h2></CardTitle><CardDescription className="line-clamp-2 leading-relaxed">{loaded[space.id]?.requirement.value.goal ?? '需求、会话与项目文件保存在本机'}</CardDescription><CardAction><Badge variant="secondary">本地空间</Badge></CardAction></CardHeader><CardContent><p className="text-sm">{loaded[space.id]?.route.content ? '查看学习路线与记录' : '继续完善学习需求'}</p></CardContent><CardFooter className="mt-auto justify-between border-t bg-muted/40 py-3"><span className="text-xs text-muted-foreground">创建于 {new Date(space.createdAt).toLocaleDateString('zh-CN')}</span><Button size="sm" aria-label={`继续学习 ${space.name}`} disabled={request.busy} onClick={() => request.run(() => open(space.id))}>继续学习<ArrowRight /></Button></CardFooter></Card>)}
              <button type="button" onClick={() => setView('home')} className="group flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"><span className="flex size-10 items-center justify-center rounded-full bg-muted group-hover:bg-primary group-hover:text-primary-foreground"><Plus className="size-5" /></span><span className="text-sm font-medium">创建新的学习空间</span><span className="text-xs">开始一个独立的学习目标</span></button>
            </div>
          </div>}
        </main>
      </div>
      <AppFooter />
    </div>
    {Object.values(loaded).map((workspace) => <div key={workspace.id} hidden={selected !== workspace.id}><WorkspaceScreen initial={workspace} home={home} active={selected === workspace.id} /></div>)}
  </div>;
}
