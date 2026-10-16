import { useEffect, useMemo, useState } from 'react'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { structuredPatch } from 'diff'
import { Check, FileCode2, LoaderCircle, SquareTerminal } from 'lucide-react'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, type BundledLanguage } from 'shiki/langs'
import { bundledThemes } from 'shiki/themes'
import type { ThemedToken } from 'shiki'
import type { ActionProposal } from '@teach-me-coding/contracts'
import { useApp } from '@/app/context'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const highlighter = createHighlighterCore({
  themes: [bundledThemes['github-dark']], langs: [], engine: createJavaScriptRegexEngine(),
})
const withinLimits = (code: string) => code.length <= 200_000 && code.split('\n').length <= 4000

function fileLanguage(path: string) {
  const description = LanguageDescription.matchFilename(languages, path)
  return [description?.name.toLowerCase(), ...description?.alias ?? []]
    .find((language): language is BundledLanguage => !!language && Object.hasOwn(bundledLanguages, language)) ?? 'text'
}

function useCodeTokens(code: string, language: BundledLanguage | 'text') {
  const [highlighted, setHighlighted] = useState<{ code: string; language: string; tokens: ThemedToken[][] } | null>(null)
  useEffect(() => {
    if (language === 'text' || !withinLimits(code)) return
    let active = true
    highlighter.then(async (instance) => {
      await instance.loadLanguage(bundledLanguages[language])
      return instance.codeToTokens(code, { lang: language, theme: 'github-dark' }).tokens
    }).then((tokens) => { if (active) setHighlighted({ code, language, tokens }) })
      .catch(() => { /* Keep the complete plain text if highlighting cannot load. */ })
    return () => { active = false }
  }, [code, language])
  return highlighted?.code === code && highlighted.language === language ? highlighted.tokens : null
}

function CodeLine({ text, tokens }: { text: string; tokens?: ThemedToken[] }) {
  const exactTokens = tokens?.map((token) => token.content).join('') === text ? tokens : undefined
  return <code>{exactTokens ? exactTokens.map((token, index) => <span key={index} style={{ color: token.color }}>{token.content}</span>) : text}</code>
}

// A bounded abort still shows both complete versions; it is never an empty diff.
function fullVersion(code: string, sign: '-' | '+') {
  if (!code) return ''
  const lines = code.split('\n')
  if (code.endsWith('\n')) lines.pop()
  return lines.map((line) => `${sign} ${line}`).join('\n')
    + (code.endsWith('\n') ? '' : '\n\\ 文件末尾无换行')
}

function FileChange({ action }: { action: Extract<ActionProposal['action'], { kind: 'file' }> }) {
  const before = action.before ?? ''
  const language = useMemo(() => fileLanguage(action.path), [action.path])
  const oldTokens = useCodeTokens(before, language), newTokens = useCodeTokens(action.content, language)
  const patch = useMemo(() => withinLimits(before) && withinLimits(action.content)
    ? structuredPatch(action.path, action.path, before, action.content, undefined, undefined, { context: 3, timeout: 30, maxEditLength: 1000 })
    : undefined, [action.path, before, action.content])

  return <figure className="min-w-0 overflow-hidden rounded-lg bg-ide text-ide-foreground ring-1 ring-foreground/10">
    <figcaption className="flex min-w-0 items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2 font-mono text-xs">
      <FileCode2 className="size-3.5 shrink-0 opacity-60" aria-hidden />
      <span className="truncate" title={action.path}>{action.path}</span>
    </figcaption>
    <div className="max-h-80 overflow-auto overscroll-contain font-mono text-[13px] leading-6" tabIndex={0} role="region" aria-label={`${action.path} 修改差异`}>
      {!patch ? <>
        <p className="px-3 py-2 font-sans text-xs text-ide-foreground/60">修改较大，按整文件展示差异</p>
        {before && <pre data-change="removed" className="m-0 min-w-full w-max border-l-2 border-red-400 bg-red-500/15 px-3 py-1">{fullVersion(before, '-')}</pre>}
        {action.content && <pre data-change="added" className="m-0 min-w-full w-max border-l-2 border-emerald-400 bg-emerald-500/15 px-3 py-1">{fullVersion(action.content, '+')}</pre>}
      </> : patch.hunks.length === 0
        ? <p className="px-3 py-3 font-sans text-xs text-ide-foreground/60">{action.before === null ? '新建空文件' : '内容没有变化'}</p>
        : <pre className="m-0 min-w-full w-max py-2">{patch.hunks.map((hunk, index) => {
          let oldLine = hunk.oldStart, newLine = hunk.newStart
          return <span key={index} className="block">
            {index > 0 && <span className="block px-3 py-1 text-xs text-ide-foreground/60">@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span>}
            {hunk.lines.map((line, row) => {
              const sign = line[0], text = line.slice(1).replace(/\r$/, '')
              if (sign === '\\') return <span key={row} className="block pl-14 text-[11px] text-ide-foreground/60">\ 文件末尾无换行</span>
              const removed = sign === '-', added = sign === '+'
              const number = removed ? oldLine : newLine
              const tokens = (removed ? oldTokens : newTokens)?.[number - 1]
              if (!added) oldLine++
              if (!removed) newLine++
              return <span key={row} data-change={removed ? 'removed' : added ? 'added' : 'unchanged'}
                className={cn('flex border-l-2 pr-4', removed ? 'border-red-400 bg-red-500/15' : added ? 'border-emerald-400 bg-emerald-500/15' : 'border-transparent')}>
                <span className="w-8 shrink-0 select-none pr-2 text-right text-[11px] text-ide-foreground/60" aria-hidden>{number}</span>
                <span className={cn('w-5 shrink-0 select-none', removed ? 'text-red-300' : 'text-emerald-300')} aria-hidden>{removed ? '−' : added ? '+' : ' '}</span>
                <CodeLine text={text || ' '} tokens={tokens?.length ? tokens : undefined} />
                {line.endsWith('\r') && (removed || added) && <span className="ml-4 text-[10px] text-ide-foreground/60">CRLF</span>}
              </span>
            })}
          </span>
        })}</pre>}
    </div>
  </figure>
}

function Command({ command }: { command: string }) {
  const tokens = useCodeTokens(command, 'shellscript')
  return <pre className="max-h-80 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-ide px-3 py-3 font-mono text-[13px] leading-6 text-ide-foreground ring-1 ring-foreground/10"
    tabIndex={0} aria-label="待执行命令">{tokens ? command.split('\n').map((line, index) => <span key={index}>{index > 0 && '\n'}<CodeLine text={line} tokens={tokens[index]} /></span>) : <code>{command}</code>}</pre>
}

export function LocalAction({ proposal: p }: { proposal: ActionProposal }) {
  const { persistence } = useApp()
  if (!persistence) return null
  const file = p.action.kind === 'file', title = file ? '文件修改' : '命令执行'
  const Icon = file ? FileCode2 : SquareTerminal
  const status = p.state === 'failed' && p.result ? {
    succeeded: '已完成', failed: file ? '修改失败' : '执行失败', 'timed-out': '执行超时',
    cancelled: '已取消', 'output-limit': '输出已达上限', unavailable: '运行环境不可用',
  }[p.result.status] : {
    pending: '', running: file ? '正在修改…' : '执行中…', succeeded: file ? '已修改' : '已执行',
    failed: file ? '修改失败' : '执行失败', rejected: '已拒绝', expired: '已失效', cancelled: '已取消', interrupted: '已中断',
  }[p.state]
  return <section className="min-w-0 space-y-3 py-1" aria-label={title} data-testid="local-action">
    <h3 className="flex items-center gap-2 text-sm font-medium"><Icon className="size-4 text-muted-foreground" aria-hidden />{title}</h3>
    {p.action.kind === 'file' ? <FileChange action={p.action} /> : <Command command={p.action.command} />}
    <div className="flex flex-wrap items-center gap-2">
      {p.state === 'pending' ? <>
        <Button disabled={persistence.busy || persistence.filesPending} onClick={() => persistence.decideAction(p.id, 'confirm')}>确认执行</Button>
        <Button variant="outline" disabled={persistence.busy} onClick={() => persistence.decideAction(p.id, 'reject')}>拒绝</Button>
        {persistence.filesPending && <span role="status" className="text-xs text-muted-foreground">等待自动保存</span>}
      </> : <>
        <span role="status" className={cn('flex items-center gap-1.5 text-xs', p.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
          {p.state === 'running' && <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />}
          {p.state === 'succeeded' && <Check className="size-3.5" aria-hidden />}{status}
        </span>
        {p.result?.exitCode !== null && p.result?.exitCode !== undefined && !file && <span className="text-xs text-muted-foreground">· 退出码 {p.result.exitCode}</span>}
        {p.state === 'running' && <Button variant="outline" onClick={() => persistence.decideAction(p.id, 'cancel')}>取消执行</Button>}
      </>}
    </div>
    {p.result?.output && (!file || p.state !== 'succeeded') && <pre className="max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs leading-relaxed" tabIndex={0} aria-label="执行输出">{p.result.output}</pre>}
  </section>
}
