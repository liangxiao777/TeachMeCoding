import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultModel, serverEnvironment } from './model.js';

test('server dotenv loading is private, environment overrides it, and the fallback model stays explicit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teach-me-coding-config-'));
  const path = join(dir, '.env');
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    await writeFile(path, 'OPENROUTER_API_KEY=synthetic-file-key\nOPENROUTER_MODEL=exact/model-id\n');
    const env = serverEnvironment({}, path);
    assert.equal(env('OPENROUTER_API_KEY'), 'synthetic-file-key');
    assert.deepEqual(defaultModel(env), { provider: 'openrouter', model: 'exact/model-id' });
    const override = serverEnvironment({ OPENROUTER_API_KEY: 'override-key', OPENROUTER_MODEL: 'other/exact-id' }, path);
    assert.equal(override('OPENROUTER_API_KEY'), 'override-key');
    assert.equal(override('OPENROUTER_MODEL'), 'other/exact-id');
    assert.equal(process.env.OPENROUTER_API_KEY, previous);
    // A variable present in the server environment wins even when empty, so
    // tests can disable providers that the root .env configures.
    assert.equal(serverEnvironment({ OPENROUTER_API_KEY: '' }, path)('OPENROUTER_API_KEY'), undefined);
    assert.equal(defaultModel(serverEnvironment({ OPENROUTER_MODEL: '' }, path)), null);
    assert.equal(defaultModel(serverEnvironment({}, join(dir, 'missing'))), null);
    assert.equal(serverEnvironment({}, join(dir, 'missing'))('OPENROUTER_API_KEY'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
