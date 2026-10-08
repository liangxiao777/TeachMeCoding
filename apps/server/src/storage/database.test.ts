import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSessionSchema, routeContentSchema, saveRequirementSchema } from '@teach-me-coding/contracts';
import { openDatabase } from './database.js';

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
