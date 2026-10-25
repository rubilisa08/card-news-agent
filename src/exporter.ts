import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.ts';
import type { Project } from './db.ts';
import { effectiveDesign, effectiveLayouts } from './layout.ts';
import { CARD_H, CARD_W, outputName, renderCard, zip } from './render.ts';
import type { RenderedCard } from './render.ts';
import { bestTrust, TIER_LABEL, trustOf } from './sourceTrust.ts';
import { portalTiers, researchSources } from './outlets.ts';
import type { CheckStatus, ExportCheck, ExportRecord } from './types.ts';

/**
 * Final approval and export (PRD 6단계, DECISIONS B29).
 *
 * The approval stores a fingerprint of everything that shows on the cards. Any later
 * change (text, layout, design, picture) changes the fingerprint, so the approval no
 * longer matches and the user has to approve again before a new export.
 *
 * The export renders every card, writes the PNGs, a ZIP and the source / image record,
 * then checks those written files. A check that could not be done is "unverified",
 * never "pass", and goes into the list of things the user has to look at.
 */

export const RECORD_NAME = '출처와 이미지 사용 기록.md';
export const CHECKS_NAME = '검사 결과.md';
export const ZIP_NAME = '카드뉴스.zip';
const SAFE = 60;
const strip = (s: string) => s.replace(/\*\*|==|__/g, '');
/** Words only: highlight marks, line breaks and spaces removed. */
const words = (s: string) => s.replace(/\*\*|==|__/g, '').replace(/\s+/g, '');

export const exportDir = (projectId: string, exportId: string) => path.join(DATA_DIR, 'projects', projectId, 'output', 'exports', exportId);

/** Fingerprint of what shows on the cards. */
export function cardSignature(p: Project): string | null {
  const sb = p.storyboard;
  const layouts = effectiveLayouts(sb, p.layouts);
  if (!sb?.approvedAt || !layouts || !p.images) return null;
  const shown = {
    storyboard: sb.version,
    design: effectiveDesign(sb, p.layouts),
    brand: p.layouts?.brand ?? '',
    layouts: layouts.map(({ updatedAt, saved, ...l }) => l),
    images: p.images.cards.map((c) => ({ index: c.index, status: c.status, file: c.file, bytes: c.bytes, createdAt: c.createdAt })),
  };
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 16);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Renders every card into a new export folder, writes the record and ZIP, and checks them. */
export async function buildExport(p: Project, baseUrl: string, progress: (m: string) => void): Promise<ExportRecord> {
  const sb = p.storyboard!;
  const layouts = effectiveLayouts(sb, p.layouts)!;
  const now = new Date();
  const id = stamp(now);
  const dir = exportDir(p.id, id);
  mkdirSync(dir, { recursive: true });

  const renders: RenderedCard[] = [];
  for (const c of sb.cards) {
    progress(`${c.index}번 카드 PNG 만드는 중`);
    renders.push(await renderCard(baseUrl, p.id, c.index, dir));
  }

  progress('출처와 이미지 사용 기록 작성 중');
  writeFileSync(path.join(dir, RECORD_NAME), recordText(p, layouts, renders, now), 'utf8');
  progress('ZIP 만드는 중');
  const entries = [...sb.cards.map((c) => outputName(c.index)), RECORD_NAME]
    .map((name) => ({ name, data: readFileSync(path.join(dir, name)) }));
  writeFileSync(path.join(dir, ZIP_NAME), zip(entries));

  progress('내보낸 파일 검사 중(누락·글자 잘림·출처·날짜)');
  const checks = await runChecks(p, dir, renders, now);
  const toReview = reviewList(checks, renders);
  writeFileSync(path.join(dir, CHECKS_NAME), checksText(p, checks, toReview, now), 'utf8');

  const kindOf = (f: string): ExportRecord['files'][number]['kind'] =>
    f.endsWith('.png') ? 'png' : f === ZIP_NAME ? 'zip' : f === CHECKS_NAME ? 'checks' : 'record';
  const files = readdirSync(dir).sort().map((name) => ({ name, bytes: statSync(path.join(dir, name)).size, kind: kindOf(name) }));
  return { id, createdAt: now.toISOString(), signature: cardSignature(p)!, files, checks, toReview };
}

// ---------- the record ----------

const TOOL_NAME: Record<string, string> = { agy: 'Antigravity agy', 'claude-cli-svg': 'Claude CLI (SVG 코드)', mock: '모의 이미지' };
const DESIGN_NAME: Record<string, string> = { basic: '기본', soft: '소프트', news: '뉴스 다크', photo: '포토 오버레이', cinema: '시네마' };

function recordText(p: Project, layouts: NonNullable<ReturnType<typeof effectiveLayouts>>, renders: RenderedCard[], now: Date) {
  const sb = p.storyboard!;
  const images = p.images!;
  const r = p.research;
  const lines = [
    `# 출처와 이미지 사용 기록: ${p.name || p.topic}`, '',
    `- 내보낸 시각: ${now.toISOString()}`,
    `- 최종 승인: ${p.final?.approvedAt ?? '없음'}`,
    `- 카드: ${sb.cards.length}장, PNG ${CARD_W}×${CARD_H}, 디자인 ${DESIGN_NAME[effectiveDesign(sb, p.layouts)]}`,
    r ? `- 조사: 주제 "${p.topic}", 조사 기준 시각 ${r.searchedAt}, 기간 ${r.periodStart} ~ ${r.periodEnd}(최근 ${r.periodDays}일)` : '- 조사: 기록 없음',
    `- 그림: 모두 설명용으로 생성한 그림입니다. 실제 제품 화면이나 보도 사진이 아닙니다. 도구 ${TOOL_NAME[images.tool] ?? images.tool}${images.fallbackReason ? ` (agy 대신 쓴 이유: ${images.fallbackReason})` : ''}`,
    '- 글자: 그림 위에 따로 얹었습니다(글꼴 Pretendard).',
    '',
  ];
  for (const c of sb.cards) {
    const l = layouts.find((x) => x.index === c.index)!;
    const img = images.cards.find((x) => x.index === c.index)!;
    const rend = renders.find((x) => x.index === c.index);
    lines.push(`## ${c.index}. ${strip(l.headline)}`, '',
      `- 역할: ${c.role}`, `- 본문: ${strip(l.body).replace(/\n/g, ' / ')}`, `- 파일: ${outputName(c.index)}${rend && !rend.fontLoaded ? ' (글꼴을 불러오지 못해 대체 글꼴로 찍힘)' : ''}`);
    lines.push('- 출처:');
    if (c.sources.length) for (const s of c.sources) lines.push(`  - [${TIER_LABEL[trustOf(s.url, portalTiers(researchSources(p.research)))]}] ${s.fact} (${s.url}, 게시 ${s.publishedAt ?? '미확인'})`);
    else lines.push('  - 연결된 확인 사실 없음');
    if (l.image === false) lines.push('- 그림: 없음(글자만 카드)');
    else lines.push(`- 그림: ${img.file} (${TOOL_NAME[img.tool ?? ''] ?? img.tool}, 생성 ${img.createdAt})`);
    for (const h of img.history ?? []) lines.push(`  - 이전 그림 보관: ${h.backup} (${h.at}, 바꾼 이유: ${h.instruction})`);
    const revs = p.revisions.filter((x) => x.index === c.index && x.status === 'done');
    if (revs.length) {
      lines.push('- 수정 기록:');
      for (const v of revs) lines.push(`  - ${v.finishedAt} ${v.kind === 'text' ? '글자' : '그림'} 수정: ${v.instruction}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------- checks on the written files ----------

const worst = (list: CheckStatus[]): CheckStatus => (list.includes('fail') ? 'fail' : list.includes('unverified') ? 'unverified' : 'pass');

/** Entry names and sizes from a ZIP's central directory. */
function zipEntries(buf: Buffer): { name: string; size: number }[] {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('ZIP 끝 표시가 없습니다.');
  const count = buf.readUInt16LE(end + 10);
  let o = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('ZIP 목록이 깨져 있습니다.');
    const size = buf.readUInt32LE(o + 24);
    const nameLen = buf.readUInt16LE(o + 28), extra = buf.readUInt16LE(o + 30), comment = buf.readUInt16LE(o + 32);
    out.push({ name: buf.toString('utf8', o + 46, o + 46 + nameLen), size });
    o += 46 + nameLen + extra + comment;
  }
  return out;
}

function pngSize(file: string): [number, number] | null {
  const b = readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || !sig.every((x, i) => b[i] === x)) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

async function urlStatus(url: string): Promise<{ status: CheckStatus; message: string }> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Mozilla/5.0 card-news-check' } });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { status: 'pass', message: `열림(${res.status})` };
    if (res.status === 404 || res.status === 410) return { status: 'fail', message: `페이지가 없습니다(${res.status})` };
    return { status: 'unverified', message: `사이트가 자동 확인을 막았습니다(${res.status}). 브라우저로 직접 열어 보세요` };
  } catch (err) {
    return { status: 'unverified', message: `열어 보지 못했습니다(${(err as Error).name === 'TimeoutError' ? '10초 초과' : (err as Error).message.slice(0, 60)}). 직접 열어 보세요` };
  }
}

async function runChecks(p: Project, dir: string, renders: RenderedCard[], now: Date): Promise<ExportCheck[]> {
  const sb = p.storyboard!;
  const layouts = effectiveLayouts(sb, p.layouts)!;
  const record = existsSync(path.join(dir, RECORD_NAME)) ? readFileSync(path.join(dir, RECORD_NAME), 'utf8') : '';

  // 1. Missing: every card's PNG on disk at the right size, every file in the ZIP, every card in the record.
  const missing: ExportCheck['details'] = [];
  let entries: { name: string; size: number }[] = [];
  try {
    entries = zipEntries(readFileSync(path.join(dir, ZIP_NAME)));
  } catch (err) {
    missing.push({ index: null, status: 'fail', message: `ZIP을 읽지 못했습니다: ${(err as Error).message}` });
  }
  for (const c of sb.cards) {
    const name = outputName(c.index);
    const file = path.join(dir, name);
    const size = existsSync(file) ? pngSize(file) : null;
    const inZip = entries.find((e) => e.name === name);
    const problems = [
      !existsSync(file) ? 'PNG 파일이 없음' : !size ? 'PNG 형식이 아님' : size[0] !== CARD_W || size[1] !== CARD_H ? `크기 ${size[0]}×${size[1]}` : '',
      !inZip ? 'ZIP에 없음' : existsSync(file) && inZip.size !== statSync(file).size ? 'ZIP 안 파일 크기가 다름' : '',
      !record.includes(`## ${c.index}. `) ? '기록 파일에 이 카드가 없음' : '',
    ].filter(Boolean);
    missing.push({ index: c.index, status: problems.length ? 'fail' : 'pass', message: problems.length ? problems.join(', ') : `${name} ${CARD_W}×${CARD_H}, ZIP과 기록에 있음` });
  }
  if (!entries.some((e) => e.name === RECORD_NAME)) missing.push({ index: null, status: 'fail', message: `ZIP에 "${RECORD_NAME}"이 없습니다` });

  // 2. Clipping: the text box on the very page that was pictured, and the drawn text vs. the saved text.
  const clipping: ExportCheck['details'] = sb.cards.map((c) => {
    const m = renders.find((r) => r.index === c.index)?.measure;
    const l = layouts.find((x) => x.index === c.index)!;
    if (!m) return { index: c.index, status: 'unverified', message: '찍을 때 글자 위치를 재지 못했습니다' };
    const problems = [
      m.top < SAFE ? `위로 ${Math.round(SAFE - m.top)}px 넘침` : '',
      m.bottom > CARD_H - SAFE ? `아래로 ${Math.round(m.bottom - (CARD_H - SAFE))}px 넘침` : '',
      m.left < 0 || m.right > CARD_W ? '옆으로 넘침' : '',
      m.overflowX ? '한 줄이 상자보다 넓음' : '',
      m.overlap ? `그림에 가림: ${m.overlap}` : '',
      words(m.headline) !== words(l.headline) ? '찍힌 제목이 저장한 제목과 다름' : '',
      words(m.body || '') !== words(l.body || '') ? '찍힌 본문이 저장한 본문과 다름' : '',
    ].filter(Boolean);
    return { index: c.index, status: problems.length ? 'fail' : 'pass', message: problems.length ? problems.join(', ') : `글자 영역 y ${Math.round(m.top)}~${Math.round(m.bottom)}, 가장자리 ${SAFE}px 안쪽` };
  });

  // 3. Sources: each card has one, it is in the record, and the link opens.
  const sources: ExportCheck['details'] = [];
  const opened = new Map<string, Promise<{ status: CheckStatus; message: string }>>();
  const portals = portalTiers(researchSources(p.research));
  for (const c of sb.cards) {
    if (!c.sources.length) {
      sources.push({ index: c.index, status: 'unverified', message: '이 카드에 연결된 출처가 없습니다. 내용이 출처에서 왔는지 직접 확인하세요' });
      continue;
    }
    // The card must rest on an official announcement or a major news organisation (B36).
    const tier = bestTrust(c.sources.map((s) => s.url), portals);
    if (tier === 'unverified') sources.push({ index: c.index, status: 'fail', message: `출처가 모두 "${TIER_LABEL.unverified}" 등급입니다(요약·추적 사이트·블로그 등). 공식 발표나 주요 언론으로 확인한 뒤 쓰세요` });
    else if (tier === 'trade') sources.push({ index: c.index, status: 'unverified', message: '전문 매체 보도만 있습니다. 공식 발표나 주요 언론으로 한 번 더 확인하세요' });
    else sources.push({ index: c.index, status: 'pass', message: `가장 신뢰도 높은 출처: ${TIER_LABEL[tier]}` });
    // One line per address: several facts of a card often share one article.
    for (const s of c.sources.filter((x, i, all) => all.findIndex((y) => y.url === x.url) === i)) {
      if (!/^https:\/\/[^\s]+$/.test(s.url)) { sources.push({ index: c.index, status: 'fail', message: `주소 형식이 이상합니다: ${s.url}` }); continue; }
      if (!record.includes(s.url)) { sources.push({ index: c.index, status: 'fail', message: `기록 파일에 출처 주소가 없습니다: ${s.url}` }); continue; }
      if (!opened.has(s.url)) opened.set(s.url, urlStatus(s.url));
      const u = await opened.get(s.url)!;
      sources.push({ index: c.index, status: u.status, message: `[${TIER_LABEL[trustOf(s.url, portals)]}] ${s.url} ${u.message}` });
    }
  }

  // 4. Dates: source dates are real and not in the future; dates written on the card
  //    can be found in that card's sources.
  const dates: ExportCheck['details'] = [];
  const r = p.research;
  for (const c of sb.cards) {
    const l = layouts.find((x) => x.index === c.index)!;
    for (const s of c.sources.filter((x, i, all) => all.findIndex((y) => y.url === x.url && y.publishedAt === x.publishedAt) === i)) {
      if (!s.publishedAt) { dates.push({ index: c.index, status: 'unverified', message: `게시일 미확인: ${s.url}` }); continue; }
      const d = new Date(`${s.publishedAt}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.publishedAt) || Number.isNaN(d.getTime())) { dates.push({ index: c.index, status: 'fail', message: `게시일 형식 오류: ${s.publishedAt}` }); continue; }
      if (d.getTime() > now.getTime() + 86_400_000) { dates.push({ index: c.index, status: 'fail', message: `게시일이 미래입니다: ${s.publishedAt}` }); continue; }
      if (r && (s.publishedAt < r.periodStart || s.publishedAt > r.periodEnd)) {
        dates.push({ index: c.index, status: 'unverified', message: `게시일 ${s.publishedAt}이 조사 기간(${r.periodStart}~${r.periodEnd}) 밖입니다. 최신 소식으로 써도 되는지 확인하세요` });
        continue;
      }
      if (!record.includes(s.publishedAt)) { dates.push({ index: c.index, status: 'fail', message: `기록 파일에 게시일이 없습니다: ${s.publishedAt}` }); continue; }
      dates.push({ index: c.index, status: 'pass', message: `게시일 ${s.publishedAt}(조사 기간 안, 기록에 있음)` });
    }
    const said = `${strip(l.headline)} ${l.body}`;
    const sourceText = c.sources.map((s) => `${s.fact} ${s.publishedAt ?? ''}`).join(' ');
    const sourceMD = new Set([...sourceText.matchAll(/(\d{1,2})월\s*(\d{1,2})일/g)].map((m) => `${+m[1]}-${+m[2]}`)
      .concat(c.sources.filter((s) => s.publishedAt).map((s) => `${+s.publishedAt!.slice(5, 7)}-${+s.publishedAt!.slice(8, 10)}`)));
    // Each date once, even when the title and the body both say it.
    const seen = new Set<string>();
    for (const m of said.matchAll(/(\d{1,2})월\s*(\d{1,2})일/g)) {
      const key = `${+m[1]}-${+m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dates.push(sourceMD.has(key)
        ? { index: c.index, status: 'pass', message: `카드의 "${m[0]}"이 이 카드 출처에 있음` }
        : { index: c.index, status: 'unverified', message: `카드의 "${m[0]}"을 이 카드 출처에서 찾지 못했습니다. 원문에서 날짜를 확인하세요` });
    }
  }

  return [
    { key: 'missing', label: '누락', status: worst(missing.map((d) => d.status)), method: '내보낸 폴더의 PNG 파일, ZIP 안 목록, 기록 파일을 다시 읽어 카드마다 대조', details: missing },
    { key: 'clipping', label: '글자 잘림·가림', status: worst(clipping.map((d) => d.status)), method: 'PNG를 찍은 바로 그 화면에서 글자 상자 위치를 재고, 제목·본문·출처 줄 아래 그림 픽셀과 글자색의 대비를 재고, 찍힌 글자를 저장한 글자와 대조(PNG 픽셀에서 글자를 읽은 것은 아님)', details: clipping },
    { key: 'sources', label: '출처', status: worst(sources.map((d) => d.status)), method: '카드마다 공식 발표나 주요 언론 출처가 있는지(출처 등급), 기록 파일에 주소가 있는지, 주소가 실제로 열리는지(10초 안에) 확인', details: sources },
    { key: 'dates', label: '날짜', status: worst(dates.map((d) => d.status)), method: '출처 게시일의 형식·미래 여부·조사 기간을 보고, 카드에 쓴 "○월 ○일"이 그 카드 출처에 있는지 대조', details: dates },
  ];
}

/** Failed or unverified items, then what no automatic check covers. */
function reviewList(checks: ExportCheck[], renders: RenderedCard[]): string[] {
  const out = checks.flatMap((c) => c.details.filter((d) => d.status !== 'pass')
    .map((d) => `[${c.label}${d.status === 'fail' ? ' 실패' : ' 확인 못 함'}]${d.index ? ` ${d.index}번 카드:` : ''} ${d.message}`));
  for (const r of renders) if (!r.fontLoaded) out.push(`[글꼴] ${r.index}번 카드가 대체 글꼴로 찍혔습니다. 인터넷 연결 후 다시 내보내세요`);
  out.push(
    '[직접 확인] PNG를 휴대폰에서 열어 글자가 그림과 겹쳐 읽기 어려운 곳이 없는지 보세요(자동 검사는 글자 위치만 쟀습니다)',
    '[직접 확인] 그림이 카드 내용과 어울리는지 보세요(생성 그림이라 자동으로 판단할 수 없습니다)',
    '[직접 확인] 문장의 사실이 출처 원문과 맞는지 원문을 열어 한 번 더 보세요(자동 검사는 주소와 날짜만 봤습니다)',
  );
  return out;
}

const STATUS_NAME: Record<CheckStatus, string> = { pass: '통과', fail: '실패', unverified: '확인 못 함' };

function checksText(p: Project, checks: ExportCheck[], toReview: string[], now: Date) {
  const lines = [`# 내보낸 파일 검사 결과: ${p.name || p.topic}`, '', `- 검사 시각: ${now.toISOString()}`, '- "확인 못 함"은 통과가 아닙니다. 아래 "직접 확인할 것"을 보세요.', ''];
  for (const c of checks) {
    lines.push(`## ${c.label}: ${STATUS_NAME[c.status]}`, `- 방법: ${c.method}`);
    for (const d of c.details) lines.push(`- ${STATUS_NAME[d.status]}${d.index ? ` · ${d.index}번` : ''}: ${d.message}`);
    lines.push('');
  }
  lines.push('## 직접 확인할 것', ...toReview.map((t) => `- ${t}`), '');
  return lines.join('\n');
}
