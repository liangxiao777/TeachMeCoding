import { parsePreviewOrigin } from '@teach-me-coding/contracts';

export function serverConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.PORT ?? '4310';
  const port = Number(value);
  if (!/^[1-9]\d*$/.test(value) || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const hostname = environment.HOST ?? '127.0.0.1';
  if (hostname !== '127.0.0.1' && hostname !== '0.0.0.0') throw new Error('HOST must be 127.0.0.1 or 0.0.0.0.');
  const webPort = environment.TMC_WEB_PORT;
  if (webPort !== undefined && (!/^[1-9]\d*$/.test(webPort) || Number(webPort) > 65535)) throw new Error('TMC_WEB_PORT must be an integer between 1 and 65535.');
  const previewOrigin = parsePreviewOrigin(environment.TMC_PREVIEW_ORIGIN);
  return { hostname, port, development: environment.NODE_ENV === 'development', ...(webPort === undefined ? {} : { webPort: Number(webPort) }), ...(previewOrigin === undefined ? {} : { previewOrigin }) };
}
