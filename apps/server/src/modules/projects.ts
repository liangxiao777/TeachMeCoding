import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createEntrySchema, idSchema, renameEntrySchema, saveFileSchema, type ProjectEntry, type ProjectFile } from '@teach-me-coding/contracts';
import { BusinessError } from './learning.js';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const forbidden = () => new BusinessError(422, { code: 'PROJECT_UNSAFE_PATH' });
const conflict = () => new BusinessError(409, { code: 'PROJECT_FILE_CONFLICT' });
const stat = (path: string) => {
  try { return lstatSync(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};

export class Projects {
  constructor(readonly dataRoot: string) {}
  root(space: string) {
    idSchema.parse(space);
    const projects = join(this.dataRoot, 'projects');
    const root = join(projects, space);
    for (const path of [projects, root]) {
      if (!stat(path)) mkdirSync(path, { mode: 0o700 });
      const info = stat(path)!;
      if (info.isSymbolicLink() || !info.isDirectory()) throw forbidden();
    }
    return root;
  }
  private path(root: string, relative: string, allowMissing = false) {
    const parts = relative.split('/');
    if (!relative || relative.length > 1000 || /[\\\x00-\x1f\x7f:]/.test(relative) || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.tmc-write-'))) throw forbidden();
    let path = root;
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]!);
      const info = stat(path);
      if (!info) {
        if (allowMissing && index === parts.length - 1) return path;
        throw new BusinessError(404, { code: 'PROJECT_PATH_NOT_FOUND' });
      }
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink > 1n)) throw forbidden();
      if (index < parts.length - 1 && !info.isDirectory()) throw forbidden();
    }
    return path;
  }
  private file(path: string, relative: string): ProjectFile {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink > 1n) throw forbidden();
      if (before.size > 1_000_000n) throw new BusinessError(413, { code: 'EDITOR_FILE_TOO_LARGE' });
      const data = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      if (before.mtimeNs !== after.mtimeNs || before.size !== after.size) throw conflict();
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new BusinessError(422, { code: 'EDITOR_UTF8_REQUIRED' }); }
      if (content.includes('\0')) throw new BusinessError(422, { code: 'EDITOR_BINARY_UNSUPPORTED' });
      return { path: relative, content, version: hash(`${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}:${hash(data)}`) };
    } finally { closeSync(fd); }
  }
  tree(space: string): ProjectEntry[] {
    const root = this.root(space);
    const entries: ProjectEntry[] = [];
    const visit = (relative: string, depth: number): string => {
      if (depth > 40 || entries.length > 5000) throw new BusinessError(413, { code: 'PROJECT_TREE_TOO_LARGE' });
      const path = relative ? this.path(root, relative) : root;
      const info = stat(path)!;
      if (info.isFile()) {
        // Listing is metadata-only, allowing unsupported/big files to remain visible.
        const version = hash(`${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`);
        entries.push({ path: relative, kind: 'file', version });
        return version;
      }
      const entry: ProjectEntry = { path: relative, kind: 'directory', version: '' };
      if (relative) entries.push(entry);
      const children = readdirSync(path).sort().filter((name) => !name.startsWith('.tmc-write-'));
      const versions = children.map((name) => `${name}:${visit(relative ? `${relative}/${name}` : name, depth + 1)}`);
      entry.version = hash(`${info.dev}:${info.ino}:${info.mtimeNs}:${versions.join('|')}`);
      return entry.version;
    };
    visit('', 0);
    return entries;
  }
  read(space: string, path: string) { return this.file(this.path(this.root(space), path), path); }
  newFile(space: string, relative: string, content: string) {
    if (Buffer.byteLength(content) > 1_000_000 || content.includes('\0')) throw new BusinessError(413, { code: 'PROJECT_TEXT_REQUIRED' });
    const path = this.path(this.root(space), relative, true);
    if (stat(path)) throw conflict();
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    return this.read(space, relative);
  }
  create(space: string, input: unknown) {
    const v = createEntrySchema.parse(input);
    const path = this.path(this.root(space), v.path, true);
    if (stat(path)) throw conflict();
    if (v.kind === 'directory') mkdirSync(path, { mode: 0o700 });
    else { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
    return { path: v.path };
  }
  save(space: string, input: unknown): ProjectFile {
    const v = saveFileSchema.parse(input);
    if (Buffer.byteLength(v.content) > 1_000_000 || v.content.includes('\0')) throw new BusinessError(413, { code: 'PROJECT_TEXT_REQUIRED' });
    const root = this.root(space), path = this.path(root, v.path);
    if (this.file(path, v.path).version !== v.version) throw conflict();
    const temporary = join(dirname(path), `.tmc-write-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, Number(stat(path)!.mode & 0o777n));
      writeFileSync(fd, v.content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      // Recheck after writing, immediately before atomic replacement; never truncate the original on failure.
      if (this.file(this.path(root, v.path), v.path).version !== v.version) throw conflict();
      renameSync(temporary, path);
      return this.read(space, v.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (stat(temporary)) unlinkSync(temporary);
    }
  }
  rename(space: string, input: unknown) {
    const v = renameEntrySchema.parse(input);
    const root = this.root(space), path = this.path(root, v.path), target = this.path(root, v.destination, true);
    if (stat(target) || v.destination.startsWith(`${v.path}/`)) throw conflict();
    const entry = this.tree(space).find((e) => e.path === v.path);
    if (entry?.version !== v.version) throw conflict();
    renameSync(path, target);
    return { path: v.destination };
  }
}
