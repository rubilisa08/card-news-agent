import { EngineError } from './engine/types.ts';
import { STORY_ROLES } from './types.ts';
import type { DeepResearchDraft, DeepResearchResult, Hook, ResearchResult } from './types.ts';

/**
 * Editorial rules the app enforces on every engine's proposal (PRD 3절, DECISIONS
 * D12–D14), so they do not depend on the model following its prompt:
 * - a hook must rest on facts from the research record (no unverified features/effects);
 * - a hook that says '최신' needs a confirmed source date, shown with the search date;
 * - 이야기형 should follow 상황 → 불편 → 변화 → 활용 → 한계.
 * Hooks that break a rule are excluded with the reason, never silently kept.
 */

const LATEST = /최신/;

const kstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

export function applyEditorialRules(draft: DeepResearchDraft, research: ResearchResult): DeepResearchResult {
  const candidates = new Map(research.candidates.map((c) => [c.id, c]));
  const records = new Map(draft.records.map((r) => [r.candidateId, r]));
  const e = draft.editorial;
  const hooks: Hook[] = [];
  const excludedHooks: { text: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const h of e.hooks) {
    const basis = h.factRefs.flatMap((ref) => {
      const fact = records.get(ref.candidateId)?.facts[ref.factIndex];
      if (!fact) return [];
      return [{ candidateId: ref.candidateId, fact: fact.text, sourceUrl: fact.sourceUrl, publishedAt: candidates.get(ref.candidateId)?.publishedAt ?? null }];
    });
    if (!basis.length) {
      excludedHooks.push({ text: h.text, reason: '조사 기록의 확인된 사실과 연결되지 않아 제외했습니다.' });
      continue;
    }
    let latestBasis: string | null = null;
    if (LATEST.test(h.text)) {
      const dates = basis.map((b) => b.publishedAt);
      const unconfirmed = dates.some((d) => !d);
      const outside = dates.some((d) => d && d < research.periodStart);
      if (unconfirmed || outside) {
        excludedHooks.push({
          text: h.text,
          reason: unconfirmed
            ? "'최신'을 뒷받침할 원문 게시일이 확인되지 않아 제외했습니다."
            : "원문 게시일이 조사 기간보다 이전이라 '최신'으로 쓸 수 없어 제외했습니다.",
        });
        continue;
      }
      latestBasis = `조사 기준일 ${kstDate(research.searchedAt)} · 원문 게시일 ${[...new Set(dates)].join(', ')}`;
    }
    hooks.push({ text: h.text, basis, latestBasis });
  }

  if (!hooks.length) {
    throw new EngineError('engine_failed',
      '확인된 사실에 근거한 후킹 문구가 하나도 남지 않아 완료로 처리하지 않았습니다.',
      '심층 조사를 다시 시도하세요.');
  }
  if (hooks.length < 2) warnings.push(`규칙을 통과한 후킹 문구가 ${hooks.length}개뿐입니다(목표 2~3개).`);

  if (e.recommendedFormat === 'story') {
    // Each story role must appear, in order, among the card roles.
    let at = -1;
    const inOrder = STORY_ROLES.every((role) => {
      const i = e.structure.findIndex((s, idx) => idx > at && s.role.includes(role));
      if (i < 0) return false;
      at = i;
      return true;
    });
    if (!inOrder) warnings.push(`이야기형 구성이 ${STORY_ROLES.join(' → ')} 순서를 따르지 않습니다. 스토리보드에서 확인하세요.`);
  }

  return {
    mock: draft.mock,
    records: draft.records,
    editorial: { ...e, hooks, excludedHooks, warnings },
  };
}
