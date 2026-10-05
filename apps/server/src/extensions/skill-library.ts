import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { loadSkills } from '@earendil-works/pi-coding-agent';
import type { SkillInstallation, SkillLeaderboard, SkillLeaderboardView, SkillSearch } from '@teach-me-coding/contracts';
import { BusinessError } from '../modules/learning.js';
import { descendants, stopProcesses } from '../runtime/processes.js';

const metadataFile = '.tmc-install.json';
const installationSchema = z.object({
  source: z.string(), skill: z.string(), ref: z.string().nullable(), upstreamHash: z.string().nullable(),
  contentHash: z.string(), cliVersion: z.string(), sourceUrl: z.string().optional(), skillPath: z.string().optional(),
});
const catalogSchema = z.object({ skills: z.array(z.object({
  id: z.string().min(1), source: z.string().min(1), skillId: z.string().min(1), name: z.string().min(1), installs: z.number().nonnegative(),
})) });
const leaderboardSchema = z.object({ skills: z.array(catalogSchema.shape.skills.element.omit({ id: true }).extend({ change: z.number().optional() })),
  total: z.number().int().nonnegative(), hasMore: z.boolean(), page: z.number().int().nonnegative() });
const wellKnownLockSchema = z.object({ version: z.literal(1), skills: z.record(z.string(), z.object({
  source: z.string(), sourceUrl: z.string(), sourceType: z.literal('well-known'),
  computedHash: z.string().regex(/^[a-f0-9]{64}$/), wellKnownDigest: z.string().optional(),
})) });
const acquiredSchema = z.array(z.object({
  name: z.string().optional(), status: z.string(), source: z.string().optional(), ref: z.string().nullable().optional(),
  hash: z.string().nullable().optional(), path: z.string().optional(), scope: z.string().optional(),
  agents: z.array(z.string()).optional(), mode: z.string().optional(),
}));
const require = createRequire(import.meta.url);
const packageFile = require.resolve('skills/package.json');
const cliPackage = JSON.parse(readFileSync(packageFile, 'utf8')) as { version: string; bin: { skills: string } };
const cli = resolve(dirname(packageFile), cliPackage.bin.skills);
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** Compatibility boundary for the anonymous endpoint used by the official Skills CLI. */
export async function searchSkills(query: string, request: typeof fetch = fetch): Promise<SkillSearch> {
  if (!query.trim()) return { skills: [] };
  try {
    const url = new URL('https://skills.sh/api/search');
    url.searchParams.set('q', query.trim()); url.searchParams.set('limit', '20');
    const response = await request(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('catalog unavailable');
    return catalogSchema.parse(await response.json());
  } catch { throw new BusinessError(503, '暂时无法搜索 skills.sh，请重试。'); }
}

/** The public leaderboard has no search id; retain its order and its view-specific metrics. */
export async function skillLeaderboard(view: SkillLeaderboardView, page: number, request: typeof fetch = fetch): Promise<SkillLeaderboard> {
  try {
    const response = await request(`https://skills.sh/api/skills/${view}/${page}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('leaderboard unavailable');
    const data = leaderboardSchema.parse(await response.json());
    if (data.page !== page || view === 'hot' && data.skills.some((skill) => skill.change === undefined)) throw new Error('unexpected leaderboard');
    return { ...data, skills: data.skills.map((skill) => ({ ...skill, id: `${skill.source}/${skill.skillId}` })) };
  } catch { throw new BusinessError(503, '暂时无法读取 skills.sh 榜单，请重试。'); }
}

export function skillSource(source: string, skill?: string) {
  if (source.startsWith('https://')) {
    let url: URL;
    try { url = new URL(source); } catch { throw new BusinessError(400, '来源链接不是有效的 HTTPS 地址。'); }
    if (url.username || url.password) throw new BusinessError(400, '来源链接不能包含登录凭据。');
    if (url.hostname === 'skills.sh' || url.hostname === 'www.skills.sh') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length !== 3 || parts.some((part) => !/^[\w.-]+$/.test(part)) || parts[2]!.startsWith('-')) throw new BusinessError(400, '请填写具体技能的 skills.sh 链接。');
      if (parts[0] === 'site') return skillSource(parts[1]!, skill ?? parts[2]);
      return { source: `${parts[0]}/${parts[1]}`, skill: skill ?? parts[2] };
    }
    return { source, skill };
  }
  if (/^[\w][\w.-]*\.[a-z]{2,}$/i.test(source)) return { source: `https://${source}/`, skill };
  // Absolute local sources are also useful for offline acquisition; reference-only loading is a separate operation.
  if (isAbsolute(source) || /^[\w.-]+\/[\w.-]+(?:\/[^\s]+|[#@][^\s]+)?$/.test(source)) return { source, skill };
  throw new BusinessError(400, '请填写 skills.sh 链接、HTTPS 仓库链接或 owner/repo。');
}

/** File bundles and provenance belong to the app; Pi still owns discovery and runtime loading. */
export class SkillLibrary {
  private staging: string;
  private backups: string;
  private running = new Set<AbortController>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(readonly directory: string, root: string) {
    this.staging = join(root, '.skill-staging'); this.backups = join(root, '.skill-backups');
    for (const path of [directory, this.staging, this.backups]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (lstatSync(path).isSymbolicLink()) throw new Error('Skill storage must not be a symlink');
    }
    // Startup holds the data-directory instance lock. Only discard our interrupted acquisition jobs.
    for (const name of readdirSync(this.staging)) {
      if (/^acquire-[a-zA-Z0-9]{6}$/.test(name)) rmSync(join(this.staging, name), { recursive: true, force: true });
    }
    // Finish an interrupted folder replacement without discarding the previous working bundle.
    for (const name of readdirSync(this.backups)) {
      const backup = join(this.backups, name), target = join(directory, name);
      if (!this.readMetadata(backup)) continue;
      if (!existsSync(target)) renameSync(backup, target);
      else if (this.metadata(join(target, 'SKILL.md'))) rmSync(backup, { recursive: true });
    }
  }
  private readMetadata(folder: string): SkillInstallation | null {
    if (!existsSync(folder) || lstatSync(folder).isSymbolicLink()) return null;
    try { return installationSchema.parse(JSON.parse(readFileSync(join(folder, metadataFile), 'utf8'))); }
    catch { return null; }
  }
  metadata(filePath: string): SkillInstallation | null {
    const folder = dirname(filePath);
    if (dirname(folder) !== this.directory || basename(filePath) !== 'SKILL.md') return null;
    return this.readMetadata(folder);
  }
  files(folder: string): string[] {
    const result: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === metadataFile) continue;
        const file = join(path, entry.name);
        if (entry.isSymbolicLink()) throw new BusinessError(409, '技能文件中包含链接，请先检查本地改动。');
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) result.push(relative(folder, file).split(sep).join('/'));
        else throw new BusinessError(409, '技能包含不支持的文件类型。');
      }
    };
    walk(folder); return result;
  }
  contentHash(folder: string) {
    const hash = createHash('sha256');
    for (const name of this.files(folder)) {
      const path = join(folder, name), body = readFileSync(path);
      hash.update(JSON.stringify([name, lstatSync(path).mode & 0o111, body.length])); hash.update(body);
    }
    return hash.digest('hex');
  }
  private publisherBundle(project: string, source: string) {
    try {
      const root = realpathSync(join(project, '.pi/skills'));
      if (!within(realpathSync(project), root)) throw new Error('Skill acquisition escaped staging');
      const folders = readdirSync(root);
      if (folders.length > 1) throw new BusinessError(422, '来源中包含多个技能，请填写要安装的技能名称。');
      if (!folders.length) throw new Error('Publisher did not install a bundle');
      const folder = realpathSync(join(root, folders[0]!));
      if (!within(root, folder)) throw new Error('Skill acquisition escaped staging');
      const lock = wellKnownLockSchema.parse(JSON.parse(readFileSync(join(project, 'skills-lock.json'), 'utf8'))).skills[basename(folder)];
      if (!lock || lock.source !== new URL(source).hostname.replace(/^www\./, '') || new URL(lock.sourceUrl).href !== new URL(source).href) throw new Error('Missing publisher provenance');
      // Match the pinned CLI's folder digest, independently of our content/permission digest.
      const digest = createHash('sha256');
      for (const name of this.files(folder).filter((name) => !name.split('/').slice(0, -1).some((part) => part === '.git' || part === 'node_modules')).sort((a, b) => a.localeCompare(b))) {
        digest.update(name); digest.update(readFileSync(join(folder, name)));
      }
      if (digest.digest('hex') !== lock.computedHash) throw new Error('Publisher bundle does not match lock');
      return { name: basename(folder), path: folder, status: 'installed', scope: 'project', mode: 'copy', agents: ['Pi'], hash: lock.wellKnownDigest ?? lock.computedHash };
    } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new BusinessError(503, '无法校验技能文件和来源记录，请检查来源后重试。');
    }
  }
  private async run(project: string, source: string, skill: string | undefined, signal: AbortSignal) {
    // skills@1.7.0 acquires publisher bundles, but its well-known add does not support JSON stdout.
    const wellKnown = source.startsWith('https://') && (new URL(source).pathname === '/' || new URL(source).pathname.startsWith('/.well-known/agent-skills'));
    const args = [cli, 'add', source, ...(skill ? ['--skill', skill] : []), '--agent', 'pi', '--copy', '--yes', ...(wellKnown ? [] : ['--json'])];
    const home = join(project, 'home'), temporary = join(project, 'tmp');
    mkdirSync(home); mkdirSync(temporary);
    const gitConfig = join(project, 'git-config'); writeFileSync(gitConfig, '');
    // Public acquisition never inherits provider keys, Git helpers, SSH agent sockets or real agent homes.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, LANG: process.env.LANG, SystemRoot: process.env.SystemRoot,
      HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'),
      DISABLE_TELEMETRY: '1', CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig,
    };
    const child = spawn(process.execPath, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      if (!child.pid) return;
      void stopProcesses(process.platform === 'win32' ? [child.pid] : descendants(child.pid)).catch(() => child.kill('SIGKILL'));
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const timer = setTimeout(stop, 120_000);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.resume(); // CLI diagnostics can contain source credentials; do not forward them into app logs.
    try {
      const code = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done); });
      if (signal.aborted) throw new BusinessError(503, '技能安装已停止，请重试。');
      let json: unknown;
      if (wellKnown) {
        if (code !== 0) throw new BusinessError(503, '无法获取这个技能，请检查来源和技能名称后重试。');
        json = [this.publisherBundle(project, source)];
      } else {
        try { json = JSON.parse(stdout || '[]'); } catch { throw new BusinessError(503, '技能来源返回了无法识别的安装结果，请重试。'); }
      }
      const entries = acquiredSchema.safeParse(json);
      if (code !== 0 || !entries.success || entries.data.some((entry) => entry.status !== 'installed')) throw new BusinessError(503, '无法获取这个技能，请检查来源和技能名称后重试。');
      if (entries.data.length !== 1) throw new BusinessError(422, '来源中包含多个技能，请填写要安装的技能名称。');
      const entry = entries.data[0]!;
      if (!entry.path || !entry.name || entry.scope !== 'project' || entry.mode !== 'copy' || !entry.agents?.includes('Pi')) throw new Error('Unexpected Skills CLI result');
      const folder = realpathSync(entry.path);
      if (!within(realpathSync(project), folder)) throw new Error('Skill acquisition escaped staging');
      const loaded = loadSkills({ cwd: project, agentDir: project, includeDefaults: false, skillPaths: [folder] });
      if (loaded.skills.length !== 1 || loaded.skills[0]!.filePath !== join(folder, 'SKILL.md') || loaded.diagnostics.length) throw new BusinessError(422, '技能的 SKILL.md 不符合 Pi 格式，请检查来源。');
      let lock: { sourceUrl?: string; skillPath?: string } = {};
      try { lock = JSON.parse(readFileSync(join(project, 'skills-lock.json'), 'utf8')).skills[entry.name] ?? {}; } catch { /* Direct downloads need not write a project lock. */ }
      const installation: SkillInstallation = { source, skill: loaded.skills[0]!.name, ref: entry.ref ?? null,
        upstreamHash: entry.hash ?? null, contentHash: this.contentHash(folder), cliVersion: cliPackage.version,
        ...(typeof lock.sourceUrl === 'string' ? { sourceUrl: lock.sourceUrl } : {}),
        ...(typeof lock.skillPath === 'string' ? { skillPath: lock.skillPath } : {}) };
      return { folder, name: basename(folder), installation };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
  }
  private async acquire<T>(source: string, skill: string | undefined, use: (bundle: Awaited<ReturnType<SkillLibrary['run']>>) => T): Promise<T> {
    if (this.closed) throw new BusinessError(503, '服务正在关闭，请稍后重试。');
    if (this.pending.size) throw new BusinessError(409, '正在处理另一个技能，请稍后再试。');
    const controller = new AbortController(); this.running.add(controller);
    const project = mkdtempSync(join(this.staging, 'acquire-'));
    const operation = this.run(project, source, skill, controller.signal).then(use);
    this.pending.add(operation);
    try { return await operation; }
    finally { this.running.delete(controller); this.pending.delete(operation); rmSync(project, { recursive: true, force: true }); }
  }
  install(source: string, skill?: string, existingNames: () => string[] = () => []) {
    const request = skillSource(source, skill);
    return this.acquire(request.source, request.skill, (bundle) => {
      const target = join(this.directory, bundle.name);
      if (existsSync(target) || existingNames().includes(bundle.installation.skill)) throw new BusinessError(409, '已存在同名技能，请检查已安装列表。');
      writeFileSync(join(bundle.folder, metadataFile), JSON.stringify(bundle.installation), { mode: 0o600 });
      renameSync(bundle.folder, target);
      return join(target, 'SKILL.md');
    });
  }
  update(filePath: string, apply: boolean) {
    const original = this.metadata(filePath);
    if (!original) throw new BusinessError(422, '本地引用的技能请在原目录中更新。');
    const folder = dirname(filePath);
    const before = this.contentHash(folder);
    return this.acquire(original.source, original.skill, (bundle) => {
      const available = original.contentHash !== bundle.installation.contentHash;
      const modified = this.contentHash(folder) !== original.contentHash;
      if (apply) {
        if (modified || this.contentHash(folder) !== before) throw new BusinessError(409, '技能有本地改动，未覆盖文件。请先保留或还原改动再更新。');
        if (bundle.name !== basename(folder)) throw new BusinessError(409, '来源中的技能名称发生变化，请重新安装。');
        if (available) {
          const backup = join(this.backups, basename(folder));
          if (existsSync(backup)) throw new BusinessError(409, '技能有尚未恢复的安装记录，请重新启动后重试。');
          writeFileSync(join(bundle.folder, metadataFile), JSON.stringify(bundle.installation), { mode: 0o600 });
          renameSync(folder, backup);
          try { renameSync(bundle.folder, folder); } catch (error) { renameSync(backup, folder); throw error; }
          rmSync(backup, { recursive: true });
        }
      }
      return { filePath, available, modified };
    });
  }
  remove(filePath: string) {
    if (this.pending.size) throw new BusinessError(409, '正在处理另一个技能，请稍后再试。');
    if (!this.metadata(filePath)) throw new BusinessError(422, '这个技能不是应用安装的技能。');
    rmSync(dirname(filePath), { recursive: true });
  }
  async close() {
    this.closed = true;
    for (const controller of this.running) controller.abort();
    await Promise.allSettled(this.pending);
  }
}
