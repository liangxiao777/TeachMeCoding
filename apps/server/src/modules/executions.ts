import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeCommands, codeFile, codeRunInputSchema, idSchema, type CodeExecution } from '@teach-me-coding/contracts';
import { hash } from '../agents/context.js';
import { executionLimits, runCommand } from '../runtime/commands.js';
import { BusinessError, type Learning } from './learning.js';

/** Fixed code snapshots, not project folders or mutable drafts. Still local OS permissions. */
export class Executions {
  private live = new Map<string, { controller: AbortController; done: Promise<CodeExecution> }>();
  private closing = false;
  constructor(private learning: Learning, private limits = executionLimits) {}
  create(space: string, unit: string, raw: unknown, submissionId: string | null = null): CodeExecution {
    if (this.closing) throw new BusinessError(503, { code: 'SERVICE_CLOSING' });
    const input = codeRunInputSchema.parse(raw), spec = this.learning.unit(space, unit).assessment;
    if (spec?.revision !== input.specRevision) throw new BusinessError(409, { code: 'ASSESSMENT_VERSION_CHANGED' });
    if (spec.q2Kind !== 'code' || !spec.execution) throw new BusinessError(422, { code: 'CODE_PLAN_UNAVAILABLE' });
    if (this.list(space, unit).some((e) => ['pending', 'running'].includes(e.state))) throw new BusinessError(409, { code: 'CODE_EXECUTION_RUNNING' });
    const e: CodeExecution = { id: randomUUID(), unitId: unit, submissionId, specRevision: input.specRevision, createdAt: Date.now(),
      code: input.code, codeHash: hash(input.code), plan: spec.execution, commands: codeCommands(spec.execution), state: 'pending', results: [] };
    this.learning.db.prepare('INSERT INTO code_executions VALUES (?,?,?,?)').run(space, e.id, unit, JSON.stringify(e));
    return e;
  }
  get(space: string, id: string): CodeExecution {
    idSchema.parse(space); idSchema.parse(id);
    const row = this.learning.db.prepare('SELECT value FROM code_executions WHERE space_id=? AND id=?').get(space, id) as { value: string } | undefined;
    if (!row) throw new BusinessError(404, { code: 'CODE_EXECUTION_NOT_FOUND' });
    return JSON.parse(row.value);
  }
  list(space: string, unit: string): CodeExecution[] {
    this.learning.unit(space, unit);
    return (this.learning.db.prepare('SELECT value FROM code_executions WHERE space_id=? AND unit_id=? ORDER BY rowid').all(space, unit) as { value: string }[]).map((r) => JSON.parse(r.value));
  }
  private save(space: string, e: CodeExecution) { this.learning.db.prepare('UPDATE code_executions SET value=? WHERE space_id=? AND id=?').run(JSON.stringify(e), space, e.id); }
  run(space: string, id: string): Promise<CodeExecution> {
    const existing = this.live.get(id); if (existing) return existing.done;
    const e = this.get(space, id);
    if (e.state !== 'pending' || this.closing) return Promise.resolve(e);
    e.state = 'running'; this.save(space, e);
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      let directory: string | undefined;
      const deadline = Date.now() + this.limits.milliseconds;
      let remaining = this.limits.outputBytes;
      try {
        for (const [i, command] of e.commands.entries()) {
          const blocked = controller.signal.aborted ? 'cancelled' : Date.now() >= deadline ? 'timed-out' : remaining === 0 ? 'output-limit' : null;
          if (blocked) {
            e.results.push({ command, expected: e.plan.cases[i]!.expected, matches: false, result: { status: blocked, output: '', exitCode: null, signal: null } });
            break;
          }
          directory = mkdtempSync(join(tmpdir(), 'tmc-code-'));
          writeFileSync(join(directory, codeFile(e.plan)), e.code, { mode: 0o600 });
          const result = await runCommand(command, directory, controller.signal, { milliseconds: Math.max(1, deadline - Date.now()), outputBytes: remaining });
          remaining = Math.max(0, remaining - Buffer.byteLength(result.output));
          const expected = e.plan.cases[i]!.expected;
          const normalize = (s: string) => s.replaceAll('\r\n', '\n').replace(/\n$/, '');
          e.results.push({ command, expected, result, matches: result.status === 'succeeded' && normalize(result.stdout ?? '') === normalize(expected) });
          this.save(space, e);
          rmSync(directory, { recursive: true, force: true }); directory = undefined;
          if (result.status !== 'succeeded') break;
        }
        e.state = controller.signal.aborted ? 'interrupted' : e.results.length === e.commands.length && e.results.every((r) => r.result.status === 'succeeded') ? 'succeeded' : 'failed';
      } catch {
        e.state = controller.signal.aborted ? 'interrupted' : 'failed';
        e.error = { code: 'CODE_EXECUTION_FAILED' };
      } finally {
        try { if (directory) rmSync(directory, { recursive: true, force: true }); }
        catch {
          e.state = 'failed'; e.error = { code: 'CODE_EXECUTION_CLEANUP_FAILED' };
        }
      }
      this.save(space, e);
      return e;
    }).finally(() => this.live.delete(id));
    this.live.set(id, { controller, done });
    return done;
  }
  stop(space: string, id: string) {
    const e = this.get(space, id);
    this.live.get(id)?.controller.abort();
    if (e.state === 'pending') { e.state = 'interrupted'; this.save(space, e); }
    return this.get(space, id);
  }
  async close() { this.closing = true; for (const e of this.live.values()) e.controller.abort(); await Promise.all([...this.live.values()].map((e) => e.done)); }
}
