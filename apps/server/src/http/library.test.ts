import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { libraryFileLimit, type LibraryDocument } from '@teach-me-coding/contracts';
import { Library } from '../modules/library.js';
import { BusinessError, Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';
import { createApp } from './app.js';
import { createLocalAccess } from './local-access.js';

test('global arbitrary-format uploads preserve bytes, names and retries across restart; downloads are attachments', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-library-')), db = openDatabase(join(root, 'app.db'));
  const learning = new Learning(db), access = createLocalAccess({ port: 14333 });
  let library = new Library(root);
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token };
  const app = () => createApp(access, learning, undefined, undefined, undefined, undefined, undefined, undefined, library);
  const upload = (name: string, bytes: Buffer, id = randomUUID(), extra = {}) => app().request(`/api/library/files?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': id, ...extra }, body: Uint8Array.from(bytes).buffer,
  });
  const post = (path: string, body: unknown) => app().request(`/api/library${path}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    const a = learning.create({ name: 'A', goal: 'A' }), b = learning.create({ name: 'B', goal: 'B' });
    const id = randomUUID(), bytes = Buffer.from([0, 255, 1, 128, 13, 10]);
    assert.equal((await upload('binary.未知格式', bytes, id, { 'X-TMC-Token': '' })).status, 401);
    assert.equal((await upload('binary.未知格式', bytes, id, { Origin: 'http://evil.test' })).status, 403);
    for (const name of ['../escape', 'folder/file.txt', 'back\\slash', '.', '..', 'bad\nname', '学'.repeat(86)]) {
      const invalid = await upload(name, bytes);
      assert.equal(invalid.status, 400, name);
      assert.deepEqual(await invalid.json(), { code: 'INVALID_LIBRARY_REQUEST' });
    }
    const first = await upload('资料.未知格式', bytes, id);
    assert.equal(first.status, 201);
    const file = await first.json() as LibraryDocument;
    const concurrent = await Promise.all([upload(file.name, bytes, id), upload(file.name, bytes, id)]);
    for (const response of concurrent) assert.deepEqual(await response.json(), file);
    const conflict = await upload(file.name, Buffer.from('different'), id);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { code: 'LIBRARY_UPLOAD_CONFLICT' });
    assert.equal((await upload('other.bin', bytes, id)).status, 409);
    const duplicateName = await (await upload(file.name, Buffer.from('same name, different file'))).json() as LibraryDocument;
    const html = Buffer.from('<script>window.privateData = true</script>');
    const htmlFile = await (await upload('网页.html', html)).json() as LibraryDocument;
    assert.equal((await upload('empty', Buffer.alloc(0))).status, 201);
    assert.equal(library.state().files.length, 4);
    assert.deepEqual(learning.space(a.id), a); assert.deepEqual(learning.space(b.id), b);
    for (const [saved, content] of [[file, bytes], [htmlFile, html]] as const) {
      const download = await app().request(`/api/library/files/${saved.id}`, { headers });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('Content-Type'), 'application/octet-stream');
      assert.match(download.headers.get('Content-Disposition')!, /attachment;.*filename\*=UTF-8''/);
      assert.equal(download.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
    }
    const before = library.state(); await library.close(); library = new Library(root);
    assert.deepEqual(library.state(), before);
    assert.deepEqual(await (await upload(file.name, bytes, id)).json(), file);
    const deleted = await post(`/files/${file.id}/delete`, {});
    assert.equal(deleted.status, 200);
    assert.equal((await post(`/files/${file.id}/delete`, {})).status, 200, 'Retrying a lost delete response must succeed.');
    const missing = await app().request(`/api/library/files/${file.id}`, { headers });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { code: 'LIBRARY_FILE_NOT_FOUND' });
    assert.equal(library.get(duplicateName.id).name, file.name);
    assert.deepEqual(readFileSync(duplicateName.path), Buffer.from('same name, different file'));
    const outside = join(root, 'app.db'); unlinkSync(duplicateName.path); symlinkSync(outside, duplicateName.path);
    const unsafe = await app().request(`/api/library/files/${duplicateName.id}`, { headers });
    assert.equal(unsafe.status, 422);
    assert.deepEqual(await unsafe.json(), { code: 'LIBRARY_UNSAFE_PATH' });
    assert.equal((await post(`/files/${duplicateName.id}/delete`, {})).status, 422);
    assert.ok(readFileSync(outside).length > 0);
  } finally { await library.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('streamed size boundary and cancellation never publish partial documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-library-limit-')), library = new Library(root);
  const body = (length: number) => {
    let remaining = length;
    return new ReadableStream<Uint8Array>({ pull(controller) {
      if (!remaining) { controller.close(); return; }
      const count = Math.min(remaining, 1024 * 1024); remaining -= count;
      controller.enqueue(new Uint8Array(count));
    } });
  };
  try {
    const signal = new AbortController().signal;
    const file = await library.upload(randomUUID(), 'at-limit.bin', body(libraryFileLimit), signal);
    assert.equal(file.size, libraryFileLimit);
    await assert.rejects(library.upload(randomUUID(), 'too-large.bin', body(libraryFileLimit + 1), signal), (error) => {
      assert.ok(error instanceof BusinessError);
      assert.equal(error.status, 413);
      assert.deepEqual(error.toResponse(), { code: 'LIBRARY_FILE_TOO_LARGE' });
      return true;
    });
    const controller = new AbortController();
    const held = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array([1, 2, 3])); } });
    const pending = library.upload(randomUUID(), 'partial.pdf', held, controller.signal);
    assert.deepEqual(library.state().files.map((f) => f.name), ['at-limit.bin']);
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    assert.deepEqual(readdirSync(library.directory), [file.id]);
  } finally { await library.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an unavailable library does not block saved spaces or unrelated APIs', async () => {
  const db = openDatabase(':memory:'), learning = new Learning(db), access = createLocalAccess({ port: 14333 });
  const app = createApp(access, learning), headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token };
  try {
    const space = learning.create({ name: 'Saved', goal: 'Preserve me' });
    const unavailable = await app.request('/api/library', { headers });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { code: 'LIBRARY_UNAVAILABLE' });
    assert.equal((await app.request('/api/library/files/missing', { headers })).status, 503);
    assert.equal((await app.request('/api/spaces', { headers })).status, 200);
    assert.deepEqual(await (await app.request(`/api/spaces/${space.id}`, { headers })).json(), space);
    assert.equal((await app.request('/api/missing', { headers })).status, 404);
  } finally { db.close(); }
});

test('library error responses project safe business details and hide unexpected failures', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-library-errors-')), library = new Library(root);
  const access = createLocalAccess({ port: 14333 });
  const app = createApp(access, undefined, undefined, undefined, undefined, undefined, undefined, undefined, library);
  const headers = { Host: '127.0.0.1:14333', 'X-TMC-Token': access.token };
  try {
    for (const [error, status, body] of [
      [new BusinessError(409, { code: 'LIBRARY_UPLOAD_CONFLICT' }), 409, { code: 'LIBRARY_UPLOAD_CONFLICT' }],
      [new Error('private file path and content'), 503, { code: 'LIBRARY_STORAGE_UNAVAILABLE' }],
    ] as const) {
      Object.assign(error, { cause: new Error('private upstream payload') });
      const mock = t.mock.method(library, 'state', () => { throw error; });
      const response = await app.request('/api/library', { headers });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), body);
      mock.mock.restore();
    }
    const oversized = await app.request('/api/library/files', { method: 'POST', headers: { ...headers, 'Content-Length': String(libraryFileLimit + 1) }, body: '' });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { code: 'LIBRARY_FILE_TOO_LARGE' });
  } finally { await library.close(); rmSync(root, { recursive: true, force: true }); }
});
