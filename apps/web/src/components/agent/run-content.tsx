import { useEffect, useMemo, useState } from 'react'
import { defaultComponents, type Components } from 'streamdown'
import { SquareTerminal } from 'lucide-react'
import type { AgentDisplayPart } from '@teach-me-coding/contracts'
import { MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool, ToolContent, ToolHeader } from '@/components/ai-elements/tool'
import { Button } from '@/components/ui/button'

const TOOL_NAMES: Record<string, string> = {
  submit_requirement_draft: '整理学习需求', submit_route_proposal: '提交学习路线',
  submit_learning_conclusion: '整理学习结论', submit_lesson: '提交课件',
  submit_assessment: '提交测评题目', submit_evaluation: '提交评估结果',
  read: '读取文件', ls: '查看目录', find: '查找文件', grep: '搜索内容',
}

/** Ordered public events only; native reasoning signatures and private rubrics never enter this view. */
export function RunContent({ parts, text = '', streaming = false, onCode }: {
  parts?: AgentDisplayPart[]
  text?: string
  streaming?: boolean
  onCode?: (code: string, language: string) => void
}) {
  const [idleSeconds, setIdleSeconds] = useState(0)
  const activity = JSON.stringify(parts ?? text)
  useEffect(() => {
    setIdleSeconds(0)
    if (!streaming) return
    const receivedAt = performance.now()
    const timer = setInterval(() => setIdleSeconds(Math.floor((performance.now() - receivedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [activity, streaming])
  const components = useMemo<Components | undefined>(() => onCode ? {
    pre: (props) => {
      const code = props.node?.children.find((child) => child.type === 'element' && child.tagName === 'code')
      const value = code?.type === 'element' ? code.children.filter((child) => child.type === 'text').map((child) => child.value).join('').replace(/\n$/, '') : ''
      const classes = code?.type === 'element' ? code.properties.className : undefined
      const language = Array.isArray(classes) ? classes.find((name) => String(name).startsWith('language-'))?.toString().slice(9) ?? '' : ''
      return <div className="min-w-0">
        <defaultComponents.pre {...props} />
        {!streaming && value && <div className="flex justify-end py-1.5">
          <Button size="xs" onClick={() => onCode(value, language)}>
            <SquareTerminal data-icon="inline-start" />带入 IDE
          </Button>
        </div>}
      </div>
    },
  } : undefined, [onCode, streaming])
  const content = parts?.length ? parts : text ? [{ type: 'text' as const, id: 'legacy', text }] : []

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="run-content">
      {content.map((part, index) => {
        if (part.type === 'text') return <MessageResponse key={part.id} components={components} isAnimating={streaming}>{part.text}</MessageResponse>
        // Pi may defer thinking_end until the whole response finishes. A later
        // content block is already evidence that the visible phase has moved on.
        const thinking = streaming && part.status === 'streaming' && index === content.length - 1
        if (part.type === 'reasoning') return (
          <Reasoning key={part.id} defaultOpen={false} isStreaming={thinking && idleSeconds < 30} className="mb-0" data-testid="reasoning">
            <ReasoningTrigger getThinkingMessage={() => thinking
              ? idleSeconds >= 30 ? <span>等待模型继续响应</span> : <Shimmer>正在思考…</Shimmer>
              : <span>{part.status === 'interrupted' ? '思考已中断' : '思考过程'}</span>} />
            <ReasoningContent className="mt-3 max-h-72 overflow-y-auto overscroll-contain border-l pl-3">
              {part.text || (part.status === 'streaming' ? '等待模型返回推理内容…' : '此阶段没有公开推理正文。')}
            </ReasoningContent>
          </Reasoning>
        )
        return (
          <Tool key={part.id} className="mb-0" data-testid="tool-call">
            <ToolHeader type="dynamic-tool" toolName={part.name} title={TOOL_NAMES[part.name] ?? (part.name || '工具调用')}
              state={part.status === 'generating' || part.status === 'ready' ? 'input-streaming' : part.status === 'running' ? 'input-available' : part.status === 'done' ? 'output-available' : 'output-error'}
              statusLabel={part.status === 'generating' ? '生成参数中' : part.status === 'ready' ? '等待执行' : part.status === 'interrupted' ? '已中断' : undefined} />
            {part.inputCharacters !== undefined && <p className="px-3 pb-3 text-xs text-muted-foreground">
              已接收 {part.inputCharacters.toLocaleString()} 字符的工具参数{part.status === 'generating' || part.status === 'ready' ? '，尚未执行。' : '。'}
            </p>}
            <ToolContent className="text-xs text-muted-foreground">
              <code className="break-all">{part.name}</code>
              <p>{part.status === 'done' ? '工具已返回；最终产物以页面中的保存或确认结果为准。'
                : part.status === 'generating' ? '模型正在生成工具参数，尚未调用工具。'
                : part.status === 'ready' ? '参数已接收，等待模型响应正常结束后执行。'
                : part.status === 'running' ? '正在等待工具返回。' : part.status === 'interrupted' ? '调用未完成，未收到工具结果。' : '工具调用失败。'}</p>
            </ToolContent>
          </Tool>
        )
      })}
      {streaming && !content.some((part, index) => part.type === 'reasoning' && part.status === 'streaming' && index === content.length - 1
        || part.type === 'tool' && ['generating', 'ready', 'running'].includes(part.status)) && (
        <div role="status" className="text-sm text-muted-foreground"><Shimmer>{text ? '正在回复…' : '等待模型响应…'}</Shimmer></div>
      )}
      {streaming && idleSeconds >= 30 && <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground" data-testid="run-inactivity">
        本页已 {idleSeconds} 秒未收到新进度。可以继续等待，或停止后重试。
      </p>}
    </div>
  )
}
