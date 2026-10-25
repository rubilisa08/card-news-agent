import type { Candidate, DeepResearchDraft, ResearchRecord, ResearchResult, StoryboardDraft } from '../types.ts';
import { EngineError } from './types.ts';
import type { Engine, EngineContext, RevisedCard } from './types.ts';

/**
 * Mock engine for building the web flow before the real engine is connected.
 * Everything it returns is flagged `mock: true` and titled "[모의]" so the screen
 * never presents it as real search results.
 *
 * CARD_NEWS_MOCK_SCENARIO: normal (default) | few (3 results for 7 days) | search_fail
 * CARD_NEWS_MOCK_FAIL_DEEP: comma-separated call numbers (counted per server process)
 *   at which deep research fails with a test error, e.g. "2" fails the second call.
 */
const scenario = process.env.CARD_NEWS_MOCK_SCENARIO ?? 'normal';
const failDeepCalls = new Set((process.env.CARD_NEWS_MOCK_FAIL_DEEP ?? '').split(',').map(Number).filter(Boolean));
let deepCalls = 0;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

const day = (base: Date, offset: number) =>
  new Date(base.getTime() - offset * 86_400_000).toISOString().slice(0, 10);

function mockCandidates(now: Date): Candidate[] {
  const src = (n: number, publisher: string, offset: number | null) => ({
    title: `[모의] 출처 기사 ${n}`,
    url: `https://example.com/mock/source-${n}`,
    publisher,
    publishedAt: offset === null ? null : day(now, offset),
  });
  return [
    { id: 'c1', title: '[모의] 대형 언어 모델 신규 버전 발표', category: '모델',
      summary: '모의 데이터: 한 연구소가 추론 성능을 높인 새 모델을 발표했다는 가상의 소식.',
      publishedAt: day(now, 1), eventDate: day(now, 2),
      sources: [src(1, '공식 블로그(모의)', 1), src(2, '기술 매체(모의)', 1)],
      value: '같은 발표를 다룬 기사 2건을 묶은 예. 많은 사용자에게 영향이 큼.',
      uncertainty: '성능 수치는 발표 주체의 주장이며 독립 검증 전.' },
    { id: 'c2', title: '[모의] 오피스 도구에 AI 요약 기능 추가', category: '제품',
      summary: '모의 데이터: 문서 도구에 회의록 요약 기능이 추가됐다는 가상의 소식.',
      publishedAt: day(now, 3), eventDate: null,
      sources: [src(3, '제품 업데이트 노트(모의)', 3)],
      value: '일반 사용자가 바로 써 볼 수 있는 변화.',
      uncertainty: '지역·요금제별 제공 범위 미확인. 사건 발생일 미확인.' },
    { id: 'c3', title: '[모의] 긴 문맥 처리 효율을 높이는 연구 공개', category: '연구',
      summary: '모의 데이터: 긴 문서를 적은 메모리로 처리하는 방법을 담은 가상의 논문.',
      publishedAt: day(now, 4), eventDate: day(now, 5),
      sources: [src(4, '논문 저장소(모의)', 4)],
      value: '기술 흐름을 설명하기 좋은 소재.',
      uncertainty: '동료 심사 전 사전 공개 논문.' },
    { id: 'c4', title: '[모의] 코드 에디터용 에이전트 기능 정식 출시', category: '개발 도구',
      summary: '모의 데이터: 코드 에디터의 에이전트 기능이 미리보기를 끝내고 정식 출시됐다는 가상의 소식.',
      publishedAt: day(now, 2), eventDate: day(now, 2),
      sources: [src(5, '변경 기록(모의)', 2)],
      value: '개발자 독자에게 직접적인 변화.',
      uncertainty: '무료 플랜 포함 여부 미확인.' },
    { id: 'c5', title: '[모의] 이미지 생성 모델 공개 예정 발표', category: '모델',
      summary: '모의 데이터: 다음 달 공개 예정이라고 발표된 가상의 이미지 모델. 아직 출시 전.',
      publishedAt: day(now, 5), eventDate: null,
      sources: [src(6, '행사 발표(모의)', 5)],
      value: '"공개 예정"과 "출시"를 구분해야 하는 사례.',
      uncertainty: '출시일과 제공 대상 미정.' },
    { id: 'c6', title: '[모의] AI 기본법 시행령 의견 수렴 시작', category: '정책',
      summary: '모의 데이터: 정부가 AI 관련 시행령 초안에 대한 의견 수렴을 시작했다는 가상의 소식.',
      publishedAt: null, eventDate: null,
      sources: [src(7, '보도자료(모의)', null)],
      value: '교육자·기관 독자에게 의미 있는 제도 변화.',
      uncertainty: '게시일 미확인. 초안이라 내용이 바뀔 수 있음.' },
    { id: 'c7', title: '[모의] 오픈소스 소형 모델 공개', category: '모델',
      summary: '모의 데이터: 노트북에서 실행 가능한 소형 모델이 공개됐다는 가상의 소식.',
      publishedAt: day(now, 6), eventDate: day(now, 6),
      sources: [src(8, '모델 저장소(모의)', 6)],
      value: '직접 실행해 볼 수 있는 소재.',
      uncertainty: '라이선스의 상업적 이용 조건 미확인.' },
    { id: 'c8', title: '[모의] 음성 비서에 실시간 통역 기능 시범 제공', category: '제품',
      summary: '모의 데이터: 일부 국가에서 실시간 통역 기능을 시범 제공한다는 가상의 소식.',
      publishedAt: day(now, 2), eventDate: null,
      sources: [src(9, '공식 발표(모의)', 2), src(10, '뉴스(모의)', 1)],
      value: '같은 발표를 다룬 기사 2건을 묶은 예. 생활 속 활용 사례.',
      uncertainty: '한국 제공 여부 미확인.' },
  ];
}

export const mockEngine: Engine = {
  name: 'mock',
  mock: true,

  async research(ctx: EngineContext, { topic, periodDays, now }): Promise<ResearchResult> {
    ctx.setSessionId(`mock-session-${ctx.projectId.slice(0, 8)}`);
    ctx.progress(`[모의] "${topic}" 검색어 정리 중`);
    await sleep(700, ctx.signal);
    ctx.progress(`[모의] 최근 ${periodDays}일 자료 검색 중`);
    await sleep(900, ctx.signal);
    if (scenario === 'search_fail') {
      throw new EngineError('search_failed', '[모의] 검색 도구 호출이 실패했습니다.', '잠시 후 다시 시도하세요.');
    }
    ctx.progress('[모의] 같은 발표 기사 묶는 중');
    await sleep(700, ctx.signal);
    let candidates = mockCandidates(now);
    if (scenario === 'few' && periodDays < 30) candidates = candidates.slice(0, 3);
    return {
      searchedAt: now.toISOString(),
      periodDays,
      periodStart: day(now, periodDays),
      periodEnd: day(now, 0),
      mock: true,
      engine: 'mock',
      note: '모의 데이터입니다. 실제 검색 결과가 아닙니다.',
      candidates,
    };
  },

  async deepResearch(ctx: EngineContext, { candidates }): Promise<DeepResearchDraft> {
    ctx.progress(`[모의] 선택한 ${candidates.length}개 후보의 원문 확인 중`);
    await sleep(900, ctx.signal);
    ctx.progress('[모의] 사실·주장·한계 분리 중');
    await sleep(700, ctx.signal);
    if (failDeepCalls.has(++deepCalls)) {
      throw new EngineError('engine_failed', `[모의 오류] ${deepCalls}번째 심층 조사에서 엔진이 응답하지 않았습니다(시험용 오류).`, '"다시 시도"를 누르세요.');
    }

    const records: ResearchRecord[] = candidates.map((c) => ({
      candidateId: c.id,
      facts: [{ text: `[모의] ${c.title}의 발표 사실`, sourceUrl: c.sources[0].url }],
      claims: [{ text: '[모의] 성능이 크게 향상됐다는 주장', by: c.sources[0].publisher, sourceUrl: c.sources[0].url }],
      limits: [c.uncertainty],
      conflicts: c.sources.length > 1 ? ['[모의] 두 출처의 제공 시작일 표기가 다름'] : [],
    }));

    let audience = ctx.priorAnswers.audience?.answer;
    if (!audience) {
      ctx.progress('[모의] 독자에 따라 구성이 크게 달라져 사용자에게 질문');
      audience = await ctx.askUser({
        key: 'audience',
        question: '어떤 독자에게 전달할까요?',
        options: [
          { label: '일반 사용자', description: '용어를 줄이고 "내 생활에서 무엇이 달라지나"를 중심으로 설명' },
          { label: '개발자', description: 'API·도구 변화와 바로 써 볼 수 있는 방법 중심' },
          { label: '교육자', description: '수업·과제에 미치는 영향과 주의점 중심' },
        ],
        recommended: '일반 사용자',
        recommendationReason: '[모의] 선택한 소식이 제품 기능 변화 중심이라 넓은 독자에게 유용합니다.',
        allowFreeText: true,
      });
    }
    const who = audience.text?.trim() || audience.choice || '일반 사용자';
    ctx.progress(`[모의] 독자 "${who}" 기준으로 편집 방향 정리 중`);
    await sleep(700, ctx.signal);

    const story = who !== '개발자';
    const allFacts = candidates.map((c) => ({ candidateId: c.id, factIndex: 0 }));
    return {
      mock: true,
      records,
      editorial: {
        audience: who,
        whyUseful: `[모의] ${who}가 이번 변화를 오해 없이 이해하고 바로 판단할 수 있게 한다.`,
        formats: {
          list: { fit: '[모의] 여러 발표를 한 장씩 빠르게 훑을 수 있다.', drawback: '[모의] 변화가 왜 중요한지 설명할 공간이 적다.' },
          story: { fit: '[모의] 처음 접하는 독자도 변화의 의미를 순서대로 이해할 수 있다.', drawback: '[모의] 소식이 여러 개면 한 흐름에 담기 어렵다.' },
        },
        recommendedFormat: story ? 'story' : 'list',
        formatReason: story
          ? `[모의] ${who}에게는 변화의 의미를 이해시키는 것이 먼저라 이야기형을 추천한다.`
          : '[모의] 개발자는 여러 변경을 빠르게 확인하길 원해 목록형을 추천한다.',
        structure: story
          ? [
              { role: '표지', summary: '[모의] 후킹 문구' },
              { role: '상황', summary: '[모의] 지금까지는 어떻게 했나' },
              { role: '불편', summary: '[모의] 무엇이 불편했나' },
              { role: '변화', summary: '[모의] 이번 발표로 무엇이 달라졌나' },
              { role: '활용', summary: '[모의] 어디에 쓸 수 있나' },
              { role: '한계', summary: '[모의] 아직 확인되지 않은 조건' },
              { role: '요약·출처', summary: '[모의] 정리와 원문 링크' },
            ]
          : [
              { role: '표지', summary: '[모의] 후킹 문구' },
              ...candidates.map((c) => ({ role: '소식', summary: c.title })),
              { role: '요약·출처', summary: '[모의] 정리와 원문 링크' },
            ],
        hooks: [
          { text: `[모의] ${who}라면 이번 주 꼭 알아야 할 변화`, factRefs: allFacts },
          // Passes only when every referenced candidate has a confirmed publish date.
          { text: '[모의] 최신 발표, 확인된 것만 정리했습니다', factRefs: allFacts },
          // No supporting fact: the rule check must exclude it.
          { text: '[모의] 성능 2배 향상, 지금 바로 써 보세요', factRefs: [] },
        ],
        reasoning: '[모의] 후킹 문구는 확인된 사실 범위 안에서만 작성했습니다.',
      },
    };
  },

  async storyboard(ctx: EngineContext, { deep, instruction }): Promise<StoryboardDraft> {
    ctx.progress(instruction ? `[모의] 변경 요청 반영 중: ${instruction.slice(0, 40)}` : '[모의] 스토리보드 기획 중');
    await sleep(900, ctx.signal);
    const refs = deep.records.map((r) => ({ candidateId: r.candidateId, factIndex: 0 }));
    const card = (role: string, headline: string, body: string, scene: string, factRefs = refs.slice(0, 1)) => ({
      role, headline: `[모의] ${headline}`, body: `[모의] ${body}`,
      imageRole: `[모의] ${role} 장면을 떠올리게 하는 배경`,
      imagePrompt: `[모의] ${scene}. 위쪽 40%는 비운 배경.`,
      factRefs,
    });
    const cards = deep.editorial.recommendedFormat === 'story'
      ? [
          card('표지', '이번 주 알아 둘 변화', '확인된 사실만 골라 정리했습니다.', '책상 위 노트북과 커피잔', refs),
          card('상황', '지금까지는 이렇게 썼습니다', '대부분 기존 방식으로 일했습니다.', '사무실 책상에서 일하는 손'),
          card('불편', '이런 점이 불편했습니다', '시간이 오래 걸렸습니다.', '쌓인 서류 더미'),
          card('변화', '이번 발표로 달라진 점', '발표 내용을 원문으로 확인했습니다.', '빛이 비치는 창문'),
          card('활용', '이렇게 써 볼 수 있습니다', '일상 업무에 적용할 수 있습니다.', '정리된 책상'),
          card('한계', '아직 확인되지 않은 것', '제공 지역과 조건은 미확인입니다.', '안개 낀 길'),
          card('요약·출처', '세 줄 요약과 출처', '원문 링크를 확인하세요.', '체크리스트가 놓인 책상', refs),
        ]
      : [
          card('표지', '이번 주 AI 소식', '확인된 소식만 모았습니다.', '신문 더미와 노트북', refs),
          ...deep.records.map((r) => card('소식', `${r.candidateId} 소식`, '발표 내용을 원문으로 확인했습니다.', '추상적인 연결선', [{ candidateId: r.candidateId, factIndex: 0 }])),
          card('요약·출처', '정리와 출처', '원문 링크를 확인하세요.', '체크리스트', refs),
        ];
    return {
      styleGuide: '[모의] 평면 일러스트, 아이보리(#F6F1E7)·남색(#23356B)·주황(#F08A3E) 3색, 부드러운 그림자, 위쪽 40% 여백.',
      cards,
    };
  },

  async reviseCard(ctx: EngineContext, { headline, body, instruction }): Promise<RevisedCard> {
    ctx.progress(`[모의] 카드 문장 고치는 중: ${instruction.slice(0, 40)}`);
    await sleep(700, ctx.signal);
    if (process.env.CARD_NEWS_MOCK_FAIL_REVISION === '1') {
      throw new EngineError('engine_failed', '[모의 오류] 카드 문장 고치기가 실패했습니다(시험용 오류).', '다시 요청해 보세요.');
    }
    // Keeps the first two sentences, as a stand-in for "shorten to two sentences".
    const sentences = body.split(/(?<=[.!?요다])\s+/).filter(Boolean);
    return {
      headline,
      body: `[모의 수정] ${sentences.slice(0, 2).join(' ')}`.slice(0, 240),
      note: `[모의] 본문을 앞 두 문장으로 줄였습니다(요청: ${instruction.slice(0, 40)}).`,
    };
  },
};
