import { EngineError } from './engine/types.ts';
import { STORY_ROLES } from './types.ts';
import type { DeepResearchResult, ResearchResult, StoryCard, StoryboardDraft } from './types.ts';

/**
 * Storyboard rules the app checks on every engine's draft (PRD 4절, DECISIONS D12–D14):
 * 5–8 cards, a cover first and a summary/next step last, one message per card,
 * every content card tied to verified facts, numbers that appear in those facts,
 * '최신' only with confirmed source dates, and 이야기형 in its role order.
 * Problems become warnings shown before approval; the user decides.
 */

const MIN_CARDS = 5;
const MAX_CARDS = 8;
const HEADLINE_MAX = 40;
const BODY_MAX = 140;

const sentences = (t: string) => t.split(/(?<=[.!?。])\s+/).filter((s) => s.trim()).length;
const numbersIn = (t: string) => t.match(/\d[\d,.]*/g) ?? [];

export function applyStoryboardRules(
  draft: StoryboardDraft, deep: DeepResearchResult, research: ResearchResult,
): { cards: StoryCard[]; warnings: string[] } {
  const records = new Map(deep.records.map((r) => [r.candidateId, r]));
  const candidates = new Map(research.candidates.map((c) => [c.id, c]));
  const warnings: string[] = [];

  if (draft.cards.length < 3) {
    throw new EngineError('engine_failed', `스토리보드 카드가 ${draft.cards.length}장뿐이라 완료로 처리하지 않았습니다.`, '스토리보드를 다시 만드세요.');
  }
  if (draft.cards.length < MIN_CARDS || draft.cards.length > MAX_CARDS) {
    warnings.push(`카드가 ${draft.cards.length}장입니다(보통 ${MIN_CARDS}~${MAX_CARDS}장).`);
  }

  const cards: StoryCard[] = draft.cards.map((c, i) => {
    const sources = c.factRefs.flatMap((ref) => {
      const fact = records.get(ref.candidateId)?.facts[ref.factIndex];
      return fact ? [{ candidateId: ref.candidateId, fact: fact.text, url: fact.sourceUrl, publishedAt: candidates.get(ref.candidateId)?.publishedAt ?? null }] : [];
    });
    const n = i + 1;
    const isCover = i === 0;
    if (!isCover && !sources.length) warnings.push(`${n}번 카드에 근거가 된 확인된 사실이 없습니다.`);
    if (sentences(c.headline) > 1) warnings.push(`${n}번 카드 핵심 문장이 한 문장이 아닙니다.`);
    if (c.headline.length > HEADLINE_MAX) warnings.push(`${n}번 카드 핵심 문장이 ${c.headline.length}자로 깁니다(${HEADLINE_MAX}자 이내 권장).`);
    if (c.body.length > BODY_MAX) warnings.push(`${n}번 카드 본문이 ${c.body.length}자로 깁니다(${BODY_MAX}자 이내 권장).`);
    const factText = sources.map((s) => s.fact).join(' ');
    const unbacked = numbersIn(`${c.headline} ${c.body}`).filter((num) => !factText.includes(num.replace(/[.,]$/, '')));
    if (unbacked.length) warnings.push(`${n}번 카드의 숫자(${[...new Set(unbacked)].join(', ')})가 근거 사실에서 확인되지 않습니다.`);
    if (/최신/.test(c.headline) && (!sources.length || sources.some((s) => !s.publishedAt || s.publishedAt < research.periodStart))) {
      warnings.push(`${n}번 카드 핵심 문장의 '최신'을 원문 게시일로 뒷받침할 수 없습니다.`);
    }
    return { index: n, role: c.role, headline: c.headline, body: c.body, imageRole: c.imageRole, imagePrompt: c.imagePrompt, sources };
  });

  if (!/표지/.test(cards[0].role)) warnings.push('첫 카드가 표지가 아닙니다.');
  if (!/요약|정리|출처|다음|행동/.test(cards[cards.length - 1].role)) warnings.push('마지막 카드가 요약이나 다음 행동 안내가 아닙니다.');
  if (deep.editorial.recommendedFormat === 'story') {
    let at = -1;
    const inOrder = STORY_ROLES.every((role) => {
      const i = cards.findIndex((c, idx) => idx > at && c.role.includes(role));
      if (i < 0) return false;
      at = i;
      return true;
    });
    if (!inOrder) warnings.push(`이야기형인데 ${STORY_ROLES.join(' → ')} 순서를 따르지 않습니다.`);
  }
  return { cards, warnings };
}
