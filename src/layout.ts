import type { CardDesign, CardLayout, LayoutSet, StoryCard, Storyboard } from './types.ts';

// magazine and bold were removed at the user's request (2026-10-23); sets saved
// with them fall back to basic.
export const DESIGNS: readonly CardDesign[] = ['basic', 'soft', 'brief', 'news', 'photo', 'cinema'];

// Limits for card text layout. Sizes are px on the 1080×1350 card; on a 360px-wide
// phone screen they shrink to a third.
export const LIMITS = {
  headline: { maxChars: 60 },
  body: { maxChars: 240 },
  headlineSize: { min: 48, max: 120 },
  bodySize: { min: 28, max: 64 },
};

/** Starting layout: the storyboard text in the empty top 40% of the image. */
export function defaultLayout(card: StoryCard): CardLayout {
  return {
    index: card.index,
    headline: card.headline,
    body: card.body,
    position: 'top',
    align: 'left',
    headlineSize: 76,
    bodySize: 40,
    theme: 'dark',
    panel: 'none',
    image: true,
    textStyle: 'plain',
    emoji: '',
    tone: 'palette',
    updatedAt: null,
  };
}

/** Cards whose picture is needed: every card except text-only ones. */
export function needsImage(sb: Storyboard | null, saved: LayoutSet | null, index: number): boolean {
  return effectiveLayouts(sb, saved)?.find((l) => l.index === index)?.image !== false;
}

/** Layouts for every card of the approved storyboard; unsaved cards get the default. */
export function effectiveLayouts(sb: Storyboard | null, saved: LayoutSet | null) {
  if (!sb?.approvedAt) return null;
  const own = saved?.storyboardVersion === sb.version ? saved.cards : [];
  return sb.cards.map((c) => {
    const s = own.find((l) => l.index === c.index);
    // Layouts saved before text-only cards existed have no image flag.
    const base = defaultLayout(c);
    return {
      ...(s ?? base), image: s?.image ?? true, textStyle: s?.textStyle ?? base.textStyle, emoji: s?.emoji ?? base.emoji, tone: s?.tone ?? base.tone,
      saved: !!s,
    };
  });
}

const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const intIn = (v: unknown, r: { min: number; max: number }) => Number.isInteger(v) && (v as number) >= r.min && (v as number) <= r.max;

/** Returns the cleaned layout, or a message saying what is wrong. */
export function validateLayout(index: number, v: unknown): CardLayout | string {
  if (!v || typeof v !== 'object') return '배치 값이 없습니다.';
  const o = v as Record<string, unknown>;
  const headline = typeof o.headline === 'string' ? o.headline.trim() : '';
  const body = typeof o.body === 'string' ? o.body.trim() : '';
  if (!headline || headline.length > LIMITS.headline.maxChars) return `제목은 1~${LIMITS.headline.maxChars}자로 입력하세요.`;
  if (body.length > LIMITS.body.maxChars) return `본문은 ${LIMITS.body.maxChars}자 이하로 입력하세요.`;
  if (!oneOf(o.position, ['top', 'middle', 'bottom'] as const)) return '글자 위치 값이 올바르지 않습니다.';
  if (!oneOf(o.align, ['left', 'center'] as const)) return '정렬 값이 올바르지 않습니다.';
  if (!oneOf(o.theme, ['dark', 'light'] as const)) return '글자색 값이 올바르지 않습니다.';
  if (!oneOf(o.panel, ['none', 'soft', 'solid'] as const)) return '배경 받침 값이 올바르지 않습니다.';
  if (o.image !== undefined && typeof o.image !== 'boolean') return '그림 사용 값이 올바르지 않습니다.';
  if (o.textStyle !== undefined && !oneOf(o.textStyle, ['plain', 'strips', 'highlight', 'poster'] as const)) return '글자 카드 모양 값이 올바르지 않습니다.';
  if (o.tone !== undefined && !oneOf(o.tone, ['palette', 'blue', 'orange', 'green', 'pink', 'black'] as const)) return '포스터 색 값이 올바르지 않습니다.';
  const emoji = typeof o.emoji === 'string' ? o.emoji.trim() : '';
  if ([...emoji].length > 4) return '이모지는 4글자 이하로 넣어 주세요.';
  if (!intIn(o.headlineSize, LIMITS.headlineSize)) return `제목 크기는 ${LIMITS.headlineSize.min}~${LIMITS.headlineSize.max}입니다.`;
  if (!intIn(o.bodySize, LIMITS.bodySize)) return `본문 크기는 ${LIMITS.bodySize.min}~${LIMITS.bodySize.max}입니다.`;
  return {
    index, headline, body,
    position: o.position, align: o.align, theme: o.theme, panel: o.panel, image: o.image !== false,
    textStyle: (o.textStyle as CardLayout['textStyle']) ?? 'plain', emoji, tone: (o.tone as CardLayout['tone']) ?? 'palette',
    headlineSize: o.headlineSize as number, bodySize: o.bodySize as number,
    updatedAt: new Date().toISOString(),
  };
}

/** The set's design; sets saved with a removed design fall back to basic. */
export function effectiveDesign(sb: Storyboard | null, saved: LayoutSet | null): CardDesign {
  // The design is a choice for the whole set, so it outlives storyboard revisions.
  const d = sb ? saved?.design : undefined;
  return d && DESIGNS.includes(d) ? d : 'basic';
}
