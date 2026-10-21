import { Hono } from 'hono';
import { libraryFileLimit } from '@teach-me-coding/contracts';
import { BusinessError } from '../modules/learning.js';
import type { Library } from '../modules/library.js';

export function libraryApi(library?: Library) {
  const api = new Hono();
  api.onError((error, c) => {
    if (error instanceof BusinessError) return c.json(error.toResponse(), error.status);
    if (error.name === 'ZodError' || error instanceof SyntaxError) return c.json({ code: 'INVALID_LIBRARY_REQUEST' }, 400);
    return c.json({ code: 'LIBRARY_STORAGE_UNAVAILABLE' }, 503);
  });
  api.use('/library', async (_c, next) => {
    if (!library) throw new BusinessError(503, { code: 'LIBRARY_UNAVAILABLE' });
    await next();
  });
  api.use('/library/*', async (_c, next) => {
    if (!library) throw new BusinessError(503, { code: 'LIBRARY_UNAVAILABLE' });
    await next();
  });
  api.get('/library', (c) => c.json(library!.state()));
  api.post('/library/files', async (c) => {
    const length = Number(c.req.header('Content-Length'));
    if (length > libraryFileLimit) throw new BusinessError(413, { code: 'LIBRARY_FILE_TOO_LARGE' });
    return c.json(await library!.upload(c.req.header('Idempotency-Key') ?? '', c.req.query('name') ?? '', c.req.raw.body, c.req.raw.signal), 201);
  });
  api.get('/library/files/:id', (c) => {
    const { file, stream } = library!.download(c.req.param('id'));
    // Never serve user HTML/SVG as same-origin active content.
    return c.newResponse(stream, { headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
    } });
  });
  api.post('/library/files/:id/delete', (c) => c.json(library!.remove(c.req.param('id'))));
  return api;
}
