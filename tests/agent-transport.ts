import { createAssistantMessageEventStream, type AssistantMessage } from '../apps/server/node_modules/@earendil-works/pi-ai/dist/index.js';
import type { StreamFn } from '../apps/server/node_modules/@earendil-works/pi-agent-core/dist/index.js';
import { reply, response, routeReply } from '../apps/server/src/agents/test-support.js';

// Deterministic test provider ONLY. Real HTTP, SQLite, Pi loop and UI are not mocked.
let evaluationFailed = false;
let planningFailed = false;
export const agentTransport: StreamFn = async (_model, context, options) => {
  const last = context.messages.at(-1);
  const user = [...context.messages].reverse().find((m) => m.role === 'user');
  const text = JSON.stringify(user?.content);
  const all = JSON.stringify(context);
  const has = (name: string) => context.messages.some((m) => m.role === 'system' && m.toolsAdded?.some((t) => t.name === name));
  if (text.includes('推理验收')) {
    if (options?.reasoning !== 'high') throw new Error('Expected high reasoning');
    const message = last?.role === 'toolResult'
      ? reply([{ type: 'thinking', thinking: '工具已返回。核对学习时间与目标。', thinkingSignature: 'PRIVATE-SIGNATURE' },
        { type: 'text', text: '## 学习建议\n\n目标已经整理。\n\n| 项目 | 安排 |\n| --- | --- |\n| 练习 | 每周两次 |\n\n```python\nprint("hello")\n```\n\n使用 `print` 输出文字。' }])
      : reply([{ type: 'thinking', thinking: '先核对已有基础。再区分目标与时间。最后整理需求。', thinkingSignature: 'PRIVATE-SIGNATURE' },
        { type: 'text', text: '我会先整理目标。' },
        has('submit_learning_conclusion') ? { type: 'toolCall', id: 'reasoning-conclusion', name: 'submit_learning_conclusion', arguments: { text: '根据已有基础继续练习。' } }
        : { type: 'toolCall', id: 'reasoning-draft', name: 'submit_requirement_draft', arguments: {
          goal: '学习 Python', background: '已有变量基础', outcome: '编写小程序', schedule: '每周两次',
        } }], 'toolUse');
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const partial: AssistantMessage = { ...message, content: [], stopReason: 'pending' };
      stream.push({ type: 'start', partial: structuredClone(partial) });
      for (const [contentIndex, part] of message.content.entries()) {
        if (part.type === 'thinking') {
          partial.content.push({ ...part, thinking: '' });
          stream.push({ type: 'thinking_start', contentIndex, partial: structuredClone(partial) });
          for (const delta of part.thinking.match(/[^。]+。?/g) ?? []) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            if (options.signal?.aborted) { stream.push({ type: 'error', reason: 'aborted', error: { ...partial, stopReason: 'aborted' } }); return; }
            const current = partial.content[contentIndex];
            if (current?.type === 'thinking') current.thinking += delta;
            stream.push({ type: 'thinking_delta', contentIndex, delta, partial: structuredClone(partial) });
          }
          stream.push({ type: 'thinking_end', contentIndex, content: part.thinking, partial: structuredClone(partial) });
        } else {
          partial.content.push(part);
          if (part.type === 'text') {
            stream.push({ type: 'text_start', contentIndex, partial: structuredClone(partial) });
            stream.push({ type: 'text_delta', contentIndex, delta: part.text, partial: structuredClone(partial) });
            stream.push({ type: 'text_end', contentIndex, content: part.text, partial: structuredClone(partial) });
          }
        }
      }
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    })();
    return stream;
  }
  if (last?.role !== 'toolResult') {
    if (has('propose_command') && text.includes('本机提案')) return response(reply([{ type: 'toolCall', id: 'local-proposal',
      name: text.includes('文件') ? 'propose_file_change' : 'propose_command',
      arguments: text.includes('文件') ? { path: 'proposal.sh', content: 'printf "CONFIRMED_47\\n"\n', reason: '添加可运行练习' }
        : { command: text.includes('等待') ? 'sleep 30; touch must-not-exist' : 'bash proposal.sh; echo once >> confirmations', reason: '运行已保存练习' },
    }], 'toolUse'));
    if (text.includes('失败')) return response(reply([], 'error'));
    if (has('submit_evaluation') && all.includes('FAIL-ONCE') && !evaluationFailed) { evaluationFailed = true; return response(reply([], 'error')); }
    if (has('submit_assessment')) return response(reply([{ type: 'toolCall', id: 'assessment-call', name: 'submit_assessment', arguments: {
      public: { q1: '解释命令行参数来自哪里', q2: all.includes('纯推理') ? '说明零个参数与两个参数的区别' : '读取并输出参数个数', starter: 'import sys\n', q2Kind: all.includes('纯推理') ? 'reasoning' : 'code' },
      rubric: { q1: { answer: 'PRIVATE-RUBRIC', criteria: ['调用者'] }, q2: { answer: 'PRIVATE-CODE', criteria: ['正确计数'] } },
    } }], 'toolUse'));
    if (has('submit_evaluation')) return response(reply([{ type: 'toolCall', id: 'evaluation-call', name: 'submit_evaluation', arguments: {
      result: 'pass', summary: '静态分析已完成。', mastered: ['参数读取'], concerns: ['还需验证边界输入'], evidence: ['答案提到程序的调用者'], toVerify: ['实际执行'],
    } }], 'toolUse'));
    if (has('submit_lesson')) return response(reply([{ type: 'toolCall', id: 'lesson-call', name: 'submit_lesson', arguments: {
      title: '参数与输入', intro: '从一个小工具开始理解命令行参数。', blocks: [
        { type: 'h2', id: 'arguments', text: '参数从哪里来' }, { type: 'p', text: '命令行参数是启动程序时由调用者提供的字符串。' },
        { type: 'code', file: 'args.py', language: 'python', code: 'import sys\nprint(sys.argv[1:])', caption: '本示例尚未在本机执行。' },
        { type: 'practice', items: ['比较传入零个参数与两个参数时的差异。'] },
      ],
    } }], 'toolUse'));
    if (has('submit_learning_conclusion')) return response(reply([{ type: 'toolCall', id: 'conclusion-call', name: 'submit_learning_conclusion', arguments: {
      text: '命令行参数来自启动程序的调用者，读取参数不等于验证参数。',
    } }], 'toolUse'));
    if (!has('submit_route_proposal') && !text.includes('慢速')) return response(reply([{ type: 'toolCall', id: 'draft-call', name: 'submit_requirement_draft', arguments: {
      goal: text.includes('纯推理') ? '纯推理' : '制作命令行工具', background: 'Python 自动化经验', outcome: '完成一个可用的工具', schedule: '每周 3 小时，共 6 周',
    } }], 'toolUse'));
  }
  if (has('submit_route_proposal')) {
    if (last?.role === 'toolResult' && last.toolName === 'add_route_stage' && all.includes('PLAN-SLOW')) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const previous = context.messages.slice(0, context.messages.findLastIndex((m) => m.role === 'user')).some((m) =>
      m.role === 'assistant' && m.content.some((part) => part.type === 'toolCall' && part.name === 'submit_route_proposal'));
    if (last?.role !== 'toolResult') {
      await new Promise((resolve) => setTimeout(resolve, all.includes('PLAN-SLOW') ? 4000 : 600));
      if (all.includes('PLAN-FAIL-ONCE') && !planningFailed) { planningFailed = true; return response(reply([], 'error')); }
      if (all.includes('PLAN-STREAM-ERROR')) {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          const tool = { type: 'toolCall' as const, id: 'streamed-route', name: 'add_route_stage', arguments: { title: '工具基础：参数、错误与输出' } };
          const partial = reply([{ type: 'thinking', thinking: '核对需求。'.repeat(121) }, tool], 'pending');
          stream.push({ type: 'start', partial: reply([], 'pending') });
          stream.push({ type: 'thinking_start', contentIndex: 0, partial });
          for (const delta of '核对需求。'.repeat(121)) stream.push({ type: 'thinking_delta', contentIndex: 0, delta, partial });
          // Like the real OpenAI-completions adapter, do not send thinking_end
          // before tool arguments; a later provider failure omits it entirely.
          stream.push({ type: 'toolcall_start', contentIndex: 1, partial });
          const json = JSON.stringify(tool.arguments);
          for (const delta of [json.slice(0, 10), json.slice(10, 40), json.slice(40)]) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            stream.push({ type: 'toolcall_delta', contentIndex: 1, delta, partial });
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 12_000);
            options?.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          const reason = options?.signal?.aborted ? 'aborted' : 'error';
          stream.push({ type: 'error', reason, error: { ...partial, stopReason: reason, errorMessage: 'PRIVATE-PROVIDER-ERROR' } });
        })();
        return stream;
      }
    }
    const next = routeReply(context.messages, { note: previous ? '调整后增加边界练习' : '从 Python 经验过渡到命令行工具', stages: [{ title: '工具基础', units: [
      { title: '参数与输入', summary: '学习读取命令行参数', goals: ['能解释参数来源'] },
      { title: '错误与输出', summary: '处理缺失参数', goals: ['区分正常和错误输出'] },
    ] }] }, previous);
    if (next) return response(next);
  }
  const stream = createAssistantMessageEventStream();
  const slow = text.includes('慢速') || has('submit_evaluation');
  const chunks = slow ? ['正在逐步整理。', '先明确目标。', '再核对基础。', '最后确认时间。'] : has('submit_route_proposal') ? ['路线内容已整理，', '正在完成规划。']
    : has('submit_lesson') ? ['课件已整理。'] : has('submit_learning_conclusion') ? ['参数来自调用者。', '可采纳下方结论，或继续讨论边界情况。'] : ['我已整理你的基础。', '需求草稿已更新，请检查右侧摘要。'];
  void (async () => {
    let accumulated = '';
    stream.push({ type: 'start', partial: reply([], 'pending') });
    stream.push({ type: 'text_start', contentIndex: 0, partial: reply([{ type: 'text', text: '' }], 'pending') });
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, has('submit_route_proposal') ? all.includes('PLAN-SLOW') ? 2500 : 600 : text.includes('延迟摘要') ? 2000 : slow ? 1400 : 200));
      if (options?.signal?.aborted) { stream.push({ type: 'error', reason: 'aborted', error: reply([{ type: 'text', text: accumulated }], 'aborted') }); return; }
      accumulated += chunk;
      stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk, partial: reply([{ type: 'text', text: accumulated }], 'pending') });
    }
    const message = reply([{ type: 'text', text: accumulated }]);
    stream.push({ type: 'text_end', contentIndex: 0, content: accumulated, partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
  })();
  return stream;
};
