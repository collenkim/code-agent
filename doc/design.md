# code-agent 설계 — Claude Code 위에서 도는 코드 작성 에이전트

> 이 문서가 정본이다 (2026-09-29). README 는 여기를 가리킨다.
> 표의 **상태** 열에서 `P3 ✅` 는 지금 구현돼 도는 것, 번호만 있는 것(`P4`)은 그 단계에서 만들 것이다. 단계는 11장.

## 1. 역할

**code-agent 는 요구사항을 받아 코드를 쓰는 에이전트다.** 그 밖의 일은 하지 않는다.

| 한다 | 하지 않는다 |
|---|---|
| 요구사항 분석, 모호한 점 질문 | 아이디어 발굴·시장 조사 (AI-DLC Ideation) |
| 필요한 문서 확인, 없으면 작성 유도 | 배포·인프라·관측 (AI-DLC Operation) |
| 개발 계획, 문서와 참조 코드를 읽고 코드·테스트 작성 | 유료 도구를 등록 없이 쓰는 것 |
| 검증하고 더 나은 방향으로 고쳐 쓰기 | 사람 대신 승인하는 것 |

실행 틀은 AI-DLC 와 같다 — **Claude Code 안에서 모델이 도구를 직접 쓴다.** 규칙은 스킬(`.claude/skills/ca-*`)과
서브에이전트 정의(`.claude/agents/ca-*`)로, 강제는 PreToolUse hook 과 `code-agent` CLI(`src/agent/`)로 한다.
다른 점은 AI-DLC 가 사후에 대조하는 것을 **쓰기 전에** 막는다는 것, 그리고 읽을 참조 코드를 **코드가** 고른다는 것이다.

## 2. 문서 모델

문서가 근거다. 없는 문서는 모델이 지어내는 자리가 된다. 그렇다고 모든 문서를 미리 요구하면 레거시에서는 시작조차 못 한다.
그래서 **세 층**으로 나눈다 — 막는 것, 자라는 것, 작업마다 만드는 것.

| 층 | 문서 | 코드가 보는 것 | 승인 해시 | 언제 쓰나 |
|---|---|---|---|---|
| **공통 POLICY** | 아키텍처 · 코드 컨벤션 · 테스트 전략 · 품질·보안 기준 | 파일 + 필수 섹션 + **사람 확정** | 예 (`projectDocsHash`) | 도입에 한 번, 작업 도중 변경 불가 |
| **공통 KNOWLEDGE** | 데이터 사전 · API 목록 · 업무 규칙·용어집 | **파일 존재만** | 아니오 | 도입에 빈 뼈대, 반영마다 그 작업 범위만 자란다 |
| **작업 문서** | `doc/work/<ID>/` 의 12개 | 문서마다 다르다 (아래 2.4) | 6개만 (`workDocsHash`) | 작업마다 |

**막는 것은 POLICY 4개뿐이다.** KNOWLEDGE 는 비어 있어도 작업을 막지 않는다 — 막으면 첫 도입에서 아무 작업도 시작되지 않는다.

### 2.1 공통 POLICY — 확정 전에는 작업이 시작되지 않는다 (P2 ✅ 2종 · P4 ✅ 2종)

| 문서 | 기본 경로 | 필수 섹션 (코드가 검사) |
|---|---|---|
| **아키텍처** | `doc/architecture.md` | 기술 스택 · 모듈/패키지 구조 · 계층과 책임 · 의존 방향 · 공통 모듈 · 주요 결정 |
| **코드 컨벤션** | `conventions[]` (기본 `doc/conventions.md`) | 명명 · 계층별 규칙 · 예외 처리 (`테스트 규칙`·`포매팅` 은 선택) |
| **테스트 전략** | `doc/test-strategy.md` | 수준과 범위 · 도구와 실행 명령 · 통과 기준 |
| **품질·보안 기준** | `doc/quality.md` | 정적 분석 · 보안 검사 · 통과 기준과 반영 차단 |

통과 조건 — 넷 다 셋을 만족해야 `start` · `next` · `plan submit` · `approve` 가 열린다 (`requireDocs`).

1. **파일이 있다** — `code-agent.json` 의 `docs.*` · `conventions`. 등록이 없으면 기본 경로. 컨벤션은 디렉토리여도 된다(그 아래 `.md` 전부)
2. **필수 섹션이 있고 비어 있지 않다** — 섹션·별칭은 `schemas.ts` 가 정한다. 제목의 번호와 뒤에 붙은 괄호 설명은 가리지 않는다.
   **`확인 필요` 만 남은 필수 섹션은 채워지지 않은 것이다.** 내용 옆의 `확인 필요` 는 막지 않고 미결 줄 수로 세어 확정하는 사람에게 보인다
3. **사람이 확정했다** — `code-agent confirm doc <종류>`(터미널)가 문서 해시를 `.code-agent/approvals/docs.jsonl`(해시 사슬)에 남긴다. 줄바꿈(CRLF/LF)만 바뀐 것은 바뀐 것으로 보지 않는다

**명령 이름 대조** — 테스트 전략의 `도구와 실행 명령`, 품질·보안 기준의 `정적 분석`·`보안 검사` 는 첫 목록의 백틱 이름(``- `unit`: …``)이
매니페스트의 `build`·`test`·`commands` 키에 실재해야 한다. 없으면 섹션 미충족으로 막는다. `verifyByBuild` 는 명령이 없으면
`passed:true · outcome:"not-run" · skipped:true` 로 돌려주므로, 이 대조가 없으면 **"테스트를 돌렸다"는 보고가 아무것도 돌리지 않은 결과 위에 선다.**
`없음` 만 적힌 갈래는 대조하지 않는다 — 자동 검사가 없는 것은 사실일 수 있고, 거짓말이 되는 것은 '있다고 적고 돌지 않는' 쪽뿐이다.

**경계** — 아키텍처의 `주요 결정` 은 *어떤 방식을 쓰는가*, 품질·보안 기준은 *무엇을 어기면 막는가*.
컨벤션의 `테스트 규칙` 은 *테스트 코드를 어떻게 쓰나*(위치·이름·TC id 표기), 테스트 전략은 *수준·명령·통과 기준*.

**문서 작성 세션** — `/ca-docs` · `/ca-adopt` 가 `code-agent docs begin` 으로 열고, 그동안 hook 이 문서 자리(`doc/`, 등록된 문서, `code-agent.json`) 밖 쓰기를 막는다.
작업이 진행 중이면 세션을 열지 않는다 — 근거 문서는 작업 도중에 바꾸지 않는다.

### 2.2 공통 KNOWLEDGE — 비어서 시작하고 반영마다 자란다 (P4 ✅ 생성 · P5 갱신)

| 문서 | 경로 | 항목 키 | 무엇이 쌓이나 |
|---|---|---|---|
| **데이터 사전** | `doc/knowledge/data-dictionary.md` | ``### `ORDER_ITEM` 이름`` | 엔티티·필드·제약·코드값 |
| **API 목록** | `doc/knowledge/api-catalog.md` | ``### `GET:/api/orders/{id}` 이름`` | 접점 계약·인증·오류 코드 |
| **업무 규칙·용어집** | `doc/knowledge/business-rules.md` | ``### `BR-ORDER-01` 규칙`` · 용어 표 | 사람의 답에서만 오는 것 |

- **게이트는 파일 존재뿐이다.** 섹션 검사도, `확인 필요` 미결 표시도, 원장 확정도 없다. 뼈대에 `확인 필요` 를 넣지 않는다 — 막지 않는 문서에 미결 표시를 남기면 영원히 지워지지 않는다.
- **승인 해시에 넣지 않는다.** 넣으면 다른 작업의 반영마다 남의 승인이 stale 이 되어 병렬 작업이 막힌다.
  대신 **작업 문서가 전제를 들고 간다** — 03·04 는 인용한 항목의 키와 *그것에 기대는 사실 한 줄*을 옮겨 적고 그 뒤에 차이를 쓴다.
  그 한 줄은 `workDocsHash` 에 이미 들어가므로 승인의 근거는 옮겨 적은 줄이 덮는다. (항목 단위 해시는 인용 파서가 필요해 P6 으로 미룬다.)
- **쓰는 것은 반영(deliver)뿐이다.** 모델이 직접 쓰지 않는다 — 작업 중에는 hook 이 작업 폴더 밖 쓰기를 막으므로 제안은 `doc/work/<ID>/knowledge.proposal.md` 에 쓰고,
  `code-agent deliver` 가 TTY 에서 diff 를 보여 준 뒤 **코드가** 키로 upsert 한다(정렬 고정 — 매번 diff 가 흔들리지 않게).
  **삭제는 적용하지 않는다** — 자동 삭제는 되돌릴 근거가 없다. 같은 키에 다른 내용이 오면 조용히 덮지 않고 양쪽을 나란히 보여 준다.
- 적용마다 `그 작업의 R 번호 1개 이상`을 요구한다 — 이것이 "한 작업의 범위만 자란다"를 코드로 강제하는 자리다.

### 2.3 역공학은 두 층이다

| 층 | 범위 | 언제 | 산출물 | 상태 |
|---|---|---|---|---|
| **뼈대 역공학** | 프로젝트 전체를 **얕게** — 빌드 파일·디렉토리·계층별 표본·**도구 후보**(테스트·린터·보안 의존성, CI 설정) | 도입에 한 번 | POLICY 4종 초안 + KNOWLEDGE 목록 초안(상한 30·40개) | P2 ✅ / P4 ✅ |
| **요구사항 범위 역공학** | 요구사항이 닿는 코드만 **깊게** | 작업마다 | 02 분석 보고서 · 03 기술 설계 | P3 ✅ / P4 ✅ |

전체를 깊게 분석하는 층은 두지 않는다 — 그 자리를 KNOWLEDGE 가 **반영마다 조금씩** 대신한다.
요구 항목이 닿는 키가 이미 KNOWLEDGE 에 있으면 explorer 를 붙이지 않고 인용한다(토큰이 줄어드는 자리).

### 2.4 작업 문서 — `doc/work/<ID>/`

번호 붙은 파일은 **모델·코드 산출물**이고, `requirement.md` 는 **사람 입력**이다. 그 구분을 이름이 지고 있어 `00-` 을 붙이지 않는다.

| 문서 | 스테이지 | 누가 쓰나 | 코드가 보는 것 (게이트) | 승인 |
|---|---|---|---|---|
| `requirement.md` | 1 시작 전 | **사람** (hook 이 모델 쓰기 거부) | 머리말 규격만 | 머리말=orderHash, **본문=docsHash** |
| `questions.md` | 전 구간 | 모델이 묻고 사람이 답 | `[Answer]:` 가 비면 전환 거부 | — |
| `01-requirements.md` ① | 2 `analysis` | 모델 (ca-analyst) | `## R<n>` 1개 이상·중복 없음 · 각 R 에 `근거:` · `## 가정` 존재 | ✔ |
| `02-analysis.md` ② | 3 `impact` | 모델 (explorer→writer) | 필수 3섹션 + **`영향 범위` 표 첫 열에 모든 R** | ✔ |
| `03-design.md` ③ | 4~5 `design` | 모델 (ca-writer) | 필수 5섹션이 filled 또는 `해당 없음 — <근거>` | ✔ |
| `04-functional.md` ④ | 4~5 `design` | 모델 (ca-writer) | 필수 4섹션 · AC 중복 없음 · **R 마다 AC 1개 이상** | ✔ |
| `plan.json` ⑤ | 6 `plan` | 모델 → `plan submit` | 스키마 · R 커버리지 · openQuestions 0 · preserve 전량 · 경로 경계 | planHash |
| `05-plan.md` ⑤ | 6 `plan` | **코드** (렌더) | 없음 — 파생물. hook 이 모델 쓰기 거부 | — (planHash 가 덮는다) |
| `07-test-spec.md` ⑦ | 6 `plan` | 모델 (구현 전) | TC 표 파싱 · AC 실재 · **모든 AC 가 TC 에 덮임** | ✔ |
| `08-validation.md` ⑧ | 8~9 · 12 | **코드만** (hook 거부 + 재렌더 대조) | base·부분 트리 해시·planHash 일치 · 선언된 검증 전부 `passed` | 역방향 |
| `09-review.md` ⑨ | 11 `review` | 모델(지적) + 코드(회차 머리) | **마지막 회차 트리 해시 == 지금 트리** · `계획 안`+`열림` 0 | 트리 해시 |
| `10-pr.md` ⑩ | 13 `deliver` | 코드(추적표·검증 블록) + 모델(나머지) | 추적표 빈 칸 0 · 코드 블록 재렌더 바이트 대조 · **사람 TTY 확인** | — |

(⑥ Code 는 소스 코드 자체다 — `06-` 파일은 없다.)

**작업 문서는 따로 확정받지 않는다. 계획과 한 묶음으로 승인된다.**

```
docsHash        = sha( projectDocsHash + "\n" + workDocsHash )
projectDocsHash = POLICY 4종의 확정 해시
workDocsHash    = 고정 목록의 `경로:sha` — requirement.md 본문 · 01 · 02 · 03 · 04 · 07
```

목록이 **고정**인 것이 P4 의 변경점이었다. P3 에서는 `analysis.md` 의 `## 작업 문서` 가 부른 것만 담겼는데,
02·03·04 가 항상 필수가 되면서 그 판정이 사라졌다 — `## 작업 문서` 섹션과 `workDocProblems` 를 없앴고,
그 섹션이 열어 두던 "이미 있는 문서가 이 범위를 덮는다" 경로는 03 의 `해당 없음 — <근거>` 와 KNOWLEDGE 인용이 대신한다.

제외하는 것과 이유 — `05-plan.md`·`plan.json`(planHash 가 이미 덮는다) · `questions.md`(구현 중에도 쌓여 승인이 수시로 무효가 된다)
· KNOWLEDGE 3종(위 2.2) · `08`·`09`·`10`(승인 뒤 산출물이라 역방향으로 묶인다 — 증거가 어느 승인 아래에서 났는지를 적는다).

> **P4 도입으로 P3 때 받은 계획 승인은 전부 무효가 됐다.** POLICY 가 2 → 4 개가 되고 작업 문서 목록이 바뀌어 `docsHash` 계산식이 달라졌다.
> 진행 중이던 작업은 `stale-docs` 로 떨어져 재승인이 필요하다. 옛 형식으로 제출돼 있던 `plan.json`(`sequence`·`approach` 없음)은 `plan submit` 으로 다시 제출해야 한다.
> 매니페스트 쪽은 안전하다 — `hashManifest` 는 `stages`·`build`·`test`·`commands` 만 담고 `docs` 는 담지 않으므로 경로 등록이 늘어도 `stale-manifest` 는 나지 않는다.

### 2.5 문서를 만드는 세 경로

`/ca-docs` 가 문서마다 **기본으로 생성 / 대화로 생성 / 기존 문서 연결** 을 묻고, 추천을 함께 보여 준다. 끝에는 언제나 사람 확정이다.

| 경로 | 무엇을 하나 | 추천되는 문서 |
|---|---|---|
| **기본으로 생성** | `code-agent survey` + ca-surveyor 병렬 역공학. 모든 서술에 근거 경로. 코드로 알 수 없는 것은 POLICY 면 `확인 필요`, KNOWLEDGE 면 **빈칸** | 아키텍처 · 컨벤션 · 데이터 사전 · API 목록 |
| **대화로 생성** | `code-agent docs interview <종류>` 가 섹션별 질문과 선택지를 낸다. 한 번에 4개까지, 역공학으로 찬 것은 묻지 않는다. 모른다고 하면 `확인 필요` — 대신 정하지 않는다 | 업무 규칙·용어집(권장은 **비워 두기**) |
| **기존 문서 연결** | `code-agent docs link <종류> <경로...>` 로 경로만 등록. 섹션 검사는 똑같이 받고 모자란 섹션만 위 두 경로로 | 컨벤션이 이미 다른 곳에 있을 때 |

**테스트 전략·품질·보안 기준은 섞인다** — 도구·명령·위치는 빌드 파일과 CI 설정에서 읽히므로 *기본으로 초안*,
수준별 필수 여부·통과 기준·임계·차단 정책은 코드 어디에도 없으므로 *그 자리만 대화*.
업무 규칙은 반대다 — 역공학하면 구현 세부와 규칙을 가리지 못해 소음만 쌓이고, 도입 때 인터뷰로 캐면 도입이 무거워진다.
**작업마다 질문의 답으로 쌓이는 것이 그 문서의 정상 경로다.**

## 3. 스테이지

**목표 흐름** (2026-09-29 확정): 요구사항 → 요구사항 분석·명세화 → 영향도 분석 → 시스템 설계 → 기능·API·데이터 정의 → 구현 계획 →
코드 생성 → 정적 분석·컴파일 → 테스트 생성·실행 → 결과 분석 → (실패: 수정 → 정적 분석부터 다시 / 성공: 코드 리뷰 → 지적은 수정 루프로)
→ 통합 검증 → 반영·PR. 스테이지는 이 흐름을 그대로 딴다.

| # | 스테이지 (key) | 목표 흐름 | 하는 일 | 누가 | 게이트 | 상태 |
|---|---|---|---|---|---|---|
| 0 | 준비 | — | `init` 설치, 워크스페이스 감지 (신규/레거시, 필수 문서 유무) | CLI | — | P1 ✅ |
| 1 | 공통 문서 | — | POLICY 4종(아키텍처 · 컨벤션 · 테스트 전략 · 품질·보안 기준) 점검·작성, KNOWLEDGE 3종 빈 뼈대. 문서마다 기본으로 생성 / 대화로 생성 | CLI 점검 + surveyor·writer | **POLICY 넷 다 확정돼야 작업 시작** | P2 ✅ 2종 · P4 ✅ 2종 |
| 2 | 요구사항 분석 `analysis` | 요구사항 · 분석·명세화 | ① `01-requirements.md` — 요구 항목(`## R<n>`), 기본값은 `## 가정`, 모호·누락·충돌은 질문 | 메인 + analyst | 질문 · R 형식 | P4 ✅ (P3 의 `analysis.md`) |
| 3 | 영향도 분석 `impact` | 영향도 분석 | ② `02-analysis.md` — 기존 시스템 분석 · 영향 범위 · Risk (**항상**, 크기는 작업에 맞게) | 메인 + explorer × 영역 → writer | 질문 · 필수 섹션 · **영향 표에 모든 R** | P4 ✅ |
| 4 | 설계·정의 `design` | 시스템 설계 · 기능/API/데이터 정의 | ③ `03-design.md` — 구성 요소 · 처리 흐름 · API · 데이터 · 설계 결정 (해당 없으면 `해당 없음 — 근거`) + ④ `04-functional.md` — 기능 · 업무 규칙 · 예외 · 수락 기준(AC) | 메인 + writer | 질문 · 필수 섹션 · **R 마다 AC 1개 이상** | P4 ✅ |
| 5 | 구현 계획 `plan` | 구현 계획 수립 | ⑤ `plan.json` → 코드가 `05-plan.md` 로 렌더(변경 파일 · 작업 순서 · 구현 방법) + ⑦ `07-test-spec.md` — AC 마다 테스트 케이스 | 메인 → critic | **사람 승인 (터미널)** — 01~04 · 07 · requirement 본문 한 묶음 | P3 ✅ (`plan.json`) · ⑤ 렌더·⑦ P4 ✅ |
| 6 | 코드 생성 `implement` | 코드 생성 | ⑥ 계획의 단계마다 새 컨텍스트에서 | implementer (테스트 단계는 tester) | hook — 계획 밖 쓰기 거부 | P3 ✅ |
| 7 | 정적 분석·컴파일 `check` | 정적 분석·컴파일 | 품질·보안 기준이 적은 명령 + `build` 를 돌려 증거로 기록 → ⑧ `08-validation.md` (코드만 씀) | CLI | 코드 — `not-run` 은 통과가 아니다 | P5 |
| 8 | 테스트 `test` | 테스트 생성·실행 · 결과 분석 | tester 가 ⑦ 의 케이스만 작성 → CLI 가 실행 → ⑧ 에 케이스마다 한 줄 | tester + CLI | 코드 — ⑦ 전부 통과, 이후 테스트 동결 | P5 |
| ↺ | 수정 | 실패 → 수정 | 7·8·9 에서 나온 것 중 계획 안은 implementer 가 고치고 **7 부터 다시** (최대 N회, 넘으면 덮지 않고 보고). 계획 밖이면 질문 또는 재계획(재승인) | implementer | hook | P5 |
| 9 | 코드 리뷰 `review` | 성공 → 코드 리뷰 | ⑨ `09-review.md` — 회차 · 지적(계획 파일 경로) · 요구 충족. 지적은 수정 루프로 | reviewer | 열린 지적 0 · 마지막 회차 트리 해시 == 지금 | P5 |
| 10 | 통합 검증 `integrate` | 통합 검증 | 깨끗한 worktree(기준 커밋 + 변경 파일)에서 전체 build · 전체 test → ⑧ | CLI | 코드 | P5 |
| 11 | 반영 `deliver` | 반영·PR | ⑩ `10-pr.md` — 요약 · 추적표(R → AC → 파일 → TC → 검증) · 확인 방법 · 위험. KNOWLEDGE 갱신 제안을 하나씩 고른다 → **사람 최종 확인(터미널)** → 작업 브랜치에 로컬 커밋. push · PR 생성 · 병합은 사람 | 메인 + CLI | **사람 확인 (터미널)** | P5 |

**오늘 커서가 도는 자리** — `code-agent status` 가 보여 주는 스테이지는
`analysis → impact → design → plan → implement → verify` 다 (`src/agent/layout.ts` 의 `PHASES`).
P3 의 `research` 한 칸이 3·4(영향도·설계) 자리였고, P4 에서 `impact` · `design` 둘로 갈렸다.
커서는 `verify` 에서 끝난다 — `code-agent next` 는 `implement` 의 마지막 단계를 마치면 거기서 멈추고,
7~11 이 생기는 P5 까지 그 뒤는 없다.

**작업 종류**는 어떤 스테이지를 어떻게 도는지로 갈린다.

| 종류 | 스테이지 |
|---|---|
| `feature` | 1 (점검) → 2 → 3 → 4 → 5 → 6 → 7 ⇄ 8 ⇄ 9 (수정 루프) → 10 → 11 |
| `fix` | 같음. ② 의 기존 시스템 분석에 결함이 나는 경로까지, 결함을 재현하는 테스트를 먼저 쓰고 지금 코드에서 실패하는 것을 본 뒤 고친다 |
| `refactor` | 같음. ② 의 기존 시스템 분석 필수, 계획에 preserve 필수, 기존 테스트가 그대로 통과해야 한다 |

`fix` · `refactor` 의 종류별 강제(재현 테스트 먼저 · preserve)는 P6 이다. 지금은 스킬 지시로만 있다.
`code-agent start` 가 받는 것은 이 셋뿐이다. 도입은 작업이 아니라 `/ca-adopt` 가 하는 일이다 —
지시서를 쓰지 않고 0 → 1 만 돈다.

어느 작업이든 1 의 점검을 먼저 지난다. 필수 문서가 없으면 거기서 멈추고 작성으로 안내한다 —
`/ca-feature` 를 불렀더라도 `/ca-docs` 로 돌려보낸다.

### 질문은 어느 스테이지에서든 던진다

애매하거나 모호하면 지어내지 않고 묻는다. 질문은 작업 폴더의 `questions.md` 에 쌓이고, **답이 없는 질문이
있으면 다음 스테이지로 넘어가지 않는다** (`code-agent next` · `plan submit` 이 확인한다. 턴 끝에 보는 Stop hook 은 P5).

```
## Q3 · 요구사항 분석
주문 취소 후 재주문이 가능한가?
A. 가능 — 새 주문번호
B. 불가
X. 기타:
[Answer]:
```

**질문과 가정은 다르다.** 업무 규칙·범위·권한·데이터의 의미·다른 도메인과의 계약처럼 모델이 정하면 지어낸 것이 되는 것만
질문으로 막는다. 컨벤션·참조 코드·일반 관행으로 기본값을 댈 수 있는 기술 세부(이름·정렬·정밀도·테스트 케이스·범위 밖 부수 작업)는
① `01-requirements.md`(P3 까지는 `analysis.md`) 의 `## 가정` 에 근거와 함께 적고 진행한다. 가정은 승인 해시에 묶이고 `approve` 화면에 그대로 보여, 사람이 계획과
함께 한 번에 받아들이거나 반려한다. (실측: 가정 없이 "주문을 등록·조회한다" 한 줄에 질문 14개, 사람 왕복 3회가 쌓였다.)

**질문 하나에 결정 하나.** "필드와 제약", "조회 범위와 페이징" 처럼 묶으면 답이 한쪽만 다뤄 되묻게 된다.

답은 채팅으로 해도 된다 — 메인 에이전트가 파일에 옮긴다. 질문의 답은 승인이 아니므로 터미널을 요구하지 않는다.
**승인·확정만 터미널**이다 (모델 세션 안의 승인은 모델이 한 것과 구분되지 않는다).

### 수정 루프 (P5)

```
implement → check (build · commands 의 정적 분석 명령) → test (작성 · 실행 · 결과 분석)
   실패 → 계획 안이면 implementer 가 고치고 check 부터 다시 (최대 N회)
        → 계획 밖이면 질문 또는 재계획 (재승인)
   성공 → review (컨벤션 · 요구 충족 · 참조 코드와의 차이 · 설계 문서와의 불일치)
        → 지적도 같은 수정 루프로 들어간다
   N회 뒤에도 실패면 덮지 않고 보고한다 — 테스트 단언을 지워 통과시키는 길은 hook 이 막는다
→ integrate (깨끗한 worktree 에서 전체 build · test) → deliver (사람 확인 → 로컬 커밋 + 10-pr.md)
결과는 모두 ⑧ 08-validation.md 에 코드가 남기고, 리뷰는 ⑨ 09-review.md 에 회차로 쌓인다
```

## 4. 메인 에이전트와 서브에이전트

**메인 에이전트**는 사용자와 대화하는 Claude Code 세션 자체다. 스킬(`/ca-*`)을 따라 순서를 진행하고,
서브에이전트를 부르고, 결과를 합친다. 코드를 직접 많이 쓰지 않는다 — 메인 컨텍스트가 작아야 긴 작업이 버틴다.

| 서브에이전트 | 스테이지 | 도구 | 하는 일 | 상태 |
|---|---|---|---|---|
| `ca-surveyor` | 1 | 읽기 전용 | 뼈대 역공학 — 영역 하나(빌드·구조·계층 표본)를 맡아 근거 경로가 달린 분석. 여럿 병렬 | P2 ✅ |
| `ca-analyst` | 2 | 읽기 전용 | 요구 항목화, 모호·누락·충돌을 질문 후보로, 항목별 "데이터·접점을 건드리는가" 판정 | P3 ✅ |
| `ca-explorer` | 3 | 읽기 전용 | 요구사항 범위 역공학 — 닿는 영역 하나의 관련 파일·호출 경로·현행 데이터·API. 영역마다 병렬 | P3 ✅ · P4 부터 `impact` 에서 돈다 |
| `ca-writer` | 1, 4 | 쓰기 (문서 경로만) | 분석 결과·사용자 답을 문서 스키마 섹션에 맞춰 문서로 | P2·P3 ✅ |
| `ca-critic` | 5 | 읽기 전용 | 계획 반박 검토 — 빠진 요구 항목, 계획 밖 파일 필요성, 테스트 공백, 작업 문서와의 불일치 | P3 ✅ |
| `ca-implementer` | 6, ↺ | 쓰기 (hook 강제) | 단계 하나. `code-agent context` 로 받은 것만 읽고 시작 | P3 ✅ |
| `ca-tester` | 8 | 쓰기 (테스트 경로만) | 테스트 작성. 구현과 다른 컨텍스트라 구현을 베끼지 않는다 | P3 ✅ (오늘은 `implement` 의 테스트 단계) · 독립 `test` 스테이지는 P5 |
| `ca-reviewer` | 9 | 읽기 전용 | 컨벤션·요구사항 충족·참조 코드와의 차이. 고칠 목록만 낸다 | 정의만 · 스테이지는 P5 |

**2~5 스테이지의 흐름** — 서브에이전트를 가장 적극적으로 쓰는 곳이다.

```
[2 분석]  메인 + ca-analyst ── ① 01-requirements.md: 요구 항목 N개 · 가정 · 범위 밖 / 질문
            ↓ 질문 답변
[3 영향도] ca-explorer × 닿는 영역 (병렬) ── 관련 코드 · 호출 경로 · 현행 데이터·API · 공통 모듈 파급
           code-agent context ──────────── 참조 도메인의 단계별 표준 파일·컨벤션 (결정론적)
           KNOWLEDGE 에 키가 있으면 ────── explorer 없이 인용
            └─ 메인 + ca-writer → ② 02-analysis.md (기존 시스템 · 영향 범위 · Risk)
[4 설계]   메인 + ca-writer ── ③ 03-design.md (구성 요소 · 흐름 · API · 데이터 · 결정)
                               ④ 04-functional.md (기능 · 업무 규칙 · 예외 · AC)
            └─ 빈칸(확인 필요) → 질문 또는 가정 → 반영
[5 계획]   메인: ⑤ plan.json (단계·파일·담당 R·작업 순서·구현 방법) + ⑦ 07-test-spec.md (AC 마다 TC)
            └─ ca-critic ── 반박 → 메인이 반영하거나 질문으로
           code-agent plan submit ── 게이트 · 스키마 · R 커버리지 · AC→TC 커버리지 · preserve · 경로, 저장 · 05-plan.md 렌더
           사람: code-agent approve (터미널) ── 계획 + 01~04 · 07 · 지시서 본문 한 묶음
```

**단계 병렬** — 계획이 서로 파일을 공유하지 않는 단계를 표시하면, 메인이 implementer 를 병렬로 부른다.

서브에이전트는 **기본이 전부 상위 모델(opus)** 이다 — 탐색도 가벼운 모델로 내리지 않는다 (2026-09-29 결정: 품질 우선). 정의 파일마다 `model:` 을 박아 각자 PC 의 기본 모델에 맡기지 않는다. 사람은 `code-agent model <에이전트|all> <opus|sonnet|haiku>` 로 바꿀 수 있고(터미널에서만), 설정은 `.code-agent/models.json` 에 남아 다시 설치해도 유지된다. implementer 를 sonnet 으로 내릴지는 P5 실측(수정 횟수·비용)으로 정한다.
비용은 모델이 아니라 구조로 줄인다 — 읽을 참조 코드를 코드가 골라 주고, explorer 는 영역별로 묶고, critic 은 계획이 가리키는 것만 읽는다.

## 5. 강제 — 모델이 어겨도 막히는 것

| 무엇 | 어디서 | 시점 | 상태 |
|---|---|---|---|
| 프로젝트 필수 문서(아키텍처·컨벤션)가 없거나 미확정이면 작업 시작·스테이지 전환·계획 제출·승인 거부 | `start` · `next` · `plan submit` · `approve` (`requireDocs`) | 스테이지 전환 | P2 ✅ |
| 분석 결과(`analysis.md` 의 `## R<n>` 요구 항목 · `## 작업 문서`)가 없거나 형식이 틀리면 넘어가지 않음 | `code-agent next` (`requireAnalysis`) | 스테이지 전환 | P3 ✅ |
| 작업 문서가 분석 결과에 필요하다고 나왔는데 없거나 비었거나 필수 섹션이 비면 계획으로 못 가고, 제출도 거부 | `next` · `plan submit` (`workDocProblems`) | 계획 전 | P3 ✅ |
| 계획의 파일마다 담당 요구 항목(`files[].requirements`)이 있고, 모든 요구 항목이 어느 파일엔가 닿아야 제출 | `code-agent plan submit` | 계획 전 | P3 ✅ |
| 계획에 `openQuestions` 가 남아 있으면 제출 거부 | `code-agent plan submit` | 계획 전 | P3 ✅ |
| 승인 뒤 필수 문서·분석·작업 문서가 바뀌면 승인 무효 (`stale-docs`) | 승인 판정 (`approvalOf` · `approvalDocsHash`) | 매 쓰기 | P3 ✅ |
| 작업 지시서(`requirement.md`)는 모델이 고칠 수 없음 — 모호하면 질문으로 | PreToolUse hook | 쓰기 전 | P1 ✅ |
| 문서 작성 세션 중에는 문서 자리(`doc/`, 등록된 문서, `code-agent.json`) 밖 쓰기 금지 | PreToolUse hook | 쓰기 전 | P2 ✅ |
| 계획 승인 전(분석·조사·계획 스테이지) 작업 폴더 밖 쓰기 금지 | PreToolUse hook → `code-agent hook` | 쓰기 전 | P1 ✅ |
| 계획에 없는 파일, scope 밖, preserve, 계층 경계 | 같음 (코어 `checkPaths` · `unplannedFiles`) | 쓰기 전 | P1 ✅ |
| `.code-agent/` 상태·제출된 계획·원장 변조 | 같음 | 쓰기 전 | P1 ✅ |
| Bash 는 허용 목록만 (스킬이 부르는 `code-agent` 서브명령 — `init`·`abort`·`approve`·`reject`·`confirm`·`model` 은 사람 몫이라 뺀다, 매니페스트에 선언한 명령, 읽기용 git status·diff·log·show·branch — `-o`·`--output` 은 파일을 쓰므로 거부). 연결·리다이렉트(`;` `&&` `\|` `>`)는 거부 | 같음 | 실행 전 | P1 ✅ · P4 ✅ |
| 답 없는 질문이 있으면 진행 금지 | `code-agent next` · `plan submit` (`requireAnswers`) | 스테이지 전환 | P3 ✅ |
| 단계의 계획 파일이 실제로 생겼는지 확인해야 다음 단계 | `code-agent next` (`missingPlannedFiles`) | 스테이지 전환 | P3 ✅ |
| 승인·확정은 사람만 | `approve` · `reject` · `confirm doc` 의 TTY 검사 | 승인 시 | P1 ✅ |
| 승인은 무엇에 대한 것인가 | 원장 해시 사슬 — 지시서·계획·매니페스트·문서 | 매 쓰기 | P1 ✅ |
| POLICY 4종(테스트 전략 · 품질·보안 기준 추가) 확정 + 명령 이름이 매니페스트에 실재 | `start` · `next` · `plan submit` · `approve` | 스테이지 전환 | P4 ✅ |
| ②③④⑦ 이 없거나 게이트를 못 지나면 계획으로 못 가고 제출도 거부 — 영향 표에 모든 R · R 마다 AC · 모든 AC 가 TC 에 | `code-agent next` · `plan submit` | 계획 전 | P4 ✅ |
| `05-plan.md` · `08-validation.md` 는 코드만 쓴다 (모델 쓰기 거부 + 재렌더 대조) | PreToolUse hook · `next` | 쓰기 전 | P4 ✅ · P5 |
| 정적 분석을 통과해야 테스트로, 수정은 N회까지 | `check` · `test` 스테이지 | 스테이지 전환 | P5 |
| 답 없는 질문·계획과 실제 변경(`git diff`)을 턴 끝에 대조 | Stop hook | 턴 끝 | P5 |

경로는 실제 경로로 풀어 비교한다 (`canonical` — Windows 8.3 이름·junction·심볼릭 링크).
hook 은 사고 방지 장치이지 보안 경계가 아니다 — 개발자는 로컬 설정으로 끌 수 있다.

## 6. 플러그인과 도구 (P7)

**원칙: 무료로 되는 것은 등록 없이 쓰고, 유료는 사용자가 등록해야만 쓴다. 아무것도 없어도 전 과정이 돈다.**
등록은 **opt-in** 이다 — 등록하지 않은 사람에게는 기본 구현으로만 돈다.

### 자리(slot) — 플러그인이 끼는 곳

code-agent 코어가 자리를 정의하고, 자리마다 **기본 구현**이 있다. 플러그인은 자리를 대신 채울 뿐이다.

| 자리 | 쓰이는 곳 | 기본 구현 (등록 없이) | 예: 채울 수 있는 플러그인 |
|---|---|---|---|
| `survey.classify` | 1 뼈대 역공학 — 파일을 계층·컴포넌트로 분류 | 경로 규칙 + surveyor | Jev |
| `candidates.rank` | 3 영향도 분석, fix — 요구 항목과 관련된 파일 순위 | ripgrep + explorer | Jev, 코드 검색 서비스 |
| `review.prefilter` | 9 코드 리뷰 — 규칙 위반 의심 항목 | reviewer 가 전부 봄 | Jev |
| `context.docs` | 3~5 영향도·설계·계획 — 컨벤션·외부 문서에서 필요한 섹션 | 제목 매칭 | Jev, 문서 MCP |
| `code.index` | 1 · 3 — 심볼·호출 관계 | ripgrep | LSP 플러그인, 코드 인덱스 MCP |
| `verify.extra` | 7 정적 분석 — build/test 외 검사 | 매니페스트 `commands` 에 선언한 정적 분석 명령 (P5 의 `check` 가 돌린다) | 정적 분석 도구 |

### 등록

```
code-agent plugin list                  # 자리, 기본 구현, 감지된 무료 도구, 등록된 플러그인
code-agent plugin add jev               # 터미널에서 키 입력 → 사용자 설정(저장소 밖)에 저장
code-agent plugin remove jev
```

- **무료 도구**(ripgrep, LSP, 매니페스트에 선언한 linter)는 설치돼 있으면 자동으로 쓴다.
- **유료 도구**는 `plugin add` 로 키를 등록해야만 켜진다. 키는 `~/.code-agent/credentials.json` 에만 있고
  저장소에는 "어떤 플러그인을 쓰는 프로젝트인가"만 남는다. 외부로 코드를 보내는 플러그인은 등록 시 그 사실을 경고한다.
- 플러그인은 **명령 어댑터**다 — JSON 을 stdin 으로 받아 JSON 을 stdout 으로 낸다 (hook 과 같은 규약, 언어 무관).
  모델이 직접 써야 하는 도구(문서 조회 등)는 MCP 서버로 등록해 `.mcp.json` 에 넣는다.
- 판정 플러그인은 **CLI 가 부른다**, 모델이 아니라. 쓸지 말지를 모델이 정하면 그 판단에 토큰이 들고 결과가 흔들린다.
- 플러그인의 판정은 입력 요약·결과·임계값과 함께 `.code-agent/log/` 에 남는다. 실패하면 기본 구현으로 떨어지고 알린다.

## 7. 토큰

| 장치 | 효과 | 상태 |
|---|---|---|
| 역공학 두 층 — 뼈대는 얕게, 요구사항 범위만 깊게 | 큰 레거시에서 전체 분석 비용 제거 | P2·P3 ✅ |
| `code-agent context` — 스테이지에 필요한 참조 코드·컨벤션 경로·계획 조각만 | 탐색 제거 (스파이크: 첫 탐색이 `Glob **/*` 로 `.git` 까지 읽음) | P1 ✅ |
| CLAUDE.md 블록 10줄 안팎, 절차는 스킬 | 매 턴 고정 비용 최소 | P1 ✅ |
| 서브에이전트 새 컨텍스트 | 앞 스테이지 대화 누적 없음 | P1 ✅ |
| 메인은 코드를 읽지 않는다 — 작업 폴더 문서·`code-agent` 출력·서브에이전트 결과로만 | 메인 컨텍스트가 작아야 긴 작업이 버틴다 | P3 ✅ |
| explorer 를 요구 항목이 아니라 **닿는 영역별로** · critic 은 계획·분석·작업 문서·계획이 가리키는 파일만 | 같은 저장소를 여러 번 훑지 않는다 (실측: 요구 항목 5개에 explorer 5개가 각자 파일 20~28개를 읽어 조사+계획 $12.58) | P3 ✅ |
| 판정 플러그인 | 파일을 Claude 컨텍스트에 넣지 않고 분류·순위 | P7 |
| `code-agent usage` | 스테이지·에이전트별 토큰 집계 — 줄었는지는 숫자로 본다 | P8 |

## 8. 배포와 대상 저장소

```
npm install -g <사내 저장소>/code-agent     # 한 번 (단일 바이너리는 P8)
cd <프로젝트> && code-agent init             # 프로젝트마다 — .claude/ 설치, 버전 고정
claude  →  /ca-docs  →  (터미널) code-agent confirm doc architecture · conventions · test-strategy · quality
        →  /ca-feature doc/work/UZRF-145/requirement.md  →  (터미널) code-agent approve  →  /ca-next …
```

| 대상 저장소에 생기는 것 | 커밋 | 상태 |
|---|---|---|
| `CLAUDE.md` 의 code-agent 블록, `.claude/skills/ca-*`, `.claude/agents/ca-*`, `.claude/settings.json` 의 PreToolUse hook, `.code-agent/version` | O | P1 ✅ |
| `code-agent.json` (`docs.*` · `conventions` 에 문서 경로 등록, `git.base`, 단계 정의, build · test · commands) | O | P1 ✅ |
| 공통 POLICY — `doc/architecture.md` · `doc/conventions.md` (P2 ✅) · `doc/test-strategy.md` · `doc/quality.md` (P4) | O | P2 ✅ · P4 ✅ |
| 공통 KNOWLEDGE — `doc/knowledge/data-dictionary.md` · `api-catalog.md` · `business-rules.md`. 도입 때 빈 뼈대, 반영마다 자란다 | O | P4 ✅ 생성 · P5 갱신 |
| `doc/work/<ID>/requirement.md` — 작업 지시서. `<ID>` 는 Jira 키 그대로 (`UZRF-145`). **사람이 쓴다** | O | P1 ✅ |
| `doc/work/<ID>/questions.md` — 질문과 답 | O | P3 ✅ |
| `doc/work/<ID>/01-requirements.md` · `02-analysis.md` · `03-design.md` · `04-functional.md` — ①~④ (P3 의 `analysis.md` · `current.md` · `data.md` · `api.md` 를 흡수) | O | P4 ✅ |
| `doc/work/<ID>/plan.json` · `05-plan.md` · `07-test-spec.md` — ⑤ 계획(초안 + 코드 렌더) · ⑦ 테스트 명세 | O | P3 ✅ · P4 ✅ |
| `doc/work/<ID>/08-validation.md` · `09-review.md` · `10-pr.md` — ⑧ 검증(코드만) · ⑨ 리뷰 · ⑩ PR 본문·추적표 | O | P5 |
| `.code-agent/work/<ID>/<대상>.plan.json` · `<대상>.verify.json` — 제출된 계획 · 검증 증거. 코드만 쓴다 | O | P1 ✅ · P5 |
| `.code-agent/approvals/` — 확정·승인 원장 (해시 사슬) · 판정 스냅샷 | O (증거) | P1 ✅ |
| `.code-agent/models.json` — 에이전트별 모델 (바꾼 것만) | O | ✅ |
| `.code-agent/active.json`, `.code-agent/docs-session.json`, `.code-agent/log/` | X (`init` 이 `.gitignore` 에 넣는다) | P1 ✅ |

작업 폴더(`doc/work/<ID>/`)는 **모델과 사람이** 쓴다. `.code-agent/` 는 **코드만** 쓴다 — hook 이 모든 도구 쓰기를 막는다.

### 작업 브랜치

`code-agent start` 가 `<종류>/<ID>`(예: `feature/ORD-1`, `fix/BUG-3`)를 기준 브랜치에서 따서 옮긴다. 이미 있으면 전환만 한다.
기준 브랜치는 **사용자 입력(`--base`) > `code-agent.json` 의 `git.base` > `master`** 순이다. git 저장소가 아니면 브랜치를 만들지 않는다.
모델은 브랜치를 바꿀 수 없다 — hook 이 읽기용 git(status·diff·log·show, branch 는 목록 보기만)만 허용한다.

반영은 **로컬까지**다 — 사람 최종 확인(TTY) 뒤 작업 브랜치에 커밋하고 PR 본문을 `pr.md` 로 남긴다.
push · PR 생성 · 병합은 사람이 한다. GitHub 연동은 없다 (P5).

작업 문서 중 오래 쓸 가치가 있는 것(새 도메인의 데이터 정의 등)은 반영 스테이지에서 `doc/` 로 올릴지 묻는다.
레거시에 문서가 조금씩 쌓이는 길이 이것이다.

## 9. 명령

### Claude Code 안 (스킬)

| 스킬 | 하는 일 | 상태 |
|---|---|---|
| `/ca-docs [architecture \| conventions]` | 프로젝트 필수 문서 점검·작성 — 빠진 문서마다 역공학 / 사용자 입력 / 기존 문서 연결 중 고르게 한다 | P2 ✅ |
| `/ca-adopt` | 레거시 첫 도입 — 뼈대 역공학으로 문서와 `code-agent.json` 까지 | P2 ✅ |
| `/ca-feature <지시서> [--base <기준>] [--target <대상>]` · `/ca-fix` · `/ca-refactor` | 1 점검 → 2 → 3 → 4 → 5, 계획을 제출하고 승인 대기에서 멈춤 | P3 ✅ |
| `/ca-next` | 다음 스테이지·단계로 진행 | P3 ✅ |
| `/ca-answer` | 남은 질문을 하나씩 묻고 `questions.md` 에 기록 | P3 ✅ |
| `/ca-status` | 위치·막힌 이유·다음 할 일 | P1 ✅ |

### 터미널 (사람)

| 명령 | 하는 일 | 상태 |
|---|---|---|
| `code-agent init [--cli <경로>]` | 이 저장소에 설치 — `.claude/` 스킬·에이전트·hook, CLAUDE.md 블록, `.gitignore`, 버전 고정 | P1 ✅ |
| `code-agent status` | 문서·작업·스테이지·질문·승인 상태와 다음 할 일 | P1 ✅ |
| `code-agent docs` | 프로젝트 필수 문서 — 종류별 있음·섹션·확정 여부 | P2 ✅ |
| `code-agent confirm doc <architecture \| conventions>` | 프로젝트 필수 문서 확정 (해시를 원장에, TTY 에서만) | P2 ✅ |
| `code-agent approve` · `reject --comment <사유>` | 계획 + 작업 문서 판정 (계획·가정 표시, 반려 사유 필수, TTY 에서만) | P1 ✅ |
| `code-agent abort` | 진행 중인 작업 커서 지우기 (작업 폴더·계획·원장은 남는다) | P1 ✅ |
| `code-agent model [<에이전트\|all> <모델>]` | 에이전트별 모델 보기 · 바꾸기 (바꾸기는 TTY, 기본 opus) | ✅ |
| `code-agent usage` | 스테이지·에이전트별 토큰 집계 | P8 |
| `code-agent update` · `plugin list \| add \| remove` | 갱신 · 플러그인 등록 | P7·P8 |

### 스킬·hook 이 부른다

| 명령 | 하는 일 | 상태 |
|---|---|---|
| `code-agent start <지시서> [--target <대상>] [--base <기준 브랜치>]` | 작업 시작 — 문서 게이트 확인, 작업 브랜치, 작업 폴더 | P1 ✅ |
| `code-agent next` | 게이트를 확인하고 다음 스테이지·단계로 | P1 ✅ |
| `code-agent context` | 지금 스테이지에 필요한 것 — 경로 · 형식 · 참조 표준 코드 · 단계 규칙 | P1 ✅ |
| `code-agent plan submit <초안.json>` | 계획 검사 후 제출 | P1 ✅ |
| `code-agent docs begin \| end` | 문서 작성 세션 (도는 동안 문서 자리 밖 쓰기 금지) | P2 ✅ |
| `code-agent docs skeleton <종류>` | 빈 문서의 섹션 뼈대 — `architecture` · `conventions` · `data` · `api` · `current` | P2 ✅ |
| `code-agent docs interview <종류> [--sections a,b]` | 사용자 입력으로 채울 때 묻는 것 | P2 ✅ |
| `code-agent docs link <종류> <경로...>` | 이미 있는 문서를 등록 | P2 ✅ |
| `code-agent survey` | 뼈대 역공학용 저장소 개요 — 빌드·언어·구조·계층 후보·표본 | P2 ✅ |
| `code-agent manifest check` | `code-agent.json` 이 실제 참조 파일을 찾는지 | P2 ✅ |
| `code-agent hook` | PreToolUse 판정 (stdin JSON → deny 사유) | P1 ✅ |

## 10. core 재사용

`src/agent/` 가 쓰는 것은 `src/core/` 에 이미 있다. 다시 쓰지 않는다.

| 모듈 | 무엇을 | 누가 쓰나 |
|---|---|---|
| `core/approval.ts` | 승인 원장(해시 사슬) · `checkApproval` · `Presence` | `approve`·`reject`·hook·`next`·`status` 가 **같은 판정**을 쓴다 |
| `core/gate.ts` | `checkPaths` · `unplannedFiles` · `missingPlannedFiles` — scope·preserve·계층 경계·계획 밖 파일 | hook · `plan submit` · `next` |
| `core/manifest.ts` | `code-agent.json` 스키마 · `stagesFor` (종류별 단계) | 전부 |
| `core/plan.ts` | 계획 스키마 · `planFormatFor` · `formatPlan` · `missingPreserve` | `plan submit` · `context` · `approve` |
| `core/workOrder.ts` | 지시서 머리말 파싱 (kind·id·title·target·scope·preserve·approver) | `start` · `loadWork` |
| `core/exemplar.ts` | 참조 도메인의 단계별 표준 파일 수집·표시 | `context` |
| `core/atomic.ts` | 상태·계획 원자적 쓰기 | `layout` · `plan submit` |
| `core/types.ts` | `BuildPlan` 등 공용 타입 | 전부 |
| `core/build.ts` | 매니페스트의 `build` · `test` · `commands` 에 선언한 명령 실행 | `check` · `test` · `integrate` 스테이지 (P5) |

매니페스트는 넓힌다 — 지금은 "도메인 디렉토리 + 계층" 레이아웃을 전제하지만, 경계의 중심은 **승인된 계획의 파일 목록**이다.
계층 `outputDirs` 는 선언한 프로젝트에서만 추가로 건다. 그래야 레이아웃이 다른 프로젝트에서도 쓸 수 있다.

## 11. 구현 순서

| 단계 | 내용 | 완료 기준 | 상태 |
|---|---|---|---|
| P1 뼈대 | CLI(`init` `hook` `start` `context` `plan submit` `approve` `status` `next` `abort`), `.claude/` 템플릿(CLAUDE.md 블록·hook·스킬·에이전트 정의), 작업 폴더 구조, 작업 브랜치 | 스파이크 판정 13개를 테스트로 이관해 통과, 테스트 저장소에서 `init` → `/ca-status` | ✅ |
| P2 프로젝트 문서 | 문서 스키마(아키텍처·컨벤션), `code-agent docs`·`confirm doc`, `/ca-docs` 의 세 경로, 뼈대 역공학(`survey`·surveyor), `/ca-adopt` | 필수 문서 없는 저장소에서 진행이 거부되고, 레거시 1개는 뼈대 역공학으로·빈 저장소 1개는 인터뷰로 두 문서가 만들어져 게이트 통과 | ✅ |
| P3 분석·범위 조사·계획 | analyst(작업 문서 판정), explorer(범위 역공학), writer(작업 문서), critic, 질문·가정 갈래, 요구 항목 커버리지 검사 | 레거시 저장소에서 데이터 정의 없이 시작해 요구사항 범위 작업 문서가 생기고 승인 가능한 계획까지, 토큰 기준치 기록 | ✅ |
| P4 문서 모델 전환 + 영향도·설계 | **한 번에 전환한다.** POLICY 2 → 4(테스트 전략 · 품질·보안 기준 스키마, 명령 이름 대조, `/ca-docs` 의 기본/대화 선택, survey 의 도구 후보) · KNOWLEDGE 3종 경로 등록 + 빈 뼈대 · 작업 문서를 번호 문서로(01 ← analysis.md, 02 ← current.md + 영향도·Risk, 03 ← data.md · api.md + 구성 요소·흐름·결정, 04 신규, 07 신규, 05 렌더) · 스테이지 `research` → `impact` · `design` · 게이트(영향 표의 R 전량 · R 마다 AC · 모든 AC 가 TC 에) · 승인 묶음을 고정 목록(지시서 본문 · 01 · 02 · 03 · 04 · 07)으로 | 레거시에서 POLICY 4종을 확정하고, 공통 모듈을 건드리는 요구가 02 에 드러나고, 03·04 를 거쳐 07 이 모든 AC 를 덮은 계획이 승인된다. KNOWLEDGE 는 빈 채로 막지 않는다. P3 대비 토큰을 다시 잰다. **기존 계획 승인은 전부 무효가 된다** (docsHash 계산식이 바뀜) | ✅ |
| P5 구현·검증·반영 | ⑧⑨⑩ — `check` · `test`(⑦ 의 케이스만, 실행·결과 분석) · 수정 루프(`check` 부터, 최대 N회) · `review` · `integrate`(worktree) · `deliver`(TTY 확인 · 로컬 커밋 · 추적표 · KNOWLEDGE 갱신) · Stop hook. 엄격안 — 증거는 기준 커밋 · 부분 트리 해시에 묶이고 테스트는 첫 실행 뒤 동결 | 실제 프로젝트에서 feature 한 건을 반영까지 완주 (첫 실측) | |
| P6 fix·refactor · 신규 저장소 | 현행 분석 필수, 재현 테스트 먼저, preserve 강제, adopt 매니페스트의 종류별 단계, 빈 저장소의 매니페스트를 인터뷰로 | 각 한 건 완주, 빈 저장소에서 feature 시작 | |
| P7 플러그인 | 자리 정의, `plugin add/list/remove`, 무료 도구 감지, Jev 어댑터 — **등록한 사람만 opt-in** | Jev 켜고/끄고 같은 저장소 A/B 토큰 비교 | |
| P8 정리·배포 | 쓰이지 않는 코드·문서 정리, 문서 세트(README 가 이 문서를 가리킴), `usage`, 단일 바이너리 배포, 설치·점검 | 다른 개발자가 혼자 설치부터 반영까지 | |

**P3 실측 기준치** (2026-09-29, 가짜 레거시 — Spring, 도메인 3 × 계층 5, Java 23파일 · 지시서 "주문을 등록·조회한다" 한 줄 · 서브에이전트 전부 opus)

| 구간 | 비용 | 시간 | 결과 |
|---|---|---|---|
| 분석 | $1.10 | 5.6분 | 요구 항목 2 · 질문 3 · 가정 15 |
| 답 반영 | $1.97 | 11.5분 | 요구 항목 4 · 후속 질문 3 (묶인 질문에 한쪽만 답해 되물음) |
| 조사 · 작업 문서 · 계획 | $12.58 | 39분 | `data.md` · `api.md` · 계획 9파일. 공통 파일(ErrorCode)이 경계에 걸려 제출 거부 → 질문 2 |
| 재제출 | $2.06 | 7.5분 | 계획 제출 (common 단계 추가 후) |
| **합계** | **$17.71** | 64분 | 질문 8개 · 답하러 사람 왕복 3회 + 승인 |

$12.58 구간의 원인은 모델이 아니라 구조였다 — 요구 항목 5개마다 explorer 가 각자 파일 20~28개를 읽었고, critic 이 74턴 동안 37개를 다시 읽었다.
그 뒤 explorer 를 영역별로 묶고, `context` 가 참조 도메인의 단계별 표준 파일을 주고, critic 을 계획이 가리키는 것으로 제한했다. 개선 후 수치는 P4 실측에서 잰다.
