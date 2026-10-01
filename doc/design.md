# code-agent 설계 — Claude Code 위에서 도는 코드 작성 에이전트

> 이 문서가 정본이다 (2026-10-01). README 는 여기를 가리킨다.
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
| **작업 문서** | `doc/work/<ID>/` 의 14개 | 문서마다 다르다 (아래 2.4) | 6개만 (`workDocsHash`) + 지시서는 **접수 확정**(`request.jsonl`) | 작업마다 |

**막는 것은 POLICY 4개뿐이다.** KNOWLEDGE 는 비어 있어도 작업을 막지 않는다 — 막으면 첫 도입에서 아무 작업도 시작되지 않는다.

### 2.1 공통 POLICY — 확정 전에는 작업이 시작되지 않는다 (P2 ✅ 2종 · P4 ✅ 2종)

| 문서 | 기본 경로 | 필수 섹션 (코드가 검사) |
|---|---|---|
| **아키텍처** | `doc/architecture.md` | 기술 스택 · 모듈/패키지 구조 · 계층과 책임 · 의존 방향 · 공통 모듈 · 주요 결정 |
| **코드 컨벤션** | `conventions[]` (기본 `doc/conventions.md`) | 명명 · 계층별 규칙 · 예외 처리 (`테스트 규칙`·`포매팅·주석` 은 선택) |
| **테스트 전략** | `doc/test-strategy.md` | 수준과 범위 · 도구와 실행 명령 · 통과 기준 |
| **품질·보안 기준** | `doc/quality.md` | 정적 분석 · 보안 검사 · 통과 기준과 반영 차단 |

통과 조건 — 넷 다 셋을 만족해야 `start` · `next` · `plan submit` · `approve` 와 그 뒤의 `repro` · `check` · `test` · `review` · `integrate` · `deliver` 가 열린다 (`requireDocs`).

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
  그 한 줄은 `workDocsHash` 에 이미 들어가므로 승인의 근거는 옮겨 적은 줄이 덮는다.
  (**항목 단위 해시는 두지 않는다** — 인용을 기계로 읽는 파서가 필요하고, 옮겨 적은 줄이 이미 해시에 들어가 있다.
  대신 인용한 원본 항목이 승인 뒤에 바뀌어도 승인은 흔들리지 않는다 — 알고 남긴 선이다.)
- **쓰는 것은 반영(deliver)뿐이다 (P5 ✅).** 모델이 직접 쓰지 않는다 — 작업 중에는 hook 이 작업 폴더 밖 쓰기를 막으므로 제안은 `doc/work/<ID>/knowledge.proposal.md` 에
  (`## <종류>` 아래 ``### `키` 이름`` 블록으로) 쓰고, `code-agent deliver` 가 TTY 에서 항목마다 지금 것과 제안을 나란히 보여 준 뒤 **코드가** 키로 upsert 한다.
  **삭제는 적용하지 않는다** — 자동 삭제는 되돌릴 근거가 없다. 같은 키는 그 자리에서 갈아 끼우고(문서의 순서가 흔들리지 않게) 새 키만 끝에 붙는다.
- 적용마다 `그 작업의 R 번호 1개 이상`을 요구한다 — 이것이 "한 작업의 범위만 자란다"를 코드로 강제하는 자리다. 근거를 달지 않은 항목은 사람에게 묻지도 않고 걸러 사유를 알린다.

### 2.3 역공학은 두 층이다

| 층 | 범위 | 언제 | 산출물 | 상태 |
|---|---|---|---|---|
| **뼈대 역공학** | 프로젝트 전체를 **얕게** — 빌드 파일·디렉토리·계층별 표본·**도구 후보**(테스트·린터·보안 의존성, CI 설정) | 도입에 한 번 | POLICY 4종 초안 + KNOWLEDGE 목록 초안(상한 30·40개) | P2 ✅ / P4 ✅ |
| **요구사항 범위 역공학** | 요구사항이 닿는 코드만 **깊게** | 작업마다 | 02 분석 보고서 · 03 기술 설계 | P3 ✅ / P4 ✅ |

전체를 깊게 분석하는 층은 두지 않는다 — 그 자리를 KNOWLEDGE 가 **반영마다 조금씩** 대신한다.
요구 항목이 닿는 키가 이미 KNOWLEDGE 에 있으면 explorer 를 붙이지 않고 인용한다(토큰이 줄어드는 자리).

### 2.4 작업 문서 — `doc/work/<ID>/`

번호 붙은 파일은 **모델·코드 산출물**이다. `requirement.md` 도 이제 코드가 렌더한다 — 사람이 지는 것은 **원문**(`request.json` 에 그대로 보관)과
**터미널 확정** 둘이고, 그래서 이름만 번호 없이 남는다. `request.json` 은 그 지시서의 재료라 같은 자리에 둔다.

| 문서 | 스테이지 | 누가 쓰나 | 코드가 보는 것 (게이트) | 승인 |
|---|---|---|---|---|
| `request.json` | 접수 (시작 전) | 모델 (ca-request) | 스키마 · 원문은 `original`·`originalFile` 중 **정확히 하나** · `requirements` 1개 이상 · 머리말 값은 한 줄 · 예약 속성(`kind`·`id`·`title`·`target`·`scope`·`preserve`·`approver`)을 `extra` 에 못 씀 · `extra` 의 속성 이름은 머리말 파서의 규칙(`[A-Za-z][A-Za-z0-9_-]*`)대로 | — (렌더된 지시서가 확정된다) |
| `requirement.md` | 접수 (시작 전) | **코드** (`request submit` 이 `request.json` 에서 렌더 · hook 이 모델 쓰기 거부) | 손으로 쓴 지시서와 **같은** 지시서 규격 + 머리말 왕복 대조(옮긴 값이 그대로 읽히는가) | **사람 확정 (TTY)** — `approvals/<slug(ID)>/request.jsonl`. 그 뒤 머리말=orderHash, **본문=docsHash** |
| `questions.md` | 전 구간 | 모델이 묻고 사람이 답 | `[Answer]:` 가 비면 전환 거부 | — |
| `01-requirements.md` ① | 2 `analysis` | 모델 (ca-analyst) | `## R<n>` 1개 이상·중복 없음 · 각 R 에 `근거:` · `## 가정` 존재 | ✔ |
| `02-analysis.md` ② | 3 `impact` | 모델 (explorer→writer) | 필수 3섹션 + **`영향 범위` 표 첫 열에 모든 R** | ✔ |
| `03-design.md` ③ | 4 `design` | 모델 (ca-writer) | 필수 5섹션이 filled 또는 `해당 없음 — <근거>` | ✔ |
| `04-functional.md` ④ | 4 `design` | 모델 (ca-writer) | 필수 4섹션 · AC 중복 없음 · **R 마다 AC 1개 이상** | ✔ |
| `plan.json` ⑤ | 5 `plan` | 모델 → `plan submit` | 스키마 · R 커버리지 · openQuestions 0 · preserve 전량 · 경로 경계 | planHash |
| `05-plan.md` ⑤ | 5 `plan` | **코드** (렌더) | 없음 — 파생물. hook 이 모델 쓰기 거부 | — (planHash 가 덮는다) |
| `07-test-spec.md` ⑦ | 5 `plan` | 모델 (구현 전) | TC 표 파싱 · AC 실재 · **모든 AC 가 TC 에 덮임** | ✔ |
| `08-validation.md` ⑧ | 7~8 · 10 | **코드만** (hook 거부 + 재렌더 바이트 대조) | base·부분 트리 해시·manifestHash·planHash 일치 · 선언된 검증 전부 `passed` (`not-run`·`error` 는 통과가 아니다) | 역방향 (P5 ✅) |
| `09-review.md` ⑨ | 9 `review` | 모델(지적 표) + **코드(회차 구역)** | **마지막 회차 트리 해시 == 지금 트리** · `## 지적` 절 존재(지적이 하나도 없으면 그 안에 `- 없음`) · `열림` 0 · `계획 밖` 0 · 범위 칸이 계획과 일치 · 동결을 푼 지적 줄 삭제 불가(`review.json` 의 `used[]`) · 회차 구역 재렌더 바이트 대조 | 트리 해시 (P5 ✅) |
| `10-pr.md` ⑩ | 11 `deliver` | **코드(추적표·검증·변경 요약 구역)** + 모델(나머지) | 추적표 빈 칸 0 · 코드 구역 재렌더 · 코드 구역 제목(`추적표`·`검증`·`변경 요약`)이 구역 밖에 있으면 거부 · 모델 3섹션 filled · **사람 TTY 확인** | — (P5 ✅) |
| `knowledge.proposal.md` | 11 `deliver` 앞 | 모델 | 없음 — `## <종류>` 아래 ``### `키` 이름`` 블록. `deliver` 가 항목마다 지금 것과 나란히 보여 주고 사람이 고른 것만, 이 작업의 R 번호가 없는 항목은 거른다. 코드가 키로 upsert 하고 삭제는 하지 않는다 | — |

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

제외하는 것과 이유 — `request.json`(렌더된 `requirement.md` 본문이 이미 해시에 들어가고, 그 지시서는 따로 **접수 확정**에 묶인다)
· `05-plan.md`·`plan.json`(planHash 가 이미 덮는다) · `questions.md`(구현 중에도 쌓여 승인이 수시로 무효가 된다)
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

**신규(빈) 저장소** (P6 ✅) — 소스 파일이 하나도 없으면 역공학할 것이 없어 첫 경로가 통째로 빈다.
누가 세는지가 중요해서 **`code-agent survey` 가 판정한다** — 모델이 파일 수를 눈대중하면 실행마다 답이 달라진다.
소스가 0개면 survey 가 `소스 파일이 없습니다 — 신규(빈) 저장소입니다` 를 머리에 찍고 정할 목록(언어 · 소스 루트 · 단계 목록 ·
`build`·`test`·`prepare` · `git.base`)을 함께 낸다. 단, "소스 0개" 는 survey 가 아는 확장자로만 센 것이라 빌드 파일이 함께 없을 때만
그렇게 단정한다 — 빌드 파일이 있으면 `지원 목록 밖 언어입니다` 로 **무엇을 쟀는지** 적고, 스킬이 사람에게 확인한 뒤 갈라진다
(C·C++·Swift·Dart 로 가득 찬 저장소를 빈 저장소로 읽고 인터뷰로 가면, 역공학할 코드를 두고 참조 없는 매니페스트가 만들어진다). `/ca-adopt`·`/ca-docs` 는 그것을 보면 surveyor 를 부르지 않고 **대화로 생성**으로 간다.
`code-agent.json` 은 `referenceDomain` 없이, 단계는 `exemplars: []` 로 만든다 — 복제할 표준이 없으므로 `scope: "project"` + `outputDirs` 가 자연스럽다.
그 뒤가 갈리지 않도록 `manifest check` 는 무-exemplar 단계를 받고(요약 한 줄만 찍는다), `code-agent context` 는 참조 표준 대신
**아키텍처·컨벤션 문서**를 가리킨다(`참조 없음 — 아키텍처·컨벤션 문서로`). "빈 저장소" 는 **소스가 없는 저장소**이지 커밋이 없는 저장소가 아니다 —
`start` 는 기준 커밋을 굳힐 수 없으면 거부하므로, `/ca-adopt` 가 만든 매니페스트와 POLICY 4종을 사람이 커밋한 뒤에 작업이 시작된다.
매니페스트 인터뷰는 코드로 만들지 않았다 — 질문 목록이 정적 텍스트라 스킬이 더 싸다. POLICY 문서 인터뷰만 `docs interview` 가 소유한다.

## 3. 스테이지

**목표 흐름** (2026-09-29 확정): 요구사항 → 요구사항 분석·명세화 → 영향도 분석 → 시스템 설계 → 기능·API·데이터 정의 → 구현 계획 →
코드 생성 → 정적 분석·컴파일 → 테스트 생성·실행 → 결과 분석 → (실패: 수정 → 정적 분석부터 다시 / 성공: 코드 리뷰 → 지적은 수정 루프로)
→ 통합 검증 → 반영·PR. 스테이지는 이 흐름을 그대로 딴다.

| # | 스테이지 (key) | 목표 흐름 | 하는 일 | 누가 | 게이트 | 상태 |
|---|---|---|---|---|---|---|
| 0 | 준비 | — | `init` 설치, 워크스페이스 감지 (신규/레거시, 필수 문서 유무) | CLI | — | P1 ✅ |
| 1 | 공통 문서 | — | POLICY 4종(아키텍처 · 컨벤션 · 테스트 전략 · 품질·보안 기준) 점검·작성, KNOWLEDGE 3종 빈 뼈대. 문서마다 기본으로 생성 / 대화로 생성 | CLI 점검 + surveyor·writer | **POLICY 넷 다 확정돼야 작업 시작** | P2 ✅ 2종 · P4 ✅ 2종 |
| — | 요구사항 접수 (`request`) | 요구사항 | 사람이 **말로** 준 것(서술·티켓·파일)을 `request.json` 으로 정리 → 코드가 `requirement.md` 렌더 → **사람이 터미널에서 확정**. 커서가 아직 없어 스테이지 번호가 없다 (문서 세션처럼 **접수 세션**으로 돈다) | 메인 (ca-request) + CLI | **사람 확정 (터미널)** — 확정된 지시서만 `start` 가 받는다 | ✅ (2026-10-01) |
| 2 | 요구사항 분석 `analysis` | 요구사항 분석·명세화 | ① `01-requirements.md` — 요구 항목(`## R<n>`), 기본값은 `## 가정`, 모호·누락·충돌은 질문 | 메인 + analyst | 질문 · R 형식 | P4 ✅ (P3 의 `analysis.md`) |
| 3 | 영향도 분석 `impact` | 영향도 분석 | ② `02-analysis.md` — 기존 시스템 분석 · 영향 범위 · Risk (**항상**, 크기는 작업에 맞게) | 메인 + explorer × 영역 → writer | 질문 · 필수 섹션 · **영향 표에 모든 R** | P4 ✅ |
| 4 | 설계·정의 `design` | 시스템 설계 · 기능/API/데이터 정의 | ③ `03-design.md` — 구성 요소 · 처리 흐름 · API · 데이터 · 설계 결정 (해당 없으면 `해당 없음 — 근거`) + ④ `04-functional.md` — 기능 · 업무 규칙 · 예외 · 수락 기준(AC) | 메인 + writer | 질문 · 필수 섹션 · **R 마다 AC 1개 이상** | P4 ✅ |
| 5 | 구현 계획 `plan` | 구현 계획 수립 | ⑤ `plan.json` → 코드가 `05-plan.md` 로 렌더(변경 파일 · 작업 순서 · 구현 방법) + ⑦ `07-test-spec.md` — AC 마다 테스트 케이스 | 메인 → critic | **사람 승인 (터미널)** — 01~04 · 07 · requirement 본문 한 묶음 | P3 ✅ (`plan.json`) · ⑤ 렌더·⑦ P4 ✅ |
| 6 | 코드 생성 `implement` | 코드 생성 | ⑥ 계획의 단계마다 새 컨텍스트에서. **`fix` 는 `kind:"test"` 단계를 맨 앞으로 세우고** 그 뒤 `code-agent repro` 로 재현을 본다 | implementer (테스트 단계는 tester) | hook — 계획 밖 쓰기 거부 · `fix` 는 재현 전 비-test 계획 파일 쓰기 거부 | P3 ✅ · 재현 P6 ✅ |
| 7 | 정적 분석·컴파일 `check` | 정적 분석·컴파일 | 품질·보안 기준이 적은 명령 + `build` 를 돌려 증거로 기록 → ⑧ `08-validation.md` (코드만 씀) | CLI | 코드 — `not-run` 은 통과가 아니다 | P5 ✅ |
| 8 | 테스트 `test` | 테스트 생성·실행 · 결과 분석 | tester 가 ⑦ 의 케이스만 작성 → CLI 가 실행 → ⑧ 에 케이스마다 한 줄 | tester + CLI | 코드 — ⑦ 의 모든 TC id 가 실행 출력 또는 `kind:"test"` 파일에서 확인됨, 이후 테스트 동결 | P5 ✅ |
| ↺ | 수정 | 실패 → 수정 | 7·8·9 에서 나온 것 중 계획 안은 implementer 가 고치고 **7 부터 다시** (`code-agent check` 는 `test`·`review`·`integrate` 에서 불려도 커서를 7 로 되감는다. 기본 N=2, `code-agent.json` 의 `fixRounds`. 한도는 증거가 시작될 때 굳고, 넘으면 덮지 않고 보고). 계획 밖이면 질문 또는 재계획(재승인) | implementer | hook | P5 ✅ |
| 9 | 코드 리뷰 `review` | 성공 → 코드 리뷰 | ⑨ `09-review.md` — `code-agent review` 가 회차 구역(번호·시각·**기준 트리 해시**)을 렌더하고, 메인이 reviewer 의 지적을 표로 옮긴다. 지적은 수정 루프로 | reviewer + CLI | 열린 지적 0 · 계획 밖 지적 0 · 마지막 회차 트리 해시 == 지금 | P5 ✅ |
| 10 | 통합 검증 `integrate` | 통합 검증 | 깨끗한 worktree(기준 커밋 + 변경 파일)에서 전체 build · 전체 test → ⑧ | CLI | 코드 | P5 ✅ |
| 11 | 반영 `deliver` | 반영·PR | ⑩ `10-pr.md` — 요약 · 추적표(R → AC → 파일 → TC → 검증) · 확인 방법 · 위험. KNOWLEDGE 갱신 제안을 하나씩 고른다 → **사람 최종 확인(터미널)** → 작업 브랜치에 로컬 커밋. **push · MR/PR 생성은 하지 않는다 — git 호스트가 붙을 때까지 보류** | 메인 + CLI | **사람 확인 (터미널)** | P5 ✅ |

**오늘 커서가 도는 자리** — `code-agent status` 가 보여 주는 스테이지는
`analysis → impact → design → plan → implement → check → test → review → integrate → deliver` 다
(`src/agent/layout.ts` 의 `PHASES`). P4 의 `verify` 한 칸이 P5 에서 `check`·`test`·`review`·`integrate`·`deliver`
다섯으로 갈렸다 — 목표 흐름의 7~11 을 그대로 딴다. `verify` 는 더 이상 스테이지가 아니다
(옛 커서는 `code-agent abort` 로 지우고 다시 시작한다. 굳혀 둔 기준 커밋이 없는 커서도 마찬가지다).
커서는 `deliver` 에서 끝난다 — `code-agent next` 는 반영을 끝내지 않고, **사람이 별도 터미널에서
`code-agent deliver`** 를 돌려야 로컬 커밋이 되고 커서가 지워진다.

**되감기** (2026-09-30) — 스테이지마다 명령이 하나씩 생기면서 "한 단계 앞으로 돌아가 보완한다"가 실제 동작이 됐다.
`code-agent back <스테이지>` 는 커서를 **이전 스테이지로만** 옮긴다. 앞으로 가는 길은 `next` 하나뿐이라 게이트를 건너뛸 수 없고,
되감아도 지우는 것이 없다 — 증거·승인 원장·작업 문서·리뷰 회차는 그대로 있고 커서만 움직인다. 그래서 되감기는 **우회가 아니다**:
`design` 이하로 가서 `01`~`04`·`07` 을 고치면 승인 묶음의 해시가 달라져 승인이 `stale-docs` 가 되고 hook 이 코드 쓰기를 막는다(다시 제출·재승인해야 한다).
수정 회차도 `planHash` 에 묶여 있어 초기화되지 않는다. 같은 계획을 그대로 다시 제출하면 승인은 살아 있다.
테스트 동결과 고쳐 쓰기 한도는 커서가 아니라 **증거**로 재기 때문에 `back implement` 로도 풀리지 않는다.
`deliver` 에서는 되감지 않는다 — 사람이 확인 화면 앞에 서 있는 자리라, 모델이 커서를 빼면 그 화면이 조용히 무효가 된다
(`REWINDABLE` 이 `code-agent check` 에 대해 닫아 둔 것과 같은 자리다).
(검증 실패로 `check` 로 돌아가는 것은 되감기가 아니다 — `code-agent check` 가 커서를 그 자리로 데려간다.)

### 요구사항 접수 — 명령으로 받는다 (2026-10-01 결정)

전에는 **사람이 `doc/work/<ID>/requirement.md` 를 손으로 써** 두고 모델이 `code-agent start` 를 걸었다. 그래서 요구사항만
프로세스 밖에 있었다 — 지시서 규격을 아는 사람만 작업을 시작할 수 있었고, 모델이 스스로 지시서를 지어내 시작하는 길도 열려 있었다.
이제 요구사항도 **명령으로 받는다.** 사람은 말로 주고(서술 · 붙여넣은 티켓 · 파일), 모델이 정리하고, **코드가** 지시서를 렌더하고,
**사람이 터미널에서 확정한다.** ID 는 언제나 사람이 준다 — 모델이 지어내면 브랜치 이름과 폴더 이름이 그 자리에서 거짓이 된다.

```
/ca-feature <ID> <서술·티켓·파일>          (또는 /ca-fix · /ca-refactor · /ca-request <ID> --kind <종류>)
  └─ code-agent request begin <ID> --kind <feature|fix|refactor> [--base <기준 브랜치>] [--target <대상>]
       접수 세션(.code-agent/request-session.json) 을 연다 — 커서가 아직 없으므로 문서 세션과 같은 방식이다.
       --base·--target 은 세션에 남아 **확정 뒤 start 가 이어받는다** (start 에 직접 준 값이 이긴다) —
       사람의 확정이 접수와 시작 사이를 끊으므로, 남겨 두지 않으면 /ca-feature … --base develop 의 기준 브랜치가 그 자리에서 사라진다
       형식 · 프로젝트 확장 속성 · 대상 후보를 함께 찍는다 (다시 보려면 code-agent request)
       대상 후보는 종류로 갈린다 — feature 는 `- <이름> (<경로>)` 로 찍고 target 에는 **이름**만 쓴다(이제부터 만들 것이라
       경로가 없을 수 있다), fix·refactor 는 경로를 찍고 target 도 저장소에 실재하는 경로다
  └─ 모델: doc/work/<ID>/request.json      원문은 original(준 글 그대로) 또는 originalFile(저장소 안 파일) 중 하나.
       원문에 근거가 없는 요구는 더하지 않는다 — 필수값이 비면 질문으로(최대 4개), 답은 clarifications 에 사람 말 그대로
  └─ code-agent request submit doc/work/<ID>/request.json
       스키마 → 렌더 → **손으로 쓴 지시서와 같은 지시서 검사** + 머리말 왕복 대조. 통과해야 requirement.md 가 쓰인다.
       반려된 내용을 그대로 다시 내면 거부한다 — 사유를 읽지 않은 제출은 사람에게 같은 화면을 한 번 더 보일 뿐이다
  └─ (사람, 별도 터미널) code-agent confirm request <ID> [<지시서>]   반려는 reject request <ID> [<지시서>] --comment "사유"
       지시서를 생략하면 그 ID 가 진행 중인 작업이면 그 작업의 지시서, 아니면 doc/work/<ID>/requirement.md.
       다른 자리에 손으로 쓴 지시서는 **경로를 함께 준다** — start 의 거부문이 그 경로가 든 확정 명령을 그대로 찍어 준다
       원문과 정리를 나란히 띄우고 confirm 을 입력받아 approvals/<slug(ID)>/request.jsonl 에 해시로 남긴다
  └─ /ca-next (또는 /ca-analyze) → code-agent start doc/work/<ID>/requirement.md → 2 요구사항 분석
```

**렌더된 지시서의 모양** — 머리말(`kind`·`id`·`title`·`target`·`scope`·`preserve`·`approver`·확장 속성) 다음에
`## 원문`(사람이 준 글을 **한 글자도 바꾸지 않고** 인용으로 감싼 것 — `originalFile` 이면 코드가 그 파일을 그대로 옮긴다) ·
`## 배경` · `## 요구 내용` · `## 완료 조건` · `## 범위 밖` · `## 제약` · `## 접수 때 정한 것`(질문과 답).
원문을 지시서 안에 함께 싣는 이유는 하나다 — **확정하는 사람이 원문과 정리를 나란히 읽는 자리**가 있어야 하기 때문이다.
정리하다 뜻이 달라지는 길과, 모델이 지시서를 지어내 스스로 시작하는 길이 여기 한 자리에서 닫힌다.
그 절들은 뒤 스테이지가 그대로 받는다 — ca-analyst 는 ① 의 `근거:` 를 `## 원문`·`## 요구 내용`·`## 완료 조건`·`## 접수 때 정한 것`
에서만 끌어오고, ca-writer 는 `## 완료 조건` 의 문장을 ④ 의 AC 로 **글자 그대로** 옮긴다(사람이 확정한 말이 수락 기준에서 다시 쓰이지 않게).

**접수 세션이 막는 것** — 세션이 열려 있는 동안 hook 은 그 작업 폴더(`doc/work/<ID>/`) 밖 쓰기를 전부 거부하고,
`requirement.md` 는 그 안에 있어도 거부한다(코드가 렌더하는 파일이다). 선언된 빌드·테스트 명령도 열지 않는다 —
돌릴 코드가 아직 없는 자리다(문서 세션과 같다). 세션은 `start` 가 지우고, 작업이 없을 때 사람이 `code-agent abort` 로 닫을 수 있다.
작업 폴더와 확정 원장은 남으므로 같은 ID 로 다시 접수할 수 있다. 문서 세션과는 서로 배타적이다 —
접수 중이면 `docs begin` 과 `docs link` 가 거부하고(근거 문서와 그 자리를 접수 도중에 바꾸지 않는다),
문서 세션 중이면 `request begin` 이 거부한다.

**확정은 "지금 바이트" 에 걸린다** — 원장에는 그때 확정한 지시서의 해시가 남고(줄바꿈·BOM 은 내용으로 세지 않는다),
`start` · `next` · `plan submit` · `approve`/`reject` · `repro` · `check` · `test` · `review` · `integrate` · `deliver` 가
**지금 내용이 확정된 것과 같은가**를 다시 본다(`requireRequestConfirmed`). 그래서 네 가지가 자동으로 따라온다.

남는 해시는 **사람에게 보여 준 바이트**의 것이다 — 프롬프트 뒤에 파일을 다시 읽어 해시하면, 사람이 읽는 사이 다시 제출된
다른 내용이 확정된 것으로 남는다. 읽는 사이에 바뀌었으면 **판정을 남기지 않고** 세운다(`확정하는 동안 지시서가 바뀌었습니다 — 판정을 남기지 않았습니다`).
판정을 고를 때는 **ID 와 지시서 경로를 둘 다** 본다 — 원장은 `slug(ID)` 마다 하나라 다른 자리의 지시서가 같은 파일에 섞일 수 있다.

- **다시 제출할 수 있다** — 작업이 시작된 뒤에도 같은 ID 면 `request submit` 이 받는다. 대신 확정이 풀려 사람이 다시 확정해야 진행한다.
- **손으로 고쳐도 같다** — 사람이 `requirement.md` 를 직접 고치면 해시가 달라져 재확정을 요구한다. 손으로 쓴 지시서도 같은 확정을 지난다 — 시작은 `/ca-analyze <지시서>` (또는 `code-agent start <지시서>`), 접수를 다시 돌리지 않는다. `request submit` 은 코드가 렌더한 표시가 없는(사람이 쓴) 지시서를 덮지 않는다
  (정해진 자리 밖에 있으면 확정·반려에 그 경로를 함께 준다).
- **관측되지 않은 확정은 받지 않을 수 있다** — `code-agent.json` 의 `workOrder.requireVerifiedApproval` 이 켜져 있는데 그 확정에
  사람이 관측된 기록이 없으면 `unverified` 로 떨어져 `start`·`next` 와 그 뒤 명령이 거부하고 터미널에서 다시 확정하게 한다.
  **이 선언은 계획 승인에만 걸리던 것이 아니다 — 요구사항 확정에도 같이 걸린다.** 매니페스트를 읽지 못하면 받지 않는 쪽으로 닫는다.
- **계획 승인도 함께 흔들린다** — 지시서 본문은 `docsHash` 안에 있어 승인이 `stale-docs` 가 되고, 머리말을 바꾸면 `orderHash` 도 달라진다.

반려는 사유가 필수고(`--comment`), 사유는 `code-agent status` 와 `/ca-request` 가 읽어 다시 정리하는 근거가 된다.
원장은 해시 사슬이라 나중에 고치면 읽기를 거부하고, `approvals/<slug(ID)>/` 디렉토리는 `deliver` 의 커밋 목록에 있어 **반영 커밋에 함께 올라간다.**

**작업 종류**는 어떤 스테이지를 어떻게 도는지로 갈린다 — 종류를 고르는 자리가 접수(`--kind`)다.

| 종류 | 스테이지 | 종류별 강제 (P6 ✅) |
|---|---|---|
| `feature` | 1 (점검) → 2 → 3 → 4 → 5 → 6 → 7 ⇄ 8 ⇄ 9 (수정 루프) → 10 → 11 | — |
| `fix` | 같음. 다만 **6 은 `kind:"test"` 단계부터** 돈다 | ② 의 `기존 시스템 분석` 에 결함이 나는 경로(`해당 없음` 불가 · 근거 `path:line` 최소 하나) · ⑦ 의 `## 재현` 절에 재현 TC id · 계획의 `sequence[0]` 이 `kind:"test"` 단계이고 그 단계의 파일이 계획에 있을 것 · **`code-agent repro` 가 지금 코드에서 그 TC 의 실패를 보기 전에는 고칠 파일을 쓸 수 없다** |
| `refactor` | 같음 | ② 의 `기존 시스템 분석` 에 지금 동작(같은 두 규칙) · 계획에 preserve 전량 · **기준 커밋에 이미 있던 `kind:"test"` 단계 파일은 고치지도 지우지도 못한다** · 8·10 에서 기존 테스트 스위트가 그대로 통과 (`not-run` 은 통과가 아니다) |

**fix 의 재현이 서는 자리** — 강제력은 스테이지가 아니라 **증거**다. `code-agent repro` 는 (a) 비-`kind:"test"` 계획 파일이 기준 커밋과
하나라도 다르면 거부하고, (b) 테스트 명령을 돌려 `failed` 만 인정하며(`not-run`·`error` 는 아무것도 증명하지 않는다), (c) ⑦ 의 `## 재현` 이
가리킨 TC id 가 **실패한 실행의 출력**에 있어야 통과시킨다. ⑧ 의 두 갈래(출력 · 테스트 파일)를 여기서는 쓰지 않는다 — 파일 안에 id 가
적혀 있다는 것은 *무엇이* 실패했는지 말해 주지 않아, 다른 TC 의 실패도 깨진 import 도 같은 `failed` 로 보인다. 통과하면 `Evidence.repro` 에
**그때의 테스트 파일 부분 트리 해시**와
함께 적히고, hook 은 그 증거가 있을 때만 고칠 파일 쓰기를 연다 — `back implement` 로도 풀리지 않고, 계획을 재승인하면(`planHash` 변경)
증거와 함께 버려져 다시 봐야 한다. 재현을 본 순간 `kind:"test"` 단계 파일이 **언다**(테스트가 아직 한 번도 돌지 않았어도) — 재현을 보고 나서
단언을 약하게 하면 그 재현이 증거가 아니게 되기 때문이다. 동결을 푸는 길은 그대로 둘이다: ⑨ 의 그 파일을 가리키는 열린 계획 안 지적, 또는 계획 재승인.
회차는 올리지 않는다(`round: 0`) — 재현은 고쳐 쓰기가 아니라 순서다. 푼 뒤 테스트를 고쳤으면 **통합 검증 앞에서 한 번 더 대조한다**:
`Evidence.repro.testTreeHash` 가 지금 테스트 트리와 다르면 `integrate` 를 막는다 — ⑧·⑩ 이 찍는 재현 줄이 반영될 테스트를 가리켜야 한다.

**'재현 먼저' 는 단계 이름표로 판정된다** (hook 도 `repro` 의 깨끗한 트리 검사도 `kind:"test"` 단계에 속하느냐로 본다). 그래서 계획이
고칠 파일을 테스트 단계에 적어 넣으면 이름표만으로 재현을 비껴간다 — `plan submit` 이 **테스트 단계의 계획 파일은 그 단계가 밝힌 자리 안**
이어야 한다고 세운다. 자리는 `scope:"project"` 의 `outputDirs` 또는 `base` 뿐이고, 둘 다 없으면 자리가 없는 것이다(아래 refactor 와 같은 규칙).

`code-agent start` 가 받는 것은 이 셋뿐이다. 어떤 종류로 돌 단계가 있는지는 매니페스트의 `stages[].kinds` 가 정한다
(비면 모든 종류). 0개면 `start` 가 거부하며 **무엇을 고쳐야 하는지**를 단계별 `kinds` 목록과 함께 찍고, `code-agent manifest check` 가
미리 경고한다(경고일 뿐 종료 코드는 0). 도입은 작업이 아니라 `/ca-adopt` 가 하는 일이다 — 지시서를 쓰지 않고 0 → 1 만 돈다.

어느 작업이든 1 의 점검을 먼저 지난다. 필수 문서가 없으면 거기서 멈추고 작성으로 안내한다 —
`/ca-feature` 를 불렀더라도 `/ca-docs` 로 돌려보낸다.

### 질문은 어느 스테이지에서든 던진다

애매하거나 모호하면 지어내지 않고 묻는다. 질문은 작업 폴더의 `questions.md` 에 쌓이고, **답이 없는 질문이
있으면 다음 스테이지로 넘어가지 않는다** (`code-agent next` · `plan submit` 과 `repro` · `check` · `test` · `review` · `integrate` · `deliver` 가 확인한다.
턴 끝에 보는 Stop hook 은 `implement`~`integrate` 에서 그 턴을 **한 번 막고**(`decision: "block"`) 다음 턴은 놓아 주는 쪽이고 — `stop_hook_active` 면 즉시 통과하고 판정이 실패해도 막지 않는다 — 절대적인 차단은 이들이다).

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

**증거가 서는 자리** (P5 단계 1 ✅) — `start` 가 기준 브랜치를 그 순간의 커밋으로 굳혀 `ActiveWork.baseCommit` 에 박고,
그 뒤 모든 판정이 그 위에 선다. `check`·`test` 는 `.code-agent/work/<ID>/<대상>.verify.json` 에 **코드만** 쓰고
(hook 이 도구 쓰기를 막는다) 거기서 ⑧ 을 렌더한다. 증거에는 기준 커밋 · **계획 파일의 부분 트리 해시** ·
`manifestHash` · `planHash` 가 함께 적혀, 넷 중 하나라도 지금 값과 다르면 그 통과는 무효다 —
통과를 받아 두고 단언을 지우는 길과 검증 명령을 약하게 바꾸는 길이 같은 자리에서 닫힌다.
명령을 돌리기 **전에** 계획↔트리를 대조하고 회차를 올린다(계획 밖 변경 위의 통과는 증거가 아니고,
뒤에 올리면 프로세스를 죽여 카운터를 피할 수 있다).

**리뷰가 서는 자리** (P5 단계 2 ✅) — 리뷰의 강제력은 **마지막 회차의 기준 트리 해시**다.
그 값을 모델이 적으면 아무것도 묶지 못하므로 회차는 `.code-agent/work/<ID>/<대상>.review.json` 에
**코드만** 쓰고(`code-agent review`), ⑨ 의 회차 구역(`<!-- code-agent:review:... -->`)을 거기서 렌더한다.
지적은 판정이라 코드가 만들 수 없어 구역 **밖**의 표에 모델이 옮겨 적고, 거기서도 **범위(계획 안/밖)는
코드가 계획 파일 목록과 대조해 정한다** — 모델이 다르게 적으면 게이트가 알린다. 경로 단위 hook 으로
구역 안쪽만 막으려면 Edit 의 부분 치환까지 봐야 해 비싸므로, ⑨·⑩ 은 **다시 렌더해 바이트로 대조한다**.

**통합 검증이 다른 이유** — `check`·`test` 는 사람이 보고 있는 작업 트리에서 돈다. 거기 남아 있던
산출물이 결과를 떠받칠 수 있어, `integrate` 는 굳혀 둔 기준 커밋 위에 **깨끗한 worktree** 를 만들고
이 작업의 변경만 얹어 전체 `build`·`test` 를 돌린다. `verifyByBuild` 는 쓰지 않는다 — 그것은 커밋을
검증하는데 새 흐름은 반영 전까지 아무것도 커밋하지 않아, 수정이 하나도 없는 트리를 통과시킨다.

**⑦ 대조는 두 갈래다** — 테스트 출력에서 TC id 를 읽어 내는 것은 프레임워크마다 형식이 달라 일반적으로 되지 않는다.
그래서 ① 실행 출력에 TC id 가 그대로 나오면 그것으로 인정하고, ② 나오지 않으면 `kind: "test"` 단계의 계획 파일이
그 id 를 들고 있는지 본다(컨벤션의 `테스트 규칙` 이 "테스트 이름·주석에 TC id 를 남긴다"고 정한 그 자리다).
둘 다 아니면 통과로 세지 않는다.

## 4. 메인 에이전트와 서브에이전트

**메인 에이전트**는 사용자와 대화하는 Claude Code 세션 자체다. 스킬(`/ca-*`)을 따라 순서를 진행하고,
서브에이전트를 부르고, 결과를 합친다. 코드를 직접 많이 쓰지 않는다 — 메인 컨텍스트가 작아야 긴 작업이 버틴다.

| 서브에이전트 | 스테이지 | 도구 | 하는 일 | 상태 |
|---|---|---|---|---|
| `ca-surveyor` | 1 | 읽기 전용 | 뼈대 역공학 — 영역 하나(빌드·구조·계층 표본)를 맡아 근거 경로가 달린 분석. 여럿 병렬 | P2 ✅ |
| `ca-analyst` | 2 | 읽기 전용 | 요구 항목화, 모호·누락·충돌을 질문 후보로, 항목별 "데이터·접점을 건드리는가" 판정 | P3 ✅ |
| `ca-explorer` | 3 | 읽기 전용 | 요구사항 범위 역공학 — 닿는 영역 하나의 관련 파일·호출 경로·현행 데이터·API. 영역마다 병렬 | P3 ✅ · P4 부터 `impact` 에서 돈다 |
| `ca-writer` | 1, 3, 4 | 쓰기 (문서 경로만) | 분석 결과·사용자 답을 문서 스키마 섹션에 맞춰 문서로 | P2·P3 ✅ |
| `ca-critic` | 5 | 읽기 전용 | 계획 반박 검토 — 빠진 요구 항목, 계획 밖 파일 필요성, 테스트 공백, 작업 문서와의 불일치 | P3 ✅ |
| `ca-implementer` | 6, ↺ | 쓰기 (hook 강제) | 단계 하나. `code-agent context` 로 받은 것만 읽고 시작 | P3 ✅ |
| `ca-tester` | 6 (`kind:"test"` 단계), 8 | 쓰기 (테스트 경로만) | 테스트 작성. 구현과 다른 컨텍스트라 구현을 베끼지 않는다. 첫 검증 뒤에는 언다 | P5 ✅ |
| `ca-reviewer` | 9 | 읽기 전용 | 컨벤션·요구사항 충족·참조 코드와의 차이. 고칠 목록만 낸다 — 항목마다 **계획 파일 경로**를 적고, 저장소를 다시 훑지 않는다(`context` 가 준 목록·증거만) | P5 ✅ |

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
| 프로젝트 필수 문서(아키텍처·컨벤션)가 없거나 미확정이면 작업 시작·스테이지 전환·계획 제출·승인 거부 | `start` · `next` · `plan submit` · `approve` · `repro` · `check` · `test` · `review` · `integrate` · `deliver` (`requireDocs`) | 스테이지 전환 · 검증 · 반영 | P2 ✅ |
| 요구 항목(① `01-requirements.md` 의 `## R<n>` · `## 가정`)이 없거나 형식이 틀리면 넘어가지 않음 | `code-agent next` · `plan submit` · `approve` (`requireRequirements`) | 스테이지 전환 | P3 ✅ |
| 번호 문서 ②③④⑦ 이 없거나 비었거나 필수 섹션이 비면 계획으로 못 가고, 제출도 거부 | `next` · `plan submit` · `approve` (`analysisProblems` · `designProblems` · `functionalProblems` · `testSpecProblems`) | 계획 전 | P3 ✅ |
| 계획의 파일마다 담당 요구 항목(`files[].requirements`)이 있고, 모든 요구 항목이 어느 파일엔가 닿아야 제출 | `code-agent plan submit` | 계획 전 | P3 ✅ |
| 계획에 `openQuestions` 가 남아 있으면 제출 거부 | `code-agent plan submit` | 계획 전 | P3 ✅ |
| 승인 뒤 필수 문서·분석·작업 문서가 바뀌면 승인 무효 (`stale-docs`) | 승인 판정 (`approvalOf` · `approvalDocsHash`) | 매 쓰기 | P3 ✅ |
| 작업 지시서(`requirement.md`)는 모델이 고칠 수 없음 — 접수 중이든 작업 중이든 문서 세션 중이든, **작업도 세션도 없을 때도**(`doc/work/<아무 ID>/requirement.md` 전부). 고칠 것은 `request.json` 에 쓰고 다시 제출하고, 모호하면 질문으로 | PreToolUse hook | 쓰기 전 | P1 ✅ · 접수 ✅ |
| **요구사항 접수 세션 중에는 그 작업 폴더(`doc/work/<ID>/`) 밖 쓰기 금지** — 확정 전에 코드·문서를 "미리" 고쳐 두는 길을 닫는다 | PreToolUse hook (`decideRequestWrite`) | 쓰기 전 | ✅ |
| **사람이 지금 내용 그대로 확정한 요구사항 위에서만 진행** — 확정이 없거나 반려됐거나 확정 뒤 바뀌었으면, 그리고 `workOrder.requireVerifiedApproval` 이 켜져 있는데 그 확정에 사람이 관측되지 않았으면(`unverified`) 거부하고 `code-agent confirm request <ID> [<지시서>]` 를 **그 지시서 경로까지 넣어** 안내. 판정은 ID 와 지시서 경로가 **둘 다** 같은 것만 본다 | `start` · `next` · `plan submit` · `approve`/`reject` · `repro` · `check` · `test` · `review` · `integrate` · `deliver` (`requireRequestConfirmed`) | 작업 시작 · 스테이지 전환 · 검증 · 반영 | ✅ |
| 접수 초안은 **지시서 규격을 지나야** 렌더된다 — 손으로 쓴 지시서와 **같은** `validateWorkOrder` + 머리말 왕복 대조(따옴표·`[ ]` 로 감싼 값, 빈 항목은 파서가 다르게 읽는다) · 원문은 `original`·`originalFile` 중 하나 · `extra` 에 예약 속성 금지 · `extra` 의 속성 이름은 `[A-Za-z][A-Za-z0-9_-]*`. 머리말 규격 위반은 **전부 접수의 말로** 돌려준다(작업 시작 때 쓰는 일반 지시서 오류문이 아니라 — 고칠 곳은 `request.json` 이다) | `code-agent request submit` | 접수 | ✅ |
| **반려된 내용을 그대로 다시 제출할 수 없다** — 마지막 판정이 반려이고 렌더 결과의 해시가 그때와 같으면 쓰지 않고 사유를 다시 찍는다. 사유를 읽지 않은 제출은 사람에게 같은 화면을 한 번 더 보일 뿐이다 | `code-agent request submit` | 접수 | ✅ |
| **확정은 사람에게 보여 준 바이트에 걸린다** — 프롬프트 앞에서 읽은 내용으로 해시하고, 사람이 읽는 사이 지시서가 바뀌었으면 **판정을 남기지 않는다**. 보여 준 것과 남는 것이 같아야 확정이 그 내용에 대한 것이 된다 | `confirm request` · `reject request` | 확정 | ✅ |
| 확정 원장은 해시 사슬 — 나중에 고치면 **읽지 않고 세운다**. `approvals/<slug(ID)>/request.jsonl` 은 반영 커밋에 함께 올라간다 | `readRequestLedger` · `deliver` | 확정 · 반영 | ✅ |
| 세션은 하나씩 — 접수 중이면 `docs begin`·`docs link` 거부, 문서 세션 중이면 `request begin` 거부, 작업 중이면 둘 다 거부 | `docs begin` · `docs link` · `request begin` | 세션 열 때 · 문서 등록 | P2 ✅ · 접수 ✅ |
| 문서 작성 세션 중에는 문서 자리(`doc/`, 등록된 문서, `code-agent.json`) 밖 쓰기 금지 — `doc/` 아래라도 `doc/work/<ID>/requirement.md` 는 거부한다(접수가 렌더하는 파일이다) | PreToolUse hook | 쓰기 전 | P2 ✅ · 접수 ✅ |
| 계획 승인 전(분석·조사·계획 스테이지) 작업 폴더 밖 쓰기 금지 | PreToolUse hook → `code-agent hook` | 쓰기 전 | P1 ✅ |
| 계획에 없는 파일, scope 밖, preserve, 계층 경계 | 같음 (코어 `checkPaths` · `unplannedFiles`) | 쓰기 전 | P1 ✅ |
| `.code-agent/` 상태·제출된 계획·원장 변조 | 같음 | 쓰기 전 | P1 ✅ |
| **작업도 세션도 없을 때 언제나 지키는 넷** (`decideOutside`) — `.code-agent/` 쓰기(대소문자 무시) · `doc/work/<아무 ID>/requirement.md` 쓰기 · `~/.code-agent/`(키 자리) 읽기·쓰기 · `.code-agent` 나 `~/.code-agent` 를 **가리키는** Bash(명령 이름 `code-agent` 는 걸리지 않는다). 그 밖의 세션 밖 도구 호출은 판정하지 않는다 — code-agent 로 하는 작업이 아닐 때까지 막을 이유는 없다. 이 틈을 열어 두면 세션이 열리기 **직전**에 모델이 지시서와 확정 원장을 손으로 써 넣고 사람의 확정 없이 `start` 를 지난다 | PreToolUse hook (`decideOutside`) | 쓰기 · 실행 · 읽기 전 | ✅ |
| 쓰기 경로에 `:` 가 들어 있으면 거부 — **모든 모드에서**. Windows 의 대체 데이터 스트림 표기(`requirement.md::$DATA`)는 같은 파일을 가리키는데, 아직 없는 파일이면 실제 경로로 풀리지 않아 이름 대조를 비껴간다 | PreToolUse hook (`streamGuard`) | 쓰기 전 | ✅ |
| **진행 중인 작업이나 문서·접수 세션이 있을 때만** — Bash 는 허용 목록만 (스킬이 부르는 `code-agent` 서브명령 — `init`·`abort`·`approve`·`reject`·`confirm`·`model`·`deliver`·`plugin add`·`plugin remove` 는 사람 몫이라 뺀다, 매니페스트에 선언한 명령, 읽기용 git status·diff·log·show·branch — `-o`·`--output` 은 파일을 쓰므로 거부). **단 문서 세션·접수 세션에서는 선언한 명령을 열지 않는다** (`decideBash` 의 `documenting`) — 문서 세션은 모델이 `code-agent.json` 을 쓸 수 있는 유일한 자리라 허용 목록을 제 손으로 넓히는 길이 되고, 접수는 돌릴 코드가 아직 없는 자리다. 연결·리다이렉트(`;` `&&` `\|` `>`)는 거부. **세션 밖에서는 허용 목록을 걸지 않지만**, `.code-agent`·`~/.code-agent` 를 가리키는 명령만은 거기서도 거부한다(위 `decideOutside`) | 같음 | 실행 전 | P1 ✅ · P4 ✅ · 접수 ✅ |
| 답 없는 질문이 있으면 진행 금지 | `code-agent next` · `plan submit` · `repro` · `check` · `test` · `review` · `integrate` (`requireAnswers`) · `deliver` (`deliverProblems`) | 스테이지 전환 · 검증 · 반영 | P3 ✅ |
| 단계의 계획 파일이 실제로 생겼는지 확인해야 다음 단계 | `code-agent next` (`missingPlannedFiles`) | 스테이지 전환 | P3 ✅ |
| 승인·확정은 사람만 | `approve` · `reject` · `confirm doc` · **`confirm request`** · **`reject request`** 의 TTY 검사 | 승인 시 | P1 ✅ · 접수 ✅ |
| 승인은 무엇에 대한 것인가 | 원장 해시 사슬 — 요구사항·지시서·계획·매니페스트·문서 | 매 쓰기 | P1 ✅ |
| POLICY 4종(테스트 전략 · 품질·보안 기준 추가) 확정 + 명령 이름이 매니페스트에 실재 | `start` · `next` · `plan submit` · `approve` · `repro` · `check` · `test` · `review` · `integrate` · `deliver` (`requireDocs`) | 스테이지 전환 · 검증 · 반영 | P4 ✅ |
| ②③④⑦ 이 없거나 게이트를 못 지나면 계획으로 못 가고 제출도 거부 — 영향 표에 모든 R · R 마다 AC · 모든 AC 가 TC 에 | `code-agent next` · `plan submit` | 계획 전 | P4 ✅ |
| `fix`·`refactor` 는 ② 의 `기존 시스템 분석` 을 `해당 없음` 으로 비울 수 없고 근거 `path:line` 이 최소 하나 있어야 한다 — 스키마 guide 가 "근거는 path:line" 이라 적어 둔 문장의 코드화다 (`feature` 는 그대로). **비었는가**로 재지 그 말이 나왔는가로 재지 않는다 — 절의 줄이 전부 `해당 없음` 일 때만 막는다 | `code-agent next`(impact) · `plan submit` · `approve` (`analysisProblems`) | 영향도 · 계획 전 | P6 ✅ |
| `fix` 는 ⑦ 에 `## 재현` 절이 있어야 하고, 거기 적힌 TC id 가 `테스트 케이스` 표에 실재해야 한다 — 수준(Unit/Integration/E2E)은 무엇이든 된다 | `code-agent next` · `plan submit` (`testSpecProblems`) | 계획 전 | P6 ✅ |
| `fix` 의 계획은 `sequence[0]` 이 `kind:"test"` 단계이고 그 단계의 파일이 `files[]` 에 있어야 제출 — 재현 테스트가 먼저다 | `code-agent plan submit` | 계획 전 | P6 ✅ |
| `refactor` 의 계획에는 **기준 커밋에 이미 있던 `kind:"test"` 단계 파일**을 넣을 수 없다 — 동작이 보존되는지 보는 것이 그 테스트다 | `code-agent plan submit` | 계획 전 | P6 ✅ |
| 선언된 종류로 돌 단계가 0개면 `start` 가 거부하고 **무엇을 고칠지** 찍는다(단계별 `kinds` 목록 · `manifest check` 안내). `manifest check` 는 종류별 0단계 · `kind:"test"` 단계 없음 · **자리를 밝히지 않은 `kind:"test"` 단계** · 참조 파일 0 을 **경고**로 미리 낸다 (종료 코드 0) | `code-agent start` (`stagesFor`) · `manifest check` | 작업 시작 전 | P6 ✅ |
| `05-plan.md` · `08-validation.md` 는 코드만 쓴다 (모델 쓰기 거부 + 재렌더 바이트 대조) | PreToolUse hook · `next` | 쓰기 전 | P4 ✅ · P5 ✅ |
| 정적 분석을 통과해야 테스트로, 수정은 N회까지 (`fixRounds`, 기본 2 — 넘으면 hook 이 계획 파일 쓰기를 전부 거부). 한도는 **증거가 시작될 때 굳는다**(`Evidence.fixRounds`) — `fixRounds` 는 `hashManifest` 밖이라, 매번 매니페스트에서 읽으면 `code-agent.json` 이 계획 파일인 작업에서 루프 도중에 올릴 수 있다 | `check` · `test` · hook | 스테이지 전환 · 쓰기 전 | P5 ✅ |
| 검증 명령(`build` · `test` · `prepare` · `commands`)이 이 계획이 쓰는 파일을 가리키면 제출 거부 — 제 검증기를 쓰는 계획은 모든 묶임이 들어맞아도 증거가 아니다 | `code-agent plan submit` | 계획 전 | P5 ✅ · `prepare` P6 ✅ |
| 검증 증거는 기준 커밋 · 계획 파일 부분 트리 해시 · `manifestHash` · `planHash` 에 묶인다 — 하나라도 달라지면 통과가 무효 | `code-agent next` (`stageProblems`) | 스테이지 전환 | P5 ✅ |
| 테스트가 한 번 돈 뒤 — **또는 `fix` 에서 `code-agent repro` 가 재현을 본 뒤** — `kind: "test"` 단계의 계획 파일 동결. 푸는 길은 ⑨ 의 **그 파일을 가리키는 열린 계획 안 지적** 또는 계획 재승인. 지적이 열쇠가 되려면 셋이 함께다: **`review` 스테이지**일 것 · `code-agent review` 가 연 **회차가 있을 것** · 푼 사실이 `review.json` 에 남을 것(남기지 못하면 풀지 않는다). ⑨ 는 작업 폴더 안이라 아무 때나 쓸 수 있어, 이 셋이 없으면 `test` 에서 미리 적어 두고 풀 수 있다 | PreToolUse hook (`findingOpensFile`) | 쓰기 전 | P5 ✅ · 재현 P6 ✅ |
| `fix` 는 재현을 보기 전에 **비-`kind:"test"` 계획 파일을 쓸 수 없다** — 증거(`Evidence.repro`)로 재기 때문에 `back implement` 로 풀리지 않고, 계획 재승인(`planHash` 변경)이면 증거와 함께 버려져 다시 봐야 한다. 재현 증거는 그때의 **테스트 파일 부분 트리 해시**에 묶여, 첫 `check` 전에 테스트를 고치면 다시 잠긴다 (첫 `check` 뒤에는 이 대조를 내린다 — ⑨ 지적으로 동결을 푼 수정 루프가 교착되지 않게) | PreToolUse hook (`reproReason`) | 쓰기 전 | P6 ✅ |
| `code-agent repro` 는 (a) 비-test 계획 파일이 기준 커밋과 다르면 거부하고 (b) `failed` 만 인정하며(`not-run`·`error` 는 아무것도 증명하지 않는다) (c) 재현 TC id 가 **실패한 실행의 출력**에 있어야 통과시킨다 — 테스트 파일 갈래는 여기서 쓰지 않는다(파일을 grep 한 것은 무엇이 실패했는지 말해 주지 않는다). 회차는 올리지 않는다(`round: 0`) | `code-agent repro` | 구현 중 | P6 ✅ |
| `fix` 의 계획은 `kind:"test"` 단계에 **그 단계가 밝힌 자리 밖의 파일**을 넣을 수 없다 — '재현 먼저' 는 단계 이름표로 재므로, 고칠 파일을 테스트 단계에 적어 넣으면 재현 전에 열린다 | `code-agent plan submit` | 계획 전 | P6 ✅ |
| `Evidence.repro` 는 반영 직전에 한 번 더 지금 테스트 트리와 대조된다 — 첫 `check` 뒤로는 hook 이 이 대조를 내려 ⑨ 로 푼 재현 테스트를 고칠 수 있는데, ⑧·⑩ 은 옛 해시를 그대로 찍는다 | `code-agent next`(integrate) (`stageProblems`) | 반영 전 | P6 ✅ |
| `refactor` 는 기준 커밋에 이미 있던 `kind:"test"` 단계 파일을 고치거나 지울 수 없다 — 계획 제출 · 쓰기 · 검증 세 자리에서 같은 문구로 막는다. 무엇이 "기존 테스트" 인지는 **매니페스트의 모든 `kind:"test"` 단계**가 밝힌 자리(`scope:"project"` 의 `outputDirs` 또는 `base`)로 정한다 — `kinds` 로 거르지 않고(빼면 보호가 꺼진다), `domainBase` 로 물러서지 않는다(소스 루트 전체가 테스트가 된다). 자리를 밝히지 않은 단계는 보호도 없다 — `manifest check` 가 경고한다 | `plan submit` · PreToolUse hook · `check`(`requireCleanPlan`) | 계획 전 · 쓰기 전 · 검증 | P6 ✅ |
| 동결을 푼 지적 줄은 지울 수 없다 — 쓴 뒤 표에서 지우면 커밋된 ⑨ 에 아무 흔적도 남지 않는다. `review.json` 의 기록과 대조해 `review` → `integrate` 를 막는다 | `code-agent next` (`reviewProblems`) | 스테이지 전환 | P5 ✅ |
| 지적의 상태는 `열림` · `해결` **글자 그대로** — 부분 일치로 보면 `미해결` · `해결 안 됨` 이 전부 닫힌 것으로 읽힌다. 둘 다 아닌 값은 오타로 짚는다. `- 없음` 은 `## 지적` 절 **안에서만** 인정한다 | `code-agent next` (`reviewProblems`) | 스테이지 전환 | P5 ✅ |
| ⑦ 의 모든 TC id 가 실행 출력 또는 `kind: "test"` 단계 파일에 있어야 `test` → `review` | `code-agent next` | 스테이지 전환 | P5 ✅ |
| ⑨ 의 회차는 코드만 쓴다 (`code-agent review` → `review.json` → 회차 구역 재렌더 바이트 대조 — 표시 짝이 둘이면 어느 쪽도 믿지 않는다). **마지막 회차 트리 해시 == 지금**이 아니면 `review` → `integrate` 거부 | `code-agent review` · `next` | 스테이지 전환 | P5 ✅ |
| 열린 지적 0 · **계획 밖을 가리키는 지적 0** — 범위는 모델이 적은 것이 아니라 코드가 계획 파일 목록과 대조해 정한다 | `code-agent next` (`reviewProblems`) | 스테이지 전환 | P5 ✅ |
| 통합 검증은 기준 커밋 위의 **깨끗한 worktree** 에서 전체 `build`·`test` — 작업 트리의 산출물이 결과를 떠받치지 못한다 | `code-agent integrate` | 스테이지 전환 | P5 ✅ |
| 매니페스트에 `prepare` 가 선언돼 있으면 그 worktree 에서 `build`·`test` **앞에** 한 번 돌고, 실패하면 build·test 를 **돌리지 않는다** — 준비되지 않은 트리 위의 통과는 증거가 아니다. 결과는 `integrate/prepare` 로 증거에 남아 `failedRuns` 가 막는다. `hashManifest` 에 들어가 승인 뒤 갈아 끼울 수 없다 (선언하지 않은 매니페스트의 해시는 그대로 — `canonical` 이 undefined 키를 떨군다). 빈 배열은 **형식 오류**다(선언은 해시를 바꾸고 `manifest check` 에도 실려 "돈다" 로 읽히는데 `integrate` 는 건너뛴다), 그리고 `check`·`test`·`repro` 는 문서가 `prepare` 를 명령 이름으로 적어도 그것을 풀지 않는다 — 준비 명령은 깨끗한 worktree 의 것이다 | `code-agent integrate` · `next`(`stageProblems`) | 스테이지 전환 | P6 ✅ |
| 반영은 사람만 — TTY 확인 + 게이트 재검사(⑧ 셋 · ⑨ · 추적표 빈 칸 0 · 모델 3섹션) 뒤에야 커밋, **검증된 변경 집합만** (`git add -A` 아님). 확인 화면 직전에 `HEAD` 가 작업 브랜치인지도 본다 — 사람이 다른 터미널에서 돌리는 명령이라 그 창이 다른 브랜치에 서 있을 수 있는데, 커밋은 이 반영의 유일한 기록이다 | `code-agent deliver` | 반영 시 | P5 ✅ |
| 반영 커밋에 올라가는 `.code-agent/` 는 **이 작업의 것뿐**이다 — `.code-agent/work/<ID>/` · `approvals/<slug(ID)>.jsonl` · `approvals/<slug(ID)>/`. 통째로 스테이지하면 다른 작업의 증거·전 작업의 원장·`models.json`·`version`·`approvals/docs.jsonl` 이 함께 실려 "검증된 변경 집합만" 이 거짓이 된다 (없는 경로는 걸러 낸다 — 판정 전에는 스냅샷 디렉토리가 없다). `git add` 와 `git commit` 이 **같은 경로 목록**을 든다 — 올리는 것만 제한하면 이미 인덱스에 있던 것(사람이 친 `git add` · 앞서 실패한 `deliver` 의 스테이지)이 그대로 실려 간다 | `code-agent deliver` (`commitDelivery`) | 반영 시 | P6 ✅ |
| ⑩ 의 추적표·검증·변경 요약은 코드 구역이다 — 손으로 고치면 `deliver` 가 다시 렌더해 덮고 확인 화면에 알린다. 표시 짝이 둘 이상이면 전부 걷어 내 하나로 만들고, 표시 **밖**에 같은 제목의 절을 따로 써 두면 커밋을 세운다 (재렌더가 덮지 못하고 아래에 덧붙어, 화면에는 진짜가 보이는데 커밋에는 지어낸 표가 함께 실린다) | `code-agent deliver` (`blocks.ts` · `deliverProblems`) | 반영 시 | P5 ✅ |
| 답 없는 질문·계획과 실제 변경(기준 커밋 대비)을 턴 끝에 대조 — **한 번만** 막는다 (`stop_hook_active` 면 통과, 판정 실패도 통과). 절대적인 차단은 `check`·`test`·`next` 가 한다 | Stop hook (`code-agent stop`) | 턴 끝 | P5 ✅ |

경로는 실제 경로로 풀어 비교한다 (`canonical` — Windows 8.3 이름·junction·심볼릭 링크).
hook 은 사고 방지 장치이지 보안 경계가 아니다 — 개발자는 로컬 설정으로 끌 수 있고, Bash 는 그 자리를 **가리키는 것**만 막으므로
글자를 쪼개 돌려 쓰는 셸 명령까지는 막지 못한다. 세션 밖에서 언제나 지키는 넷도 같은 성질이다.

## 6. 플러그인과 도구 (P7)

**원칙: 무료로 되는 것은 등록 없이 쓰고, 유료는 사용자가 등록해야만 쓴다. 아무것도 없어도 전 과정이 돈다.**
등록은 **opt-in** 이다 — 등록하지 않은 사람에게는 기본 구현으로만 돈다.

계약·형식·명령의 정본은 [plugins.md](plugins.md). 여기 있는 것은 **왜 그 모양인가**다.

### 자리(slot) — 플러그인이 끼는 곳

code-agent 코어가 자리를 정의하고, 자리마다 **기본 구현**이 있다. 플러그인은 자리를 대신 채울 뿐이다.

| 자리 | 쓰이는 곳 (부르는 명령) | 기본 구현 (등록 없이) | 예: 채울 수 있는 플러그인 |
|---|---|---|---|
| `survey.classify` | 1 뼈대 역공학 (`survey`) — 파일을 계층·컴포넌트로 분류 | 경로 규칙 + surveyor | Jev |
| `candidates.rank` | 3·4 영향도·설계 (`context`) — 요구 항목과 관련된 파일 순위 | 내장 키워드 스캔 (결정론) | Jev, 코드 검색 서비스 |
| `review.prefilter` | 9 코드 리뷰 (`review`) — 규칙 위반 의심 항목 | reviewer 가 전부 봄 | Jev |
| `context.docs` | 3~5 영향도·설계·계획 (`context`) — 컨벤션·KNOWLEDGE 에서 필요한 섹션 | 제목 매칭 | Jev, 문서 MCP |
| `code.index` | **예약 — 부르는 곳이 없다** | 없음 | LSP 플러그인, 코드 인덱스 MCP |
| `verify.extra` | 7 정적 분석 (`check`) — build/test 외 검사 | 매니페스트 `commands` 에 선언한 정적 분석 명령 (P5 의 `check` 가 돌린다) | 정적 분석 도구 |

`code.index` 는 이름만 잡아 뒀다 — `--slots code.index` 로 등록은 되지만 호출 지점이 없다.
`plugin list` 의 `지금 채우는 것` 칸이 **등록·선언이 다 있어도** `예약` 으로 찍고 그 줄을 함께 낸다
(그 칸에 플러그인 이름이 뜨면 표가 돌지 않는 것을 돈다고 말한다). 쓸 자리가 확인되기 전에 호출 지점을 만들면
계약이 실사용 없이 굳는다.

### 계약 — 버전 있는 JSON 한 왕복

플러그인은 **명령 어댑터**다 — JSON 을 stdin 으로 받아 JSON 을 stdout 으로 낸다 (hook 과 같은 규약, 언어 무관).
code-agent 는 네트워크를 직접 쓰지 않는다. 외부 서비스에 붙는 일은 전부 어댑터 안에서 일어난다 —
그래서 Jev 가 붙을 때 code-agent 에 고칠 코드가 없다.

| 봉투 | `{protocol:"code-agent.plugin", version:"1", op, requestId, repoRoot?, slot?, sendsCode?, secret?, input?}` |
|---|---|
| 응답 | `{protocol, version:"1", requestId, ok:true, output}` 또는 `{…, ok:false, error}` |
| `op` | `describe`(등록 때 한 번, 키 없이) · `probe`(등록 때 한 번, 키를 실어) · `run`(자리마다) |
| 버리는 응답 | `protocol` 불일치 · `version !== "1"` · **`requestId` 불일치** · `ok` 없음 · `output` 이 자리 스키마와 다름 |
| 상한 | `describe`·`probe` 10초/256 KiB · 나머지 자리 20초/1 MiB · `verify.extra` 120초/1 MiB. 요청의 목록(`files`·`docs`·`planFiles`·`changed`·`requirements`)은 각각 3000개에서 자른다. `verify.extra` 의 `kind` 는 식별자여야 한다 |

`requestId` 를 대조하는 이유는 앞 호출의 응답을 캐시해 되돌려 주는 어댑터를 막기 위해서다.
`verify.extra` 만 120초인 것은 두 번째 러너(비동기)를 만들지 않기 위해서다 —
어댑터 실행은 `spawnSync` 하나로 돈다(필요한 상한 셋이 그 옵션 그대로다). **2분 넘게 도는 검사는 플러그인으로 못 쓴다**;
긴 정적 분석은 매니페스트 `commands` 로 선언한다 — 그 길은 이미 있고 `check` 가 돌린다.

### 자리를 누가 채우는가 — 해결 순서

```
1. code-agent.json 의 plugins 가 그 자리를 선언했나?    아니면 → 기본 구현, 알림 없음
2. 그 이름이 이 PC 에 등록돼 있고 그 자리를 덮나?        아니면 → 기본 구현 + 알림 한 줄
3. 호출 → 실패하면                                      → 기본 구현 + 알림 한 줄 + 로그
```

**선언은 팀 것이고 등록은 개인 것이다.** 개인이 등록해 뒀어도 저장소가 선언하지 않았으면 기본 구현이 돈다 —
개인 등록이 팀 저장소의 `context` 출력을 조용히 바꾸면 재현이 사람마다 갈린다.
반대로 저장소가 선언했는데 등록이 없으면 알림 한 줄과 함께 기본 구현으로 돌고, **작업은 막히지 않는다.**

**플러그인 실패는 명령을 세우지 않는다** — `context`·`survey`·`review`·`check` 는 전부 정상 종료하고 알림 한 줄만 는다.
호출마다 요청 요약·소요·결과가 `.code-agent/log/plugins/<slot>.jsonl` 에 남는다 (마지막 200줄, 키 값은 없다).

### 키와 동의

- `plugin add`·`plugin remove` 는 **TTY 전용**이고 hook 의 사람 전용 목록에 있다 — 모델은 `plugin list` 만 부른다.
  등록은 사람이 동의를 주는 자리라 `approve`·`confirm doc`·`deliver` 와 같은 문을 쓴다.
- 키는 `~/.code-agent/credentials.json` 에만 있고 저장소에는 "어떤 자리에 어떤 플러그인을 쓰는가"만 남는다.
  한 번 쓰고 다시 출력되지 않는다 — `plugin list` 는 `키 등록됨` 만 찍고 길이도 찍지 않는다(길이는 단서다).
- **모델은 그 파일을 읽지도 못한다.** TTY 로 막은 것은 *쓰는* 길뿐이었다 — 평문 키를 디스크에 두면
  `Read ~/.code-agent/credentials.json` 한 번이 그것을 모델의 화면에 그대로 올린다. hook 이 그 자리를
  읽기 도구로도, 그 경로를 가리키는 Bash 로도 막는다. 같은 이유로 문서 세션에서는 선언된 명령을 열지 않는다 —
  거기는 모델이 `code-agent.json` 을 쓸 수 있는 유일한 자리라, 허용 목록을 제 손으로 넓히는 길이 된다.
- **저장소는 어댑터를 고르지 못한다.** 어댑터 이름은 PATH 에서만 찾는다 — 저장소 안 래퍼 우선 규칙
  (gradlew·mvnw)은 매니페스트가 선언한 빌드 명령의 것이고, 개인이 등록한 어댑터에는 키가 실린다.
  클론한 저장소가 루트에 `node.cmd` 하나를 두는 것으로 그 키를 받아 갈 수 있으면 등록의 동의가 뜻을 잃는다.
- **키 전달 방식은 어댑터가 정하고 등록이 기록한다.** `describe` 가 `{"delivery":"stdin"}`(기본) 또는
  `{"delivery":"env","env":"JEV_API_KEY"}` 를 말한다. `plugin add` 에 `--secret-env` 같은 플래그를 두지 않는다 —
  어댑터만이 제 인터페이스를 알고, 사람에게 환경변수 이름을 묻는 것은 사람이 답할 수 없는 질문이다.
  argv 는 프로세스 목록에 보이고 환경변수는 손자 프로세스까지 새기 때문에 **stdin 이 기본**이다.
- 외부로 코드를 보내는 플러그인(`--sends-code` 또는 어댑터가 스스로 밝힌 `sendsCode`)은 등록 때 경고 화면이 뜨고
  **플러그인 이름을 그대로 입력**해야 통과한다. 다만 `sendsCode` 는 **게이트 대상이 스스로 답한 값**이라 그것만으로는
  자료가 못 된다 — `false` 라고 답해도 자리를 여는 순간 경로 목록·요구 항목 문장·컨벤션 규칙은 간다.
  그래서 큰 경고와 이름 입력은 `sendsCode` 에만 두되(힘이 실린 문은 하나여야 한다), **동의 기록은 언제나 남기고**
  등록 화면이 자리마다 무엇이 나가는지 적는다.
- 등록 마지막에 `probe` 를 한 번 보낸다. **실패하면 키도 저장하지 않고 등록하지 않는다** —
  붙지 않는 플러그인을 등록해 두고 매번 실패 한 줄을 보는 일이 없게 하는 문이다.
- 저장 자리는 `CODE_AGENT_HOME` 이 있으면 그 아래, 없으면 `os.homedir()/.code-agent/`.
  `%APPDATA%`·`XDG_CONFIG_HOME` 을 따르지 않는 것은 두 플랫폼이 같은 자리를 쓰는 편이 문서·지원이 싸서다.
  `CODE_AGENT_HOME` 은 테스트가 실제 사용자 홈을 건드리지 않게 둔 knob 이다.

### 판정은 더하기만 한다

- 판정 플러그인은 **CLI 가 부른다**, 모델이 아니라. 쓸지 말지를 모델이 정하면 그 판단에 토큰이 들고 결과가 흔들린다.
  모델이 직접 써야 하는 도구(문서 조회 등)는 MCP 서버로 등록해 `.mcp.json` 에 넣는다.
- `verify.extra` 의 결과는 `check` 의 증거에 **런으로 추가**될 뿐 기존 런을 지우거나 결과를 바꾸지 않는다 —
  **실패한 빌드를 통과로 만드는 길이 원천적으로 닫혀 있다.** 반대 방향은 열려 있어, 플러그인 런이 `failed` 면 막힌다.
  그 불변식은 **사람이 읽는 ⑧ 에서도** 지켜져야 한다. ⑧ 은 증거에서 다시 렌더되므로 바이트 대조 게이트가
  "증거와 문서가 같다"만 볼 뿐 문서가 거짓인지는 못 본다 — 그래서 어댑터가 준 `kind` 는 표 행을 가를 수 없는
  식별자로 묶고, `detail` 안의 울타리는 닫히지 않게 바꾼다. 증거가 옳아도 보고서가 거짓이면 승인하는 사람에게는 같은 일이다.
- **어댑터가 준 문자열은 화면으로 나갈 때 한 줄로 묶이고 목록은 개수가 잘린다.** 자리 출력은 모델이 지시로 읽는
  자리다 — 사람이 고른 것은 어댑터 실행 파일이지 그것이 중계하는 서버가 아니다.
- 그래서 **등록한 사람만 엄격해진다** — 같은 커밋에서 등록자는 막히고 등록하지 않은 팀원은 막히지 않는다.
  자기 PC 에 린터를 하나 더 건 것과 같은 성질이라 의도대로 둔다.
- `review.prefilter` 의 의심 항목은 `code-agent review` 의 **stdout 에만** 실리고 ⑨ 에는 쓰지 않는다.
  지적 표는 모델이 쓰고 회차 구역은 코드가 바이트로 대조하므로, 코드가 지적 표에 쓰면 그 대조가 흔들린다.
- `manifest.plugins` 는 `hashManifest` 에 넣지 않는다 — 경계도 검증 선언도 아니고, 런을 더하기만 하므로
  승인이 본 경계를 넓히지 못한다. **`plugins` 를 더해도 기존 계획 승인은 한 건도 무효가 되지 않는다.**
- `candidates.rank` 의 기본 구현은 ripgrep 이 PATH 에 있어도 **쓰지 않는다** — rg 의 ignore 규칙·유니코드 단어 경계가
  Node 스캔과 달라 같은 저장소에서 사람마다 다른 순위가 나온다. `plugin list` 의 `감지된 무료 도구` 가
  `- ripgrep: 있음 (<경로>) — candidates.rank 는 쓰지 않습니다(사람마다 순위가 갈리지 않게 내장 스캔으로 고정)`
  (없으면 `- ripgrep: 없음 — …`) 로 보고한다.

## 7. 토큰

| 장치 | 효과 | 상태 |
|---|---|---|
| 역공학 두 층 — 뼈대는 얕게, 요구사항 범위만 깊게 | 큰 레거시에서 전체 분석 비용 제거 | P2·P3 ✅ |
| `code-agent context` — 스테이지에 필요한 참조 코드·컨벤션 경로·계획 조각만 | 탐색 제거 (스파이크: 첫 탐색이 `Glob **/*` 로 `.git` 까지 읽음) | P1 ✅ |
| CLAUDE.md 블록 10줄 안팎, 절차는 스킬 | 매 턴 고정 비용 최소 | P1 ✅ |
| 서브에이전트 새 컨텍스트 | 앞 스테이지 대화 누적 없음 | P1 ✅ |
| 메인은 코드를 읽지 않는다 — 작업 폴더 문서·`code-agent` 출력·서브에이전트 결과로만 | 메인 컨텍스트가 작아야 긴 작업이 버틴다 | P3 ✅ |
| explorer 를 요구 항목이 아니라 **닿는 영역별로** · critic 은 계획·분석·작업 문서·계획이 가리키는 파일만 | 같은 저장소를 여러 번 훑지 않는다 (실측: 요구 항목 5개에 explorer 5개가 각자 파일 20~28개를 읽어 조사+계획 $12.58) | P3 ✅ |
| `code-agent context` 의 후보 파일 순위·참고 문서 섹션 — 등록 없이 도는 기본 구현 | explorer 가 저장소를 다시 훑지 않고, 컨벤션·KNOWLEDGE 를 전문으로 읽지 않는다 | P7 ✅ |
| 판정 플러그인 | 파일을 Claude 컨텍스트에 넣지 않고 분류·순위 | 코드 P7 ✅ · 효과는 Jev A/B 로 잰다 (§6 · [plugins.md §8](plugins.md#8-ab-토큰-비교-jev-가-붙으면)) |
| `code-agent usage` | 스테이지·에이전트별 토큰 집계 — 줄었는지는 숫자로 본다. 비용은 **추정**이다(공개 단가표로 곱한 값, 기준일을 출력에 찍는다) | P8 ✅ |

## 8. 배포와 대상 저장소

```
npm install -g <사내 저장소>/code-agent     # 한 번 — Node 22 이상
npm run build:bin → dist-bin/code-agent(.exe)  # 또는 단일 실행 파일 (Node 불필요, OS 별 ~90 MB — install.md)
cd <프로젝트> && code-agent init             # 프로젝트마다 — .claude/ 설치, 버전 고정
code-agent doctor                            # 설치·환경 점검 (✗ 가 없으면 종료 코드 0)
claude  →  /ca-docs  →  (터미널) code-agent confirm doc architecture · conventions · test-strategy · quality
        →  /ca-feature UZRF-145 <요구사항 서술·티켓·파일>   # 접수 — 코드가 requirement.md 를 렌더한다
        →  (터미널) code-agent confirm request UZRF-145     # 원문과 정리를 나란히 읽고 확정
        →  /ca-next  →  (터미널) code-agent approve  →  /ca-next …
```

설치·점검·갱신·지우기의 정본은 [install.md](install.md) 다. **템플릿을 읽는 자리는 `src/agent/assets.ts` 하나**이고 —
npm 설치면 패키지 폴더에서, 단일 실행 파일이면 `node:sea` 의 내장 자원에서 **같은 키**로 읽는다 — 그래서 `init`·`update`·`doctor` 가
두 설치에서 갈리지 않는다. 바이너리는 자기 OS 의 node 를 복사해 만들므로 **OS 별로 따로** 만들고, **만드는 Node 는 24.8 이상**이어야 한다
(`node:sea.getAssetKeys` 가 그 버전에 들어왔다 — 없으면 자원을 못 읽는 바이너리가 나오므로 빌드 스크립트가 막고, 그래도 그런 바이너리가
돌면 `assets.ts` 가 한 문장으로 세운다).

| 대상 저장소에 생기는 것 | 커밋 | 상태 |
|---|---|---|
| `CLAUDE.md` 의 code-agent 블록, `.claude/skills/ca-*`, `.claude/agents/ca-*`, `.claude/settings.json` 의 PreToolUse hook, `.code-agent/version` | O | P1 ✅ |
| `code-agent.json` (`docs.*` · `conventions` 에 문서 경로 등록, `git.base`, 단계 정의 — `kinds` 로 종류별, build · test · **prepare**(선택) · commands · **plugins**(선택, 자리 선언만 — 키는 없다)) | O | P1 ✅ · `prepare` P6 ✅ · `plugins` P7 ✅ |
| 공통 POLICY — `doc/architecture.md` · `doc/conventions.md` (P2 ✅) · `doc/test-strategy.md` · `doc/quality.md` (P4) | O | P2 ✅ · P4 ✅ |
| 공통 KNOWLEDGE — `doc/knowledge/data-dictionary.md` · `api-catalog.md` · `business-rules.md`. 도입 때 빈 뼈대, 반영마다 자란다 | O | P4 ✅ 생성 · P5 ✅ 갱신 |
| `doc/work/<ID>/request.json` — 접수 초안(원문 · 정리 · 접수 때 정한 것). **모델이 쓴다** | O | ✅ |
| `doc/work/<ID>/requirement.md` — 작업 지시서. `<ID>` 는 Jira 키 그대로 (`UZRF-145`). **코드가 `request.json` 에서 렌더하고 사람이 터미널에서 확정한다** (손으로 쓴 지시서도 같은 확정을 지난다 — 다른 자리에 있으면 `confirm request <ID> <지시서>`) | O | P1 ✅ · 접수 ✅ |
| `doc/work/<ID>/questions.md` — 질문과 답 | O | P3 ✅ |
| `doc/work/<ID>/01-requirements.md` · `02-analysis.md` · `03-design.md` · `04-functional.md` — ①~④ (P3 의 `analysis.md` · `current.md` · `data.md` · `api.md` 를 흡수) | O | P4 ✅ |
| `doc/work/<ID>/plan.json` · `05-plan.md` · `07-test-spec.md` — ⑤ 계획(초안 + 코드 렌더) · ⑦ 테스트 명세 | O | P3 ✅ · P4 ✅ |
| `doc/work/<ID>/08-validation.md` · `09-review.md` · `10-pr.md` — ⑧ 검증(코드만) · ⑨ 리뷰(회차 구역은 코드) · ⑩ PR 본문(추적표 구역은 코드) | O | P5 ✅ |
| `doc/work/<ID>/knowledge.proposal.md` — 공통 KNOWLEDGE 갱신 제안. 반영 때 사람이 고른 것만 코드가 upsert | O | P5 ✅ |
| `.code-agent/work/<ID>/<대상>.plan.json` · `<대상>.verify.json` · `<대상>.review.json` — 제출된 계획 · 검증 증거 · 리뷰 회차. 코드만 쓴다 | O | P1 ✅ · P5 ✅ |
| `.code-agent/approvals/` — 확정·승인 원장 (해시 사슬) · 판정 스냅샷. `docs.jsonl`(POLICY) · `<slug(ID)>.jsonl`(계획) · **`<slug(ID)>/request.jsonl`(요구사항 확정·반려)** | O (증거) | P1 ✅ · 접수 ✅ |
| `.code-agent/models.json` — 에이전트별 모델 (바꾼 것만) | O | ✅ |
| `.code-agent/active.json`, `.code-agent/docs-session.json`, `.code-agent/request-session.json`, `.code-agent/log/` | X (`init` 이 `.gitignore` 에 넣는다) | P1 ✅ · 접수 ✅ |

작업 폴더(`doc/work/<ID>/`)는 **모델과 사람이** 쓴다. `.code-agent/` 는 **코드만** 쓴다 — hook 이 모든 도구 쓰기를 막는다.

**커밋을 누가 하는가는 자리마다 다르다** (P6 ✅) — `code-agent deliver` 의 커밋에는 **이 작업의 것만** 담긴다:
계획 파일 · `doc/work/<ID>/` · `.code-agent/work/<ID>/` · `.code-agent/approvals/<slug(ID)>.jsonl` · `.code-agent/approvals/<slug(ID)>/` ·
사람이 고른 KNOWLEDGE 파일. 도입 설정(`.code-agent/version` · `models.json` · `approvals/docs.jsonl`)과 `code-agent.json` · POLICY 4종은
**사람이 도입·설정 때 따로 커밋한다**(`/ca-adopt` 의 마지막 단계). 반영이 `.code-agent` 를 통째로 올리면 다른 작업의 증거와 남의 원장이
이 커밋에 따라 들어와 "검증된 변경 집합만" 이 거짓이 된다.

### 작업 브랜치

`code-agent start` 가 `<종류>/<ID>`(예: `feature/ORD-1`, `fix/BUG-3`)를 기준 브랜치에서 따서 옮긴다. 이미 있으면 전환만 한다.
기준 브랜치는 **사용자 입력(`--base`) > `code-agent.json` 의 `git.base` > `master`** 순이다. git 저장소가 아니면 브랜치를 만들지 않는다.
모델은 브랜치를 바꿀 수 없다 — hook 이 읽기용 git(status·diff·log·show, branch 는 목록 보기만)만 허용한다.

반영은 **로컬 커밋까지**다 — 사람 최종 확인(TTY) 뒤 작업 브랜치에 커밋하고 MR/PR 본문을 `10-pr.md` 로 남긴다.
**push · MR/PR 생성은 하지 않는다.** git 호스트가 붙기 전에는 만들 자리가 없어 보류한 것이고, 붙으면 그때 정한다 (2026-09-29 결정).

작업 문서 중 오래 쓸 가치가 있는 것(새 도메인의 데이터 정의 등)은 반영 스테이지에서 `doc/` 로 올릴지 묻는다.
레거시에 문서가 조금씩 쌓이는 길이 이것이다.

## 9. 명령

### Claude Code 안 (스킬)

| 스킬 | 하는 일 | 상태 |
|---|---|---|
| `/ca-docs [architecture \| conventions \| test-strategy \| quality \| data-dictionary \| api-catalog \| business-rules]` | 프로젝트 필수 문서 점검·작성 — 빠진 문서마다 역공학 / 사용자 입력 / 기존 문서 연결 중 고르게 한다 | P2 ✅ |
| `/ca-adopt` | 레거시 첫 도입 — 뼈대 역공학으로 문서와 `code-agent.json` 까지 | P2 ✅ |
| `/ca-request <ID> [--kind <종류>] <요구사항 서술 · 붙여넣은 티켓 · 파일 경로>` | **접수 단계만** — 원문을 그대로 보관하고 `request.json` 으로 정리해 제출한 뒤, 사람의 터미널 확정 앞에서 멈춘다. 반려 사유를 읽고 다시 정리하는 자리도 여기 | ✅ |
| `/ca-feature <ID> <요구사항 서술 · 티켓 · 파일> [--base <기준>] [--target <대상>]` · `/ca-fix` · `/ca-refactor` | 접수 → (사람 확정) → `start` + 사이클을 5 까지 — 계획을 제출하고 승인 대기에서 멈춤. 종류(`--kind`)를 고르는 것이 이 셋이다. `/ca-fix`·`/ca-refactor` 가 더 지는 것(② 의 현행 분석 · ⑦ 의 `## 재현` · `sequence[0]` · 기존 테스트 보호)은 **전부 코드가 막는다** | P3 ✅ · 종류별 강제 P6 ✅ · 접수 ✅ |
| `/ca-next` | **사이클** — 지금 스테이지의 단계 스킬을 따르고, 사람의 자리가 나올 때까지 다음 단계 스킬로 이어 간다. 작업이 아직 시작 전이고 접수 중이면 거기부터 | P3 ✅ |
| `/ca-analyze` · `/ca-impact` · `/ca-design` · `/ca-plan` | 2 · 3 · 4 · 5 를 하나씩. `/ca-analyze` 는 진행 중인 작업이 없고 접수한 요구사항이 **확정됨** 이면 `code-agent start doc/work/<ID>/requirement.md` 부터, `/ca-plan` 은 게이트가 아니라 터미널 승인에서 멈춘다 (반려 사유를 읽는 자리도 여기) | P5 ✅ |
| `/ca-implement` · `/ca-check` · `/ca-test` · `/ca-review` · `/ca-integrate` | 6 · 7 · 8 · 9 · 10 을 하나씩. `/ca-implement` 는 커서가 `check` 에 닿을 때까지, `/ca-integrate` 는 이어서 ⑩ 을 쓰고 터미널 `deliver` 앞에서 멈춘다 | P5 ✅ |
| `/ca-answer` | 남은 질문을 하나씩 묻고 `questions.md` 에 기록 | P3 ✅ |
| `/ca-status` | 위치·막힌 이유·다음 할 일 | P1 ✅ |

**절차의 출처는 단계 스킬 하나다.** 스테이지가 하는 일은 `/ca-<스테이지>` 스킬에만 적혀 있고, `/ca-next` 사이클도
`/ca-feature`·`/ca-fix`·`/ca-refactor` 도 그 파일을 읽는다 — 단계로 끊어 돌든 사이클로 몰든 도는 내용이 갈리지 않는다.
단계를 나눈 이유는 **단계마다 결과를 보고 보완할 자리를 만드는 것**이다 (2026-09-30 결정).

단계 스킬은 넷을 한다: (1) `code-agent status` 로 자리를 확인하고 (2) 그 스테이지의 일만 하고 (3) `code-agent next` 로 게이트를 지나고
(4) 다음 단계 명령을 찍고 멈춘다. 커서가 그 스테이지가 아니면 일하지 않는다 — 아직 이르면 먼저 할 명령을 알리고,
이미 지났으면 `code-agent back <스테이지>` 를 알린다 (되감기는 **사용자가 되돌리라고 말했을 때만** 돈다).
**↺ 수정 루프**는 `/ca-check` 에 한 벌 있고 `/ca-test`·`/ca-review`·`/ca-integrate` 가 그것을 가리킨다 — 루프가 돌아가는 자리가 `check` 라서다.

### 터미널 (사람)

| 명령 | 하는 일 | 상태 |
|---|---|---|
| `code-agent init [--cli <경로>]` | 이 저장소에 설치 — `.claude/` 스킬·에이전트·hook, CLAUDE.md 블록, `.gitignore`, 버전 고정 | P1 ✅ |
| `code-agent doctor` | 설치·환경 점검 — 런타임 · git · PATH 의 code-agent · git 저장소 · settings.json 이 읽히는지 · hook 2개가 풀리는지 · 버전 스큐 · 스킬·에이전트가 번들과 같은지(없는 것과 다른 것을 갈라 센다) · 이 버전에 없는 `ca-*` · 매니페스트 · POLICY 4종 · 사용자 키 파일 · TTY. 번들을 못 읽어도 **끝까지 찍고** 요약에 닿는다. `✗` 가 없으면 종료 코드 0 ([install.md §4](install.md#4-code-agent-doctor--점검)) | P8 ✅ |
| `code-agent status` | 문서·작업·스테이지·질문·승인 상태와 다음 할 일 | P1 ✅ |
| `code-agent docs` | 프로젝트 필수 문서 — 종류별 있음·섹션·확정 여부 | P2 ✅ |
| `code-agent confirm doc <architecture \| conventions \| test-strategy \| quality>` | 프로젝트 필수 문서 확정 (해시를 원장에, TTY 에서만) | P2 ✅ |
| `code-agent confirm request <ID> [<지시서>]` · `reject request <ID> [<지시서>] --comment <사유>` | **요구사항 확정·반려** (TTY 에서만) — 지시서를 통째로 띄워 원문과 정리를 나란히 읽히고, **보여 준 바이트**의 해시로 판정을 `approvals/<slug(ID)>/request.jsonl` 에 남긴다(읽는 사이에 바뀌었으면 아무것도 남기지 않는다). 지시서를 생략하면 그 ID 가 진행 중인 작업이면 그 작업의 지시서, 아니면 `doc/work/<ID>/requirement.md` — 다른 자리에 손으로 쓴 지시서는 경로를 함께 준다. 확정해야 `start` 가 받는다. 확정 뒤 내용이 바뀌면 다시 확정한다 | ✅ |
| `code-agent approve` · `reject --comment <사유>` | 계획 + 작업 문서 판정 (계획·가정 표시, 반려 사유 필수, TTY 에서만) | P1 ✅ |
| `code-agent abort` | 진행 중인 작업 커서 지우기 (작업 폴더·계획·원장은 남는다). 작업이 없으면 **접수 세션을 닫는다** — 작업 폴더와 확정 원장은 남아 같은 ID 로 다시 접수할 수 있다 | P1 ✅ · 접수 ✅ |
| `code-agent deliver` | 11 반영 — 게이트 재검사 · ⑩ 의 코드 구역 렌더 · TTY 확인 · KNOWLEDGE 항목 선택 · 작업 브랜치에 **로컬 커밋**. push·MR/PR 없음 | P5 ✅ |
| `code-agent model [<에이전트\|all> <모델>]` | 에이전트별 모델 보기 · 바꾸기 (바꾸기는 TTY, 기본 opus) | ✅ |
| `code-agent usage [--work <ID>] [--since <날짜>]` | 스테이지·에이전트별 토큰 집계 — Claude Code 기록(`~/.claude/projects/<인코딩한 경로>`)을 읽고 `.code-agent/log/stages.jsonl` 의 전이로 구간을 가른다. 비용은 추정 | P8 ✅ |
| `code-agent knowledge` · `knowledge prune` | 공통 KNOWLEDGE 항목과 그것을 마지막으로 넣은 작업(git 이력에서 복원) · 근거 경로가 전부 사라진 항목을 사람이 골라 지우기 (`prune` 은 TTY, 자동 삭제 없음) | P8 ✅ |
| `code-agent plugin example [--out <경로>]` | 번들에 든 예시 어댑터를 파일로 꺼낸다 — 어댑터는 `node <경로>` 로 도는 파일이라 단일 실행 파일만 받은 PC 에도 꺼낼 자리가 있어야 한다 | P8 ✅ |
| `code-agent plugin add <이름> --command "<argv>" [--slots a,b] [--sends-code]` · `plugin remove <이름>` | 이 PC 에 플러그인 등록·해제 — `describe` → 동의(코드를 보내면 이름 입력) → 키 → `probe`. 키·동의는 `~/.code-agent/credentials.json` 에만 (TTY 에서만) | P7 ✅ |
| `code-agent update [--cli <경로>]` | 지금 도는 버전의 스킬·에이전트·hook 을 다시 설치 — 보존은 `init` 이 하던 그대로(다른 hook · 블록 밖 · `models.json` 오버라이드)이고 `--cli` 는 승계한다. 이 버전에 없는 `ca-*` 가 남아 있으면 알린다(지우지는 않는다). 작업 중에도 돌고 **막지 않고 경고만** 한다 · TTY 불필요 | P8 ✅ |

### 스킬·hook 이 부른다

| 명령 | 하는 일 | 상태 |
|---|---|---|
| `code-agent request begin <ID> --kind <feature \| fix \| refactor> [--base <기준 브랜치>] [--target <대상>]` | **1 요구사항 접수를 연다** — 접수 세션을 만들고(도는 동안 그 작업 폴더 밖 쓰기 금지) 초안 형식 · 프로젝트 확장 속성 · 대상 후보를 찍는다. ID 는 사람이 준 것만 받는다 (형식 검사). `--base`·`--target` 은 세션에 남아 **확정 뒤 `start` 가 이어받는다** — `code-agent status` 가 `시작할 때 기준 브랜치 … · 대상 …` 으로 보여 준다 | ✅ |
| `code-agent request` | 접수 초안 형식 · 규칙 · 대상 후보 · 지금 상태. **작업 중에도 같은 것을 준다** — 이미 시작한 작업의 요구사항을 고칠 때 초안 형식이 필요하다(그때 `code-agent context` 는 스테이지 컨텍스트를 준다). 접수도 작업도 없으면 접수를 열라고 세운다 | ✅ |
| `code-agent request submit <request.json>` | 접수 초안 검사 → `doc/work/<ID>/requirement.md` 렌더 — 스키마 · **손으로 쓴 지시서와 같은 지시서 검사** · 머리말 왕복 대조. 확정은 사람이 한다. 작업이 시작된 뒤에도 같은 ID 면 다시 제출할 수 있다(확정이 풀린다). **반려된 내용 그대로면 거부**하고 사유를 다시 찍는다 | ✅ |
| `code-agent start <지시서> [--target <대상>] [--base <기준 브랜치>]` | 작업 시작 — 문서 게이트 확인, **요구사항이 지금 내용 그대로 확정됐는지** 확인, 작업 브랜치, 작업 폴더. 접수 때 말한 `--base`·`--target` 을 이어받는다(여기서 직접 준 값이 이긴다). 시작하면 접수 세션을 지운다 | P1 ✅ · 확정 게이트 ✅ |
| `code-agent next` | 게이트를 확인하고 다음 스테이지·단계로 | P1 ✅ |
| `code-agent back <스테이지>` | 커서를 **이전** 스테이지로만 되감는다 (`analysis`…`integrate`). 앞으로는 못 가고, `deliver` 에서는(사람의 자리) 되감지 않으며, 진행 중인 작업이 없으면 거부한다. 증거·승인 원장·작업 문서는 그대로 두고 커서만 움직이며(`implement` 로 가면 계획의 첫 단계로), **무엇이 무효가 되는지 함께 찍는다** | P5 ✅ |
| `code-agent context` | 지금 스테이지에 필요한 것 — 경로 · 형식 · 참조 표준 코드 · 단계 규칙. 아직 커서가 없고 접수 중이면 접수 컨텍스트를 준다(그것만 다시 보려면 `code-agent request`) | P1 ✅ |
| `code-agent plan submit <초안.json>` | 계획 검사 후 제출 | P1 ✅ |
| `code-agent repro` | 재현 (**`fix` 전용** — 스테이지가 아니라 `implement` 안에서 돈다) — `kind:"test"` 단계 파일만 바뀐 트리에서 테스트 명령을 돌려 재현 TC 의 **실패**를 확인하고 증거에 적는다. 이것을 통과해야 고칠 파일 쓰기가 열리고, 그 순간 테스트가 언다 | P6 ✅ |
| `code-agent check` | 7 정적 분석·컴파일 — `build` + 품질·보안 기준의 명령을 돌려 증거에 기록하고 ⑧ 을 렌더 | P5 ✅ |
| `code-agent test` | 8 테스트 — `test` + 테스트 전략의 명령을 돌리고 ⑦ 의 TC id 를 대조 | P5 ✅ |
| `code-agent review` | 9 코드 리뷰 — 회차를 열어 기준 트리 해시를 굳히고 ⑨ 의 회차 구역을 렌더 | P5 ✅ |
| `code-agent integrate` | 10 통합 검증 — 기준 커밋 위의 깨끗한 worktree 에서 (`prepare` 가 있으면 그것 먼저) 전체 `build`·`test` | P5 ✅ · `prepare` P6 ✅ |
| `code-agent docs begin \| end` | 문서 작성 세션 (도는 동안 문서 자리 밖 쓰기 금지). 요구사항을 접수 중이면 열지 않는다 | P2 ✅ |
| `code-agent docs skeleton <종류>` | 빈 문서의 섹션 뼈대 — POLICY 4종(`architecture` · `conventions` · `test-strategy` · `quality`) · `knowledge`(KNOWLEDGE 3종을 한 번에) · KNOWLEDGE 낱개(`data-dictionary` · `api-catalog` · `business-rules`) · 작업 문서(`01-requirements` · `02-analysis` · `03-design` · `04-functional` · `07-test-spec`) | P2 ✅ |
| `code-agent docs interview <종류> [--sections a,b]` | 사용자 입력으로 채울 때 묻는 것 | P2 ✅ |
| `code-agent docs link <종류> <경로...>` | 이미 있는 문서를 등록. 요구사항을 접수 중이면 거부한다 (`docs begin` 과 같은 문 — 근거 문서와 그 자리는 접수·작업 도중에 바꾸지 않는다) | P2 ✅ · 접수 ✅ |
| `code-agent survey` | 뼈대 역공학용 저장소 개요 — 빌드·언어·구조·계층 후보·표본 | P2 ✅ |
| `code-agent manifest check` | `code-agent.json` 이 실제 참조 파일을 찾는지 | P2 ✅ |
| `code-agent plugin list` | 자리 · 기본 구현 · 감지된 무료 도구 · 이 PC 의 등록 · 저장소 선언 · 지금 무엇이 채우는가. **읽기만 한다** — `add`·`remove` 는 사람의 터미널 명령이다 | P7 ✅ |
| `code-agent hook` | PreToolUse 판정 (stdin JSON → deny 사유) | P1 ✅ |
| `code-agent stop` | Stop 판정 (stdin JSON) — 계획 밖 변경·답 없는 질문을 턴 끝에 한 번 | P5 ✅ |

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
| `core/build.ts` | 매니페스트의 `build` · `test` · `commands` 에 선언한 명령 실행 (`runCommand` 만 — `verifyByBuild` 는 커밋을 검증하므로 쓰지 않는다. `integrate` 는 worktree 를 직접 만든다) | `check` · `test` · `integrate` ✅ |

매니페스트는 넓힌다 — 지금은 "도메인 디렉토리 + 계층" 레이아웃을 전제하지만, 경계의 중심은 **승인된 계획의 파일 목록**이다.
계층 `outputDirs` 는 선언한 프로젝트에서만 추가로 건다. 그래야 레이아웃이 다른 프로젝트에서도 쓸 수 있다.

## 11. 구현 순서

| 단계 | 내용 | 완료 기준 | 상태 |
|---|---|---|---|
| P1 뼈대 | CLI(`init` `hook` `start` `context` `plan submit` `approve` `status` `next` `abort`), `.claude/` 템플릿(CLAUDE.md 블록·hook·스킬·에이전트 정의), 작업 폴더 구조, 작업 브랜치 | 스파이크 판정 13개를 테스트로 이관해 통과, 테스트 저장소에서 `init` → `/ca-status` | ✅ |
| P2 프로젝트 문서 | 문서 스키마(아키텍처·컨벤션), `code-agent docs`·`confirm doc`, `/ca-docs` 의 세 경로, 뼈대 역공학(`survey`·surveyor), `/ca-adopt` | 필수 문서 없는 저장소에서 진행이 거부되고, 레거시 1개는 뼈대 역공학으로·빈 저장소 1개는 인터뷰로 두 문서가 만들어져 게이트 통과 | ✅ |
| P3 분석·범위 조사·계획 | analyst(작업 문서 판정), explorer(범위 역공학), writer(작업 문서), critic, 질문·가정 갈래, 요구 항목 커버리지 검사 | 레거시 저장소에서 데이터 정의 없이 시작해 요구사항 범위 작업 문서가 생기고 승인 가능한 계획까지, 토큰 기준치 기록 | ✅ |
| P4 문서 모델 전환 + 영향도·설계 | **한 번에 전환한다.** POLICY 2 → 4(테스트 전략 · 품질·보안 기준 스키마, 명령 이름 대조, `/ca-docs` 의 기본/대화 선택, survey 의 도구 후보) · KNOWLEDGE 3종 경로 등록 + 빈 뼈대 · 작업 문서를 번호 문서로(01 ← analysis.md, 02 ← current.md + 영향도·Risk, 03 ← data.md · api.md + 구성 요소·흐름·결정, 04 신규, 07 신규, 05 렌더) · 스테이지 `research` → `impact` · `design` · 게이트(영향 표의 R 전량 · R 마다 AC · 모든 AC 가 TC 에) · 승인 묶음을 고정 목록(지시서 본문 · 01 · 02 · 03 · 04 · 07)으로 | 레거시에서 POLICY 4종을 확정하고, 공통 모듈을 건드리는 요구가 02 에 드러나고, 03·04 를 거쳐 07 이 모든 AC 를 덮은 계획이 승인된다. KNOWLEDGE 는 빈 채로 막지 않는다. P3 대비 토큰을 다시 잰다. **기존 계획 승인은 전부 무효가 된다** (docsHash 계산식이 바뀜) | ✅ |
| P5 단계 1 증거 코어 | 기준 커밋 고정(`ActiveWork.baseCommit`) · `tree.ts`(변경 목록 · 부분 트리 해시) · 스테이지 `check`·`test`·`review`·`integrate`·`deliver` · `code-agent check`·`test`(증거 `verify.json` · ⑧ 렌더 · 계획↔트리 사전 대조 · 회차) · 수정 루프(`fixRounds`, 기본 2) · 테스트 동결(`kind: "test"`) · Stop hook | ⑧ 이 코드로만 쓰이고, 증거가 트리·매니페스트·계획에 묶이고, 한도를 넘기면 hook 이 막는다 — 전부 테스트로 | ✅ |
| P5 단계 2 리뷰·통합·반영 | ⑨ `09-review.md`(코드가 쓰는 회차 구역 · 마지막 회차 트리 해시 == 지금 · 범위는 코드가 판정) · `integrate`(기준 커밋 + 변경 파일만 얹은 깨끗한 worktree 에서 전체 build·test) · `deliver`(TTY 확인 → ⑩ `10-pr.md` 추적표 렌더 → **로컬 커밋까지**. push·MR/PR 없음) · KNOWLEDGE upsert · 테스트 동결의 두 번째 탈출구(⑨ 의 지적) | 실제 프로젝트에서 feature 한 건을 로컬 커밋까지 완주 (첫 실측) | 코드 ✅ (리뷰 지적 반영) · 실측 |
| P6 fix·refactor · 신규 저장소 | ② 현행 분석 필수(`해당 없음` 불가 · 근거 `path:line`) · ⑦ 의 `## 재현` 절과 `code-agent repro`(증거 `Evidence.repro`, 재현 전 쓰기 거부, 재현 뒤 테스트 동결) · `sequence[0]` 이 테스트 단계 · refactor 의 기존 테스트 파일 보호(제출·쓰기·검증 세 자리) · `stages[].kinds` 종류별 단계와 `manifest check` 경고 · 빈 저장소 감지(`survey`)와 참조 없는 `context` · `deliver` 커밋 범위 제한 · `integrate` 의 `prepare` | 각 한 건 완주, 빈 저장소에서 feature 시작 | 코드 ✅ · 완주 실측 |
| P7 플러그인 | 자리 6개 · 버전 있는 명령 어댑터 계약(stdin JSON → stdout JSON, `describe`·`probe`·`run`) · `plugin list/add/remove`(등록은 TTY·동의·`probe`, 키는 사용자 스토어) · 무료 도구 감지 · 기본 구현 둘(내장 키워드 스캔 · 제목 매칭) · `code-agent.json` 의 `plugins` 선언(해시 중립) · 호출 로그 — **등록한 사람만 opt-in**, 실패하면 기본 구현 + 한 줄 | Jev 켜고/끄고 같은 저장소 A/B 토큰 비교 | 코드 ✅ · **A/B 는 실제 Jev 가 붙어야 잰다** (절차: [plugins.md §8](plugins.md#8-ab-토큰-비교-jev-가-붙으면)) |
| P8 정리·배포 | 단일 실행 파일(Node SEA — 템플릿을 자원으로 안고 `assets.ts` 한 자리에서 읽는다) · `doctor` · `update` · `usage` · `knowledge`/`prune` · 죽은 코드 정리와 매니페스트 `[]` 함정 차단(해시 중립) · 문서 세트(README → [install.md](install.md) · 이 문서 · [usage.md](usage.md) · [requirement.md](requirement.md) · [plugins.md](plugins.md)) | 다른 개발자가 혼자 설치부터 반영까지 | ✅ |
| 요구사항 접수 | 13단계의 1 을 프로세스 안으로 — `code-agent request begin`·`submit`(접수 세션 · `request.json` → `requirement.md` 렌더 · 지시서 규격 재사용) · `confirm request`·`reject request`(TTY · 해시 사슬 원장) · 모든 진행 명령의 확정 게이트(`requireRequestConfirmed`) · `/ca-request` 와 `/ca-feature`·`/ca-fix`·`/ca-refactor` 의 인자 전환(`<ID> <요구사항>`) · 적대적 리뷰 반영(확정에 지시서 경로 인자 · 접수 시작 인자(`--base`·`--target`) 승계 · 보여 준 바이트로 해시 · 반려본 재제출 거부 · ID+지시서로 판정 · `requireVerifiedApproval` 적용 · 세션 밖에서도 도는 hook) | 사람이 지시서 규격을 몰라도 말로 요구사항을 주면 작업이 시작되고, 확정하지 않은 요구사항 위에서는 아무것도 진행되지 않는다 | ✅ (2026-10-01) |

**P8 뒤로 남은 것** (코드가 아니라 실측·결정이 필요한 것들이다)

- **주인이 직접 처음부터 끝까지 한 건 완주** — P5·P6 에 이미 걸려 있는 그 자리다. 코드로 대신할 수 없다.
- **실제 Jev 플러그인으로 A/B 토큰 비교** — 절차는 [plugins.md §8](plugins.md#8-ab-토큰-비교-jev-가-붙으면).
- **프런트엔드 제품 방향 결정** — 지금은 CLI + Claude Code 뿐이다.
- **push · MR/PR** — git 호스트가 붙으면 그때 정한다 (2026-09-29 보류 결정). ⑩ 이 쓸 본문을 이미 들고 있다.
- **⑦ 대조의 TC 수준 출력 파싱** — 실행 출력에서 TC id 를 읽는 일은 프레임워크마다 형식이 달라 일반적으로 되지 않는다 (아래 "알고 남긴 한계").
- **플러그인 어댑터가 남긴 손자 프로세스까지 묶는 제한 시간** — [plugins.md §9](plugins.md#9-한계).
- **`usage` 의 `agentType` 문자열** — 지금 관측된 것은 내장 에이전트(`Explore`) 뿐이다. `ca-implementer` 같은 프로젝트 에이전트가 어떤 문자열로 오는지는 **한 건 돌려 봐야** 확정된다. 코드는 값을 그대로 쓰고 모르는 값을 버리지 않는다.

**P5 뒤로 미룬 것**

- **반영의 원장 줄** — 지금 `deliver` 의 TTY 확인은 **커밋 자체**가 기록이다(증거 파일·⑧⑨⑩ 이 그 커밋 안에 들어간다). 원장(`.code-agent/approvals/`)에는 계획 승인만 쌓인다 — 반영 줄을 더하려면 `ApprovalRecord` 에 종류 축을 넣고 `checkApproval`·`recordDecision` 의 `stage === undefined` 필터를 함께 고쳐야 해서, 그 자리를 건드리는 값이 확인될 때까지 미룬다.
- **⑨ 의 `요구 충족` 절** — AC 마다 충족/근거를 적는 절은 넣지 않았다. 같은 대조를 ⑩ 의 추적표가 **코드로** 하고 있어(R → AC → 파일 → TC → 검증, 빈 칸이면 반영 거부), 모델이 쓰는 두 번째 사본을 두면 둘이 갈릴 때 어느 쪽이 사실인지가 모호해진다.
  스킬·에이전트 템플릿과 `usage.md` 는 이 절을 쓰라고 시키고 있었는데(코드는 읽지도 않는다), 2026-09-29 리뷰에서 걷어냈다 — 문서 하나에 출처가 둘이면 어느 쪽도 근거가 되지 않는다.
- **매니페스트의 `kind: "verify"` · 단계의 `expect` 는 죽은 선언이다** — 코드가 한 번도 읽지 않는다(스키마 정의와 에이전트 문장뿐). 걱정하던 "fix 스타터는 두 단계가 모두 `verify`" 는 그런 스타터가 이 트리에 없어 P6 시작 시점에 이미 무효였다. 그런데 둘 다 `hashManifest` 안이라 **지우면 기존 승인이 전부 무효가 된다** — 해시 중립이 아니어서 P6 범위 밖으로 둔다. fix 의 재현 표시는 `expect` 가 아니라 ⑦ 의 `## 재현` 절이 맡는다.
- **MR/PR** — `deliver` 는 로컬 커밋에서 끝난다. push·MR/PR 생성은 git 호스트가 붙을 때 정한다(2026-09-29 결정). ⑩ 이 그때 쓸 본문을 이미 들고 있다.

**알고 남긴 한계** (2026-09-29 리뷰에서 재현해 두고 고치지 않기로 한 것)

- **⑦ 대조의 두 번째 갈래** — 실행 출력에 TC id 가 없으면 `kind:"test"` 단계의 계획 파일에 그 id 가 **있기만 하면** 확인으로 센다. `// TC-1 · TC-2` 한 줄짜리 파일도 통과한다. 출력 파싱은 프레임워크마다 형식이 달라 일반적으로 되지 않아 둔 갈래이고(§3), 강제력은 `build`·`test` 가 실제로 도는 것과 테스트 동결이 든다.
- **작업 폴더는 사람이 읽는 묶음이다** — `deliver` 의 커밋은 `doc/work/<ID>/` 를 통째로 올리므로 모델이 그 아래 떨어뜨린 파일도 함께 커밋된다. 감춰지지는 않는다: `## 변경 요약` 이 기준 커밋 대비 전 목록을 확인 화면에 싣고, 그 밖의 계획 밖 변경은 `outsideChanges` 가 막는다. "검증된 변경 집합만" 은 **코드**에 대한 보증이다.
- **KNOWLEDGE 3종은 계획 밖 변경 대조에서 빠진다** — `deliver` 가 사람이 고른 항목을 코드로 적용하는 자리라 모델이 쓸 수 없고(hook), 넣어 두지 않으면 커밋이 실패했을 때 적용본만 남아 다시 반영할 길이 영영 막힌다.

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
