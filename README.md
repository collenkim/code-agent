# code-agent

> 최근 변경·검증·알려진 한계: [2026-10-01 최종 보완 기록](doc/reviews/2026-10-01-validation-review-improvements.md). 사용 방법은 [사용 가이드](doc/usage.md), 설치·갱신은 [설치 문서](doc/install.md).

**요구사항을 받아 코드를 쓰는 에이전트다.** Claude Code **안에서** 돈다 — 모델이 도구를 직접 쓰고, 절차는 스킬(`.claude/skills/ca-*`)과 서브에이전트 정의(`.claude/agents/ca-*`)에, 강제는 PreToolUse hook 과 `code-agent` CLI 에 있다. 근거가 되는 공통 POLICY 문서 4종(아키텍처·코드 컨벤션·테스트 전략·품질·보안 기준)이 사람 손으로 확정되기 전에는 작업이 시작되지 않고, 계획이 사람의 터미널에서 승인되기 전에는 코드가 한 줄도 써지지 않는다. **요구사항도 명령으로 받는다** — 사람이 말로 준 서술·티켓·파일을 모델이 원문 그대로 보관해 정리하면 코드가 지시서(`requirement.md`)를 렌더하고, 사람이 터미널에서 확정한 것만 분석이 받는다. 모호한 것은 지어내지 않고 `questions.md` 로 막는다. 서브에이전트는 기본이 전부 opus 이고, 사람이 `code-agent model` 로 바꿀 수 있다.

## 문서 모델

| 층 | 문서 | 코드가 보는 것 | 승인 해시 | 상태 |
|---|---|---|---|---|
| **공통 POLICY** | `doc/architecture.md` · 컨벤션(`conventions[]`) · `doc/test-strategy.md` · `doc/quality.md` | 파일 + 필수 섹션 + **사람 확정** | 예 | ✅ (4종) |
| **공통 KNOWLEDGE** | `doc/knowledge/` 의 데이터 사전 · API 목록 · 업무 규칙·용어집 | **파일 존재만** | 아니오 | 생성 ✅ · 갱신 ✅ (`deliver` 에서 사람이 고른 항목만) |
| **작업 문서** | `doc/work/<ID>/` 의 번호 문서 | 문서마다 다르다 | 6개 | 아래 흐름 표 |

**막는 것은 POLICY 4종뿐이다.** KNOWLEDGE 는 비어 있어도 작업을 막지 않는다 — 도입 때 빈 뼈대로 만들고 반영마다 그 작업 범위만 자란다.
지시서(`requirement.md`)는 **접수 때 사람이 따로 확정**하고, 나머지 작업 문서는 따로 확정받지 않고 **계획과 한 묶음으로 승인된다** (지시서 본문 · `01` · `02` · `03` · `04` · `07`).

## 목표 흐름

사용자에게는 **준비 → 요구 확인 → 계획 확인 → 개발·검증 → 결과 확인**으로 안내한다. 기존 언어·프레임워크·테스트 도구는 재사용한다. 준비와 요구사항 적합성 검토에서는 테스트를 실행하지 않으며, 구현 후 기존 명령으로 실행한 결과를 요구사항에 연결한다. 버그 수정은 구현 전에 실패 재현을 먼저 확인한다. 아래 표는 에이전트 내부 절차다.

2026-09-29 확정. 스테이지(`key`)는 이 흐름을 그대로 딴다. 1번 요구사항은 2026-10-01 에 **명령으로 받는 접수**가 됐다 — 사람이 손으로 `requirement.md` 를 쓰던 자리다.

| # | 단계 | 하는 일 | 지금 |
|---|---|---|---|
| 1 | 요구사항 접수 | `/ca-feature <ID> <요구사항>`(또는 `/ca-request`) → `code-agent request begin <ID> --kind <종류> [--base <기준 브랜치>] [--target <대상>]` → 모델이 `request.json` 으로 정리 → `code-agent request submit` 이 `doc/work/<ID>/requirement.md` 를 렌더(머리말 `kind`·`id`·`title`·`target` + 원문 그대로) → **사람 확정(터미널)**. 접수 때 받은 `--base`·`--target` 은 접수 세션(`.code-agent/request-session.json`)에 남아 확정 뒤 `start` 가 쓴다 — 사람의 확정이 끼어 명령이 끊겨도 잃지 않는다 (`start` 에 직접 준 값이 이긴다) | ✅ |
| 2 | 요구사항 분석·명세화 `analysis` | ① `01-requirements.md` — 요구 항목 `## R<n>`(각각 `근거:`) · `## 가정` · `## 범위 밖` · 질문 | ✅ |
| 3 | 영향도 분석 `impact` | ② `02-analysis.md` — 기존 시스템 분석 · 영향 범위 표(**모든 R**) · Risk. 모든 작업 필수 | ✅ |
| 4~5 | 시스템 설계 + 기능·API·데이터 정의 `design` | ③ `03-design.md`(구성 요소·흐름·API·데이터·설계 결정) + ④ `04-functional.md`(기능·업무 규칙·예외·**AC**) | ✅ |
| 6 | 구현 계획 `plan` | ⑤ `plan.json`(+`sequence`·`approach`) → 코드가 `05-plan.md` 렌더 + ⑦ `07-test-spec.md`(AC 마다 TC) → **사람 승인(터미널)** | ✅ |
| 7 | 코드 생성 `implement` | 단계마다 새 컨텍스트에서 `ca-implementer`. `fix` 는 테스트 단계가 먼저이고 `code-agent repro` 로 재현을 본 뒤에 고친다 | ✅ |
| 8 | 정적 분석·컴파일 `check` | 품질·보안 기준이 적은 명령 + build → ⑧ `08-validation.md` (코드만 쓴다) | ✅ |
| 9 | 테스트 생성·실행 `test` | `ca-tester` 가 ⑦ 의 TC 만 쓰고 CLI 가 돌린다 · 이후 테스트 동결 | ✅ |
| 10 | 결과 분석 | 실패를 파일·요구 항목으로 묶는다 | ✅ |
| ↺ | 수정 | 계획 안이면 고치고 **8 부터 다시** (기본 2회 — `code-agent check` 가 뒤 스테이지에서 불려도 그 자리로 되감는다). 계획 밖이면 질문 또는 재승인 | ✅ |
| 11 | 코드 리뷰 `review` | 독립 `ca-reviewer`의 실행·완료를 hook이 관찰하고 지적 표를 ⑨에 기록한다. 결과·코드 상태를 대조한 뒤 지적은 수정 루프로 | ✅ |
| 12 | 통합 검증 `integrate` | 기준 커밋에서 뜬 깨끗한 worktree 에 계획 파일만 얹고 전체 build · test | ✅ |
| 13 | 반영 `deliver` | ⑩ `10-pr.md` — 추적표·변경 요약 → **사람 최종 확인(터미널)** → 작업 브랜치 로컬 커밋. KNOWLEDGE 3종이 여기서 자란다. push · MR/PR 생성은 하지 않는다(git 호스트가 붙을 때까지 보류) | ✅ |

(⑥ Code 는 소스 코드 자체다 — `06-` 파일은 없다.)

스테이지마다 명령이 하나씩 있다. **`/ca-next` 는 그 명령들을 이어 도는 사이클**이고, `deliver` 앞에서 멈춰 **사람에게 터미널을 넘긴다**.
P4 의 `verify` 한 칸은 `check` · `test` · `review` · `integrate` · `deliver` 다섯으로 갈렸다.

### 단계별 명령

절차는 단계 스킬 **하나**에만 있다 — 단계 명령으로 가든 `/ca-next` 사이클로 가든 읽는 파일이 같다.
단계마다 끊으면 그 자리에서 결과를 보고 고친 뒤 다음으로 갈 수 있다.

| 스테이지 | 명령 | 하는 일 | 어디서 멈추나 |
|---|---|---|---|
| (접수) | `/ca-request <ID> --kind <종류> <요구사항>` | 원문 보관 → `request.json` 정리 → `request submit` 이 지시서 렌더 | **터미널 `code-agent confirm request <ID> [<지시서>]`** |
| `analysis` | `/ca-analyze` | ① `01-requirements.md` (진행 중인 작업이 없고 접수한 요구사항이 확정돼 있으면 `code-agent start` 부터) | 질문 · `next` 통과 |
| `impact` | `/ca-impact` | ② `02-analysis.md` — explorer 병렬 → writer | 질문 · `next` 통과 |
| `design` | `/ca-design` | ③ `03-design.md` · ④ `04-functional.md` | 질문 · `next` 통과 |
| `plan` | `/ca-plan` | ⑤ `plan.json` · ⑦ `07-test-spec.md` → critic → `plan submit` | **터미널 `code-agent approve`** |
| `implement` | `/ca-implement` | 계획의 단계마다 implementer·tester, 커서가 `check` 에 닿을 때까지 | 계획 밖 · 질문 · `check` 도달 |
| `check` | `/ca-check` | `code-agent check` (build + 정적 분석·보안) · **↺ 수정 루프의 정의가 여기 있다** | 실패 · `next` 통과 |
| `test` | `/ca-test` | tester 가 ⑦ 의 TC 만 → `code-agent test` (이후 테스트 동결) | 실패 · `next` 통과 |
| `review` | `/ca-review` | 독립 reviewer 호출 → hook이 ⑨에 결과 기록 | 실행 기록 · 열린 지적 · `next` 통과 |
| `integrate` | `/ca-integrate` | `code-agent integrate` + ⑩ `10-pr.md` 의 모델 구역 | **터미널 `code-agent deliver`** |

접수는 작업 커서가 생기기 **전**이라 스테이지 번호가 없다 — 문서 작성 세션처럼 접수 세션(`.code-agent/request-session.json`)으로 돌고, `code-agent status` 가 그 자리를(접수 때 받아 둔 `시작할 때 기준 브랜치 … · 대상 …` 까지) 보여 준다.
`code-agent request`(서브명령 없이)는 접수 형식·규칙·대상 후보·지금 상태를 찍는다 — **작업이 시작된 뒤에도** 그렇다(요구사항을 고칠 때 필요한 것이 그 형식이다). `code-agent context` 는 접수 중이면 같은 것을, 작업 중이면 그 스테이지의 컨텍스트를 준다 — 둘은 이제 같은 명령이 아니다.

**사이클** — `/ca-feature`(= 접수 + 확정 뒤 `start` + `plan` 까지) · `/ca-fix` · `/ca-refactor` 로 시작하고, `/ca-next` 로 사람의 자리가 나올 때까지 이어 돈다.
잘못 온 자리는 `code-agent back <스테이지>` 로 **뒤로만** 되감는다 — 앞으로는 못 가고, 무엇이 무효가 되는지(예: `design` 이하로 가서 문서를 고치면 계획 승인이 `stale-docs`) 명령이 찍는다.
증거는 `planHash` 에 묶여 있어 되감아도 수정 회차는 초기화되지 않는다.

| 단계 | 내용 | 상태 |
|---|---|---|
| P1 뼈대 | CLI · PreToolUse hook · `.claude/` 템플릿 · 작업 폴더 | ✅ |
| P2 프로젝트 문서 | 문서 스키마 · `docs` · `confirm doc` · `/ca-docs` · `/ca-adopt` | ✅ |
| P3 분석·조사·계획 | analyst · explorer · writer · critic · 질문 루프 · `plan submit` · `approve` | ✅ |
| P4 문서 모델 전환 + 영향도·설계 | POLICY 2 → 4 · KNOWLEDGE 3종 빈 뼈대 · 작업 문서를 번호 문서(`01`~`04`·`07`, `05` 는 코드 렌더)로 · `impact` · `design` 스테이지 | ✅ |
| P5 단계 1 증거 코어 | 8·9·10 · 수정 루프 · 테스트 동결 · Stop hook · 기준 커밋·부분 트리 해시에 묶인 증거 | ✅ |
| P5 단계 2 리뷰·통합·반영 | 11~13 · ⑨⑩ · KNOWLEDGE 갱신 · 로컬 커밋 | ✅ |
| P6 fix·refactor·신규 저장소 | 재현 테스트 우선(`code-agent repro`) · 기존 테스트 보호 · 종류별 단계(`stages[].kinds`) · 빈 저장소 도입 · `deliver` 커밋 범위 · `integrate` 의 `prepare` | 코드 ✅ · 완주 실측 |
| P7 플러그인 | 자리(slot) 6개 · 명령 어댑터 계약(stdin JSON → stdout JSON) · `plugin list/add/remove` · 기본 구현 — 등록한 사람만 opt-in ([`doc/plugins.md`](doc/plugins.md)) | 코드 ✅ · Jev A/B 실측 |
| P8 정리·배포 | 문서 세트 · 단일 실행 파일 · `doctor` · `update` · `usage` · `knowledge` ([`doc/install.md`](doc/install.md)) | ✅ |

## 설치

```
npm install -g <이 저장소 경로>              # 한 번 — Node 22 이상
cd <프로젝트> && code-agent init             # 프로젝트마다
```

Node 를 깔 수 없는 PC 는 **단일 실행 파일**을 쓴다 — 이 저장소에서 `npm run build:bin` 이 `dist-bin/code-agent(.exe)` 를 낸다 (OS 별, ~90 MB).
설치 두 가지 · 바이너리 만들기와 서명 · `init` · `doctor` · `update` · 지우기는 [`doc/install.md`](doc/install.md).
code-agent 자체를 고치면서 쓸 때는 `npm link` + `code-agent init --cli <이 저장소>/dist/agent/cli.js`.

`init` 이 대상 저장소에 만드는 것 — 전부 커밋해 팀과 공유한다.

| 자리 | 내용 |
|---|---|
| `.claude/skills/ca-*` · `.claude/agents/ca-*` | 절차와 서브에이전트 정의 (`template/` 사본) |
| `.claude/settings.json` | PreToolUse → `code-agent hook` · Stop → `code-agent stop` · ca-reviewer의 SubagentStart/Stop → `code-agent review-event` |
| `CLAUDE.md` | `<!-- code-agent:start -->` 블록만. 블록 밖은 건드리지 않는다 |
| `.gitignore` | `.code-agent/active.json` · `docs-session.json` · `request-session.json` · `log/` 제외 |
| `.code-agent/version` | 도입한 버전 고정 |

## 빠른 시작

```
cd <프로젝트> && code-agent init
claude
```

1. **요구사항부터 말한다** — `/ca-feature "만들고 싶은 기능"`. ID를 생략하면 `WORK-0001`부터 자동 발급한다. 원문을 저장하고 분석 전에 설정·공통 문서를 점검한다.
   없는 것은 `/ca-adopt`·`/ca-docs` 흐름에서 준비한다. 신규는 **웹·API(JavaScript) / 자동화(Python) / 직접 선택** 중 목적에 맞는 추천으로 시작하며, 기존 프로젝트는 설정을 재사용한다.
   추천 구성은 `code-agent docs setup node|python`이 설정·POLICY 4종·단계 규칙을 작성한다. `docs begin`은 KNOWLEDGE 3종의 빈 뼈대를 만든다. 실제 소스·테스트는 계획 승인 뒤에 작성한다.
   `code-agent setup`은 실행 환경·기존 명령·Git 기준을 확인한다. 최초 커밋이 없으면 `code-agent setup baseline`이 준비 파일 목록을 보여주고 터미널 확인 뒤 저장한다. 테스트 도구를 다시 선택하거나 준비 단계에서 테스트를 실행하지 않는다.
2. **별도 터미널에서 공통 문서를 한 번에 확정** — 문서를 읽고 `code-agent confirm doc all`. 기존 개별 확정도 가능하다.
   TTY 에서만 받는다. 모델 세션 안의 확정은 모델이 한 것과 구분되지 않는다. KNOWLEDGE 3종은 확정하지 않는다.
3. **`/ca-next`로 접수를 이어간다.** 티켓 ID가 있으면 처음부터 `/ca-feature UZRF-145 <요구사항>`으로 시작할 수 있다. 아래는 그 ID를 사용한 예다.
   모델이 원문을 한 글자도 바꾸지 않고 `doc/work/UZRF-145/request.json` 에 담아 정리하고, `code-agent request submit` 이
   `doc/work/UZRF-145/requirement.md` 를 **코드로** 렌더한 뒤 멈춘다 (지시서에 대한 모델의 쓰기는 hook 이 거부한다).
   결함 수정은 `/ca-fix`, 구조 개선은 `/ca-refactor` — 접수만 따로 돌리려면 `/ca-request <ID> --kind <feature|fix|refactor> <요구사항>`.
4. **별도 터미널에서 요구사항 확정** — `code-agent confirm request UZRF-145`. 원문과 정리가 나란히 뜨고,
   확정한 **그 내용 그대로**만 작업이 시작된다 (확정되는 것은 **화면에 보여 준 바이트**다 — 읽는 사이에 지시서가 바뀌면
   판정을 남기지 않고 선다). 반려는 `code-agent reject request UZRF-145 --comment "사유"` (사유 필수) — `/ca-request` 가 사유를 읽고 다시 정리한다.
   지시서가 `doc/work/<ID>/requirement.md` 가 아닌 자리에 있으면 경로를 함께 준다: `code-agent confirm request UZRF-145 <지시서>`.
5. **`/ca-next`** (또는 `/ca-analyze`) — `code-agent start doc/work/UZRF-145/requirement.md` 로 시작해 분석 → 영향도 → 설계 → 계획 제출까지 가고 멈춘다.
   `/ca-fix` 는 ② 의 현행 분석 · ⑦ 의 `## 재현` 절 · `sequence[0]` 이 테스트 단계라는 것이 더 붙고, 구현에서 `code-agent repro` 로
   **지금 코드에서 실패하는 것을 본 뒤에야** 고칠 파일이 열린다. `/ca-refactor` 는 preserve 전량과 **기존 테스트 파일 보호**가 더 붙는다.
6. **`/ca-answer`** — 답 없는 질문을 하나씩 묻는다. 하나라도 남으면 다음 스테이지로 넘어가지 않는다.
7. **별도 터미널에서 승인** — `code-agent approve`. 확정 요구→분석 R 추적표, Task별 요구사항·파일·순서, 계획과 `## 가정`이 함께 보인다.
   반려는 `code-agent reject --comment "사유"` (사유 필수).
8. **`/ca-next`** — 승인한 `sequence` 순서대로 Task를 진행하고, 이어서 `check` → `test` → `review` → `integrate` 를 몬다. 순서를 바꾸려면 계획을 수정·제출하고 다시 승인받는다.
   한 단계씩 끊어 보려면 `/ca-implement` · `/ca-check` · `/ca-test` · `/ca-review` · `/ca-integrate` 를 직접 부른다 (절차는 같다).
   검증이 실패하면 계획 안에서 고치고 `check` 부터 다시 돈다(기본 2회). 지금 위치는 `/ca-status`.
9. **별도 터미널에서 반영** — `code-agent deliver`. 추적표·검증 증거·변경 파일을 보여 주고 확인을 받은 뒤
   작업 브랜치에 **로컬 커밋**한다. push·MR/PR 생성은 하지 않는다.

요구사항을 고칠 때도 같은 자리다 — 초안을 고쳐 다시 제출하면 확정이 풀리고, 사람이 다시 확정할 때까지 그 작업은 진행되지 않는다
(받아 둔 계획 승인도 함께 무효가 된다). 반려받은 뒤 **같은 내용 그대로** 다시 제출하는 것은 거부된다 — 사유를 읽고 고쳐야 한다.
손으로 쓴 `requirement.md` 도 똑같이 `code-agent confirm request <ID>` 를 지나야 한다. 그것이 정해진 자리가 아니면 경로를 함께 준다
(`code-agent confirm request <ID> <지시서>`) — `start` 가 거부할 때 쳐야 할 명령을 그 경로까지 찍어 준다.

## 명령

| Claude Code 안 | 하는 일 |
|---|---|
| `/ca-adopt` · `/ca-docs` | 도입 · 공통 문서(POLICY 4종 · KNOWLEDGE 3종) 점검·작성 |
| `/ca-request <ID> --kind <종류> <요구사항>` | 요구사항 접수만 — 원문 보관 · 정리 · 지시서 렌더, 사람의 확정 대기에서 멈춘다 |
| `/ca-feature <ID> <요구사항>` · `/ca-fix` · `/ca-refactor` | 작업 시작 — 접수 후 요구사항 확정 대기에서 한 번, 계획 승인 대기에서 또 한 번 멈춘다 |
| `/ca-analyze` · `/ca-impact` · `/ca-design` · `/ca-plan` · `/ca-implement` · `/ca-check` · `/ca-test` · `/ca-review` · `/ca-integrate` | 스테이지 하나씩 (위 [단계별 명령](#단계별-명령)) |
| `/ca-answer` · `/ca-next` · `/ca-status` | 질문에 답 · 사이클로 이어 돌기 · 지금 위치 |

| 터미널 (사람) | 하는 일 |
|---|---|
| `code-agent init [--cli <경로>]` | 이 저장소에 설치 |
| `code-agent doctor` | 설치·환경 점검 — `✓` 확인 · `✗` 막는 것(→ 고치는 법) · `·` 알림. `✗` 가 없으면 종료 코드 0 ([`doc/install.md`](doc/install.md#4-code-agent-doctor--점검)) |
| `code-agent update [--cli <경로>]` | 지금 버전의 스킬·에이전트·hook 을 다시 설치 — 사람이 바꾼 것(다른 hook · 블록 밖 · 모델 오버라이드)은 그대로 |
| `code-agent status` · `code-agent docs` | 문서·작업·스테이지·질문·승인 상태 · 문서 섹션별 상태 |
| `code-agent confirm doc <all\|architecture\|conventions\|test-strategy\|quality>` | 공통 POLICY 문서 일괄 또는 개별 확정 (TTY) |
| `code-agent confirm request <ID> [<지시서>]` · `reject request <ID> [<지시서>] --comment <사유>` | 요구사항 확정 · 반려 (TTY) — 원문과 정리를 나란히 보여 주고, **보여 준 바이트**를 확정한다. 지시서를 생략하면 그 ID 가 진행 중인 작업이면 그 작업의 지시서, 아니면 `doc/work/<ID>/requirement.md`. 확정된 요구사항만 `start` 가 받는다 |
| `code-agent approve` · `reject --comment <사유>` | 계획 판정 (TTY) |
| `code-agent deliver` | 반영 — 추적표·검증 증거 확인 후 작업 브랜치 로컬 커밋 (TTY). push·MR/PR 없음 |
| `code-agent abort` | 진행 중인 작업 커서 지우기 — 작업이 없으면 열려 있는 접수 세션을 닫는다 (작업 폴더·계획·원장은 남는다) |
| `code-agent model [<에이전트\|all> <opus\|sonnet\|haiku>]` | 에이전트별 모델 보기 · 바꾸기 (바꾸기는 터미널에서만, 기본 opus) |
| `code-agent usage [--work <ID>] [--since <날짜>]` | 이 저장소의 Claude Code 기록에서 스테이지·에이전트별 토큰과 **비용 추정**을 집계 ([`doc/usage.md`](doc/usage.md#5-터미널-명령-사람)) |
| `code-agent knowledge` · `knowledge prune` | 공통 KNOWLEDGE 항목과 그것을 넣은 작업 · 근거 경로가 사라진 항목을 사람이 골라 지우기 (`prune` 은 TTY) |
| `code-agent plugin list` | 자리마다 지금 무엇이 채우는지 · 감지된 무료 도구 · 등록된 플러그인 |
| `code-agent plugin add <이름> --command "<argv>" [--slots a,b] [--sends-code]` · `plugin remove <이름>` | 플러그인 등록 · 해제 (TTY). 키와 동의는 `~/.code-agent/credentials.json` 에만 — 저장소에는 자리 선언만 ([`doc/plugins.md`](doc/plugins.md)) |

스킬이 부르는 것(= 모델이 Bash 로 부를 수 있는 전부): `request`(형식·규칙·대상 후보)·`request begin|submit` · `start` · `next` · `back <스테이지>` · `context` · `status` · `plan submit` · `repro`(fix 전용) · `check` · `test` · `review` · `integrate` · `survey` · `manifest check` · `plugin list` · `docs begin|end|recommend|setup|skeleton|interview|link`.
확정·반려(`confirm request` · `reject request`)와 `setup baseline`은 사람의 터미널 전용이다. hook 명령은 `code-agent hook`(PreToolUse), `code-agent stop`(Stop), `code-agent review-event`(리뷰어 SubagentStart/Stop)이며 stdin JSON을 받는다.

## 막히는 자리

| 무엇 | 어디서 | 상태 |
|---|---|---|
| 사람이 **지금 내용 그대로** 확정하지 않은 요구사항 위에서는 아무것도 진행하지 않는다 — 확정 뒤 지시서가 바뀌거나 초안을 다시 제출하면 확정이 풀리고, 받아 둔 계획 승인도 무효가 된다 (손으로 쓴 지시서도 같은 확정을 지난다). 판정은 **그 ID 의 그 지시서** 것만 센다 — 다른 경로의 확정이 이 지시서를 열어 주지 않는다 | `start` · `next` · `plan submit` · `approve` · `repro` · `check` · `test` · `review` · `integrate` · `deliver` | ✅ |
| 관측된 판정만 받는 프로젝트(`code-agent.json` 의 `workOrder.requireVerifiedApproval`)에서는 **요구사항 확정에도** 그 규칙이 걸린다 — 사람이 관측되지 않은 확정은 `unverified` 로 거부되고 터미널에서 다시 확정해야 한다 (계획 승인만의 규칙이 아니다) | `start` · `next` · 그 뒤 전부 | ✅ |
| 확정되는 것은 **사람 화면에 보여 준 바이트**다 — 사람이 읽는 사이에 지시서가 바뀌면 판정을 아예 남기지 않는다 (`확정하는 동안 지시서가 바뀌었습니다`) | `confirm request` · `reject request` | ✅ |
| 반려된 것과 **똑같은 내용**은 다시 제출되지 않는다 — 사유를 그대로 돌려주고 멈춘다. 머리말 속성 이름이 `[A-Za-z][A-Za-z0-9_-]*` 가 아니어도 거부한다 | `request submit` | ✅ |
| `requirement.md` 는 코드만 쓴다 — 모델의 쓰기는 **진행 중인 작업도 세션도 없을 때까지** 거부된다 (`request.json` 을 고쳐 다시 제출). 접수 중에는 그 작업 폴더(`doc/work/<ID>/`) 밖 쓰기와 선언된 build·test 명령도 닫히고, 문서 세션 중에도 지시서는 닫힌다 | PreToolUse hook | ✅ |
| 요구사항 확정 원장(`.code-agent/approvals/<ID>/request.jsonl`)은 해시 사슬이다 — 나중에 고치면 읽지 않고 선다. 이 작업의 승인 디렉토리 안이라 반영 커밋에 함께 들어간다 | `confirm request` · `start` · `next` · `deliver` | ✅ |
| POLICY 문서가 없거나 미확정이면 작업 시작·스테이지 전환·계획 제출·승인이 모두 거부된다 (KNOWLEDGE 는 막지 않는다) | `start` · `next` · `plan submit` · `approve` | ✅ |
| 테스트 전략·품질·보안 기준이 적은 명령 이름이 `code-agent.json` 의 `build`·`test`·`commands` 에 없으면 그 문서는 통과하지 못한다 | `docs` · `confirm doc` | ✅ |
| `01-requirements.md` 에 `## R<n>`(각각 `근거:`)·`## 가정` 이 없으면 영향도로 못 간다 | `next` | ✅ |
| `02-analysis.md` 의 영향 범위 표에 빠진 R 이 있으면 설계로 못 간다 | `next` | ✅ |
| `03-design.md` 의 필수 섹션이 비었거나 근거 없는 `해당 없음` 이면, `04-functional.md` 에 AC 없는 R 이 있으면 계획으로 못 간다 | `next` | ✅ |
| `07-test-spec.md` 가 모든 AC 를 TC 로 덮지 않으면 계획이 제출되지 않는다 | `plan submit` | ✅ |
| `05-plan.md` 는 코드만 쓴다 — 모델의 쓰기는 거부된다 (`plan.json` 을 고쳐 다시 제출) | PreToolUse hook | ✅ |
| 계획의 파일마다 `requirements`, 모든 요구 항목이 어느 파일엔가 닿아야 제출된다 | `plan submit` | ✅ |
| 승인 전 코드 쓰기, 계획 밖 파일, scope·preserve·계층 경계 | PreToolUse hook | ✅ |
| `.code-agent/` 는 도구로 못 쓴다 (커서·제출된 계획·승인 원장) — **작업도 세션도 없을 때까지** 그렇고, 그 경로를 가리키는 Bash 도 막힌다 (명령 이름 `code-agent` 는 걸리지 않는다). 세션이 열리기 전에 지시서와 확정 원장을 손으로 써 넣고 `start` 를 지나는 길이 여기서 닫힌다 | PreToolUse hook | ✅ |
| 경로에 `:` 가 든 쓰기는 어느 모드에서도 거부된다 — Windows 의 대체 데이터 스트림(`requirement.md::$DATA`)이 이름 대조를 비켜 같은 파일을 쓰는 길이다 | PreToolUse hook | ✅ |
| Bash 는 스킬이 부르는 `code-agent` 서브명령 · 선언된 명령 · 읽기용 git(파일로 내보내기 없이)만. 연결·리다이렉트 금지 | PreToolUse hook | ✅ |
| 답 없는 질문이 있으면 진행 금지 | `next` · `plan submit` | ✅ |
| `back` 은 **뒤로만** 간다 — 앞 스테이지로는 못 가고, `deliver`(사람이 서 있는 자리)에서는 되감지 않으며, 되감아도 증거·승인·수정 회차는 지워지지 않는다 (해시에 묶여 있어 어긋나면 그때 막힌다) | `back` | ✅ |
| 검증 결과는 모델이 보고하는 것이 아니라 `check`·`test`·`integrate` 가 증거에 적은 것만 유효하다 — `not-run`·`error`·`skipped` 는 통과가 아니다 | `check` · `test` · `next` | ✅ |
| 증거는 기준 커밋 · 계획 파일의 부분 트리 해시 · `manifestHash` · `planHash` 에 묶인다 — 하나라도 달라지면 그 통과가 무효 | `next` · `deliver` | ✅ |
| 테스트가 한 번 돌면 — `fix` 는 `code-agent repro` 가 재현을 본 순간부터 — `kind: "test"` 단계의 파일이 언다 — 단언을 지워 통과시키는 길이 막힌다 | PreToolUse hook | ✅ |
| `fix` 는 **재현이 먼저다** — ② 의 현행 분석(`해당 없음` 불가) · ⑦ 의 `## 재현` 절 · `sequence[0]` 이 테스트 단계. `code-agent repro` 가 지금 코드에서 그 TC 의 **실패**를 보기 전에는 고칠 파일을 쓸 수 없다 (`not-run`·`error` 는 재현이 아니고, 재현 TC id 는 **실패한 실행의 출력**에 찍혀야 한다) | `next` · `plan submit` · `repro` · PreToolUse hook | ✅ |
| `refactor` 는 **기준 커밋에 이미 있던 `kind: "test"` 단계 파일**을 고치지도 지우지도 못한다 — 동작이 보존되는지 보는 것이 그 테스트다. 그 자리는 단계가 밝힌 `outputDirs`·`base` 로 정해진다 (`kinds` 로 거르지 않고 소스 루트로 물러서지 않는다) | `plan submit` · PreToolUse hook · `check` | ✅ |
| 선언된 종류(`stages[].kinds`)로 돌 단계가 0개면 `start` 가 거부하고 무엇을 고칠지 찍는다. `manifest check` 가 미리 경고한다 (경고일 뿐 종료 코드 0) | `start` · `manifest check` | ✅ |
| `prepare` 가 선언돼 있으면 통합 검증의 깨끗한 worktree 에서 `build`·`test` **앞에** 돌고, 실패하면 build·test 를 돌리지 않는다 — 준비되지 않은 트리 위의 통과는 증거가 아니다 | `integrate` · `next` | ✅ |
| 반영 커밋에는 **이 작업의 파일·증거·원장만** 담긴다 — `.code-agent/` 를 통째로 올리지 않는다 (다른 작업의 증거·`models.json`·도입 원장은 사람이 따로 커밋한다) | `deliver` | ✅ |
| 계획 안 수정은 `fixRounds`(기본 2)회까지. 넘으면 계획 파일 쓰기가 전부 거부되고 보고만 남는다 | PreToolUse hook | ✅ |
| 리뷰의 열린 `계획 안` 지적이 있거나 마지막 회차 트리 해시가 지금과 다르면 반영 거부 | `deliver` | ✅ |
| 계획 밖 변경·답 없는 질문이 남아 있으면 턴 끝에 **한 번 막는다** — 이어 붙은 턴(`stop_hook_active`)에서는 놓아 준다. 두 번 막지 않는다 | Stop hook (`code-agent stop`) | ✅ |
| 승인·확정·반영은 사람만 — 반영 확인 화면에 추적표·검증 증거·커밋될 파일 목록이 함께 뜬다 | `approve` · `confirm` · `deliver` 의 TTY 검사 | ✅ |
| 플러그인 등록·해제도 사람만 — 모델은 `plugin list` 만 부른다. 코드를 밖으로 보내는 플러그인은 **이름을 그대로 입력**해야 등록되고, `probe` 가 실패하면 키도 저장되지 않는다 | `plugin add`·`remove` 의 TTY 검사 · PreToolUse hook | ✅ |
| 플러그인은 검증 런을 **더하기만** 한다 — 실패한 빌드를 통과로 만들 수 없고, 호출이 실패하면 기본 구현으로 떨어지며 명령은 정상 종료한다 | `check` · `context` · `review` · `survey` | ✅ |
| 등록된 키 파일(`~/.code-agent/`)은 모델이 읽지 못한다 — `Read`·`Grep`·`Glob` 도, 그 경로를 가리키는 Bash 도, 거기에 쓰는 것도 **작업도 세션도 없을 때까지** 막힌다. 어댑터 실행 파일은 **PATH 에서만** 찾아 저장소가 가로챌 수 없다 | PreToolUse hook · `resolveExecutable(skipLocal)` | ✅ |

그 밖에 작업도 세션도 없을 때는 판정하지 않는다 — code-agent 로 하는 작업이 아닐 때까지 막을 이유가 없다.
hook 은 사고 방지 장치이지 보안 경계가 아니다 — 개발자는 로컬 설정으로 끌 수 있고, Bash 는 그 자리를 **가리키는 것**만 막아 글자를 쪼개 돌려 쓰는 셸 명령까지는 막지 못한다.

## 더 읽을 것

| 문서 | 무엇 |
|---|---|
| [`doc/install.md`](doc/install.md) | **설치가 첫 걸음** — npm 전역 vs 단일 실행 파일 · 바이너리 만들기와 서명 · `init` · `doctor` · `update` · 지우기 |
| [`doc/design.md`](doc/design.md) | **정본** — 역할 · 문서 게이트 · 스테이지 · 강제 · 서브에이전트 · 플러그인 자리 · 구현 순서 · 실측 |
| [`doc/usage.md`](doc/usage.md) | 설치부터 승인까지 — 무엇을 치고 어디서 멈추는가 |
| [`doc/requirement.md`](doc/requirement.md) | 작업 지시서 규격 — 자리·머리말 속성·kind 별 필수·승인 묶음 |
| [`doc/plugins.md`](doc/plugins.md) | 플러그인(명령 어댑터) 계약 — 자리·요청/응답 JSON·등록과 키·실패 규칙·예시 어댑터 |

흐름·정책이 이 README 와 어긋나면 `doc/design.md` 가 맞다.
