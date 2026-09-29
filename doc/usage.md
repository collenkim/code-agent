# 사용 가이드 — 설치부터 승인까지

> 설계와 근거는 [design.md](design.md), 지시서 규격은 [requirement.md](requirement.md).
> 이 문서는 **무엇을 치고 어디서 멈추는가**다.

code-agent 는 **Claude Code 안에서** 돈다. 모델이 도구를 직접 쓴다. 규칙은 스킬·에이전트 정의(`template/` → 설치되면 `.claude/`)에 있고,
강제는 PreToolUse hook 과 `code-agent` CLI 가 한다.

창은 둘 띄운다.

| 창 | 무엇 | 왜 |
|---|---|---|
| Claude Code (`claude`) | `/ca-*` 스킬로 작업을 진행한다 | 모델이 일하는 자리 |
| 터미널 (PowerShell · Windows Terminal) | `confirm doc` · `approve` · `reject` · `deliver` · `status` | 판정은 사람이 한다. 모델 세션 안의 승인은 모델이 한 것과 구분되지 않는다 |

---

## 목차

- [1. 설치](#1-설치)
- [2. 흐름 — 지금 어디까지 도는가](#2-흐름--지금-어디까지-도는가)
- [3. 한 바퀴](#3-한-바퀴)
- [4. 슬래시 명령 (Claude Code 안)](#4-슬래시-명령-claude-code-안)
- [5. 터미널 명령 (사람)](#5-터미널-명령-사람)
- [6. 스킬이 부르는 명령](#6-스킬이-부르는-명령)
- [7. 만들어지는 파일](#7-만들어지는-파일)
- [8. 질문과 가정](#8-질문과-가정)
- [9. 승인과 반영 — 터미널에서](#9-승인과-반영--터미널에서)
- [10. 막히면](#10-막히면)
- [11. 아직 없는 것](#11-아직-없는-것)

---

## 1. 설치

```
npm install -g <사내 저장소>/code-agent     # 한 번
cd <프로젝트> && code-agent init             # 프로젝트마다
```

`init` 이 대상 저장소에 하는 일.

| 무엇 | 자리 | 커밋 |
|---|---|---|
| 스킬·에이전트 | `.claude/skills/ca-*` · `.claude/agents/ca-*` | O |
| PreToolUse hook | `.claude/settings.json` — matcher `Write\|Edit\|MultiEdit\|NotebookEdit\|Bash`, command `code-agent hook` | O |
| 절차 블록 | `CLAUDE.md` 의 `<!-- code-agent:start -->` ~ `end` 사이 | O |
| 제외 목록 | `.gitignore` 의 `# code-agent:start` ~ `end` 사이 | O |
| 버전 고정 | `.code-agent/version` | O |

표시된 블록 **안쪽만** 바꾼다. `settings.json` 의 다른 hook·설정과 `CLAUDE.md` 의 블록 밖은 건드리지 않는다.

`--cli <경로>` 는 hook 이 부를 CLI 를 바꾼다 — `node "<경로>" hook` 이 된다. code-agent 자체를 고치면서 쓸 때만 쓴다.

```
code-agent init --cli C:/IdeaProjects/code-agent/dist/agent/cli.js
```

설치한 파일은 커밋해 팀과 공유한다. 배포는 지금 npm 전역 설치다 (단일 실행 파일은 P8).

---

## 2. 흐름 — 지금 어디까지 도는가

목표 흐름과, 지금 CLI 가 실제로 가진 스테이지의 대응.

| # | 목표 흐름 | 스테이지 (`active.json` 의 `phase`) | 산출물 | 상태 |
|---|---|---|---|---|
| — | 공통 POLICY 4종 · KNOWLEDGE 3종 | (스테이지 밖 게이트) | `doc/architecture.md` · 컨벤션 · `doc/test-strategy.md` · `doc/quality.md` · `doc/knowledge/*.md` | **구현됨** P2 2종 · P4 2종 + KNOWLEDGE |
| 1·2 | 요구사항 → 분석·명세화 | `analysis` | ① `01-requirements.md` | **구현됨** P4 (P3 의 `analysis.md`) |
| 3 | 영향도 분석 | `impact` | ② `02-analysis.md` | **구현됨** P4 |
| 4·5 | 시스템 설계 + 기능·API·데이터 정의 | `design` | ③ `03-design.md` · ④ `04-functional.md` | **구현됨** P4 |
| 6 | 구현 계획 | `plan` | ⑤ `plan.json` → 코드가 `05-plan.md` 렌더 · ⑦ `07-test-spec.md` | **구현됨** P3 · ⑤ 렌더·⑦ P4 |
| 7 | 코드 생성 | `implement` | ⑥ 소스 코드 (`06-` 파일은 없다) | **구현됨** P3 (단계 커서 + hook 울타리) |
| 8 | 정적 분석·컴파일 | `check` | ⑧ `08-validation.md` (코드만 쓴다) | **구현됨** P5 |
| 9 | 테스트 생성·실행 | `test` | 테스트 코드 (⑦ 의 TC 만) + ⑧ · 이후 테스트 동결 | **구현됨** P5 |
| 10 | 결과 분석 · 수정 루프 (8 부터 다시, 기본 2회) | — | ⑧ 의 `수정 루프` | **구현됨** P5 |
| 11 | 코드 리뷰 (지적은 수정 루프로) | `review` | ⑨ `09-review.md` | **구현됨** P5 |
| 12 | 통합 검증 | `integrate` | ⑧ 의 마지막 회차 | **구현됨** P5 |
| 13 | 반영 — 사람 최종 확인 → 로컬 커밋 | `deliver` | ⑩ `10-pr.md` + KNOWLEDGE 3종 갱신 | **구현됨** P5 |

- P3 의 `research` 한 칸은 P4 에서 `impact`(영향도) 와 `design`(설계·정의) 둘로 갈렸다. `02`·`03`·`04` 는 **모든 작업에 필수**다 (크기는 작업에 맞게).
- 검증은 모델이 보고하는 것이 아니라 **코드가 명령을 돌려 남긴 증거**다 — `code-agent check` · `test` · `integrate` 가 `.code-agent/work/<ID>/<대상>.verify.json` 에 적고 거기서 ⑧ 을 렌더한다.
  증거는 기준 커밋 · 계획 파일의 부분 트리 해시 · `manifestHash` · `planHash` 에 묶여, 통과 뒤 코드를 고치거나 검증 명령을 약하게 바꾸면 무효가 된다.
- `/ca-next` 는 `deliver` 앞에서 멈춘다. **반영은 사람이 터미널에서** `code-agent deliver` 로 한다 — 확인 화면을 보고 작업 브랜치에 로컬 커밋까지.
- **push · MR/PR 생성은 하지 않는다.** git 호스트가 붙을 때까지 보류한 것이고, 붙으면 그때 정한다 (2026-09-29 결정). 병합은 사람이 한다.

> **P4 로 올라오면서 P3 때 받은 계획 승인은 전부 무효가 됐다.** POLICY 가 2 → 4 종이 되고 승인 묶음이 바뀌어 해시 계산식이 달라졌다 —
> `stale-docs` 로 떨어지므로 터미널에서 다시 승인한다. 옛 형식으로 제출돼 있던 `plan.json` 은 `plan submit` 으로 다시 제출해야 한다.
> `code-agent.json` 쪽은 안전하다(경로 등록은 매니페스트 해시에 들어가지 않는다).

---

## 3. 한 바퀴

```
code-agent init
claude
  /ca-adopt (또는 /ca-docs)        → POLICY 4종 작성 + KNOWLEDGE 3종 빈 뼈대
  ────────────────────────────────  터미널: code-agent confirm doc architecture
                                    터미널: code-agent confirm doc conventions
                                    터미널: code-agent confirm doc test-strategy
                                    터미널: code-agent confirm doc quality
  /ca-feature doc/work/UZRF-145/requirement.md
      analysis  → 01-requirements.md   질문이 나오면 멈춤 → /ca-answer
      impact    → 02-analysis.md
      design    → 03-design.md · 04-functional.md
      plan      → plan.json + 07-test-spec.md → 제출(코드가 05-plan.md 렌더) 후 멈춤
  ────────────────────────────────  터미널: code-agent approve
  /ca-next                          → implement, 단계마다 서브에이전트
      check     → build · 정적 분석·보안 명령 → 08-validation.md (코드만 쓴다)
      test      → ca-tester 가 ⑦ 의 TC 만 쓰고 CLI 가 돌린다 → 이후 테스트 동결
        실패 → 계획 안이면 고치고 check 부터 다시 (기본 2회) / 계획 밖이면 질문·재승인
      review    → ca-reviewer 지적 표 → 09-review.md → 지적도 같은 수정 루프로
      integrate → 깨끗한 worktree 에서 전체 build · test
      deliver   → 10-pr.md 의 요약·확인 방법·위험을 쓰고 멈춤
  ────────────────────────────────  터미널: code-agent deliver  (확인 → 작업 브랜치 로컬 커밋)
```

사람이 멈추는 자리는 넷이다 — **문서 확정 · 질문 답변 · 계획 승인 · 반영 확인.** 그중 확정·승인·반영은 터미널에서만 된다.

---

## 4. 슬래시 명령 (Claude Code 안)

| 명령 | 하는 일 | 어디서 멈추나 | 상태 |
|---|---|---|---|
| `/ca-adopt` | 레거시 첫 도입 — 뼈대 역공학으로 문서 + `code-agent.json` | 문서 확정 안내 | 구현됨 (POLICY 4종 · KNOWLEDGE 3종) |
| `/ca-docs [종류]` | 공통 문서 점검·작성 (POLICY 4종 · KNOWLEDGE 3종) | 문서 확정 안내 | 구현됨 (POLICY 4종 · KNOWLEDGE 3종) |
| `/ca-feature <지시서>` | 분석 → 영향도 → 설계 → 계획 제출 | 질문 · 계획 승인 | 구현됨 (`impact`·`design` 포함) |
| `/ca-answer` | 답 없는 질문을 사용자에게 묻고 기록 | — | 구현됨 |
| `/ca-next` | 지금 스테이지를 이어 간다 | 스테이지마다 · `deliver` 는 사람에게 넘긴다 | 구현됨 (`integrate` 까지) |
| `/ca-status` | 위치·막힌 이유·다음 할 일 | — | 구현됨 |
| `/ca-fix <지시서>` | 결함 수정 — 현행 분석·재현 테스트를 앞세운다 | 질문 · 계획 승인 | 스킬만 · 완주는 **P6** |
| `/ca-refactor <지시서>` | 리팩토링 — 보존 조건이 계획의 중심 | 질문 · 계획 승인 | 스킬만 · 완주는 **P6** |

### `/ca-adopt`

레거시 저장소에 처음 들일 때. `code-agent docs begin` 으로 문서 세션을 열고 `code-agent survey` 로 저장소 개요와 **도구 후보**(테스트·정적 분석·보안 의존성, CI 설정)를 받은 뒤,
`ca-surveyor` 여럿을 병렬로 돌려 POLICY 4종 초안과 KNOWLEDGE 3종 뼈대를 쓰고, `code-agent.json` 을 만든다.

사람이 하는 일 — `referenceDomain`(복제 기준 도메인) 고르기, `stages`(계층 순서)·`build`·`test`·`commands`·`git.base` 확인.
끝나면 `code-agent manifest check` 가 ✓ 여야 한다.

### `/ca-docs [종류]`

공통 문서 게이트를 여는 명령. **문서마다** 경로를 묻고 추천을 함께 보여 준다.

| 경로 | 언제 | 어떻게 |
|---|---|---|
| 기본으로 생성 | 코드가 있을 때 | `survey` → `ca-surveyor` 병렬 → `ca-writer` 가 작성. 코드로 알 수 없는 것은 POLICY 면 `확인 필요`, KNOWLEDGE 면 **빈칸** |
| 대화로 생성 | 신규거나, 의도·정책·임계처럼 코드에 없는 것 | `code-agent docs interview <종류>` 의 질문을 사용자에게 묻고 답을 옮긴다 (한 번에 4개까지) |
| 기존 문서 연결 | 다른 곳에 이미 있을 때 | `code-agent docs link <종류> <경로...>` — 섹션 검사는 똑같이 받는다 |

| 문서 | 층 | 기본 경로 | 추천 |
|---|---|---|---|
| 아키텍처 | POLICY | `doc/architecture.md` | 기본으로 생성 |
| 코드 컨벤션 | POLICY | `doc/conventions.md` (디렉토리 가능) | 기본으로 생성 |
| 테스트 전략 | POLICY | `doc/test-strategy.md` | 도구·명령은 기본, **수준·통과 기준은 대화** |
| 품질·보안 기준 | POLICY | `doc/quality.md` | 도구·명령은 기본, **임계·차단 정책은 대화** |
| 데이터 사전 | KNOWLEDGE | `doc/knowledge/data-dictionary.md` | 기본으로 생성 (상세 상위 30개) |
| API 목록 | KNOWLEDGE | `doc/knowledge/api-catalog.md` | 기본으로 생성 (상위 40개) |
| 업무 규칙·용어집 | KNOWLEDGE | `doc/knowledge/business-rules.md` | **빈 뼈대** — 작업마다 질문의 답으로 쌓인다 |

**POLICY 4종**의 통과 조건은 셋이다. ① 파일이 있다 ② 필수 섹션이 있고 비어 있지 않다 ③ **사람이 확정했다.**
확정은 모델이 못 한다 — 터미널에서 네 번:
`code-agent confirm doc architecture` · `conventions` · `test-strategy` · `quality`.

테스트 전략의 `도구와 실행 명령`, 품질·보안 기준의 `정적 분석`·`보안 검사` 는 **명령 이름 대조**를 더 받는다 —
첫 목록의 백틱 이름(``- `unit`: …``)이 `code-agent.json` 의 `build`·`test`·`commands` 키에 실재해야 한다.
없으면 섹션 미충족으로 막힌다. 자동 검사가 없는 갈래는 `없음` 으로 적고, `없음` 은 대조하지 않는다.

**KNOWLEDGE 3종**은 **파일 존재만** 본다. 섹션 검사도 확정도 없고, 비어 있어도 작업을 막지 않는다.
모델은 작업 중에 이 파일들을 쓰지 않는다 — 인용만 하고, 제안은 `doc/work/<ID>/knowledge.proposal.md` 에 적는다.
갱신은 반영(`code-agent deliver`)에서 사람이 항목을 고른 뒤 코드가 한다 (키 단위 upsert, 삭제 없음).

### `/ca-feature <지시서> [--base <기준 브랜치>] [--target <대상>]`

지시서는 `doc/work/<Jira 키>/requirement.md` 다. **모델은 이 파일을 쓸 수 없다** — hook 이 거부한다.
요구가 모호하면 지시서를 고치는 대신 `questions.md` 에 질문으로 남는다.

1. `code-agent start` — 지시서 머리말을 검사하고, 작업 브랜치 `<종류>/<ID>` 를 따고, `questions.md` 를 만들고, 커서를 `analysis` 에 둔다.
2. **analysis** → ① `01-requirements.md` — `ca-analyst` 가 요구 항목 `## R<n>`(각각 `근거:`)·`## 가정`·`## 범위 밖` 을 뽑는다. 질문이 나오면 **멈춘다.**
3. **impact** → ② `02-analysis.md` — 요구 항목을 닿는 영역으로 묶어 `ca-explorer` 를 병렬로 돌리고 `ca-writer` 가 쓴다.
   `doc/knowledge/` 에 키가 이미 있으면 explorer 를 붙이지 않고 **인용한다.**
4. **design** → ③ `03-design.md` · ④ `04-functional.md` — `ca-writer` 가 같은 스테이지에서 함께 쓴다. AC(`AC-R<n>-<m>`)가 여기서 나온다.
5. **plan** → ⑤ `plan.json` + ⑦ `07-test-spec.md` 초안 → `ca-critic` 반박 검토 → `code-agent plan submit` (통과하면 코드가 `05-plan.md` 를 렌더한다).
6. 제출되면 **멈춘다** — 사람이 터미널에서 승인해야 한다.

문서마다 Bash: `code-agent docs skeleton <종류>` 로 뼈대를 받아 쓴다. **`05-plan.md` 는 모델이 쓸 수 없다** — 고칠 것이 있으면 `plan.json` 을 고쳐 다시 제출한다.

기준 브랜치는 `--base` > `code-agent.json` 의 `git.base` > `master` 순이다.
지시서에 `target` 이 여럿이면 `--target` 으로 고른다.

### `/ca-answer`

`questions.md` 에서 `[Answer]:` 가 빈 질문을 사용자에게 묻고, **사용자가 한 말 그대로** 적는다.
모르면 비워 둔다 — 대신 답하지 않는다. 답이 없는 질문이 하나라도 있으면 `code-agent next` 가 넘어가지 않는다.

### `/ca-next`

`code-agent status` 로 스테이지를 보고 그 자리부터 이어 간다.

- `analysis` · `impact` · `design` · `plan` — `/ca-feature` 의 해당 절차를 잇는다.
- `implement` — 단계마다 `code-agent context` 로 만들 파일·단계 규칙·참조 표준 코드를 받아 `ca-implementer`(테스트 단계면 `ca-tester`)에게 넘기고, 끝나면 `code-agent next`.
- `check` — `code-agent check` 가 `build` + 품질·보안 기준의 명령을 돌린 결과만 게이트를 연다. 모델이 직접 돌린 빌드는 세지 않는다.
- `test` — ⑦ 에 코드가 없는 TC 가 남아 있으면 `ca-tester` 가 **그대로, 그것만** 쓰고(매니페스트에 `kind: test` 단계가 있으면 `implement` 에서 이미 다 썼다) `code-agent test` 가 돌린다.
  이 실행 뒤 `kind: test` 단계의 파일은 **언다** — 실패해도 단언을 고쳐 통과시킬 수 없다.
- `review` — `code-agent context` 가 고른 것(계획 파일 · 요구 항목 · 검증 증거 요약 · 실패 로그 경로 · 얼어 있는 파일)만 `ca-reviewer` 에게 준다.
  리뷰어는 그 목록 밖을 읽지 않고 `| id | 계획 파일 | 범위 | 상태 | 지적 |` 표로 답한다 — 열 순서는 코드가 칸 위치로 읽어 고정이고,
  계획 파일은 저장소 기준 경로 그대로(백틱·`:줄번호` 없이), 상태는 `열림` · `해결` 둘뿐이다. 메인은 그 표를 `09-review.md` 의 `## 지적` 에 **그대로** 옮긴다(요약·완화 금지).
  회차 머리(번호·시각·기준 트리 해시)는 코드가 적는다. 반영은 **마지막 회차의 트리 해시가 지금과 같고 열린 `계획 안` 지적이 0** 이어야 열린다.
  얼어 있던 테스트 파일을 지적으로 푼 경우 **그 줄은 코드가 기억한다** — 쓰고 나서 지우면 `review` → `integrate` 가 막힌다.
- `integrate` — `code-agent integrate` 가 기준 커밋에서 뜬 깨끗한 worktree 에 계획 파일만 얹고 전체 build·test 를 돌린다.
- `deliver` — 모델은 ⑩ `10-pr.md` 의 `요약`·`확인 방법`·`위험·되돌리기` 만 쓰고 멈춘다. 추적표·검증 블록과 커밋은 `code-agent deliver` 의 몫이다.
- **↺ 수정 루프** — 실패·지적 중 **계획 안**은 `ca-implementer` 가 지목된 파일만 고치고 `check` 부터 다시 돈다.
  `code-agent check` 는 `test` · `review` · `integrate` 어디서 불러도 커서를 그 자리로 되감는다. 회차는 코드가 세고 기본 2회이며, 한 번 시작한 루프는 시작할 때의 한도로 끝난다.
  **계획 밖**은 고치지 않는다 — `questions.md` 에 질문으로 남기거나 계획을 고쳐 재승인한다. 한도를 넘기면 hook 이 계획 파일 쓰기를 전부 막고 보고만 남는다.
- 사람에게 물을 것은 **턴의 마지막 메시지에 모아서** 낸다.

### `/ca-status`

`code-agent status` 를 그대로 보여 주고 마지막 `다음:` 줄을 한 문장으로 풀어 준다.

### `/ca-fix` · `/ca-refactor` (P6)

스킬은 설치돼 있고 `/ca-feature` 와 같은 절차로 계획 제출까지 돈다. 다른 점은 아래 둘이다.

- `fix` — `02-analysis.md` 의 `기존 시스템 분석` 이 **결함이 나는 경로까지** 가야 한다. `07-test-spec.md` 의 첫 TC 는 **재현 케이스**이고 계획 `sequence[]` 의 첫 자리다.
- `refactor` — `02-analysis.md` 의 `영향 범위` 가 중심. 지시서의 `preserve` 문장을 **그대로** 옮겨야 제출된다 (코드가 대조한다).

검증 스테이지(`check` · `test` · `review` · `integrate` · `deliver`)는 종류를 가리지 않고 그대로 돈다.
다만 **종류별 강제**(재현 TC 를 계획의 첫 자리에, `expect: fail` 로 먼저 실패시켜 보기, preserve 대조)는 아직 스킬 지시로만 있다 — **P6 에서 완주한다.**

---

## 5. 터미널 명령 (사람)

| 명령 | 하는 일 | TTY 필요 |
|---|---|---|
| `code-agent init [--cli <경로>]` | 이 저장소에 설치 | — |
| `code-agent status` | 문서·작업·스테이지·질문·승인 상태와 다음 할 일 | — |
| `code-agent docs` | 공통 문서의 섹션별 상태와 확정 여부 (KNOWLEDGE 는 있음/없음만) | — |
| `code-agent confirm doc <architecture\|conventions\|test-strategy\|quality>` | POLICY 문서 확정 — 해시를 원장에 남긴다. **넷 다** 해야 작업이 시작된다 | **O** |
| `code-agent approve` | 제출된 계획 승인 | **O** |
| `code-agent reject --comment "<사유>"` | 제출된 계획 반려 (사유 필수) | **O** |
| `code-agent deliver` | 반영 — 추적표·검증 증거·변경 파일을 보여 주고 확인을 받은 뒤 작업 브랜치에 **로컬 커밋**. push·MR/PR 생성은 하지 않는다 | **O** |
| `code-agent abort` | 진행 커서(`.code-agent/active.json`)만 지운다 | — |
| `code-agent model [<에이전트\|all> <opus\|sonnet\|haiku>]` | 에이전트별 모델 표 · 바꾸기. 설정은 `.code-agent/models.json`, 정의 파일의 `model:` 줄을 코드가 다시 쓴다 | 바꾸기는 **터미널에서만** |

`abort` 는 작업 폴더·제출된 계획·원장을 남긴다. 같은 지시서로 다시 `start` 할 수 있다.

`deliver` 는 화면을 그리기 **전에** 게이트를 한 번 더 돌린다 — 증거가 지금 트리와 맞는지, 승인이 아직 `approved` 인지,
⑨ 에 열린 `계획 안` 지적이 없고 마지막 회차의 트리 해시가 지금과 같은지. 하나라도 어긋나면 **커밋하지 않고** 무엇이 어긋났는지 찍는다.
KNOWLEDGE 갱신은 `doc/work/<ID>/knowledge.proposal.md` 의 항목을 화면에서 고른 것만 반영한다 (삭제는 없다).

`status` 가 보여 주는 것 — 프로젝트 문서 ✓/✗, 작업 id·제목·종류·대상, 지시서 경로, 작업 폴더, 브랜치와 기준,
스테이지(전체 흐름에서 지금 자리를 `[ ]` 로), `implement` 면 단계 목록, 답 없는 질문, 계획·승인 상태, `다음:` 한 줄.

---

## 6. 스킬이 부르는 명령

사람이 칠 일은 거의 없다. 무엇이 왜 거부됐는지 읽을 때 필요하다.

| 명령 | 하는 일 |
|---|---|
| `code-agent docs begin` · `end` | 문서 작성 세션. 도는 동안 hook 이 문서 자리 밖 쓰기를 막는다 |
| `code-agent docs skeleton <종류>` | 빈 문서의 섹션 뼈대. 종류 — POLICY: `architecture` `conventions` `test-strategy` `quality` · KNOWLEDGE: `data-dictionary` `api-catalog` `business-rules` · 작업 문서: `01-requirements` `02-analysis` `03-design` `04-functional` `07-test-spec` |
| `code-agent docs interview <종류> [--sections a,b]` | 대화로 채울 때 물을 것 |
| `code-agent docs link <종류> <경로...>` | 이미 있는 문서를 `code-agent.json` 에 등록. 작업이 진행 중이면 거부한다 — 근거 문서는 작업 도중에 바꾸지 않는다 |
| `code-agent survey` | 뼈대 역공학용 저장소 개요 — 빌드 파일·언어·디렉토리·계층 후보·표본·**도구 후보**(테스트·정적 분석·보안 의존성, CI 설정)·이미 있는 문서 |
| `code-agent manifest check` | `code-agent.json` 이 참조 파일을 실제로 찾는지 (✗ 면 exit 1) |
| `code-agent start <지시서> [--target <대상>] [--base <기준 브랜치>]` | 작업 시작 |
| `code-agent next` | 게이트를 확인하고 다음 스테이지·단계로 |
| `code-agent context` | 지금 스테이지에 필요한 것 — 경로·형식·참조 코드·단계 규칙 |
| `code-agent plan submit <초안.json>` | 계획 검사 후 제출 |
| `code-agent check` | 8 정적 분석·컴파일 — `build` + 품질·보안 기준이 적은 명령을 돌려 증거에 적고 ⑧ 을 렌더 |
| `code-agent test` | 9 테스트 — `test` + 테스트 전략이 적은 명령을 돌리고 ⑦ 의 TC id 를 대조. 이 실행 뒤 테스트가 언다 |
| `code-agent integrate` | 12 통합 검증 — 기준 커밋에서 뜬 깨끗한 worktree 에 계획 파일만 얹고 전체 build·test |
| `code-agent hook` | PreToolUse 판정 (stdin JSON). 사람이 부르지 않는다 |
| `code-agent stop` | Stop 판정 (stdin JSON) — 계획 밖 변경·답 없는 질문을 턴 끝에 **한 번** 알린다. 사람이 부르지 않는다 |

모델이 Bash 로 부를 수 있는 것은 이 표의 명령과 `code-agent status` 뿐이다 — `init` · `abort` · `approve` · `reject` · `confirm doc` · `deliver` · `model` 은 hook 이 거부한다 (사람의 터미널 명령이다).

---

## 7. 만들어지는 파일

자리는 둘로 나뉜다. `doc/work/<ID>/` 는 **모델과 사람이** 쓰고, `.code-agent/` 는 **코드만** 쓴다 (hook 이 모든 도구 쓰기를 막는다).

| 경로 | 무엇 | 누가 쓴다 | 커밋 |
|---|---|---|---|
| `doc/architecture.md` · 컨벤션 · `doc/test-strategy.md` · `doc/quality.md` | 공통 POLICY 4종 — 확정해야 작업이 시작된다 | 모델 초안 + **사람 확정** | O |
| `doc/knowledge/data-dictionary.md` · `api-catalog.md` · `business-rules.md` | 공통 KNOWLEDGE 3종 — 도입에 빈 뼈대, 반영마다 자란다 | `docs skeleton` 이 만들고 `deliver` 가 갱신 (사람이 고른 항목만) | O |
| `doc/work/<ID>/requirement.md` | 작업 지시서 — 작업의 입력 | **사람만** | O |
| `doc/work/<ID>/questions.md` | 질문과 답 | `start` 가 만들고 모델이 덧붙인다 | O |
| `doc/work/<ID>/01-requirements.md` ① | 요구 항목 `## R<n>` · 가정 · 범위 밖 | 모델 (`ca-analyst` 결과) | O |
| `doc/work/<ID>/02-analysis.md` ② | 기존 시스템 분석 · 영향 범위 · Risk | 모델 (`ca-explorer` → `ca-writer`) | O |
| `doc/work/<ID>/03-design.md` ③ | 구성 요소 · 처리 흐름 · API · 데이터 · 설계 결정 | 모델 (`ca-writer`) | O |
| `doc/work/<ID>/04-functional.md` ④ | 기능 · 업무 규칙 · 예외 · 수락 기준(AC) | 모델 (`ca-writer`) | O |
| `doc/work/<ID>/plan.json` ⑤ | 계획 초안 | 모델 | O |
| `doc/work/<ID>/05-plan.md` ⑤ | 사람이 읽는 계획 — `plan.json` 의 뷰 | **`plan submit` 만** (hook 이 모델 쓰기 거부) | O |
| `doc/work/<ID>/07-test-spec.md` ⑦ | AC 마다 테스트 케이스 — **구현 전에** 쓴다 | 모델 | O |
| `doc/work/<ID>/08-validation.md` ⑧ | 검증 보고서 — 기준·실행 결과·TC·수정 루프·실패 로그 | **`check`·`test`·`integrate` 만** (hook 이 모델 쓰기 거부, 재렌더 바이트 대조) | O |
| `doc/work/<ID>/09-review.md` ⑨ | 리뷰 회차 · 지적 표(`id · 계획 파일 · 범위 · 상태 · 지적`) | 회차 머리는 코드, 지적 본문은 모델이 `ca-reviewer` 출력 그대로 | O |
| `doc/work/<ID>/10-pr.md` ⑩ | MR/PR 본문 — 요약 · 추적표 · 검증 · 확인 방법 · 위험 | `code-agent:trace` 블록은 **`deliver` 만**, 나머지는 모델 | O |
| `doc/work/<ID>/knowledge.proposal.md` | KNOWLEDGE 갱신 제안 — `deliver` 가 항목별로 물어 고른 것만 반영 | 모델이 적고 사람이 고른다 | O |
| `.code-agent/work/<ID>/<대상>.plan.json` | 제출된 계획 | `plan submit` 만 | O |
| `.code-agent/work/<ID>/<대상>.verify.json` | 검증 증거 — 기준 커밋 · 부분 트리 해시 · `manifestHash` · `planHash` · 회차 · 실행 목록 | `check` · `test` · `integrate` 만 | O (증거) |
| `.code-agent/approvals/docs.jsonl` | 문서 확정 원장 (해시 사슬) | `confirm doc` 만 | O |
| `.code-agent/approvals/<ID>.jsonl` | 계획 승인·반려 원장 (해시 사슬) | `approve` · `reject` 만 | O |
| `.code-agent/approvals/<ID>/<대상>-<n>.plan.json` | 판정한 그 계획의 사본 — 재승인 때 바뀐 곳을 이것과 대조해 보여 준다 | `approve` · `reject` 만 | O |
| `.code-agent/version` | 설치된 code-agent 버전 | `init` | O |
| `.code-agent/active.json` | 진행 커서 (id·지시서·대상·스테이지·단계·브랜치) | `start` · `next` · `abort` | X |
| `.code-agent/docs-session.json` | 문서 작성 세션 표시 | `docs begin` · `end` | X |
| `.code-agent/log/` | 검증 명령의 전체 로그 — ⑧ 에는 꼬리만 남는다 | `check` · `test` · `integrate` | X |

`<ID>` 는 지시서 머리말의 `id` 다 — Jira 키를 그대로 쓴다. **작업 폴더 이름과 같아야** 지시서와 작업 폴더가 한자리에 있다.

### `01-requirements.md` ① — 코드가 읽는 형식

```markdown
## R1 · 주문을 등록한다
근거: "주문을 등록·조회한다."
- 데이터: 만든다
- 접점(API·화면): 만든다
- 기존 코드: 안 고친다

## 가정
- 목록 정렬은 등록일 내림차순 — 근거: doc/conventions.md 계층별 규칙

## 범위 밖
- 주문 취소 — 근거: 지시서에 없고, 상태 전이 규칙이 정해지지 않았다
```

코드가 보는 것 — `## R<번호>` 가 하나 이상이고 번호가 겹치지 않을 것, 블록마다 `근거:` 줄이 있을 것, `## 가정` 섹션이 있을 것(`- 없음` 허용).
요구 항목 번호는 이후 전부와 대조된다: `02` 의 영향 표 첫 열, `04` 의 `AC-R<n>-<m>`, 계획의 `files[].requirements`.
`## 가정` 은 막지 않는다 — 계획 제출과 `approve` 화면에 그대로 실려 사람이 계획과 함께 받아들인다.
`## 범위 밖` 은 선택이다.

> P3 의 `analysis.md` 가 P4 에서 이 파일이 됐다. `## 작업 문서` 섹션은 없어졌다 — `02`·`03`·`04` 가 항상 필수가 되면서
> 판정할 것이 사라졌다. "이미 있는 문서가 이 범위를 덮는다" 는 `03` 의 `해당 없음 — <근거>` 와 KNOWLEDGE 인용이 대신한다.

### `04-functional.md` ④ · `07-test-spec.md` ⑦ — AC 와 TC

```markdown
## 수락 기준
- AC-R1-1 · 필수 필드를 채워 등록하면 201 과 주문번호가 돌아온다
- AC-R1-2 · 품목이 비면 400 `ORDER_ITEM_REQUIRED` 다
```

```markdown
## 테스트 케이스
| TC | 수준 | 대상 AC | 케이스 | 기대 결과 |
|---|---|---|---|---|
| TC-1 | Unit | AC-R1-1 | 유효한 주문 등록 | 주문번호가 발급된다 |
| TC-2 | Integration | AC-R1-2 | 품목 빈 요청 | 400 · ORDER_ITEM_REQUIRED |
```

AC 는 **R 마다 최소 하나**, TC 는 **AC 마다 최소 하나**다. 하나라도 비면 계획이 제출되지 않는다.
⑦ 은 승인 묶음에 들어가므로 **승인 뒤에 고치면 `stale-docs` 로 코드 쓰기가 멈춘다** — 테스트가 통과하지 않는다고 기대치를 낮추는 길이 닫힌다.

### `questions.md` — 한 질문에 한 결정

```markdown
## Q3 · 요구사항 분석
주문 취소 후 재주문이 가능한가?
A. 가능 — 새 주문번호
B. 불가
X. 기타:
[Answer]: A
```

`[Answer]:` 뒤가 비어 있으면 답이 없는 것이다. 하나라도 비면 다음 스테이지로 넘어가지 않는다.

### `plan.json` — 제출 형식

`feature` 는 만들 파일 목록, `fix` · `refactor` 는 고칠 파일 + 보존 조건이다.

```json
{
  "domainName": "도메인 이름",
  "domainLabel": "사람이 읽는 이름",
  "domainRoot": "도메인 분류 (없으면 \"\")",
  "domainDirName": "실제 디렉토리 이름",
  "files": [{ "stage": "단계 키", "path": "상대경로", "purpose": "한 줄 설명", "requirements": ["R1"] }],
  "sequence": [{ "step": "무엇을 먼저", "why": "그 차례인 이유 (02 의 Risk 가 큰 것부터)" }],
  "approach": "구현 방법 한 문단 — 03 의 설계를 어떤 방식으로 옮기는가",
  "conventions": [{ "rule": "적용할 규칙", "source": "근거 위치" }],
  "conflicts": [{ "topic": "", "docSays": "", "codeSays": "", "decision": "" }],
  "openQuestions": [],
  "reasoning": "판단 근거"
}
```

`fix` · `refactor` 는 `domain*` 대신 `preserve: [{ "item": "지시서 문장 그대로", "how": "어떻게 지켜지는지" }]` 가 들어간다.

제출이 통과하려면 — `openQuestions` 가 비어 있고, 파일마다 `requirements` 가 있고, 모든 요구 항목이 어느 파일엔가 닿고,
경로가 단계의 위치·지시서 `scope`·계층 경계 안이고, **`07-test-spec.md` 의 모든 TC 가 `04` 에 실재하는 AC 를 가리키며 모든 AC 가 덮여야** 한다.
통과하면 코드가 `05-plan.md` 를 렌더한다 — 사람이 승인 화면에서 읽는 것이 그것이다. 그 파일은 손으로 고치지 않는다.

`sequence` · `approach` 는 필수다 — 둘이 없는 옛 형식의 제출본은 `plan submit` 으로 다시 제출해야 읽힌다.

---

## 8. 질문과 가정

모든 모호함을 질문으로 막으면 한 줄짜리 요구에도 사람 왕복이 세 번 쌓인다. 그래서 둘로 나눈다.

| | 질문 | 가정 |
|---|---|---|
| 무엇 | 업무 규칙 · 범위 · 권한 · 데이터의 의미 · 외부·다른 도메인과의 계약 | 이름 · 정렬 · 숫자 정밀도 · 테스트 케이스 목록 · 메시지 문구 · 범위 밖으로 둘 부수 작업 |
| 기준 | 모델이 정하면 **지어낸 것**이 된다 | 컨벤션·참조 코드·일반 관행으로 **기본값을 댈 수 있다** |
| 어디에 | `doc/work/<ID>/questions.md` | `01-requirements.md` 의 `## 가정` — 근거를 반드시 단다 |
| 진행 | **막는다** — 답이 없으면 다음 스테이지로 못 간다 | 막지 않는다 |
| 사람은 언제 보나 | 그때 바로 (`/ca-answer`) | 승인 화면에 그대로 뜬다 — 계획과 함께 받아들이거나 반려한다 |

**질문 하나에 결정 하나.** 두 결정을 한 질문에 묶으면 한쪽만 답이 오고 되묻게 된다 (실측에서 나온 왕복이다).

답은 채팅으로 해도 된다 — 메인 에이전트가 파일에 옮긴다. 질문의 답은 승인이 아니라 터미널을 요구하지 않는다.

---

## 9. 승인과 반영 — 터미널에서

계획이 제출되면 Claude Code 는 멈춘다. **별도 터미널**(PowerShell · Windows Terminal)에서 저장소로 가서 친다.

```powershell
cd C:\IdeaProjects\my-app
code-agent approve
```

화면에 뜨는 것 — 계획(`05-plan.md` 와 같은 것: 변경 파일 · 작업 순서 · 구현 방법 · 보존 조건 · 적용 규칙), `01-requirements.md` 의 가정 전부,
이전 판정 뒤 계획이 바뀌었으면 바뀐 곳.

마지막 줄에서 **`approve` 를 그대로 입력**한다. 다른 것을 치면 아무것도 남기지 않고 끝난다.

```
approve 를 그대로 입력하면 판정을 남깁니다 (다른 입력은 취소): approve
승인을 원장에 남겼습니다. Claude Code 에서 /ca-next 로 구현을 시작하세요.
```

반려는 사유가 필수다. 입력할 낱말은 `reject` 다.

```powershell
code-agent reject --comment "공통 모듈을 건드리는 계획은 먼저 설계 논의"
```

문서 확정도 같은 모양이다 — `code-agent confirm doc architecture`, 입력할 낱말은 `confirm`.

승인은 **묶인다.** 원장에 남는 해시에 지시서·계획·매니페스트·확정된 POLICY 4종과 **작업 문서 고정 목록**이 들어간다 —
지시서 본문 · `01-requirements.md` · `02-analysis.md` · `03-design.md` · `04-functional.md` · `07-test-spec.md`.
어느 쪽이든 승인 뒤에 바뀌면 승인이 무효가 된다. `questions.md` 와 KNOWLEDGE 3종은 들어가지 않는다 —
구현 중에도 쌓이거나 다른 작업의 반영으로 자라서, 넣으면 승인이 수시로 무효가 된다.

| 승인 상태 | 뜻 | 할 일 |
|---|---|---|
| `none` | 판정이 없다 | 터미널에서 `approve` |
| `approved` | 유효하다 | `/ca-next` |
| `rejected` | 반려됐다 | 사유대로 계획을 고쳐 다시 제출 |
| `stale-plan` | 승인 뒤 계획이 바뀌었다 | 다시 승인 (바뀐 곳이 화면에 뜬다) |
| `stale-docs` | 승인 뒤 POLICY 문서나 작업 문서(`01`~`04`·`07`·지시서 본문)가 바뀌었다 | 다시 승인 |
| `stale-order` | 승인 뒤 지시서가 바뀌었다 | 다시 승인 |
| `stale-manifest` | 승인 뒤 `code-agent.json` 이 바뀌었다 | 다시 승인 |
| `unverified` | 사람 확인 없이 남은 판정 | 터미널에서 다시 |

### 반영 — `code-agent deliver`

마지막 문도 터미널이다. `/ca-next` 가 `integrate` 까지 몰고 멈추면 같은 자리에서 친다.

```powershell
cd C:\IdeaProjects\my-app
code-agent deliver
```

화면에 뜨는 것 — **추적표**(R → AC → 파일 → TC → 검증), **검증 증거**(명령 그대로 · 결과 · 기준 커밋 · 트리 해시 · 회차),
⑨ 의 마지막 회차와 열린 지적 수, **커밋될 파일 목록**(기준 커밋 대비 A/M/D/R), KNOWLEDGE 갱신 제안 항목.
무엇을 확정하는지는 파일 목록이다 — 그것 없이 "확정하시겠습니까" 만 물으면 판정이 형식이 된다.

입력할 낱말은 `deliver` 다. 통과하면 작업 브랜치에 **로컬 커밋**하고 커서를 지운다.

```
deliver 를 그대로 입력하면 반영합니다 (다른 입력은 취소): deliver
작업 브랜치에 커밋했습니다: feature/UZRF-145  a1b2c3d
```

- 화면을 그리기 **전에** 게이트를 한 번 더 돈다 — 증거가 지금 트리와 맞고, 승인이 아직 `approved` 이고,
  ⑨ 에 열린 `계획 안` 지적이 없고, 마지막 회차의 트리 해시가 지금과 같아야 한다. 하나라도 어긋나면 **커밋하지 않고** 무엇이 어긋났는지 찍는다.
- 커밋 범위는 계획 파일 · `doc/work/<ID>/` · `.code-agent/work/<ID>/` · 승인 원장이다 (`git add -A` 가 아니다).
  증거와 원장이 코드와 **같은 커밋**에 들어가, 무엇을 근거로 이 코드가 들어왔는지가 커밋 하나 안에서 닫힌다.
- **push · MR/PR 생성은 하지 않는다.** `10-pr.md` 를 MR/PR 본문으로 그대로 쓰면 된다.
- KNOWLEDGE 갱신은 `knowledge.proposal.md` 의 항목 중 **화면에서 고른 것만** 반영된다 (키 단위 upsert, 삭제 없음).

---

## 10. 막히면

### `판정은 터미널에서 받습니다 — stdin 이 TTY 가 아닙니다`

`approve` · `reject` · `confirm doc` · `deliver` 는 stdin 이 TTY 여야 한다.

| 어디서 | 되나 | 어떻게 |
|---|---|---|
| Claude Code 안의 Bash | **안 된다** | 설계다. 모델 세션 안의 승인은 모델이 한 것과 구분되지 않는다 |
| PowerShell · Windows Terminal · cmd | 된다 | 그대로 |
| Git Bash (mintty) | **안 된다** | mintty 는 node 의 stdin 을 파이프로 준다. `winpty code-agent approve` 로 감싸거나 PowerShell 을 쓴다 |
| CI · 스크립트 · 파이프 | 안 된다 | 사람이 그 자리에 있는지를 보는 문이다 |

이 문이 막는 것은 모델이 셸로 자기 계획을 승인하는 길이다. 보안 경계가 아니라 **관측**이다.

### hook 이 거부했다

거부 사유는 모델에게 그대로 보인다. 우회하지 않는 것이 규칙이다.

| 거부 문구 | 뜻 | 할 일 |
|---|---|---|
| `지금은 analysis 스테이지라 작업 폴더(...) 밖은 쓸 수 없습니다` | 승인 전에 코드를 쓰려 했다 | 계획까지 진행하고 승인을 받는다 |
| `계획이 승인되지 않았습니다 (none)` | 제출·승인 전 쓰기 | 터미널에서 `approve` |
| `계획이 승인되지 않았습니다 (stale-docs)` | 승인 뒤 근거 문서가 바뀌었다 | 다시 승인 |
| `승인된 계획에 없는 파일입니다: <경로>` | 계획 밖 파일 | 사람에게 알린다. 계획을 고치면 재승인 |
| `[지시서 scope 밖]` · `[do-not-touch 경계]` | 지시서 `scope` 밖이거나 계층 경계를 넘었다 | 아래 참고 |
| `[보존 대상]` | `preserve` 로 지킨다고 한 것을 건드렸다 | 계획을 고치거나 질문으로 |
| `작업 지시서(...)는 고칠 수 없습니다` | 모델이 `requirement.md` 를 고치려 했다 | 모호하면 `questions.md` 에 질문으로. 지시서는 사람이 고친다 |
| `05-plan.md 는 코드가 렌더합니다` | 모델이 렌더된 계획 문서를 고치려 했다 | `plan.json` 을 고쳐 `plan submit` 으로 다시 제출한다 |
| `08-validation.md 는 코드가 렌더합니다` | 검증 보고서를 손으로 고치려 했다 | 결과를 바꾸려면 고쳐서 `code-agent check` 부터 다시 돈다 |
| `테스트가 이미 돌아 얼어 있는 파일입니다` | `code-agent test` 가 한 번 돈 뒤의 `kind: test` 단계 파일이다 | 고치지 말고 근거와 함께 보고한다. 풀리는 길은 계획 재승인뿐이다 |
| `고쳐 쓰기 2회를 넘겨…` | `fixRounds` 한도를 넘겼다 | 덮지 않고 보고하는 자리다. `questions.md` 에 적고 사람에게 알린다 |
| `작업 상태·제출된 계획·승인 기록은 도구로 고칠 수 없습니다` | `.code-agent/` 쓰기 | `next` · `plan submit` · `confirm` 으로만 바뀐다 |
| `문서 작성 중에는 문서 자리(...) 밖은 쓸 수 없습니다` | 문서 세션 중 코드 쓰기 | 문서에 적고 사람에게 알린다. 세션은 `docs end` |
| `작업 중에는 Bash 로 code-agent 명령(…), 선언된 명령, 읽기용 git 만` | 허용 밖 명령 | 파일은 Write/Edit, 읽기는 Read/Grep/Glob. `init`·`abort`·`approve`·`reject`·`confirm`·`deliver`·`model` 은 사람이 터미널에서 |
| `연결·리다이렉트(; && \| >)는 안 됩니다` | 명령을 이어 붙였다 | 한 번에 하나씩 실행한다 |

**공통 모듈이 경계에 걸릴 때** — 새 오류 코드처럼 도메인 밖 공통 파일을 고쳐야 하는 계획은 경계 검사에서 거부된다.
`code-agent.json` 에 `"scope": "project"` 인 공통 단계를 두면 풀린다 (순서는 도메인 단계보다 앞).
지시서의 `scope` 를 넓혀야 하는 경우라면 그건 사람이 고친다.

### `code-agent next` 가 넘어가지 않는다

| 문구 | 뜻 |
|---|---|
| `프로젝트 필수 문서가 갖춰지지 않아...` | POLICY 4종(아키텍처·컨벤션·테스트 전략·품질·보안 기준) 중 없거나·섹션이 비었거나·명령 이름이 매니페스트에 없거나·확정되지 않은 것이 있다. `code-agent docs` 로 어느 섹션인지 본다. KNOWLEDGE 는 막지 않는다 |
| `답이 없는 질문이 N개 있어...` | `/ca-answer` |
| `요구사항 분석 결과가 없습니다` | `01-requirements.md` 에 `## R<번호>` 와 `## 가정` 을 쓴다 |
| `01-requirements.md 의 형식이 맞지 않습니다` | 요구 항목이 없거나·번호가 겹치거나·`근거:` 줄이 빠졌거나·`## 가정` 이 없다 |
| `영향 범위 표에 없는 요구 항목: R3` | `02-analysis.md` 의 표에 그 R 행을 더한다 (영향이 없으면 근거와 함께 `없음`) |
| `AC 가 없는 요구 항목: R3` | `04-functional.md` 에 `AC-R3-1` 을 더한다 |
| `해당 없음 에 근거가 없습니다` | `03-design.md` 의 그 섹션을 `해당 없음 — <근거>` 로 쓴다 |
| `단계 <key> 의 계획 파일이 아직 없습니다` | 그 단계의 계획 파일이 덜 만들어졌다 |
| `열린 지적이 남아 있습니다` | ⑨ 의 `계획 안` · `열림` 지적을 수정 루프로 닫는다 |
| `마지막 리뷰 회차 이후 코드가 바뀌었습니다` | 리뷰 뒤에 고쳤다. 리뷰를 한 회차 더 돈다 |
| `반영은 별도 터미널에서 code-agent deliver` | 여기가 모델의 끝이다. 확인과 커밋은 사람이 한다 |
| `굳혀 둔 기준 커밋이 없습니다` | 증거 코어 이전에 시작된 커서다. `code-agent abort` 뒤 다시 시작한다 (작업 폴더는 남는다) |

### `code-agent plan submit` 이 거부했다

| 문구 | 할 일 |
|---|---|
| `어느 요구 항목을 위한 파일인지 requirements 에 적으세요` | 파일마다 담당 요구 항목 번호를 단다 |
| `어떤 파일에도 닿지 않는 요구 항목: R3` | 파일을 더하거나, 이번 범위가 아니면 질문으로 확인 |
| `남은 질문이 있습니다` | `openQuestions` 를 `questions.md` 로 옮겨 답을 받는다 |
| `preserve 가 계획에 없습니다: <문장>` | 지시서의 보존 조건을 **문장 그대로** 옮긴다 |
| `알 수 없는 단계 <key>` | `code-agent context` 가 보여 준 단계 key 를 쓴다 |

### 그 밖

| 상황 | 뜻 |
|---|---|
| `code-agent.json 이 없습니다` | `/ca-adopt` 로 먼저 도입 |
| `진행 중인 작업이 있습니다: <ID>` | 끝내거나 `code-agent abort` 뒤에 시작 |
| `작업이 진행 중입니다 ... 근거 문서는 작업 도중에 바꾸지 않습니다` | `/ca-docs` 를 작업 중에 열었다. 작업을 끝내거나 `abort` |
| `사슬이 끊겼습니다 — 누가 원장을 고쳤는지 확인하세요` | `.code-agent/approvals/*.jsonl` 이 손으로 바뀌었다. git 이력으로 확인한다 |
| `기준 브랜치가 없습니다: master` | `start --base <브랜치>` 또는 `code-agent.json` 의 `git.base` |
| `code-agent hook 이 판정에 실패해 막았습니다` | hook 자체가 터졌다. 막는 쪽으로 닫힌다 — 메시지를 보고 `code-agent status` 로 상태를 확인 |
| `계획 밖 변경이 있습니다` (턴 끝) | Stop hook 이 기준 커밋과 대조해 한 번 알린 것이다. 되돌리거나 사람에게 알린다 — 계획을 넓히려면 재승인 |
| `검증 증거가 지금 트리와 맞지 않습니다` | 통과 뒤에 코드·계획·매니페스트가 바뀌었다. `code-agent check` 부터 다시 돈다 |

---

## 11. 아직 없는 것

| 단계 | 내용 | 상태 |
|---|---|---|
| P1 뼈대 | CLI · hook · `.claude/` 템플릿 · 작업 폴더 | ✅ |
| P2 프로젝트 문서 | 문서 스키마 · `docs` · `confirm doc` · `/ca-docs` · `/ca-adopt` | ✅ |
| P3 분석·조사·계획 | `analysis.md` · 작업 문서 · 계획 검사 · 승인 · 구현 울타리 | ✅ |
| P4 문서 모델 전환 + 영향도·설계 | POLICY 2 → 4 · KNOWLEDGE 3종 빈 뼈대 · 번호 작업 문서(`01`~`04`·`07`, `05` 는 코드 렌더) · `impact`·`design` 스테이지 · 영향 표/AC/TC 게이트 · 승인 묶음 고정 | ✅ |
| P5 구현·검증·반영 | 정적 분석 · 테스트 실행 · 테스트 동결 · 수정 루프 · 코드 리뷰 · 통합 검증 · 반영(TTY 확인 · 로컬 커밋 · `10-pr.md`) · KNOWLEDGE 갱신 · Stop hook | ✅ |
| P6 fix·refactor·신규 저장소 | 재현 테스트 먼저 · preserve 강제 완주 · 빈 저장소 도입 | 다음 |
| P7 플러그인 | 자리 정의 · `plugin add/list/remove` · 등록한 사람만 opt-in | — |
| P8 정리·배포 | 단일 실행 파일 · `usage`(토큰 집계) · 설치 점검 | — |

지금 완주할 수 있는 것은 **작업 브랜치의 로컬 커밋까지**다. push · MR/PR 생성 · 병합은 사람이 손으로 한다 —
git 호스트가 붙을 때까지 보류한 자리이고, 붙으면 그때 정한다.
