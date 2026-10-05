import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLibrary, searchSkills, skillSource } from './skill-library.js';
import { SkillService } from './skills.js';
import { openDatabase } from '../storage/database.js';

function makeSkill(root: string, name = 'reviewing-loops', body = 'Explain the counter before the condition.') {
  const directory = join(root, name); mkdirSync(join(directory, 'reference'), { recursive: true });
  mkdirSync(join(directory, 'scripts'));
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Explain loops when the learner asks about iteration.\n---\n${body}\nRead reference/examples.md.`);
  writeFileSync(join(directory, 'reference/examples.md'), 'A loop with an asymmetric initial counter: 3.');
  writeFileSync(join(directory, 'scripts/example.sh'), '#!/bin/sh\nprintf never-run-on-install\n', { mode: 0o755 });
  return directory;
}

test('catalog adapter preserves public fields and distinguishes outage/schema drift from no results', async () => {
  const entry = { id: 'owner/repo/reviewing-loops', source: 'owner/repo', skillId: 'reviewing-loops', name: 'reviewing-loops', installs: 347 };
  let calls = 0;
  const request: typeof fetch = async (input, options) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.origin, 'https://skills.sh'); assert.equal(url.pathname, '/api/search');
    assert.equal(url.searchParams.get('q'), 'loops & types'); assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(options?.headers, undefined);
    return Response.json({ skills: [entry], count: 1, query: 'loops & types', extra: true });
  };
  assert.deepEqual(await searchSkills(' loops & types ', request), { skills: [entry] });
  assert.deepEqual(await searchSkills(' ', request), { skills: [] }); assert.equal(calls, 1);
  assert.deepEqual(await searchSkills('none', async () => Response.json({ skills: [] })), { skills: [] });
  for (const response of [new Response('', { status: 500 }), Response.json({ unexpected: [] }), Response.json({ skills: [{ ...entry, installs: '347' }] })]) {
    await assert.rejects(searchSkills('loops', async () => response), /无法搜索/);
  }
  assert.deepEqual(skillSource('https://www.skills.sh/owner/repo/reviewing-loops?from=search'), { source: 'owner/repo', skill: 'reviewing-loops' });
  assert.deepEqual(skillSource('owner/repo#release@reviewing-loops'), { source: 'owner/repo#release@reviewing-loops', skill: undefined });
  for (const source of ['--global', 'https://user:secret@github.com/owner/repo', 'https://skills.sh/docs', 'https://skills.sh/owner/repo/--global']) assert.throws(() => skillSource(source));
});

test('pinned public CLI installs the complete bundle, enables subsequent snapshots and safely manages updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skill-library-')), db = openDatabase(':memory:');
  const source = makeSkill(join(root, 'source')), skills = new SkillService(db, join(root, 'app'));
  try {
    const before = skills.snapshot('Explain a loop');
    const installed = await skills.install({ source, skill: 'reviewing-loops' });
    const item = installed.skills[0]!;
    assert.equal(installed.skills.length, 1); assert.equal(item.enabled, true);
    assert.equal(dirname(item.filePath), join(root, 'app/skills/reviewing-loops'));
    assert.equal(item.installation?.cliVersion, '1.7.0'); assert.equal(item.installation?.source, source);
    assert.equal(item.installation?.skill, 'reviewing-loops'); assert.match(item.installation!.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(before.prompt, '', 'existing snapshot must not receive new metadata');
    assert.match(skills.snapshot('Explain a loop').prompt, /reviewing-loops/);
    assert.ok(!skills.snapshot('Explain a loop').prompt.includes('counter before'), 'automatic loading remains progressive');
    assert.match(skills.snapshot('/skill:reviewing-loops please explain').text, /counter before/);
    const details = skills.details(item.filePath);
    assert.deepEqual(details.files, ['reference/examples.md', 'scripts/example.sh', 'SKILL.md']);
    assert.equal(skills.file(item.filePath, 'reference/examples.md').content, 'A loop with an asymmetric initial counter: 3.');
    assert.equal(readFileSync(join(dirname(item.filePath), 'scripts/example.sh'), 'utf8'), '#!/bin/sh\nprintf never-run-on-install\n');
    const library = new SkillLibrary(skills.directory, join(root, 'app'));
    assert.equal(library.contentHash(source), item.installation!.contentHash);
    const original = readFileSync(item.filePath, 'utf8');
    writeFileSync(join(source, 'reference/examples.md'), 'Upstream changed resource, not SKILL.md.');
    assert.deepEqual(await skills.update({ filePath: item.filePath }, false), { filePath: item.filePath, available: true, modified: false });
    assert.equal(readFileSync(join(dirname(item.filePath), 'reference/examples.md'), 'utf8'), 'A loop with an asymmetric initial counter: 3.', 'checking must not update');
    skills.save({ ...skills.settings().configuration, disabled: [item.filePath] });
    await skills.update({ filePath: item.filePath }, true);
    assert.equal(skills.settings().skills[0]!.enabled, false, 'update preserves enablement');
    assert.equal(skills.file(item.filePath, 'reference/examples.md').content, 'Upstream changed resource, not SKILL.md.');
    assert.equal(readFileSync(item.filePath, 'utf8'), original);
    chmodSync(join(dirname(item.filePath), 'scripts/example.sh'), 0o644);
    assert.equal((await skills.update({ filePath: item.filePath }, false)).modified, true, 'permission-only local edits matter');
    await assert.rejects(skills.update({ filePath: item.filePath }, true), /本地改动/);
    writeFileSync(item.filePath, `${original}\nLocal instructions that must survive.`);
    await assert.rejects(skills.update({ filePath: item.filePath }, true), /本地改动/);
    assert.match(readFileSync(item.filePath, 'utf8'), /must survive/);
    await assert.rejects(skills.install({ source, skill: 'reviewing-loops' }), /同名/);
    skills.remove({ filePath: item.filePath });
    assert.equal(skills.reload().skills.length, 0); assert.equal(existsSync(dirname(item.filePath)), false);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), original, 'uninstall never removes or edits upstream');
    assert.deepEqual(readdirSync(join(root, 'app/.skill-staging')), []);
    assert.deepEqual(readdirSync(join(root, 'app/.skill-backups')), []);
  } finally { await skills.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('local references can be individually removed and restored without deleting siblings or original files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-local-skills-')), db = openDatabase(':memory:');
  const source = join(root, 'external'); makeSkill(source); makeSkill(source, 'explaining-types');
  const skills = new SkillService(db, join(root, 'app'));
  try {
    const settings = skills.local({ path: source }), item = settings.skills.find((skill) => skill.name === 'reviewing-loops')!;
    assert.equal(item.installation, null); assert.equal(settings.skills.length, 2);
    assert.throws(() => skills.local({ path: 'relative' }), /绝对/);
    assert.throws(() => skills.local({ path: join(root, 'missing') }), /没有可加载/);
    await assert.rejects(skills.update({ filePath: item.filePath }, false), /原目录/);
    skills.remove({ filePath: item.filePath });
    assert.deepEqual(skills.settings().skills.map((skill) => skill.name), ['explaining-types']);
    assert.ok(existsSync(item.filePath));
    assert.equal(new SkillService(db, join(root, 'app')).settings().skills.length, 1);
    assert.ok(!skills.snapshot('Explain').prompt.includes('reviewing-loops'));
    assert.equal(skills.local({ path: item.filePath }).skills.length, 2);
    assert.throws(() => skills.details(join(root, 'secret')), /未找到/);
    assert.throws(() => skills.file(item.filePath, '../../secret'), /请选择/);
    symlinkSync(join(root, 'secret'), join(dirname(item.filePath), 'escape'));
    assert.throws(() => skills.details(item.filePath), /链接/);
    assert.throws(() => skills.remove({ filePath: join(root, 'external') }), /未找到/);
    rmSync(join(dirname(item.filePath), 'escape'));
    const collision = makeSkill(join(root, 'alternate'));
    await assert.rejects(skills.install({ source: collision }), /同名/);
    assert.equal(existsSync(join(skills.directory, 'reviewing-loops')), false);
  } finally { await skills.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a local reference added during acquisition is not shadowed by the downloaded skill', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skill-collision-')), db = openDatabase(':memory:');
  const source = makeSkill(join(root, 'source')), skills = new SkillService(db, join(root, 'app'));
  try {
    const acquisition = skills.install({ source });
    skills.local({ path: source });
    await assert.rejects(acquisition, /同名/);
    assert.equal(skills.settings().skills[0]!.filePath, join(source, 'SKILL.md'));
    assert.equal(skills.settings().skills[0]!.installation, null);
    assert.equal(existsSync(join(skills.directory, 'reviewing-loops')), false);
    assert.deepEqual(readdirSync(join(root, 'app/.skill-staging')), []);
  } finally { await skills.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ambiguous, missing and invalid CLI acquisitions leave no installed files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skill-failures-')), db = openDatabase(':memory:');
  const source = join(root, 'source'); makeSkill(source); makeSkill(source, 'explaining-types');
  const skills = new SkillService(db, join(root, 'app'));
  try {
    await assert.rejects(skills.install({ source, skill: '--global' }), /不能是命令选项/);
    await assert.rejects(skills.install({ source }), /多个技能/);
    await assert.rejects(skills.install({ source, skill: 'nonexistent' }), /无法获取/);
    await assert.rejects(skills.install({ source: join(root, 'missing') }), /无法获取/);
    assert.deepEqual(readdirSync(skills.directory), []);
    assert.deepEqual(readdirSync(join(root, 'app/.skill-staging')), []);
    const pending = skills.install({ source, skill: 'reviewing-loops' });
    await assert.rejects(skills.install({ source, skill: 'explaining-types' }), /另一个技能/);
    await pending;
  } finally { await skills.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('interrupted replacement restores the previous managed bundle on restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skill-recovery-')), db = openDatabase(':memory:');
  const source = makeSkill(join(root, 'source')), skills = new SkillService(db, join(root, 'app'));
  try {
    const item = (await skills.install({ source })).skills[0]!;
    const backup = join(root, 'app/.skill-backups/reviewing-loops');
    renameSync(dirname(item.filePath), backup);
    const interrupted = mkdtempSync(join(root, 'app/.skill-staging/acquire-'));
    const unrelated = join(root, 'app/.skill-staging/notes.txt');
    writeFileSync(unrelated, 'Preserve files not created by acquisition.');
    const recovered = new SkillService(db, join(root, 'app'));
    assert.equal(recovered.settings().skills[0]!.installation!.contentHash, item.installation!.contentHash);
    assert.match(readFileSync(item.filePath, 'utf8'), /counter before/);
    assert.equal(existsSync(backup), false);
    assert.equal(existsSync(interrupted), false);
    assert.equal(readFileSync(unrelated, 'utf8'), 'Preserve files not created by acquisition.');
    symlinkSync(source, join(skills.directory, 'external-link'));
    assert.equal(new SkillLibrary(skills.directory, join(root, 'app')).metadata(join(skills.directory, 'external-link/SKILL.md')), null);
    await recovered.close();
  } finally { await skills.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('acquisition does not inherit service credentials or global agent paths, and shutdown cleans its child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-skill-worker-')), db = openDatabase(':memory:');
  const skills = new SkillService(db, join(root, 'app')), bin = join(root, 'bin'), dump = join(root, 'worker-env.json');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env));\nprocess.exit(1);\n`, { mode: 0o755 });
  const original = { PATH: process.env.PATH, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.OPENROUTER_API_KEY = 'synthetic-worker-private-key'; process.env.SSH_AUTH_SOCK = '/synthetic-private-agent';
  try {
    await assert.rejects(skills.install({ source: 'synthetic/skills#test-ref', skill: 'reviewing-loops' }), /无法获取/);
    const env = JSON.parse(readFileSync(dump, 'utf8'));
    assert.equal(env.OPENROUTER_API_KEY, undefined); assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.DISABLE_TELEMETRY, '1'); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.ok(env.HOME.includes('/app/.skill-staging/acquire-'));
    assert.equal(env.XDG_STATE_HOME, join(env.HOME, 'state'));
    assert.equal(env.XDG_CONFIG_HOME, join(env.HOME, 'config'));
    assert.equal(existsSync(env.HOME), false, 'temporary acquisition home must be cleaned');
    const source = makeSkill(join(root, 'source'));
    const pending = skills.install({ source });
    const rejected = assert.rejects(pending, /停止/);
    await skills.close(); await rejected;
    assert.deepEqual(readdirSync(skills.directory), []);
    assert.deepEqual(readdirSync(join(root, 'app/.skill-staging')), []);
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await skills.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});
