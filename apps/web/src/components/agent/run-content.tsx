import { useMemo } from 'react'
import { defaultComponents, type Components } from 'streamdown'
import { SquareTerminal } from 'lucide-react'
import type { AgentDisplayPart } from '@teach-me-coding/contracts'
import { MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool, ToolContent, ToolHeader, ToolInput } from '@/components/ai-elements/tool'
import { Button } from '@/components/ui/button'

const TOOL_NAMES: Record<string, string> = {
  submit_requirement_draft: '整理学习需求', submit_route_proposal: '提交学习路线',
  add_route_stage: '添加学习阶段', add_route_unit: '添加学习单元',
  update_route_stage: '调整学习阶段', update_route_unit: '调整学习单元',
  remove_route_stage: '移除空阶段', remove_route_unit: '移除草稿单元',
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
      {content.map((part, index) => {
        if (part.type === 'text') return <MessageResponse key={part.id} components={components} isAnimating={streaming}>{part.text}</MessageResponse>
        // Pi may defer thinking_end until the whole response finishes. A later
        // content block is already evidence that the visible phase has moved on.
        const thinking = streaming && part.status === 'streaming' && index === content.length - 1
        if (part.type === 'reasoning') return (
          <Reasoning key={part.id} defaultOpen={false} isStreaming={thinking} className="mb-0" data-testid="reasoning">
            <ReasoningTrigger getThinkingMessage={() => thinking
              ? <Shimmer>正在思考…</Shimmer>
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
              statusLabel={part.status === 'generating' ? '准备中' : part.status === 'ready' ? '等待执行' : part.status === 'interrupted' ? '已中断' : undefined} />
            <ToolContent className="text-xs text-muted-foreground">
              <code className="break-all">{part.name}</code>
              {(part.input !== undefined || part.inputText !== undefined) && (
                <ToolInput input={part.input} inputText={part.inputText} className="max-h-96 overflow-y-auto overscroll-contain" />
              )}
            </ToolContent>
          </Tool>
        )
      })}
      {streaming && !content.some((part, index) => part.type === 'reasoning' && part.status === 'streaming' && index === content.length - 1
        || part.type === 'tool' && ['generating', 'ready', 'running'].includes(part.status)) && (
        <div role="status" className="text-sm text-muted-foreground"><Shimmer>{text ? '正在回复…' : '等待模型响应…'}</Shimmer></div>
      )}
    </div>
  )
}
