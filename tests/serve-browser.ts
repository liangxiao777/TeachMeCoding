import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedWorkspaces } from './seed-workspaces.js';

const mode = process.argv[2];
if (mode !== 'production' && mode !== 'development') throw new Error('Choose a serving mode');
const root = mkdtempSync(join(tmpdir(), `tmc-browser-${mode}-`));
mkdirSync('.amp/in', { recursive: true });
const metadata = `.amp/in/browser-${mode}.json`;
writeFileSync(metadata, JSON.stringify(seedWorkspaces(root)));
const child = spawn(process.execPath, mode === 'production' ? ['apps/server/dist/index.js'] : ['--import', 'tsx', 'apps/server/src/index.ts'], {
  stdio: 'inherit', env: { ...process.env, OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '', NODE_ENV: mode, TMC_DATA_DIR: root, PORT: mode === 'production' ? '14320' : '14321', TMC_WEB_PORT: '15173' },
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => { rmSync(root, { recursive: true, force: true }); rmSync(metadata, { force: true }); process.exitCode = code ?? 0; });
