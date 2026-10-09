import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '../apps/server/node_modules/@earendil-works/pi-ai/dist/index.js';
import type { StreamFn } from '../apps/server/node_modules/@earendil-works/pi-agent-core/dist/index.js';
import { reply, response, routeReply } from '../apps/server/src/agents/test-support.js';

// Deterministic test provider ONLY. Real HTTP, SQLite, Pi loop and UI are not mocked.
let evaluationFailed = false;
let planningFailed = false;
const failedIntakeAnswers = new Set<string>();
export const agentTransport: StreamFn = async (_model, context, options) => {
  const last = context.messages.at(-1);
  const user = [...context.messages].reverse().find((m) => m.role === 'user');
  const text = JSON.stringify(user?.content);
  const all = JSON.stringify(context);
  const has = (name: string) => context.messages.some((m) => m.role === 'system' && m.toolsAdded?.some((t) => t.name === name));
  if (has('ask_user_question') && all.includes('自适应问答验收')) {
    const current = context.messages.slice(context.messages.findLastIndex((m) => m.role === 'user') + 1);
    const results = current.filter((m) => m.role === 'toolResult');
    const fields = { rows: [
      { question: '想学习什么？', answer: '学习 Cedar 4.7.2 的流式解析' },
      { question: '已有经验？', answer: '会写循环，尚未做过解析器' },
      { question: '希望完成什么？', answer: '处理本地流水账的坏输入' },
      { question: '时间安排？', answer: '每周两次，每次 30 分钟' },
    ] };
    const call = (name: string, args: JsonObject) => response(reply([{ type: 'toolCall', id: `intake-${results.length}-${name}`, name, arguments: args }], 'toolUse'));
    if (text.includes('自适应问答验收')) {
      if (!results.length) return response(reply([
        { type: 'toolCall', id: 'intake-draft', name: 'submit_requirement_draft', arguments: fields },
        { type: 'toolCall', id: 'intake-questions', name: 'ask_user_question', arguments: { questions: [
          { prompt: '希望先完成哪一种成果？', multiple: false, options: [
            { label: '离线命令行工具', description: '读取本地文件，不部署服务' },
            { label: '浏览器演示', description: '交互展示解析过程' },
          ] },
          { prompt: '优先练习哪些能力？', multiple: true, options: [
            { label: '识别坏输入', description: '练习错误处理与边界' },
            { label: '测量内存', description: '理解流式处理的资源限制' },
            { label: '解释状态', description: '能说明分块时需要保留什么' },
          ] },
          { prompt: '练习时优先使用什么材料？', multiple: false, options: [
            { label: '合成记录', description: '先用可公开的例子' },
            { label: '自己的脱敏数据', description: '不上传原始私人资料' },
          ] },
          { prompt: '如何检查练习成果？', multiple: true, options: [
            { label: '自动化测试', description: '检查输出与边界' },
            { label: '逐步解释', description: '说明处理过程' },
          ] },
        ].slice(0, text.includes('单题问答') ? 1 : text.includes('四题问答') ? 4 : 2) } },
      ], 'toolUse'));
      return response(reply([{ type: 'text', text: '先确认成果与练习重点，再核验影响路线的技术资料。' }]));
    }
    const space = all.match(/spaceId=\\"([^\\]+)\\"/)?.[1] ?? '';
    if (text.includes('回答后失败一次') && !failedIntakeAnswers.has(space)) {
      failedIntakeAnswers.add(space); return response(reply([], 'error'));
    }
    if (!results.length) return call('web_fetch', { url: 'https://docs.example.org/cedar/4.7.2', extractMode: 'text' });
    if (results.length === 1) {
      const content = '# Cedar（验收用项目） 4.7.2\n\nCedar 用来逐块解析记录（确定性验收材料，不是实际产品资料）。\n\n## 学习范围\n\n处理命令行账本中的坏输入，练习分块状态和错误处理。\n\n| 项目 | 内容 |\n| --- | --- |\n| 适用版本 | 4.7.2 |\n| 运行环境 | Node 24 |\n\n## 练习建议\n\n从坏输入与分块边界开始，再比较内存使用。\n\n```ts\n  parse("a");\n```\n\n## 待补充\n\n性能基准留到练习阶段，不阻塞路线。\n\n## 资料来源\n\n[官方资料](https://docs.example.org/cedar/4.7.2)\n';
      const hostile = all.includes('不可信 Markdown 验收') ? '\n<script>window.__researchInjected = true</script>\n<img src="https://research-tracker.example/raw" onerror="window.__researchInjected = true">\n\n![追踪图片](https://research-tracker.example/pixel)\n\n[危险脚本](javascript:alert(1))\n\n[本地服务](http://127.0.0.1:4310/private)\n\n[含凭据链接](https://user:secret@public.org/private)\n' : '';
      return call('write_research_document', { content: content + hostile });
    }
    if (results.length === 2) return call('submit_requirement_draft', fields);
    return response(reply([{ type: 'text', text: '已保存回答与固定版本资料，请核对摘要后再确认。' }]));
  }
  if (text.includes('推理验收')) {
    if (options?.reasoning !== 'high') throw new Error('Expected high reasoning');
    const message = last?.role === 'toolResult'
      ? reply([{ type: 'thinking', thinking: '工具已返回。核对学习时间与目标。', thinkingSignature: 'PRIVATE-SIGNATURE' },
        { type: 'text', text: '## 学习建议\n\n目标已经整理。\n\n| 项目 | 安排 |\n| --- | --- |\n| 练习 | 每周两次 |\n\n```python\nprint("hello")\n```\n\n使用 `print` 输出文字。' }])
      : reply([{ type: 'thinking', thinking: '先核对已有基础。再区分目标与时间。最后整理需求。', thinkingSignature: 'PRIVATE-SIGNATURE' },
        { type: 'text', text: '我会先整理目标。' },
        has('submit_learning_conclusion') ? { type: 'toolCall', id: 'reasoning-conclusion', name: 'submit_learning_conclusion', arguments: { text: '根据已有基础继续练习。' } }
        : { type: 'toolCall', id: 'reasoning-draft', name: 'submit_requirement_draft', arguments: {
          rows: [
            { question: '想学习什么？', answer: '学习 Python' },
            { question: '已有经验？', answer: '已有变量基础' },
            { question: '希望完成什么？', answer: '编写小程序' },
            { question: '时间安排？', answer: '每周两次' },
          ],
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
      public: { q1: '解释命令行参数来自哪里', q2: all.includes('纯推理') ? '说明零个参数与两个参数的区别' : '读取并输出参数个数', starter: all.includes('真实代码测评') ? '// 输出参数个数\n' : 'import sys\n', q2Kind: all.includes('纯推理') ? 'reasoning' : 'code',
        ...(all.includes('真实代码测评') ? { execution: { language: 'javascript', cases: [{ args: ['red', 'blue'], expected: '2' }, { args: [], expected: '0' }] } } : {}) },
      rubric: { q1: { answer: 'PRIVATE-RUBRIC', criteria: ['调用者'] }, q2: { answer: 'PRIVATE-CODE', criteria: ['正确计数'] } },
    } }], 'toolUse'));
    // Intentionally proposes pass even for wrong code: browser tests must exercise the host's override.
    // Real-provider UX verification is separate; this fixture cannot prove evaluation quality.
    if (has('submit_evaluation')) return response(reply([{ type: 'toolCall', id: 'evaluation-call', name: 'submit_evaluation', arguments: {
      result: 'pass', summary: '本次提交符合题目要求。', mastered: [], concerns: [], evidence: ['解释题说明参数是在启动程序时传入的，不是程序自己产生的。'], toVerify: [],
    } }], 'toolUse'));
    if (has('submit_lesson')) return response(reply([{ type: 'toolCall', id: 'lesson-call', name: 'submit_lesson', arguments: {
      title: '参数与输入', content: [
        '从一个小工具开始理解命令行参数。',
        '## 参数从哪里来\n\n命令行参数是启动程序时由调用者提供的字符串。',
        '```python file=args.py\nimport sys\nprint(sys.argv[1:])\n```',
        '> [!TIP]\n> 本示例尚未在本机执行。可以带入 IDE 后自行尝试。',
        '::::practice\n比较传入零个参数与两个参数时的差异。\n\n:::hint\n先观察 `sys.argv[1:]` 如何排除程序名。\n:::\n\n:::solution\n零个参数得到空列表，两个参数得到包含两个字符串的列表。\n:::\n::::',
      ].join('\n\n'),
    } }], 'toolUse'));
    if (has('submit_learning_conclusion')) return response(reply([{ type: 'toolCall', id: 'conclusion-call', name: 'submit_learning_conclusion', arguments: {
      text: '命令行参数来自启动程序的调用者，读取参数不等于验证参数。',
    } }], 'toolUse'));
    if (!has('submit_route_proposal') && !text.includes('慢速')) return response(reply([{ type: 'toolCall', id: 'draft-call', name: 'submit_requirement_draft', arguments: {
      rows: [
        { question: '想学习什么？', answer: text.includes('纯推理') ? '纯推理' : text.includes('真实代码测评') ? '真实代码测评' : '制作命令行工具' },
        { question: '已有经验？', answer: 'Python 自动化经验' },
        { question: '希望完成什么？', answer: '完成一个可用的工具' },
        { question: '时间安排？', answer: '每周 3 小时，共 6 周' },
      ],
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
