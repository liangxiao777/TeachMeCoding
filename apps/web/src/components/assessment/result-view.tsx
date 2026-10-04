'use client'

import { executionFeedback } from '@teach-me-coding/contracts'
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  HelpCircle,
  MessageSquareQuote,
  Quote,
  RotateCcw,
  Trophy,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Separator } from '@/components/ui/separator'
import { InlineText } from '@/components/shared'
import { findUnit, nextUnit, relativeTime } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'
import { ExecutionResult } from './execution-result'

function Section({
  icon: Icon,
  title,
  items,
  tone,
  onAsk,
}: {
  icon: typeof Quote
  title: string
  items: string[]
  tone: 'primary' | 'accent' | 'muted'
  onAsk?: (item: string) => void
}) {
  if (!items.length) return null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon
            className={cn(
              'size-4',
              tone === 'primary' && 'text-primary',
              tone === 'accent' && 'text-accent-foreground',
              tone === 'muted' && 'text-muted-foreground',
            )}
            aria-hidden
          />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {items.map((i, idx) => (
            <li key={i} className="flex flex-col">
              {idx > 0 && <Separator className="my-2.5" />}
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words text-sm leading-relaxed"><InlineText text={i} /></span>
                {onAsk && (
                  <Button variant="ghost" size="xs" className="shrink-0 text-primary" onClick={() => onAsk(i)}>
                    <MessageSquareQuote data-icon="inline-start" />
                    就此提问
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

export function ResultView() {
  const space = useSpace()
  const { goNextUnit, backToStudy, startAssessment, setQuote, setView } = useApp()
  const record = space.records.find((r) => r.id === space.viewingRecordId)
  if (!record) return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <Card>
          <CardHeader>
            <CardTitle>测评记录暂不可用</CardTitle>
            <CardDescription>当前没有可读取的测评结果。</CardDescription>
          </CardHeader>
        </Card>
        <Button size="lg" variant="ghost" onClick={() => setView('route')}>查看学习路线</Button>
      </div>
    </div>
  )
  const passed = record.result === 'pass'
  const unverified = record.result === 'unverified'
  const expired = ['non-execution', 'execution-verified'].includes(record.verification ?? '') && record.valid === false
  const unit = findUnit(space, record.unitId)
  const next = nextUnit(space, record.unitId)
  const isLatest = [...space.records].reverse().find((r) => r.unitId === record.unitId)?.id === record.id
  const ask = (text: string) => setQuote({ source: 'advice', label: `${record.unitTitle} · 测评`, text })
  const execution = record.execution && executionFeedback(record.execution)
  const nextStep = expired ? '回到当前单元，核对最新题目后重新作答。'
    : unverified ? execution?.nextStep ?? '当前题目没有可用的代码运行结果。重新出题后运行代码，再提交测评。'
    : passed ? next ? '可以继续下一单元，也可以回看本次作答。' : '可以回看本次作答，或返回学习路线。'
    : execution?.nextStep ?? '根据下面的建议修改回答，再重新测评。'

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <Card className={cn('overflow-hidden', passed ? 'border-primary/30' : 'border-accent-foreground/25')}>
          <div className={cn('h-1.5', passed ? 'bg-primary' : 'bg-accent-foreground/70')} aria-hidden />
          <CardHeader className="gap-4">
            <div className="flex items-center justify-between gap-4">
              <p className="font-mono text-xs text-muted-foreground">
                {record.unitTitle} · 第 {record.attempt} 次测评 · {relativeTime(record.createdAt)}
              </p>
              {!isLatest && <Badge variant="outline">历史记录</Badge>}
            </div>
            <div className="flex items-center gap-4">
              <div
                className={cn(
                  'flex size-12 shrink-0 items-center justify-center rounded-full',
                  passed ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground',
                )}
              >
                {passed ? <CheckCircle2 className="size-6" aria-hidden /> : <RotateCcw className="size-6" aria-hidden />}
              </div>
              <div className="flex flex-col gap-1">
                <Badge variant={passed ? 'default' : 'secondary'} className="w-fit">
                  {expired ? '历史结论 · 来源已变化' : unverified ? '暂无法判断' : passed ? '通过' : '需要修改'}
                </Badge>
                <CardTitle className="text-2xl tracking-tight">
                  {expired ? '此结果基于旧版本，请重新测评' : unverified ? '本次代码检查未完成' : passed ? '本次测评通过' : '这次还有需要修改的地方'}
                </CardTitle>
              </div>
            </div>
            <CardDescription className="text-base leading-relaxed text-foreground"><InlineText text={record.summary} /></CardDescription>
            {unverified && <p className="text-sm text-muted-foreground">运行没有完成，不代表你没有学会；本次不会记为通过或不合格。</p>}
            <p className="text-sm leading-relaxed"><span className="font-medium">接下来：</span>{nextStep}</p>
          </CardHeader>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          {passed && !expired && next && isLatest ? (
            <Button size="lg" onClick={goNextUnit}>
              进入下一单元：{next.title}
              <ArrowRight data-icon="inline-end" />
            </Button>
          ) : (!passed || expired) && isLatest ? (
            <>
              <Button size="lg" onClick={startAssessment}>
                <RotateCcw data-icon="inline-start" />
                重新测评
              </Button>
              <Button size="lg" variant="outline" onClick={backToStudy}>
                <BookOpen data-icon="inline-start" />
                回到「{unit?.title}」继续学习
              </Button>
            </>
          ) : null}
          <Button size="lg" variant="ghost" onClick={() => (isLatest && passed && !next ? setView('route') : backToStudy())}>
            {isLatest && passed && !next ? '查看学习路线' : '返回单元'}
          </Button>
        </div>

        {passed && !expired && space.completed && !next && isLatest && (
          <Alert>
            <Trophy aria-hidden />
            <AlertTitle>学习路线已完成</AlertTitle>
            <AlertDescription>这是路线上的最后一个单元，你已完成整条学习路线。</AlertDescription>
          </Alert>
        )}

        <Section icon={Quote} title={unverified ? '作答反馈（仅供修改参考）' : '为什么是这个结果'} items={record.evidence} tone="muted" />
        <Section icon={CircleAlert} title="下一步怎么改" items={record.concerns} tone="accent" onAsk={ask} />
        {record.execution && <ExecutionResult execution={record.execution} showSummary={record.summary !== execution?.summary} />}
        {(record.mastered.length > 0 || record.toVerify.length > 0) && <Collapsible className="rounded-xl border bg-card">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
            补充反馈
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-4 border-t p-4">
              <Section icon={CheckCircle2} title="本次做对的地方" items={record.mastered} tone="primary" />
              <Section icon={HelpCircle} title="本次未覆盖" items={record.toVerify} tone="muted" onAsk={ask} />
            </div>
          </CollapsibleContent>
        </Collapsible>}

        <Collapsible className="rounded-xl border bg-card">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
            查看我的回答
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-3 border-t px-4 py-4">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">解释题</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{record.answers.q1 || '（未作答）'}</p>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{record.q2Kind === 'reasoning' ? '分析题' : '代码题'}</p>
              {record.q2Kind === 'reasoning' ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{record.answers.q2 || '（未作答）'}</p>
                : <pre className="overflow-x-auto rounded-lg bg-ide p-3 font-mono text-xs leading-relaxed text-ide-foreground">{record.answers.q2}</pre>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  )
}
