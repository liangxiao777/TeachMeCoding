import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable release version is required.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('Release tag and package version must match.');
}
const directory = `${name}-${version}`, filename = `${directory}.tar.gz`;
const output = join(root, '.amp/in/artifacts/release');
const temporary = mkdtempSync(join(tmpdir(), 'tmc-release-'));
try {
  const bundle = join(temporary, directory);
  // Copy only distributable files; never include local data, .env, or native
  // dependencies built for the packager's operating system and architecture.
  for (const path of [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version', '.env.example',
    'LICENSE', 'README.md', 'README.zh.md', 'SECURITY.md', 'SECURITY.zh.md',
    'CONTRIBUTING.md', 'CONTRIBUTING.zh.md', 'AGENTS.md', 'AGENTS.zh.md', 'docs', 'patches',
    'scripts/server.mjs', 'apps/server/package.json', 'apps/server/dist',
    'apps/web/package.json', 'apps/web/dist', 'apps/web/public/icon.svg',
    'packages/contracts/package.json', 'packages/contracts/dist',
  ]) {
    mkdirSync(dirname(join(bundle, path)), { recursive: true });
    cpSync(join(root, path), join(bundle, path), { recursive: true });
  }
  mkdirSync(output, { recursive: true });
  execFileSync('tar', ['-czf', join(output, filename), '-C', temporary, directory], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'inherit',
  });
  const checksum = createHash('sha256').update(readFileSync(join(output, filename))).digest('hex');
  writeFileSync(join(output, 'SHA256SUMS'), `${checksum}  ${filename}\n`);
  console.log(join(output, filename));
} finally { rmSync(temporary, { recursive: true, force: true }); }
