import type Database from 'better-sqlite3';
import { SessionManager, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';
import { retainedMessage, type HistoryGroup } from '../agents/context.js';

export interface SessionCheckpoint { header: SessionHeader; entries: SessionEntry[] }

/** Restore successful turns only. Raw diagnostics never become model context. */
export function restoreAgentSession(db: Database.Database, space: string, session: string | null, run: string, cwd: string) {
  let manager = SessionManager.inMemory(cwd, { id: session ?? run });
  const history: HistoryGroup[] = [];
  if (session) {
    const saved = db.prepare(`SELECT json_extract(a.input,'$.sessionCheckpoint') AS checkpoint FROM runs r
      JOIN agent_runs a ON a.space_id=r.space_id AND a.id=r.id
      WHERE r.space_id=? AND r.session_id=? AND r.id!=? AND r.state='succeeded'
      AND json_type(a.input,'$.sessionCheckpoint')='object' ORDER BY r.rowid`).all(space, session, run) as { checkpoint: string }[];
    const checkpoints = saved.map((row) => JSON.parse(row.checkpoint) as SessionCheckpoint);
    if (checkpoints.length) {
      manager = SessionManager.inMemory(cwd, { id: session }, [checkpoints[0]!.header, ...checkpoints.flatMap((c) => c.entries)]);
    } else {
      // Import legacy native history once, before this session's first checkpoint.
      const rows = db.prepare(`SELECT r.id,m.value FROM runs r JOIN agent_messages m ON m.space_id=r.space_id AND m.run_id=r.id
        WHERE r.space_id=? AND r.session_id=? AND r.id!=? AND r.state='succeeded' ORDER BY r.rowid,m.seq`).all(space, session, run) as { id: string; value: string }[];
      for (const row of rows) {
        let group = history.at(-1);
        if (group?.id !== row.id) { group = { id: row.id, messages: [] }; history.push(group); }
        group.messages.push(JSON.parse(row.value) as Message);
      }
    }
  }
  const inherited = manager.getEntryCount();
  return { manager, history, checkpoint: (): SessionCheckpoint => ({ header: manager.getHeader()!,
    // Append deltas, not another copy of the entire conversation. Preserve native
    // compaction boundaries, system checkpoints and omission edits verbatim.
    entries: manager.getEntries().slice(inherited).map((entry) => entry.type === 'message' &&
      ['system', 'user', 'assistant', 'toolResult'].includes(entry.message.role)
      ? { ...entry, message: retainedMessage(entry.message as Message) } : structuredClone(entry)),
  }) };
}
