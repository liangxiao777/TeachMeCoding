import { useMemo } from 'react'
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
      {content.map((part) => {
        if (part.type === 'text') return <MessageResponse key={part.id} components={components} isAnimating={streaming}>{part.text}</MessageResponse>
        if (part.type === 'reasoning') return (
          <Reasoning key={part.id} defaultOpen={false} isStreaming={part.status === 'streaming'} className="mb-0" data-testid="reasoning">
            <ReasoningTrigger getThinkingMessage={() => part.status === 'streaming'
              ? <Shimmer>正在思考…</Shimmer> : <span>{part.status === 'interrupted' ? '思考已中断' : '思考过程'}</span>} />
            <ReasoningContent className="mt-3 max-h-72 overflow-y-auto overscroll-contain border-l pl-3">
              {part.text || (part.status === 'streaming' ? '等待模型返回推理内容…' : '此阶段没有公开推理正文。')}
            </ReasoningContent>
          </Reasoning>
        )
        return (
          <Tool key={part.id} className="mb-0" data-testid="tool-call">
            <ToolHeader type="dynamic-tool" toolName={part.name} title={TOOL_NAMES[part.name] ?? part.name}
              state={part.status === 'running' ? 'input-available' : part.status === 'done' ? 'output-available' : 'output-error'}
              statusLabel={part.status === 'interrupted' ? '已中断' : undefined} />
            <ToolContent className="text-xs text-muted-foreground">
              <code className="break-all">{part.name}</code>
              <p>{part.status === 'done' ? '工具已返回；最终产物以页面中的保存或确认结果为准。'
                : part.status === 'running' ? '正在等待工具返回。' : part.status === 'interrupted' ? '调用未完成，未收到工具结果。' : '工具调用失败。'}</p>
            </ToolContent>
          </Tool>
        )
      })}
      {streaming && !content.some((part) => part.type === 'reasoning' && part.status === 'streaming' || part.type === 'tool' && part.status === 'running') && (
        <div role="status" className="text-sm text-muted-foreground"><Shimmer>{text ? '正在回复…' : '等待模型响应…'}</Shimmer></div>
      )}
    </div>
  )
}
