import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SearchProvider } from '@teach-me-coding/contracts';
import { SearchService } from './search.js';
import { TeachingRuntime } from '../agents/runtime.js';
import { reply, response, teachingModel } from '../agents/test-support.js';
import { Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';

function fixture(request: typeof fetch = async () => { throw new Error('Unexpected network request'); }, env = (_name: string): string | undefined => undefined) {
  const root = mkdtempSync(join(tmpdir(), 'tmc-search-')), path = join(root, 'search.json');
  const service = new SearchService(path, { env, fetch: request });
  return { service, root, path, close() { service.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('search defaults off, keeps provider-specific credentials, and writes a private recoverable configuration', () => {
  const { service, root, path, close } = fixture();
  try {
    assert.equal(service.settings().enabled, false); assert.deepEqual(service.tools(), []);
    service.save({ enabled: true }); assert.deepEqual(service.tools(), [], 'missing credentials must not advertise a usable tool');
    service.save({ apiKey: '  synthetic-brave-secret  ' });
    assert.equal(service.tools().length, 1);
    service.save({ provider: 'tavily', apiKey: 'synthetic-tavily-secret' });
    service.save({ enabled: false }); service.save({ provider: 'brave', apiKey: '' });
    assert.deepEqual(service.tools(), []);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { enabled: false, provider: 'brave',
      apiKeys: { brave: 'synthetic-brave-secret', tavily: 'synthetic-tavily-secret' } });
    const reopened = new SearchService(path, { env: () => undefined });
    assert.deepEqual(reopened.settings(), service.settings()); reopened.close();
    assert.doesNotMatch(JSON.stringify(service.settings()), /synthetic-.*-secret/);
    for (const invalid of [{}, { provider: 'unknown' }, { enabled: 'true' }, { apiKey: 'bad\nheader' }, { apiKey: null }, { enabled: true, extra: 1 }]) {
      assert.throws(() => service.save(invalid));
    }
    const before = readFileSync(path, 'utf8');
    mkdirSync(`${path}.tmp`);
    assert.throws(() => service.save({ enabled: true, apiKey: 'failed-write-secret' }));
    assert.equal(service.settings().enabled, false); assert.equal(readFileSync(path, 'utf8'), before);
    rmSync(`${path}.tmp`, { recursive: true });
    writeFileSync(join(root, 'invalid.json'), '{broken');
    assert.throws(() => new SearchService(join(root, 'invalid.json'), { env: () => undefined }));
    assert.equal(readFileSync(join(root, 'invalid.json'), 'utf8'), '{broken');
    symlinkSync(path, join(root, 'linked.json'));
    assert.throws(() => new SearchService(join(root, 'linked.json'), { env: () => undefined }), /regular file/);
  } finally { close(); }
});

test('environment credentials remain private, saved keys take precedence, and selecting a missing key never falls back', async () => {
  const keys: string[] = [];
  const { service, close } = fixture(async (_url, options) => {
    keys.push(new Headers(options?.headers).get('x-api-key')!); return Response.json({ results: [] });
  }, (name) => name === 'EXA_API_KEY' ? 'synthetic-env-secret' : name === 'OPENROUTER_API_KEY' ? 'private-model-secret' : undefined);
  try {
    assert.equal(service.settings().providers.find((entry) => entry.id === 'exa')?.configured, 'environment');
    service.save({ provider: 'exa' });
    await service.test({ query: 'documentation' });
    assert.equal(service.settings().enabled, false, 'manual testing must not enable Agent search');
    service.save({ apiKey: 'synthetic-saved-secret' }); await service.test({ query: 'documentation' });
    assert.deepEqual(keys, ['synthetic-env-secret', 'synthetic-saved-secret']);
    service.save({ provider: 'tavily', enabled: true });
    assert.deepEqual(service.tools(), []);
    assert.throws(() => service.test({ query: 'documentation' }), /API Key/);
    assert.equal(keys.length, 2); assert.doesNotMatch(JSON.stringify(service.settings()), /secret/);
  } finally { close(); }
});

for (const provider of ['brave', 'tavily', 'exa'] as const) {
  test(`${provider} uses its documented endpoint/auth, preserves rank, filters unsafe URLs and bounds snippets`, async () => {
    const query = 'Rust 中文 C++', first = 'https://doc.rust-lang.org/book/?chapter=4&language=zh', second = 'https://example.org/ownership';
    let calls = 0;
    const { service, close } = fixture(async (input, options) => {
      calls++;
      const url = new URL(String(input)), headers = Object.fromEntries(new Headers(options?.headers));
      assert.equal(options?.redirect, 'error'); assert.ok(options?.signal);
      if (provider === 'brave') {
        assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
        assert.deepEqual(Object.fromEntries(url.searchParams), { q: query, count: '2', result_filter: 'web', text_decorations: 'false' });
        assert.equal(options?.method, 'GET'); assert.equal(options.body, undefined);
        assert.deepEqual(headers, { accept: 'application/json', 'x-subscription-token': 'synthetic-brave-secret' });
      } else {
        assert.equal(options?.method, 'POST');
        assert.equal(url.href, provider === 'tavily' ? 'https://api.tavily.com/search' : 'https://api.exa.ai/search');
        assert.deepEqual(headers, provider === 'tavily'
          ? { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer synthetic-tavily-secret' }
          : { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': 'synthetic-exa-secret' });
        assert.deepEqual(JSON.parse(String(options.body)), provider === 'tavily' ? { query, max_results: 2 }
          : { query, numResults: 2, type: 'auto', contents: { highlights: true } });
      }
      const entries = [
        { title: 'unsafe', url: 'javascript:alert(1)' },
        { title: 'credentials', url: 'https://user:password@example.org/' },
        { title: '  The Rust Book  ', url: first },
        { title: '', url: second },
        { title: 'beyond count', url: 'https://unused.example/' },
      ];
      return Response.json(provider === 'brave' ? { type: 'search', query: { original: query },
        web: { results: entries.map((value) => ({ ...value, description: 'Borrowing & lifetimes'.repeat(120) })) } }
        : provider === 'tavily' ? { results: entries.map((value) => ({ ...value, content: 'Ownership guide'.repeat(160) })) }
          : { results: entries.map((value) => ({ ...value, highlights: [' ', ' Borrowing ', ' Lifetimes '], summary: 'Summary must not win', text: 'Full text must not win' })) });
    });
    try {
      service.save({ provider, apiKey: `synthetic-${provider}-secret`, enabled: true });
      const result = await service.test({ query: `  ${query}  `, count: 2 });
      assert.equal(calls, 1); assert.equal(result.provider, provider); assert.equal(result.query, query); assert.equal(result.untrusted, true);
      assert.ok(result.tookMs >= 0);
      const snippet = provider === 'brave' ? 'Borrowing & lifetimes'.repeat(120).slice(0, 2000)
        : provider === 'tavily' ? 'Ownership guide'.repeat(160).slice(0, 2000) : 'Borrowing\nLifetimes';
      assert.deepEqual(result.results, [{ title: 'The Rust Book', url: first, snippet }, { title: 'example.org', url: second, snippet }]);
    } finally { close(); }
  });
}

test('Brave accepts documented empty responses without web, but never mistakes broken responses for empty results', async () => {
  let payload: unknown;
  const { service, close } = fixture(async () => Response.json(payload));
  try {
    service.save({ apiKey: 'synthetic-brave-secret' });
    for (const web of [undefined, null, { results: [] }]) {
      payload = { type: 'search', query: { original: 'docs' }, ...(web === undefined ? {} : { web }) };
      assert.deepEqual((await service.test({ query: 'docs' })).results, []);
    }
    for (const value of [{}, { type: 'error', query: { original: 'docs' } }, { type: 'search' },
      { type: 'search', query: { original: 'docs' }, web: {} }, { type: 'search', query: { original: 'docs' }, web: { results: 'broken' } }]) {
      payload = value; await assert.rejects(service.test({ query: 'docs' }), /有效搜索结果/);
    }
  } finally { close(); }
});

test('Brave enforces both its character and word limits before making a request', async () => {
  const queries: string[] = [];
  const { service, close } = fixture(async (url) => {
    const original = new URL(String(url)).searchParams.get('q')!; queries.push(original);
    return Response.json({ type: 'search', query: { original }, web: { results: [] } });
  });
  try {
    service.save({ apiKey: 'synthetic-brave-secret' });
    await service.test({ query: 'x'.repeat(600) }); await service.test({ query: Array(75).fill('x').join(' ') });
    for (const query of ['x'.repeat(601), Array(76).fill('x').join(' ')]) assert.throws(() => service.test({ query }), /600.*75/);
    assert.deepEqual(queries, ['x'.repeat(600), Array(75).fill('x').join(' ')]);
  } finally { close(); }
});

test('Exa falls back from empty highlights to summary/text, and result counts have one 1–10 policy', async () => {
  let calls = 0;
  const { service, close } = fixture(async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options?.body)); assert.equal(body.numResults, calls === 1 ? 5 : calls === 2 ? 1 : 10);
    return Response.json({ results: [
      { url: 'https://summary.example/', highlights: [], summary: 'Summary evidence', text: 'Different full text' },
      { url: 'https://text.example/', highlights: [' '], summary: '', text: 'Text evidence' },
    ] });
  });
  try {
    service.save({ provider: 'exa', apiKey: 'synthetic-exa-secret' });
    const result = await service.test({ query: 'docs' });
    assert.deepEqual(result.results.map((entry) => entry.snippet), ['Summary evidence', 'Text evidence']);
    assert.equal((await service.test({ query: 'docs', count: 1 })).results.length, 1);
    assert.equal((await service.test({ query: 'docs', count: 10 })).results.length, 2);
    for (const input of [{ query: ' ' }, { query: 'x'.repeat(1001) }, { query: 'docs', count: 0 }, { query: 'docs', count: 11 },
      { query: 'docs', count: 1.5 }, { query: 'docs', provider: 'brave' }]) assert.throws(() => service.test(input));
    assert.equal(calls, 3);
  } finally { close(); }
});

test('empty results succeed but malformed/error/oversize responses fail safely without retry or reflected secrets', async () => {
  let payload = Response.json({ results: [] }), calls = 0;
  const { service, close } = fixture(async () => { calls++; return payload; });
  try {
    service.save({ provider: 'tavily', apiKey: 'synthetic-private-secret' });
    assert.deepEqual((await service.test({ query: 'docs' })).results, []);
    for (const status of [401, 403, 429, 502]) {
      payload = new Response('synthetic-private-secret upstream diagnostics', { status });
      await assert.rejects(service.test({ query: 'docs' }), (error: Error) => {
        assert.doesNotMatch(error.message, /synthetic-private-secret|diagnostics/);
        assert.match(error.message, status === 401 || status === 403 ? /认证/ : status === 429 ? /额度/ : /不可用/); return true;
      });
    }
    for (const value of ['not JSON synthetic-private-secret', '{"unexpected":"synthetic-private-secret"}']) {
      payload = new Response(value); await assert.rejects(service.test({ query: 'docs' }), /有效搜索结果/);
    }
    const json = '{"results":[]}';
    payload = new Response(json + ' '.repeat(1024 * 1024 - json.length));
    assert.deepEqual((await service.test({ query: 'docs' })).results, [], 'exactly 1 MiB is accepted');
    payload = new Response(json + ' '.repeat(1024 * 1024 + 1 - json.length));
    await assert.rejects(service.test({ query: 'docs' }), /有效搜索结果/);
    assert.equal(calls, 9, 'no automatic retries or provider fallback');
  } finally { close(); }
});

test('deadline and already-aborted requests never call the network', async (t) => {
  let calls = 0;
  const { service, close } = fixture(async () => { calls++; return Response.json({ results: [] }); });
  try {
    service.save({ provider: 'tavily', apiKey: 'synthetic-key' });
    t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      assert.equal(milliseconds, 30_000); return AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
    });
    await assert.rejects(service.test({ query: 'docs' }), /超时/); t.mock.restoreAll();
    await assert.rejects(service.test({ query: 'docs' }, AbortSignal.abort()), /取消/);
    assert.equal(calls, 0);
  } finally { t.mock.restoreAll(); close(); }
});

test('disable, shutdown and parent cancellation abort active Agent searches; disabled old tools cannot call again', async () => {
  for (const action of ['disable', 'shutdown', 'parent'] as const) {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const { service, close } = fixture(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('reflected synthetic-private-secret')), { once: true }); entered();
    }));
    try {
      service.save({ provider: 'tavily', apiKey: 'synthetic-private-secret', enabled: true });
      const tool = service.tools()[0]!, controller = new AbortController();
      const pending = tool.execute('cancel', { query: 'docs' }, controller.signal); await ready;
      if (action === 'disable') service.save({ enabled: false }); else if (action === 'shutdown') service.close(); else controller.abort();
      await assert.rejects(pending, /取消/);
      if (action === 'disable') { assert.deepEqual(service.tools(), []); await assert.rejects(tool.execute('later', { query: 'docs' }), /关闭/); }
    } finally { close(); }
  }
});

test('running tools keep their selected provider/key; new runs receive updated configuration', async () => {
  const calls: { provider: SearchProvider; key: string | null }[] = [];
  const { service, close } = fixture(async (url, options) => {
    const provider = String(url).includes('brave.com') ? 'brave' : 'tavily', headers = new Headers(options?.headers);
    calls.push({ provider, key: headers.get(provider === 'brave' ? 'X-Subscription-Token' : 'Authorization') });
    return Response.json(provider === 'brave' ? { type: 'search', query: { original: 'docs' }, web: { results: [] } } : { results: [] });
  });
  try {
    service.save({ enabled: true, apiKey: 'original-brave-secret' }); const previous = service.tools()[0]!;
    service.save({ provider: 'tavily', apiKey: 'new-tavily-secret' });
    await previous.execute('old', { query: 'docs' }); await service.tools()[0]!.execute('new', { query: 'docs' });
    assert.deepEqual(calls, [{ provider: 'brave', key: 'original-brave-secret' }, { provider: 'tavily', key: 'Bearer new-tavily-secret' }]);
  } finally { close(); }
});

test('a DeepSeek teaching model calls ordinary web_search, receives citations, and retains only source metadata', async () => {
  const db = openDatabase(':memory:'), model = { ...teachingModel, id: 'deepseek-chat', provider: 'deepseek' };
  const selection = { provider: 'deepseek', model: 'deepseek-chat', thinkingLevel: 'high' as const };
  let searches = 0, turns = 0;
  const { service, close } = fixture(async (_url, options) => {
    searches++; assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer synthetic-search-secret');
    return Response.json({ results: [{ title: 'Rust Book', url: 'https://doc.rust-lang.org/book/', content: 'TRANSIENT-SEARCH-EVIDENCE' }] });
  });
  const runtime = new TeachingRuntime(new Learning(db), { current: () => ({ selection, model }), resolve: () => model }, {
    search: service, stream: (current, context) => {
      assert.equal(current.provider, 'deepseek'); assert.doesNotMatch(JSON.stringify(context), /synthetic-search-secret/);
      const system = context.messages.find((entry) => entry.role === 'system'); assert.ok(system?.role === 'system');
      if (++turns === 3) {
        assert.ok(!system.toolsAdded?.some((tool) => tool.name === 'web_search'));
        return response({ ...reply([{ type: 'text', text: 'Search is disabled.' }]), provider: model.provider, model: model.id });
      }
      assert.ok(system.toolsAdded?.some((tool) => tool.name === 'web_search'));
      if (turns === 1) return response({ ...reply([{ type: 'toolCall', id: 'search-1', name: 'web_search', arguments: { query: 'Rust ownership', count: 2 } }], 'toolUse'), provider: model.provider, model: model.id });
      const result = context.messages.find((entry) => entry.role === 'toolResult' && entry.toolName === 'web_search'); assert.ok(result?.role === 'toolResult');
      assert.equal(result.isError, false); assert.match(JSON.stringify(result.content), /TRANSIENT-SEARCH-EVIDENCE/);
      return response({ ...reply([{ type: 'text', text: 'See the [Rust Book](https://doc.rust-lang.org/book/).' }]), provider: model.provider, model: model.id });
    },
  });
  try {
    service.save({ enabled: true, provider: 'tavily', apiKey: 'synthetic-search-secret' });
    const space = runtime.createSpace(randomUUID(), { name: 'Search', goal: 'Find Rust documentation.' }), run = space.runs[0]!;
    await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'succeeded'); assert.equal(searches, 1);
    const native = JSON.stringify(db.prepare('SELECT value FROM agent_messages').all());
    assert.match(native, /omitted/); assert.doesNotMatch(native, /TRANSIENT-SEARCH-EVIDENCE|synthetic-search-secret/);
    const manifests = db.prepare('SELECT value FROM context_manifests ORDER BY request').all() as { value: string }[];
    const sources = JSON.parse(manifests[1]!.value).toolSources[0].sources;
    assert.equal(sources[0].kind, 'web'); assert.equal(sources[0].provider, 'tavily'); assert.equal(sources[0].url, 'https://doc.rust-lang.org/book/');
    assert.equal(sources[0].title, 'Rust Book'); assert.match(sources[0].hash, /^[a-f0-9]{64}$/);
    assert.ok(runtime.events(space.id, run.id).events.some((entry) => entry.data.type === 'tool' && entry.data.name === 'web_search' && entry.data.phase === 'end' && !entry.data.failed));
    service.save({ enabled: false });
    const second = runtime.createSpace(randomUUID(), { name: 'No search', goal: 'Answer without search.' });
    await runtime.idle(second.runs[0]!.id); assert.equal(searches, 1); assert.equal(turns, 3);
  } finally { await runtime.close(); db.close(); close(); }
});
