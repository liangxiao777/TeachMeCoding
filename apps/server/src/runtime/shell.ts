import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { terminalEnvironment } from './terminal-env.js';

/** One Bash dialect for agent tools, assessments and the interactive terminal. */
export function bashShell() {
  const local = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : undefined;
  const config = getShellConfig(local && existsSync(local) ? local : undefined);
  // Pi can fall back to sh or the legacy WSL launcher. Neither runs our native
  // Bash commands against the same filesystem and toolchains as the Node host.
  if (config.shell === 'sh' || config.commandTransport === 'stdin') {
    throw new Error('Bash is required. On Windows, install Git for Windows (not the WSL bash launcher).');
  }
  const env = terminalEnvironment(process.env);
  if (process.platform === 'win32') {
    // --noprofile deliberately skips Git's /etc/profile PATH setup.
    env.PATH = [dirname(config.shell), resolve(dirname(config.shell), '../usr/bin'), env.PATH].filter(Boolean).join(';');
    // Assessment arguments are data, not MSYS paths to rewrite for native tools.
    env.MSYS_NO_PATHCONV = '1'; env.MSYS2_ARG_CONV_EXCL = '*';
  }
  return { file: config.shell, args: ['--noprofile', '--norc'], env };
}
