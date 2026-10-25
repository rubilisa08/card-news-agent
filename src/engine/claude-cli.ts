import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.ts';
import type {
  Answer, AskSpec, Candidate, DeepResearchDraft, EditorialDraft, HookDraft, PriorAnswer, ResearchRecord, ResearchResult, Source,
  StoryboardDraft,
} from '../types.ts';
import { CARD_FORMATS } from '../types.ts';
import { outletRule } from '../outlets.ts';
import { EngineError } from './types.ts';
import type { Engine, EngineContext, ReviseCardInput, RevisedCard, StoryboardInput } from './types.ts';

/**
 * Claude CLI engine: runs `claude -p` once per step with arguments passed as an array
 * (the topic never goes through a shell) and the prompt on stdin. Each call must end
 * in JSON matching a schema; the app validates it again before trusting it. A question
 * comes back as status "need_input": the call ends, the app waits for the web answer,
 * then sends it to the same session with `--resume <session id>`.
 */

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const MODEL = process.env.CARD_NEWS_CLAUDE_MODEL || 'sonnet';
const EFFORT = process.env.CARD_NEWS_CLAUDE_EFFORT || 'medium';
const TIMEOUT_MS = Number(process.env.CARD_NEWS_ENGINE_TIMEOUT_MS ?? 25 * 60_000);
/**
 * Diagnostic switch: withhold WebSearch so the search-failure path can be checked
 * end to end against the real CLI (README "설정").
 */
const WEB_TOOLS = process.env.CARD_NEWS_DISABLE_WEBSEARCH === '1' ? ['WebFetch'] : ['WebSearch', 'WebFetch'];
/** Questions one deep-research run may ask before it must produce a result. */
const MAX_QUESTIONS = 2;

// ---------- running the CLI ----------

interface CallOptions {
  prompt: string;
  schema: object;
  tools: string[];
  /** Resume this session, or start a new one with this ID. */
  resume?: string;
  newSessionId?: string;
}

interface CallResult {
  sessionId: string;
  output: unknown;
  /** WebSearch calls that came back with at least one result link. */
  webSearches: number;
  /** WebSearch calls attempted, and the error text of the ones that failed. */
  searchAttempts: number;
  searchErrors: string[];
}

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const str = { type: 'string' };

/**
 * Environment for the child CLI. When this server is itself started from inside a
 * Claude Code session (e.g. the desktop app), it inherits that session's variables,
 * which switch the child into a nested mode (CLAUDE_CODE_SIMPLE skips OAuth login,
 * ANTHROPIC_BASE_URL points at the host). Drop them so the child behaves like a
 * plain terminal run. CLAUDE_CONFIG_DIR and API key variables are kept.
 */
function childEnv(): NodeJS.ProcessEnv {
  const inherited = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_PREVIEW_|ANTHROPIC_BASE_URL$|USE_(LOCAL|STAGING)_OAUTH$)/;
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited.test(k)));
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

const AUTH_NEXT = '터미널에서 "claude auth login"을 실행해 로그인한 뒤 다시 시도하세요. 로그인 없이 화면 흐름만 보려면 서버를 끄고 "npm run start:mock"으로 다시 켜세요.';

function authFailure(text: string): boolean {
  return /authenticat|oauth|log ?in|401|invalid api key|credential/i.test(text);
}

function callClaude(ctx: EngineContext, opts: CallOptions): Promise<CallResult> {
  const cwd = path.join(DATA_DIR, 'projects', ctx.projectId);
  mkdirSync(cwd, { recursive: true });
  const toolList = opts.tools.join(',');
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(opts.schema),
    '--tools', toolList,
    '--allowedTools', toolList,
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    ...(opts.resume ? ['--resume', opts.resume] : ['--session-id', opts.newSessionId ?? randomUUID()]),
    '--model', MODEL,
    '--effort', EFFORT,
  ];

  return new Promise((resolve, reject) => {
    if (ctx.signal.aborted) return reject(ctx.signal.reason);
    const child = spawn(CLAUDE_BIN, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    let stderr = '';
    let final: Record<string, unknown> | null = null;
    let settled = false;
    // Search success is read from the WebSearch tool results in the stream: the final
    // result's usage.server_tool_use.web_search_requests stays 0 for the CLI's
    // WebSearch tool even when searches ran (checked 2026-10-23, Claude Code 2.1.306).
    const searchIds = new Set<string>();
    let webSearches = 0;
    const searchErrors: string[] = [];

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => { killTree(child.pid); finish(() => reject(ctx.signal.reason)); };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(() => reject(new EngineError('engine_failed',
        `Claude CLI가 ${Math.round(TIMEOUT_MS / 60_000)}분 안에 끝나지 않아 중단했습니다.`, '다시 시도하세요. 반복되면 후보 수를 줄여 보세요.')));
    }, TIMEOUT_MS);

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let ev: Record<string, any>;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content ?? []) {
          if (block.type !== 'tool_use') continue;
          if (block.name === 'WebSearch') {
            searchIds.add(block.id);
            ctx.progress(`웹 검색: ${String(block.input?.query ?? '').slice(0, 80)}`);
          }
          if (block.name === 'WebFetch') ctx.progress(`원문 확인: ${String(block.input?.url ?? '').slice(0, 100)}`);
        }
      }
      if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type !== 'tool_result' || !searchIds.has(block.tool_use_id)) continue;
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          const links = (ev.tool_use_result?.results ?? [])
            .flatMap((r: { content?: unknown }) => (Array.isArray(r?.content) ? r.content : []))
            .filter((x: { url?: unknown }) => typeof x?.url === 'string');
          if (block.is_error) searchErrors.push(text.slice(0, 200));
          else if (links.length) webSearches++;
          else searchErrors.push(`결과 없음: ${text.slice(0, 120)}`);
        }
      }
      if (ev.type === 'result') final = ev;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });

    child.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(err.code === 'ENOENT'
      ? new EngineError('engine_failed', 'Claude CLI(claude)를 찾을 수 없습니다.', 'Claude Code를 설치한 뒤 서버를 다시 시작하세요.')
      : new EngineError('engine_failed', `Claude CLI 실행 실패: ${err.message}`, '다시 시도하세요.'))));

    child.on('close', (code) => {
      handleLine(buffer);
      finish(() => {
        const r = final;
        if (!r) {
          const why = stderr.trim().split('\n').slice(-3).join(' ') || `종료 코드 ${code}`;
          return reject(authFailure(why)
            ? new EngineError('auth_required', `Claude 로그인이 필요합니다: ${why}`, AUTH_NEXT)
            : new EngineError('engine_failed', `Claude CLI가 결과 없이 끝났습니다: ${why}`, '다시 시도하세요.'));
        }
        const text = String(r.result ?? '');
        if (r.is_error) {
          return reject(authFailure(text)
            ? new EngineError('auth_required', `Claude 로그인이 필요합니다: ${text.slice(0, 200)}`, AUTH_NEXT)
            : new EngineError('engine_failed', `Claude CLI 오류: ${text.slice(0, 300)}`, '다시 시도하세요.'));
        }
        if (r.structured_output === undefined || r.structured_output === null) {
          return reject(new EngineError('engine_failed', 'Claude CLI 결과가 약속한 JSON 형식이 아니어서 완료로 처리하지 않았습니다.', '다시 시도하세요.'));
        }
        resolve({
          sessionId: String(r.session_id),
          output: r.structured_output,
          webSearches,
          searchAttempts: searchIds.size,
          searchErrors,
        });
      });
    });

    child.stdin.end(opts.prompt, 'utf8');
  });
}

// ---------- validating what came back ----------

class Shape extends Error {}
const fail = (what: string): never => { throw new Shape(what); };
const text = (v: unknown, what: string, max = 600): string =>
  (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fail(what));
const textOrNull = (v: unknown, max = 600): string | null =>
  (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const list = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : fail(what));
const date = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const httpUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v) ? v : null);

function badOutput(err: unknown): never {
  if (err instanceof Shape) {
    throw new EngineError('engine_failed', `Claude CLI 결과 형식 오류(${err.message}). 완료로 처리하지 않았습니다.`, '다시 시도하세요.');
  }
  throw err;
}

// ---------- research ----------

const SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'url', 'publisher', 'publishedAt', 'site'],
  properties: { title: str, url: str, publisher: str, publishedAt: nullable(str), site: nullable(str) },
};

const RESEARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['candidates', 'articles', 'note'],
  properties: {
    note: nullable(str),
    articles: { type: 'array', items: SOURCE_SCHEMA },
    candidates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'summary', 'category', 'publishedAt', 'eventDate', 'sources', 'value', 'uncertainty'],
        properties: {
          title: str, summary: str, category: str,
          publishedAt: nullable(str), eventDate: nullable(str),
          sources: { type: 'array', items: SOURCE_SCHEMA },
          value: str, uncertainty: str,
        },
      },
    },
  },
};

const kst = (d: Date) => d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' });
const ymd = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10); // KST date

function researchPrompt(topic: string, now: Date, start: string, end: string, days: number) {
  return `너는 카드뉴스 제작을 위한 자료 조사원이다. 사용자가 고를 후보 목록을 만든다.

주제: ${topic}
기준 시각: ${now.toISOString()} (한국 시간 ${kst(now)})
조사 기간: ${start} ~ ${end} (최근 ${days}일)

지킬 것:
1. 넓게 훑기(가장 먼저 한다): WebFetch로 https://news.google.com/rss/search?q=<주제>+when:${days}d&hl=ko&gl=KR&ceid=KR:ko 를 연다(주제는 URL 인코딩하고 여러 단어는 +로 잇는다). 주제가 이름·브랜드 같은 고유명사면 큰따옴표로 감싼 검색(q=%22<주제>%22+when:${days}d)도 연다. 이 목록은 본문에만 주제어가 나오는 기사도 잡아 준다. 그러니 제목에 주제어가 없어도 목록에 나온 기사는 주제 관련 기사로 보고 검토한다. 도박·스팸·주제와 무관한 사이트 항목은 버린다. 각 항목의 제목, 언론사(source), 언론사 주소(source의 url 속성), 게시 시각(pubDate)을 그대로 쓴다.
   그다음 WebSearch로 한국어·영어 검색어를 바꿔 가며 더 찾고, 필요하면 WebFetch로 원문을 열어 날짜와 내용을 확인한다. 기사 제목에 주제어가 없을 수 있으므로 주제어만으로 검색하지 말고, 주제와 관련된 현상·상품·업계 말(예: 브랜드라면 상품 종류나 유행어)로도 검색한 뒤 본문에 주제가 나오는지 확인한다.
2. 서로 다른 후보를 7~12개 고른다. 찾지 못하면 찾은 만큼만 내고, 없는 소식을 지어내지 않는다.
3. 같은 발표를 다룬 기사는 후보 하나로 묶고 sources에 함께 넣는다(후보마다 최대 8개). 공식 발표·문서·논문이 있으면 sources의 첫 번째에 둔다.
   articles에는 조사 기간 안에 찾은 주제 관련 기사를 후보로 고르지 않은 것까지 모두 넣는다(최대 80개, 같은 기사는 한 번만). 사용자가 이 목록을 보고 정보를 모은다.
   sources와 articles의 site에는 기사를 낸 언론사의 도메인(예: fnnews.com, sedaily.com)을 쓴다. url이 news.google.com이나 v.daum.net 같은 포털 주소일 때는 꼭 쓴다. 원문 주소를 확인했으면 url에 원문 주소를 쓴다.
   출처는 신뢰도가 가장 높은 곳에서 가져온다: ① 회사·기관의 공식 발표(공식 블로그·뉴스룸·보도자료·정부 사이트) ② 널리 알려진 주요 언론(로이터, AP, 블룸버그, CNBC, 더버지, 테크크런치, 연합뉴스, 주요 일간지·방송 등) ③ 전문 매체. 요약·추적(aggregator) 사이트, 순위표·모델 목록 사이트, 개인 블로그, SNS 게시물, AI가 쓴 것 같은 사이트는 출처로 쓰지 않는다. 각 후보는 ①이나 ②를 넣도록 최대한 찾는다. 끝내 찾지 못해도 주제에 맞는 소식이면 후보로 내되, uncertainty에 "공식 발표나 주요 언론 보도를 찾지 못했다"고 밝힌다(앱은 이런 후보에 "출처 확인 필요"를 표시한다).
4. 주제에 맞게 모델·제품·연구·개발 도구·정책 등으로 다양하게 고르고, category에 한국어로 분류를 적는다.
5. 날짜는 원문이나 검색 결과에서 확인한 것만 YYYY-MM-DD로 쓰고, 확인하지 못하면 null로 둔다. publishedAt은 기사 게시일, eventDate는 실제 발표·출시·변경일이다.
6. 조사 기간보다 전에 일어난 일을 최근 기사가 다시 다룬 경우에는 후보에서 뺀다.
7. summary에서 "공개 예정"과 "출시됨"을 구분하고, 업체의 성능 주장은 주장이라고 밝힌다. 기사 제목만 보고 사실로 단정하지 않는다.
8. value에는 사용자가 이 후보를 고를지 판단할 수 있게 "선택할 가치"를 2~3문장(화면에서 2~3줄, 120~220자)으로 쉽고 정확하게 쓴다. 해요체로 쓰고, 다음을 차례로 담는다: ① 무슨 일인지 핵심 사실 한 가지(누가·무엇을·숫자나 날짜가 있으면 그대로, 출처에서 확인한 것만) ② 독자에게 왜 중요하거나 흥미로운지 ③ 카드뉴스로 만들면 어떤 이야기·구성이 되는지. "~할 수 있습니다" 같은 막연한 말만 쓰지 말고, 확인하지 못한 것을 사실처럼 쓰지 않는다. uncertainty에는 확인하지 못한 점이나 조건을 한 문장으로 적는다.
9. 모든 텍스트는 한국어로 쓴다(고유명사 제외). url은 실제로 확인한 http(s) 주소만 쓴다.
   출처도 한국어가 기본이다(사용자가 출처를 쉽게 확인하도록): 한국 언론사 기사는 한국어판 주소를 쓰고, 영문판(news.sbs.co.kr/english, khan.co.kr/en, koreajoongangdaily, koreaherald 영문 기사 등)은 같은 기사의 한국어판을 찾지 못했을 때만 쓴다. 같은 소식에 한국어 기사와 외국어 기사가 함께 있으면 한국어 기사를 외국어 기사보다 앞에 둔다(공식 발표는 맨 앞 그대로). sources의 title은 한국어로 쓰고, 원문이 외국어면 뜻을 한국어로 옮긴 뒤 끝에 " (영문)"처럼 원문 언어를 붙인다. publisher도 한국어 이름으로 쓴다(예: 로이터, 블룸버그, 오픈AI).
10. 검색 도구를 쓸 수 없었거나 결과가 없으면 candidates를 비우고 note에 이유를 쓴다. 그 밖에 알릴 점이 없으면 note는 null로 둔다.
${outletRule(11, days)}

결과는 지정된 JSON 스키마로만 출력한다.`;
}

/** A news site's domain from "fnnews.com", "https://www.fnnews.com/…" or similar. */
function siteOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  try {
    const h = new URL(/^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`).hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : null;
  } catch { return null; }
}

function parseSource(s: unknown): Source[] {
  const src = s as Record<string, unknown>;
  const url = httpUrl(src.url);
  return url ? [{ title: textOrNull(src.title, 200) ?? url, url, publisher: textOrNull(src.publisher, 100) ?? '출처 미상', publishedAt: date(src.publishedAt), site: siteOf(src.site) }] : [];
}

function parseCandidates(output: unknown, periodStart: string): { candidates: Candidate[]; articles: Source[]; note: string | null; dropped: number } {
  try {
    const o = output as Record<string, unknown>;
    let dropped = 0;
    const candidates: Candidate[] = [];
    // Articles outside the period are left out, as candidates are.
    const seen = new Set<string>();
    const articles = (Array.isArray(o.articles) ? o.articles : []).flatMap(parseSource)
      .filter((a) => !(a.publishedAt && a.publishedAt < periodStart) && !seen.has(a.url) && seen.add(a.url))
      .slice(0, 80);
    for (const raw of list(o.candidates, 'candidates')) {
      const c = raw as Record<string, unknown>;
      const sources: Source[] = list(c.sources, 'sources').flatMap(parseSource);
      if (!sources.length) { dropped++; continue; }
      const publishedAt = date(c.publishedAt);
      const eventDate = date(c.eventDate);
      // A confirmed date before the period means old news re-reported; keep it out.
      const latest = [publishedAt, eventDate].filter(Boolean).sort().pop();
      if (latest && latest < periodStart) { dropped++; continue; }
      candidates.push({
        id: `c${candidates.length + 1}`,
        title: text(c.title, 'title', 200),
        summary: text(c.summary, 'summary'),
        category: textOrNull(c.category, 30) ?? '기타',
        publishedAt,
        eventDate,
        sources,
        value: text(c.value, 'value', 500),
        uncertainty: textOrNull(c.uncertainty, 300) ?? '불확실성 미기재',
      });
    }
    return { candidates: candidates.slice(0, 12), articles, note: textOrNull(o.note), dropped };
  } catch (err) {
    return badOutput(err);
  }
}

// ---------- deep research ----------

const QUESTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['key', 'question', 'options', 'recommended', 'recommendationReason'],
  properties: {
    key: str, question: str,
    options: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['label', 'description'], properties: { label: str, description: str } },
    },
    recommended: str, recommendationReason: str,
  },
};

const DEEP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'question', 'result'],
  properties: {
    status: { type: 'string', enum: ['need_input', 'result'] },
    question: nullable(QUESTION_SCHEMA),
    result: nullable({
      type: 'object', additionalProperties: false,
      required: ['records', 'editorial'],
      properties: {
        records: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['candidateId', 'facts', 'claims', 'limits', 'conflicts'],
            properties: {
              candidateId: str,
              facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'sourceUrl'], properties: { text: str, sourceUrl: str } } },
              claims: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'by', 'sourceUrl'], properties: { text: str, by: str, sourceUrl: str } } },
              limits: { type: 'array', items: str },
              conflicts: { type: 'array', items: str },
            },
          },
        },
        editorial: {
          type: 'object', additionalProperties: false,
          required: ['audience', 'whyUseful', 'formats', 'recommendedFormat', 'formatReason', 'structure', 'hooks', 'reasoning'],
          properties: {
            audience: str,
            whyUseful: str,
            formats: {
              type: 'object', additionalProperties: false, required: ['list', 'story'],
              properties: Object.fromEntries(CARD_FORMATS.map((f) => [f, {
                type: 'object', additionalProperties: false, required: ['fit', 'drawback'], properties: { fit: str, drawback: str },
              }])),
            },
            recommendedFormat: { type: 'string', enum: [...CARD_FORMATS] },
            formatReason: str,
            structure: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, required: ['role', 'summary'], properties: { role: str, summary: str } },
            },
            hooks: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false, required: ['text', 'factRefs'],
                properties: {
                  text: str,
                  factRefs: {
                    type: 'array',
                    items: { type: 'object', additionalProperties: false, required: ['candidateId', 'factIndex'], properties: { candidateId: str, factIndex: { type: 'integer' } } },
                  },
                },
              },
            },
            reasoning: str,
          },
        },
      },
    }),
  },
};

const answerText = (a: Answer) =>
  (a.choice && a.text ? `${a.choice} (추가 의견: ${a.text})` : a.text ?? a.choice ?? '');

function priorAnswersText(prior: Record<string, PriorAnswer>): string {
  const entries = Object.entries(prior);
  if (!entries.length) return '없음';
  return entries.map(([key, p]) => `- [${key}] ${p.question} → ${answerText(p.answer)}`).join('\n');
}

function deepPrompt(topic: string, candidates: Candidate[], searchedAt: string, prior: Record<string, PriorAnswer>) {
  const picked = candidates.map((c) => ({
    candidateId: c.id, title: c.title, summary: c.summary, publishedAt: c.publishedAt, eventDate: c.eventDate,
    sources: c.sources.map((s) => s.url), uncertainty: c.uncertainty,
  }));
  return `사용자가 "${topic}" 카드뉴스에 쓸 후보를 골랐다. 이 후보만 심층 조사하고 편집 방향을 제안한다.
조사 기준일: ${ymd(new Date(searchedAt))} (publishedAt은 원문 게시일, null이면 확인하지 못한 것)

선택한 후보:
${JSON.stringify(picked, null, 2)}

조사:
1. 각 후보의 sources 원문을 WebFetch로 직접 연다. 가능하면 WebSearch로 발표 기관의 공식 발표·제품 문서·변경 기록·논문을 찾아 우선 사용한다. facts의 sourceUrl은 공식 발표나 널리 알려진 주요 언론(없으면 전문 매체)만 쓴다. 요약·추적 사이트·블로그에만 있는 내용은 facts가 아니라 limits에 "확인 필요"로 적는다(앱도 그런 facts를 limits로 옮긴다).
   news.google.com 주소는 원문으로 넘어가는 링크다. 언론사 사이트가 열리면 WebSearch(allowed_domains에 그 언론사 도메인)로 같은 제목 기사를 찾아 원문을 연다. 중앙·조선·동아·매경·한겨레처럼 열리지 않는 곳은 본문을 열 수 없다. 그 기사를 sourceUrl로 쓰는 facts는 기사 제목에 드러난 내용과 날짜까지만 쓴다. 숫자·조건 같은 세부 내용은 WebSearch(allowed_domains ["v.daum.net"])로 같은 제목 기사를 찾아 열어 확인하거나 다른 출처로 확인하고, 확인하지 못하면 limits에 적는다.
2. 후보마다 records를 만든다. candidateId는 위 값을 그대로 쓴다.
   - facts: 원문에서 직접 확인한 사실만. sourceUrl에는 확인한 원문 주소를 쓴다.
   - claims: 발표 주체의 주장(성능·효과 등). by에 주장한 주체를 쓴다. 독립적으로 검증된 사실로 바꾸지 않는다.
   - limits: 누가·언제부터·어떤 조건(지역·계정·요금제)으로 쓸 수 있는지 중 확인하지 못한 점, 공개 예정인지 여부 등.
   - conflicts: 자료끼리 날짜나 조건이 맞지 않는 점. 없으면 빈 배열.
   기사 제목만으로 사실을 확정하지 않고, 원문을 열지 못한 내용은 limits에 그렇게 적는다.

편집 판단:
3. 조사 결과로 독자(audience)와 독자에게 유용한 이유(whyUseful)를 정한다.
4. 카드 형식은 두 가설을 비교해 하나를 추천한다.
   - list(목록형): 이번 주 AI 소식을 빠르게 훑고 싶은 독자에게 맞다. 발표 하나를 한 장에 짧게 담는다.
   - story(이야기형): AI를 처음 접해 변화의 의미가 궁금한 독자에게 맞다. 상황 → 불편 → 변화 → 활용 → 한계 순서로 이해시킨다.
   formats.list와 formats.story에 이번 소식과 독자 기준으로 맞는 점(fit)과 아쉬운 점(drawback)을 각각 쓰고, recommendedFormat에 하나를 고르고, formatReason에 비교 근거를 쓴다.
   structure에는 추천 형식의 카드 순서를 role과 summary로 쓴다. story라면 role에 상황, 불편, 변화, 활용, 한계를 이 순서대로 쓴다(앞에 표지, 뒤에 요약·출처 카드를 더할 수 있다). list라면 발표 하나당 카드 한 장이다.
5. 표지 후킹 문구(hooks)를 2~3개 쓴다.
   - factRefs에 근거가 된 facts의 candidateId와 factIndex(그 후보 facts 배열의 0부터 시작하는 순번)를 적는다. 근거 없는 문구는 쓰지 않는다.
   - facts에서 확인하지 않은 기능·효과·수치는 넣지 않는다. claims(발표 주체의 주장)는 사실처럼 쓰지 않는다.
   - '최신'이라는 말은 근거 후보의 publishedAt(원문 게시일)이 확인된 경우에만 쓴다. null인 후보에 기대는 문구에는 쓰지 않는다.
6. 대상 독자나 편집 방향에 따라 결과가 크게 달라지는데 지금까지의 입력으로 판단할 수 없을 때만 status를 "need_input"으로 하고 question 하나를 낸다.
   - 사용자가 독자를 아직 정하지 않았고(아래 답변에 독자가 없음) 선택한 소식들이 서로 다른 독자(예: 일반 사용자, 개발자, 교육자)에게 맞는다면, 여러 독자를 한데 묶어 정하지 말고 독자를 묻는다. 독자에 따라 추천 형식(목록형/이야기형)과 후킹이 달라지기 때문이다.
   - 선택한 소식이 모두 같은 독자에게 맞아 판단이 분명하면 묻지 않는다.
   - key는 영문 소문자 식별자(예: audience, direction), options는 2~4개, 각 description에 선택했을 때 무엇이 달라지는지 한 줄로 쓴다.
   - recommended에 추천 선택지의 label을, recommendationReason에 근거를 쓴다. 이때 result는 null로 둔다.
   - 판단할 수 있으면 질문하지 말고 status "result"로 바로 결과를 내고, question은 null로 둔다.
7. 이미 받은 사용자 답변(다시 묻지 않는다):
${priorAnswersText(prior)}

모든 텍스트는 한국어로 쓰고, 결과는 지정된 JSON 스키마로만 출력한다.`;
}

function answerPrompt(spec: AskSpec, answer: Answer) {
  return `질문 [${spec.key}] "${spec.question}"에 대한 사용자 답변: ${answerText(answer)}
이 답을 반영해 같은 JSON 스키마로 다시 출력한다. 추가 질문은 결과가 크게 달라질 때만 하고, 같은 질문은 다시 하지 않는다.`;
}

function parseQuestion(q: unknown, prior: Record<string, PriorAnswer>): AskSpec {
  try {
    const o = q as Record<string, unknown>;
    const options = list(o.options, 'options').map((x) => {
      const opt = x as Record<string, unknown>;
      return { label: text(opt.label, 'option.label', 60), description: text(opt.description, 'option.description', 200) };
    }).slice(0, 4);
    if (options.length < 2) fail('options 2개 미만');
    const recommended = textOrNull(o.recommended, 60);
    const key = (textOrNull(o.key, 40) ?? 'question').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    return {
      key: prior[key] ? `${key}_${Object.keys(prior).length + 1}` : key,
      question: text(o.question, 'question', 200),
      options,
      recommended: options.some((x) => x.label === recommended) ? recommended : null,
      recommendationReason: textOrNull(o.recommendationReason, 300),
      allowFreeText: true,
    };
  } catch (err) {
    return badOutput(err);
  }
}

function parseDeepResult(r: unknown, candidates: Candidate[]): DeepResearchDraft {
  try {
    const o = r as Record<string, unknown>;
    const ids = new Set(candidates.map((c) => c.id));
    // Facts without a usable source URL are dropped, so hook factRefs (which use the
    // engine's original positions) are remapped; a ref to a dropped fact disappears.
    const factIndexMap = new Map<string, Map<number, number>>();
    const records: ResearchRecord[] = list(o.records, 'records').flatMap((x) => {
      const rec = x as Record<string, unknown>;
      const candidateId = String(rec.candidateId);
      if (!ids.has(candidateId)) return [];
      const indexMap = new Map<number, number>();
      factIndexMap.set(candidateId, indexMap);
      const facts: ResearchRecord['facts'] = [];
      list(rec.facts, 'facts').forEach((f, i) => {
        const ff = f as Record<string, unknown>;
        const url = httpUrl(ff.sourceUrl);
        if (!url) return;
        indexMap.set(i, facts.length);
        facts.push({ text: text(ff.text, 'fact.text'), sourceUrl: url });
      });
      return [{
        candidateId,
        facts,
        claims: list(rec.claims, 'claims').flatMap((c) => {
          const cc = c as Record<string, unknown>;
          const url = httpUrl(cc.sourceUrl);
          return url ? [{ text: text(cc.text, 'claim.text'), by: textOrNull(cc.by, 100) ?? '발표 주체', sourceUrl: url }] : [];
        }),
        limits: list(rec.limits, 'limits').flatMap((t) => textOrNull(t) ?? []),
        conflicts: list(rec.conflicts, 'conflicts').flatMap((t) => textOrNull(t) ?? []),
      }];
    });
    if (!records.length) fail('선택한 후보의 조사 기록이 없음');
    const e = (o.editorial ?? fail('editorial')) as Record<string, unknown>;
    const fm = (e.formats ?? fail('formats')) as Record<string, Record<string, unknown>>;
    const formats = Object.fromEntries(CARD_FORMATS.map((f) => [f, {
      fit: text(fm[f]?.fit, `formats.${f}.fit`, 300),
      drawback: text(fm[f]?.drawback, `formats.${f}.drawback`, 300),
    }])) as EditorialDraft['formats'];
    const recommendedFormat = CARD_FORMATS.find((f) => f === e.recommendedFormat) ?? fail('recommendedFormat');
    const hooks: HookDraft[] = list(e.hooks, 'hooks').slice(0, 3).map((h) => {
      const hh = h as Record<string, unknown>;
      return {
        text: text(hh.text, 'hook.text', 120),
        factRefs: list(hh.factRefs, 'hook.factRefs').flatMap((ref) => {
          const rr = ref as Record<string, unknown>;
          const mapped = factIndexMap.get(String(rr.candidateId))?.get(Number(rr.factIndex));
          return mapped === undefined ? [] : [{ candidateId: String(rr.candidateId), factIndex: mapped }];
        }),
      };
    });
    if (!hooks.length) fail('후킹 문구 없음');
    const editorial: EditorialDraft = {
      audience: text(e.audience, 'audience', 100),
      whyUseful: text(e.whyUseful, 'whyUseful'),
      formats,
      recommendedFormat,
      formatReason: text(e.formatReason, 'formatReason'),
      structure: list(e.structure, 'structure').slice(0, 12).map((s) => {
        const ss = s as Record<string, unknown>;
        return { role: text(ss.role, 'structure.role', 30), summary: text(ss.summary, 'structure.summary', 200) };
      }),
      hooks,
      reasoning: text(e.reasoning, 'reasoning'),
    };
    if (!editorial.structure.length) fail('structure 없음');
    return { mock: false, records, editorial };
  } catch (err) {
    return badOutput(err);
  }
}

// ---------- storyboard ----------

const STORYBOARD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['styleGuide', 'cards'],
  properties: {
    styleGuide: str,
    cards: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['role', 'headline', 'body', 'imageRole', 'imagePrompt', 'factRefs'],
        properties: {
          role: str, headline: str, body: str, imageRole: str, imagePrompt: str,
          factRefs: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['candidateId', 'factIndex'], properties: { candidateId: str, factIndex: { type: 'integer' } } },
          },
        },
      },
    },
  },
};

function storyboardPrompt({ topic, deep, research, previous, instruction }: StoryboardInput) {
  const e = deep.editorial;
  const facts = deep.records.map((r) => ({
    candidateId: r.candidateId,
    title: research.candidates.find((c) => c.id === r.candidateId)?.title,
    publishedAt: research.candidates.find((c) => c.id === r.candidateId)?.publishedAt ?? null,
    facts: r.facts.map((f, i) => ({ factIndex: i, text: f.text })),
    claims: r.claims.map((c) => `${c.text} — ${c.by}`),
    limits: r.limits,
  }));
  const format = e.recommendedFormat === 'story' ? '이야기형' : '목록형';
  const revise = previous && instruction
    ? `\n변경 요청: 아래 이전 스토리보드를 사용자의 요청대로 고친다. 요청과 관계없는 장은 그대로 둔다.\n사용자 요청: ${instruction}\n이전 스토리보드:\n${JSON.stringify({ styleGuide: previous.styleGuide, cards: previous.cards.map(({ role, headline, body, imageRole, imagePrompt }) => ({ role, headline, body, imageRole, imagePrompt })) }, null, 2)}\n`
    : '';
  return `"${topic}" 카드뉴스의 스토리보드를 만든다. 조사 기록과 편집 방향만 근거로 쓴다.

독자: ${e.audience}
형식: ${format} (${e.formatReason})
카드 구성 제안: ${e.structure.map((s) => s.role).join(' → ')}
후킹 후보: ${e.hooks.map((h) => h.text).join(' / ')}
조사 기준일: ${ymd(new Date(research.searchedAt))}

조사 기록(facts만 사실로 쓴다. claims는 발표 주체의 주장, limits는 확인하지 못한 점이다):
${JSON.stringify(facts, null, 2)}
${revise}
규칙:
1. 5~8장으로 만든다. 첫 장 role은 "표지", 마지막 장 role은 "요약·출처" 또는 "다음 행동"이다.
2. ${format === '이야기형'
    ? '이야기형: 표지 다음에 role을 "상황", "불편", "변화", "활용", "한계" 순서로 둔다.'
    : '목록형: 표지 다음에 소식 하나당 한 장을 두고, 각 장 role은 "소식"으로 한다.'}
3. 한 장에는 메시지 하나만 담는다. headline(핵심 문장)은 40자 이내 한 문장, body(본문)는 2~3문장 140자 이내.
4. headline과 body는 facts 범위에서만 쓴다. 장마다 factRefs에 근거가 된 facts의 candidateId와 factIndex를 적는다. 표지도 후킹 근거가 된 facts를 적는다.
5. claims는 사실처럼 쓰지 않고 "~라고 밝혔어요"처럼 주체를 밝힌다. 확인되지 않은 기능·효과·순위·과장은 쓰지 않는다. 숫자는 facts에 있는 표기 그대로 쓴다.
6. '최신'이라는 말은 원문 게시일(publishedAt)이 확인된 소식에만 쓴다. 공개 예정·프리뷰·베타를 "출시"로 바꾸지 않는다. 확인하지 못한 조건은 한계(또는 요약) 장에 쓴다.
7. imageRole: 이 장에서 그림이 하는 역할을 한 줄로 쓴다(예: 상황을 떠올리게 하는 장면).
8. imagePrompt: 무엇을 그릴지(주인공, 상황, 분위기)를 한국어 2~3문장으로 쓴다. 크기·위치·여백·색은 앱이 카드 디자인에 맞춰 따로 정하므로 쓰지 않는다. 실제 제품 화면·로고·실존 인물·글자·숫자는 그리지 않는다. 안개·흐릿함·번짐처럼 흐린 표현은 쓰지 않고, 모든 요소를 또렷하게 그리는 장면으로 쓴다(불확실함은 물음표 같은 상징으로).
9. styleGuide: 모든 장에 공통으로 쓸 그림체, 색감(hex 색 3~4개, 밝은 바탕색·어두운 색·강조색을 포함), 조명을 2~3문장으로 쓴다. 구도·여백·위치는 앱이 카드 디자인에 맞춰 정하므로 쓰지 않는다. 장마다 그림체와 색감이 같아야 한다.
10. 말투: headline과 body는 일반 독자에게 말하듯 친근한 해요체로 쓴다(예: "늘었어요", "확인해 보세요", "아직 확인되지 않았어요"). "~다"로 끝나는 기사체·보고서체는 쓰지 않는다. headline은 짧고 눈에 띄게 쓰고, 강조할 핵심어(숫자+단위 등) 하나를 **두 별표**로 감싼다. 말투를 바꿔도 facts의 내용·숫자·날짜는 바꾸지 않는다. styleGuide와 imagePrompt는 지시문이라 말투 규칙을 따르지 않아도 된다.
11. 표지(1장) headline은 피드에서 보이는 썸네일 제목이다. 짧은 구절 2~3줄로 끊어 쓰고(줄마다 12자 안팎, 줄바꿈은 \n), 읽는 사람이 궁금해지거나 마음이 움직이게 쓴다. 단 facts 범위를 벗어나는 과장·낚시·단정은 쓰지 않는다. 다른 장의 headline도 길면 \n으로 읽는 호흡에 맞게 끊어도 된다.

모든 텍스트는 한국어로 쓰고, 결과는 지정된 JSON 스키마로만 출력한다.`;
}

function parseStoryboard(output: unknown): StoryboardDraft {
  try {
    const o = output as Record<string, unknown>;
    return {
      styleGuide: text(o.styleGuide, 'styleGuide'),
      cards: list(o.cards, 'cards').slice(0, 10).map((x) => {
        const c = x as Record<string, unknown>;
        return {
          role: text(c.role, 'card.role', 20),
          headline: text(c.headline, 'card.headline', 80),
          body: text(c.body, 'card.body', 300),
          imageRole: text(c.imageRole, 'card.imageRole', 120),
          imagePrompt: text(c.imagePrompt, 'card.imagePrompt', 400),
          factRefs: list(c.factRefs, 'card.factRefs').map((r) => {
            const rr = r as Record<string, unknown>;
            return { candidateId: String(rr.candidateId), factIndex: Number(rr.factIndex) };
          }),
        };
      }),
    };
  } catch (err) {
    return badOutput(err);
  }
}

// ---------- SVG illustration (fallback when agy is unavailable) ----------

const SVG_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['svg'], properties: { svg: str },
};

/**
 * Asks Claude CLI to draw one card illustration as SVG code. Claude CLI has no raster
 * image tool, so this is a vector drawing; the image worker validates it.
 */
export async function drawSvg(ctx: EngineContext, styleGuide: string, imagePrompt: string, direction: string): Promise<string> {
  const res = await callClaude(ctx, {
    prompt: `카드뉴스 배경용 설명 일러스트 하나를 SVG 코드로 그린다.

규칙:
- 루트는 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1350" width="1080" height="1350">이다.
- 글자, 숫자, 로고를 넣지 않는다. <text>, <tspan>, <script>, <foreignObject>, 외부 이미지·링크(href의 http 주소)를 쓰지 않는다.
- 흐림 필터(feGaussianBlur 등)로 안개·번짐을 만들지 않는다. 모든 도형은 또렷한 플랫 일러스트로 그린다. 그림자가 필요하면 약한 반투명 도형으로만 표현한다.
- 단순한 도형, 패스, 그라데이션으로 그리고 코드는 60KB 이하로 한다.

공통 그림체와 색감(모든 카드가 같아야 함): ${styleGuide}
이 카드의 장면: ${imagePrompt}

${direction}
위 그림 규칙(크기·색·여백·위치)은 공통 그림체 설명이나 장면 설명과 다르면 이 그림 규칙을 따른다.

결과는 지정된 JSON 스키마의 svg 필드에 SVG 코드 전체를 넣어 출력한다.`,
    schema: SVG_SCHEMA,
    tools: [],
    newSessionId: randomUUID(),
  });
  return text((res.output as { svg?: unknown }).svg, 'svg', 300_000);
}

// ---------- engine ----------

export const claudeCliEngine: Engine = {
  name: 'claude-cli',
  mock: false,

  async research(ctx, { topic, periodDays, now }): Promise<ResearchResult> {
    const periodEnd = ymd(now);
    const periodStart = ymd(new Date(now.getTime() - periodDays * 86_400_000));
    // A new research starts a fresh session; its ID is saved before the call so a
    // restart can still find it.
    const sessionId = randomUUID();
    ctx.setSessionId(sessionId);
    ctx.progress(`Claude CLI로 최근 ${periodDays}일 자료 조사 시작`);

    const res = await callClaude(ctx, {
      prompt: researchPrompt(topic, now, periodStart, periodEnd, periodDays),
      schema: RESEARCH_SCHEMA,
      tools: WEB_TOOLS,
      newSessionId: sessionId,
    });
    if (res.webSearches === 0) {
      const why = res.searchAttempts === 0
        ? '웹 검색이 한 번도 실행되지 않았습니다. 이 계정이나 환경에서 검색 도구를 쓸 수 없을 수 있습니다.'
        : `웹 검색 ${res.searchAttempts}회가 모두 결과 없이 끝났습니다${res.searchErrors[0] ? ` (${res.searchErrors[0]})` : ''}.`;
      throw new EngineError('search_failed', why,
        '"다시 시도"를 누르세요. 반복되면 터미널에서 claude를 실행해 웹 검색이 되는지 확인하세요.');
    }
    const { candidates, articles, note, dropped } = parseCandidates(res.output, periodStart);
    ctx.progress(`후보 ${candidates.length}개, 찾은 기사 ${articles.length}건 정리 완료 (결과를 받은 웹 검색 ${res.webSearches}회 / 시도 ${res.searchAttempts}회)`);
    const notes = [note, dropped ? `기간 밖이거나 확인 가능한 원문 주소가 없는 후보 ${dropped}개를 제외했습니다.` : null].filter(Boolean);
    return {
      searchedAt: now.toISOString(),
      periodDays, periodStart, periodEnd,
      mock: false,
      engine: 'claude-cli',
      note: notes.length ? notes.join(' ') : null,
      candidates,
      articles,
    };
  },

  async deepResearch(ctx, { topic, candidates, searchedAt }): Promise<DeepResearchDraft> {
    // Continue the project's research session when there is one, so the engine keeps
    // the search context; otherwise start a new session.
    let sessionId = ctx.sessionId;
    const prior = { ...ctx.priorAnswers };
    ctx.progress(`선택한 ${candidates.length}개 후보의 원문 확인 시작`);

    let res = await callClaude(ctx, {
      prompt: deepPrompt(topic, candidates, searchedAt, prior),
      schema: DEEP_SCHEMA,
      tools: WEB_TOOLS,
      ...(sessionId ? { resume: sessionId } : { newSessionId: randomUUID() }),
    });
    if (res.sessionId !== sessionId) { sessionId = res.sessionId; ctx.setSessionId(sessionId); }

    for (let asked = 0; ; asked++) {
      const out = res.output as { status?: string; question?: unknown; result?: unknown };
      if (out.status === 'result' && out.result) return parseDeepResult(out.result, candidates);
      if (out.status !== 'need_input' || !out.question || asked >= MAX_QUESTIONS) {
        if (asked >= MAX_QUESTIONS) {
          res = await callClaude(ctx, {
            prompt: '질문은 여기까지 받는다. 지금까지의 답변으로 판단해 status "result"로 결과를 출력한다.',
            schema: DEEP_SCHEMA, tools: WEB_TOOLS, resume: sessionId!,
          });
          const last = res.output as { status?: string; result?: unknown };
          if (last.status === 'result' && last.result) return parseDeepResult(last.result, candidates);
        }
        throw new EngineError('engine_failed', 'Claude CLI가 결과도 질문도 아닌 응답을 보내 완료로 처리하지 않았습니다.', '다시 시도하세요.');
      }

      const spec = parseQuestion(out.question, prior);
      ctx.progress('편집 방향에 따라 결과가 크게 달라져 사용자에게 질문');
      const answer = await ctx.askUser(spec);
      prior[spec.key] = { question: spec.question, answer };
      ctx.progress('답변을 같은 세션에 전달해 이어서 진행');
      res = await callClaude(ctx, {
        prompt: answerPrompt(spec, answer),
        schema: DEEP_SCHEMA, tools: WEB_TOOLS, resume: sessionId!,
      });
    }
  },

  async storyboard(ctx, input): Promise<StoryboardDraft> {
    // Continue the project's session so the engine keeps its research context.
    ctx.progress(input.instruction ? '변경 요청을 반영해 스토리보드를 다시 만드는 중' : '조사 기록으로 스토리보드를 만드는 중');
    const res = await callClaude(ctx, {
      prompt: storyboardPrompt(input),
      schema: STORYBOARD_SCHEMA,
      tools: [],
      ...(ctx.sessionId ? { resume: ctx.sessionId } : { newSessionId: randomUUID() }),
    });
    if (res.sessionId !== ctx.sessionId) ctx.setSessionId(res.sessionId);
    const draft = parseStoryboard(res.output);
    ctx.progress(`카드 ${draft.cards.length}장 기획 완료`);
    return draft;
  },

  async reviseCard(ctx, input): Promise<RevisedCard> {
    // A card edit needs only this card and its facts, so it runs in its own session.
    ctx.progress('요청대로 카드 문장을 고치는 중');
    const res = await callClaude(ctx, {
      prompt: revisePrompt(input),
      schema: REVISE_SCHEMA,
      tools: [],
      newSessionId: randomUUID(),
    });
    const o = res.output as Record<string, unknown>;
    try {
      return { headline: text(o.headline, 'headline', 80), body: text(o.body, 'body', 300), note: text(o.note, 'note', 300) };
    } catch {
      throw new EngineError('engine_failed', '고친 문장을 받지 못했습니다(응답 형식이 맞지 않음).', '다시 요청해 보세요.');
    }
  },
};

const REVISE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'body', 'note'],
  properties: { headline: str, body: str, note: str },
};

function revisePrompt(i: ReviseCardInput) {
  return `"${i.topic}" 카드뉴스의 카드 한 장(${i.role})을 사용자의 요청대로 고친다. 이 카드만 고치고, 그림은 바꾸지 않는다.

독자: ${i.audience}
지금 제목(headline): ${i.headline}
지금 본문(body): ${i.body}
이 카드가 쓸 수 있는 확인된 사실(facts):
${JSON.stringify(i.facts, null, 2)}

사용자 요청: ${i.instruction}

규칙:
1. 요청한 것만 바꾼다. 요청이 본문만 말하면 제목은 그대로 둔다.
2. 사실은 facts 범위 안에서만 쓴다. 지금 문장에 있는 조건·제한(예: 어떤 요금제에만 해당, 예정·미출시, 미확인)은 요청이 빼라고 하지 않는 한 빠뜨리지 않는다. 숫자·날짜·이름은 facts 표기 그대로 쓴다.
3. 발표 주체의 주장은 "~라고 밝혔어요"처럼 주체를 밝힌다. 확인되지 않은 효과·과장은 쓰지 않는다.
4. 말투는 일반 독자에게 말하듯 친근한 해요체로 쓴다. 제목은 40자 이내, 본문은 140자 이내다. 강조 표시를 쓸 수 있다: 제목은 **동그라미**와 __물결 밑줄__, 본문은 ==형광펜==과 __밑줄__(한 카드에 2~3곳까지). 요청이 키워드·이모지·짧은 줄을 원하면 본문을 \n으로 나눈 3~6줄로 쓰고, 줄마다 앞에 어울리는 이모지 하나와 15자 안팎의 핵심 구절을 둔다. 읽는 호흡에 맞게 \n으로 줄을 끊어도 된다. 표지 카드라면 제목은 썸네일이므로 짧은 구절 2~3줄로, 궁금해지게 쓰되 facts를 벗어나지 않는다. 지금 제목에 **두 별표** 강조가 있으면 유지하고, 없으면 핵심어 하나를 **두 별표**로 감싼다.
5. note에는 무엇을 바꿨는지 한 문장으로 쓴다.

결과는 지정된 JSON 스키마로만 출력한다.`;
}
