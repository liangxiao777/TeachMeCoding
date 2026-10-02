import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode, Folder, Maximize2, Minimize2, X } from 'lucide-react';
import type { ProjectEntry, ProjectFile, Quote } from '@teach-me-coding/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { RequestState, useRequest, useUnsavedWarning } from './request-state';

type Buffer = ProjectFile & { edited: string };
export function ProjectEditor({ space, open, close, quote }: { space: string; open: boolean; close: () => void; quote: (q: Quote) => void }) {
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
  const [full, setFull] = useState(false);
  const buffer = buffers[active];
  const dirty = Object.values(buffers).some((b) => b.content !== b.edited);
  useUnsavedWarning(dirty);
  useEffect(() => {
    if (!open) setFull(false);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && full) { setFull(false); close(); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [open, full, close]);
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
    setPath(''); await refresh();
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
    setSelected(destination); setExpanded([]); setDisk(null); await refresh();
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
  return <section hidden={!open} className={full ? 'dark fixed inset-0 z-40 flex flex-col bg-background text-foreground' : 'dark flex h-[520px] shrink-0 flex-col border-t bg-background text-foreground'} aria-label="项目 IDE">
    <div className="flex items-center gap-2 border-b px-4 py-2"><FileCode className="size-4" /><h2 className="font-medium">项目 IDE</h2><span className="text-xs text-muted-foreground">真实磁盘文件 · {dirty ? '有未保存编辑' : '已保存'}</span>
      <Button className="ml-auto" size="sm" variant="ghost" aria-label={full ? '退出全屏' : '全屏 IDE'} onClick={() => setFull(!full)}>{full ? <Minimize2 /> : <Maximize2 />}</Button>
      <Button size="sm" variant="ghost" onClick={() => { setFull(false); close(); }}>返回学习</Button></div>
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-auto border-r p-3">
        <div className="flex items-center justify-between"><h3 className="text-sm">项目文件</h3><Button size="sm" variant="ghost" disabled={request.busy} onClick={() => request.run(refresh)}>刷新目录</Button></div>
        <nav aria-label="项目文件树" className="flex flex-col">
          {visible.map((entry) => <button key={entry.path} disabled={request.busy} className={`flex items-center gap-1 rounded p-1.5 text-left text-xs hover:bg-muted ${selected === entry.path ? 'bg-muted' : ''}`} style={{ paddingLeft: 6 + (entry.path.split('/').length - 1) * 14 }} title={entry.path} onClick={() => show(entry)}>
            {entry.kind === 'directory' ? <>{expanded.includes(entry.path) ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}<Folder className="size-3" /></> : <FileCode className="size-3" />}
            <span className="truncate">{entry.path.split('/').at(-1)}</span>
          </button>)}
        </nav>
        <label className="text-xs">新路径<Input placeholder="src/main.rs" value={path} disabled={request.busy} onChange={(e) => setPath(e.target.value)} /></label>
        <div className="flex gap-2"><select aria-label="新建类型" value={kind} className="rounded border bg-background p-1 text-xs" onChange={(e) => setKind(e.target.value as typeof kind)}><option value="file">文件</option><option value="directory">目录</option></select>
          <Button size="sm" variant="outline" disabled={request.busy || !path} onClick={create}>新建</Button></div>
        {selected && <><label className="text-xs">重命名路径<Input value={destination} disabled={request.busy} onChange={(e) => setDestination(e.target.value)} /></label><Button size="sm" variant="outline" disabled={request.busy || destination === selected} onClick={rename}>重命名</Button></>}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 overflow-x-auto border-b">{tabs.map((p) => <div key={p} className={`flex items-center gap-2 border-r px-3 py-2 text-xs ${p === active ? 'bg-muted' : ''}`}><button onClick={() => { setActive(p); setDisk(null); }}>{p}{buffers[p]?.edited !== buffers[p]?.content ? ' ●' : ''}</button>
          <button aria-label={`关闭 ${p}`} onClick={() => { setTabs((all) => all.filter((x) => x !== p)); if (p === active) setActive(tabs.find((x) => x !== p) ?? ''); }}><X className="size-3" /></button></div>)}</div>
        <div className="px-3 pt-2"><RequestState request={request} /></div>
        {buffer ? <><div className="flex items-center gap-2 p-2"><Button size="sm" disabled={request.busy || buffer.edited === buffer.content} onClick={save}>保存文件</Button>
          <Button size="sm" variant="outline" disabled={request.busy} onClick={compare}>读取磁盘版本</Button><Button size="sm" variant="ghost" onClick={() => quote({ source: 'code', label: buffer.path, text: buffer.edited })}>引用代码</Button></div>
          <div className="flex min-h-0 flex-1"><textarea aria-label="代码编辑器" spellCheck={false} disabled={request.busy} className="min-w-0 flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-6 outline-none" value={buffer.edited} onChange={(e) => setBuffers({ ...buffers, [active]: { ...buffer, edited: e.target.value } })} />
            {disk && disk.path === active && <div className="flex w-1/2 flex-col overflow-auto border-l p-3"><h3 className="mb-2 text-sm">磁盘版本（编辑内容保留在左侧）</h3><pre className="flex-1 whitespace-pre-wrap break-words text-xs">{disk.content}</pre><Button size="sm" variant="outline" onClick={() => { setBuffers({ ...buffers, [active]: { ...disk, edited: buffer.edited } }); setDisk(null); }}>保留编辑，基于此版本继续</Button><Button size="sm" variant="ghost" onClick={() => { setBuffers({ ...buffers, [active]: { ...disk, edited: disk.content } }); setDisk(null); }}>放弃编辑，采用磁盘内容</Button></div>}
          </div></> : <p className="p-8 text-sm text-muted-foreground">从项目树打开文件，或新建文件开始编辑。</p>}
        <div className="shrink-0 border-t bg-muted/30 p-4 text-xs text-muted-foreground">终端与代码运行尚未接入。此处不会连接模拟环境或执行命令。</div>
      </div>
    </div>
  </section>;
}
