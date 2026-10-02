import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileCode, FilePlus, Folder, FolderPlus, Maximize2, MessageSquareQuote, Minimize2, Pencil, RefreshCw, Save, TerminalSquare, X } from 'lucide-react';
import { usePanelRef } from 'react-resizable-panels';
import type { ProjectEntry, ProjectFile, Quote } from '@teach-me-coding/contracts';
import { CodeEditor, type EditorPosition } from '@/components/code-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { api } from '@/lib/api';
import { RequestState, useRequest, useUnsavedWarning } from './request-state';

type Buffer = ProjectFile & { edited: string };
export function ProjectEditor({ space, open, close, quote, full, setFull, explorer, materials, children }: {
  space: string; open: boolean; close: () => void; quote: (q: Quote) => void;
  full: boolean; setFull: (full: boolean) => void; explorer: boolean; materials: ReactNode; children: ReactNode;
}) {
  const request = useRequest();
  const [tree, setTree] = useState<ProjectEntry[]>([]);
  const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [selected, setSelected] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [path, setPath] = useState('');
  const [kind, setKind] = useState<'file' | 'directory'>('file');
  const [destination, setDestination] = useState('');
  const [disk, setDisk] = useState<ProjectFile | null>(null);
  const [pathAction, setPathAction] = useState<'create' | 'rename' | null>(null);
  const positions = useRef<Record<string, EditorPosition>>({});
  const idePanel = usePanelRef();
  const treePanel = usePanelRef();
  const normalHeight = useRef(40);
  const treeWidth = useRef(240);
  const buffer = buffers[active];
  const dirty = Object.values(buffers).some((b) => b.content !== b.edited);
  useUnsavedWarning(dirty);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && full && !event.defaultPrevented && !document.querySelector('[role="dialog"]')) close();
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [open, full, close]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => idePanel.current?.resize(`${open ? full ? 100 : normalHeight.current : 0}%`));
    return () => cancelAnimationFrame(frame);
  }, [open, full, idePanel]);
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => treePanel.current?.resize(`${explorer ? treeWidth.current : 0}px`));
    return () => cancelAnimationFrame(frame);
  }, [explorer, treePanel]);
  useEffect(() => { void request.run(async () => setTree(await api(`/spaces/${space}/project/tree`))); }, [space, request.run]);
  const refresh = async () => setTree(await api<ProjectEntry[]>(`/spaces/${space}/project/tree`));
  const show = (entry: ProjectEntry) => request.run(async () => {
    setSelected(entry.path); setDestination(entry.path);
    if (entry.kind === 'directory') { setExpanded((list) => list.includes(entry.path) ? list.filter((x) => x !== entry.path) : [...list, entry.path]); return; }
    if (!buffers[entry.path]) {
      const file = await api<ProjectFile>(`/spaces/${space}/project/file?path=${encodeURIComponent(entry.path)}`);
      setBuffers((all) => ({ ...all, [entry.path]: { ...file, edited: file.content } }));
    }
    setTabs((all) => [...new Set([...all, entry.path])]); setActive(entry.path); setDisk(null);
  });
  const create = () => request.run(async () => {
    await api(`/spaces/${space}/project/create`, { path, kind });
    setPath(''); setPathAction(null); await refresh();
  });
  const rename = () => request.run(async () => {
    const affected = (p: string) => p === selected || p.startsWith(`${selected}/`);
    if (Object.values(buffers).some((b) => affected(b.path) && b.content !== b.edited)) throw new Error('重命名前请先保存该文件或目录中的编辑内容。');
    const entry = tree.find((e) => e.path === selected);
    if (!entry) return;
    await api(`/spaces/${space}/project/rename`, { path: selected, destination, version: entry.version });
    // Close renamed buffers; reopening reads the new path/version instead of keeping stale identities.
    setBuffers((all) => Object.fromEntries(Object.entries(all).filter(([p]) => !affected(p))));
    setTabs((all) => all.filter((p) => !affected(p))); if (affected(active)) setActive('');
    setSelected(destination); setExpanded([]); setDisk(null); setPathAction(null); await refresh();
  });
  const save = () => request.run(async () => {
    if (!buffer) return;
    const file = await api<ProjectFile>(`/spaces/${space}/project/save`, { path: buffer.path, version: buffer.version, content: buffer.edited });
    setBuffers((all) => ({ ...all, [file.path]: { ...file, edited: all[file.path]?.edited ?? file.content } })); setDisk(null); await refresh();
  });
  const compare = () => request.run(async () => {
    if (buffer) setDisk(await api(`/spaces/${space}/project/file?path=${encodeURIComponent(buffer.path)}`));
  });
  const visible = tree.filter((entry) => entry.path.split('/').slice(0, -1).every((_, index, parts) => expanded.includes(parts.slice(0, index + 1).join('/'))));
  return <div className="flex min-h-0 flex-1">
    <ResizablePanelGroup orientation="horizontal" onLayoutChanged={(_, meta) => { if (meta.isUserInteraction && explorer) treeWidth.current = treePanel.current?.getSize().inPixels ?? 240; }}>
      <ResizablePanel id="project-tree" panelRef={treePanel} defaultSize="240px" minSize={explorer ? '200px' : 0} maxSize={explorer ? '35%' : 0}>
      <aside hidden={!explorer} className="flex h-full min-w-0 flex-col gap-3 overflow-auto bg-sidebar p-2" aria-label="单元材料">
        {materials}
        <div className="flex items-center gap-0.5"><h3 className="mr-auto px-2 text-xs text-muted-foreground">项目文件</h3>
          <Button size="icon-xs" variant="ghost" aria-label="新建文件" disabled={request.busy} onClick={() => { setKind('file'); setPathAction('create'); }}><FilePlus /></Button>
          <Button size="icon-xs" variant="ghost" aria-label="新建目录" disabled={request.busy} onClick={() => { setKind('directory'); setPathAction('create'); }}><FolderPlus /></Button>
          <Button size="icon-xs" variant="ghost" aria-label="重命名文件" disabled={request.busy || !selected} onClick={() => setPathAction('rename')}><Pencil /></Button>
          <Button size="icon-xs" variant="ghost" aria-label="刷新目录" disabled={request.busy} onClick={() => request.run(refresh)}><RefreshCw /></Button>
        </div>
        {pathAction && <form className="flex flex-col gap-2 rounded-md border bg-background p-2" onSubmit={(e) => { e.preventDefault(); void (pathAction === 'create' ? create() : rename()); }}>
          <label className="text-xs">{pathAction === 'create' ? '新路径' : '重命名路径'}<Input autoFocus placeholder={kind === 'directory' ? 'src' : 'src/main.rs'} value={pathAction === 'create' ? path : destination} disabled={request.busy} onChange={(e) => pathAction === 'create' ? setPath(e.target.value) : setDestination(e.target.value)} /></label>
          <div className="flex justify-end gap-2"><Button type="button" size="xs" variant="ghost" disabled={request.busy} onClick={() => setPathAction(null)}>取消</Button><Button type="submit" size="xs" disabled={request.busy || (pathAction === 'create' ? !path : !destination || destination === selected)}>{pathAction === 'create' ? '新建' : '重命名'}</Button></div>
        </form>}
        <RequestState request={request} />
        <nav aria-label="项目文件树" className="flex flex-col">
          {visible.map((entry) => <button key={entry.path} disabled={request.busy} className={`flex items-center gap-1 rounded p-1.5 text-left text-xs hover:bg-muted ${selected === entry.path ? 'bg-muted' : ''}`} style={{ paddingLeft: 6 + (entry.path.split('/').length - 1) * 14 }} title={entry.path} onClick={() => show(entry)}>
            {entry.kind === 'directory' ? <>{expanded.includes(entry.path) ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}<Folder className="size-3" /></> : <FileCode className="size-3" />}
            <span className="truncate">{entry.path.split('/').at(-1)}</span>
          </button>)}
        </nav>
      </aside>
      </ResizablePanel>
      <ResizableHandle aria-label="调整文件目录宽度" disabled={!explorer} className={explorer ? '' : 'hidden'} />
      <ResizablePanel id="learning-workspace" minSize={explorer ? '400px' : 0}>
        <ResizablePanelGroup orientation="vertical" onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction && open && !full) normalHeight.current = layout['disk-ide']!; }}>
          <ResizablePanel id="learning-content" defaultSize="60%" minSize={full ? 0 : '40%'} maxSize={full ? 0 : '100%'} inert={full} aria-hidden={full}>
            <div className="h-full overflow-y-auto overflow-x-hidden">{children}</div>
          </ResizablePanel>
          <ResizableHandle aria-label="调整 IDE 高度" disabled={!open || full} className={!open || full ? 'hidden' : 'h-px!'} />
          <ResizablePanel id="disk-ide" panelRef={idePanel} defaultSize="40%" minSize={open ? '20%' : 0} maxSize={!open ? 0 : full ? '100%' : '50vh'} inert={!open} aria-hidden={!open}>
            <section hidden={!open} className="dark flex h-full min-h-0 flex-col bg-ide text-ide-foreground" aria-label="项目 IDE">
              <div className="flex h-12 shrink-0 items-center gap-1 border-b border-white/10 px-2">
                <div className="mr-auto flex min-w-0 overflow-x-auto">{tabs.map((p) => <div key={p} className={`flex shrink-0 items-center gap-2 px-2 py-2 text-xs ${p === active ? 'bg-white/10' : 'text-ide-foreground/50'}`}><FileCode className="size-3.5" /><button title={p} onClick={() => { setActive(p); setDisk(null); }}>{p.split('/').at(-1)}{buffers[p]?.edited !== buffers[p]?.content ? ' ●' : ''}</button><button aria-label={`关闭 ${p}`} onClick={() => { setTabs((all) => all.filter((x) => x !== p)); if (p === active) setActive(tabs.find((x) => x !== p) ?? ''); }}><X className="size-3" /></button></div>)}</div>
                <span className="mr-1 hidden shrink-0 text-[10px] text-muted-foreground xl:block">真实磁盘文件 · {dirty ? '有未保存编辑' : '已保存'}</span>
                <Button size="icon-xs" variant="ghost" aria-label="保存文件" title="保存文件" disabled={request.busy || !buffer || buffer.edited === buffer.content} onClick={save}><Save /></Button>
                <Button size="icon-xs" variant="ghost" aria-label="读取磁盘版本" title="读取磁盘版本" disabled={request.busy || !buffer} onClick={compare}><RefreshCw /></Button>
                <Button size="icon-xs" variant="ghost" aria-label="引用代码" title="引用代码" disabled={!buffer} onClick={() => buffer && quote({ source: 'code', label: buffer.path, text: buffer.edited })}><MessageSquareQuote /></Button>
                <Button size="icon-xs" variant="ghost" aria-label={full ? '退出全屏' : '全屏 IDE'} onClick={() => setFull(!full)}>{full ? <Minimize2 /> : <Maximize2 />}</Button>
                {!full && <Button size="icon-xs" variant="ghost" aria-label="返回学习" onClick={close}><X /></Button>}
              </div>
              {!explorer && <div className="px-3"><RequestState request={request} /></div>}
              <ResizablePanelGroup orientation={full ? 'vertical' : 'horizontal'}>
                <ResizablePanel id="code" defaultSize="60%" minSize="25%">
                  <div className="flex h-full min-w-0 flex-col">
                    {buffer ? <><div className="flex h-7 shrink-0 items-center gap-2 border-b border-white/5 px-4 font-mono text-[11px] text-muted-foreground">{buffer.path}{disk && <span className="ml-auto font-sans">本地编辑与磁盘版本比较</span>}</div><div className="flex min-h-0 flex-1">
                      <CodeEditor label="代码编辑器" disabled={request.busy} className="flex-1" value={buffer.edited} position={positions.current[active] ??= { start: 0, end: 0, top: 0, left: 0 }} onChange={(value) => setBuffers({ ...buffers, [active]: { ...buffer, edited: value } })} />
                      {disk && disk.path === active && <div className="flex w-1/2 flex-col gap-3 overflow-auto border-l p-3"><h3 className="text-xs font-medium">磁盘版本（左侧编辑尚未保存）</h3><pre className="flex-1 whitespace-pre-wrap break-words text-xs">{disk.content}</pre><Button size="sm" variant="outline" className="h-auto whitespace-normal py-2" onClick={() => { setBuffers({ ...buffers, [active]: { ...disk, edited: buffer.edited } }); setDisk(null); }}>保留编辑，基于此版本继续</Button><Button size="sm" variant="ghost" className="h-auto whitespace-normal py-2" onClick={() => { setBuffers({ ...buffers, [active]: { ...disk, edited: disk.content } }); setDisk(null); }}>放弃编辑，采用磁盘内容</Button></div>}
                    </div></> : <p className="p-8 text-sm text-muted-foreground">从项目树打开文件，或新建文件开始编辑。</p>}
                  </div>
                </ResizablePanel>
                <ResizableHandle aria-label="调整编辑器与终端大小" />
                <ResizablePanel id="terminal" defaultSize="40%" minSize="20%"><section className="flex h-full flex-col" aria-label="终端"><div className="flex h-7 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground"><TerminalSquare className="size-3.5" />终端 · 尚未接入</div><div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center text-xs leading-relaxed text-muted-foreground"><TerminalSquare className="size-6 opacity-50" /><p>终端与代码运行尚未接入。<br />此处不会连接模拟环境或执行命令。</p></div></section></ResizablePanel>
              </ResizablePanelGroup>
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  </div>;
}
