import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  Answer, AskSpec, CardRevision, DeepResearchResult, ExportRecord, FinalApproval, ImageSet, LayoutSet, PriorAnswer, Question, QuestionKind, ResearchResult, Storyboard,
  RunError, RunKind, RunStatus, Stage,
} from './types.ts';

export const DATA_DIR = path.resolve(process.env.CARD_NEWS_DATA_DIR ?? 'data');
mkdirSync(path.join(DATA_DIR, 'projects'), { recursive: true });

// Wait for a lock instead of failing when another process (e.g. a second server on
// the same data folder) is writing.
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'), { timeout: 5000 });
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    period_days INTEGER NOT NULL,
    stage TEXT NOT NULL,
    version INTEGER NOT NULL,
    engine TEXT NOT NULL,
    engine_session_id TEXT,
    research_json TEXT,
    selection_json TEXT,
    deep_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    engine TEXT NOT NULL,
    input_json TEXT NOT NULL,
    progress_json TEXT NOT NULL,
    error_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    version INTEGER NOT NULL,
    spec_json TEXT NOT NULL,
    status TEXT NOT NULL,
    answer_json TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT
  );
  CREATE TABLE IF NOT EXISTS requests (
    scope TEXT NOT NULL,
    request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope, request_id)
  );
`);

// Columns added after the first release; existing databases get them on start.
const projectColumns = new Set((db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map((c) => c.name));
for (const col of ['storyboard_json', 'images_json', 'layout_json', 'name', 'archived_at', 'revisions_json', 'final_json', 'exports_json']) {
  if (!projectColumns.has(col)) db.exec(`ALTER TABLE projects ADD COLUMN ${col} TEXT`);
}

const now = () => new Date().toISOString();
const parse = <T>(s: unknown): T | null => (typeof s === 'string' ? (JSON.parse(s) as T) : null);

export interface Project {
  id: string;
  topic: string;
  periodDays: number;
  stage: Stage;
  version: number;
  engine: string;
  engineSessionId: string | null;
  research: ResearchResult | null;
  selection: { candidateIds: string[]; savedAt: string } | null;
  deep: DeepResearchResult | null;
  storyboard: Storyboard | null;
  images: ImageSet | null;
  layouts: LayoutSet | null;
  /** Display name chosen by the user; the topic stays what was researched. */
  name: string | null;
  archivedAt: string | null;
  revisions: CardRevision[];
  final: FinalApproval | null;
  exports: ExportRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  projectId: string;
  kind: RunKind;
  status: RunStatus;
  engine: string;
  input: Record<string, unknown>;
  progress: { at: string; message: string }[];
  error: RunError | null;
  startedAt: string;
  finishedAt: string | null;
}

type Row = Record<string, unknown>;

function toProject(r: Row): Project {
  return {
    id: r.id as string,
    topic: r.topic as string,
    periodDays: r.period_days as number,
    stage: r.stage as Stage,
    version: r.version as number,
    engine: r.engine as string,
    engineSessionId: (r.engine_session_id as string | null) ?? null,
    research: parse(r.research_json),
    selection: parse(r.selection_json),
    deep: parse(r.deep_json),
    storyboard: parse(r.storyboard_json),
    images: parse(r.images_json),
    layouts: parse(r.layout_json),
    name: (r.name as string | null) ?? null,
    archivedAt: (r.archived_at as string | null) ?? null,
    revisions: parse(r.revisions_json) ?? [],
    final: parse(r.final_json),
    exports: parse(r.exports_json) ?? [],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toRun(r: Row): Run {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    kind: r.kind as RunKind,
    status: r.status as RunStatus,
    engine: r.engine as string,
    input: parse(r.input_json) ?? {},
    progress: parse(r.progress_json) ?? [],
    error: parse(r.error_json),
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function toQuestion(r: Row): Question {
  const spec = parse<AskSpec>(r.spec_json)!;
  return {
    ...spec,
    id: r.id as string,
    projectId: r.project_id as string,
    runId: r.run_id as string,
    kind: r.kind as QuestionKind,
    version: r.version as number,
    status: r.status as Question['status'],
    answer: parse(r.answer_json),
    createdAt: r.created_at as string,
  };
}

// ---- projects ----

export function createProject(topic: string, periodDays: number, engine: string): Project {
  const id = randomUUID();
  const t = now();
  db.prepare(`INSERT INTO projects (id, topic, period_days, stage, version, engine, created_at, updated_at)
              VALUES (?, ?, ?, 'created', 1, ?, ?, ?)`).run(id, topic, periodDays, engine, t, t);
  mkdirSync(path.join(DATA_DIR, 'projects', id), { recursive: true });
  return getProject(id)!;
}

export function getProject(id: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
  return r ? toProject(r) : null;
}

/** Most recently worked on first; archived projects are listed apart. */
export function listProjects(archived = false): Project[] {
  return (db.prepare(`SELECT * FROM projects WHERE archived_at IS ${archived ? 'NOT ' : ''}NULL ORDER BY updated_at DESC`).all() as Row[]).map(toProject);
}

export function countArchived(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NOT NULL').get() as { n: number }).n;
}

/** Removes a project and everything recorded for it, including its files. */
export function deleteProject(id: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM questions WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM runs WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM requests WHERE scope = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  rmSync(path.join(DATA_DIR, 'projects', id), { recursive: true, force: true });
}

export interface ProjectPatch {
  stage?: Stage;
  periodDays?: number;
  engine?: string;
  engineSessionId?: string | null;
  research?: ResearchResult | null;
  selection?: Project['selection'];
  deep?: DeepResearchResult | null;
  storyboard?: Storyboard | null;
  images?: ImageSet | null;
  layouts?: LayoutSet | null;
  name?: string | null;
  archivedAt?: string | null;
  revisions?: CardRevision[];
  final?: FinalApproval | null;
  exports?: ExportRecord[];
}

/** Applies a patch and bumps the project version. */
export function updateProject(id: string, patch: ProjectPatch): Project {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => { cols.push(`${col} = ?`); vals.push(v); };
  if (patch.stage !== undefined) set('stage', patch.stage);
  if (patch.periodDays !== undefined) set('period_days', patch.periodDays);
  if (patch.engine !== undefined) set('engine', patch.engine);
  if (patch.engineSessionId !== undefined) set('engine_session_id', patch.engineSessionId);
  if (patch.research !== undefined) set('research_json', patch.research && JSON.stringify(patch.research));
  if (patch.selection !== undefined) set('selection_json', patch.selection && JSON.stringify(patch.selection));
  if (patch.deep !== undefined) set('deep_json', patch.deep && JSON.stringify(patch.deep));
  if (patch.storyboard !== undefined) set('storyboard_json', patch.storyboard && JSON.stringify(patch.storyboard));
  if (patch.images !== undefined) set('images_json', patch.images && JSON.stringify(patch.images));
  if (patch.layouts !== undefined) set('layout_json', patch.layouts && JSON.stringify(patch.layouts));
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.archivedAt !== undefined) set('archived_at', patch.archivedAt);
  if (patch.revisions !== undefined) set('revisions_json', JSON.stringify(patch.revisions));
  if (patch.final !== undefined) set('final_json', patch.final && JSON.stringify(patch.final));
  if (patch.exports !== undefined) set('exports_json', JSON.stringify(patch.exports));
  set('updated_at', now());
  db.prepare(`UPDATE projects SET ${cols.join(', ')}, version = version + 1 WHERE id = ?`).run(...vals, id);
  return getProject(id)!;
}

// ---- runs ----

export function createRun(projectId: string, kind: RunKind, engine: string, input: Record<string, unknown>): Run {
  const id = randomUUID();
  db.prepare(`INSERT INTO runs (id, project_id, kind, status, engine, input_json, progress_json, started_at)
              VALUES (?, ?, ?, 'running', ?, ?, '[]', ?)`).run(id, projectId, kind, engine, JSON.stringify(input), now());
  return getRun(id)!;
}

export function getRun(id: string): Run | null {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
  return r ? toRun(r) : null;
}

/**
 * How long each kind of run usually takes: the median of the last 10 finished
 * successful runs with the real engine (mock runs are instant), in seconds, across
 * all projects. Shown next to a running step.
 */
export function typicalSeconds(): Partial<Record<RunKind, number>> {
  const rows = db.prepare(`SELECT kind, started_at, finished_at FROM runs WHERE status = 'succeeded' AND finished_at IS NOT NULL AND engine != 'mock'
                           ORDER BY started_at DESC LIMIT 300`).all() as Row[];
  const by = new Map<RunKind, number[]>();
  for (const r of rows) {
    const s = (Date.parse(r.finished_at as string) - Date.parse(r.started_at as string)) / 1000;
    const list = by.get(r.kind as RunKind) ?? [];
    if (Number.isFinite(s) && s > 0 && list.length < 10) by.set(r.kind as RunKind, [...list, s]);
  }
  return Object.fromEntries([...by].map(([k, l]) => [k, Math.round([...l].sort((a, b) => a - b)[Math.floor(l.length / 2)])]));
}

export function listRuns(projectId: string, limit = 10): Run[] {
  return (db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
    .all(projectId, limit) as Row[]).map(toRun);
}

export function findActiveRun(projectId: string, kind?: RunKind): Run | null {
  const r = (kind
    ? db.prepare(`SELECT * FROM runs WHERE project_id = ? AND kind = ? AND status IN ('running','waiting_for_user') LIMIT 1`).get(projectId, kind)
    : db.prepare(`SELECT * FROM runs WHERE project_id = ? AND status IN ('running','waiting_for_user') LIMIT 1`).get(projectId)
  ) as Row | undefined;
  return r ? toRun(r) : null;
}

export function setRunStatus(id: string, status: RunStatus, error: RunError | null = null): void {
  const finished = status === 'running' || status === 'waiting_for_user' ? null : now();
  db.prepare('UPDATE runs SET status = ?, error_json = ?, finished_at = ? WHERE id = ?')
    .run(status, error && JSON.stringify(error), finished, id);
}

export function appendProgress(id: string, message: string): void {
  const run = getRun(id);
  if (!run) return;
  const progress = [...run.progress, { at: now(), message }].slice(-30);
  db.prepare('UPDATE runs SET progress_json = ? WHERE id = ?').run(JSON.stringify(progress), id);
}

/** Marks runs left running by a previous server process as interrupted. */
export function markInterruptedRuns(error: RunError): number {
  const res = db.prepare(`UPDATE runs SET status = 'interrupted', error_json = ?, finished_at = ?
                          WHERE status IN ('running','waiting_for_user')`).run(JSON.stringify(error), now());
  return Number(res.changes);
}

// ---- questions ----

export function createQuestion(projectId: string, runId: string, kind: QuestionKind, spec: AskSpec): Question {
  // A new question replaces any older open one in the same project.
  db.prepare(`UPDATE questions SET status = 'superseded' WHERE project_id = ? AND status = 'open'`).run(projectId);
  const id = randomUUID();
  db.prepare(`INSERT INTO questions (id, project_id, run_id, kind, key, version, spec_json, status, created_at)
              VALUES (?, ?, ?, ?, ?, 1, ?, 'open', ?)`).run(id, projectId, runId, kind, spec.key, JSON.stringify(spec), now());
  return getQuestion(id)!;
}

export function getQuestion(id: string): Question | null {
  const r = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined;
  return r ? toQuestion(r) : null;
}

export function getOpenQuestion(projectId: string): Question | null {
  const r = db.prepare(`SELECT * FROM questions WHERE project_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`)
    .get(projectId) as Row | undefined;
  return r ? toQuestion(r) : null;
}

/** Answers keyed by question key, for resuming a stage after an interruption. */
export function getAnsweredByKey(projectId: string): Record<string, PriorAnswer> {
  const rows = db.prepare(`SELECT key, spec_json, answer_json FROM questions WHERE project_id = ? AND status = 'answered' AND kind = 'engine'
                           ORDER BY answered_at`).all(projectId) as Row[];
  return Object.fromEntries(rows.map((r) => [r.key as string, {
    question: parse<AskSpec>(r.spec_json)!.question,
    answer: parse<Answer>(r.answer_json)!,
  }]));
}

/** Returns false when the question was no longer open (already answered elsewhere). */
export function answerQuestion(id: string, answer: Answer): boolean {
  const res = db.prepare(`UPDATE questions SET status = 'answered', answer_json = ?, answered_at = ?, version = version + 1
                          WHERE id = ? AND status = 'open'`).run(JSON.stringify(answer), now(), id);
  return Number(res.changes) === 1;
}

/** Closes every open question of one kind (e.g. the retired "widen the period" question, B45). */
export function supersedeOpenOfKind(kind: QuestionKind): number {
  return Number(db.prepare(`UPDATE questions SET status = 'superseded' WHERE kind = ? AND status = 'open'`).run(kind).changes);
}

export function supersedeRunQuestions(runId: string): void {
  db.prepare(`UPDATE questions SET status = 'superseded' WHERE run_id = ? AND status = 'open'`).run(runId);
}

// ---- idempotent requests ----

export interface StoredResponse {
  statusCode: number;
  body: unknown;
}

/**
 * Runs `fn` once per (scope, requestId). A repeat with the same input returns the stored
 * response; a repeat with different input is a conflict. `fn` must be synchronous so no
 * other request can interleave between the lookup and the insert.
 */
export function idempotent(
  scope: string, requestId: string, input: unknown, fn: () => StoredResponse,
): StoredResponse | { conflict: true } {
  const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prev = db.prepare('SELECT input_hash, status_code, response_json FROM requests WHERE scope = ? AND request_id = ?')
    .get(scope, requestId) as Row | undefined;
  if (prev) {
    if (prev.input_hash !== inputHash) return { conflict: true };
    return { statusCode: prev.status_code as number, body: JSON.parse(prev.response_json as string) };
  }
  const res = fn();
  // Only successful outcomes are replayed; a rejected request may be retried with the same ID.
  if (res.statusCode < 400) {
    db.prepare(`INSERT INTO requests (scope, request_id, input_hash, status_code, response_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(scope, requestId, inputHash, res.statusCode, JSON.stringify(res.body), now());
  }
  return res;
}
