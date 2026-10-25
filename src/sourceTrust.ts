/**
 * How far a source can be trusted, from its address (DECISIONS B36). The user asked
 * that cards rest on the most trusted, widely known sources, and that news found
 * only on aggregators, blogs or unknown sites is not put forward: a tracker site
 * once dated an April model release to October.
 *
 * official   the company or public body itself, or its press-release wire
 * major      widely known news organisations
 * trade      established specialist outlets and research hosts
 * unverified everything else (aggregators, trackers, blogs, social posts, unknown sites)
 */

export type TrustTier = 'official' | 'major' | 'trade' | 'unverified';

export const TIER_LABEL: Record<TrustTier, string> = {
  official: '공식',
  major: '주요 언론',
  trade: '전문 매체',
  unverified: '확인 필요',
};

const RANK: Record<TrustTier, number> = { official: 3, major: 2, trade: 1, unverified: 0 };

const OFFICIAL = [
  // AI and tech companies
  'openai.com', 'anthropic.com', 'claude.com', 'blog.google', 'cloud.google.com', 'research.google', 'deepmind.google', 'ai.google.dev', 'googleblog.com', 'about.google',
  'about.fb.com', 'ai.meta.com', 'meta.com', 'atmeta.com', 'microsoft.ai', 'microsoft.com', 'blogs.microsoft.com', 'nvidia.com', 'nvidianews.nvidia.com', 'apple.com',
  'aboutamazon.com', 'aws.amazon.com', 'x.ai', 'deepseek.com', 'mistral.ai', 'minimax.io', 'moonshot.ai', 'kimi.com', 'alibabacloud.com',
  'qwenlm.github.io', 'ibm.com', 'intel.com', 'amd.com', 'tsmc.com', 'arm.com', 'qualcomm.com', 'cohere.com', 'perplexity.ai',
  'huggingface.co/blog', 'samsung.com', 'news.samsung.com', 'skhynix.com', 'news.skhynix.com', 'lgcorp.com', 'lgresearch.ai',
  'navercorp.com', 'kakaocorp.com', 'upstage.ai', 'kt.com', 'sktelecom.com',
  // public bodies
  'whitehouse.gov', 'congress.gov', 'europa.eu', 'gov.uk', 'nist.gov', 'ftc.gov', 'msit.go.kr', 'korea.kr', 'oecd.org', 'un.org',
  // press-release wires carry the company's own text
  'businesswire.com', 'prnewswire.com', 'globenewswire.com',
];

const MAJOR = [
  'reuters.com', 'apnews.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'bbc.com',
  'bbc.co.uk', 'cnbc.com', 'cnn.com', 'economist.com', 'axios.com', 'theinformation.com', 'theverge.com', 'techcrunch.com', 'wired.com',
  'arstechnica.com', 'technologyreview.com', 'engadget.com', 'venturebeat.com', 'zdnet.com', 'forbes.com', 'businessinsider.com',
  'fortune.com', 'nikkei.com', 'asia.nikkei.com', 'scmp.com', 'npr.org', 'politico.com', 'time.com',
  // Korea
  'yna.co.kr', 'yonhapnews.co.kr', 'chosun.com', 'joongang.co.kr', 'donga.com', 'hani.co.kr', 'khan.co.kr', 'mk.co.kr',
  'hankyung.com', 'sedaily.com', 'edaily.co.kr', 'mt.co.kr', 'newsis.com', 'news1.kr', 'kbs.co.kr', 'imbc.com', 'mbc.co.kr', 'sbs.co.kr',
  'ytn.co.kr', 'jtbc.co.kr', 'hankookilbo.com', 'kmib.co.kr', 'seoul.co.kr', 'etnews.com', 'zdnet.co.kr', 'heraldcorp.com',
  'koreaherald.com', 'koreatimes.co.kr', 'koreajoongangdaily.joins.com',
  // more national dailies, business dailies, broadcasters and sports dailies (B43:
  // 세계일보 and 파이낸셜뉴스 articles were held as unknown sites)
  'segye.com', 'fnnews.com', 'munhwa.com', 'asiae.co.kr', 'ajunews.com', 'dt.co.kr', 'naeil.com', 'nocutnews.co.kr',
  'mbn.co.kr', 'ichannela.com', 'tvchosun.com', 'yonhapnewstv.co.kr', 'wowtv.co.kr', 'mtn.co.kr', 'ohmynews.com',
  'busan.com', 'kookje.co.kr', 'imaeil.com', 'sportschosun.com', 'sportsseoul.com', 'isplus.com',
];

const TRADE = [
  'aitimes.com', 'aitimes.kr', 'bloter.net', 'byline.network', 'ddaily.co.kr', 'digitaltoday.co.kr', 'itworld.co.kr', 'ciokorea.com',
  'the-decoder.com', 'theregister.com', 'siliconangle.com', 'tomshardware.com', 'anandtech.com', 'nextgov.com', 'fedscoop.com',
  'searchengineland.com', 'infoq.com', 'semafor.com', '9to5mac.com', '9to5google.com', 'macrumors.com', 'androidauthority.com',
  'arxiv.org', 'nature.com', 'science.org', 'github.com', 'huggingface.co',
  // business and entertainment news sites
  'newspim.com', 'inews24.com', 'etoday.co.kr', 'economist.co.kr', 'bizwatch.co.kr', 'newsway.co.kr', 'osen.co.kr',
  'xportsnews.com', 'mydaily.co.kr', 'tenasia.co.kr', 'newsen.com', 'tvreport.co.kr', 'mhnse.com', 'starnewskorea.com',
  'esquirekorea.co.kr', 'marieclairekorea.com',
];

const host = (url: string) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};
const pathOf = (url: string) => {
  try { return new URL(url).pathname.toLowerCase(); } catch { return ''; }
};

/** Whether `h` is the listed domain or one of its subdomains (path-qualified entries match the path start). */
function listed(list: string[], url: string) {
  const h = host(url);
  const p = pathOf(url);
  return list.some((d) => {
    const [dom, ...rest] = d.split('/');
    const under = h === dom || h.endsWith(`.${dom}`);
    return under && (!rest.length || p.startsWith(`/${rest.join('/')}`));
  });
}

/**
 * `portals`: tiers of portal and Google News links found in this project's research,
 * taken from the news site that published the article (B39, B43).
 */
export function trustOf(url: string, portals?: ReadonlyMap<string, TrustTier>): TrustTier {
  const h = host(url);
  if (!h) return 'unverified';
  const known = portals?.get(url);
  if (known) return known;
  if (listed(OFFICIAL, url) || /\.(gov|go\.kr|gov\.uk|europa\.eu)$/.test(h)) return 'official';
  if (listed(MAJOR, url)) return 'major';
  if (listed(TRADE, url)) return 'trade';
  return 'unverified';
}

/** The best tier among several sources. */
export function bestTrust(urls: string[], portals?: ReadonlyMap<string, TrustTier>): TrustTier {
  return urls.map((u) => trustOf(u, portals)).reduce<TrustTier>((a, b) => (RANK[b] > RANK[a] ? b : a), 'unverified');
}

/** Official or a major news organisation: enough to put a story forward. */
export const isWellSourced = (tier: TrustTier) => RANK[tier] >= RANK.major;
