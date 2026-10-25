import { copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as db from './db.ts';
import { applyEditorialRules } from './editorial.ts';
import { bestTrust, isWellSourced, TIER_LABEL, trustOf } from './sourceTrust.ts';
import { outletCoverage, portalTiers, researchSources } from './outlets.ts';
import type { Project, Run, StoredResponse } from './db.ts';
import { EngineError } from './engine/types.ts';
import type { Engine, EngineContext } from './engine/types.ts';
import { buildExport, cardSignature } from './exporter.ts';
import { defaultImageTool, generateImages, imageDir, newImageSet, writeProvenance } from './images.ts';
import { effectiveDesign, effectiveLayouts, needsImage, validateLayout } from './layout.ts';
import { applyStoryboardRules } from './storyboard.ts';
import type { Answer, AskSpec, Candidate, CardRevision, DeepResearchResult, ImageTool, Question, ResearchResult, RunError, RunKind, Stage, Storyboard } from './types.ts';

/** Test switch: card numbers whose first image attempt fails on purpose (VALIDATION.md). */
const failImageCards = new Set((process.env.CARD_NEWS_MOCK_FAIL_IMAGE ?? '').split(',').map(Number).filter(Boolean));

/** Cards left generating when a run stops become failed, so each can be retried. */
function markUnfinishedImages(projectId: string, reason: string | null) {
  const p = db.getProject(projectId)!;
  if (!p.images?.cards.some((c) => c.status === 'generating')) return;
  const images = structuredClone(p.images);
  for (const c of images.cards) {
    if (c.status !== 'generating') continue;
    c.status = 'failed';
    c.error = { code: reason ? 'cancelled' : 'interrupted', message: reason ?? '작업이 중단되어 이미지를 끝까지 만들지 못했습니다.', nextAction: '이 카드의 "다시 시도"를 누르세요.' };
  }
  db.updateProject(projectId, { images });
}

/**
 * Job manager: the app-side engine interface (start, answer, status, cancel).
 * HTTP handlers call these and return at once; the run continues in the background
 * and the browser polls the project snapshot.
 */

/** Fewer 7-day candidates than this → ask whether to widen to 30 days. */
const WIDEN_YES = '30일로 넓히기';
const WIDEN_NO = '지금 결과로 진행';

interface LiveRun {
  controller: AbortController;
  waiters: Map<string, (answer: Answer) => void>;
}

/** Runs executing in this process. A run in the DB but not here was interrupted. */
const live = new Map<string, LiveRun>();

let engine: Engine;
/** The server's own address, for the hidden browser that pictures the cards. */
let renderBase = '';

export function initJobs(selected: Engine, base: string): number {
  engine = selected;
  renderBase = base;
  restoreHeld();
  // The "30일로 넓힐까요?" question is retired (B45); close any still open from before.
  db.supersedeOpenOfKind('widen_period');
  return recoverInterrupted();
}

export function engineInfo() {
  return { engine: engine.name, mock: engine.mock };
}

export function fail(statusCode: number, code: string, message: string, nextAction: string): StoredResponse {
  return { statusCode, body: { error: { code, message, nextAction } } };
}

const ok = (body: unknown, statusCode = 200): StoredResponse => ({ statusCode, body });

/** An answer sent from an old screen: rejected without touching the current run or results. */
export const staleQuestion = () => fail(409, 'stale_question',
  '지난 질문에 대한 답변이라 반영하지 않았습니다. 현재 작업과 결과는 바뀌지 않았습니다.',
  '화면이 최신 상태로 다시 그려집니다. 지금 보이는 질문이나 결과를 확인하세요.');

/**
 * Stage to show when no run is active: what the saved results support. Research
 * clears old candidates when it starts; deep research keeps the selection and any
 * earlier successful result.
 */
export function restingStage(p: Project): Stage {
  if (!p.research) return 'created';
  if (!p.deep) return 'selecting';
  if (!p.storyboard) return 'editorial_ready';
  if (!p.storyboard.approvedAt) return 'storyboard_review';
  return allPicturesReady(p) ? 'reviewing' : 'producing';
}

/** Every card has its picture, except text-only cards which need none. */
function allPicturesReady(p: Project) {
  return !!p.images?.cards.every((c) => c.status === 'done' || !needsImage(p.storyboard, p.layouts, c.index));
}

const busy = () => fail(409, 'invalid_stage', '다른 작업이 진행 중입니다.', '진행 중인 작업이 끝나거나 취소된 뒤 다시 시도하세요.');

// ---- source trust (B36) ----

/**
 * Candidates without an official or major-news source stay on offer; the screen
 * marks them "출처 확인 필요" (user request 2026-10-24, replacing the "보류" list of
 * B36). Facts from unverified sources still never reach a card (demoteUnverifiedFacts).
 */
function countWeak(r: ResearchResult): number {
  if (r.mock) return 0;
  const portals = portalTiers(researchSources(r));
  return r.candidates.filter((c) => !isWellSourced(bestTrust(c.sources.map((s) => s.url), portals))).length;
}

/** Stories held aside by earlier versions go back among the candidates, after the others. */
function restoreHeld(): number {
  let n = 0;
  for (const p of [...db.listProjects(false), ...db.listProjects(true)]) {
    const r = p.research;
    if (!r?.held?.length) continue;
    const back = r.held.map(({ heldReason: _, ...c }, i) => ({ ...c, id: `c${r.candidates.length + i + 1}` }));
    db.updateProject(p.id, { research: { ...r, candidates: [...r.candidates, ...back], held: [] } });
    n += back.length;
  }
  return n;
}

/** Which of the newspapers the user asked for made it into the candidates (B38, B39). */
function withOutlets(r: ResearchResult): ResearchResult {
  return r.mock ? r : { ...r, outlets: outletCoverage(r.candidates) };
}

/** Facts whose only source is unverified become limits, so cards never state them as fact. */
function demoteUnverifiedFacts(d: DeepResearchResult, research: ResearchResult): DeepResearchResult {
  if (d.mock) return d;
  const portals = portalTiers(researchSources(research));
  return {
    ...d,
    records: d.records.map((r) => {
      const weak = r.facts.filter((f) => trustOf(f.sourceUrl, portals) === 'unverified');
      if (!weak.length) return r;
      return {
        ...r,
        facts: r.facts.filter((f) => trustOf(f.sourceUrl, portals) !== 'unverified'),
        limits: [...r.limits, ...weak.map((f) => `${TIER_LABEL.unverified} 출처에만 있는 내용이라 사실로 쓰지 않음: ${f.text}`)],
      };
    }),
  };
}

// ---- start ----

export function startResearch(project: Project, periodDays: number): StoredResponse {
  const active = db.findActiveRun(project.id);
  if (active?.kind === 'research') return ok({ runId: active.id, status: active.status, reused: true }, 202);
  if (active) return fail(409, 'invalid_stage', '다른 작업이 진행 중입니다.', '진행 중인 작업이 끝나거나 취소된 뒤 다시 시도하세요.');

  db.updateProject(project.id, { stage: 'researching', periodDays, research: null, selection: null, deep: null, storyboard: null, images: null, layouts: null });
  const run = launch(project, 'research', { periodDays });
  return ok({ runId: run.id, status: run.status, reused: false }, 202);
}

export function startDeepResearch(project: Project): StoredResponse {
  const active = db.findActiveRun(project.id);
  if (active?.kind === 'deep_research') return ok({ runId: active.id, status: active.status, reused: true }, 202);
  if (active) return fail(409, 'invalid_stage', '다른 작업이 진행 중입니다.', '진행 중인 작업이 끝나거나 취소된 뒤 다시 시도하세요.');
  if (!project.selection?.candidateIds.length) {
    return fail(409, 'invalid_stage', '아직 후보를 선택하지 않았습니다.', '후보를 1~3개 선택해 저장하세요.');
  }
  if (project.storyboard?.approvedAt) {
    return fail(409, 'invalid_stage', '승인한 스토리보드가 있어 심층 조사를 다시 할 수 없습니다.', '지금 단계에서 카드를 검수하세요.');
  }
  // The previous successful result stays until a new run succeeds, so a failed
  // re-run never erases it.
  db.updateProject(project.id, { stage: 'deep_research' });
  const run = launch(project, 'deep_research', { candidateIds: project.selection.candidateIds });
  return ok({ runId: run.id, status: run.status, reused: false }, 202);
}

export function startStoryboard(project: Project, instruction: string | null): StoredResponse {
  const active = db.findActiveRun(project.id);
  if (active?.kind === 'storyboard') return ok({ runId: active.id, status: active.status, reused: true }, 202);
  if (active) return busy();
  if (!project.deep) return fail(409, 'invalid_stage', '심층 조사 결과가 없습니다.', '심층 조사를 먼저 마치세요.');
  if (project.storyboard?.approvedAt) {
    return fail(409, 'invalid_stage', '이미 승인한 스토리보드입니다.', '이미지 제작과 검수 단계에서 진행하세요.');
  }
  if (instruction && !project.storyboard) return fail(409, 'invalid_stage', '고칠 스토리보드가 없습니다.', '먼저 스토리보드를 만드세요.');
  // An earlier draft stays until the new one succeeds.
  db.updateProject(project.id, { stage: 'storyboard_drafting' });
  const run = launch(project, 'storyboard', { instruction });
  return ok({ runId: run.id, status: run.status, reused: false }, 202);
}

/** Approval of the current storyboard version starts image generation. */
/** `tool`: the drawing tool the user picked next to the design (B50); null keeps the default (agy). */
export function approveStoryboard(project: Project, tool: ImageTool | null = null): StoredResponse {
  if (db.findActiveRun(project.id)) return busy();
  const sb = project.storyboard;
  if (!sb) return fail(409, 'invalid_stage', '승인할 스토리보드가 없습니다.', '먼저 스토리보드를 만드세요.');
  if (sb.approvedAt) return fail(409, 'invalid_stage', '이미 승인한 스토리보드입니다.', '이미지 진행 상황을 확인하세요.');
  const approved = { ...sb, approvedAt: new Date().toISOString() };
  const images = newImageSet(approved, engine.mock || !tool ? defaultImageTool(engine.mock) : tool);
  db.updateProject(project.id, { stage: 'producing', storyboard: approved, images });
  const run = launch(project, 'images', { indices: approved.cards.map((c) => c.index) });
  return ok({ approved: true, storyboardVersion: approved.version, runId: run.id, status: run.status }, 202);
}

/** Retries one failed card; the other cards and the approved storyboard stay as they are. */
export function retryImage(project: Project, index: number | 'failed', tool: ImageTool | null = null): StoredResponse {
  const active = db.findActiveRun(project.id);
  if (active?.kind === 'images') return ok({ runId: active.id, status: active.status, reused: true }, 202);
  if (active) return busy();
  const images = project.images;
  let indices: number[];
  if (index === 'failed') {
    indices = (images?.cards ?? []).filter((c) => c.status === 'failed' || c.status === 'pending').map((c) => c.index);
    if (!indices.length) return fail(409, 'invalid_stage', '다시 그릴 실패한 카드가 없습니다.', '화면을 새로고침하세요.');
  } else {
    const slot = images?.cards.find((c) => c.index === index);
    if (!slot) return fail(404, 'not_found', `${index}번 카드 이미지가 없습니다.`, '화면을 새로고침하세요.');
    if (slot.status !== 'failed' && slot.status !== 'pending') {
      return fail(409, 'invalid_stage', `${index}번 카드는 다시 만들 상태가 아닙니다(${slot.status}).`, '실패한 카드만 다시 시도할 수 있습니다.');
    }
    indices = [index];
  }
  // The user picks the tool for these and later pictures (e.g. Claude CLI while agy's quota is used up).
  const changed = tool && images && images.tool !== tool ? { images: { ...images, tool, fallbackReason: null } } : {};
  db.updateProject(project.id, { stage: 'producing', ...changed });
  const run = launch(project, 'images', { indices });
  return ok({ runId: run.id, status: run.status, reused: false }, 202);
}

// ---- card revisions (PRD 6: change one card, keep the others) ----

/** A change request for one card: its text only (picture kept) or its picture only. */
export function startRevision(project: Project, index: number, kind: 'text' | 'image', instruction: string, tool: ImageTool | null = null): StoredResponse {
  if (db.findActiveRun(project.id)) return busy();
  const sb = project.storyboard;
  if (!sb?.approvedAt || !project.images) return fail(409, 'invalid_stage', '승인한 스토리보드와 카드 그림이 있어야 고칠 수 있습니다.', '스토리보드를 승인하고 그림이 만들어진 뒤 다시 시도하세요.');
  if (!sb.cards.some((c) => c.index === index)) return fail(400, 'bad_request', '카드 번호가 올바르지 않습니다.', '화면을 새로고침하세요.');
  const slot = project.images.cards.find((c) => c.index === index);
  if (kind === 'image' && (!slot?.file || slot.status !== 'done')) {
    return fail(409, 'invalid_stage', `${index}번 카드에 다시 만들 그림이 없습니다.`, '그림이 실패한 카드는 이미지 목록의 "다시 시도"를 쓰세요.');
  }
  const layout = effectiveLayouts(sb, project.layouts)!.find((l) => l.index === index)!;
  const revision: CardRevision = {
    id: randomUUID(), index, kind, instruction, status: 'running', runId: '',
    before: kind === 'text' ? { headline: layout.headline, body: layout.body } : { file: slot!.file! },
    after: null, warnings: [], error: null, createdAt: new Date().toISOString(), finishedAt: null,
  };
  const run = launch(project, 'revision', { revisionId: revision.id, index, kind, instruction, tool });
  revision.runId = run.id;
  db.updateProject(project.id, { revisions: [...db.getProject(project.id)!.revisions, revision] });
  return ok({ runId: run.id, revisionId: revision.id, status: run.status }, 202);
}

function finishRevision(projectId: string, id: string, patch: Partial<CardRevision>) {
  const p = db.getProject(projectId)!;
  db.updateProject(projectId, {
    revisions: p.revisions.map((r) => (r.id === id ? { ...r, ...patch, finishedAt: new Date().toISOString() } : r)),
  });
}

/** Numbers written in the new text that appear neither in the old text nor in the card's facts. */
function newNumbers(before: string, after: string, facts: string) {
  const nums = (t: string) => new Set(t.match(/\d[\d,.]*/g) ?? []);
  const known = new Set([...nums(before), ...nums(facts)]);
  return [...nums(after)].filter((n) => !known.has(n));
}

// ---- final approval and export (PRD 6, B29) ----

/** Approves the cards as they are now and starts the export. */
export function approveFinal(project: Project): StoredResponse {
  if (db.findActiveRun(project.id)) return busy();
  const sb = project.storyboard;
  if (!sb?.approvedAt || !allPicturesReady(project)) {
    return fail(409, 'invalid_stage', '그림이 필요한 카드의 그림이 모두 만들어져야 최종 승인할 수 있습니다.', '대기·실패한 카드를 다시 만들거나, 그 카드를 "그림 없이 글자만"으로 바꾼 뒤 승인하세요.');
  }
  const signature = cardSignature(project)!;
  db.updateProject(project.id, { final: { approvedAt: new Date().toISOString(), signature, exportId: null } });
  const run = launch(project, 'export', { signature });
  return ok({ approved: true, signature, runId: run.id, status: run.status }, 202);
}

function launch(project: Project, kind: RunKind, input: Record<string, unknown>): Run {
  // A session ID belongs to one engine; switching engines starts a fresh session.
  if (project.engine !== engine.name) db.updateProject(project.id, { engine: engine.name, engineSessionId: null });
  const run = db.createRun(project.id, kind, engine.name, input);
  const entry: LiveRun = { controller: new AbortController(), waiters: new Map() };
  live.set(run.id, entry);
  setImmediate(() => void execute(run, entry));
  return run;
}

async function execute(run: Run, entry: LiveRun): Promise<void> {
  const { signal } = entry.controller;
  const project = db.getProject(run.projectId)!;
  const ctx: EngineContext = {
    projectId: project.id,
    sessionId: project.engineSessionId,
    signal,
    progress: (message) => db.appendProgress(run.id, message),
    setSessionId: (id) => { if (id !== db.getProject(project.id)!.engineSessionId) db.updateProject(project.id, { engineSessionId: id }); },
    askUser: (spec) => waitForAnswer(run, entry, spec),
    priorAnswers: db.getAnsweredByKey(project.id),
  };

  try {
    if (run.kind === 'research') {
      const periodDays = run.input.periodDays as number;
      const found = await engine.research(ctx, { topic: project.topic, periodDays, now: new Date() });
      const result = withOutlets(found);
      const weak = countWeak(result);
      if (weak) ctx.progress(`공식 발표나 주요 언론으로 확인되지 않은 후보 ${weak}개에 "출처 확인 필요"를 표시했습니다.`);
      db.updateProject(project.id, { stage: 'selecting', research: result });
      db.setRunStatus(run.id, 'succeeded');
      // The period the user picked next to the topic box stands; no follow-up question
      // offers to widen it (user request 2026-10-24). "30일로 다시 조사" stays on screen.
    } else if (run.kind === 'deep_research') {
      const ids = run.input.candidateIds as string[];
      const research = project.research!;
      const candidates = research.candidates.filter((c) => ids.includes(c.id));
      const draft = await engine.deepResearch(ctx, { topic: project.topic, candidates, searchedAt: research.searchedAt });
      const result = demoteUnverifiedFacts(applyEditorialRules(draft, research), research);
      // A storyboard planned from the old research no longer matches it.
      db.updateProject(project.id, { stage: 'editorial_ready', deep: result, storyboard: null, images: null, layouts: null });
      db.setRunStatus(run.id, 'succeeded');
    } else if (run.kind === 'storyboard') {
      const instruction = (run.input.instruction as string | null) ?? null;
      const draft = await engine.storyboard(ctx, {
        topic: project.topic, deep: project.deep!, research: project.research!, previous: project.storyboard, instruction,
      });
      const { cards, warnings } = applyStoryboardRules(draft, project.deep!, project.research!);
      const storyboard: Storyboard = {
        version: (project.storyboard?.version ?? 0) + 1,
        mock: engine.mock,
        format: project.deep!.editorial.recommendedFormat,
        audience: project.deep!.editorial.audience,
        styleGuide: draft.styleGuide,
        cards, warnings, instruction,
        createdAt: new Date().toISOString(),
        approvedAt: null,
      };
      // Card layouts belong to the old version; the chosen design and brand stay.
      const kept = project.layouts && { storyboardVersion: storyboard.version, cards: [], design: project.layouts.design, brand: project.layouts.brand };
      db.updateProject(project.id, { stage: 'storyboard_review', storyboard, images: null, layouts: kept });
      db.setRunStatus(run.id, 'succeeded');
    } else if (run.kind === 'revision') {
      await executeRevision(run, ctx, project);
    } else if (run.kind === 'export') {
      if (cardSignature(project) !== run.input.signature) {
        throw new EngineError('engine_failed', '승인한 뒤 카드가 바뀌어 내보내지 않았습니다.', '바뀐 카드를 확인하고 다시 최종 승인하세요.');
      }
      const record = await buildExport(project, renderBase, ctx.progress);
      const fresh = db.getProject(project.id)!;
      db.updateProject(project.id, {
        exports: [...fresh.exports, record],
        final: fresh.final?.signature === record.signature ? { ...fresh.final, exportId: record.id } : fresh.final,
      });
      db.setRunStatus(run.id, 'succeeded');
    } else {
      const failed = await generateImages({
        ctx,
        design: effectiveDesign(project.storyboard, project.layouts),
        storyboard: project.storyboard!,
        images: project.images!,
        indices: run.input.indices as number[],
        save: (images) => db.updateProject(project.id, { images }),
        failCards: failImageCards,
      });
      if (failed) {
        throw new EngineError('image_failed', `이미지 ${failed}장을 만들지 못했습니다. 나머지 카드와 승인한 스토리보드는 그대로입니다.`, '실패한 카드의 "다시 시도"를 누르세요.');
      }
      db.updateProject(project.id, { stage: restingStage(db.getProject(project.id)!) });
      db.setRunStatus(run.id, 'succeeded');
    }
  } catch (err) {
    db.supersedeRunQuestions(run.id);
    if (run.kind === 'revision') {
      finishRevision(project.id, run.input.revisionId as string, {
        status: 'failed', error: signal.aborted ? '취소했습니다.' : (err as Error).message.slice(0, 300),
      });
    }
    if (run.kind === 'images') markUnfinishedImages(project.id, signal.aborted ? '취소로 중단되었습니다.' : null);
    if (signal.aborted) {
      db.setRunStatus(run.id, 'cancelled', {
        code: 'cancelled', message: '작업을 취소했습니다.', nextAction: '필요하면 다시 시작하세요.',
      });
    } else {
      const error: RunError = err instanceof EngineError
        ? err.toRunError()
        : { code: 'engine_failed', message: `엔진 실행 중 오류: ${(err as Error).message}`, nextAction: '다시 시도하세요. 반복되면 서버 로그를 확인하세요.' };
      db.setRunStatus(run.id, 'failed', error);
    }
    db.updateProject(project.id, { stage: restingStage(db.getProject(project.id)!) });
  } finally {
    live.delete(run.id);
  }
}

async function executeRevision(run: Run, ctx: EngineContext, project: Project) {
  const { revisionId, index, kind, instruction, tool } = run.input as { revisionId: string; index: number; kind: 'text' | 'image'; instruction: string; tool?: ImageTool | null };
  const sb = project.storyboard!;
  const card = sb.cards.find((c) => c.index === index)!;

  if (kind === 'text') {
    // Only this card's words change; its picture, layout settings and the other cards stay.
    const current = effectiveLayouts(sb, project.layouts)!.find((l) => l.index === index)!;
    const revised = await engine.reviseCard(ctx, {
      topic: project.topic, audience: sb.audience, role: card.role,
      headline: current.headline, body: current.body, instruction,
      facts: card.sources.map(({ fact, url, publishedAt }) => ({ fact, url, publishedAt })),
    });
    const { saved, ...base } = current;
    const checked = validateLayout(index, { ...base, headline: revised.headline, body: revised.body });
    if (typeof checked === 'string') throw new EngineError('engine_failed', `고친 문장이 규칙에 맞지 않아 반영하지 않았습니다: ${checked}`, '요청을 조금 바꿔 다시 보내세요.');
    const fresh = db.getProject(project.id)!;
    const own = fresh.layouts?.storyboardVersion === sb.version ? fresh.layouts.cards.filter((c) => c.index !== index) : [];
    db.updateProject(project.id, {
      layouts: { storyboardVersion: sb.version, cards: [...own, checked].sort((a, b) => a.index - b.index), design: effectiveDesign(sb, fresh.layouts), brand: fresh.layouts?.brand },
    });
    const facts = card.sources.map((s) => s.fact).join(' ');
    const added = newNumbers(`${current.headline} ${current.body}`, `${checked.headline} ${checked.body}`, facts);
    finishRevision(project.id, revisionId, {
      status: 'done', after: { headline: checked.headline, body: checked.body },
      warnings: [revised.note, ...(added.length ? [`출처와 이전 문장에 없던 숫자가 들어갔습니다: ${added.join(', ')}. 맞는지 확인하세요.`] : [])],
    });
    ctx.progress(`${index}번 카드 문장을 고쳤습니다. 그림과 다른 카드는 그대로입니다.`);
  } else {
    // Only this card's picture is redone; the old file is kept as a backup and put
    // back if the new one cannot be made.
    const dir = imageDir(project.id);
    const before = structuredClone(project.images!);
    const slot = before.cards.find((c) => c.index === index)!;
    const backup = `card-${String(index).padStart(2, '0')}.v${(slot.history?.length ?? 0) + 1}${path.extname(slot.file!)}`;
    copyFileSync(path.join(dir, slot.file!), path.join(dir, backup));
    const images = structuredClone(before);
    Object.assign(images.cards.find((c) => c.index === index)!, { status: 'pending', error: null });
    if (tool) {
      // The set's tool for this and later pictures; agy may have been dropped after an earlier failure.
      images.tool = tool;
      images.fallbackReason = null;
    }
    db.updateProject(project.id, { images });
    let failed = 1;
    try {
      failed = await generateImages({
        ctx, storyboard: sb, images, indices: [index], notes: { [index]: instruction }, design: effectiveDesign(sb, project.layouts),
        save: (next) => db.updateProject(project.id, { images: next }),
      });
    } finally {
      if (failed) {
        // Put the previous picture and its record back.
        copyFileSync(path.join(dir, backup), path.join(dir, slot.file!));
        db.updateProject(project.id, { images: before });
        writeProvenance(dir, sb, before);
      }
    }
    if (failed) throw new EngineError('image_failed', `${index}번 카드 그림을 다시 만들지 못해 이전 그림을 그대로 두었습니다.`, '요청을 바꿔 다시 시도하세요.');
    const done = structuredClone(db.getProject(project.id)!.images!);
    const s = done.cards.find((c) => c.index === index)!;
    s.history = [...(slot.history ?? []), { at: new Date().toISOString(), instruction, backup }];
    db.updateProject(project.id, { images: done });
    writeProvenance(dir, sb, done);
    finishRevision(project.id, revisionId, { status: 'done', after: { file: s.file! } });
    ctx.progress(`${index}번 카드 그림만 다시 만들었습니다. 이전 그림은 ${backup}로 보관했습니다.`);
  }
  db.updateProject(project.id, { stage: restingStage(db.getProject(project.id)!) });
  db.setRunStatus(run.id, 'succeeded');
}

/** need_input: store the question, mark the run waiting_for_user, resolve on the web answer. */
function waitForAnswer(run: Run, entry: LiveRun, spec: AskSpec): Promise<Answer> {
  const { signal } = entry.controller;
  const question = db.createQuestion(run.projectId, run.id, 'engine', spec);
  db.setRunStatus(run.id, 'waiting_for_user');
  return new Promise((resolve, reject) => {
    const onAbort = () => { entry.waiters.delete(question.id); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.waiters.set(question.id, (answer) => {
      signal.removeEventListener('abort', onAbort);
      entry.waiters.delete(question.id);
      db.setRunStatus(run.id, 'running');
      db.appendProgress(run.id, '사용자 답변을 받아 작업을 이어 갑니다.');
      resolve(answer);
    });
  });
}

// ---- answer ----

export function validateAnswer(question: Question, raw: unknown): Answer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { choice, text } = raw as { choice?: unknown; text?: unknown };
  const c = typeof choice === 'string' && choice ? choice : null;
  const t = typeof text === 'string' && text.trim() ? text.trim().slice(0, 500) : null;
  if (c && !question.options.some((o) => o.label === c)) return null;
  if (t && !question.allowFreeText) return null;
  if (!c && !t) return null;
  return { choice: c, text: t };
}

export function submitAnswer(project: Project, question: Question, answer: Answer): StoredResponse {
  if (!db.answerQuestion(question.id, answer)) {
    return staleQuestion();
  }
  const answered = db.getQuestion(question.id)!;

  if (question.kind === 'widen_period') {
    if (answer.choice === WIDEN_YES) {
      const res = startResearch(db.getProject(project.id)!, 30);
      const runId = (res.body as { runId?: string }).runId ?? null;
      return ok({ accepted: true, question: answered, runId });
    }
    return ok({ accepted: true, question: answered, runId: null });
  }

  const waiter = live.get(question.runId)?.waiters.get(question.id);
  if (waiter) {
    waiter(answer);
    return ok({ accepted: true, question: answered, runId: question.runId });
  }
  // The run that asked is gone (server restarted): rerun the stage; the saved answer
  // is passed back as priorAnswers so the engine does not ask again.
  const run = db.getRun(question.runId)!;
  const fresh = db.getProject(project.id)!;
  const res = run.kind === 'research' ? startResearch(fresh, fresh.periodDays) : startDeepResearch(fresh);
  const runId = (res.body as { runId?: string }).runId ?? null;
  return ok({ accepted: true, question: answered, runId, resumed: true });
}

// ---- cancel ----

export function cancelRun(run: Run): StoredResponse {
  const entry = live.get(run.id);
  if (entry) {
    entry.controller.abort(new Error('cancelled'));
    return ok({ runId: run.id, status: 'cancelling' }, 202);
  }
  if (run.status === 'interrupted') {
    db.supersedeRunQuestions(run.id);
    db.setRunStatus(run.id, 'cancelled', { code: 'cancelled', message: '중단된 작업을 취소했습니다.', nextAction: '필요하면 다시 시작하세요.' });
    const p = db.getProject(run.projectId)!;
    db.updateProject(p.id, { stage: restingStage(p) });
  }
  return ok({ runId: run.id, status: db.getRun(run.id)!.status });
}

// ---- restart recovery ----

function recoverInterrupted(): number {
  const count = db.markInterruptedRuns({
    code: 'interrupted',
    message: '서버가 다시 시작되어 진행 중이던 작업이 중단되었습니다.',
    nextAction: '열린 질문이 있으면 답하면 이어서 진행합니다. 없으면 "다시 시도"를 누르세요.',
  });
  for (const p of [...db.listProjects(), ...db.listProjects(true)]) {
    if (p.stage === 'researching') db.updateProject(p.id, { stage: restingStage(p) });
    if (p.stage === 'deep_research' && !db.getOpenQuestion(p.id)) db.updateProject(p.id, { stage: restingStage(p) });
    if (p.stage === 'storyboard_drafting') db.updateProject(p.id, { stage: restingStage(p) });
    if (p.stage === 'producing') markUnfinishedImages(p.id, null);
  }
  return count;
}
