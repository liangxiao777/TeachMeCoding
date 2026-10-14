import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createSessionSchema, routeContentSchema, saveRequirementSchema } from '@teach-me-coding/contracts';
import { migrate, migrations, openDatabase } from './database.js';
import { Learning } from '../modules/learning.js';

test('schema enforces cross-space ownership and atomically rolls back incomplete routes', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare('INSERT INTO spaces VALUES (?,?,?)').run('a', 'Rust', 1);
    db.prepare('INSERT INTO spaces VALUES (?,?,?)').run('b', 'Python', 2);
    db.prepare('INSERT INTO units(space_id,id) VALUES (?,?)').run('a', 'u1');
    db.prepare('INSERT INTO units(space_id,id) VALUES (?,?)').run('b', 'u2');
    const session = db.prepare('INSERT INTO sessions(space_id,id,scope,unit_id,title) VALUES (?,?,?,?,?)');
    session.run('a', 'sa', 'unit', 'u1', 'A');
    session.run('b', 'sb', 'unit', 'u2', 'B');
    assert.throws(() => session.run('a', 'wrong', 'unit', 'u2', 'Wrong'), /FOREIGN KEY/);
    assert.throws(() => session.run('b', 'missing', 'unit', 'absent', 'Missing'), /FOREIGN KEY/);
    assert.throws(() => db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run('a', 'sb', 'm', 'user', 'wrong', null, 1), /FOREIGN KEY/);
    assert.throws(() => db.transaction(() => {
      db.prepare('INSERT INTO routes(space_id,revision,content) VALUES (?,0,?)').run('a', '{"note":"incomplete"}');
      db.prepare('INSERT INTO units(space_id,id) VALUES (?,?)').run('a', 'u3');
      session.run('a', 'invalid', 'unit', 'missing', 'Broken');
    })(), /FOREIGN KEY/);
    assert.equal(db.prepare('SELECT * FROM routes').all().length, 0);
    assert.equal(db.prepare("SELECT * FROM units WHERE id='u3'").all().length, 0);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally { db.close(); }
});

test('public request schemas reject invalid scopes, absent fields and leaked internal fields', () => {
  assert.equal(createSessionSchema.safeParse({ scope: 'unit', unitId: null, title: 'x' }).success, false);
  assert.equal(createSessionSchema.safeParse({ scope: 'route', unitId: randomUUID(), title: 'x' }).success, false);
  assert.equal(saveRequirementSchema.safeParse({ revision: 0, confirmed: false, value: { goal: 'x' } }).success, false);
  assert.equal(routeContentSchema.safeParse({ note: '', stages: [], piState: {} }).success, false);
  assert.equal(createSessionSchema.safeParse({ scope: 'intake', unitId: null, title: '需求' }).success, true);
});

test('migration 11 preserves each frozen baseline and document pin while moving old technical metadata into plain answers', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  migrate(db, migrations.slice(0, 10));
  const space = randomUUID(), session = randomUUID(), run = randomUUID(), task = randomUUID(), document = randomUUID();
  const researchRef = { id: document, revision: 2 };
  const target = { kind: 'technology', name: 'Cedar <边界>', version: '4.7.2', scope: '  分块解析\r\n' };
  const intake = { target, researchRef };
  const current = { goal: '现在想整理账本', background: '', outcome: '保留损坏记录', schedule: '周五 50 分钟' };
  const original = { revision: 3, confirmed: false, value: { goal: '  原来想写解析器\r\n', background: '会循环', outcome: '', schedule: '' }, intake };
  const research = { id: document, revision: 2, target, content: '\r\n# 旧调研\r\n\r\n资料正文原样保留。\r\n', hash: 'existing-hash', runId: run, createdAt: 71 };
  const frozen = { requirement: original, route: { revision: 2, intake, content: null }, research,
    submitted: { text: '原问题不能变', quote: null }, references: [{ source: 'code', label: 'sample.ts', text: 'const a = 17;' }] };
  try {
    db.prepare('INSERT INTO spaces VALUES (?,?,?)').run(space, '旧内容', 19);
    db.prepare('INSERT INTO requirements VALUES (?,8,1,?,?)').run(space, JSON.stringify(current), JSON.stringify(intake));
    db.prepare('INSERT INTO routes VALUES (?,2,NULL,?)').run(space, JSON.stringify(intake));
    db.prepare("INSERT INTO sessions(space_id,id,scope,title) VALUES (?,?,'intake','旧会话')").run(space, session);
    db.prepare("INSERT INTO runs VALUES (?,?,NULL,?,'intake','failed')").run(space, run, session);
    db.prepare('INSERT INTO agent_runs VALUES (?,?,?,NULL,0,23)').run(space, run, JSON.stringify(frozen));
    db.prepare("INSERT INTO tasks VALUES (?,?,NULL,NULL,'lesson','failed')").run(space, task);
    db.prepare('INSERT INTO task_runs VALUES (?,?,?,NULL,0,29)').run(space, task, JSON.stringify(frozen));
    db.prepare('INSERT INTO research_dossiers VALUES (?,?,?,?,?)').run(space, document, 2, run, JSON.stringify(research));
    for (const [id, value] of [['empty', { goal: '', background: '', outcome: '', schedule: '' }], ['new', { rows: [{ question: '新的问题', answer: '新的内容' }] }]] as const) {
      db.prepare('INSERT INTO spaces VALUES (?,?,?)').run(id, id, 31);
      db.prepare('INSERT INTO requirements VALUES (?,0,0,?,NULL)').run(id, JSON.stringify(value));
    }
    migrate(db, migrations.slice(0, 11));
    const read = (table: string, id: string, column: string) => JSON.parse((db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${table === 'requirements' || table === 'routes' ? 'space_id' : 'id'}=?`).get(id) as { value: string }).value);
    assert.equal(db.pragma('user_version', { simple: true }), 11);
    assert.deepEqual(read('requirements', space, 'value'), { rows: [
      { question: '学习目标', answer: '现在想整理账本' }, { question: '期望达成', answer: '保留损坏记录' },
      { question: '时间安排', answer: '周五 50 分钟' }, { question: '学习对象', answer: 'Cedar <边界>' },
      { question: '适用版本', answer: '4.7.2' }, { question: '学习范围', answer: '  分块解析\r\n' },
    ] });
    const rows = [
      { question: '学习目标', answer: '  原来想写解析器\r\n' }, { question: '已有基础', answer: '会循环' },
      { question: '学习对象', answer: 'Cedar <边界>' }, { question: '适用版本', answer: '4.7.2' },
      { question: '学习范围', answer: '  分块解析\r\n' },
    ];
    const { target: _target, ...documentValue } = research;
    for (const [table, id] of [['agent_runs', run], ['task_runs', task]]) assert.deepEqual(read(table!, id!, 'input'), {
      ...frozen, requirement: { ...original, value: { rows }, intake: { researchRef } },
      route: { ...frozen.route, intake: { researchRef } }, research: documentValue,
    });
    assert.deepEqual(read('research_dossiers', document, 'value'), documentValue);
    assert.deepEqual(read('requirements', 'empty', 'value'), { rows: [] });
    assert.deepEqual(read('requirements', 'new', 'value'), { rows: [{ question: '新的问题', answer: '新的内容' }] });
    assert.deepEqual(read('requirements', space, 'intake'), { researchRef });
    assert.deepEqual(read('routes', space, 'intake'), { researchRef });
    assert.deepEqual(db.prepare('SELECT revision,confirmed FROM requirements WHERE space_id=?').get(space), { revision: 8, confirmed: 1 });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const before = db.prepare('SELECT * FROM agent_runs').all();
    migrate(db, migrations.slice(0, 11));
    assert.deepEqual(db.prepare('SELECT * FROM agent_runs').all(), before);
  } finally { db.close(); }
});

test('migration 12 preserves proposal history and applied routes, keeps only the latest matching pending per space, and enforces terminal states', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  migrate(db, migrations.slice(0, 11));
  const spaces = [randomUUID(), randomUUID(), randomUUID()], sessions = spaces.map(() => randomUUID());
  const content = JSON.stringify({ note: '  Historical rationale\r\n', stages: [{ id: randomUUID(), title: 'Stage',
    units: [{ id: randomUUID(), title: 'Unit', summary: 'Exact history', goals: ['Original goal'] }] }] });
  const intake = '{"researchRef":null}';
  const insert = db.prepare('INSERT INTO proposals(space_id,id,session_id,base_revision,requirement_revision,content,intake,state) VALUES (?,?,?,?,?,?,?,?)');
  const add = (index: number, route: number, requirement: number | null, state = 'pending') => {
    const id = randomUUID();
    insert.run(spaces[index], id, sessions[index], route, requirement, content, intake, state);
    return id;
  };
  try {
    for (const [index, space] of spaces.entries()) {
      db.prepare('INSERT INTO spaces VALUES (?,?,?)').run(space, `Legacy ${index}`, index);
      db.prepare('INSERT INTO requirements VALUES (?,7,1,?,?)').run(space, '{"rows":[{"question":"Goal?","answer":"Learn"}]}', intake);
      db.prepare('INSERT INTO routes VALUES (?,3,?,?)').run(space, content, intake);
      db.prepare("INSERT INTO sessions(space_id,id,scope,title) VALUES (?,?,'route','Route')").run(space, sessions[index]);
    }
    const applied = add(0, 0, 1, 'applied');
    const older = add(0, 3, 7), latest = add(0, 3, 7);
    const staleRoute = add(0, 2, 7), staleRequirement = add(0, 3, 6), missingRequirement = add(0, 3, null);
    const otherLatest = add(1, 3, 7);
    const allStale = add(2, 0, 7);
    const before = db.prepare('SELECT * FROM proposals ORDER BY rowid').all() as Record<string, unknown>[];
    const routes = db.prepare('SELECT * FROM routes ORDER BY rowid').all();
    assert.throws(() => migrate(db, [...migrations.slice(0, 11), `${migrations[11]}\nSELECT * FROM injected_missing_table;`]), /migration 12 failed/);
    assert.equal(db.pragma('user_version', { simple: true }), 11);
    assert.deepEqual(db.prepare('SELECT * FROM proposals ORDER BY rowid').all(), before, 'Failed rebuild must preserve all old rows and schema.');
    migrate(db);
    assert.equal(db.pragma('user_version', { simple: true }), 12);
    assert.deepEqual(db.prepare('SELECT * FROM routes ORDER BY rowid').all(), routes);
    const after = db.prepare('SELECT * FROM proposals ORDER BY rowid').all();
    assert.deepEqual(after, before.map((row) => ({ ...row, state: row.id === applied ? 'applied'
      : new Set<string>([latest, otherLatest]).has(row.id as string) ? 'pending' : 'superseded', run_id: null, feedback: '' })));
    const learning = new Learning(db);
    for (const id of [older, staleRoute, staleRequirement, missingRequirement, allStale]) {
      const space = id === allStale ? spaces[2]! : spaces[0]!;
      assert.throws(() => learning.applyProposal(space, id), /已经结束/);
      assert.throws(() => learning.rejectProposal(space, id, {}), /已经结束/);
    }
    assert.equal(learning.space(spaces[0]!).proposals.find((proposal) => proposal.id === latest)!.state, 'pending');
    assert.throws(() => add(0, 3, 7), /UNIQUE constraint/);
    learning.rejectProposal(spaces[0]!, latest, { feedback: 'Saved after upgrade' });
    learning.rejectProposal(spaces[0]!, latest, { feedback: 'Saved after upgrade' });
    assert.throws(() => learning.applyProposal(spaces[0]!, latest), /已经结束/);
    assert.doesNotThrow(() => add(0, 3, 7), 'Terminal decisions release the unique pending slot.');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const stable = db.prepare('SELECT * FROM proposals ORDER BY rowid').all();
    migrate(db);
    assert.deepEqual(db.prepare('SELECT * FROM proposals ORDER BY rowid').all(), stable);
    assert.equal(learning.space(spaces[0]!).proposals.find((proposal) => proposal.id === applied)!.state, 'applied');
  } finally { db.close(); }
});
