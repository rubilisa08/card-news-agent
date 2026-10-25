/**
 * News organisations the user wants searched on every topic (DECISIONS B38, B39).
 * Some of them block the search tool's crawler (checked 2026-10-24). Their recent
 * articles are listed through the Google News RSS search (`site:` + `when:`), which
 * gives each article's title, newspaper and time and links to the original; a Daum
 * News copy, when found, can be opened to read the text (B42). Searching Daum, Nate,
 * Zum or MSN by keyword mostly returned old articles. A portal or Google News link
 * counts as that newspaper only when its publisher is one of the names below.
 */
import type { ResearchResult, Source } from './types.ts';
import { trustOf, type TrustTier } from './sourceTrust.ts';

export interface Outlet {
  name: string;
  /** Other names the newspaper goes by, as a portal or article may print it. */
  aliases: string[];
  domain: string;
  /** direct: search its own site; gnews: its site blocks the search tool, so list it through Google News. */
  via: 'direct' | 'gnews';
}

export const REQUIRED_OUTLETS: Outlet[] = [
  { name: 'SBS 뉴스', aliases: ['SBS'], domain: 'sbs.co.kr', via: 'direct' },
  { name: '중앙일보', aliases: [], domain: 'joongang.co.kr', via: 'gnews' },
  { name: '한국경제', aliases: ['한국경제신문', '한경'], domain: 'hankyung.com', via: 'direct' },
  { name: '조선일보', aliases: [], domain: 'chosun.com', via: 'gnews' },
  { name: '동아일보', aliases: [], domain: 'donga.com', via: 'gnews' },
  { name: '매일경제', aliases: ['매일경제신문', '매경'], domain: 'mk.co.kr', via: 'gnews' },
  { name: '서울신문', aliases: [], domain: 'seoul.co.kr', via: 'direct' },
  { name: '경향신문', aliases: [], domain: 'khan.co.kr', via: 'direct' },
  { name: '한겨레', aliases: ['한겨레신문'], domain: 'hani.co.kr', via: 'gnews' },
  { name: '한국일보', aliases: [], domain: 'hankookilbo.com', via: 'direct' },
  { name: '머니투데이', aliases: [], domain: 'mt.co.kr', via: 'direct' },
];

/** Portal pages that carry or link a newspaper's own article under its name. */
const PORTALS = ['news.google.com', 'v.daum.net', 'news.daum.net', 'n.news.naver.com', 'news.naver.com'];

const hostOf = (url: string) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
const under = (h: string, dom: string) => h === dom || h.endsWith(`.${dom}`);
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

export const isPortal = (url: string) => PORTALS.some((p) => under(hostOf(url), p));

/** The listed newspaper an article belongs to: by its address, or a portal copy by its named publisher. */
export function outletOf(src: Pick<Source, 'url' | 'publisher' | 'site'>): Outlet | null {
  const h = hostOf(src.url);
  const site = src.site ? hostOf(`https://${src.site}`) : '';
  const own = REQUIRED_OUTLETS.find((o) => under(h, o.domain) || (isPortal(src.url) && site && under(site, o.domain)));
  if (own) return own;
  if (!isPortal(src.url)) return null;
  const p = norm(src.publisher ?? '');
  return REQUIRED_OUTLETS.find((o) => [o.name, ...o.aliases].some((n) => norm(n) === p)) ?? null;
}

/** Every source in a research result: candidates, held stories and the full article list. */
export const researchSources = (r: ResearchResult | null | undefined): Source[] =>
  [...(r?.candidates ?? []), ...(r?.held ?? [])].flatMap((c) => c.sources).concat(r?.articles ?? []);

/**
 * Tiers of the portal and Google News links in a research result, from the site
 * that published each article (its `site`, or a listed newspaper's name).
 */
export function portalTiers(sources: Source[]): Map<string, TrustTier> {
  const map = new Map<string, TrustTier>();
  for (const s of sources) {
    if (!isPortal(s.url)) continue;
    const site = s.site ? hostOf(`https://${s.site}`) : '';
    const tier = site && !PORTALS.some((p) => under(site, p)) ? trustOf(`https://${site}/`) : outletOf(s) ? 'major' : null;
    if (tier) map.set(s.url, tier);
  }
  return map;
}

/** How many candidates each listed newspaper appears in. */
export function outletCoverage(candidates: ResearchResult['candidates']) {
  return REQUIRED_OUTLETS.map((o) => ({
    name: o.name,
    via: o.via,
    count: candidates.filter((c) => c.sources.some((s) => outletOf(s) === o)).length,
  }));
}

/** The research rule that sends the engine to every listed newspaper. */
export function outletRule(n: number, days: number) {
  const direct = REQUIRED_OUTLETS.filter((o) => o.via === 'direct');
  const gnews = REQUIRED_OUTLETS.filter((o) => o.via === 'gnews');
  return `${n}. 다음 언론사는 주제마다 반드시 따로 찾는다(사용자 요청).
   - 직접 검색: ${direct.map((o) => `${o.name}(${o.domain})`).join(', ')}. WebSearch에 allowed_domains로 그 언론사 주소 하나를 주고 주제 검색어(한국어)로 찾는다. url은 그 언론사 한국어판 주소 그대로 쓴다.
   - 구글 뉴스 목록으로 찾기: ${gnews.map((o) => `${o.name}(${o.domain})`).join(', ')}. 이 언론사 사이트는 검색 도구 접근을 막는다. 언론사마다 WebFetch로 https://news.google.com/rss/search?q=<주제 검색어>+site:<언론사 주소>+when:${days}d&hl=ko&gl=KR&ceid=KR:ko 를 연다(검색어는 한국어 핵심어 1~3개, 띄어쓰기는 +, 한글은 URL 인코딩). 결과 목록의 각 항목에 있는 제목·언론사(source)·게시 시각(pubDate)만 믿고, 목록에서 주제에 맞는 기사를 고른다.
     url은 그 항목의 link(news.google.com/rss/articles/… 주소, 누르면 원문으로 이동)를 그대로 쓰고, site에는 언론사 도메인을 쓰고, publisher는 "${gnews.map((o) => o.name).join('", "')}" 중 하나로 정확히 적고, publishedAt은 pubDate를 한국 시간 날짜로 바꿔 쓴다. 이 기사들은 본문을 열 수 없으므로 제목에 드러난 내용만 근거로 삼는다. 본문이 필요하면 WebSearch에 allowed_domains ["v.daum.net"]과 그 기사 제목을 주어 다음 뉴스에 실린 같은 기사를 찾아 열고, 기사에 적힌 언론사가 같을 때만 sources에 함께 넣는다.
   - 조사 기간 안의 기사만 쓴다. 같은 소식을 다룬 후보의 sources에 넣고(공식 발표가 있으면 그 다음 자리), 이 언론사들만 다룬 소식이라도 주제에 맞으면 후보로 낸다.
   - 조사 기간 안의 관련 기사를 찾지 못한 언론사는 note에 이름을 모아 "조사 기간 안의 관련 기사를 찾지 못한 언론사: …"로 적는다.`;
}
