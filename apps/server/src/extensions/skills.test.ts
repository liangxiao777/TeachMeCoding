import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { SkillService } from './skills.js';
import { openDatabase } from '../storage/database.js';
import { Learning } from '../modules/learning.js';
import { TeachingRuntime } from '../agents/runtime.js';
import { response, reply, syntheticSource } from '../agents/test-support.js';

test('Pi Skills use progressive XML metadata, explicit invocation and persisted enablement', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skills-')), db = openDatabase(':memory:');
  try {
    const skills = new SkillService(db, root);
    const make = (name: string, manual = false, directory = skills.directory, body = 'Use the secret fixture instruction.') => {
      const folder = join(directory, name); mkdirSync(folder, { recursive: true });
      const path = join(folder, 'SKILL.md');
      writeFileSync(path, `---\nname: ${name}\ndescription: "Reviews <code> & explains it."\n${manual ? 'disable-model-invocation: true\n' : ''}---\n${body}`);
      return path;
    };
    const automatic = make('reviewing-code'), manual = make('assessing-code', true);
    const snapshot = skills.snapshot('Explain code');
    assert.match(snapshot.prompt, /reviewing-code/);
    assert.match(snapshot.prompt, /&lt;code&gt; &amp;/);
    assert.ok(!snapshot.prompt.includes('assessing-code'));
    assert.ok(!snapshot.prompt.includes('secret fixture instruction'), 'body must not be loaded until needed');
    assert.equal(XMLValidator.validate(snapshot.prompt), true);
    const explicit = skills.snapshot('/skill:assessing-code explain a loop');
    assert.match(explicit.text, /secret fixture instruction/);
    assert.match(explicit.text, /explain a loop/);
    assert.match(explicit.text, /directory=/);
    skills.save({ paths: [], disabled: [automatic] });
    assert.ok(!skills.snapshot('review').prompt.includes('reviewing-code'));
    assert.throws(() => skills.snapshot('/skill:reviewing-code'), /停用/);
    assert.equal(new SkillService(db, root).settings().skills.find((s) => s.filePath === automatic)?.enabled, false);
    const extra = join(root, 'extra'); make('assessing-code', false, extra, 'Losing duplicate body');
    const bad = join(extra, 'invalid'); mkdirSync(bad); writeFileSync(join(bad, 'SKILL.md'), '---\nname: invalid\n---\nMissing description.');
    const settings = skills.save({ paths: [extra], disabled: [] });
    assert.ok(settings.diagnostics.some((diagnostic) => diagnostic.type === 'collision'));
    assert.ok(settings.diagnostics.some((diagnostic) => diagnostic.type === 'warning'));
    assert.equal(settings.skills.find((s) => s.name === 'assessing-code')!.filePath, manual);
    assert.throws(() => skills.save({ paths: ['relative/path'], disabled: [] }), /绝对/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the real teaching loop lists Skills, can read their body and preserves original scene tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skill-loop-')), db = openDatabase(':memory:');
  const learning = new Learning(db), skills = new SkillService(db, root);
  const path = join(skills.directory, 'reviewing-loops'); mkdirSync(path);
  writeFileSync(join(path, 'SKILL.md'), '---\nname: reviewing-loops\ndescription: Explain loops when the learner asks about them.\n---\nExplain the counter before the condition.');
  let calls = 0;
  const agents = new TeachingRuntime(learning, syntheticSource, { skills, projectDirectory: () => root, stream: (_model, context) => {
    const system = context.messages.find((m) => m.role === 'system'); assert.ok(system?.role === 'system');
    assert.ok(typeof system.content === 'string');
    assert.match(system.content, /available_skills/);
    assert.ok(system.toolsAdded?.some((t) => t.name === 'submit_requirement_draft'));
    assert.ok(system.toolsAdded?.some((t) => t.name === 'read'));
    assert.equal(XMLValidator.validate(system.content), true);
    if (++calls === 1) {
      assert.ok(!JSON.stringify(context.messages).includes('Explain the counter'));
      return response(reply([{ type: 'toolCall', id: 'read-skill', name: 'read', arguments: { path: join(path, 'SKILL.md') } }], 'toolUse'));
    }
    assert.ok(JSON.stringify(context.messages).includes('Explain the counter'));
    return response(reply([{ type: 'text', text: 'Explain the counter before the condition.' }]));
  } });
  try {
    const space = agents.createSpace(randomUUID(), { name: 'Loops', goal: 'Explain loops' });
    const run = space.runs[0]!; await agents.idle(run.id);
    assert.equal(agents.get(space.id, run.id).state, 'succeeded');
    assert.equal(calls, 2);
    const manifest = db.prepare('SELECT value FROM context_manifests WHERE run_id=?').get(run.id) as { value: string };
    assert.equal(typeof JSON.parse(manifest.value).extensions.skills, 'string');
    const session = learning.session(space.id, run.sessionId!);
    const explicit = agents.submit(space.id, session.id, randomUUID(), { text: '/skill:reviewing-loops test request', quote: null, draftRevision: session.draft.revision });
    await agents.idle(explicit.run.id);
    assert.equal(agents.get(space.id, explicit.run.id).state, 'succeeded');
    assert.equal(calls, 3);
  } finally { await agents.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
