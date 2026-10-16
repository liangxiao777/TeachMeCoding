import { randomUUID } from 'node:crypto';
import { actionDecisionSchema, actionReceipt, commandProposalSchema, fileProposalSchema, idSchema, type ActionProposal, type CommandResult } from '@teach-me-coding/contracts';
import { hash } from '../agents/context.js';
import { BusinessError, type Learning } from './learning.js';
import type { Projects } from './projects.js';
import { runCommand } from '../runtime/commands.js';

export class Actions {
  private live = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  constructor(private learning: Learning, private projects: Projects) {}
  prepare(space: string, session: string, run: string, kind: 'file' | 'command', raw: unknown): ActionProposal {
    const cwd = this.projects.root(space);
    let action: ActionProposal['action'];
    if (kind === 'file') {
      const value = fileProposalSchema.parse(raw);
      let before: ReturnType<Projects['read']> | null;
      try { before = this.projects.read(space, value.path); }
      catch (e) { if (!(e instanceof BusinessError) || e.status !== 404) throw e; before = null; }
      action = { kind, ...value, cwd, before: before?.content ?? null, version: before?.version ?? null };
    } else {
      const value = commandProposalSchema.parse(raw);
      action = { kind, ...value, cwd, projectVersion: hash(this.projects.tree(space)) };
    }
    const createdAt = Date.now(), expiresAt = createdAt + 30 * 60_000;
    return { id: randomUUID(), sessionId: session, runId: run, digest: hash({ action, expiresAt }), action, createdAt, expiresAt, state: 'pending', result: null };
  }
  save(space: string, proposal: ActionProposal) {
    this.learning.db.prepare('INSERT INTO action_proposals VALUES (?,?,?,?,?)').run(space, proposal.id, proposal.sessionId, proposal.runId, JSON.stringify(proposal));
  }
  list(space: string, session: string): ActionProposal[] {
    this.learning.session(space, session);
    const rows = this.learning.db.prepare('SELECT value FROM action_proposals WHERE space_id=? AND session_id=? ORDER BY rowid').all(space, session) as { value: string }[];
    return rows.map(({ value }) => { const p = JSON.parse(value) as ActionProposal; return p.state === 'pending' && p.expiresAt <= Date.now() ? { ...p, state: 'expired' } : p; });
  }
  get(space: string, id: string): ActionProposal {
    idSchema.parse(space); idSchema.parse(id);
    const row = this.learning.db.prepare('SELECT value FROM action_proposals WHERE space_id=? AND id=?').get(space, id) as { value: string } | undefined;
    if (!row) throw new BusinessError(404, '操作提案不存在。');
    return JSON.parse(row.value);
  }
  private update(space: string, proposal: ActionProposal) {
    this.learning.db.prepare('UPDATE action_proposals SET value=? WHERE space_id=? AND id=?').run(JSON.stringify(proposal), space, proposal.id);
  }
  private finish(space: string, p: ActionProposal, state: ActionProposal['state'], result: CommandResult | null) {
    this.learning.db.transaction(() => {
      this.update(space, { ...p, state, result });
      const text = actionReceipt({ ...p, state, result });
      this.learning.db.prepare("INSERT INTO messages VALUES (?,?,?,'agent',?,NULL,?)").run(space, p.sessionId, randomUUID(), text, Date.now());
    })();
  }
  decide(space: string, id: string, raw: unknown): ActionProposal {
    const input = actionDecisionSchema.parse(raw), p = this.get(space, id);
    if (input.digest !== p.digest) throw new BusinessError(409, '确认的提案内容不匹配，请刷新。');
    if (input.decision === 'cancel' && p.state === 'running') { this.live.get(id)?.controller.abort(); return this.get(space, id); }
    if (p.state !== 'pending') return p; // Any retry or competing decision is inert.
    if (this.closing) throw new BusinessError(503, '服务正在关闭。');
    if (p.expiresAt <= Date.now()) { this.finish(space, p, 'expired', null); return this.get(space, id); }
    if (input.decision !== 'confirm') { this.finish(space, p, input.decision === 'reject' ? 'rejected' : 'cancelled', null); return this.get(space, id); }
    if (this.learning.db.prepare("SELECT 1 FROM action_proposals WHERE space_id=? AND json_extract(value,'$.state')='running'").get(space)) throw new BusinessError(409, '当前空间已有本机操作执行中，请等待或取消后再确认。');
    try {
      if (p.action.cwd !== this.projects.root(space)) throw new BusinessError(409, '工作目录已变化。');
      if (p.action.kind === 'file') {
        const path = p.action.path;
        const current = this.projects.tree(space).find((e) => e.path === path);
        if (p.action.version === null ? !!current : !current || this.projects.read(space, p.action.path).version !== p.action.version) throw new BusinessError(409, '文件版本已变化，请重新生成提案。');
      } else if (hash(this.projects.tree(space)) !== p.action.projectVersion) throw new BusinessError(409, '项目已变化，请重新生成命令提案。');
    } catch (error) {
      this.finish(space, p, 'expired', null);
      throw error;
    }
    // Commit the claim before any side effect. Unknown crash outcomes are never replayed.
    this.update(space, { ...p, state: 'running' });
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      let result: CommandResult;
      try {
        if (controller.signal.aborted) result = { status: 'cancelled', output: '', exitCode: null, signal: null };
        else if (p.action.kind === 'command') result = await runCommand(p.action.command, p.action.cwd, controller.signal);
        else {
          if (p.action.version === null) this.projects.newFile(space, p.action.path, p.action.content);
          else this.projects.save(space, { path: p.action.path, version: p.action.version, content: p.action.content });
          result = { status: 'succeeded', output: `已保存 ${p.action.path}`, exitCode: 0, signal: null };
        }
      } catch (error) { result = { status: 'failed', output: error instanceof BusinessError ? error.message : '本机操作失败；可能已有部分副作用。', exitCode: null, signal: null }; }
      this.finish(space, p, result.status === 'succeeded' ? 'succeeded' : result.status === 'cancelled' ? 'cancelled' : 'failed', result);
    }).finally(() => this.live.delete(id));
    this.live.set(id, { controller, done });
    return this.get(space, id);
  }
  async idle(id: string) { await this.live.get(id)?.done; }
  async close() { this.closing = true; for (const e of this.live.values()) e.controller.abort(); await Promise.all([...this.live.values()].map((e) => e.done)); }
}
