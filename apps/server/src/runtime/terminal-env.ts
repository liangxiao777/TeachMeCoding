// Never spread process.env into a learning-code process. This is not a sandbox:
// the program still has the user's OS permissions and can read accessible files.
export function terminalEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { TERM: 'xterm-256color' };
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
    'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
    // Windows environment names are case-insensitive; emit only one PATH even
    // when the source came from a plain object with a mixed-case Path property.
    const name = Object.keys(source).find((name) => name.toLowerCase() === key.toLowerCase());
    if (name !== undefined && source[name] !== undefined) env[key] = source[name];
  }
  return env;
}
