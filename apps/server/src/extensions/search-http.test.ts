import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { BusinessError } from '../modules/learning.js';
import { HttpSearchError, runHttpSearch, searchModelDefaults } from './search-http.js';

type Provider = Parameters<typeof runHttpSearch>[0];
type Configuration = Parameters<typeof runHttpSearch>[3];
const query = 'Rust 中文 C++ 🦀 & ownership';
const key = 'synthetic-search-key';
const signal = () => new AbortController().signal;
const invoke = (provider: Provider, payload: unknown, configuration: Configuration = {}, count = 2) =>
  runHttpSearch(provider, key, { query, count }, configuration, async () => Response.json(payload), signal());
function safeError(error: unknown, code = 'SEARCH_RESULTS_UNAVAILABLE', kind: HttpSearchError['kind'] = 'invalid'): boolean {
  assert.ok(error instanceof BusinessError);
  assert.equal(error.status, 503);
  assert.equal(error.message, code);
  assert.deepEqual(error.detail, { code });
  if (code === 'SEARCH_RESULTS_UNAVAILABLE') {
    assert.ok(error instanceof HttpSearchError);
    assert.equal(error.kind, kind);
  }
  assert.doesNotMatch(error.message, /synthetic|UPSTREAM|sensitive|schema-value|secret|Bearer/);
  return true;
}
type Call = { url: string; method: string | undefined; headers: Record<string, string>; body: unknown; redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined };
function record(input: Parameters<typeof fetch>[0], options: Parameters<typeof fetch>[1]): Call {
  return { url: String(input), method: options?.method, headers: Object.fromEntries(new Headers(options?.headers)),
    body: options?.body === undefined ? undefined : JSON.parse(String(options.body)), redirect: options?.redirect, signal: options?.signal };
}

const rankedRows = [
  ...['javascript:alert(1)', 'file:///tmp/evidence', 'data:text/plain,private', 'https://user:password@example.org/',
    '/relative', 'not-a-url', `https://long.example/${'x'.repeat(2048)}`].map((url) => ({ url, title: 'unsafe' })),
  { url: 'https://example.org/中文?q=C%2B%2B', title: `  ${'标题'.repeat(300)}  ` },
  { url: 'http://second.example/guide', title: '' },
  { url: 'https://beyond.example/', title: 'Beyond count' },
];
const longSnippet = '证据'.repeat(1100);
const transports: { provider: Provider; url: string; headers: Record<string, string>; body: unknown; payload: unknown; snippet?: string; configuration?: Configuration }[] = [
  { provider: 'brave', url: 'https://api.search.brave.com/res/v1/web/search?q=Rust+%E4%B8%AD%E6%96%87+C%2B%2B+%F0%9F%A6%80+%26+ownership&count=2&result_filter=web&text_decorations=false',
    headers: { accept: 'application/json', 'x-subscription-token': key }, body: undefined,
    payload: { type: 'search', query: { original: query }, web: { results: rankedRows.map((row) => ({ ...row, description: longSnippet })) } } },
  { provider: 'tavily', url: 'https://api.tavily.com/search', headers: { authorization: `Bearer ${key}` },
    body: { query, max_results: 2 }, payload: { results: rankedRows.map((row) => ({ ...row, content: longSnippet })) } },
  { provider: 'exa', url: 'https://api.exa.ai/search', headers: { 'x-api-key': key },
    body: { query, numResults: 2, type: 'auto', contents: { highlights: true } }, snippet: '保留排名\n中文 C++',
    payload: { results: rankedRows.map((row) => ({ ...row, highlights: [' ', ' 保留排名 ', ' 中文 C++ '], summary: 'Must not win', text: 'Must not win' })) } },
  { provider: 'firecrawl', url: 'https://api.firecrawl.dev/v2/search', headers: { authorization: `Bearer ${key}` },
    body: { query, limit: 2 }, payload: { success: true, data: rankedRows.map((row) => ({ ...row, description: longSnippet })) } },
  { provider: 'firecrawl-free', url: 'https://api.firecrawl.dev/v2/search', headers: {},
    body: { query, limit: 2 }, payload: { success: true, data: { web: rankedRows.map((row) => ({ ...row, snippet: longSnippet })) } } },
  { provider: 'parallel', url: 'https://api.parallel.ai/v1/search', headers: { 'x-api-key': key, 'user-agent': 'TeachMeCoding/1.0' },
    body: { search_queries: [query], advanced_settings: { max_results: 2 } }, snippet: '第一段\n第二段',
    payload: { results: rankedRows.map((row) => ({ ...row, excerpts: ['第一段', '第二段'] })) } },
  { provider: 'perplexity', url: 'https://api.perplexity.ai/search', headers: { authorization: `Bearer ${key}` },
    body: { query, max_results: 2 }, payload: { results: rankedRows.map((row) => ({ ...row, snippet: longSnippet })) } },
  { provider: 'minimax', url: 'https://api.minimax.io/v1/coding_plan/search', headers: { authorization: `Bearer ${key}` },
    body: { q: query }, payload: { base_resp: { status_code: 0 }, organic: rankedRows.map(({ url, ...row }) => ({ ...row, link: url, snippet: longSnippet })) } },
  { provider: 'minimax', configuration: { region: 'cn' }, url: 'https://api.minimaxi.com/v1/coding_plan/search', headers: { authorization: `Bearer ${key}` },
    body: { q: query }, payload: { base_resp: { status_code: 0 }, organic: rankedRows.map(({ url, ...row }) => ({ ...row, link: url, snippet: longSnippet })) } },
  { provider: 'ollama', url: 'https://ollama.com/api/web_search', headers: { authorization: `Bearer ${key}` },
    body: { query, max_results: 2 }, payload: { results: rankedRows.map((row) => ({ ...row, content: longSnippet })) } },
];
for (const fixture of transports) {
  test(`${fixture.provider} ${fixture.configuration?.region ?? 'global'}: exact official transport, Unicode, ranked safe results and local bounds`, async () => {
    const calls: Call[] = [], deadline = signal();
    const result = await runHttpSearch(fixture.provider, key, { query, count: 2 }, fixture.configuration ?? {}, async (input, options) => {
      calls.push(record(input, options)); return Response.json(fixture.payload);
    }, deadline);
    assert.deepEqual(calls, [{ url: fixture.url, method: fixture.body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(fixture.body === undefined ? {} : { 'content-type': 'application/json' }), ...fixture.headers },
      body: fixture.body, redirect: 'error', signal: deadline }]);
    const snippet = fixture.snippet ?? longSnippet.slice(0, 2000);
    assert.deepEqual(result, { results: [
      { title: '标题'.repeat(250), url: 'https://example.org/%E4%B8%AD%E6%96%87?q=C%2B%2B', snippet },
      { title: 'second.example', url: 'http://second.example/guide', snippet },
    ] });
    assert.doesNotMatch(JSON.stringify(result), /synthetic-search-key/);
  });
}

test('Brave documented empty web is valid; malformed search envelopes and strict legacy rows are not', async () => {
  for (const web of [undefined, null, { results: [] }]) {
    assert.deepEqual(await invoke('brave', { type: 'search', query: { original: query }, ...(web === undefined ? {} : { web }) }), { results: [] });
  }
  for (const payload of [{}, { type: 'error', query: { original: query } }, { type: 'search' },
    { type: 'search', query: { original: query }, web: {} }, { type: 'search', query: { original: query }, web: { results: 'schema-value' } }]) {
    await assert.rejects(invoke('brave', payload), safeError);
  }
  for (const provider of ['brave', 'tavily', 'exa'] as const) {
    const rows = [{ url: 'https://example.org/', title: { sensitive: 'schema-value' } }];
    await assert.rejects(invoke(provider, provider === 'brave' ? { type: 'search', query: { original: query }, web: { results: rows } } : { results: rows }), safeError);
  }
});

test('Exa preserves highlight/summary/text precedence and nullish title/snippet behavior', async () => {
  const result = await invoke('exa', { results: [
    { url: 'https://summary.example/', highlights: [], summary: ' Summary ', text: 'Full text' },
    { url: 'https://text.example/', title: null, highlights: [' '], summary: '', text: ' Text ' },
    { url: 'https://empty.example/', title: ' ', highlights: null, summary: null, text: null },
  ] }, {}, 10);
  assert.deepEqual(result.results, [
    { title: 'summary.example', url: 'https://summary.example/', snippet: 'Summary' },
    { title: 'text.example', url: 'https://text.example/', snippet: 'Text' },
    { title: 'empty.example', url: 'https://empty.example/', snippet: '' },
  ]);
});

test('Firecrawl handles documented envelopes, URL aliases and metadata titles without scraping', async () => {
  const rows = [
    { sourceURL: 'https://first.example/', metadata: { title: ' First ' }, description: ' Description ', snippet: 'Loses' },
    { sourceUrl: 'https://second.example/', title: 'Second', snippet: ' Snippet ', summary: 'Loses' },
    { metadata: { sourceURL: 'https://third.example/', title: 'Third' }, summary: ' Summary ' },
  ];
  for (const envelope of [{ data: rows }, { results: rows }, { data: { results: rows } }, { data: { data: rows } },
    { web: { results: rows } }, { data: { web: [rows[0]], news: [rows[1]], images: [rows[2]] } }]) {
    assert.deepEqual((await invoke('firecrawl', { success: true, ...envelope }, {}, 10)).results, [
      { title: 'First', url: 'https://first.example/', snippet: 'Description' },
      { title: 'Second', url: 'https://second.example/', snippet: 'Snippet' },
      { title: 'Third', url: 'https://third.example/', snippet: 'Summary' },
    ]);
  }
  for (const data of [[], { web: [] }, { web: [], news: [], images: [] }]) assert.deepEqual(await invoke('firecrawl', { success: true, data }), { results: [] });
  for (const payload of [{ success: false, data: rows, error: 'UPSTREAM synthetic-search-key' }, { success: true }, { data: { web: 'schema-value' } }]) {
    await assert.rejects(invoke('firecrawl', payload), safeError);
  }
});

test('Firecrawl Free and DuckDuckGo never transmit configured or environment credentials', async () => {
  const previous = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'synthetic-env-secret';
  try {
    for (const provider of ['firecrawl-free', 'duckduckgo'] as const) {
      for (const apiKey of [undefined, 'synthetic-saved-secret\nMUST-NOT-BECOME-A-HEADER']) {
        const calls: Call[] = [];
        const result = await runHttpSearch(provider, apiKey, { query, count: 1 }, {}, async (input, options) => {
          calls.push(record(input, options));
          return provider === 'firecrawl-free' ? Response.json({ data: [] }) : new Response('<div class="no-results">No results found</div>');
        }, signal());
        assert.deepEqual(result, { results: [] }); assert.equal(calls.length, 1);
        assert.doesNotMatch(JSON.stringify(calls), /synthetic|authorization|api-key|subscription-token/i);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = previous;
  }
});

test('native providers accept real empty arrays but reject missing/error envelopes and MiniMax base_resp errors', async () => {
  for (const provider of ['tavily', 'exa', 'parallel', 'perplexity', 'ollama', 'minimax'] as const) {
    const empty = provider === 'minimax' ? { organic: [], base_resp: { status_code: 0 } } : { results: [] };
    assert.deepEqual(await invoke(provider, empty), { results: [] });
    for (const payload of [{}, { ...empty, success: false }, { ...empty, error: 'UPSTREAM synthetic-search-key' },
      provider === 'minimax' ? { organic: null } : { results: 'schema-value' },
      provider === 'minimax' ? { organic: [{}] } : { results: [{}] }]) await assert.rejects(invoke(provider, payload), safeError);
  }
  for (const base_resp of [{ status_code: 1004, status_msg: 'UPSTREAM synthetic-search-key' }, { status_code: '0' }, {}, null]) {
    await assert.rejects(invoke('minimax', { organic: [], base_resp }), safeError);
  }
});

test('native count bounds one and ten preserve rank and do not depend on the upstream enforcing count', async () => {
  for (const fixture of transports) {
    for (const count of [1, 10]) {
      const result = await invoke(fixture.provider, fixture.payload, fixture.configuration, count);
      assert.deepEqual(result.results.map((entry) => entry.url), count === 1
        ? ['https://example.org/%E4%B8%AD%E6%96%87?q=C%2B%2B']
        : ['https://example.org/%E4%B8%AD%E6%96%87?q=C%2B%2B', 'http://second.example/guide', 'https://beyond.example/']);
    }
  }
  const exact = 'https://length.example/' + 'x'.repeat(2048 - 'https://length.example/'.length);
  assert.deepEqual((await invoke('perplexity', { results: [{ url: exact }, { url: `${exact}x` }, { url: `https://encoded.example/${'文'.repeat(300)}` }] }, {}, 10)).results,
    [{ title: 'length.example', url: exact, snippet: '' }]);
});

test('DuckDuckGo decodes HTML entities, unwraps only official uddg redirects, and caps safe results', async () => {
  const calls: Call[] = [], deadline = signal();
  const html = `<html><body>
    <div class="result"><a class="result__a" href="/l/?uddg=javascript%3Aalert(1)">Unsafe</a></div>
    <div class="result"><a class="result__a" href="https://user:password@example.org/">Credentials</a></div>
    <div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffirst.example%2F%3Fx%3D1%26y%3D2&amp;rut=ignored">Rust &amp; 中文 &#x1F980;</a></h2>
      <a class="result__snippet">Ownership &lt;guide&gt; &quot;safe&quot; &#39;text&#39;&nbsp;中文</a></div>
    <div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fsecond.example%2F">Second</a><div class="result__snippet">${'长'.repeat(2100)}</div></div>
    <div class="result"><a class="result__a" href="https://beyond.example/">Beyond</a></div>
  </body></html>`;
  const result = await runHttpSearch('duckduckgo', undefined, { query, count: 2 }, {}, async (input, options) => {
    calls.push(record(input, options)); return new Response(html);
  }, deadline);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://html.duckduckgo.com/html?q=Rust+%E4%B8%AD%E6%96%87+C%2B%2B+%F0%9F%A6%80+%26+ownership&kp=-1');
  assert.equal(calls[0]!.method, 'GET'); assert.equal(calls[0]!.body, undefined);
  assert.equal(calls[0]!.redirect, 'error'); assert.equal(calls[0]!.signal, deadline);
  assert.equal(calls[0]!.headers.accept, 'text/html'); assert.match(calls[0]!.headers['user-agent']!, /^Mozilla\/5\.0/);
  assert.deepEqual(result, { results: [
    { title: 'Rust & 中文 🦀', url: 'https://first.example/?x=1&y=2', snippet: 'Ownership <guide> "safe" \'text\'\u00a0中文' },
    { title: 'Second', url: 'https://second.example/', snippet: '长'.repeat(2000) },
  ] });
  const direct = await runHttpSearch('duckduckgo', undefined, { query, count: 10 }, {}, async () => new Response(
    '<div class="result"><a class="result__a" href="https://unrelated.example/l/?uddg=https%3A%2F%2Fother.example%2F">CAPTCHA documentation</a><span class="result__snippet">How to integrate captcha</span></div>'), signal());
  assert.equal(direct.results[0]!.url, 'https://unrelated.example/l/?uddg=https%3A%2F%2Fother.example%2F');
});

test('DuckDuckGo accepts explicit no-result pages, not challenges, unknown HTML or HTTP 202', async () => {
  for (const html of ['<div class="no-results">No results found for query</div>', '<div class="result--no-result"><h1>No results.</h1></div>']) {
    assert.deepEqual(await runHttpSearch('duckduckgo', undefined, { query, count: 2 }, {}, async () => new Response(html), signal()), { results: [] });
  }
  for (const html of ['<html></html>', '', '<h1>UPSTREAM sensitive error</h1>', '<form id="challenge-form"></form>',
    '<form action="//duckduckgo.com/anomaly.js">No results</form>', '<div class="anomaly-modal">Bots use DuckDuckGo too</div>',
    '<h1>Please verify you are human</h1>', '<form id="img-form"></form>']) {
    await assert.rejects(runHttpSearch('duckduckgo', undefined, { query, count: 2 }, {}, async () => new Response(html), signal()), safeError);
  }
  await assert.rejects(runHttpSearch('duckduckgo', undefined, { query, count: 2 }, {},
    async () => new Response('<div class="no-results">No results</div>', { status: 202 }), signal()), (error) => safeError(error, 'SEARCH_RESULTS_UNAVAILABLE', 'unavailable'));
});

test('search model defaults and Gemini request are independent of the teaching model', async () => {
  assert.deepEqual(searchModelDefaults, { gemini: 'gemini-3.6-flash', grok: 'grok-4.7', kimi: 'kimi-k2.6' });
  for (const model of [undefined, 'gemini-custom-flash']) {
    const calls: Call[] = [], deadline = signal();
    const result = await runHttpSearch('gemini', key, { query, count: 1 }, { model }, async (input, options) => {
      calls.push(record(input, options));
      return Response.json({ candidates: [{ content: { parts: [{ text: ' 中文 answer ' }] }, groundingMetadata: {
        groundingChunks: [{ web: { uri: 'javascript:alert(1)', title: 'Unsafe' } },
          { web: { uri: 'https://source.example/', title: 'Source' } }, { web: { uri: 'https://beyond.example/' } }],
      } }] });
    }, deadline);
    assert.deepEqual(calls, [{ url: `https://generativelanguage.googleapis.com/v1beta/models/${model ?? 'gemini-3.6-flash'}:generateContent`,
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-goog-api-key': key },
      body: { contents: [{ parts: [{ text: query }] }], tools: [{ google_search: {} }] }, redirect: 'error', signal: deadline }]);
    assert.deepEqual(result, { answer: '中文 answer', results: [{ title: 'Source', url: 'https://source.example/', snippet: '' }] });
  }
});

test('Gemini needs both an answer and actual grounding; documented query/support evidence is accepted', async () => {
  const candidate = (groundingMetadata: unknown, text = 'Answer') => ({ candidates: [{ content: { parts: [{ text }] }, groundingMetadata }] });
  for (const grounding of [undefined, {}, { groundingChunks: [] }, { groundingChunks: [{ web: { uri: 'https://u:p@example.org/' } }] },
    { webSearchQueries: [' ', 1] }, { groundingSupports: [{}] }]) await assert.rejects(invoke('gemini', candidate(grounding)), safeError);
  await assert.rejects(invoke('gemini', candidate({ webSearchQueries: ['documentation'] }, ' ')), safeError);
  for (const grounding of [{ webSearchQueries: ['documentation'] },
    { groundingSupports: [{ segment: { text: 'Grounded segment' }, groundingChunkIndices: [0] }] }]) {
    assert.deepEqual(await invoke('gemini', candidate(grounding)), { answer: 'Answer', results: [] });
  }
  assert.equal((await invoke('gemini', candidate({ webSearchQueries: ['docs'] }, '文'.repeat(20_010)))).answer, '文'.repeat(20_000));
  await assert.rejects(invoke('gemini', { candidates: [{ content: { parts: [{ text: 'Ungrounded first' }] } },
    { content: { parts: [{ text: 'Second must not win' }] }, groundingMetadata: { webSearchQueries: ['docs'] } }] }), safeError);
});

test('Grok uses one hosted responses call, store:false, configured model and URL annotations', async () => {
  for (const model of [undefined, 'grok-configured']) {
    const calls: Call[] = [], deadline = signal();
    const result = await runHttpSearch('grok', key, { query, count: 2 }, { model }, async (input, options) => {
      calls.push(record(input, options)); return Response.json({ status: 'completed', output_text: 'Fallback must lose', output: [
        { type: 'web_search_call', status: 'completed' },
        { type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'First answer', annotations: [
          { type: 'url_citation', url: 'data:text/plain,unsafe' }, { type: 'url_citation', url: 'https://first.example/', title: 'First' },
        ] }, { type: 'output_text', text: '中文', annotations: [{ type: 'url_citation', url_citation: { url: 'https://second.example/', title: 'Second' } }] }] },
      ] });
    }, deadline);
    assert.deepEqual(calls, [{ url: 'https://api.x.ai/v1/responses', method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: { model: model ?? 'grok-4.7', input: [{ role: 'user', content: query }], tools: [{ type: 'web_search' }], store: false }, redirect: 'error', signal: deadline }]);
    assert.deepEqual(result, { answer: 'First answer\n中文', results: [
      { title: 'First', url: 'https://first.example/', snippet: '' }, { title: 'Second', url: 'https://second.example/', snippet: '' },
    ] });
  }
});

test('Grok accepts root citations or completed search; rejects ordinary chat, missing answer and explicit failures', async () => {
  assert.deepEqual(await invoke('grok', { output_text: 'Root fallback', citations: ['https://source.example/', 'https://source.example/'] }),
    { answer: 'Root fallback', results: [{ title: 'source.example', url: 'https://source.example/', snippet: '' }] });
  assert.deepEqual(await invoke('grok', { output_text: 'Search was executed', output: [{ type: 'web_search_call', status: 'completed' }] }),
    { answer: 'Search was executed', results: [] });
  for (const payload of [{ output_text: 'Ungrounded chat' }, { output_text: 'Answer', citations: ['javascript:alert(1)'] },
    { citations: ['https://source.example/'] }, { output_text: ' ', output: [{ type: 'web_search_call', status: 'completed' }] },
    ...['failed', 'in_progress', 'incomplete', 'cancelled'].map((status) => ({ status, output_text: 'Partial', citations: ['https://source.example/'] })),
    { output_text: 'Partial', citations: ['https://source.example/'], output: [{ type: 'web_search_call', status: 'failed' }] },
    { output_text: 'Answer', error: 'UPSTREAM sensitive', citations: ['https://source.example/'] }]) await assert.rejects(invoke('grok', payload), safeError);
  assert.equal((await invoke('grok', { output_text: '文'.repeat(20_100), citations: ['https://source.example/'] })).answer, '文'.repeat(20_000));
});

test('Kimi replays exact assistant content/reasoning/tool arguments and gathers citations across three rounds', async () => {
  const args1 = ' { "search_results": [{"url":"https://args.example/", "title":"Arguments source"}] }\n';
  const args2 = '{"url":"https://second-args.example/","title":"Second args"}';
  const calls1 = [{ id: 'tool-1', type: 'function', function: { name: '$web_search', arguments: args1 } }];
  const calls2 = [{ id: 'tool-2', type: 'function', function: { name: '$web_search', arguments: args2 } }];
  const assistant1 = { role: 'assistant', content: null, reasoning_content: 'Reasoning 中文', tool_calls: calls1 };
  const assistant2 = { role: 'assistant', content: 'Search more', reasoning_content: '', tool_calls: calls2 };
  const tool1 = { role: 'tool', tool_call_id: 'tool-1', name: '$web_search', content: args1 };
  const tool2 = { role: 'tool', tool_call_id: 'tool-2', name: '$web_search', content: args2 };
  const payloads = [
    { choices: [{ message: assistant1, finish_reason: 'tool_calls' }], search_results: [{ url: 'https://root.example/', title: 'Root', snippet: 'Evidence' }] },
    { choices: [{ message: assistant2, finish_reason: 'tool_calls' }], search_results: [{ url: 'javascript:alert(1)' }, { url: 'https://root.example/' }] },
    { choices: [{ message: { role: 'assistant', content: ' 最终 grounded answer ' }, finish_reason: 'stop' }], search_results: [{ url: 'https://final.example/' }] },
  ];
  for (const region of ['global', 'cn'] as const) {
    const calls: Call[] = [], deadline = signal();
    const result = await runHttpSearch('kimi', key, { query, count: 3 }, { region }, async (input, options) => {
      calls.push(record(input, options)); return Response.json(payloads[calls.length - 1]);
    }, deadline);
    const expectedMessages = [
      [{ role: 'user', content: query }],
      [{ role: 'user', content: query }, assistant1, tool1],
      [{ role: 'user', content: query }, assistant1, tool1, assistant2, tool2],
    ];
    assert.deepEqual(calls, expectedMessages.map((messages) => ({ url: region === 'cn'
      ? 'https://api.moonshot.cn/v1/chat/completions' : 'https://api.moonshot.ai/v1/chat/completions', method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: { model: 'kimi-k2.6', messages, tools: [{ type: 'builtin_function', function: { name: '$web_search' } }], thinking: { type: 'disabled' } },
      redirect: 'error' as const, signal: deadline })));
    assert.deepEqual(result, { answer: '最终 grounded answer', results: [
      { title: 'Root', url: 'https://root.example/', snippet: 'Evidence' },
      { title: 'Arguments source', url: 'https://args.example/', snippet: '' },
      { title: 'Second args', url: 'https://second-args.example/', snippet: '' },
    ] });
  }
});

test('Kimi configured models disable thinking only on compatible families and accept direct valid search evidence', async () => {
  for (const model of ['kimi-k2.5', 'kimi-k2.6-preview', 'kimi-k2', 'moonshot-v1-128k']) {
    const calls: Call[] = [];
    const result = await runHttpSearch('kimi', key, { query, count: 1 }, { model }, async (input, options) => {
      calls.push(record(input, options)); return Response.json({ choices: [{ message: { content: 'Answer' }, finish_reason: 'stop' }], search_results: [{ url: 'https://source.example/' }] });
    }, signal());
    const body = calls[0]!.body as Record<string, unknown>;
    assert.equal(body.model, model); assert.equal(calls.length, 1);
    assert.deepEqual(body.thinking, model === 'kimi-k2.5' || model === 'kimi-k2.6-preview' ? { type: 'disabled' } : undefined);
    assert.deepEqual(result, { answer: 'Answer', results: [{ title: 'source.example', url: 'https://source.example/', snippet: '' }] });
  }
  const result = await invoke('kimi', { choices: [{ message: { content: '文'.repeat(20_010), tool_calls: null }, finish_reason: 'stop' }],
    search_results: [{ url: 'https://source.example/' }] });
  assert.equal(result.answer, '文'.repeat(20_000));
});

test('Kimi opaque arguments are replayed verbatim, multiple tools get individual messages, and replay grounds the answer', async () => {
  const toolCalls = [' opaque 中文 \n', '{"not":"a search payload"}'].map((arguments_, index) =>
    ({ id: `call-${index}`, type: 'function', function: { name: '$web_search', arguments: arguments_ } }));
  const calls: Call[] = [];
  const result = await runHttpSearch('kimi', key, { query, count: 2 }, {}, async (input, options) => {
    calls.push(record(input, options)); return Response.json({ choices: [{ message: calls.length === 1
      ? { content: null, tool_calls: toolCalls } : { content: 'Grounded by builtin replay' } }] });
  }, signal());
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[1]!.body as { messages: unknown[] }).messages, [{ role: 'user', content: query },
    { role: 'assistant', content: null, tool_calls: toolCalls },
    { role: 'tool', tool_call_id: 'call-0', name: '$web_search', content: ' opaque 中文 \n' },
    { role: 'tool', tool_call_id: 'call-1', name: '$web_search', content: '{"not":"a search payload"}' },
  ]);
  assert.deepEqual(result, { answer: 'Grounded by builtin replay', results: [] });
});

test('Kimi rejects ungrounded/unfinished answers, unknown or unusable tools, and fourth-round execution', async () => {
  const goodCall = { id: 'good', type: 'function', function: { name: '$web_search', arguments: '{}' } };
  const badCalls = [
    { ...goodCall, function: { name: 'shell', arguments: '{}' } },
    { ...goodCall, id: '' }, { ...goodCall, type: 'builtin_function' },
    { ...goodCall, function: { name: '$web_search', arguments: {} } },
    { ...goodCall, function: { name: '$web_search', arguments: ' ' } },
  ];
  for (const payload of [{ choices: [{ message: { content: 'Ordinary chat' } }] },
    { choices: [{ message: { content: 'Unsafe citations' } }], search_results: [{ url: 'https://u:p@example.org/' }] },
    { choices: [{ message: { content: '' } }], search_results: [{ url: 'https://source.example/' }] },
    { choices: [{ message: { content: 'Partial' }, finish_reason: 'length' }], search_results: [{ url: 'https://source.example/' }] },
    { choices: [{ message: { content: null, tool_calls: 'schema-value' } }] },
    ...badCalls.map((call) => ({ choices: [{ message: { content: null, tool_calls: [goodCall, call] } }] }))]) {
    let calls = 0;
    await assert.rejects(runHttpSearch('kimi', key, { query, count: 2 }, {}, async () => { calls++; return Response.json(payload); }, signal()), safeError);
    assert.equal(calls, 1, 'invalid tools never trigger a second round');
  }
  let calls = 0;
  await assert.rejects(runHttpSearch('kimi', key, { query, count: 2 }, {}, async () => {
    calls++; return Response.json({ choices: [{ message: { content: null, tool_calls: [goodCall] } }] });
  }, signal()), safeError);
  assert.equal(calls, 3, 'at most three total HTTP rounds, never a fourth call');
});

test('controlled HTTP errors never read or reflect upstream bodies, redirect or retry', async () => {
  for (const status of [301, 302, 401, 403, 429, 500, 502]) {
    let reads = 0, cancelled = 0, calls = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { reads++; throw new Error('UPSTREAM synthetic-search-key'); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async (_input, options) => {
      calls++; assert.equal(options?.redirect, 'error'); return new Response(body, { status, headers: { location: 'https://other.example/' } });
    }, signal()), (error) => safeError(error, 'SEARCH_RESULTS_UNAVAILABLE', status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate-limit' : 'unavailable'));
    assert.equal(calls, 1); assert.equal(reads, 0); assert.equal(cancelled, 1);
  }
  const redirected = Response.json({ results: [] }); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => redirected, signal()), (error) => safeError(error, 'SEARCH_RESULTS_UNAVAILABLE', 'unavailable'));
});

test('all keyed providers reject missing credentials before transport; unsafe model IDs cannot change endpoints', async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; throw new Error('UPSTREAM synthetic-search-key'); };
  for (const provider of ['brave', 'tavily', 'exa', 'firecrawl', 'parallel', 'perplexity', 'minimax', 'ollama', 'gemini', 'grok', 'kimi'] as const) {
    await assert.rejects(runHttpSearch(provider, undefined, { query, count: 2 }, {}, request, signal()), (error) => safeError(error, 'SEARCH_RESULTS_UNAVAILABLE', 'auth'));
  }
  for (const provider of ['gemini', 'grok', 'kimi'] as const) {
    for (const model of ['../../other?key=secret', 'https://evil.example', 'a/b', 'bad\nheader', '', 'x'.repeat(101)]) {
      await assert.rejects(runHttpSearch(provider, key, { query, count: 2 }, { model }, request, signal()), safeError);
    }
  }
  assert.equal(calls, 0);
});

test('malformed JSON, schema values, missing bodies, transport/stream errors and byte caps are sanitized', async () => {
  for (const response of [new Response('UPSTREAM synthetic-search-key'), Response.json({ results: [{ url: 'https://source.example/', title: 'schema-value', content: {} }] }),
    new Response(null), new Response(new ReadableStream({ start(controller) { controller.error(new Error('UPSTREAM sensitive')); } }))]) {
    await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => response, signal()), safeError);
  }
  for (const error of [new Error('UPSTREAM sensitive synthetic-search-key'), Object.assign(new BusinessError(503, { code: 'MODEL_UNAVAILABLE' }), { cause: new Error('UPSTREAM sensitive synthetic-search-key') })]) {
    await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => { throw error; }, signal()), safeError);
  }
  const json = '{"results":[]}';
  assert.deepEqual(await runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => new Response(json + ' '.repeat(1024 * 1024 - json.length)), signal()), { results: [] });
  await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => new Response(json + ' '.repeat(1024 * 1024 + 1 - json.length)), signal()), safeError);
  // The cap counts bytes, not Unicode code units, and applies to HTML as well as JSON.
  await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => Response.json({ results: [], padding: '文'.repeat(350_000) }), signal()), safeError);
  await assert.rejects(runHttpSearch('duckduckgo', undefined, { query, count: 2 }, {}, async () => new Response('文'.repeat(350_000)), signal()), safeError);
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled++; return new Promise(() => {}); } });
  await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => new Response(stream), signal()), safeError);
  assert.equal(cancelled, 1, 'body size failure does not await a hostile cancel promise');
});

test('already-aborted and timeout requests never call transport and never expose abort reasons', async () => {
  let calls = 0;
  for (const reason of [new Error('UPSTREAM sensitive'), new DOMException('UPSTREAM sensitive', 'TimeoutError')]) {
    await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => { calls++; return Response.json({ results: [] }); },
      AbortSignal.abort(reason)), (error) => safeError(error, reason.name === 'TimeoutError' ? 'SEARCH_TIMEOUT' : 'SEARCH_CANCELLED'));
  }
  assert.equal(calls, 0);
});

test('fetch ignoring cancellation loses immediately; a later response is cleaned up without reading', async () => {
  const controller = new AbortController();
  let resolve!: (value: Response) => void, cancelled = 0, reads = 0, calls = 0;
  const pending = runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => {
    calls++; return new Promise<Response>((done) => { resolve = done; });
  }, controller.signal);
  const rejected = assert.rejects(pending, (error) => safeError(error, 'SEARCH_CANCELLED'));
  controller.abort(new Error('UPSTREAM sensitive'));
  await rejected;
  const body = new ReadableStream<Uint8Array>({ pull() { reads++; }, cancel() { cancelled++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  resolve(new Response(body)); await nextTurn();
  assert.equal(calls, 1); assert.equal(reads, 0); assert.equal(cancelled, 1);
});

test('abort wins simultaneous fetch success/rejection and releases listeners', async (t) => {
  for (const outcome of ['success', 'reject'] as const) {
    const controller = new AbortController();
    const add = t.mock.method(controller.signal, 'addEventListener'), remove = t.mock.method(controller.signal, 'removeEventListener');
    let cancelled = 0;
    await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, () => {
      controller.abort();
      return outcome === 'success' ? Promise.resolve(new Response(new ReadableStream({ cancel() { cancelled++; } })))
        : Promise.reject(new Error('UPSTREAM sensitive'));
    }, controller.signal), (error) => safeError(error, 'SEARCH_CANCELLED'));
    await nextTurn();
    assert.equal(cancelled, outcome === 'success' ? 1 : 0);
    assert.ok(add.mock.calls.length > 0); assert.ok(remove.mock.calls.length >= add.mock.calls.length);
    t.mock.restoreAll();
  }
});

test('pending stream reads race cancellation and cleanup does not wait for cancel completion', async () => {
  const controller = new AbortController();
  let entered!: () => void, cancelled = 0;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull() { entered(); return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  const pending = runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => new Response(body), controller.signal);
  const rejected = assert.rejects(pending, (error) => safeError(error, 'SEARCH_CANCELLED'));
  await ready; controller.abort(); await rejected;
  assert.equal(cancelled, 1); assert.equal(body.locked, false);
});

test('abort wins a simultaneous stream chunk or EOF', async () => {
  for (const eof of [false, true]) {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ pull(stream) {
      if (eof) stream.close(); else stream.enqueue(new TextEncoder().encode('{"results":[]}'));
      controller.abort();
    } }, { highWaterMark: 0 });
    await assert.rejects(runHttpSearch('tavily', key, { query, count: 2 }, {}, async () => new Response(body), controller.signal),
      (error) => safeError(error, 'SEARCH_CANCELLED'));
    assert.equal(body.locked, false);
  }
});

test('Kimi shares one deadline over all rounds and cancellation wins a hanging second round', async () => {
  const controller = new AbortController();
  const calls: Call[] = [];
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const pending = runHttpSearch('kimi', key, { query, count: 2 }, {}, async (input, options) => {
    calls.push(record(input, options));
    if (calls.length === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: 'search', type: 'function', function: { name: '$web_search', arguments: '{}' } },
    ] } }] });
    entered(); return new Promise<Response>(() => {});
  }, controller.signal);
  const rejected = assert.rejects(pending, (error) => safeError(error, 'SEARCH_TIMEOUT'));
  await ready; controller.abort(new DOMException('UPSTREAM sensitive', 'TimeoutError')); await rejected;
  assert.equal(calls.length, 2); assert.ok(calls.every((call) => call.signal === controller.signal));
});

test('Kimi cancellation on the first round EOF prevents any tool replay round', async () => {
  const controller = new AbortController();
  let calls = 0, reads = 0;
  const encoded = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
    { id: 'search', type: 'function', function: { name: '$web_search', arguments: '{}' } },
  ] } }] }));
  const body = new ReadableStream<Uint8Array>({ pull(stream) {
    if (++reads === 1) stream.enqueue(encoded); else { stream.close(); controller.abort(); }
  } }, { highWaterMark: 0 });
  await assert.rejects(runHttpSearch('kimi', key, { query, count: 2 }, {}, async () => { calls++; return new Response(body); }, controller.signal),
    (error) => safeError(error, 'SEARCH_CANCELLED'));
  assert.equal(calls, 1);
});
