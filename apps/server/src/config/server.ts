export function serverConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.PORT ?? '4310';
  const port = Number(value);
  if (!/^[1-9]\d*$/.test(value) || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  // HOST is intentionally not configurable: this application runs locally only.
  return { hostname: '127.0.0.1', port, development: environment.NODE_ENV === 'development' };
}
