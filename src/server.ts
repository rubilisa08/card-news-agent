import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as db from './db.ts';
import { FILE_NAME, imageDir } from './images.ts';
import { DESIGNS, effectiveDesign, effectiveLayouts, needsImage, validateLayout } from './layout.ts';
import { closeRenderer, renderCard, zip } from './render.ts';
import { cardSignature, exportDir } from './exporter.ts';
import { trustOf } from './sourceTrust.ts';
import { portalTiers, researchSources } from './outlets.ts';
import type { StoredResponse } from './db.ts';
import { selectEngine } from './engine/index.ts';
import * as jobs from './jobs.ts';
import { fail } from './jobs.ts';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8765);

const engine = selectEngine();
const RENDER_BASE = `http://${HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST}:${PORT}`;
const interrupted = jobs.initJobs(engine, RENDER_BASE);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' }, bodyLimit: 64 * 1024 });
await app.register(fastifyStatic, { root: path.resolve('public') });

// The screen's version is a hash of its files. index.html loads them with ?v=,
// and every API response carries it, so a tab opened before a restart can tell
// it is running old code and ask for a reload (B22).
const PUBLIC_FILES = ['index.html', 'app.js', 'style.css'];
const APP_VERSION = createHash('sha256')
  .update(PUBLIC_FILES.map((f) => readFileSync(path.resolve('public', f))).join('\0'))
  .digest('hex').slice(0, 12);
const INDEX_HTML = readFileSync(path.resolve('public', 'index.html'), 'utf8')
  .replace(/(src|href)="\/(app\.js|style\.css)"/g, `$1="/$2?v=${APP_VERSION}"`);
const sendIndex = (_req: unknown, reply: FastifyReply) =>
  reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(INDEX_HTML);
app.get('/', sendIndex);
app.get('/index.html', sendIndex);
// The screen files are read from disk on every request, but server code only
// loads at start. When the code on disk changed after start, the screen can show
// new buttons the running server does not have yet, so it is told to ask for a
// restart (B26).
const codeFiles = () => [
  ...PUBLIC_FILES.map((f) => path.resolve('public', f)),
  ...readdirSync(path.resolve('src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).map((f) => path.resolve('src', f)),
];
const codeStamp = () => codeFiles().map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
const STARTED_STAMP = codeStamp();
let stampCheckedAt = 0;
let codeChanged = false;
function serverOutdated() {
  if (Date.now() - stampCheckedAt > 2000) {
    stampCheckedAt = Date.now();
    try { codeChanged = codeStamp() !== STARTED_STAMP; } catch { codeChanged = true; }
  }
  return codeChanged;
}

app.addHook('onSend', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  reply.header('x-app-version', APP_VERSION);
  if (serverOutdated()) reply.header('x-server-outdated', '1');
});

type Body = Record<string, unknown>;
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100;

function send(reply: FastifyReply, res: StoredResponse) {
  return reply.code(res.statusCode).send(res.body);
}

/** Wraps a mutating request with requestId de-duplication within `scope`. */
function once(reply: FastifyReply, scope: string, body: Body, input: unknown, fn: () => StoredResponse) {
  if (!isId(body.requestId)) return send(reply, fail(400, 'bad_request', 'requestId가 필요합니다.', '화면을 새로고침한 뒤 다시 시도하세요.'));
  const res = db.idempotent(scope, body.requestId, input, fn);
  if ('conflict' in res) {
    return send(reply, fail(409, 'request_conflict', '같은 requestId로 다른 내용을 보냈습니다.', '화면을 새로고침한 뒤 다시 시도하세요.'));
  }
  return send(reply, res);
}

const notFound = () => fail(404, 'not_found', '프로젝트를 찾을 수 없습니다.', '첫 화면에서 프로젝트를 다시 고르세요.');
const staleVersion = () => fail(409, 'stale_version', '다른 화면이나 작업에서 프로젝트가 바뀌었습니다.', '화면이 최신 상태로 갱신된 뒤 다시 시도하세요.');

/** Trust tier of each source address in the project, for the tags on screen (B36). */
function trustMap(p: db.Project) {
  const urls = new Set<string>();
  for (const s of researchSources(p.research)) urls.add(s.url);
  for (const r of p.deep?.records ?? []) for (const f of [...r.facts, ...r.claims]) urls.add(f.sourceUrl);
  for (const c of p.storyboard?.cards ?? []) for (const s of c.sources) urls.add(s.url);
  const portals = portalTiers(researchSources(p.research));
  return Object.fromEntries([...urls].map((u) => [u, trustOf(u, portals)]));
}

/** The final approval and whether the cards still look the way they were approved. */
function finalState(p: db.Project) {
  if (!p.final) return null;
  return { ...p.final, valid: p.final.signature === cardSignature(p) };
}

function snapshot(id: string) {
  const p = db.getProject(id);
  if (!p) return null;
  const q = db.getOpenQuestion(id);
  return {
    project: {
      id: p.id, topic: p.topic, name: p.name, archivedAt: p.archivedAt, periodDays: p.periodDays, stage: p.stage, version: p.version,
      engine: p.engine, mock: engine.mock, createdAt: p.createdAt, updatedAt: p.updatedAt,
    },
    research: p.research,
    selection: p.selection,
    deep: p.deep,
    storyboard: p.storyboard,
    images: p.images,
    layouts: effectiveLayouts(p.storyboard, p.layouts),
    design: effectiveDesign(p.storyboard, p.layouts),
    brand: p.layouts?.brand ?? '',
    revisions: p.revisions,
    trust: trustMap(p),
    typicalSeconds: db.typicalSeconds(),
    final: finalState(p),
    exports: p.exports.map((e) => ({ ...e, current: e.signature === cardSignature(p) })),
    runs: db.listRuns(id, 5).map(({ input, projectId, ...r }) => r),
    question: q && {
      id: q.id, version: q.version, kind: q.kind, question: q.question, options: q.options,
      recommended: q.recommended, recommendationReason: q.recommendationReason, allowFreeText: q.allowFreeText,
    },
  };
}

app.get('/api/health', async () => ({ ok: true, ...jobs.engineInfo() }));

app.get<{ Querystring: { archived?: string } }>('/api/projects', async (req) => {
  const archived = req.query.archived === '1';
  return {
    archived,
    archivedCount: db.countArchived(),
    projects: db.listProjects(archived).map((p) => ({
      id: p.id, topic: p.topic, name: p.name, stage: p.stage, mock: p.engine === 'mock',
      cards: p.storyboard?.cards.length ?? 0,
      images: p.images?.cards.filter((c) => c.status === 'done').length ?? 0,
      busy: !!db.findActiveRun(p.id),
      createdAt: p.createdAt, updatedAt: p.updatedAt, archivedAt: p.archivedAt,
    })),
  };
});

// ---- managing the project list: rename, archive, delete ----

app.post<{ Params: { id: string } }>('/api/projects/:id/name', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > 100) return send(reply, fail(400, 'bad_request', '이름은 100자 이하로 입력하세요.', '이름을 줄여 다시 저장하세요.'));
  // An empty name goes back to showing the topic.
  const updated = db.updateProject(p.id, { name: name || null });
  return { name: updated.name, version: updated.version };
});

app.post<{ Params: { id: string } }>('/api/projects/:id/archive', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  if (typeof body.archived !== 'boolean') return send(reply, fail(400, 'bad_request', 'archived는 true 또는 false입니다.', '요청을 고쳐 다시 보내세요.'));
  if (body.archived && db.findActiveRun(p.id)) {
    return send(reply, fail(409, 'invalid_stage', '작업이 진행 중인 프로젝트는 보관할 수 없습니다.', '작업이 끝나거나 취소된 뒤 다시 시도하세요.'));
  }
  const updated = db.updateProject(p.id, { archivedAt: body.archived ? (p.archivedAt ?? new Date().toISOString()) : null });
  return { archivedAt: updated.archivedAt };
});

app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  if (db.findActiveRun(p.id)) {
    return send(reply, fail(409, 'invalid_stage', '작업이 진행 중인 프로젝트는 삭제할 수 없습니다.', '프로젝트를 열어 작업을 취소한 뒤 다시 시도하세요.'));
  }
  db.deleteProject(p.id);
  return { deleted: true };
});

app.post('/api/projects', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
  const periodDays = body.periodDays === undefined ? 7 : body.periodDays;
  if (!topic || topic.length > 200) return send(reply, fail(400, 'bad_request', '주제를 1~200자로 입력하세요.', '주제를 고쳐 다시 시도하세요.'));
  if (periodDays !== 7 && periodDays !== 30) return send(reply, fail(400, 'bad_request', '조사 기간은 7일 또는 30일입니다.', '기간을 고쳐 다시 시도하세요.'));
  return once(reply, 'global', body, { topic, periodDays }, () => {
    const p = db.createProject(topic, periodDays, engine.name);
    return { statusCode: 201, body: { projectId: p.id } };
  });
});

app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
  const s = snapshot(req.params.id);
  return s ? s : send(reply, notFound());
});

app.post<{ Params: { id: string } }>('/api/projects/:id/research', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const periodDays = body.periodDays === undefined ? p.periodDays : body.periodDays;
  if (periodDays !== 7 && periodDays !== 30) return send(reply, fail(400, 'bad_request', '조사 기간은 7일 또는 30일입니다.', '기간을 고쳐 다시 시도하세요.'));
  return once(reply, p.id, body, { kind: 'research', periodDays }, () => jobs.startResearch(p, periodDays));
});

app.post<{ Params: { id: string } }>('/api/projects/:id/selection', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const ids = body.candidateIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || !ids.every(isId) || new Set(ids).size !== ids.length) {
    return send(reply, fail(400, 'bad_request', '후보를 1~3개 선택하세요.', '선택을 고쳐 다시 저장하세요.'));
  }
  return once(reply, p.id, body, { kind: 'selection', ids, version: body.version }, () => {
    if (body.version !== p.version) return staleVersion();
    if (db.findActiveRun(p.id)) return fail(409, 'invalid_stage', '작업이 진행 중이라 선택을 바꿀 수 없습니다.', '작업이 끝나거나 취소된 뒤 다시 시도하세요.');
    if (p.stage !== 'selecting' && p.stage !== 'editorial_ready') {
      return fail(409, 'invalid_stage', '지금은 후보를 선택하는 단계가 아닙니다.', '조사가 끝난 뒤 선택하세요.');
    }
    const known = new Set(p.research?.candidates.map((c) => c.id));
    if (!ids.every((id) => known.has(id))) return fail(400, 'bad_request', '목록에 없는 후보가 포함되어 있습니다.', '화면을 새로고침한 뒤 다시 선택하세요.');
    // Changing the selection invalidates deep research done for the old one; saving the
    // same candidates again (e.g. to re-run) keeps the earlier successful result.
    const prev = new Set(p.selection?.candidateIds ?? []);
    const same = prev.size === ids.length && ids.every((id) => prev.has(id));
    const updated = db.updateProject(p.id, {
      ...(same ? {} : { stage: 'selecting' as const, deep: null, storyboard: null, images: null, layouts: null }),
      selection: { candidateIds: ids, savedAt: new Date().toISOString() },
    });
    return { statusCode: 200, body: { selection: updated.selection, version: updated.version } };
  });
});

app.post<{ Params: { id: string } }>('/api/projects/:id/deep-research', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  return once(reply, p.id, body, { kind: 'deep_research', version: body.version }, () => {
    const active = db.findActiveRun(p.id, 'deep_research');
    if (!active && body.version !== p.version) return staleVersion();
    return jobs.startDeepResearch(p);
  });
});

app.post<{ Params: { id: string } }>('/api/projects/:id/answers', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  if (!isId(body.questionId)) return send(reply, fail(400, 'bad_request', 'questionId가 필요합니다.', '화면을 새로고침하세요.'));
  const input = { kind: 'answer', questionId: body.questionId, questionVersion: body.questionVersion, answer: body.answer };
  return once(reply, p.id, body, input, () => {
    const q = db.getQuestion(body.questionId as string);
    if (!q || q.projectId !== p.id) return fail(404, 'not_found', '질문을 찾을 수 없습니다.', '화면을 새로고침하세요.');
    if (q.status !== 'open' || q.version !== body.questionVersion) {
      return jobs.staleQuestion();
    }
    const answer = jobs.validateAnswer(q, body.answer);
    if (!answer) return fail(400, 'invalid_answer', '선택지 중 하나를 고르거나 내용을 입력하세요.', '답을 고쳐 다시 제출하세요.');
    return jobs.submitAnswer(p, q, answer);
  });
});

app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req, reply) => {
  const run = db.getRun(req.params.id);
  if (!run) return send(reply, fail(404, 'not_found', '작업을 찾을 수 없습니다.', '화면을 새로고침하세요.'));
  return send(reply, jobs.cancelRun(run));
});

const later = (what: string) => fail(501, 'not_implemented', `${what}은(는) 아직 구현하지 않았습니다.`, '구현 5단계에서 연결합니다.');
app.post<{ Params: { id: string } }>('/api/projects/:id/storyboard', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const instruction = typeof body.instruction === 'string' && body.instruction.trim() ? body.instruction.trim().slice(0, 500) : null;
  return once(reply, p.id, body, { kind: 'storyboard', instruction, version: body.version }, () => {
    const active = db.findActiveRun(p.id, 'storyboard');
    if (!active && body.version !== p.version) return staleVersion();
    return jobs.startStoryboard(p, instruction);
  });
});

app.post<{ Params: { id: string } }>('/api/projects/:id/approve', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  if (body.stage === 'final') {
    return once(reply, p.id, body, { kind: 'approve', stage: 'final', version: body.version }, () => {
      if (body.version !== p.version) return staleVersion();
      return jobs.approveFinal(p);
    });
  }
  if (body.stage !== 'storyboard') return send(reply, fail(400, 'bad_request', 'stage는 storyboard 또는 final입니다.', '요청을 고쳐 다시 보내세요.'));
  const tool = body.tool ?? null;
  if (tool !== null && tool !== 'agy' && tool !== 'claude-cli-svg') return send(reply, fail(400, 'bad_request', '그릴 도구는 agy 또는 claude-cli-svg입니다.', '도구를 골라 다시 요청하세요.'));
  return once(reply, p.id, body, { kind: 'approve', stage: body.stage, version: body.version, tool }, () => {
    if (body.version !== p.version) return staleVersion();
    return jobs.approveStoryboard(p, tool);
  });
});

app.post<{ Params: { id: string; index: string } }>('/api/projects/:id/images/:index/retry', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const index = req.params.index === 'failed' ? 'failed' : Number(req.params.index);
  if (index !== 'failed' && (!Number.isInteger(index) || index < 1 || index > 12)) return send(reply, fail(400, 'bad_request', '카드 번호가 올바르지 않습니다.', '화면을 새로고침하세요.'));
  const tool = body.tool ?? null;
  if (tool !== null && tool !== 'agy' && tool !== 'claude-cli-svg') return send(reply, fail(400, 'bad_request', '그릴 도구는 agy 또는 claude-cli-svg입니다.', '도구를 골라 다시 요청하세요.'));
  const attempt = index === 'failed' ? p.images?.cards.map((c) => c.attempts).join(',') : p.images?.cards.find((c) => c.index === index)?.attempts;
  return once(reply, p.id, body, { kind: 'image_retry', index, tool, attempt }, () => jobs.retryImage(p, index, tool));
});

// Text layout of one card over its image. `layout: null` goes back to the default.
app.post<{ Params: { id: string; index: string } }>('/api/projects/:id/cards/:index/layout', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const index = Number(req.params.index);
  const sb = p.storyboard;
  if (!sb?.approvedAt) return send(reply, fail(409, 'invalid_stage', '승인한 스토리보드가 없어 글자를 배치할 수 없습니다.', '스토리보드를 먼저 승인하세요.'));
  if (!sb.cards.some((c) => c.index === index)) return send(reply, fail(400, 'bad_request', '카드 번호가 올바르지 않습니다.', '화면을 새로고침하세요.'));
  const layout = body.layout === null ? null : validateLayout(index, body.layout);
  if (typeof layout === 'string') return send(reply, fail(400, 'bad_request', layout, '값을 고쳐 다시 저장하세요.'));
  return once(reply, p.id, body, { kind: 'layout', index, layout: body.layout ?? null, version: body.version }, () => {
    if (body.version !== p.version) return staleVersion();
    const own = p.layouts?.storyboardVersion === sb.version ? p.layouts.cards.filter((c) => c.index !== index) : [];
    const cards = layout ? [...own, layout].sort((a, b) => a.index - b.index) : own;
    const layouts = { storyboardVersion: sb.version, cards, design: effectiveDesign(sb, p.layouts), brand: p.layouts?.brand };
    // A card switched to text-only may be the last one missing a picture.
    const updated = db.updateProject(p.id, { layouts, stage: db.findActiveRun(p.id) ? p.stage : jobs.restingStage({ ...p, layouts }) });
    return { statusCode: 200, body: { version: updated.version } };
  });
});

// The design shared by all cards of the set.
app.post<{ Params: { id: string } }>('/api/projects/:id/design', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const sb = p.storyboard;
  // Chosen before approval too, so the pictures are drawn for this design (B31).
  if (!sb) return send(reply, fail(409, 'invalid_stage', '스토리보드가 없어 디자인을 고를 수 없습니다.', '스토리보드를 먼저 만드세요.'));
  if (!DESIGNS.includes(body.design as never)) return send(reply, fail(400, 'bad_request', `디자인은 ${DESIGNS.join(', ')} 중 하나입니다.`, '화면을 새로고침하세요.'));
  const brand = body.brand === undefined ? p.layouts?.brand ?? '' : typeof body.brand === 'string' ? body.brand.trim() : null;
  if (brand === null || brand.length > 20) return send(reply, fail(400, 'bad_request', '브랜드 이름은 20자 이하로 입력하세요.', '이름을 줄여 다시 저장하세요.'));
  return once(reply, p.id, body, { kind: 'design', design: body.design, brand, version: body.version }, () => {
    if (body.version !== p.version) return staleVersion();
    const cards = p.layouts?.storyboardVersion === sb.version ? p.layouts.cards : [];
    const updated = db.updateProject(p.id, { layouts: { storyboardVersion: sb.version, cards, design: body.design as typeof DESIGNS[number], brand } });
    return { statusCode: 200, body: { design: body.design, version: updated.version } };
  });
});

// ---- finished cards: image + saved text layout, pictured as PNG (B27) ----

const TOOL_NAME: Record<string, string> = { agy: 'Antigravity agy', 'claude-cli-svg': 'Claude CLI (SVG 코드)', mock: '모의 이미지' };

/** Why the project's cards cannot be pictured yet, or null when they can. */
function notRenderable(p: db.Project, index?: number) {
  if (!p.storyboard?.approvedAt) return fail(409, 'invalid_stage', '승인한 스토리보드가 없어 카드를 만들 수 없습니다.', '스토리보드를 먼저 승인하세요.');
  const cards = index === undefined ? p.storyboard.cards : p.storyboard.cards.filter((c) => c.index === index);
  if (!cards.length) return fail(400, 'bad_request', '카드 번호가 올바르지 않습니다.', '화면을 새로고침하세요.');
  const missing = cards.filter((c) => needsImage(p.storyboard, p.layouts, c.index) && !p.images?.cards.some((i) => i.index === c.index && i.status === 'done')).map((c) => c.index);
  if (missing.length) return fail(409, 'invalid_stage', `${missing.join(', ')}번 카드의 이미지가 아직 없습니다.`, '카드 이미지가 모두 "확인 완료"가 된 뒤 다시 시도하세요.');
  return null;
}

const attachment = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const renderFailed = (err: unknown) => fail(500, 'render_failed', `카드 PNG를 만들지 못했습니다: ${(err as Error).message}`, 'Edge 또는 Chrome이 설치되어 있는지 확인하고 다시 시도하세요.');

app.get<{ Params: { id: string; index: string } }>('/api/projects/:id/cards/:index/png', async (req, reply) => {
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const index = Number(req.params.index);
  const blocked = notRenderable(p, index);
  if (blocked) return send(reply, blocked);
  try {
    const card = await renderCard(RENDER_BASE, p.id, index);
    return reply.type('image/png').header('cache-control', 'no-store').header('x-font-loaded', String(card.fontLoaded))
      .header('content-disposition', attachment(card.file)).send(card.png);
  } catch (err) {
    return send(reply, renderFailed(err));
  }
});

app.get<{ Params: { id: string } }>('/api/projects/:id/cards.zip', async (req, reply) => {
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const blocked = notRenderable(p);
  if (blocked) return send(reply, blocked);
  const sb = p.storyboard!;
  try {
    const cards = [];
    for (const c of sb.cards) cards.push(await renderCard(RENDER_BASE, p.id, c.index));
    const notes = [
      `# ${p.name || p.topic}`, '',
      `- 카드 ${cards.length}장, 1080×1350 PNG. 만든 시각 ${new Date().toISOString()}`,
      `- 그림: ${TOOL_NAME[p.images!.tool] ?? p.images!.tool}로 만든 설명용 생성 이미지입니다. 실제 제품 화면이나 보도 사진이 아닙니다.`,
      `- 글자: 그림 위에 따로 얹었습니다(Pretendard${cards.every((c) => c.fontLoaded) ? '' : '. 일부 카드는 글꼴을 불러오지 못해 대체 글꼴로 찍혔습니다'}).`, '',
      ...sb.cards.flatMap((c) => [
        `## ${c.index}. ${c.headline}`,
        ...(c.sources.length ? c.sources.map((s) => `- ${s.fact} (${s.url}${s.publishedAt ? `, 게시 ${s.publishedAt}` : ''})`) : ['- 연결된 확인 사실 없음']),
        '',
      ]),
    ].join('\n');
    const body = zip([...cards.map((c) => ({ name: c.file, data: c.png })), { name: '출처와 이미지 기록.md', data: Buffer.from(notes, 'utf8') }]);
    return reply.type('application/zip').header('cache-control', 'no-store')
      .header('content-disposition', attachment(`${p.name || p.topic} 카드뉴스.zip`)).send(body);
  } catch (err) {
    return send(reply, renderFailed(err));
  }
});

// Generated card images. Only checked file names inside the project's image folder.
app.get<{ Params: { id: string; file: string } }>('/api/projects/:id/images/:file', async (req, reply) => {
  const p = db.getProject(req.params.id);
  if (!p || !FILE_NAME.test(req.params.file) || !p.images?.cards.some((c) => c.file === req.params.file && c.status === 'done')) {
    return send(reply, fail(404, 'not_found', '이미지를 찾을 수 없습니다.', '화면을 새로고침하세요.'));
  }
  const type = req.params.file.endsWith('.svg') ? 'image/svg+xml' : req.params.file.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
  return reply.type(type).header('cache-control', 'no-store').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
    .send(readFileSync(path.join(imageDir(p.id), req.params.file)));
});
// A change request for one card: { index, kind: text|image, instruction }.
app.post<{ Params: { id: string } }>('/api/projects/:id/revisions', async (req, reply) => {
  const body = (req.body ?? {}) as Body;
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const index = Number(body.index);
  const kind = body.kind;
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!Number.isInteger(index)) return send(reply, fail(400, 'bad_request', '고칠 카드 번호가 필요합니다.', '카드를 골라 다시 요청하세요.'));
  if (kind !== 'text' && kind !== 'image') return send(reply, fail(400, 'bad_request', '"글자 고치기" 또는 "그림 다시 만들기"를 고르세요.', '고칠 것을 골라 다시 요청하세요.'));
  if (!instruction || instruction.length > 500) return send(reply, fail(400, 'bad_request', '고칠 내용을 1~500자로 적어 주세요.', '요청을 적어 다시 보내세요.'));
  // A picture can be redrawn with another tool, e.g. back to agy after a fallback (B32).
  const tool = body.tool === undefined ? null : body.tool;
  if (tool !== null && tool !== 'agy' && tool !== 'claude-cli-svg') return send(reply, fail(400, 'bad_request', '그릴 도구는 agy 또는 claude-cli-svg입니다.', '도구를 골라 다시 요청하세요.'));
  return once(reply, p.id, body, { kind: 'revision', index, revisionKind: kind, instruction, tool, version: body.version }, () => {
    if (body.version !== p.version) return staleVersion();
    return jobs.startRevision(p, index, kind, instruction, kind === 'image' ? tool : null);
  });
});

app.get<{ Params: { id: string } }>('/api/projects/:id/exports', async (req, reply) => {
  const p = db.getProject(req.params.id);
  if (!p) return send(reply, notFound());
  const sig = cardSignature(p);
  return { final: finalState(p), items: p.exports.map((e) => ({ ...e, current: e.signature === sig })) };
});

// Files of one export. Only names listed in that export's record are served.
app.get<{ Params: { id: string; exportId: string; file: string } }>('/api/projects/:id/exports/:exportId/:file', async (req, reply) => {
  const p = db.getProject(req.params.id);
  const ex = p?.exports.find((e) => e.id === req.params.exportId);
  const file = ex?.files.find((f) => f.name === req.params.file);
  if (!p || !ex || !file) return send(reply, fail(404, 'not_found', '내보낸 파일을 찾을 수 없습니다.', '화면을 새로고침하세요.'));
  const type = file.kind === 'png' ? 'image/png' : file.kind === 'zip' ? 'application/zip' : 'text/markdown; charset=utf-8';
  const name = file.kind === 'zip' ? `${p.name || p.topic} 카드뉴스.zip` : file.name;
  return reply.type(type).header('cache-control', 'no-store').header('content-disposition', attachment(name))
    .send(readFileSync(path.join(exportDir(p.id, ex.id), file.name)));
});

if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  app.log.warn(`HOST=${HOST}: 이 컴퓨터 밖에서도 접속할 수 있습니다. 인증이 없으므로 주의하세요.`);
}

try {
  await app.listen({ host: HOST, port: PORT });
  // Ctrl+C also closes the hidden browser used for card PNGs.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { closeRenderer().finally(() => process.exit(0)); });
  console.log(`\n카드뉴스 에이전트: http://${HOST}:${PORT}  (엔진: ${engine.name}${engine.mock ? ', 모의 데이터' : ''})`);
  if (interrupted) console.log(`서버 재시작으로 중단된 작업 ${interrupted}개를 "중단됨"으로 표시했습니다.`);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`\n포트 ${PORT}이(가) 이미 사용 중입니다. 다른 포트로 실행하세요. 예: PowerShell에서 $env:PORT=8766; npm start`);
    process.exit(1);
  }
  throw err;
}
