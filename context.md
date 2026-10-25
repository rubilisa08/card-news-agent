# 작업 인계 문서 (context.md)

마지막 갱신: 2026-10-25 (KST). 새 세션은 **이 파일 → DECISIONS.md → README.md → SOURCES.md → VALIDATION.md → API_SPEC.md** 순서로 읽고 시작한다. 원래 요구사항은 PRD.md(일부 수정됨), 검수 기준은 ACCEPTANCE.md, 엔진 참고는 ENGINE_GUIDE.md·EXAMPLE_RUN.md다.

GitHub: https://github.com/rubilisa08/card-news-agent (2026-10-25 첫 커밋). 사용자 데이터 `data/`와 `node_modules/`는 올리지 않는다(.gitignore).

---

## 1. 사용자와 작업 방식 (꼭 지킬 것)
- **모든 설명은 한국어로 쓴다.** 마무리 메시지뿐 아니라 진행 안내도 한국어다.
- **agy로 시험용 이미지를 만들지 않는다.** 한도가 낮다(2026-10-24에 한도 초과, 초기화 예정 2026-10-30 14:55 KST). 실제 카드 제작에서만 쓴다. `agy models`처럼 그림을 만들지 않는 명령은 된다.
- **출처 원칙:** 공식 발표·주요 언론 우선. 확인 안 된 소식은 빼지 말고 "확인 필요"로 표시한다. 카드에는 확인된 내용만 사실로 쓴다. 기준은 SOURCES.md다.
- **조사마다 꼭 찾는 언론사 11곳:** SBS 뉴스, 중앙일보, 한국경제, 조선일보, 동아일보, 매일경제, 서울신문, 경향신문, 한겨레, 한국일보, 머니투데이.
- **시험은 사용자 `data/`가 아닌 별도 폴더에서 한다.** `CARD_NEWS_DATA_DIR`=임시 폴더, 포트 8790/8791. 사용자 데이터 복사는 `VACUUM INTO`(읽기 전용으로 열어서)로 한다.
- **미검증 항목을 성공으로 적지 않는다.** 확인 방식(모의/복사본/실제 엔진)을 밝힌다. Claude 사용량이 드는 실제 조사·그림 생성은 사용자에게 먼저 묻는다.
- 사용자는 비개발자에 가깝다. 어느 폴더에서 무엇을 입력하는지, 서버 다시 켜기까지 순서대로 안내한다. 코드를 바꾸면 "서버를 다시 켜야 적용"을 꼭 말한다. 작업이 도는 중에 서버를 끄면 그 작업이 중단된다.
- 사용자는 Windows 11, PowerShell, OneDrive 폴더를 쓴다. 프로젝트 경로는 `C:\Users\cheon\OneDrive\바탕 화면\AI Agent\card-news-workflow-kit`이다.

## 2. 만들고 있는 것
PRD.md의 "사용자와 함께 만드는 카드뉴스 에이전트". 흐름:
1. 주제 입력(최근 7일/30일 선택) → 웹 조사(후보 7~12개 + 찾은 기사 전체 목록)
2. 사용자가 1~3개 선택 → 심층 조사(사실·주장·한계·상충 분리), 필요하면 독자 질문
3. 편집 방향(목록형·이야기형 비교 후 추천, 근거가 달린 후킹) → 스토리보드 5~8장 → 승인(디자인·그림 도구 선택)
4. 장별 설명 그림 생성(agy 또는 Claude CLI SVG, 글자 없음)
5. 글자 배치(디자인 6종, 휴대폰 미리보기, 잘림·겹침 검사) → 카드별 수정 요청(글자/그림) → 최종 승인
6. 내보내기(카드별 PNG, ZIP, 출처·이미지 기록, 내보낸 파일 검사)

### 핵심 결정 (자세한 이유는 DECISIONS.md, D1~D16·B1~B50)
- **실행:** TypeScript·Node 24를 빌드 없이 직접 실행(`tsc --noEmit`로 타입만 검사), Fastify, `node:sqlite`, 빌드 없는 HTML+JS 화면(1.5초 폴링).
- **엔진:** Claude CLI(`claude -p`, stream-json, `--json-schema`), 모델 sonnet, effort medium. 호출 하나 시간 제한 25분.
- **그림:** agy(Antigravity CLI) 또는 Claude CLI가 SVG 코드로 그린다. 승인할 때 고른다(B50). 그림 규칙(크기·색·여백·구도)은 디자인마다 `src/artDirection.ts`가 붙인다.
- **카드 출력:** 1080×1350 HTML을 playwright-core + 설치된 Edge로 PNG로 찍는다. 글꼴 Pretendard.

## 3. 실행 방법
```bash
cd "C:\Users\cheon\OneDrive\바탕 화면\AI Agent\card-news-workflow-kit"
npm install          # 처음 한 번
npm start            # 실제 엔진(Claude CLI). Claude 로그인 필요
npm run start:mock   # 모의 엔진
npm run typecheck    # 타입 검사
```
- 브라우저 주소 http://127.0.0.1:8765, 끌 때는 서버 창에서 Ctrl+C.
- 환경 변수는 README "설정" 표. 주요: `PORT`, `CARD_NEWS_DATA_DIR`, `CARD_NEWS_ENGINE`, `CARD_NEWS_CLAUDE_MODEL`, `CARD_NEWS_ENGINE_TIMEOUT_MS`(기본 25분), `CARD_NEWS_IMAGE_TOOL`, `CARD_NEWS_IMAGE_TIMEOUT_MS`.
- 시험 서버(Git Bash, 백그라운드): `(CARD_NEWS_DATA_DIR="<임시폴더>" PORT=8791 nohup node src/server.ts > log 2>&1 &)`. 끝나면 `Get-NetTCPConnection -LocalPort 8791 -State Listen`으로 찾아 `Stop-Process`로 끈다.
- 사용자 데이터 복사: `node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/app.db',{readOnly:true}).exec(\"VACUUM INTO '<임시>/app.db'\")"` + 필요한 `data/projects/<id>` 폴더 복사.
- 서버는 코드 파일이 바뀌면 응답 헤더 `x-server-outdated`로 알리고, 화면에 "서버를 다시 켜야 합니다" 띠가 뜬다.
- Claude CLI를 이 데스크톱 앱 안에서 직접 실행하면 앱 환경 변수 때문에 인증이 실패한다. 앱은 `childEnv()`로 걸러 낸다.

## 4. 코드 구조
| 파일 | 역할 |
|---|---|
| `src/server.ts` | 라우트, requestId 중복 처리(`once`), 프로젝트 스냅샷(출처 등급 `trust`, 작업 보통 시간 `typicalSeconds` 포함), 이미지·PNG·ZIP·내보내기 파일 제공 |
| `src/db.ts` | SQLite(projects, runs, questions, requests). 열 추가 마이그레이션. `typicalSeconds`, `supersedeOpenOfKind` |
| `src/jobs.ts` | 작업 관리자: 조사·심층 조사·스토리보드·승인(그림 도구)·그림·재시도(도구 선택)·카드 수정·최종 승인·내보내기·취소·재시작 복구. 시작 때 예전 "보류" 소식 되돌리기와 기간 넓히기 질문 닫기 |
| `src/engine/claude-cli.ts` | 조사(구글 뉴스로 넓게 훑기, 언론사 11곳, 한국어 출처, `articles`, `site`), 심층 조사, 스토리보드, 카드 글자 고치기, SVG 그리기 지시문·스키마·검증 |
| `src/engine/mock.ts` | 모의 엔진 |
| `src/sourceTrust.ts` | 출처 등급(공식/주요 언론/전문 매체/확인 필요) 도메인 목록 |
| `src/outlets.ts` | 꼭 찾는 언론사 11곳, 찾는 방법(직접/구글 뉴스), 포털·구글 뉴스 링크 등급 |
| `src/editorial.ts`, `src/storyboard.ts` | 편집·스토리보드 규칙 검사 |
| `src/layout.ts` | 디자인 목록(basic, soft, brief, news, photo, cinema), 기본 배치, 검증 |
| `src/artDirection.ts` | 디자인별 그림 규칙(agy·SVG 공통) |
| `src/images.ts` | 그림 작업자: agy 호출과 brain 폴더에서 그림 가져오기, 한도 초과 감지, Claude SVG, 검사, PROVENANCE.md |
| `src/render.ts` | Playwright로 렌더 페이지를 PNG로 찍기, ZIP |
| `src/exporter.ts` | 최종 내보내기와 검사(누락·잘림·겹침·출처 등급·날짜) |
| `public/index.html, app.js, style.css` | 화면 |

문서: `DECISIONS.md`(결정 기록), `README.md`(실행법·확인 기록), `SOURCES.md`(출처 기준), `API_SPEC.md`, `VALIDATION.md`.

## 5. 작업 기록

### 세션 1 (2026-10-23)
- 기반: 주제 → 조사 → 선택 → 심층 조사 → 독자 질문 → 편집 방향 → 스토리보드 → 승인 → 그림 흐름. 모의·실제 엔진으로 확인(VALIDATION.md 5개 상황 통과).
- 실제 엔진 첫 그림: agy가 빈 오류로 실패해 7장 모두 Claude SVG로 대체.

### 세션 2 (2026-10-23 ~ 2026-10-25) — 이 대화
- **화면 개선(B22, B23):** 결과로 이동, 후보 목록 접기, 옛 화면 감지 띠, 앱 안 확인 창(브라우저 패널이 `confirm()`을 막음).
- **글자 배치와 출력(B24~B27):** 그림 위 HTML 글자, 휴대폰 미리보기, 잘림·겹침·작음 검사와 자동 수정, Pretendard, PNG·ZIP 내려받기, 서버 재시작 안내.
- **프로젝트 기록 관리:** 이름 바꾸기, 보관, 삭제.
- **디자인(B28, B30, B33, B40):** 기본·소프트(사용자가 가장 좋아함), 뉴스 다크·포토 오버레이(사용자 예시 "오늘광남", "9호선"), 시네마(포엠매거진 예시), 브리프 포스터(구글 WeatherNext 카드 예시). 매거진·볼드는 사용자가 싫다고 해서 지움. 모든 카드 오른쪽 위 페이지 번호.
- **말투:** 카드 문장은 해요체.
- **카드별 수정·최종 승인·내보내기(B29):** 글자만/그림만 수정, 수정하면 최종 승인 다시, PNG·ZIP·출처와 이미지 기록, 내보낸 파일 검사(확인 못 함은 통과 아님).
- **그림 규칙(B31):** 크기·색·여백 조화를 agy와 SVG 모두에 적용.
- **agy 원인(B32):** 그림은 만들어졌는데 옮기는 명령이 headless 권한에 막혔던 것 → 앱이 brain 폴더에서 직접 가져옴. 이후 한도 초과(429)를 감지해 알림(B37), 실패한 카드를 Claude CLI로 이어 그리기(B37), 승인할 때 도구 선택(B50).
- **그림 없는 카드(B34, B35):** 글자 카드 모양 3가지(키워드 띠, 형광펜 요약, 포스터).
- **출처(B36, B38, B39, B41~B44, B46):** 출처 등급과 꼬리표, 언론사 11곳 검색(막힌 5곳은 구글 뉴스 RSS), 출처는 한국어 기본, 구글 뉴스로 넓게 훑기(제목에 주제어가 없는 기사도 찾음 — "한정선" 사례), 찾은 기사 전체 목록, 주요 언론 목록 확대, SOURCES.md 정리, "보류" 대신 "출처 확인 필요" 표시.
- **후보 화면(B44, B45, B47):** 선택할 가치(파란 상자, 2~3줄)와 불확실성(주황 글자), 기간 넓히기 질문 없앰.
- **작업 경과 시간(B48):** "5분 12초째", "걸린 시간", 보통 걸리는 시간.
- **사진 디자인을 그림에 맞추기(B49):** 뉴스 다크는 사진 띠를 그림 내용 쪽으로, 시네마는 글자를 빈 쪽으로(밝으면 진한 글자). 다른 디자인용 그림을 쓸 때 생기던 문제.

## 6. 지금 상태와 남은 일
- 사용자 서버(8765)는 코드를 바꿀 때마다 다시 켜야 한다. 마지막 변경(B50 그림 도구 선택)은 사용자가 다시 켜야 반영된다.
- **실제 엔진으로 아직 확인하지 않은 것:** 선택할 가치 2~3줄 규칙(B47)으로 실제 조사, 승인 때 고른 도구로 실제 그림 생성(B50), 작업 취소 시 claude 프로세스 정리, 재시작 뒤 이어가기.
- 뉴스 다크는 그림 내용이 640px 띠보다 크면 위아래가 조금 잘린다. 새로 그리면(지금 디자인 규칙) 가장 잘 맞는다.
- 사용자 `data/`에 확인용으로 만든 모의·시험 프로젝트가 몇 개 남아 있다(사용자가 직접 정리).
- ACCEPTANCE.md 전체 항목 검증과 기록.

## 7. 알려진 함정
- 이 환경의 검색 도구는 로이터·더버지·와이어드·연합뉴스·FT·WSJ·폴리티코·비즈니스인사이더·중앙·조선·동아·매경·한겨레에 들어가지 못한다. 구글 뉴스 RSS(`news.google.com/rss/search?q=…+when:7d&hl=ko&gl=KR&ceid=KR:ko`)는 WebFetch로 열리고 언론사·시각을 준다(본문은 없음).
- 웹 검색(WebSearch)은 제목 위주로 맞추고 오래된 결과가 많다. 본문에만 주제어가 있는 기사는 구글 뉴스 목록으로 잡는다.
- `usage.server_tool_use.web_search_requests`는 실제 검색을 해도 0이다. 스트림의 tool_use_result로 센다(B12).
- Git Bash에서 `curl`이나 명령 인자로 한국어를 보내면 깨질 수 있다. 시험 요청은 Node fetch 스크립트로 보낸다.
- Python 패치를 bash heredoc 안에 넣으면 `\b`, `\d` 같은 이스케이프가 깨진다. 패치 스크립트는 파일로 써서 실행한다.
- 숨겨진 브라우저 패널에서는 스크린샷이 안 될 수 있다. JS로 DOM 상태를 읽는다. 같은 탭에서 해시만 바꾸면 옛 app.js가 남으므로 새로고침한다.
- agy는 그림을 `~/.gemini/antigravity-cli/brain/<대화>/`에 JPG로 저장한다. headless에서는 파일 옮기기 명령이 막힌다.
- 렌더(PNG) 페이지는 그림 측정(B49)과 글꼴 로드가 끝난 뒤 찍는다.
