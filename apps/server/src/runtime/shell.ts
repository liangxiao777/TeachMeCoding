import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { terminalEnvironment } from './terminal-env.js';

/** One Bash dialect for agent tools, assessments and the interactive terminal. */
export function bashShell() {
  const config = getShellConfig();
  if (config.shell === 'sh') throw new Error('Bash is required.');
  return { file: config.shell, args: ['--noprofile', '--norc'], env: terminalEnvironment(process.env) };
}
