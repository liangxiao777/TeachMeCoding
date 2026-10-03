import { createAssistantMessageEventStream } from '../apps/server/node_modules/@earendil-works/pi-ai/dist/index.js';
import type { StreamFn } from '../apps/server/node_modules/@earendil-works/pi-agent-core/dist/index.js';
import { reply, response } from '../apps/server/src/agents/test-support.js';

// Deterministic test provider ONLY. Real HTTP, SQLite, Pi loop and UI are not mocked.
export const agentTransport: StreamFn = (_model, context, options) => {
  const last = context.messages.at(-1);
  const user = [...context.messages].reverse().find((m) => m.role === 'user');
  const text = JSON.stringify(user?.content);
  if (last?.role !== 'toolResult') {
    if (text.includes('失败')) return response(reply([], 'error'));
    if (!text.includes('慢速')) return response(reply([{ type: 'toolCall', id: 'draft-call', name: 'submit_requirement_draft', arguments: {
      goal: '制作命令行工具', background: 'Python 自动化经验', outcome: '完成一个可用的工具', schedule: '每周 3 小时，共 6 周',
    } }], 'toolUse'));
  }
  const stream = createAssistantMessageEventStream();
  const slow = text.includes('慢速');
  const chunks = slow ? ['正在逐步整理。', '先明确目标。', '再核对基础。', '最后确认时间。'] : ['我已整理你的基础。', '需求草稿已更新，请检查右侧摘要。'];
  void (async () => {
    let accumulated = '';
    stream.push({ type: 'start', partial: reply([], 'pending') });
    stream.push({ type: 'text_start', contentIndex: 0, partial: reply([{ type: 'text', text: '' }], 'pending') });
    for (const chunk of chunks) {
      await new Promise((resolve) => setTimeout(resolve, slow ? 1400 : 200));
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
