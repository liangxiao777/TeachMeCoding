import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { hash } from './context.js';

const utf8Size = (byte: number) => byte < 0x80 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;
const utf8Start = (data: Buffer, index: number) => {
  for (let start = Math.max(0, index - 3); start < index; start++) {
    const end = start + utf8Size(data[start]!);
    if (end > index && end <= data.length && isUtf8(data.subarray(start, end))) return start;
  }
  return index;
};

// First-party bounded OS reads. No project fence, credential-name filter or shell process.
// Avoid importing the coding-agent session/extension host just to expose these four tools.
export function readTools(cwd: string): AgentTool[] {
  const path = (input: string) => resolve(cwd, input === '~' ? homedir() : input.startsWith('~/') ? `${homedir()}/${input.slice(2)}` : input);
  const result = (value: unknown, sources: unknown[]) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: { sources } });
  const read = async (input: string, offset: number, limit: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const full = path(input), handle = await open(full, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error('Read requires a regular file; use ls for directories.');
      // At most three bytes of lookaround on each side; only served bytes enter the source hash/range.
      const windowOffset = Math.max(0, offset - 3), buffer = Buffer.alloc(offset - windowOffset + limit + 3);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, windowOffset), window = buffer.subarray(0, bytesRead);
      const after = await handle.stat({ bigint: true });
      if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) throw new Error('File changed during read; read again.');
      signal?.throwIfAborted();
      let start = offset - windowOffset, end = Math.min(start + limit, bytesRead);
      // NUL/binary pages retain exact requested byte offsets, lengths and base64 content.
      if (!window.subarray(start, end).includes(0)) {
        start = utf8Start(window, start);
        end = utf8Start(window, Math.min(start + limit, bytesRead));
        if (end === start && start < bytesRead) end = start + utf8Size(window[start]!);
      }
      const data = window.subarray(start, Math.max(start, end)), servedOffset = windowOffset + start;
      const version = hash(`${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}:${after.size}`);
      return { text: data.toString('utf8'), base64: data.includes(0) ? data.toString('base64') : undefined,
        nextOffset: BigInt(servedOffset + data.length) < after.size ? servedOffset + data.length : null,
        source: { kind: 'disk', id: hash(full), version, hash: hash(data.toString('base64')), range: { offset: servedOffset, bytes: data.length }, capturedAt: Date.now() } };
    } finally { await handle.close(); }
  };
  const pathSchema = Type.String({ description: 'Path relative to cwd, absolute, ../ or ~/; cwd is not a sandbox.' });
  const offsetSchema = Type.Optional(Type.Integer({ minimum: 0, default: 0 }));
  const readSchema = Type.Object({ path: pathSchema, offset: offsetSchema, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192, default: 4096 })) });
  const lsSchema = Type.Object({ path: pathSchema, offset: offsetSchema });
  const findSchema = Type.Object({ path: pathSchema, pattern: Type.Optional(Type.String({ maxLength: 200 })), offset: offsetSchema });
  const grepSchema = Type.Object({ path: pathSchema, pattern: Type.String({ minLength: 1, maxLength: 200 }), offset: offsetSchema });
  const tools: AgentTool[] = [{ name: 'read', label: '读取文件', description: `Read a byte page (UTF-8, with base64 for NUL/binary pages). UTF-8 offsets inside a character align back; page ends stop before split characters. A tiny limit serves the first complete character (at most max(limit, 4) bytes). Use returned nextOffset, not requested offset + limit, to continue; source.range reports actual served bytes. Default cwd: ${cwd}. Version is observed at actual read time; changed files have new versions.`,
    parameters: readSchema,
    async execute(_id, raw, signal) {
      const args = raw as { path: string; offset?: number; limit?: number }; // Validated by Pi against parameters.
      const value = await read(args.path, args.offset ?? 0, args.limit ?? 4096, signal);
      return result(value, [value.source]);
    },
  }];
  for (const name of ['ls', 'find', 'grep'] as const) tools.push({ name, label: name, description:
    (name === 'ls' ? 'List a directory, including dotfiles; no path fence.' : name === 'find' ? 'Find names containing optional literal pattern, recursively.' : 'Search required nonempty literal text (spaces preserved) in a regular file or directory, in the first 8192 bytes of each file. Results explicitly report this partial byte range; use read to continue.') + ' Match-count pagination: follow nextOffset. At most 30 items, 2000 scanned entries and depth 20; truncated searches are partial and require a narrower path, not another offset.',
    parameters: name === 'ls' ? lsSchema : name === 'find' ? findSchema : grepSchema,
    async execute(_id, raw, signal) {
      const args = raw as { path: string; offset?: number; pattern?: string }; // Validated by Pi against parameters.
      const items: unknown[] = [], sources: unknown[] = []; let scanned = 0, matched = 0, hasMore = false, scanLimited = false, depthLimited = false;
      const match = (item: unknown) => {
        if (matched++ < (args.offset ?? 0)) return;
        if (items.length < 30) items.push(item);
        else hasMore = true; // One extra match proves there is a next page within the traversal budget.
      };
      const grep = async (full: string) => {
        const value = await read(full, 0, 8192, signal);
        sources.push(value.source);
        if (value.text.includes(args.pattern!)) {
          match({ path: full, excerpts: value.text.split('\n').filter((line) => line.includes(args.pattern!)).slice(0, 3).map((line) => line.slice(0, 250).replace(/[\uD800-\uDBFF]$/, '')), source: value.source, nextOffset: value.nextOffset });
        }
      };
      const visit = async (directory: string, depth: number) => {
        signal?.throwIfAborted();
        if (hasMore || scanLimited) return;
        if (depth > 20) { depthLimited = true; return; }
        const dir = await opendir(directory);
        for await (const entry of dir) {
          signal?.throwIfAborted();
          if (scanned >= 2000) { scanLimited = true; break; }
          scanned++;
          const full = resolve(directory, entry.name);
          if (name === 'ls' || name === 'find' && entry.name.includes(args.pattern ?? '')) {
            match({ path: full, kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' });
          }
          if (name === 'grep' && entry.isFile()) await grep(full);
          // Directory symlinks can be explicitly passed as path; do not recursively follow cycles.
          if (name !== 'ls' && entry.isDirectory()) await visit(full, depth + 1);
          if (hasMore || scanLimited) break;
        }
      };
      signal?.throwIfAborted();
      const full = path(args.path);
      if (name === 'grep' && (await stat(full)).isFile()) { scanned++; await grep(full); }
      else await visit(full, 0);
      signal?.throwIfAborted();
      const truncated = scanLimited || depthLimited;
      return result({ items, scanned, truncated, nextOffset: hasMore && !truncated ? (args.offset ?? 0) + items.length : null,
        warning: truncated ? `Search is partial (${scanLimited ? 'scan limit 2000' : 'depth limit 20'}); narrow the path instead of continuing with an offset.` : undefined,
        scope: name === 'grep' ? 'first 8192 bytes per regular file; narrow path or use read for remainder' : 'directory traversal, no recursive symlink following' }, sources);
    },
  });
  return tools;
}
