import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadModelConfig } from './model.js';

test('server dotenv loading is private, environment overrides it, and missing config fails explicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teach-me-coding-config-'));
  const path = join(dir, '.env');
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    await writeFile(path, 'OPENROUTER_API_KEY=synthetic-file-key\nOPENROUTER_MODEL=exact/model-id\n');
    assert.deepEqual(loadModelConfig({}, path), { apiKey: 'synthetic-file-key', model: 'exact/model-id' });
    assert.deepEqual(loadModelConfig({ OPENROUTER_API_KEY: 'override-key', OPENROUTER_MODEL: 'other/exact-id' }, path), {
      apiKey: 'override-key', model: 'other/exact-id',
    });
    assert.equal(process.env.OPENROUTER_API_KEY, previous);
    assert.throws(() => loadModelConfig({}, join(dir, 'missing')), /Set OPENROUTER_API_KEY/);
    assert.throws(() => loadModelConfig({ OPENROUTER_API_KEY: 'key' }, join(dir, 'missing')), /Set OPENROUTER_MODEL/);
    assert.throws(() => loadModelConfig({ OPENROUTER_API_KEY: '' }, path), /Set OPENROUTER_API_KEY/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
