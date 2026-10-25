import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Credential } from '@earendil-works/pi-ai';
import { FileCredentialStore } from './credentials.js';

const apiKey: Credential = { type: 'api_key', key: 'synthetic-key' };
const oauth: Credential = { type: 'oauth', access: 'a', refresh: 'r', expires: 0 };

function dir() {
  return mkdtempSync(join(tmpdir(), 'tmc-credentials-'));
}

test('credentials round-trip through one private file and list hides secrets', async () => {
  const root = dir(), path = join(root, 'credentials.json');
  try {
    const store = new FileCredentialStore(path);
    assert.equal(await store.read('openrouter'), undefined);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.modify('openrouter', async (current) => (assert.equal(current, undefined), apiKey)), apiKey);
    assert.equal((await store.read('openrouter'))?.type, 'api_key');
    assert.equal(await store.modify('anthropic', async () => oauth), oauth);
    assert.deepEqual((await store.list()).map((c) => c.providerId).sort(), ['anthropic', 'openrouter']);
    assert.ok(!JSON.stringify(await store.list()).includes('synthetic-key'));
    if (process.platform !== 'win32') assert.equal(lstatSync(path).mode & 0o777, 0o600);
    // A fresh store instance over the same file sees every credential.
    assert.equal((await new FileCredentialStore(path).read('anthropic'))?.type, 'oauth');
    // modify returning undefined leaves the entry unchanged.
    assert.equal((await store.modify('openrouter', async () => undefined))?.type, 'api_key');
    await store.delete('openrouter');
    assert.equal(await store.read('openrouter'), undefined);
    await store.delete('missing'); // deleting an absent credential is a no-op.
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('serialized modify calls observe each other and the file stays valid', async () => {
  const root = dir(), path = join(root, 'credentials.json');
  try {
    const store = new FileCredentialStore(path);
    let inside = 0;
    await Promise.all(['a', 'b', 'c'].map((id) => store.modify(id, async () => {
      inside++;
      const token = { type: 'api_key', key: id } as Credential;
      assert.equal(inside, 1, 'modify callbacks must not interleave');
      inside--;
      return token;
    })));
    assert.equal((await store.list()).length, 3);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
    // One failing modify does not poison the chain.
    await assert.rejects(store.modify('x', async () => { throw new Error('synthetic failure'); }));
    assert.equal((await store.modify('d', async () => apiKey))?.type, 'api_key');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the store refuses corrupt files and anything that is not a regular file', async () => {
  const root = dir();
  try {
    const corrupt = join(root, 'corrupt.json');
    writeFileSync(corrupt, 'not json', { mode: 0o600 });
    await assert.rejects(new FileCredentialStore(corrupt).list(), /Unsupported|JSON|regular file/);
    const foreign = join(root, 'foreign.json');
    writeFileSync(foreign, JSON.stringify({ version: 9, credentials: {} }), { mode: 0o600 });
    await assert.rejects(new FileCredentialStore(foreign).list());
    const link = join(root, 'link.json');
    symlinkSync(foreign, link);
    await assert.rejects(new FileCredentialStore(link).list(), /regular file/);
    const nested = join(root, 'sub', 'credentials.json');
    mkdirSync(join(root, 'sub'));
    const store = new FileCredentialStore(nested);
    await store.modify('openrouter', async () => apiKey);
    assert.equal((await store.read('openrouter'))?.type, 'api_key');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
