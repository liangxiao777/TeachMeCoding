import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { hash } from './context.js';

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
      const buffer = Buffer.alloc(limit), { bytesRead } = await handle.read(buffer, 0, limit, offset);
      const after = await handle.stat({ bigint: true });
      if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) throw new Error('File changed during read; read again.');
      signal?.throwIfAborted();
      const data = buffer.subarray(0, bytesRead);
      const version = hash(`${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}:${after.size}`);
      return { text: data.toString('utf8'), base64: data.includes(0) ? data.toString('base64') : undefined,
        nextOffset: BigInt(offset + bytesRead) < after.size ? offset + bytesRead : null,
        source: { kind: 'disk', id: hash(full), version, hash: hash(data.toString('base64')), range: { offset, bytes: bytesRead }, capturedAt: Date.now() } };
    } finally { await handle.close(); }
  };
  const pathSchema = Type.String({ description: 'Path relative to cwd, absolute, ../ or ~/; cwd is not a sandbox.' });
  const offsetSchema = Type.Optional(Type.Integer({ minimum: 0, default: 0 }));
  const readSchema = Type.Object({ path: pathSchema, offset: offsetSchema, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192, default: 4096 })) });
  const searchSchema = Type.Object({ path: pathSchema, pattern: Type.Optional(Type.String({ maxLength: 200 })), offset: offsetSchema });
  const tools: AgentTool[] = [{ name: 'read', label: '读取文件', description: `Read a byte page (UTF-8, with base64 for binary). Default cwd: ${cwd}. Version is observed at actual read time; changed files have new versions.`,
    parameters: readSchema,
    async execute(_id, raw, signal) {
      const args = raw as { path: string; offset?: number; limit?: number }; // Validated by Pi against parameters.
      const value = await read(args.path, args.offset ?? 0, args.limit ?? 4096, signal);
      return result(value, [value.source]);
    },
  }];
  for (const name of ['ls', 'find', 'grep'] as const) tools.push({ name, label: name, description:
    name === 'ls' ? 'List a directory, including dotfiles. Paginated; no path fence.' : name === 'find' ? 'Find names containing literal pattern, recursively; bounded traversal.' : 'Search literal text in the first 8192 bytes of each file. Results explicitly report this partial range; use read to continue.',
    parameters: searchSchema,
    async execute(_id, raw, signal) {
      const args = raw as { path: string; offset?: number; pattern?: string }; // Validated by Pi against parameters.
      const items: unknown[] = [], sources: unknown[] = []; let scanned = 0, matched = 0, truncated = false;
      const visit = async (directory: string, depth: number) => {
        signal?.throwIfAborted();
        if (depth > 20 || scanned >= 2000 || items.length >= 30) { truncated = true; return; }
        const dir = await opendir(directory);
        for await (const entry of dir) {
          signal?.throwIfAborted();
          if (++scanned > 2000 || items.length >= 30) { truncated = true; break; }
          const full = resolve(directory, entry.name);
          if (name === 'ls' || name === 'find' && entry.name.includes(args.pattern ?? '')) {
            if (matched++ >= (args.offset ?? 0)) items.push({ path: full, kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' });
          }
          if (name === 'grep' && entry.isFile()) {
            const value = await read(full, 0, 8192, signal);
            sources.push(value.source);
            if (value.text.includes(args.pattern ?? '')) {
              if (matched++ >= (args.offset ?? 0)) items.push({ path: full, excerpts: value.text.split('\n').filter((line) => line.includes(args.pattern ?? '')).slice(0, 3).map((line) => line.slice(0, 250)), source: value.source, nextOffset: value.nextOffset });
            }
          }
          // Directory symlinks can be explicitly passed as path; do not recursively follow cycles.
          if (name !== 'ls' && entry.isDirectory()) await visit(full, depth + 1);
        }
      };
      await visit(path(args.path), 0);
      return result({ items, scanned, truncated, nextOffset: truncated ? (args.offset ?? 0) + items.length : null,
        scope: name === 'grep' ? 'first 8192 bytes per regular file; narrow path or use read for remainder' : 'directory traversal, no recursive symlink following' }, sources);
    },
  });
  return tools;
}
