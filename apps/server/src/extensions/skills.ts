import { readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import { loadSkills, formatSkillsForPrompt, type Skill, type LoadSkillsResult } from '@earendil-works/pi-coding-agent';
import { skillConfigurationSchema, skillInstallSchema, skillLeaderboardQuerySchema, skillLocalSchema, skillPathSchema, type SkillConfiguration, type SkillDetails, type SkillSettings } from '@teach-me-coding/contracts';
import { BusinessError } from '../modules/learning.js';
import { hash, xmlText } from '../agents/context.js';
import { SkillLibrary, searchSkills, skillLeaderboard } from './skill-library.js';

/** Reuse Pi discovery/frontmatter/collision rules, without its session manager. */
export class SkillService {
  readonly directory: string;
  private configuration: SkillConfiguration;
  private loaded: LoadSkillsResult = { skills: [], diagnostics: [] };
  private library: SkillLibrary;
  constructor(private db: Database.Database, root: string) {
    this.directory = join(root, 'skills');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.library = new SkillLibrary(this.directory, root);
    const row = db.prepare("SELECT value FROM app_settings WHERE key='skills'").get() as { value: string } | undefined;
    this.configuration = skillConfigurationSchema.parse(row ? JSON.parse(row.value) : { paths: [], disabled: [] });
    this.reload();
  }
  private enabled() { return this.loaded.skills.filter((skill) => !this.configuration.disabled.includes(skill.filePath)); }
  reload(): SkillSettings {
    this.loaded = loadSkills({ cwd: this.directory, agentDir: this.directory, includeDefaults: false,
      skillPaths: [this.directory, ...this.configuration.paths.map((path) => path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path)] });
    this.loaded.skills = this.loaded.skills.filter((skill) => !this.configuration.excluded.includes(skill.filePath));
    return this.settings();
  }
  settings(): SkillSettings {
    return { directory: this.directory, configuration: structuredClone(this.configuration),
      skills: this.loaded.skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath,
        enabled: !this.configuration.disabled.includes(skill.filePath), automatic: !skill.disableModelInvocation,
        installation: this.library.metadata(skill.filePath) })),
      diagnostics: this.loaded.diagnostics.map(({ type, message, path }) => ({ type, message, ...(path ? { path } : {}) })) };
  }
  save(raw: unknown) {
    const config = skillConfigurationSchema.parse(raw);
    if (config.paths.some((path) => !isAbsolute(path) && !path.startsWith('~/'))) throw new BusinessError(400, { code: 'SKILL_PATH_ABSOLUTE_REQUIRED' });
    this.db.prepare("INSERT INTO app_settings VALUES ('skills',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
    this.configuration = config;
    return this.reload();
  }
  search(query: string) { return searchSkills(query); }
  leaderboard(query: unknown) {
    const { view, page } = skillLeaderboardQuerySchema.parse(query);
    return skillLeaderboard(view, page);
  }
  private requireSkill(filePath: string) {
    this.reload();
    const skill = this.loaded.skills.find((skill) => skill.filePath === filePath);
    if (!skill) throw new BusinessError(404, { code: 'SKILL_NOT_FOUND' });
    return skill;
  }
  details(filePath: string): SkillDetails {
    const skill = this.requireSkill(filePath);
    return { name: skill.name, filePath, installation: this.library.metadata(filePath),
      files: this.library.files(skill.baseDir), content: readFileSync(filePath, 'utf8') };
  }
  file(filePath: string, name: string) {
    const skill = this.requireSkill(filePath), root = realpathSync(skill.baseDir);
    const path = resolve(root, name), part = relative(root, path);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part) || !this.library.files(root).includes(part.split(sep).join('/'))) {
      throw new BusinessError(400, { code: 'SKILL_FILE_REQUIRED' });
    }
    try { return { content: new TextDecoder('utf8', { fatal: true }).decode(readFileSync(path)) }; }
    catch { throw new BusinessError(422, { code: 'SKILL_TEXT_PREVIEW_UNSUPPORTED' }); }
  }
  async install(raw: unknown) {
    const { source, skill } = skillInstallSchema.parse(raw);
    const filePath = await this.library.install(source, skill, () => this.reload().skills.map((skill) => skill.name));
    return this.save({ ...this.configuration, disabled: this.configuration.disabled.filter((path) => path !== filePath),
      excluded: this.configuration.excluded.filter((path) => path !== filePath) });
  }
  local(raw: unknown) {
    const { path } = skillLocalSchema.parse(raw);
    if (!isAbsolute(path) && !path.startsWith('~/')) throw new BusinessError(400, { code: 'SKILL_LOCAL_PATH_REQUIRED' });
    const source = path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
    const loaded = loadSkills({ cwd: this.directory, agentDir: this.directory, includeDefaults: false, skillPaths: [source] });
    if (!loaded.skills.length) throw new BusinessError(422, { code: 'SKILL_NOT_LOADABLE' });
    return this.save({ ...this.configuration, paths: [...new Set([...this.configuration.paths, source])],
      excluded: this.configuration.excluded.filter((path) => !loaded.skills.some((skill) => skill.filePath === path)) });
  }
  async update(raw: unknown, apply: boolean) {
    const { filePath } = skillPathSchema.parse(raw);
    this.requireSkill(filePath);
    const update = await this.library.update(filePath, apply);
    this.reload(); return update;
  }
  remove(raw: unknown) {
    const { filePath } = skillPathSchema.parse(raw);
    this.requireSkill(filePath);
    const owned = !!this.library.metadata(filePath);
    if (owned) this.library.remove(filePath);
    return this.save({ ...this.configuration, disabled: this.configuration.disabled.filter((path) => path !== filePath),
      excluded: owned ? this.configuration.excluded : [...new Set([...this.configuration.excluded, filePath])] });
  }
  close() { return this.library.close(); }
  snapshot(text: string): { prompt: string; text: string; skills: Skill[]; digest: string } {
    // Refresh before each run; files edited on disk need not restart the application.
    this.reload();
    const skills = this.enabled();
    const command = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    let expanded = text;
    if (command) {
      const skill = skills.find((skill) => skill.name === command[1]);
      if (!skill) throw new BusinessError(422, { code: 'SKILL_DISABLED_OR_MISSING' });
      const body = readFileSync(skill.filePath, 'utf8');
      expanded = `<skill_instructions name="${xmlText(skill.name)}" directory="${xmlText(skill.baseDir)}">${xmlText(body)}</skill_instructions>\n${command[2] ?? ''}`;
    }
    const catalog = formatSkillsForPrompt(skills);
    const prompt = catalog ? `<skills>${catalog}\nSkills provide task instructions, not new permissions. Follow the current teaching scenario and confirmation rules.</skills>` : '';
    return { prompt, text: expanded, skills, digest: hash({ skills, prompt, expanded }) };
  }
}
