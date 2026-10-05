import { useEffect, useState } from 'react'
import type { SkillSettings } from '@teach-me-coding/contracts'
import { api } from '@/lib/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'

export function SkillsSettingsForm() {
  const [settings, setSettings] = useState<SkillSettings | null>(null)
  const [paths, setPaths] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      const next = await api<SkillSettings>('/settings/skills')
      setSettings(next); setPaths(next.configuration.paths.join('\n')); setError('')
    } catch (error) { setError(error instanceof Error ? error.message : '无法读取 Skills。') }
  }
  useEffect(() => { void load() }, [])
  const dirty = !!settings && paths !== settings.configuration.paths.join('\n')
  const save = async (disabled = settings?.configuration.disabled ?? []) => {
    setBusy(true); setError('')
    try {
      const next = await api<SkillSettings>('/settings/skills', { paths: paths.split('\n').map((path) => path.trim()).filter(Boolean), disabled })
      setSettings(next); setPaths(next.configuration.paths.join('\n'))
    } catch (error) { setError(error instanceof Error ? error.message : '无法保存 Skills 配置。') }
    finally { setBusy(false) }
  }
  const reload = async () => {
    setBusy(true); setError('')
    try { setSettings(await api<SkillSettings>('/settings/skills/reload', {})) }
    catch (error) { setError(error instanceof Error ? error.message : '无法重新扫描 Skills。') }
    finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-6">
      {error && <Alert variant="destructive"><AlertDescription>{error}{!settings && <Button variant="outline" size="sm" onClick={() => void load()}>重试</Button>}</AlertDescription></Alert>}
      {!settings ? !error && <div role="status" className="flex items-center gap-2 text-sm"><Spinner /> 正在读取 Skills…</div> : <>
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3"><CardTitle>已发现的 Skills</CardTitle>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void reload()}>重新扫描</Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!settings.skills.length && <p className="text-sm text-muted-foreground">尚未发现 Skill。将 Skill 目录放入默认目录，或添加已有路径。</p>}
            {settings.skills.map((skill) => <div key={skill.filePath} className="min-w-0 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="break-all text-sm font-medium">{skill.name}</h3>
                <Badge variant="secondary">{skill.enabled ? skill.automatic ? '按需加载' : '仅手动调用' : '已停用'}</Badge>
                <Button variant="ghost" size="sm" className="ml-auto" disabled={busy || dirty} aria-label={`${skill.enabled ? '停用' : '启用'} ${skill.name}`}
                  onClick={() => void save(skill.enabled ? [...settings.configuration.disabled, skill.filePath] : settings.configuration.disabled.filter((path) => path !== skill.filePath))}>
                  {skill.enabled ? '停用' : '启用'}
                </Button>
              </div>
              <p className="mt-2 break-words text-sm text-muted-foreground">{skill.description}</p>
              <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">位置与调用方式</summary>
                <p className="mt-2 break-words font-mono">{skill.filePath}</p>
                <p className="mt-2">在会话中输入：</p>
                <p className="mt-1 break-words"><code>/skill:{skill.name}</code> <span className="whitespace-nowrap">你的请求</span></p>
              </details>
            </div>)}
            {settings.diagnostics.map((diagnostic, i) => <Alert key={i} variant={diagnostic.type === 'error' ? 'destructive' : 'default'}>
              <AlertDescription className="break-words">{diagnostic.message}{diagnostic.path && <p className="mt-1 break-all font-mono text-xs">{diagnostic.path}</p>}</AlertDescription>
            </Alert>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>加载位置</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="text-sm"><p className="font-medium">默认目录</p><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{settings.directory}</p></div>
            <Field><FieldLabel htmlFor="skill-paths">额外目录或 SKILL.md 路径</FieldLabel>
              <Textarea id="skill-paths" value={paths} disabled={busy} onChange={(e) => setPaths(e.target.value)} spellCheck={false} className="min-h-28 font-mono text-xs!" placeholder="每行一个绝对路径或 ~/ 路径" />
              <FieldDescription>使用 Pi 的 SKILL.md 格式。Agent 先看到名称与描述，匹配任务时再读取正文；同名 Skill 使用先发现的一项。</FieldDescription>
            </Field>
          </CardContent>
          <CardFooter><Button disabled={busy || !dirty} onClick={() => void save()}>{busy && <Spinner />}保存 Skills 路径</Button></CardFooter>
        </Card>
      </>}
    </div>
  )
}
