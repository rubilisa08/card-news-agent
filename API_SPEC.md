# 웹 API 명세

기준 주소는 `http://127.0.0.1:8765`이고, 모든 본문은 JSON입니다. 이 문서는 PRD "웹 API 계약 초안"을 확정한 것입니다. **구현 상태** 열에서 아직 만들지 않은 요청을 구분합니다.

## 연결 방식

### 전체 구조

```
브라우저(public/app.js)  ──HTTP JSON──▶  웹 서버(src/server.ts, Fastify, 127.0.0.1:8765)
        ▲                                        │ 상태 저장: data/app.db (SQLite)
        │ 1.5초마다 GET으로 상태 조회(폴링)          ▼
        └──────────────────────────  작업 관리자(src/jobs.ts)
                                                 │ 백그라운드 작업 실행
                                                 ▼
                                   엔진: claude-cli(실제 검색) 또는 mock(모의 데이터)
                                   claude-cli는 claude -p를 하위 프로세스로 실행
```

- 브라우저는 명령을 직접 실행하지 않는다. 서버에 요청만 보낸다.
- 오래 걸리는 작업(조사, 심층 조사)은 요청을 받으면 **작업 ID를 바로 돌려주고**(202) 백그라운드에서 실행한다. 브라우저는 `GET /api/projects/{id}`를 1.5초마다 호출해 진행 상황, 질문, 결과를 받아 화면을 갱신한다.
- 화면의 원본은 언제나 서버다. 브라우저는 아직 보내지 않은 입력만 따로 들고 있다(체크한 후보, 쓰다 만 답변). 그래서 새로고침해도 후보·선택·질문·진행 상태가 그대로 다시 보인다.

### 화면 흐름과 요청 순서

| 단계 | 사용자 동작 | 브라우저가 보내는 요청 | 서버 동작 |
|---|---|---|---|
| 1. 주제 입력 | 주제와 기간을 입력하고 "조사 시작" | `POST /api/projects` → `POST /api/projects/{id}/research` | 프로젝트를 만들고 후보 조사 작업을 시작한다(`stage: researching`). |
| 2. 조사 진행 | 기다림. "작업 취소"를 누를 수 있음 | `GET /api/projects/{id}` 반복, 취소 시 `POST /api/runs/{runId}/cancel` | 진행 메시지(검색어 등)를 `runs[0].progress`에 쌓는다. 끝나면 `research`에 후보를 저장한다(`stage: selecting`). |
| 2-1. 결과 부족 | "30일로 넓힐까요?"에 답 | `POST /api/projects/{id}/answers` | 7일 후보가 5개 미만이면 질문을 만든다. "넓히기"를 고르면 30일로 다시 조사한다. |
| 3. 후보 선택 | 1~3개 체크 후 "선택 저장 후 심층 조사" | `POST /api/projects/{id}/selection` → `POST /api/projects/{id}/deep-research` | 선택을 저장한다. 선택이 저장되기 전에는 심층 조사를 시작하지 않는다. |
| 4. 질문 답변 | 질문 카드에서 선택지를 고르거나 직접 입력하고 "답변 제출" | `POST /api/projects/{id}/answers` | 작업은 `waiting_for_user`로 기다리다가, 답을 받으면 같은 엔진 세션으로 이어 간다. |
| 5. 결과 확인 | 조사 기록과 편집 방향을 읽음 | `GET /api/projects/{id}` | `deep`에 조사 기록과 편집 제안을 저장한다(`stage: editorial_ready`). |

- **중복 클릭:** 버튼은 요청 중에 비활성화된다. 답변의 `requestId`는 질문마다 하나로 고정해 브라우저 세션 저장소에 둔다. 그래서 두 번 누르거나 새로고침 뒤 다시 보내도 서버에는 한 번만 반영된다.
- **오래된 화면:** 선택 저장은 `version`을, 답변은 `questionVersion`을 함께 보낸다. 다른 화면에서 이미 바뀌었으면 409로 거절되고, 화면은 최신 상태로 다시 그려진다.
- **추천 선택지:** 질문 카드에 "추천" 표시만 하고 미리 체크하지 않는다. 사용자가 직접 골라야 답으로 저장된다.

### 서버와 엔진의 연결

- 작업 관리자는 엔진에 `progress()`(진행 상황), `askUser()`(질문), `setSessionId()`(세션 저장) 기능을 넘겨준다. 엔진이 `askUser()`를 부르면 관리자가 질문을 DB에 저장하고 작업을 `waiting_for_user`로 바꾼다. 웹에서 답이 오면 엔진에 돌려준다.
- **claude-cli:** `claude -p`를 인자 배열로 실행하고(셸을 거치지 않음) 프롬프트는 stdin으로 보낸다. 결과는 JSON 스키마로 받고 앱이 다시 검사한다. 질문이 필요하면 엔진이 `status: "need_input"`을 반환하고 그 호출은 끝난다. 답이 오면 `--resume <세션 ID>`로 같은 세션에 이어서 보낸다. 세션 ID는 프로젝트마다 따로 저장한다. 자세한 내용은 DECISIONS.md B10~B13.
- **mock:** 실제 검색 없이 정해진 모의 후보 8개와 독자 질문을 돌려준다. 화면 흐름을 확인하는 용도다.
- **서버 재시작:** 실행 중이거나 답을 기다리던 작업은 `interrupted`로 표시된다. 열린 질문에 답하면 저장된 답과 세션으로 그 단계를 다시 실행하고, 질문이 없으면 "다시 시도" 버튼을 보여 준다.

### 모의 데이터 표시

모의 엔진으로 실행하면(`npm run start:mock`) 다음 위치에 모의임을 표시한다. 실제 검색 결과로 오해하지 않게 하기 위해서다.
- 화면 맨 위 노란 띠: "모의 엔진으로 실행 중입니다 … 실제 검색 결과가 아닌 모의 데이터입니다."
- 오른쪽 위 엔진 표시: "엔진: mock"
- 프로젝트 제목 아래, 각 후보 카드, 조사 기록 제목의 "모의" 꼬리표
- 후보 목록 위 안내 문구, 그리고 모든 모의 문장 앞의 "[모의]"
- 링크는 실제로 존재하지 않는 `https://example.com/mock/...` 주소다.

`GET /api/health`의 `mock`, 프로젝트 스냅샷의 `project.mock`과 `research.mock`이 `true`이면 화면이 위 표시를 켠다.

## 공통 규칙

- **requestId**: 상태를 바꾸는 요청은 모두 `requestId`(클라이언트가 만든 UUID)를 받습니다. 프로젝트 범위에서 같은 ID·같은 입력이면 처음 저장한 응답을 그대로 돌려줍니다. 같은 ID인데 입력이 다르면 `409 request_conflict`를 돌려줍니다.
- **version**: 프로젝트에는 결과가 바뀔 때마다 1씩 오르는 `version`이 있습니다. 선택 저장·승인처럼 화면에 보인 상태를 바탕으로 하는 요청은 `version`이 현재 값과 다르면 `409 stale_version`으로 거절합니다.
- **진행 중 작업**: 같은 종류의 작업이 이미 실행 중이거나 답변을 기다리고 있으면 새 작업을 만들지 않고 그 작업을 돌려줍니다(`reused: true`).

### 오류 응답

```json
{ "error": { "code": "stale_question", "message": "이미 답한 질문입니다.", "nextAction": "화면을 새로고침하세요." } }
```

| code | HTTP | 의미 |
|---|---|---|
| bad_request | 400 | 입력 형식 오류 |
| invalid_answer | 400 | 선택지에 없는 답이거나 빈 자유 입력 |
| not_found | 404 | 프로젝트·작업·질문이 없음 |
| request_conflict | 409 | 같은 requestId에 다른 입력 |
| stale_version | 409 | 오래된 화면에서 보낸 요청 |
| stale_question | 409 | 이미 답했거나 더는 유효하지 않은 질문 |
| invalid_stage | 409 | 지금 단계에서 할 수 없는 요청 |
| not_implemented | 501 | 아직 구현하지 않은 단계 |

작업 실패 시 `run.error.code`에 들어가는 값: `auth_required`, `search_failed`, `image_failed`, `engine_failed`, `cancelled`, `interrupted`

## 상태 값

- **project.stage**: `created` → `researching` → `selecting` → `deep_research` → `editorial_ready` → `storyboard_drafting` → `storyboard_review` → (승인) `producing` → `reviewing` → (`approved`, 미구현)
- **스냅샷 추가 필드**: `storyboard`(`version`, `format`, `audience`, `styleGuide`, `cards[{ index, role, headline, body, imageRole, imagePrompt, sources[{ fact, url, publishedAt }] }]`, `warnings`, `approvedAt`), `images`(`tool`, `fallbackReason`, `cards[{ index, status: pending|generating|done|failed, tool, file, format, width, height, bytes, prompt, createdAt, error, attempts }]`)
- **`layouts`**: 스토리보드 승인 전에는 `null`. 승인 뒤에는 카드마다 `{ index, headline, body, position: top|middle|bottom, align: left|center, headlineSize(48~120), bodySize(28~64), theme: dark|light, panel: none|soft|solid, updatedAt, saved }`. 크기는 1080×1350 카드 기준 px. 저장하지 않은 카드는 스토리보드 문장과 기본 배치(위, 76/40, 어두운 글자, 받침 없음)이고 `saved: false`. 잘림·겹침·글자 크기 검사는 화면(브라우저)이 실제 글자 위치와 이미지 픽셀을 재서 하며, 서버에 저장하지 않는다(B24)
- **run.status**: `running`, `waiting_for_user`, `succeeded`, `failed`, `cancelled`, `interrupted`. `waiting_for_user`는 실패가 아닙니다.
- **question.status**: `open`, `answered`, `superseded`(작업 취소 등으로 무효)

## 요청

| 요청 | 입력 | 결과 | 구현 상태 |
|---|---|---|---|
| GET /api/health | – | `{ ok, engine, mock }` | 완료 |
| GET /api/projects | `?archived=1`(보관함) | `{ archived, archivedCount, projects: [{ id, topic, name, stage, mock, cards, images, busy, createdAt, updatedAt, archivedAt }] }`, 최근 작업 순 | 완료 |
| POST /api/projects/{id}/name | `name`(100자 이하, 빈 값이면 이름 지움) | `{ name, version }` | 완료. 조사 주제(`topic`)는 바뀌지 않음 |
| POST /api/projects/{id}/archive | `archived`(true/false) | `{ archivedAt }` | 완료. 작업 중이면 보관 409 |
| DELETE /api/projects/{id} | – | `{ deleted: true }` | 완료. 작업 중이면 409. DB 기록과 `projects/{id}` 폴더를 지움 |
| POST /api/projects | `topic`, `periodDays?`(7 또는 30), `requestId` | `{ projectId }` | 완료 |
| GET /api/projects/{id} | – | 프로젝트 스냅샷(아래) | 완료 |
| POST /api/projects/{id}/research | `requestId`, `periodDays?` | `{ runId, status, reused }` | 완료 |
| POST /api/projects/{id}/selection | `candidateIds`(1~3개), `version`, `requestId` | `{ selection, version }` | 완료 |
| POST /api/projects/{id}/deep-research | `version`, `requestId` | `{ runId, status, reused }` | 완료 (PRD 초안에 없던 요청. 선택 저장과 다음 단계 시작을 나눔) |
| POST /api/projects/{id}/answers | `questionId`, `questionVersion`, `answer: { choice?, text? }`, `requestId` | `{ accepted, question, runId }` | 완료 |
| POST /api/runs/{id}/cancel | – | `{ runId, status }` | 완료 |
| POST /api/projects/{id}/storyboard | `version`, `requestId`, `instruction?`(변경 요청) | `{ runId, status, reused }` | 완료. 심층 조사 결과가 있고 승인 전일 때만 가능 |
| POST /api/projects/{id}/approve | `stage`(storyboard/final), `version`, `requestId` | storyboard: `{ approved, storyboardVersion, runId }`(이미지 작업 시작) | storyboard 완료 / final은 아래 행 참고 |
| POST /api/projects/{id}/images/{index}/retry | `requestId` | `{ runId, status, reused }` | 완료. 실패한 카드만 다시 생성 |
| GET /api/projects/{id}/images/{file} | – | 확인 완료된 카드 이미지(PNG 또는 SVG) | 완료. `card-NN.png`·`card-NN.svg` 이름만 허용 |
| POST /api/projects/{id}/cards/{index}/layout | `layout`(아래) 또는 `null`(기본 배치로 되돌림), `version`, `requestId` | `{ version }` | 완료. 스토리보드 승인 뒤에만 가능. 값이 범위를 벗어나면 400 |
| POST /api/projects/{id}/design | `design`(basic/magazine/bold/soft), `version`, `requestId` | `{ design, version }` | 완료. 스냅샷의 `design`으로 보임(기본 basic) |
| GET /api/projects/{id}/cards/{index}/png | – | 저장된 배치로 찍은 1080×1350 PNG(내려받기). 헤더 `x-font-loaded` | 완료. 승인한 스토리보드와 그 카드의 이미지가 있어야 함(아니면 409). 찍기 실패 500 `render_failed` |
| GET /api/projects/{id}/cards.zip | – | 카드 PNG 전부 + `출처와 이미지 기록.md` ZIP | 완료. 모든 카드의 이미지가 있어야 함 |
| POST /api/projects/{id}/revisions | `index`, `kind`(text/image), `instruction`(1~500자), `version`, `requestId` | `{ runId, revisionId, status }` (작업 kind `revision`) | 완료. 승인한 스토리보드와 그림이 있어야 함. 다른 작업 중이면 409 |
| POST /api/projects/{id}/approve | `stage: "final"`, `version`, `requestId` | `{ approved, signature, runId }` (작업 kind `export`) | 완료. 모든 그림이 done이어야 함 |
| GET /api/projects/{id}/exports | – | `{ final, items: [{ id, createdAt, signature, files, checks, toReview, current }] }` | 완료. `current`는 지금 카드와 같은 내보내기 |
| GET /api/projects/{id}/exports/{exportId}/{file} | – | 내보낸 파일(PNG·ZIP·md) 내려받기 | 완료. 그 내보내기 목록에 있는 이름만 |

### 프로젝트 스냅샷

```jsonc
{
  "project": { "id", "topic", "periodDays", "stage", "version", "engine", "mock", "createdAt", "updatedAt" },
  "research": {            // 조사 전에는 null
    "searchedAt", "periodDays", "periodStart", "periodEnd", "mock", "engine", "note",
    "candidates": [{
      "id", "title", "summary", "category",
      "publishedAt",       // 확인 못 하면 null → 화면에 "미확인"
      "eventDate",         // 확인 못 하면 null
      "sources": [{ "title", "url", "publisher", "publishedAt" }],  // 같은 발표 기사는 한 후보에 묶음
      "value", "uncertainty"
    }]
  },
  "selection": { "candidateIds": [], "savedAt" },   // 없으면 null
  "deep": {                // 심층 조사 결과, 없으면 null
    "records": [{ "candidateId", "facts": [{ "text", "sourceUrl" }], "claims": [{ "text", "by", "sourceUrl" }], "limits", "conflicts" }],
    "editorial": {
      "audience", "whyUseful",
      "formats": { "list": { "fit", "drawback" }, "story": { "fit", "drawback" } },  // 목록형·이야기형 비교
      "recommendedFormat": "list | story", "formatReason",
      "structure": [{ "role", "summary" }],  // 이야기형은 상황 → 불편 → 변화 → 활용 → 한계
      "hooks": [{ "text", "basis": [{ "candidateId", "fact", "sourceUrl", "publishedAt" }], "latestBasis" }],  // latestBasis: '최신'을 쓴 경우의 날짜 근거
      "excludedHooks": [{ "text", "reason" }],  // 규칙 위반으로 제외한 문구
      "warnings": [], "reasoning"
    }
  },
  "runs": [ { "id", "kind", "status", "progress": [], "error", "startedAt", "finishedAt" } ],  // 최신순
  "question": {            // 열린 질문이 없으면 null
    "id", "version", "kind", "question",
    "options": [{ "label", "description" }],
    "recommended", "recommendationReason", "allowFreeText"
  }
}
```

화면의 추천 표시는 사용자의 답이 아닙니다. 추천 선택지는 미리 선택된 상태로 보이지 않습니다.
