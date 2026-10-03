'use client'

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
import { findUnit, nextUnit, relativeTime } from '@/app/selectors'
import { useApp, useSpace } from '@/app/context'
import { cn } from '@/lib/utils'

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
          <Badge variant="secondary" className="font-mono">
            {items.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col">
          {items.map((i, idx) => (
            <li key={i} className="flex flex-col">
              {idx > 0 && <Separator className="my-2.5" />}
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm leading-relaxed">{i}</span>
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
  const expired = record.verification === 'non-execution' && record.valid === false
  const unit = findUnit(space, record.unitId)
  const next = nextUnit(space, record.unitId)
  const isLatest = [...space.records].reverse().find((r) => r.unitId === record.unitId)?.id === record.id
  const ask = (text: string) => setQuote({ source: 'advice', label: `${record.unitTitle} · 测评`, text })

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
                  {expired ? '历史结论 · 来源已变化' : unverified ? '尚未验证' : passed ? '通过' : '需要加强'}
                </Badge>
                <CardTitle className="text-2xl tracking-tight">
                  {expired ? '此结果基于旧版本，请重新测评' : unverified ? '代码尚未通过真实执行验证' : passed ? '你已经掌握了这个单元' : '再巩固一下会更扎实'}
                </CardTitle>
              </div>
            </div>
            <CardDescription className="text-base leading-relaxed text-foreground">{record.summary}</CardDescription>
          </CardHeader>
        </Card>

        {passed && !expired && space.completed && !next && isLatest && (
          <Alert>
            <Trophy aria-hidden />
            <AlertTitle>学习路线已完成</AlertTitle>
            <AlertDescription>这是路线上的最后一个单元，你已完成整条学习路线。</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Section icon={CheckCircle2} title="已经掌握" items={record.mastered} tone="primary" />
          <Section icon={CircleAlert} title="需要加强" items={record.concerns} tone="accent" onAsk={ask} />
        </div>
        <Section icon={Quote} title="判断依据" items={record.evidence} tone="muted" />
        <Section icon={HelpCircle} title="尚未验证" items={record.toVerify} tone="muted" onAsk={ask} />

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

        <div className="flex flex-wrap items-center gap-3 border-t pt-6">
          {passed && !expired && next && isLatest ? (
            <Button size="lg" onClick={goNextUnit}>
              进入下一单元：{next.title}
              <ArrowRight data-icon="inline-end" />
            </Button>
          ) : (!passed || expired) && isLatest ? (
            <>
              <Button size="lg" onClick={backToStudy}>
                <BookOpen data-icon="inline-start" />
                回到「{unit?.title}」继续学习
              </Button>
              <Button size="lg" variant="outline" onClick={startAssessment}>
                <RotateCcw data-icon="inline-start" />
                重新测评
              </Button>
            </>
          ) : null}
          <Button size="lg" variant="ghost" onClick={() => (isLatest && passed && !next ? setView('route') : backToStudy())}>
            {isLatest && passed && !next ? '查看学习路线' : '返回单元'}
          </Button>
        </div>
      </div>
    </div>
  )
}
