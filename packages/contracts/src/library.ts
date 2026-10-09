import { z } from 'zod';
import { idSchema } from './workspace.js';

export const libraryFileLimit = 100 * 1024 * 1024;
export const libraryNameSchema = z.string().min(1).max(255).refine((name) =>
  name !== '.' && name !== '..' && !/[\/\\\x00-\x1f\x7f]/.test(name) && new TextEncoder().encode(name).length <= 255,
  '请使用不含路径的文件名。');
export const libraryDocumentSchema = z.object({
  id: idSchema, name: libraryNameSchema, size: z.number().int().min(0).max(libraryFileLimit),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number().int().nonnegative(),
}).strict();
export type LibraryDocument = z.infer<typeof libraryDocumentSchema> & { path: string };
export interface LibraryState {
  files: LibraryDocument[];
  maxFileBytes: number;
}
