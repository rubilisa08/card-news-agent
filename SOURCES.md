# 출처 기준

카드뉴스의 내용은 출처에서 그대로 옵니다. 이 앱은 **널리 알려지고 신뢰도가 높은 곳에서 확인된 내용만** 카드에 씁니다. 검증되지 않은 정보 때문에 오해가 생기지 않게 하려는 것입니다(사용자 원칙, 2026-10-24).

이 문서는 앱이 출처를 어떻게 나누고, 어떤 언론사를 어떤 등급으로 보고, 어디서 찾는지를 정리합니다. 등급 목록의 실제 값은 [src/sourceTrust.ts](src/sourceTrust.ts)에, 꼭 찾는 언론사 목록은 [src/outlets.ts](src/outlets.ts)에 있습니다. 목록을 바꿀 때는 코드와 이 문서를 함께 고치세요.

## 1. 출처 등급 4가지

| 등급 | 화면 꼬리표 | 무엇인가 | 카드에 쓸 수 있나 |
|---|---|---|---|
| 공식 | 공식 | 회사·기관이 직접 낸 발표(공식 블로그·뉴스룸·보도자료·정부 사이트) | 예 (가장 우선) |
| 주요 언론 | 주요 언론 | 널리 알려진 통신사·신문·방송 | 예 |
| 전문 매체 | 전문 매체 | 특정 분야 전문 매체, 연구 자료, 연예·경제 온라인 매체 | 다른 출처와 함께일 때만 |
| 확인 필요 | 확인 필요 | 위 목록에 없는 곳(요약·추적 사이트, 블로그, SNS, 처음 보는 사이트, 공식 이름을 흉내 낸 주소 등) | 후보로는 보이지만, 그 출처에만 있는 내용은 카드에 사실로 쓰지 않음 |

앱이 등급에 따라 하는 일:
- **후보 고르기:** 공식이나 주요 언론 출처가 하나도 없는 소식도 후보로 보여 주고 고를 수 있습니다. 다만 후보에 **"출처 확인 필요"** 꼬리표가 붙고, 불확실성에 그 사실이 적힙니다(2026-10-24 사용자 요청으로 "보류" 대신 표시만 하기로 바꿈).
- **심층 조사:** "확인 필요" 출처에만 있는 내용은 사실로 쓰지 않고 "한계·미확인"으로 옮깁니다.
- **내보내기 검사:** 카드 출처가 모두 "확인 필요"면 실패로, 전문 매체뿐이면 "확인 못 함"으로 표시합니다.
- **화면:** 모든 출처 앞에 등급 꼬리표가 붙습니다.

주소는 도메인 끝까지 정확히 맞아야 같은 곳으로 봅니다. 예를 들어 `news.jtbc.co.kr`은 JTBC(주요 언론)로 보지만, `evil-openai.com`이나 `openai.com.fake.io`는 "확인 필요"입니다.

## 2. 주요 언론

### 한국
| 구분 | 언론사 (도메인) |
|---|---|
| 통신사 | 연합뉴스 (yna.co.kr, yonhapnews.co.kr), 뉴시스 (newsis.com), 뉴스1 (news1.kr) |
| 종합 일간지 | 조선일보 (chosun.com), 중앙일보 (joongang.co.kr), 동아일보 (donga.com), 한겨레 (hani.co.kr), 경향신문 (khan.co.kr), 한국일보 (hankookilbo.com), 서울신문 (seoul.co.kr), 국민일보 (kmib.co.kr), 세계일보 (segye.com), 문화일보 (munhwa.com), 내일신문 (naeil.com) |
| 경제지 | 매일경제 (mk.co.kr), 한국경제 (hankyung.com), 서울경제 (sedaily.com), 이데일리 (edaily.co.kr), 머니투데이 (mt.co.kr), 파이낸셜뉴스 (fnnews.com), 헤럴드경제 (heraldcorp.com), 아시아경제 (asiae.co.kr), 아주경제 (ajunews.com) |
| IT 일간지 | 전자신문 (etnews.com), 지디넷코리아 (zdnet.co.kr), 디지털타임스 (dt.co.kr) |
| 방송 | KBS (kbs.co.kr), MBC (imbc.com, mbc.co.kr), SBS·SBS Biz (sbs.co.kr), YTN (ytn.co.kr), JTBC (jtbc.co.kr), MBN (mbn.co.kr), 채널A (ichannela.com), TV조선 (tvchosun.com), 연합뉴스TV (yonhapnewstv.co.kr), 한국경제TV (wowtv.co.kr), 머니투데이방송 MTN (mtn.co.kr), CBS 노컷뉴스 (nocutnews.co.kr) |
| 인터넷 신문 | 오마이뉴스 (ohmynews.com) |
| 지역 일간지 | 부산일보 (busan.com), 국제신문 (kookje.co.kr), 매일신문 (imaeil.com) |
| 스포츠 일간지 | 스포츠조선 (sportschosun.com, sports.chosun.com), 스포츠서울 (sportsseoul.com), 일간스포츠 (isplus.com), 스포츠경향 (sports.khan.co.kr), 스포츠동아 (sports.donga.com) |
| 영문판 | 코리아헤럴드 (koreaherald.com), 코리아타임스 (koreatimes.co.kr), 코리아중앙데일리 (koreajoongangdaily.joins.com) |

### 해외
로이터 (reuters.com), AP (apnews.com), 블룸버그 (bloomberg.com), 파이낸셜타임스 (ft.com), 월스트리트저널 (wsj.com), 뉴욕타임스 (nytimes.com), 워싱턴포스트 (washingtonpost.com), 가디언 (theguardian.com), BBC (bbc.com, bbc.co.uk), CNBC (cnbc.com), CNN (cnn.com), 이코노미스트 (economist.com), 악시오스 (axios.com), 디인포메이션 (theinformation.com), 더버지 (theverge.com), 테크크런치 (techcrunch.com), 와이어드 (wired.com), 아스테크니카 (arstechnica.com), MIT 테크놀로지 리뷰 (technologyreview.com), 엔가젯 (engadget.com), 벤처비트 (venturebeat.com), ZDNet (zdnet.com), 포브스 (forbes.com), 비즈니스인사이더 (businessinsider.com), 포천 (fortune.com), 닛케이 (nikkei.com, asia.nikkei.com), 사우스차이나모닝포스트 (scmp.com), NPR (npr.org), 폴리티코 (politico.com), 타임 (time.com)

## 3. 공식

- **AI·기술 회사:** 오픈AI, 앤트로픽(anthropic.com, claude.com), 구글(blog.google, cloud.google.com, research.google, deepmind.google 등), 메타(about.fb.com, ai.meta.com, meta.com, 투자자 사이트 atmeta.com), 마이크로소프트(microsoft.com, microsoft.ai), 엔비디아, 애플, 아마존·AWS, xAI, 딥시크, 미스트랄, 미니맥스, 문샷(kimi.com), 알리바바 클라우드·큐원, IBM, 인텔, AMD, TSMC, Arm, 퀄컴, 코히어, 퍼플렉시티, 허깅페이스 블로그(huggingface.co/blog)
- **한국 회사:** 삼성, SK하이닉스, LG, 네이버, 카카오, 업스테이지, KT, SK텔레콤
- **공공기관:** 미국 백악관·의회·NIST·FTC, EU, 영국 정부, 과학기술정보통신부(msit.go.kr), 대한민국 정책브리핑(korea.kr), OECD, UN. 주소가 `.gov`·`.go.kr`·`.gov.uk`·`.europa.eu`로 끝나는 정부 사이트도 공식으로 봅니다.
- **보도자료 배포처:** 비즈니스와이어, PR뉴스와이어, 글로브뉴스와이어(회사가 직접 쓴 글을 그대로 싣기 때문)

## 4. 전문 매체

- **AI·IT 전문:** AI타임스(aitimes.com, aitimes.kr), 블로터, 바이라인네트워크, 디지털데일리, 디지털투데이, ITWorld, CIO코리아, 더디코더, 더레지스터, 실리콘앵글, 탐스하드웨어, 아난드테크, 넥스트거브, 페드스쿱, 서치엔진랜드, InfoQ, 세마포, 9to5Mac, 9to5Google, 맥루머스, 안드로이드어소리티
- **연구·코드:** arXiv, 네이처, 사이언스, 깃허브, 허깅페이스
- **경제 온라인:** 뉴스핌, 아이뉴스24, 이투데이, 이코노미스트(economist.co.kr), 비즈워치, 뉴스웨이
- **연예·라이프:** OSEN, 엑스포츠뉴스, 마이데일리, 텐아시아, 뉴스엔, TV리포트, MHN스포츠, 스타뉴스, 에스콰이어 코리아, 마리끌레르 코리아

## 5. 꼭 찾는 언론사 11곳

사용자 요청에 따라 주제마다 아래 11곳을 따로 찾습니다. 조사 결과 화면에 언론사별로 후보 몇 개에 들어갔는지 나오고, 찾지 못한 곳은 안내 문구에 이름이 적힙니다.

| 언론사 | 찾는 방법 |
|---|---|
| SBS 뉴스, 한국경제, 서울신문, 경향신문, 한국일보, 머니투데이 | 그 언론사 사이트 안에서 직접 검색 |
| 중앙일보, 조선일보, 동아일보, 매일경제, 한겨레 | 구글 뉴스 목록으로 찾기 (사이트가 검색 도구 접근을 막음) |

**막힌 5곳의 한계:** 이 신문들의 사이트는 앱이 열 수 없습니다. 그래서 구글 뉴스 목록에서 제목·언론사·게시 시각만 확인하고, 그 기사로는 제목에 드러난 내용과 날짜까지만 근거로 씁니다. 출처 링크(news.google.com)를 누르면 원문으로 이동하니 직접 확인할 수 있습니다. 다음 뉴스에 같은 기사가 실려 있으면 그 기사를 열어 본문을 확인합니다(2026-10-24 확인).

## 6. 찾는 순서

1. **넓게 훑기:** 구글 뉴스에서 주제로 조사 기간 안 기사를 먼저 받습니다. 제목에 주제어가 없고 본문에만 있는 기사도 이렇게 잡힙니다. 예: "한정선" 조사에서 서울경제·파이낸셜뉴스 기사는 제목에 "한정선"이 없었습니다.
2. **더 찾기:** 웹 검색으로 검색어를 바꿔 가며 더 찾습니다. 주제어만이 아니라 관련 현상·상품 말로도 검색합니다.
3. **11곳 따로 찾기:** 위 5번 표대로 찾습니다.
4. **묶기:** 같은 소식을 다룬 기사는 후보 하나로 묶습니다(후보마다 출처 최대 8개). 공식 발표가 있으면 출처 맨 앞에 둡니다.
5. **전체 목록:** 조사 기간 안에서 찾은 주제 관련 기사는 후보로 고르지 않은 것까지 "찾은 기사 N건 모두 보기"에 등급·날짜·언론사와 함께 보여 줍니다(최대 80건).

## 7. 출처는 한국어가 기본

- 한국 언론 기사는 한국어판 주소를 씁니다. 영문판은 한국어판을 찾지 못했을 때만 씁니다.
- 같은 소식에 한국어 기사와 외국어 기사가 있으면 한국어 기사를 앞에 둡니다(공식 발표는 맨 앞).
- 출처 제목은 한국어로 옮겨 보여 주고, 외국어 원문이면 끝에 "(영문)"처럼 표시합니다. 발행처도 한국어 이름으로 씁니다.

## 8. 알아 둘 제약

- 이 환경의 검색 도구는 로이터, 더버지, 와이어드, 연합뉴스, FT, WSJ, 폴리티코, 비즈니스인사이더와 위 막힌 신문 5곳에 들어가지 못합니다. 이런 곳은 다른 공식 발표나 주요 언론으로 대신 확인합니다.
- CNBC·오픈AI 등 일부 페이지는 본문 열람이 막혀(403) 검색 요약으로만 확인될 때가 있습니다.
- 등급은 주소(도메인)만 보고 정합니다. 주요 언론의 기사라도 칼럼·광고성 기사일 수 있으니, 카드에 쓰기 전에 출처를 열어 한 번 확인하세요.

## 9. 목록 바꾸는 법

1. [src/sourceTrust.ts](src/sourceTrust.ts)에서 `OFFICIAL`(공식), `MAJOR`(주요 언론), `TRADE`(전문 매체) 중 맞는 곳에 도메인을 넣습니다. `www.`는 빼고, 하위 주소는 자동으로 포함됩니다(예: `chosun.com`이면 `sports.chosun.com`도 포함).
2. 꼭 찾는 언론사를 바꾸려면 [src/outlets.ts](src/outlets.ts)의 `REQUIRED_OUTLETS`를 고칩니다.
3. 이 문서의 표도 함께 고칩니다.
4. 서버를 다시 켭니다. 이미 조사한 프로젝트의 꼬리표는 화면을 새로 열면 새 목록으로 다시 계산됩니다.

결정 기록: [DECISIONS.md](DECISIONS.md)의 B36(등급), B38·B39·B42(꼭 찾는 언론사), B41(한국어 출처), B43(넓게 훑기·주요 언론 확대).
