import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { DATA_DIR } from './db.ts';
import { drawSvg } from './engine/claude-cli.ts';
import { EngineError } from './engine/types.ts';
import type { EngineContext } from './engine/types.ts';
import { artDirection } from './artDirection.ts';
import type { CardDesign, CardImage, ImageSet, ImageTool, RunError, Storyboard, StoryCard } from './types.ts';

/**
 * Image worker (PRD 5절). Each card is generated on its own and checked on disk:
 * the file must exist, be a real PNG or JPEG (or a validated SVG for the Claude fallback),
 * and have sane dimensions. A request sent or a JSON reply received is never
 * counted as success. agy is asked in natural language to use its built-in
 * generate_image tool; no unverified image subcommand is used.
 *
 * Fallback (DECISIONS D15): when agy cannot produce the set's first image (not
 * installed, login, permission, or no file), the whole set switches to SVG drawn by
 * Claude CLI so every card keeps one style. A failure after agy already produced a
 * card is marked failed for retry instead of mixing tools.
 */

const AGY_BIN = process.env.AGY_BIN ?? 'agy';
const AGY_TIMEOUT_MS = Number(process.env.CARD_NEWS_IMAGE_TIMEOUT_MS ?? 10 * 60_000);
/**
 * Where agy keeps what it makes. Its generate_image saves into
 * brain/<conversation>/ (as JPEG), not into the working folder, and in headless
 * mode it is not allowed to run a command to move the file (DECISIONS B32).
 */
const AGY_BRAIN = process.env.AGY_BRAIN_DIR ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
export const FILE_NAME = /^card-\d{2}\.(png|jpg|svg)$/;

export function imageDir(projectId: string) {
  return path.join(DATA_DIR, 'projects', projectId, 'images');
}

export function defaultImageTool(mockEngine: boolean): ImageTool {
  const forced = process.env.CARD_NEWS_IMAGE_TOOL;
  if (forced === 'agy' || forced === 'claude-cli-svg' || forced === 'mock') return forced;
  return mockEngine ? 'mock' : 'agy';
}

export function newImageSet(sb: Storyboard, tool: ImageTool): ImageSet {
  return {
    storyboardVersion: sb.version,
    tool,
    fallbackReason: null,
    cards: sb.cards.map((c) => ({
      index: c.index, status: 'pending', tool: null, file: null, format: null, width: null, height: null,
      bytes: null, prompt: '', createdAt: null, error: null, attempts: 0,
    })),
  };
}

/** The card's scene, plus the user's change request when the picture is redone. */
const scene = (card: StoryCard, note?: string) => (note ? `${card.imagePrompt}\n이 카드 그림의 수정 요청(반드시 반영): ${note}` : card.imagePrompt);

function agyPrompt(sb: Storyboard, card: StoryCard, design: CardDesign, note?: string) {
  return `내장 generate_image 도구로 카드뉴스용 그림 한 장을 만들어 줘.
- 그림 파일을 옮기거나 이름을 바꾸거나 형식을 바꾸는 명령은 실행하지 마. 권한이 없어 작업이 멈춘다. 앱이 파일을 직접 가져간다.
- 공통 그림체와 색감(모든 카드가 같아야 함): ${sb.styleGuide}
- 이 카드의 장면: ${scene(card, note)}
- 그림의 역할: ${card.imageRole}
- 실제 제품 화면, 실제 사건 사진, 실존 인물처럼 보이지 않게 그린다.
${artDirection(design, sb.styleGuide, 'agy')}
위 그림 규칙(크기·색·여백·위치)은 공통 그림체 설명이나 장면 설명과 다르면 이 그림 규칙을 따른다.
그림을 만든 뒤에는 생성된 그림 파일의 절대 경로만 답에 적어 줘.`;
}

// ---------- file checks ----------

interface Checked { format: 'png' | 'jpg' | 'svg'; width: number; height: number; bytes: number }

function checkPng(file: string): Checked {
  const buf = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 33 || !sig.every((b, i) => buf[i] === b) || buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('PNG 형식이 아닙니다(파일 시그니처 불일치).');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 256 || height < 256 || width > 8192 || height > 8192) throw new Error(`이미지 크기가 비정상입니다(${width}×${height}).`);
  return { format: 'png', width, height, bytes: buf.length };
}

/** A real JPEG: SOI marker, and the size from its first frame header. */
export function checkJpg(file: string): Checked {
  const buf = readFileSync(file);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('JPEG 형식이 아닙니다(파일 시그니처 불일치).');
  let o = 2;
  while (o + 9 < buf.length) {
    if (buf[o] !== 0xff) { o++; continue; }
    const m = buf[o + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const height = buf.readUInt16BE(o + 5), width = buf.readUInt16BE(o + 7);
      if (width < 256 || height < 256 || width > 8192 || height > 8192) throw new Error(`이미지 크기가 비정상입니다(${width}×${height}).`);
      return { format: 'jpg', width, height, bytes: buf.length };
    }
    o += 2 + buf.readUInt16BE(o + 2);
  }
  throw new Error('JPEG에서 그림 크기를 찾지 못했습니다.');
}

const IMAGE_EXT = /\.(png|jpe?g)$/i;

/** Image files under agy's brain folder written since `since` (ms), newest first. */
function agyImagesSince(since: number): string[] {
  if (!existsSync(AGY_BRAIN)) return [];
  const out: { f: string; t: number }[] = [];
  for (const conv of readdirSync(AGY_BRAIN)) {
    const dir = path.join(AGY_BRAIN, conv);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (!IMAGE_EXT.test(f)) continue;
        const t = statSync(path.join(dir, f)).mtimeMs;
        if (t >= since) out.push({ f: path.join(dir, f), t });
      }
    } catch { /* a folder agy is still writing */ }
  }
  return out.sort((a, b) => b.t - a.t).map((x) => x.f);
}

function checkSvg(svg: string): Checked {
  const s = svg.trim().replace(/^<\?xml[^>]*>\s*/, '');
  if (!s.startsWith('<svg')) throw new Error('SVG가 <svg>로 시작하지 않습니다.');
  if (/<(text|tspan|script|foreignObject)\b/i.test(s)) throw new Error('SVG에 글자나 스크립트 요소가 들어 있습니다.');
  if (/\son\w+\s*=/i.test(s) || /href\s*=\s*["']\s*(https?:|javascript:)/i.test(s)) throw new Error('SVG에 이벤트 속성이나 외부 링크가 들어 있습니다.');
  const vb = s.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (!vb) throw new Error('SVG에 viewBox가 없습니다.');
  return { format: 'svg', width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])), bytes: Buffer.byteLength(s) };
}

// ---------- tools ----------

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
}

/** Thrown when agy itself cannot be used, as opposed to a single bad attempt. */
class AgyUnavailable extends Error {}

function runAgy(cwd: string, prompt: string, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const child = spawn(AGY_BIN, ['-p', prompt, '--output-format', 'json', '--print-timeout', `${Math.round(AGY_TIMEOUT_MS / 60_000)}m`],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child.pid), AGY_TIMEOUT_MS + 30_000);
    const onAbort = () => { killTree(child.pid); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer); signal.removeEventListener('abort', onAbort);
      reject(err.code === 'ENOENT' ? new AgyUnavailable('agy(Antigravity CLI)를 찾을 수 없습니다.') : err);
    });
    child.on('close', (code) => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve({ code, stdout, stderr }); });
  });
}

/**
 * Finds the picture agy made in this run and copies it into the card folder: a path
 * named in its reply first, else an image written during the run in its brain
 * folder or in the working folder. The copied file decides success; the reply is
 * only read to find or explain it. Every run is written to agy-card-NN.log.
 */
export function collectAgyImage(dir: string, index: number, started: number, reply: string): { file: string; checked: Checked; from: string } | null {
  const named = (reply.match(/[A-Za-z]:[\\/][^\n"'`<>|*?]+?\.(?:png|jpe?g)|\/[^\s"'`]+?\.(?:png|jpe?g)/gi) ?? [])
    .map((f) => f.replace(/\\\\/g, '\\').trim());
  const fresh = [
    ...agyImagesSince(started),
    ...readdirSync(dir).filter((f) => IMAGE_EXT.test(f) && !/^card-\d{2}(\.v\d+)?\./.test(f)).map((f) => path.join(dir, f))
      .filter((f) => statSync(f).mtimeMs >= started),
  ];
  const from = [...named, ...fresh].find((f) => existsSync(f) && statSync(f).mtimeMs >= started - 1000);
  if (!from) return null;
  const jpeg = readFileSync(from).subarray(0, 2).equals(Buffer.from([0xff, 0xd8]));
  const file = `card-${String(index).padStart(2, '0')}.${jpeg ? 'jpg' : 'png'}`;
  copyFileSync(from, path.join(dir, file));
  return { file, from, checked: jpeg ? checkJpg(path.join(dir, file)) : checkPng(path.join(dir, file)) };
}

async function generateWithAgy(dir: string, sb: Storyboard, card: StoryCard, signal: AbortSignal, design: CardDesign, note?: string): Promise<{ checked: Checked; file: string }> {
  const started = Date.now();
  const prompt = agyPrompt(sb, card, design, note);
  const log = path.join(dir, `agy-card-${String(card.index).padStart(2, '0')}.log`);
  const write = (lines: string[]) => writeFileSync(log, lines.join('\n'), 'utf8');
  let res: { code: number | null; stdout: string; stderr: string };
  try {
    res = await runAgy(dir, prompt, signal);
  } catch (err) {
    write([`시작 ${new Date(started).toISOString()}`, `실행 실패: ${(err as Error).message}`, '', '[요청]', prompt]);
    throw err;
  }
  const { code, stdout, stderr } = res;
  let reply: { status?: string; response?: string; error?: unknown } = {};
  try { reply = JSON.parse(stdout); } catch { /* not JSON: the file decides */ }
  const got = collectAgyImage(dir, card.index, started, `${reply.response ?? ''}\n${stdout}`);
  write([
    `시작 ${new Date(started).toISOString()}, ${Math.round((Date.now() - started) / 1000)}초, 종료 코드 ${code}`,
    got ? `가져온 그림: ${got.from} → ${got.file} (${got.checked.format.toUpperCase()} ${got.checked.width}×${got.checked.height}, ${got.checked.bytes}바이트)` : '가져온 그림: 없음',
    '', '[요청]', prompt, '', '[stdout]', stdout.slice(0, 20_000), '', '[stderr]', stderr.slice(-4000),
  ]);
  if (!got) {
    const said = `${typeof reply.error === 'string' ? reply.error : JSON.stringify(reply.error ?? '')} ${stderr}`.trim();
    if (/authenticat|unauthori[sz]ed|credential|log ?in required/i.test(said)) throw new AgyUnavailable(`agy 로그인이 필요합니다: ${said.slice(0, 200)}`);
    if (/denied|not allowed/i.test(stderr)) throw new AgyUnavailable(`agy가 도구 권한을 받지 못했습니다: ${stderr.slice(0, 200)}`);
    const told = `${reply.response ?? ''} ${said}`;
    if (/RESOURCE_EXHAUSTED|\b429\b|quota|할당량/i.test(told)) {
      const reset = told.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z/)?.[0];
      throw new AgyUnavailable(`agy 이미지 사용 한도가 다 찼습니다${reset ? `(초기화 예정 ${new Date(reset).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })})` : ''}. "Claude CLI로 그리기"를 누르면 이어서 그릴 수 있습니다. (자세한 기록: ${path.basename(log)})`);
    }
    const why = said || (reply.response ?? '').slice(0, 200) || `종료 코드 ${code}`;
    throw new AgyUnavailable(`agy가 이미지 파일을 만들지 못했습니다: ${why} (자세한 기록: ${path.basename(log)})`);
  }
  return got;
}

async function generateWithClaudeSvg(ctx: EngineContext, dir: string, sb: Storyboard, card: StoryCard, fileName: string, design: CardDesign, note?: string): Promise<Checked> {
  const svg = await drawSvg(ctx, sb.styleGuide, `${scene(card, note)} (그림의 역할: ${card.imageRole})`, artDirection(design, sb.styleGuide, 'svg'));
  const checked = checkSvg(svg);
  writeFileSync(path.join(dir, fileName), svg.trim(), 'utf8');
  return checked;
}

/** Test-only image: a small gradient PNG written without any external tool. */
function generateMock(dir: string, card: StoryCard, fileName: string): Checked {
  const w = 432, h = 540;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const t = y / h;
      raw[o] = Math.round(246 - t * (246 - 35) * (y > h * 0.4 ? 1 : 0.1));
      raw[o + 1] = Math.round(241 - t * (241 - 53) * (y > h * 0.4 ? 1 : 0.1));
      raw[o + 2] = Math.round(231 - t * (231 - 107) * (y > h * 0.4 ? 1 : 0.1) + (card.index * 7) % 20);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(path.join(dir, fileName), png);
  return checkPng(path.join(dir, fileName));
}

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}

// ---------- the worker ----------

export interface ImageRun {
  ctx: EngineContext;
  storyboard: Storyboard;
  images: ImageSet;
  indices: number[];
  /** Persists the set after every change so the screen shows per-card progress. */
  save(images: ImageSet): void;
  /** Test switch: card numbers (1-based) whose generation fails on purpose. */
  failCards?: Set<number>;
  /** The user's change request per card, when a done picture is redone. */
  notes?: Record<number, string>;
  /** Card design the pictures are composed for (B31). */
  design: CardDesign;
}

/** Generates the requested cards in order. Returns how many failed. */
export async function generateImages(run: ImageRun): Promise<number> {
  const { ctx, storyboard: sb, images } = run;
  const dir = imageDir(ctx.projectId);
  mkdirSync(dir, { recursive: true });
  let failed = 0;

  for (const index of run.indices) {
    const card = sb.cards.find((c) => c.index === index)!;
    const slot = images.cards.find((c) => c.index === index)!;
    if (slot.status === 'done') continue;
    let checked: Checked | null = null;
    let error: RunError | null = null;
    slot.status = 'generating';
    slot.attempts += 1;
    run.save(images);

    while (!checked && !error) {
      const tool = images.tool;
      const fileName = `card-${String(index).padStart(2, '0')}.${tool === 'claude-cli-svg' ? 'svg' : 'png'}`;
      const note = run.notes?.[index];
      slot.prompt = tool === 'agy' ? agyPrompt(sb, card, run.design, note)
        : `${sb.styleGuide}\n${scene(card, note)}\n${artDirection(run.design, sb.styleGuide, tool === 'claude-cli-svg' ? 'svg' : 'agy')}`;
      ctx.progress(`${index}번 카드 이미지 생성 중 (${tool === 'agy' ? 'agy' : tool === 'claude-cli-svg' ? 'Claude CLI SVG' : '모의'})`);
      try {
        if (run.failCards?.has(index) && slot.attempts === 1) {
          throw new EngineError('image_failed', `[모의 오류] ${index}번 카드 이미지 생성이 실패했습니다(시험용 오류).`, '이 카드의 "다시 시도"를 누르세요.');
        }
        if (tool === 'agy') {
          const got = await generateWithAgy(dir, sb, card, ctx.signal, run.design, note);
          checked = got.checked;
          slot.file = got.file;
        } else {
          checked = tool === 'claude-cli-svg' ? await generateWithClaudeSvg(ctx, dir, sb, card, fileName, run.design, note)
            : generateMock(dir, card, fileName);
          slot.file = fileName;
        }
        slot.tool = tool;
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const agyNeverWorked = !images.cards.some((c) => c.status === 'done' && c.tool === 'agy');
        if (err instanceof AgyUnavailable && agyNeverWorked) {
          images.tool = 'claude-cli-svg';
          images.fallbackReason = err.message;
          ctx.progress(`agy로 이미지를 만들지 못해 Claude CLI SVG로 전환합니다: ${err.message.slice(0, 120)}`);
          run.save(images);
          continue;
        }
        error = err instanceof EngineError ? err.toRunError()
          : { code: 'image_failed', message: `${index}번 카드 이미지 생성 실패: ${(err as Error).message.slice(0, 300)}`, nextAction: '이 카드의 "다시 시도"를 누르세요.' };
      }
    }

    if (checked) {
      Object.assign(slot, { status: 'done', format: checked.format, width: checked.width, height: checked.height, bytes: checked.bytes, createdAt: new Date().toISOString(), error: null, design: run.design });
      ctx.progress(`${index}번 카드 이미지 확인 완료: ${slot.file} (${checked.format.toUpperCase()} ${checked.width}×${checked.height}, ${Math.round(checked.bytes / 1024)}KB)`);
    } else {
      Object.assign(slot, { status: 'failed', error });
      failed++;
      ctx.progress(`${index}번 카드 이미지 실패: ${error!.message.slice(0, 120)}`);
    }
    run.save(images);
    writeProvenance(dir, sb, images);
  }
  return failed;
}

/** Image provenance record kept next to the files (PRD 5절: tool, date, prompt, earlier versions). */
export function writeProvenance(dir: string, sb: Storyboard, images: ImageSet) {
  const lines = [
    '# 이미지 생성 기록', '',
    `- 스토리보드 버전: ${sb.version}`,
    `- 도구: ${images.tool}${images.fallbackReason ? ` (agy 대신 사용한 이유: ${images.fallbackReason})` : ''}`,
    '- 모든 이미지는 설명용으로 생성한 그림이며, 실제 제품 화면이나 보도 사진이 아니다.', '',
  ];
  for (const c of images.cards) {
    lines.push(`## ${c.index}번 카드`, `- 상태: ${c.status}`);
    if (c.file) lines.push(`- 파일: ${c.file} (${c.format?.toUpperCase()} ${c.width}×${c.height}, ${c.bytes}바이트)`, `- 생성 도구: ${c.tool}`, `- 생성 시각: ${c.createdAt}`);
    if (c.error) lines.push(`- 오류: ${c.error.message}`);
    for (const h of c.history ?? []) lines.push(`- 이전 그림 보관: ${h.backup} (${h.at}, 바꾼 이유: ${h.instruction})`);
    lines.push('- 요청:', '```', c.prompt, '```', '');
  }
  writeFileSync(path.join(dir, 'PROVENANCE.md'), lines.join('\n'), 'utf8');
}
