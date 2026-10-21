import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net, { type LookupFunction, type TcpNetConnectOpts } from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readability } from '@mozilla/readability';
import { createWebFetchTool, type WebFetchOptions, type WebFetchResponse } from './web-fetch.js';
import { SearchService } from './search.js';
import { TeachingRuntime } from '../agents/runtime.js';
import { reply, response, syntheticSource, teachingModel } from '../agents/test-support.js';
import { BusinessError, Learning } from '../modules/learning.js';
import { openDatabase } from '../storage/database.js';

const address = 'https://docs.example/guide/start';
const publicLookup: NonNullable<WebFetchOptions['lookup']> = async () => [
  { address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 },
];
function fixture(request: NonNullable<WebFetchOptions['fetch']>, lookup = publicLookup) {
  return createWebFetchTool({ fetch: request, lookup });
}
async function result(tool: ReturnType<typeof createWebFetchTool>, input: unknown = { url: address }) {
  const value = await tool.execute('fetch-test', input);
  assert.equal(value.content[0]?.type, 'text');
  return JSON.parse(value.content[0]!.type === 'text' ? value.content[0]!.text : '') as WebFetchResponse;
}
function body(value: WebFetchResponse) {
  const match = value.text.match(/^\[UNTRUSTED_WEB_CONTENT:([a-f0-9]{16})\]\n([\s\S]*)\n\[\/UNTRUSTED_WEB_CONTENT:\1\]$/);
  assert.ok(match, 'content must have matching unpredictable untrusted boundaries');
  return match[2]!;
}
const html = `<html><head><title>Rust Reference Guide</title><base href="https://wrong.example/"></head><body>
  <nav>NAVIGATION-NOISE</nav><script>throw new Error('SCRIPT-NOISE')</script><style>STYLE-NOISE</style>
  <p hidden>HIDDEN-NOISE</p><p aria-hidden="true">ARIA-NOISE</p><div style="display: none">CSS-NOISE</div>
  <iframe src="https://never-request.example/">FRAME-NOISE</iframe>
  <div role="dialog"><h2>OVERLAY-NOISE</h2><p>Press ? to show help.</p></div>
  <main><h1>Borrowing</h1><p>Read <a href="../borrow/?v=2#examples">the guide</a> &amp; practice <code>snake_case</code>.</p>
  <pre><code class="language-rust">let borrowed = &amp;owner;
  println!("{}", borrowed);</code></pre><p>Borrowed data must not outlive its owner.</p>
  <a href="javascript:alert(1)">unsafe scheme</a><a href="https://user:secret@example.org/">unsafe credentials</a>
  </main><footer>FOOTER-NOISE</footer></body></html>`;

test('HTML extraction preserves documentation/code, resolves links against the fetched URL, and removes active/hidden content', async () => {
  const calls: string[] = [];
  const tool = fixture(async (url, options) => {
    calls.push(url.href);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.ok(options.dispatcher);
    assert.ok(options.signal); assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
    return new Response(html, { headers: { 'Content-Type': 'Text/HTML; charset=utf-8' } });
  });
  const markdown = await result(tool, { url: `  ${address}#ownership  ` });
  assert.equal(markdown.url, address); assert.equal(markdown.finalUrl, address); assert.equal(markdown.status, 200);
  assert.equal(markdown.contentType, 'text/html'); assert.equal(markdown.extractMode, 'markdown');
  assert.equal(markdown.title, 'Rust Reference Guide'); assert.equal(markdown.extractor, 'readability');
  assert.equal(markdown.untrusted, true); assert.equal(markdown.truncated, false);
  assert.match(body(markdown), /^#{1,2} Borrowing$/m);
  assert.match(body(markdown), /\[the guide\]\(https:\/\/docs.example\/borrow\/\?v=2#examples\)/);
  assert.match(body(markdown), /practice `snake_case`/);
  assert.match(body(markdown), /```rust\nlet borrowed = &owner;\n  println!\("\{\}", borrowed\);\n```/);
  assert.doesNotMatch(markdown.text, /-NOISE|wrong\.example|javascript:|user:secret/);
  assert.equal(markdown.length, markdown.text.length); assert.equal(markdown.rawLength, body(markdown).length);
  assert.ok(Number.isFinite(Date.parse(markdown.fetchedAt))); assert.ok(markdown.tookMs >= 0);
  const text = await result(tool, { url: address, extractMode: 'text' });
  assert.match(body(text), /Borrowing\n\nRead the guide & practice snake_case\./);
  assert.match(body(text), /let borrowed = &owner;\n  println!\("\{\}", borrowed\);/);
  assert.doesNotMatch(text.text, /```|\[the guide\]|-NOISE/);
  assert.deepEqual(calls, [address, address], 'fetch each time without a shared response cache');
});

test('short or unparseable articles fall back to sanitized local HTML rather than a paid extractor', async (t) => {
  const tool = fixture(async () => new Response('<p>Short <strong>API</strong> documentation.</p>', { headers: { 'content-type': 'text/html' } }));
  for (const fails of [false, true]) {
    t.mock.method(Readability.prototype, 'parse', () => { if (fails) throw new Error('synthetic parser failure'); return null; });
    const value = await result(tool);
    assert.equal(value.extractor, 'html'); assert.equal(body(value), 'Short **API** documentation.');
    t.mock.restoreAll();
  }
});

test('Markdown, plain text and JSON have explicit extraction behavior, including plain mode without corrupting code', async () => {
  const markdown = '# Ownership\n\n**Borrowing** [guide](./borrowing/) and `snake_case`.\n\n```rust\n// literal ** and _\nlet snake_case = 1;\n```';
  let content = markdown, contentType = 'text/markdown';
  const tool = fixture(async () => new Response(content, { headers: { 'content-type': contentType } }));
  const md = await result(tool); assert.equal(body(md), markdown); assert.equal(md.extractor, 'markdown');
  const plain = await result(tool, { url: address, extractMode: 'text' });
  assert.equal(body(plain), 'Ownership\n\nBorrowing guide and snake_case.\n\n// literal ** and _\nlet snake_case = 1;');
  content = '{"topic":"Rust","counts":[3,1]}'; contentType = 'application/problem+json';
  assert.equal(body(await result(tool)), '{\n  "topic": "Rust",\n  "counts": [\n    3,\n    1\n  ]\n}');
  content = '  Rust\nsecond line with snake_case  '; contentType = 'text/plain';
  assert.equal(body(await result(tool)), 'Rust\nsecond line with snake_case');
});

test('character bounds include untrusted markers, keep Unicode intact, and distinguish both sides of the exact boundary', async () => {
  let text = 'x'.repeat(100);
  const tool = fixture(async () => new Response(text));
  // The specified pair of markers consumes 83 characters (41 + 42), independently of page content.
  const exact = await result(tool, { url: address, maxChars: 183 });
  assert.equal(exact.length, 183); assert.equal(body(exact), text); assert.equal(exact.truncated, false);
  text += 'y';
  const capped = await result(tool, { url: address, maxChars: 183 });
  assert.equal(capped.length, 183); assert.equal(body(capped), 'x'.repeat(100)); assert.equal(capped.truncated, true); assert.equal(capped.rawLength, 101);
  text = 'x'.repeat(16) + '🦀END';
  const unicode = await result(tool, { url: address, maxChars: 100 });
  assert.equal(body(unicode), 'x'.repeat(16)); assert.equal(unicode.length, 99); assert.equal(unicode.truncated, true);
  assert.doesNotMatch(unicode.text, /[\ud800-\udfff]/u);
  text = 'x'.repeat(25_000);
  const defaultLimit = await result(tool); assert.equal(defaultLimit.length, 20_000); assert.equal(defaultLimit.truncated, true);
});

test('download is capped while streaming, marks partial results, cancels unread bodies and drops incomplete UTF-8', async () => {
  for (const extra of [0, 1]) {
    const value = await result(fixture(async () => new Response('a'.repeat(750_000) + 'z'.repeat(extra))));
    assert.equal(value.rawLength, 750_000); assert.equal(!!value.warning, extra === 1); assert.equal(value.truncated, true);
    assert.equal(body(value).length, 19_917);
  }
  let cancelled = false;
  const tool = fixture(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from('a'.repeat(749_999) + '🦀MUST-NOT-BE-READ'));
  }, cancel() { cancelled = true; } })));
  const value = await result(tool);
  assert.equal(value.rawLength, 749_999); assert.match(value.warning!, /750,000/);
  assert.doesNotMatch(value.text, /�|MUST-NOT-BE-READ/); assert.equal(cancelled, true);
});

test('charset declarations and BOMs decode non-UTF8 pages before extraction', async () => {
  let data = Buffer.from([0x63, 0x61, 0x66, 0xe9]), contentType = 'text/plain; charset=windows-1252';
  const tool = fixture(async () => new Response(data, { headers: { 'content-type': contentType } }));
  assert.equal(body(await result(tool)), 'café');
  data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Rust 中文文档', 'utf16le')]); contentType = 'text/plain; charset=utf-8';
  assert.equal(body(await result(tool)), 'Rust 中文文档', 'BOM overrides an incorrect HTTP declaration');
  data = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>caf'), Buffer.from([0xe9]), Buffer.from('</p>')]); contentType = 'text/html';
  assert.equal(body(await result(tool, { url: address, extractMode: 'text' })), 'café');
});

test('invalid inputs, credentials, private/special IP literals, local names and non-HTTP schemes never resolve or connect', async () => {
  let lookups = 0, requests = 0;
  const tool = fixture(async () => { requests++; return new Response('must not call'); }, async () => { lookups++; return publicLookup('unused'); });
  for (const input of [{}, { url: '' }, { url: address, maxChars: 99 }, { url: address, maxChars: 20_001 },
    { url: address, maxChars: 101.5 }, { url: address, extractMode: 'html' }, { url: address, headers: { authorization: 'PRIVATE' } }]) {
    await assert.rejects(tool.execute('invalid', input), { message: 'WEB_FETCH_INVALID_REQUEST' });
  }
  for (const url of ['file:///etc/passwd', 'ftp://public.example/file', 'data:text/plain,private', 'not a URL',
    'https://user:secret@public.example/', 'http://localhost/', 'http://printer/', 'http://HOST.local./',
    'http://service.internal/', 'http://metadata.google.internal/', 'http://0/', 'http://2130706433/', 'http://0x7f000001/',
    'http://127.1/', 'http://0177.0.0.1/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.1.1/',
    'http://169.254.169.254/', 'http://100.100.100.200/', 'http://198.18.0.1/', 'http://192.0.2.1/', 'http://224.0.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[fec0::1]/',
    'http://[64:ff9b::a00:1]/', 'http://[64:ff9b:1::808:808]/', 'http://[2002:7f00:1::1]/',
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'http://[2001:4860:0:0:0:5efe:7f00:1]/']) {
    await assert.rejects(tool.execute('blocked', { url }), (error: Error) => {
      assert.doesNotMatch(error.message, /secret|\/etc\/passwd/); return true;
    });
  }
  assert.equal(lookups, 0); assert.equal(requests, 0);
});

test('DNS validates every answer, including mixed public/private addresses and family mismatches', async () => {
  let requests = 0;
  const tool = (answers: Awaited<ReturnType<typeof publicLookup>>) => fixture(async () => { requests++; return new Response('unsafe'); }, async () => answers);
  for (const answers of [[], [{ address: '127.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '::1', family: 6 }, { address: '2606:4700:4700::1111', family: 6 }],
    [{ address: '8.8.8.8', family: 6 }], [{ address: 'not an IP', family: 4 }]]) {
    await assert.rejects(result(tool(answers)), { message: 'WEB_FETCH_ADDRESS_FORBIDDEN' });
  }
  assert.equal(requests, 0);
  for (const url of ['https://8.8.8.8/', 'https://[2606:4700:4700::1111]/', 'https://[::ffff:8.8.8.8]/']) {
    const value = await result(fixture(async () => new Response('Public documentation'), async () => { throw new Error('literals must not resolve'); }), { url });
    assert.equal(body(value), 'Public documentation');
  }
});

test('the actual Undici connection uses pinned DNS answers and preserves the HTTP hostname despite a rebinding resolver', async (t) => {
  let lookups = 0, connected = 0, host = '';
  const server = createServer((req, res) => { host = req.headers.host!; assert.equal(req.headers.authorization, undefined); res.end('Pinned transport documentation'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port, connect = net.connect;
  // Only the disposable fixture reroutes sockets to loopback, after checking the production transport's lookup.
  t.mock.method(net, 'connect', (options: TcpNetConnectOpts & { lookup?: LookupFunction }) => {
    const pinned = options.lookup; assert.ok(pinned, 'a DNS precheck without transport pinning must fail this test');
    const reroute: LookupFunction = (hostname, hints, callback) => pinned(hostname, hints, (error, addresses, family) => {
      assert.ifError(error); connected++;
      if (Array.isArray(addresses)) {
        assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); callback(null, [{ address: '127.0.0.1', family: 4 }]);
      } else { assert.equal(addresses, '8.8.8.8'); assert.equal(family, 4); callback(null, '127.0.0.1', 4); }
    });
    return connect({ ...options, lookup: reroute });
  });
  try {
    const value = await result(createWebFetchTool({ lookup: async () => {
      lookups++; return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    } }), { url: `http://docs.example:${port}/guide` });
    assert.equal(body(value), 'Pinned transport documentation'); assert.equal(host, `docs.example:${port}`);
    assert.equal(lookups, 1); assert.equal(connected, 1);
  } finally { t.mock.restoreAll(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('redirects allow three safe hops, retain case/query, revalidate each target and reject private redirects or DNS rebinding', async () => {
  let calls = 0, lookupCalls = 0;
  const seen: string[] = [];
  const tool = fixture(async (url) => {
    seen.push(url.href);
    return ++calls <= 3 ? new Response('redirect', { status: [301, 302, 307][calls - 1], headers: {
      location: calls === 1 ? '../Next?Case=Kept' : calls === 2 ? 'https://other.example/Final' : '?Case=StillKept',
    } }) : new Response('Final content');
  }, async (hostname) => { lookupCalls++; return publicLookup(hostname); });
  const value = await result(tool);
  assert.equal(value.finalUrl, 'https://other.example/Final?Case=StillKept'); assert.equal(body(value), 'Final content');
  assert.deepEqual(seen, [address, 'https://docs.example/Next?Case=Kept', 'https://other.example/Final', 'https://other.example/Final?Case=StillKept']);
  assert.equal(lookupCalls, 4);
  for (const location of ['http://127.0.0.1/private', 'http://[::ffff:10.0.0.1]/', 'file:///private', 'https://user:secret@public.example/']) {
    let redirects = 0;
    await assert.rejects(result(fixture(async () => { redirects++; return new Response(null, { status: 308, headers: { location } }); })));
    assert.equal(redirects, 1);
  }
  calls = 0; lookupCalls = 0;
  await assert.rejects(result(fixture(async () => { calls++; return new Response(null, { status: 302, headers: { location: '/rebound' } }); }, async () => {
    lookupCalls++; return [{ address: lookupCalls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  })), { message: 'WEB_FETCH_ADDRESS_FORBIDDEN' });
  assert.equal(calls, 1); assert.equal(lookupCalls, 2);
});

test('redirect loops, missing locations, excessive hops, HTTP errors and unsupported binaries fail safely without retry', async () => {
  let calls = 0;
  const tool = (request: NonNullable<WebFetchOptions['fetch']>) => fixture(async (...args) => { calls++; return request(...args); });
  await assert.rejects(result(tool(async () => new Response(null, { status: 302, headers: { location: address } }))), { message: 'WEB_FETCH_REDIRECT_LOOP' });
  assert.equal(calls, 1); calls = 0;
  await assert.rejects(result(tool(async () => new Response(null, { status: 302 }))), { message: 'WEB_FETCH_INVALID_REDIRECT' });
  assert.equal(calls, 1); calls = 0;
  await assert.rejects(result(tool(async () => new Response(null, { status: 308, headers: { location: `/hop-${calls}` } }))), { message: 'WEB_FETCH_TOO_MANY_REDIRECTS' });
  assert.equal(calls, 4);
  for (const status of [401, 403, 404, 429, 500]) {
    calls = 0;
    await assert.rejects(result(tool(async () => new Response('REFLECTED-PRIVATE-BODY', { status }))), (error: unknown) => {
      assert.ok(error instanceof BusinessError);
      assert.equal(error.message, 'WEB_FETCH_HTTP_FAILED');
      assert.deepEqual(error.detail, { code: 'WEB_FETCH_HTTP_FAILED', params: { status } });
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/); return true;
    }); assert.equal(calls, 1);
  }
  for (const contentType of ['application/pdf', 'image/png', 'application/octet-stream']) {
    await assert.rejects(result(fixture(async () => new Response('binary', { headers: { 'content-type': contentType } }))), { message: 'WEB_FETCH_CONTENT_UNSUPPORTED' });
  }
  await assert.rejects(result(fixture(async () => { throw new Error('PRIVATE-DIAGNOSTIC https://user:secret@host/'); })), (error: Error) => {
    assert.doesNotMatch(error.message, /PRIVATE|secret|user:/); return true;
  });
  await assert.rejects(result(fixture(async () => new Response(null, { status: 204 }))), { message: 'WEB_FETCH_BODY_UNAVAILABLE' });
  await assert.rejects(result(fixture(async () => new Response('<html><body><script>app()</script></body></html>', { headers: { 'content-type': 'text/html' } }))), { message: 'WEB_FETCH_BODY_UNAVAILABLE' });
  await assert.rejects(result(fixture(async () => new Response('<div>'.repeat(257) + 'Deep' + '</div>'.repeat(257), { headers: { 'content-type': 'text/html' } }))), { message: 'WEB_FETCH_HTML_TOO_COMPLEX' });
});

test('already-cancelled/deadline calls never reach DNS or HTTP', async (t) => {
  let calls = 0;
  const tool = fixture(async () => { calls++; return new Response('late'); }, async () => { calls++; return publicLookup('unused'); });
  await assert.rejects(tool.execute('cancel', { url: address }, AbortSignal.abort()), { message: 'WEB_FETCH_CANCELLED' });
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 30_000); return AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
  });
  try { await assert.rejects(result(tool), { message: 'WEB_FETCH_TIMEOUT' }); assert.equal(calls, 0); }
  finally { t.mock.restoreAll(); }
});

test('DNS waits and body reads cancel promptly, including a stream whose cancellation promise never settles', async () => {
  for (const stage of ['dns', 'body'] as const) {
    const controller = new AbortController(); let entered!: () => void, cancelled = false, requests = 0;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const tool = fixture(async () => {
      requests++;
      return new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(Buffer.from('PARTIAL-CANCELLED-BODY')); },
        pull() { entered(); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } }));
    }, stage === 'dns' ? async () => { entered(); return new Promise(() => {}); } : publicLookup);
    const pending = tool.execute('cancel', { url: address }, controller.signal);
    await ready; controller.abort(); await assert.rejects(pending, { message: 'WEB_FETCH_CANCELLED' });
    assert.equal(requests, stage === 'dns' ? 0 : 1); assert.equal(cancelled, stage === 'body');
  }
});

test('caller cancellation propagates into HTTP and rejects late successful responses', async () => {
  for (const cooperative of [false, true]) {
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; }), controller = new AbortController();
    const tool = fixture(async (_url, options) => new Promise<Response>((resolve, reject) => {
      finish = () => resolve(new Response('LATE-BODY'));
      if (cooperative) options.signal.addEventListener('abort', () => reject(new Error('PRIVATE-DIAGNOSTIC')), { once: true });
      entered();
    }));
    const pending = tool.execute('late', { url: address }, controller.signal);
    await ready; controller.abort(); finish(); await assert.rejects(pending, { message: 'WEB_FETCH_CANCELLED' });
  }
});

test('DeepSeek receives ordinary web_fetch without a search key or enabled search, and only provenance is retained', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-fetch-runtime-')), db = openDatabase(':memory:');
  const search = new SearchService(join(root, 'search.json'), { env: () => undefined });
  const model = { ...teachingModel, id: 'deepseek-chat', provider: 'deepseek' };
  const selection = { provider: model.provider, model: model.id, thinkingLevel: 'high' as const };
  let turns = 0, pages = 0;
  const runtime = new TeachingRuntime(new Learning(db), { ...syntheticSource, current: () => ({ model, selection }), resolve: () => model }, {
    search, webFetch: { lookup: publicLookup, fetch: async () => { pages++; return new Response('TRANSIENT-PAGE-EVIDENCE'); } },
    stream: (current, context) => {
      assert.equal(current.provider, 'deepseek');
      const system = context.messages.find((entry) => entry.role === 'system'); assert.ok(system?.role === 'system');
      assert.ok(system.toolsAdded?.some((tool) => tool.name === 'web_fetch'));
      assert.ok(!system.toolsAdded?.some((tool) => tool.name === 'web_search'));
      if (++turns === 1) return response({ ...reply([{ type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: { url: address } }], 'toolUse'), provider: model.provider, model: model.id });
      const evidence = context.messages.find((entry) => entry.role === 'toolResult' && entry.toolName === 'web_fetch'); assert.ok(evidence?.role === 'toolResult');
      assert.equal(evidence.isError, false); assert.match(JSON.stringify(evidence.content), /TRANSIENT-PAGE-EVIDENCE/);
      return response({ ...reply([{ type: 'text', text: `Read the [documentation](${address}).` }]), provider: model.provider, model: model.id });
    },
  });
  try {
    const space = runtime.createSpace(randomUUID(), { name: 'Fetch', goal: 'Read public Rust documentation.' }), run = space.runs[0]!;
    await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'succeeded'); assert.equal(pages, 1); assert.equal(turns, 2);
    const native = JSON.stringify(db.prepare('SELECT value FROM agent_messages').all());
    assert.match(native, /omitted/); assert.doesNotMatch(native, /TRANSIENT-PAGE-EVIDENCE|UNTRUSTED_WEB_CONTENT/);
    const manifests = db.prepare('SELECT value FROM context_manifests ORDER BY request').all() as { value: string }[];
    const sources = JSON.parse(manifests[1]!.value).toolSources[0].sources;
    assert.equal(sources[0].provider, 'web_fetch'); assert.equal(sources[0].url, address);
    assert.ok(sources[0].capturedAt > 0); assert.match(sources[0].hash, /^[a-f0-9]{64}$/);
    const events = runtime.events(space.id, run.id).events;
    assert.ok(events.some((entry) => entry.data.type === 'tool' && entry.data.name === 'web_fetch' && entry.data.phase === 'end' && !entry.data.failed));
    assert.doesNotMatch(JSON.stringify(events), /TRANSIENT-PAGE-EVIDENCE/);
  } finally { await runtime.close(); search.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a teaching model can follow an ordinary web_search result with web_fetch in the same run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-search-fetch-')), db = openDatabase(':memory:');
  let searches = 0, pages = 0, turns = 0;
  const search = new SearchService(join(root, 'search.json'), { env: () => undefined, fetch: async () => {
    searches++; return Response.json({ results: [{ title: 'Rust Reference', url: address, content: 'SEARCH-SNIPPET' }] });
  } });
  search.save({ enabled: true, provider: 'tavily', apiKey: 'synthetic-search-secret' });
  const model = teachingModel, selection = { provider: model.provider, model: model.id, thinkingLevel: 'high' as const };
  const runtime = new TeachingRuntime(new Learning(db), { ...syntheticSource, current: () => ({ model, selection }), resolve: () => model }, {
    search, webFetch: { lookup: publicLookup, fetch: async (url, options) => {
      pages++; assert.equal(url.href, address); assert.doesNotMatch(JSON.stringify(options.headers), /secret|authorization|cookie/i);
      return new Response('DETAILED-PAGE-EVIDENCE');
    } }, stream: (_model, context) => {
      assert.doesNotMatch(JSON.stringify(context), /synthetic-search-secret/);
      if (++turns === 1) return response(reply([{ type: 'toolCall', id: 'search-first', name: 'web_search', arguments: { query: 'Rust references' } }], 'toolUse'));
      const searched = context.messages.find((entry) => entry.role === 'toolResult' && entry.toolName === 'web_search');
      assert.ok(searched?.role === 'toolResult'); assert.equal(searched.isError, false);
      if (turns === 2) {
        const payload = JSON.parse(searched.content[0]!.type === 'text' ? searched.content[0]!.text : '');
        assert.equal(payload.results[0].url, address);
        return response(reply([{ type: 'toolCall', id: 'fetch-next', name: 'web_fetch', arguments: { url: payload.results[0].url } }], 'toolUse'));
      }
      const fetched = context.messages.find((entry) => entry.role === 'toolResult' && entry.toolName === 'web_fetch');
      assert.ok(fetched?.role === 'toolResult'); assert.equal(fetched.isError, false); assert.match(JSON.stringify(fetched.content), /DETAILED-PAGE-EVIDENCE/);
      return response(reply([{ type: 'text', text: `According to the [Rust Reference](${address}).` }]));
    },
  });
  try {
    const space = runtime.createSpace(randomUUID(), { name: 'Search then fetch', goal: 'Find and read Rust documentation.' }), run = space.runs[0]!;
    await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'succeeded');
    assert.equal(searches, 1); assert.equal(pages, 1); assert.equal(turns, 3);
    const manifest = JSON.parse((db.prepare('SELECT value FROM context_manifests WHERE request=3').get() as { value: string }).value);
    assert.deepEqual(manifest.toolSources.map((entry: { sources: { provider: string; url: string }[] }) => entry.sources.map(({ provider, url }) => ({ provider, url }))),
      [[{ provider: 'tavily', url: address }], [{ provider: 'web_fetch', url: address }]]);
    assert.doesNotMatch(JSON.stringify(db.prepare('SELECT value FROM agent_messages').all()), /SEARCH-SNIPPET|DETAILED-PAGE-EVIDENCE|synthetic-search-secret/);
  } finally { await runtime.close(); search.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('stopping or closing a teaching run aborts web_fetch without another model request or late commit', async () => {
  for (const action of ['stop', 'close'] as const) {
    const db = openDatabase(':memory:'), learning = new Learning(db); let entered!: () => void, turns = 0, cancelled = false, commits = 0;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const model = { ...teachingModel, id: 'deepseek-chat', provider: 'deepseek' }, selection = { provider: model.provider, model: model.id, thinkingLevel: 'high' as const };
    const runtime = new TeachingRuntime(learning, { ...syntheticSource, current: () => ({ model, selection }), resolve: () => model }, {
      scenario: () => ({ tools: [], commit() { commits++; } }), webFetch: { lookup: publicLookup, fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull() { entered(); }, cancel() { cancelled = true; },
      })) }, stream: () => { turns++; return response({ ...reply([{ type: 'toolCall', id: 'pending-fetch', name: 'web_fetch', arguments: { url: address } }], 'toolUse'), provider: model.provider, model: model.id }); },
    });
    try {
      const space = runtime.createSpace(randomUUID(), { name: 'Cancel fetch', goal: 'Read documentation.' }), run = space.runs[0]!;
      await ready; if (action === 'stop') runtime.stop(space.id, run.id); else await runtime.close();
      await runtime.idle(run.id); assert.equal(runtime.get(space.id, run.id).state, 'interrupted');
      assert.equal(turns, 1); assert.equal(cancelled, true); assert.equal(commits, 0);
    } finally { await runtime.close(); db.close(); }
  }
});
