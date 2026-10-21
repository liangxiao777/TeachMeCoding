import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Projects } from './projects.js';

test('real nested files, collisions, external changes, renames and failed saves never silently overwrite data', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-files-')); const space = randomUUID(); const p = new Projects(root);
  const disk = join(root, 'projects', space);
  try {
    for (const path of ['src', 'src/nested', 'examples']) p.create(space, { path, kind: 'directory' });
    for (const path of ['src/nested/main.rs', 'examples/main.rs']) p.create(space, { path, kind: 'file' });
    assert.throws(() => p.create(space, { path: 'src', kind: 'file' }), { message: 'PROJECT_FILE_CONFLICT' });
    const original = p.read(space, 'src/nested/main.rs');
    const saved = p.save(space, { ...original, content: 'fn main() { println!("17"); }' });
    assert.equal(readFileSync(join(disk, saved.path), 'utf8'), saved.content);
    assert.equal(p.read(space, 'examples/main.rs').content, '');
    writeFileSync(join(disk, saved.path), 'external modification');
    assert.throws(() => p.save(space, { ...saved, content: 'local changes' }), { message: 'PROJECT_FILE_CONFLICT' });
    assert.equal(p.read(space, saved.path).content, 'external modification');
    const dir = p.tree(space).find((e) => e.path === 'src')!;
    p.rename(space, { path: 'src', destination: 'source', version: dir.version });
    assert.equal(p.read(space, 'source/nested/main.rs').content, 'external modification');
    assert.throws(() => p.read(space, original.path), { message: 'PROJECT_PATH_NOT_FOUND' });
    const entry = p.tree(space).find((e) => e.path === 'source/nested/main.rs')!;
    assert.throws(() => p.rename(space, { ...entry, destination: 'examples/main.rs' }), /./); // strict protocol rejects extra kind
    assert.throws(() => p.rename(space, { path: entry.path, destination: 'examples/main.rs', version: entry.version }), { message: 'PROJECT_FILE_CONFLICT' });
    const latest = p.read(space, entry.path);
    chmodSync(join(disk, 'source/nested'), 0o500);
    assert.throws(() => p.save(space, { ...latest, content: 'not saved' }), /EACCES/);
    chmodSync(join(disk, 'source/nested'), 0o700);
    assert.equal(p.read(space, entry.path).content, 'external modification');
    assert.equal(readdirSync(join(disk, 'source/nested')).length, 1);
  } finally { chmodSync(join(disk, 'source/nested'), 0o700); rmSync(root, { recursive: true, force: true }); }
});

test('existing and missing paths reject traversal, symlinks, project-root links and hardlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmc-boundary-')); const space = randomUUID(); const p = new Projects(root);
  try {
    p.create(space, { path: 'safe', kind: 'directory' });
    for (const path of ['../outside', '/etc/passwd', 'safe/../../outside', 'C:\\outside', 'safe//a', 'safe/./a', 'safe/../a', 'safe\0/a']) {
      assert.throws(() => p.create(space, { path, kind: 'file' }), { message: 'PROJECT_UNSAFE_PATH' });
      assert.throws(() => p.read(space, path), { message: 'PROJECT_UNSAFE_PATH' });
    }
    const disk = join(root, 'projects', space);
    writeFileSync(join(root, 'outside'), 'sentinel');
    symlinkSync(root, join(disk, 'linked'));
    symlinkSync(join(root, 'outside'), join(disk, 'file-link'));
    symlinkSync(join(root, 'not-yet-created'), join(disk, 'dangling'));
    for (const path of ['linked/new', 'file-link', 'dangling', 'linked/missing/new']) {
      assert.throws(() => p.create(space, { path, kind: 'file' }), { message: 'PROJECT_UNSAFE_PATH' });
      assert.throws(() => p.read(space, path), { message: 'PROJECT_UNSAFE_PATH' });
    }
    assert.throws(() => p.tree(space), { message: 'PROJECT_UNSAFE_PATH' });
    linkSync(join(root, 'outside'), join(disk, 'hardlink'));
    assert.throws(() => p.read(space, 'hardlink'), { message: 'PROJECT_UNSAFE_PATH' });
    const other = randomUUID(); symlinkSync(root, join(root, 'projects', other));
    assert.throws(() => p.create(other, { path: 'new', kind: 'file' }), { message: 'PROJECT_UNSAFE_PATH' });
    assert.equal(readFileSync(join(root, 'outside'), 'utf8'), 'sentinel');
    assert.equal(readdirSync(root).includes('new'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
