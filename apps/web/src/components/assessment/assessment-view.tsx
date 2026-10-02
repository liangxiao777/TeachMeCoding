'use client'

import { ArrowLeft, ClipboardCheck, Play, Save, Send } from 'lucide-react'
import { Generating, InlineText } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { CodeEditor, TermOutput } from '@/components/workbench/ide-panel'
import { findUnit } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'

function QuestionHeader({ n, title, prompt }: { n: number; title: string; prompt: string }) {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-2.5">
        <Badge className="size-6 rounded-full p-0 font-mono">{n}</Badge>
        {title}
      </CardTitle>
      <CardDescription className="text-sm leading-relaxed text-foreground">
        <InlineText text={prompt} />
      </CardDescription>
    </CardHeader>
  )
}

export function AssessmentView() {
  const space = useSpace()
  const { updateDraft, runDraft, submitAssessment, leaveAssessment, assessment: getAssessment, capabilities, persistence } = useApp()
  const draft = space.draft
  const unit = findUnit(space, draft?.unitId ?? space.currentUnitId)
  if (!draft || !unit) return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={leaveAssessment}>
          <ArrowLeft data-icon="inline-start" />
          返回单元（答案会保留）
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>测评暂不可用</CardTitle>
            <CardDescription>当前没有可用的单元测评草稿。</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </div>
  )
  const spec = getAssessment(unit)
  const canRun = !!spec && capabilities.assessment && capabilities.terminal
  const storageBusy = !!persistence && (!persistence.ready || persistence.busy)

  if (draft.state === 'evaluating' && spec && capabilities.assessment) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Card className="w-full max-w-md shadow-lg">
          <CardContent>
            <Generating
              title="正在评估你的回答"
              steps={['阅读解释题的回答', '运行并检查你提交的代码', '对照本单元能力目标', '整理掌握情况与建议']}
              note="测评结果会写入你的学习记录，后续课件和 Agent 回答都会参考它。"
            />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <div className="flex flex-col gap-5">
          <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={leaveAssessment}>
            <ArrowLeft data-icon="inline-start" />
            返回单元（答案会保留）
          </Button>
          <div className="flex flex-col gap-2">
            <Badge variant="outline" className="gap-1.5">
              <ClipboardCheck aria-hidden />
              单元测评 · 第 {draft.attempt} 次
            </Badge>
            <h1 className="text-balance text-3xl font-semibold tracking-tight">{unit.title}</h1>
          </div>
          {spec && (
            <div className="flex flex-col gap-2.5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">这次测评会检查</p>
              <ul className="flex flex-wrap gap-2">
                {spec.abilities.map((a) => (
                  <li key={a}>
                    <Badge variant="secondary" className="h-7 px-3 font-normal">
                      {a}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {draft.state === 'generating' && spec && capabilities.assessment ? (
          <Card>
            <CardContent>
              <Generating title="正在根据你的学习情况出题" steps={['回顾本单元目标', '参考你在会话中的疑问', '生成解释题与调试题']} />
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              {spec ? <QuestionHeader n={1} title={spec.q1.title} prompt={spec.q1.prompt} /> : (
                <CardHeader>
                  <CardTitle>测评题目暂不可用</CardTitle>
                  <CardDescription>当前单元没有可用测评题目。已有答案草稿仍可编辑和保存。</CardDescription>
                </CardHeader>
              )}
              <CardContent className="flex flex-col gap-4">
                {spec?.q1.code && (
                  <pre className="overflow-x-auto rounded-lg bg-ide p-4 font-mono text-[13px] leading-6 text-ide-foreground">
                    {spec.q1.code.split('\n').map((l, i) => (
                      <div key={i}>
                        <span className="mr-4 inline-block w-4 text-right opacity-40">{i + 1}</span>
                        {l}
                      </div>
                    ))}
                  </pre>
                )}
                <Field>
                  <FieldLabel htmlFor="q1">你的回答</FieldLabel>
                  <Textarea
                    id="q1"
                    rows={5}
                    value={draft.q1}
                    onChange={(e) => updateDraft({ q1: e.target.value })}
                    placeholder={spec ? '用自己的话解释，写清楚原因和你的改法…' : '编辑已保留的答案草稿…'}
                    className="resize-y leading-relaxed"
                  />
                  <FieldDescription>{spec ? '不需要标准术语，讲清楚你的理解即可。' : '题目暂不可用，不会自动生成或替换你的答案。'}</FieldDescription>
                </Field>
              </CardContent>
            </Card>

            <Card>
              {spec ? <QuestionHeader n={2} title={spec.q2.title} prompt={spec.q2.prompt} /> : (
                <CardHeader><CardTitle>代码答案草稿</CardTitle></CardHeader>
              )}
              <CardContent>
                <div className="dark flex flex-col overflow-hidden rounded-lg border bg-ide text-ide-foreground">
                  <div className="flex items-center justify-between border-b py-1.5 pr-1.5 pl-3">
                    <span className="font-mono text-xs text-muted-foreground">{spec?.q2.file ?? '代码答案草稿'}</span>
                    <Button size="xs" disabled={!canRun || draft.q2Running || storageBusy} onClick={runDraft}>
                      {canRun && draft.q2Running ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                      运行
                    </Button>
                  </div>
                  <CodeEditor className="h-64" label={spec ? `编辑 ${spec.q2.file}` : '代码答案草稿'} value={draft.q2} onChange={(v) => updateDraft({ q2: v })} />
                  <div className="min-h-16 border-t px-3 py-2 font-mono text-xs leading-5" aria-live="polite">
                    {draft.q2Output ? <TermOutput lines={draft.q2Output} /> : <p className="text-muted-foreground">{canRun ? '运行后在这里查看输出' : '代码运行暂不可用，不会执行模拟运行。'}</p>}
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="sticky bottom-0 -mx-8 flex items-center justify-between gap-4 border-t bg-background/85 px-8 py-4 backdrop-blur">
              <p className="text-sm text-muted-foreground">
                {capabilities.assessment && spec ? '提交后 Agent 会给出掌握情况、依据和建议。' : '测评评估暂不可用，仍可保存答案草稿。'}
                {persistence && <span role="status" className="ml-2">{persistence.assessmentDirty ? '未保存' : '已保存'}</span>}
              </p>
              {persistence && (
                <Button
                  size="lg"
                  variant="outline"
                  disabled={!persistence.ready || persistence.busy || !persistence.assessmentDirty}
                  onClick={persistence.saveAssessment}
                >
                  <Save data-icon="inline-start" />
                  保存答案草稿
                </Button>
              )}
              <Button size="lg" onClick={submitAssessment} disabled={!spec || !capabilities.assessment || storageBusy || !draft.q1.trim()}>
                <Send data-icon="inline-start" />
                提交测评
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
