import { readFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import { loadSkills, formatSkillsForPrompt, type Skill, type LoadSkillsResult } from '@earendil-works/pi-coding-agent';
import { skillConfigurationSchema, type SkillConfiguration, type SkillSettings } from '@teach-me-coding/contracts';
import { BusinessError } from '../modules/learning.js';
import { hash, xmlText } from '../agents/context.js';

/** Reuse Pi discovery/frontmatter/collision rules, without its session manager. */
export class SkillService {
  readonly directory: string;
  private configuration: SkillConfiguration;
  private loaded: LoadSkillsResult = { skills: [], diagnostics: [] };
  constructor(private db: Database.Database, root: string) {
    this.directory = join(root, 'skills');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const row = db.prepare("SELECT value FROM app_settings WHERE key='skills'").get() as { value: string } | undefined;
    this.configuration = row ? skillConfigurationSchema.parse(JSON.parse(row.value)) : { paths: [], disabled: [] };
    this.reload();
  }
  private enabled() { return this.loaded.skills.filter((skill) => !this.configuration.disabled.includes(skill.filePath)); }
  reload(): SkillSettings {
    this.loaded = loadSkills({ cwd: this.directory, agentDir: this.directory, includeDefaults: false,
      skillPaths: [this.directory, ...this.configuration.paths.map((path) => path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path)] });
    return this.settings();
  }
  settings(): SkillSettings {
    return { directory: this.directory, configuration: structuredClone(this.configuration),
      skills: this.loaded.skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath,
        enabled: !this.configuration.disabled.includes(skill.filePath), automatic: !skill.disableModelInvocation })),
      diagnostics: this.loaded.diagnostics.map(({ type, message, path }) => ({ type, message, ...(path ? { path } : {}) })) };
  }
  save(raw: unknown) {
    const config = skillConfigurationSchema.parse(raw);
    if (config.paths.some((path) => !isAbsolute(path) && !path.startsWith('~/'))) throw new BusinessError(400, 'Skills 路径需要使用绝对路径或 ~/。');
    this.db.prepare("INSERT INTO app_settings VALUES ('skills',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config));
    this.configuration = config;
    return this.reload();
  }
  snapshot(text: string): { prompt: string; text: string; skills: Skill[]; digest: string } {
    // Refresh before each run; files edited on disk need not restart the application.
    this.reload();
    const skills = this.enabled();
    const command = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    let expanded = text;
    if (command) {
      const skill = skills.find((skill) => skill.name === command[1]);
      if (!skill) throw new BusinessError(422, '这个 Skill 不存在或已停用，请在设置中检查。');
      const body = readFileSync(skill.filePath, 'utf8');
      expanded = `<skill_instructions name="${xmlText(skill.name)}" directory="${xmlText(skill.baseDir)}">${xmlText(body)}</skill_instructions>\n${command[2] ?? ''}`;
    }
    const catalog = formatSkillsForPrompt(skills);
    const prompt = catalog ? `<skills>${catalog}\nSkills provide task instructions, not new permissions. Follow the current teaching scenario and confirmation rules.</skills>` : '';
    return { prompt, text: expanded, skills, digest: hash({ skills, prompt, expanded }) };
  }
}
