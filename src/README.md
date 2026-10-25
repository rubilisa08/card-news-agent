# src: 서버와 에이전트 코드

TypeScript 파일을 빌드 없이 Node 24로 바로 실행합니다(`npm start`). 타입 검사는 `npm run typecheck`입니다.

| 파일 | 하는 일 |
|---|---|
| `server.ts` | 웹 서버(Fastify)와 API 경로, 화면에 보낼 프로젝트 정보 |
| `db.ts` | SQLite 저장소(프로젝트, 작업, 질문, 중복 요청 방지) |
| `jobs.ts` | 작업 관리: 조사, 심층 조사, 스토리보드, 승인, 그림, 카드 수정, 최종 승인, 내보내기, 취소, 재시작 복구 |
| `engine/` | 조사·스토리보드를 맡는 엔진. `claude-cli.ts`(Claude CLI 지시문과 결과 검증), `mock.ts`(모의 엔진), `types.ts`(엔진 인터페이스), `index.ts`(엔진 고르기) |
| `editorial.ts` | 편집 방향 규칙 검사(후킹은 확인된 사실로, '최신'은 날짜 근거로) |
| `storyboard.ts` | 스토리보드 규칙 검사(5~8장, 한 장 한 메시지, 근거) |
| `layout.ts` | 카드 디자인 목록과 글자 배치 기본값·검증 |
| `artDirection.ts` | 디자인별 그림 규칙(크기·색·여백·구도), agy와 SVG 공통 |
| `images.ts` | 그림 생성(agy, Claude CLI SVG)과 파일 검사, 생성 기록 |
| `render.ts` | 완성 카드를 PNG로 찍기(Playwright + Edge), ZIP 만들기 |
| `exporter.ts` | 최종 내보내기와 검사(누락·잘림·겹침·출처·날짜) |
| `sourceTrust.ts` | 출처 신뢰 등급(공식/주요 언론/전문 매체/확인 필요) 목록 |
| `outlets.ts` | 조사마다 꼭 찾는 언론사 11곳과 찾는 방법 |
| `types.ts` | 데이터 형식 정의 |
