import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDataDirectory } from '../storage/data-directory.js';
import { Learning } from '../modules/learning.js';
import { FileCredentialStore } from '../models/credentials.js';
import { openSavedModel } from './saved-model.js';

test('paid checks obey the instance lock, restore saved choices and never run business recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-saved-model-')), data = openDataDirectory(root);
  const selection = { provider: 'openrouter', model: 'stealth/space-bunny-alpha', thinkingLevel: 'low' };
  try {
    data.db.prepare("INSERT INTO app_settings VALUES ('model', ?)").run(JSON.stringify(selection));
    const space = new Learning(data.db).create({ name: 'Preserve', goal: 'Do not recover a real run during a provider check.' });
    data.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)').run(space.id, randomUUID(), null, space.sessions[0]!.id, 'intake', 'running');
    await new FileCredentialStore(join(root, 'credentials.json')).modify('openrouter', async () => ({ type: 'api_key', key: 'synthetic-saved-key' }));
    await assert.rejects(openSavedModel(root), /Stop the instance/);
    data.close();
    const before = readFileSync(join(root, 'app.db'));
    const saved = await openSavedModel(root);
    try {
      assert.deepEqual(saved.selection, selection);
      assert.equal((await saved.models.models.getAuth(saved.model))?.auth.apiKey, 'synthetic-saved-key');
      await assert.rejects(openSavedModel(root), /Stop the instance/);
      assert.throws(() => openDataDirectory(root), /already in use/);
    } finally { saved.close(); }
    assert.deepEqual(readFileSync(join(root, 'app.db')), before);
    const again = await openSavedModel(root); again.close();
  } finally { data.close(); rmSync(root, { recursive: true, force: true }); }
});
