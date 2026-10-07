import { z } from 'zod';
import { parseHTML } from 'linkedom/worker';
import type { SearchProvider, WebSearchResult } from '@teach-me-coding/contracts';
import { BusinessError } from '../modules/learning.js';

export const searchModelDefaults = { gemini: 'gemini-3.6-flash', grok: 'grok-4.7', kimi: 'kimi-k2.6' } as const;

type HttpProvider = Exclude<SearchProvider, 'codex'>;
type Configuration = { model?: string; region?: 'global' | 'cn' };
type SearchOutput = { results: WebSearchResult[]; answer?: string };
type Entry = { title?: unknown; url?: unknown; snippet?: unknown };
type JsonObject = Record<string, unknown>;
const maxResponseBytes = 1024 * 1024;
const row = { title: z.string().nullish(), url: z.string() };
// Keep the existing providers' validation and empty-response semantics intact.
const braveResponse = z.object({ type: z.literal('search'), query: z.object({ original: z.string() }),
  web: z.object({ results: z.array(z.object({ ...row, description: z.string().nullish() })) }).nullish() });
const tavilyResponse = z.object({ results: z.array(z.object({ ...row, content: z.string().nullish() })) });
const exaResponse = z.object({ results: z.array(z.object({ ...row, highlights: z.array(z.string()).nullish(),
  summary: z.string().nullish(), text: z.string().nullish() })) });
const snippetResponse = z.object({ results: z.array(z.object({ ...row, snippet: z.string().nullish() })) });
const parallelResponse = z.object({ results: z.array(z.object({ ...row, excerpts: z.array(z.string()).nullish() })) });
const minimaxResponse = z.object({ organic: z.array(z.object({ title: row.title, link: z.string(), snippet: z.string().nullish() })) });

class HttpSearchError extends BusinessError {
  constructor(message: string) { super(503, message); }
}
function invalid(): never { throw new HttpSearchError('无法取得有效搜索结果，请检查网络或稍后重试。'); }
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && !!value.trim()) ?? '';
}
function safeUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048) return url;
  } catch { /* Untrusted result, not a navigation target. */ }
}
function ranked(entries: Entry[], count: number, deduplicate = false): WebSearchResult[] {
  const results: WebSearchResult[] = [], seen = new Set<string>();
  for (const entry of entries) {
    const url = safeUrl(entry.url);
    if (!url || deduplicate && seen.has(url.href)) continue;
    seen.add(url.href);
    results.push({ title: (firstString(entry.title).trim() || url.hostname).slice(0, 500), url: url.href,
      snippet: firstString(entry.snippet).trim().slice(0, 2000) });
    if (results.length === count) break;
  }
  return results;
}
function cancelBody(body: ReadableStream<Uint8Array> | null | undefined) {
  try { void body?.cancel().catch(() => {}); } catch { /* Cleanup must not replace the result or wait on an upstream stream. */ }
}

/** Abort wins even when a mock/transport ignores the signal or resolves in the same turn. */
function abortable<T>(start: () => Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      Promise.resolve(start()).then((value) => {
        signal.removeEventListener('abort', abort);
        if (settled || signal.aborted) { discard?.(value); abort(); return; }
        settled = true; resolve(value);
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort);
        if (settled) return;
        if (signal.aborted) { abort(); return; }
        settled = true; reject(error);
      });
    } catch (error) {
      signal.removeEventListener('abort', abort);
      if (!settled) { settled = true; reject(signal.aborted ? signal.reason : error); }
    }
  });
}

async function responseText(url: URL, headers: Record<string, string>, body: unknown | undefined,
  request: typeof fetch, signal: AbortSignal, html = false): Promise<string> {
  let response: Response | undefined;
  try {
    response = await abortable(() => request(url, { method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal }), signal, (late) => cancelBody(late.body));
    signal.throwIfAborted();
    if (response.redirected || !response.ok || html && response.status === 202) {
      const reason = response.status === 401 || response.status === 403 ? '认证失败，请检查 API Key。'
        : response.status === 429 ? '请求受限，请检查服务额度或稍后重试。' : '暂时不可用，请稍后重试。';
      throw new HttpSearchError(reason);
    }
    if (!response.body) invalid();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await abortable(() => reader.read(), signal);
        signal.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) invalid();
        chunks.push(value);
      }
    } finally {
      // Do not await cancel: a hostile source can leave cancellation pending forever.
      try { void reader.cancel().catch(() => {}); } catch { /* Already closed. */ }
      reader.releaseLock();
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally { cancelBody(response?.body); }
}
async function jsonResponse(url: string, headers: Record<string, string>, body: unknown | undefined,
  request: typeof fetch, signal: AbortSignal): Promise<JsonObject> {
  const value = object(JSON.parse(await responseText(new URL(url), headers, body, request, signal)));
  if (!value || value.success === false || value.error != null) invalid();
  return value;
}
function arrayRows(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) invalid();
  return value.map((entry) => object(entry) ?? invalid());
}

function firecrawlEntries(value: JsonObject): Entry[] {
  const data = object(value.data);
  let rows: unknown;
  if (Array.isArray(value.data)) rows = value.data;
  else if (data && ['web', 'news', 'images'].some((key) => key in data)) {
    rows = ['web', 'news', 'images'].flatMap((key) => key in data ? arrayRows(data[key]) : []);
  } else rows = value.results ?? data?.results ?? data?.data ?? object(value.web)?.results;
  return arrayRows(rows).map((entry) => {
    const metadata = object(entry.metadata);
    return { url: firstString(entry.url, entry.sourceURL, entry.sourceUrl, metadata?.sourceURL),
      title: firstString(entry.title, metadata?.title), snippet: firstString(entry.description, entry.snippet, entry.summary) };
  });
}

function duckduckgoEntries(html: string): Entry[] {
  const { document } = parseHTML(html);
  // Challenge detection is deliberately conservative; no captcha execution or bypass.
  if (document.querySelector('#challenge-form, #img-form, form[action*="anomaly"], form[action*="challenge"], [id*="captcha"], .anomaly-modal')
    || /anomaly\.js|bots use DuckDuckGo too|select all squares|verify (?:that )?you are (?:a )?human|please complete the captcha/i.test(html)) invalid();
  const anchors = Array.from(document.querySelectorAll('a.result__a'));
  if (!anchors.length) {
    const noResults = document.querySelector('.no-results, .no-results__message, .result--no-result');
    if (noResults && /no (?:more )?results|no (?:web )?results found/i.test(noResults.textContent ?? '')) return [];
    invalid();
  }
  return anchors.map((anchor) => {
    let href = anchor.getAttribute('href') ?? '';
    try {
      const url = new URL(href, 'https://html.duckduckgo.com');
      if (['duckduckgo.com', 'www.duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) && url.pathname === '/l/') {
        href = url.searchParams.get('uddg') ?? '';
      } else if (href.startsWith('//')) href = url.href;
      else if (!/^https?:/i.test(href)) href = '';
    } catch { href = ''; }
    const container = anchor.closest('.result') ?? anchor.closest('.web-result');
    return { title: anchor.textContent, url: href, snippet: container?.querySelector('.result__snippet')?.textContent ?? '' };
  });
}

function citations(value: unknown): Entry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return { url: entry };
    const source = object(entry);
    return { url: source?.url ?? source?.uri, title: source?.title, snippet: source?.snippet ?? source?.content };
  });
}
function synthesized(answer: string, entries: Entry[], grounded: boolean, count: number): SearchOutput {
  if (!answer.trim() || !grounded) invalid();
  return { results: ranked(entries, count, true), answer: answer.trim().slice(0, 20_000) };
}

function geminiResults(value: JsonObject, count: number): SearchOutput {
  const candidate = object(Array.isArray(value.candidates) ? value.candidates[0] : undefined);
  const content = object(candidate?.content), grounding = object(candidate?.groundingMetadata);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const answer = parts.map((part) => firstString(object(part)?.text)).filter(Boolean).join('\n');
  const entries = (Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks : []).map((chunk): Entry => {
    const web = object(object(chunk)?.web);
    return { url: web?.uri, title: web?.title };
  });
  const queries = strings(grounding?.webSearchQueries).some((query) => !!query.trim());
  const supports = Array.isArray(grounding?.groundingSupports) && grounding.groundingSupports.some((support) => {
    const item = object(support), segment = object(item?.segment);
    return !!firstString(segment?.text) && Array.isArray(item?.groundingChunkIndices)
      && item.groundingChunkIndices.some((index) => Number.isInteger(index) && index >= 0);
  });
  return synthesized(answer, entries, entries.some((entry) => !!safeUrl(entry.url)) || queries || supports, count);
}

function grokResults(value: JsonObject, count: number): SearchOutput {
  if (value.status !== undefined && value.status !== 'completed') invalid();
  const entries = citations(value.citations), texts: string[] = [];
  let searched = false;
  for (const output of Array.isArray(value.output) ? value.output : []) {
    const item = object(output);
    if (!item) invalid();
    if (item.status !== undefined && item.status !== 'completed' || item.error != null) invalid();
    if (item.type === 'web_search_call' && item.status === 'completed') searched = true;
    if (item.type !== 'message') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      const part = object(content);
      if (part?.type !== 'output_text') continue;
      const text = firstString(part.text);
      if (text) texts.push(text);
      for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
        const source = object(annotation);
        if (source?.type === 'url_citation') entries.push(...citations([object(source.url_citation) ?? source]));
      }
    }
  }
  return synthesized(texts.join('\n') || firstString(value.output_text), entries,
    searched || entries.some((entry) => !!safeUrl(entry.url)), count);
}

async function kimiResults(apiKey: string, input: { query: string; count: number }, configuration: Configuration,
  request: typeof fetch, signal: AbortSignal): Promise<SearchOutput> {
  const model = configuration.model ?? searchModelDefaults.kimi;
  const url = configuration.region === 'cn' ? 'https://api.moonshot.cn/v1/chat/completions' : 'https://api.moonshot.ai/v1/chat/completions';
  const messages: JsonObject[] = [{ role: 'user', content: input.query }], entries: Entry[] = [];
  let searched = false;
  for (let round = 0; round < 3; round++) {
    const value = await jsonResponse(url, { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      { model, messages, tools: [{ type: 'builtin_function', function: { name: '$web_search' } }],
        ...(/^kimi-k2\.[56](?:$|-)/.test(model) ? { thinking: { type: 'disabled' } } : {}) }, request, signal);
    entries.push(...citations(value.search_results), ...citations(value.citations));
    const choice = object(Array.isArray(value.choices) ? value.choices[0] : undefined), message = object(choice?.message);
    if (!message || choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter') invalid();
    entries.push(...citations(message.search_results), ...citations(message.citations));
    if (message.tool_calls != null && !Array.isArray(message.tool_calls)) invalid();
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      if (choice?.finish_reason != null && choice.finish_reason !== 'stop') invalid();
      return synthesized(firstString(message.content), entries,
        searched || entries.some((entry) => !!safeUrl(entry.url)), input.count);
    }
    const replay = calls.map((call) => {
      const tool = object(call), fn = object(tool?.function);
      if (tool?.type !== 'function' || !firstString(tool.id) || fn?.name !== '$web_search' || typeof fn.arguments !== 'string' || !fn.arguments.trim()) invalid();
      try {
        const args = object(JSON.parse(fn.arguments));
        entries.push(...citations(args?.search_results), ...citations(args?.url ? [args] : []));
      } catch { /* Arguments are opaque replay data; parsing is only for optional citations. */ }
      return { role: 'tool', tool_call_id: tool.id, name: '$web_search', content: fn.arguments };
    });
    if (round === 2) invalid();
    searched = true;
    messages.push({ role: 'assistant', ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.reasoning_content !== undefined ? { reasoning_content: message.reasoning_content } : {}), tool_calls: calls }, ...replay);
  }
  return invalid();
}

/** Fixed official HTTPS transports; no retries, redirects, provider fallback or teaching-model auth. */
export async function runHttpSearch(provider: HttpProvider, apiKey: string | undefined, input: { query: string; count: number },
  configuration: Configuration, request: typeof fetch, signal: AbortSignal): Promise<SearchOutput> {
  try {
    signal.throwIfAborted();
    if (provider !== 'duckduckgo' && provider !== 'firecrawl-free' && !apiKey) {
      throw new HttpSearchError('认证失败，请检查 API Key。');
    }
    if (['gemini', 'grok', 'kimi'].includes(provider) && configuration.model !== undefined
      && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(configuration.model)) invalid();
    if (provider === 'kimi') {
      const result = await kimiResults(apiKey!, input, configuration, request, signal);
      signal.throwIfAborted(); return result;
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    let url: string, body: unknown | undefined;
    switch (provider) {
      case 'brave': {
        const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
        endpoint.searchParams.set('q', input.query); endpoint.searchParams.set('count', String(input.count));
        endpoint.searchParams.set('result_filter', 'web'); endpoint.searchParams.set('text_decorations', 'false');
        url = endpoint.href; headers['X-Subscription-Token'] = apiKey!; break;
      }
      case 'tavily': url = 'https://api.tavily.com/search'; headers.Authorization = `Bearer ${apiKey}`;
        body = { query: input.query, max_results: input.count }; break;
      case 'exa': url = 'https://api.exa.ai/search'; headers['x-api-key'] = apiKey!;
        body = { query: input.query, numResults: input.count, type: 'auto', contents: { highlights: true } }; break;
      case 'firecrawl': case 'firecrawl-free': url = 'https://api.firecrawl.dev/v2/search';
        if (provider === 'firecrawl') headers.Authorization = `Bearer ${apiKey}`;
        body = { query: input.query, limit: input.count }; break;
      case 'parallel': url = 'https://api.parallel.ai/v1/search'; headers['x-api-key'] = apiKey!;
        headers['User-Agent'] = 'TeachMeCoding/1.0';
        body = { search_queries: [input.query], advanced_settings: { max_results: input.count } }; break;
      case 'perplexity': url = 'https://api.perplexity.ai/search'; headers.Authorization = `Bearer ${apiKey}`;
        body = { query: input.query, max_results: input.count }; break;
      case 'minimax': url = configuration.region === 'cn' ? 'https://api.minimaxi.com/v1/coding_plan/search' : 'https://api.minimax.io/v1/coding_plan/search';
        headers.Authorization = `Bearer ${apiKey}`; body = { q: input.query }; break;
      case 'ollama': url = 'https://ollama.com/api/web_search'; headers.Authorization = `Bearer ${apiKey}`;
        body = { query: input.query, max_results: input.count }; break;
      case 'gemini': url = `https://generativelanguage.googleapis.com/v1beta/models/${configuration.model ?? searchModelDefaults.gemini}:generateContent`;
        headers['x-goog-api-key'] = apiKey!; body = { contents: [{ parts: [{ text: input.query }] }], tools: [{ google_search: {} }] }; break;
      case 'grok': url = 'https://api.x.ai/v1/responses'; headers.Authorization = `Bearer ${apiKey}`;
        body = { model: configuration.model ?? searchModelDefaults.grok, input: [{ role: 'user', content: input.query }], tools: [{ type: 'web_search' }], store: false }; break;
      case 'duckduckgo': {
        const endpoint = new URL('https://html.duckduckgo.com/html'); endpoint.searchParams.set('q', input.query); endpoint.searchParams.set('kp', '-1');
        const html = await responseText(endpoint, { Accept: 'text/html',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' }, undefined, request, signal, true);
        const result = { results: ranked(duckduckgoEntries(html), input.count) };
        signal.throwIfAborted(); return result;
      }
      default: return invalid();
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const value = await jsonResponse(url, headers, body, request, signal);
    let entries: Entry[];
    switch (provider) {
      case 'brave': entries = (braveResponse.parse(value).web?.results ?? []).map((entry) => ({ ...entry, snippet: entry.description ?? '' })); break;
      case 'tavily': entries = tavilyResponse.parse(value).results.map((entry) => ({ ...entry, snippet: entry.content ?? '' })); break;
      case 'exa': entries = exaResponse.parse(value).results.map((entry) => ({ ...entry,
        snippet: entry.highlights?.map((text) => text.trim()).filter(Boolean).join('\n') || entry.summary || entry.text || '' })); break;
      case 'firecrawl': case 'firecrawl-free': entries = firecrawlEntries(value); break;
      case 'parallel': entries = parallelResponse.parse(value).results.map((entry) => ({ ...entry, snippet: entry.excerpts?.join('\n') ?? '' })); break;
      case 'perplexity': entries = snippetResponse.parse(value).results; break;
      case 'minimax': {
        if (value.base_resp !== undefined && object(value.base_resp)?.status_code !== 0) invalid();
        entries = minimaxResponse.parse(value).organic.map((entry) => ({ ...entry, url: entry.link })); break;
      }
      case 'ollama': entries = tavilyResponse.parse(value).results.map((entry) => ({ ...entry, snippet: entry.content })); break;
      case 'gemini': { const result = geminiResults(value, input.count); signal.throwIfAborted(); return result; }
      case 'grok': { const result = grokResults(value, input.count); signal.throwIfAborted(); return result; }
    }
    const result = { results: ranked(entries, input.count) };
    signal.throwIfAborted(); return result;
  } catch (error) {
    // No upstream bodies, schema values, credentials, model output or transport diagnostics in errors.
    if (signal.aborted) throw new BusinessError(503, signal.reason?.name === 'TimeoutError' ? '搜索请求超时，请重试。' : '搜索请求已取消。');
    if (error instanceof HttpSearchError) throw error;
    return invalid();
  }
}
