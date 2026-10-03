import Database from 'better-sqlite3';

// Migrations are append-only. Each version, including user_version, commits atomically.
export const migrations = [
  `CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE requirements (space_id TEXT PRIMARY KEY REFERENCES spaces(id), revision INTEGER NOT NULL DEFAULT 0,
     confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)), value TEXT NOT NULL CHECK(json_valid(value)));
   CREATE TABLE routes (space_id TEXT PRIMARY KEY REFERENCES spaces(id), revision INTEGER NOT NULL DEFAULT 0, content TEXT CHECK(json_valid(content)));
   CREATE TABLE units (space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'not_started'
     CHECK(status IN ('not_started','learning','needs_work','passed','skipped')), PRIMARY KEY(space_id,id));
   CREATE TABLE sessions (space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('intake','route','unit')),
     unit_id TEXT, title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, draft TEXT NOT NULL DEFAULT '{"text":"","quote":null,"routeSuggestion":""}',
     PRIMARY KEY(space_id,id), FOREIGN KEY(space_id,unit_id) REFERENCES units(space_id,id),
     CHECK((scope='unit' AND unit_id IS NOT NULL) OR (scope!='unit' AND unit_id IS NULL)));
   CREATE TABLE messages (space_id TEXT NOT NULL, session_id TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','agent')),
     text TEXT NOT NULL, quote TEXT CHECK(json_valid(quote)), created_at INTEGER NOT NULL, PRIMARY KEY(space_id,id),
     FOREIGN KEY(space_id,session_id) REFERENCES sessions(space_id,id));
   CREATE TABLE lessons (space_id TEXT NOT NULL, unit_id TEXT NOT NULL, content TEXT NOT NULL CHECK(json_valid(content)),
     PRIMARY KEY(space_id,unit_id), FOREIGN KEY(space_id,unit_id) REFERENCES units(space_id,id));
   CREATE TABLE assessment_specs (space_id TEXT NOT NULL, unit_id TEXT NOT NULL, content TEXT NOT NULL CHECK(json_valid(content)),
     PRIMARY KEY(space_id,unit_id), FOREIGN KEY(space_id,unit_id) REFERENCES units(space_id,id));
   CREATE TABLE assessment_drafts (space_id TEXT NOT NULL, unit_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
     answers TEXT NOT NULL DEFAULT '{"q1":"","q2":""}', PRIMARY KEY(space_id,unit_id), FOREIGN KEY(space_id,unit_id) REFERENCES units(space_id,id));
   CREATE TABLE assessments (space_id TEXT NOT NULL, unit_id TEXT NOT NULL, id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0),
     answers TEXT NOT NULL CHECK(json_valid(answers)), result TEXT NOT NULL CHECK(json_valid(result)), created_at INTEGER NOT NULL,
     PRIMARY KEY(space_id,id), UNIQUE(space_id,unit_id,attempt), FOREIGN KEY(space_id,unit_id) REFERENCES units(space_id,id));
   CREATE TABLE proposals (space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, session_id TEXT NOT NULL,
     base_revision INTEGER NOT NULL, content TEXT NOT NULL CHECK(json_valid(content)), state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied')),
     PRIMARY KEY(space_id,id), FOREIGN KEY(space_id,session_id) REFERENCES sessions(space_id,id));
   CREATE TABLE tasks (space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, unit_id TEXT, session_id TEXT, kind TEXT NOT NULL,
     state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','interrupted')), PRIMARY KEY(space_id,id),
     FOREIGN KEY(space_id,unit_id) REFERENCES units(space_id,id), FOREIGN KEY(space_id,session_id) REFERENCES sessions(space_id,id));
   CREATE TABLE runs (space_id TEXT NOT NULL REFERENCES spaces(id), id TEXT NOT NULL, unit_id TEXT, session_id TEXT NOT NULL, kind TEXT NOT NULL,
     state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','interrupted')), PRIMARY KEY(space_id,id),
     FOREIGN KEY(space_id,unit_id) REFERENCES units(space_id,id), FOREIGN KEY(space_id,session_id) REFERENCES sessions(space_id,id));
   CREATE UNIQUE INDEX one_active_run ON runs(space_id,session_id) WHERE state IN ('pending','running');
   CREATE TABLE requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL CHECK(json_valid(response)));`,
  `CREATE TABLE agent_runs (space_id TEXT NOT NULL, id TEXT NOT NULL, input TEXT NOT NULL CHECK(json_valid(input)),
     error TEXT, cancelled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(space_id,id),
     FOREIGN KEY(space_id,id) REFERENCES runs(space_id,id));
   CREATE TABLE agent_events (space_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)),
     PRIMARY KEY(space_id,run_id,seq), FOREIGN KEY(space_id,run_id) REFERENCES agent_runs(space_id,id));
   CREATE TABLE agent_messages (space_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, format_version INTEGER NOT NULL,
     value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(space_id,run_id,seq), FOREIGN KEY(space_id,run_id) REFERENCES agent_runs(space_id,id));
   CREATE TABLE context_manifests (space_id TEXT NOT NULL, run_id TEXT NOT NULL, request INTEGER NOT NULL,
     value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(space_id,run_id,request), FOREIGN KEY(space_id,run_id) REFERENCES agent_runs(space_id,id));`,
];

export function migrate(db: Database.Database, versions: readonly string[] = migrations) {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > versions.length) throw new Error('Database was created by a newer application; upgrade before opening it.');
  for (let index = version; index < versions.length; index++) {
    try {
      db.transaction(() => { db.exec(versions[index]!); db.pragma(`user_version = ${index + 1}`); })();
    } catch (cause) {
      throw new Error(`Database migration ${index + 1} failed; existing data was preserved.`, { cause });
    }
  }
}

export function openDatabase(path: string) {
  const db = new Database(path);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    db.pragma('journal_mode = WAL');
    return db;
  } catch (error) { db.close(); throw error; }
}
