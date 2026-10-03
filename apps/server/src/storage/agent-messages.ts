import type Database from 'better-sqlite3';
import type { Message } from '@earendil-works/pi-ai';

/** Close interrupted native protocol relationships, not tool execution or business results. */
export function sealToolCalls(db: Database.Database, table: 'agent_messages' | 'task_messages', space: string, run: string) {
  const rows = db.prepare(`SELECT seq,value FROM ${table} WHERE space_id=? AND run_id=? ORDER BY seq`).all(space, run) as { seq: number; value: string }[];
  const pending = new Map<string, string>();
  for (const row of rows) {
    const message = JSON.parse(row.value) as Message;
    if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') pending.set(part.id, part.name);
    if (message.role === 'toolResult') pending.delete(message.toolCallId);
  }
  let seq = rows.at(-1)?.seq ?? 0;
  for (const [toolCallId, toolName] of pending) {
    const missing: Message = { role: 'toolResult', toolCallId, toolName, isError: true, timestamp: Date.now(),
      content: [{ type: 'text', text: '[host recovery marker: tool result unavailable after interruption; execution may not have started or completed; never infer success]' }] };
    db.prepare(`INSERT INTO ${table} VALUES (?,?,?,1,?)`).run(space, run, ++seq, JSON.stringify(missing));
  }
}
