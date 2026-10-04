import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

type Stored = Record<string, Credential>;

/**
 * pi-ai credential storage in one 0600 JSON file. The data-directory lock keeps
 * a single writer process; writes are serialized here and replaced atomically.
 */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private path: string) {}
  private load(): Stored {
    const info = lstatSync(this.path, { throwIfNoEntry: false });
    if (!info) return {};
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Credential store must be a regular file.');
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as { version?: number; credentials?: Stored };
    if (value.version !== 1 || typeof value.credentials !== 'object' || value.credentials === null) throw new Error('Unsupported credential store format.');
    return value.credentials;
  }
  private save(credentials: Stored) {
    const temporary = `${this.path}.tmp`;
    rmSync(temporary, { force: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, credentials }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.path);
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }
  async read(providerId: string) { return this.load()[providerId]; }
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.serial(async () => {
      const next = await fn(this.load()[providerId]);
      if (next === undefined) return this.load()[providerId];
      this.save({ ...this.load(), [providerId]: next });
      return next;
    });
  }
  delete(providerId: string) {
    return this.serial(async () => {
      const credentials = this.load();
      if (!(providerId in credentials)) return;
      delete credentials[providerId];
      this.save(credentials);
    });
  }
}
