// Never spread process.env into a learning-code process. This is not a sandbox:
// the program still has the user's OS permissions and can read accessible files.
export function terminalEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { TERM: 'xterm-256color' };
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}
