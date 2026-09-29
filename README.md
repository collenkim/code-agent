# code-agent

**요구사항을 받아 코드를 쓰는 에이전트다.** Claude Code **안에서** 돈다 — 모델이 도구를 직접 쓰고, 절차는 스킬(`.claude/skills/ca-*`)과 서브에이전트 정의(`.claude/agents/ca-*`)에, 강제는 PreToolUse hook 과 `code-agent` CLI 에 있다. 근거가 되는 공통 POLICY 문서 4종(아키텍처·코드 컨벤션·테스트 전략·품질·보안 기준)이 사람 손으로 확정되기 전에는 작업이 시작되지 않고, 계획이 사람의 터미널에서 승인되기 전에는 코드가 한 줄도 써지지 않는다. 모호한 것은 지어내지 않고 `questions.md` 로 막는다. 서브에이전트는 기본이 전부 opus 이고, 사람이 `code-agent model` 로 바꿀 수 있다.

## 문서 모델

| 층 | 문서 | 코드가 보는 것 | 승인 해시 | 상태 |
|---|---|---|---|---|
| **공통 POLICY** | `doc/architecture.md` · 컨벤션(`conventions[]`) · `doc/test-strategy.md` · `doc/quality.md` | 파일 + 필수 섹션 + **사람 확정** | 예 | ✅ (4종) |
| **공통 KNOWLEDGE** | `doc/knowledge/` 의 데이터 사전 · API 목록 · 업무 규칙·용어집 | **파일 존재만** | 아니오 | 생성 ✅ · 갱신 P5 |
| **작업 문서** | `doc/work/<ID>/` 의 번호 문서 | 문서마다 다르다 | 6개 | 아래 흐름 표 |

**막는 것은 POLICY 4종뿐이다.** KNOWLEDGE 는 비어 있어도 작업을 막지 않는다 — 도입 때 빈 뼈대로 만들고 반영마다 그 작업 범위만 자란다.
작업 문서는 따로 확정받지 않고 **계획과 한 묶음으로 승인된다** (지시서 본문 · `01` · `02` · `03` · `04` · `07`).

## 목표 흐름

2026-09-29 확정. 스테이지(`key`)는 이 흐름을 그대로 딴다.

| # | 단계 | 하는 일 | 지금 |
|---|---|---|---|
| 1 | 요구사항 | `doc/work/<Jira 키>/requirement.md` — 사람이 쓴다 (머리말 `kind`·`id`·`title`·`target`) | ✅ |
| 2 | 요구사항 분석·명세화 `analysis` | ① `01-requirements.md` — 요구 항목 `## R<n>`(각각 `근거:`) · `## 가정` · `## 범위 밖` · 질문 | ✅ |
| 3 | 영향도 분석 `impact` | ② `02-analysis.md` — 기존 시스템 분석 · 영향 범위 표(**모든 R**) · Risk. 모든 작업 필수 | ✅ |
| 4~5 | 시스템 설계 + 기능·API·데이터 정의 `design` | ③ `03-design.md`(구성 요소·흐름·API·데이터·설계 결정) + ④ `04-functional.md`(기능·업무 규칙·예외·**AC**) | ✅ |
| 6 | 구현 계획 `plan` | ⑤ `plan.json`(+`sequence`·`approach`) → 코드가 `05-plan.md` 렌더 + ⑦ `07-test-spec.md`(AC 마다 TC) → **사람 승인(터미널)** | ✅ |
| 7 | 코드 생성 `implement` | 단계마다 새 컨텍스트에서 `ca-implementer` | 커서·hook 울타리 ✅ · 루프 P5 |
| 8 | 정적 분석·컴파일 `check` | 품질·보안 기준이 적은 명령 + build → ⑧ `08-validation.md` (코드만 쓴다) | P5 |
| 9 | 테스트 생성·실행 `test` | `ca-tester` 가 ⑦ 의 TC 만 쓰고 CLI 가 돌린다 | P5 |
| 10 | 결과 분석 | 실패를 파일·요구 항목으로 묶는다 | P5 |
| ↺ | 수정 | 계획 안이면 고치고 **8 부터 다시** (최대 N회). 계획 밖이면 질문 또는 재승인 | P5 |
| 11 | 코드 리뷰 `review` | ⑨ `09-review.md` — 컨벤션·요구 충족·설계와의 불일치. 지적은 ↺ 수정 루프로 | P5 |
| 12 | 통합 검증 `integrate` | 깨끗한 worktree 에서 전체 build · test | P5 |
| 13 | 반영 `deliver` | ⑩ `10-pr.md` — 추적표·변경 요약 → **사람 최종 확인(터미널)** → 작업 브랜치 로컬 커밋. KNOWLEDGE 3종이 여기서 자란다. push · PR 생성 · 병합은 사람 | P5 |

(⑥ Code 는 소스 코드 자체다 — `06-` 파일은 없다.)

오늘 `code-agent next` 는 `implement` 를 지나 `verify` 에서 멈춘다. P3 의 `research` 한 칸은 `impact` · `design` 둘로 갈렸다.

| 단계 | 내용 | 상태 |
|---|---|---|
| P1 뼈대 | CLI · PreToolUse hook · `.claude/` 템플릿 · 작업 폴더 | ✅ |
| P2 프로젝트 문서 | 문서 스키마 · `docs` · `confirm doc` · `/ca-docs` · `/ca-adopt` | ✅ |
| P3 분석·조사·계획 | analyst · explorer · writer · critic · 질문 루프 · `plan submit` · `approve` | ✅ |
| P4 문서 모델 전환 + 영향도·설계 | POLICY 2 → 4 · KNOWLEDGE 3종 빈 뼈대 · 작업 문서를 번호 문서(`01`~`04`·`07`, `05` 는 코드 렌더)로 · `impact` · `design` 스테이지 | ✅ |
| P5 구현·검증·반영 | 7~13 · 수정 루프 · Stop hook | 다음 |
| P6 fix·refactor·신규 저장소 | 재현 테스트 우선 · preserve 강제 · 빈 저장소 도입 | |
| P7 플러그인 | 자리(slot) 정의 · `plugin add/list/remove` — 등록한 사람만 opt-in | |
| P8 정리·배포 | 문서 세트 · `usage` · 단일 실행 파일 | |

## 설치

| 무엇 | 명령 |
|---|---|
| 빌드 | `npm run build` — `dist/` 에 컴파일 (`bin.code-agent` → `dist/agent/cli.js`) |
| 설치 | `npm install -g <이 저장소 경로>` |
| 개발 중 | 이 저장소에서 `npm link` — 고칠 때마다 `npm run build` |
| 프로젝트마다 | `cd <프로젝트> && code-agent init` |
| 개발용 hook | `code-agent init --cli <이 저장소>/dist/agent/cli.js` — hook 이 PATH 대신 로컬 빌드를 부른다 |

`init` 이 대상 저장소에 만드는 것 — 전부 커밋해 팀과 공유한다.

| 자리 | 내용 |
|---|---|
| `.claude/skills/ca-*` · `.claude/agents/ca-*` | 절차와 서브에이전트 정의 (`template/` 사본) |
| `.claude/settings.json` | PreToolUse hook (`Write`·`Edit`·`MultiEdit`·`NotebookEdit`·`Bash`) → `code-agent hook` |
| `CLAUDE.md` | `<!-- code-agent:start -->` 블록만. 블록 밖은 건드리지 않는다 |
| `.gitignore` | `.code-agent/active.json` · `docs-session.json` · `log/` 제외 |
| `.code-agent/version` | 도입한 버전 고정 |

## 빠른 시작

```
cd <프로젝트> && code-agent init
claude
```

1. **`/ca-adopt`** — 레거시 첫 도입. 뼈대 역공학으로 `code-agent.json` · POLICY 4종 · KNOWLEDGE 3종 빈 뼈대까지.
   이미 매니페스트가 있으면 **`/ca-docs`** 로 문서만 점검·작성한다 — 문서마다 **기본으로 생성 / 대화로 생성 / 기존 문서 연결** 을 추천과 함께 묻는다.
2. **별도 터미널에서 확정** — `code-agent confirm doc architecture` · `conventions` · `test-strategy` · `quality` **네 번.**
   TTY 에서만 받는다. 모델 세션 안의 확정은 모델이 한 것과 구분되지 않는다. KNOWLEDGE 3종은 확정하지 않는다.
3. **요구사항을 쓴다** — `doc/work/<Jira 키>/requirement.md`. 사람의 입력이라 모델은 고칠 수 없다(hook 이 거부).
   머리말에 `kind: feature` · `id` (Jira 키 그대로) · `title` · `target`.
4. **`/ca-feature doc/work/UZRF-145/requirement.md`** — 분석 → 영향도 → 설계 → 계획 제출까지 가고 멈춘다.
   (`/ca-fix` · `/ca-refactor` 는 재현 TC 와 preserve 가 더 붙는다.)
5. **`/ca-answer`** — 답 없는 질문을 하나씩 묻는다. 하나라도 남으면 다음 스테이지로 넘어가지 않는다.
6. **별도 터미널에서 승인** — `code-agent approve`. 계획과 `## 가정` 이 함께 보인다.
   반려는 `code-agent reject --comment "사유"` (사유 필수).
7. **`/ca-next`** — 구현 단계를 하나씩 진행한다. 지금 위치는 `/ca-status`.

## 명령

| Claude Code 안 | 하는 일 |
|---|---|
| `/ca-adopt` · `/ca-docs` | 도입 · 공통 문서(POLICY 4종 · KNOWLEDGE 3종) 점검·작성 |
| `/ca-feature <지시서>` · `/ca-fix` · `/ca-refactor` | 작업 시작 — 승인 대기에서 멈춘다 |
| `/ca-answer` · `/ca-next` · `/ca-status` | 질문에 답 · 다음으로 · 지금 위치 |

| 터미널 (사람) | 하는 일 |
|---|---|
| `code-agent init [--cli <경로>]` | 이 저장소에 설치 |
| `code-agent status` · `code-agent docs` | 문서·작업·스테이지·질문·승인 상태 · 문서 섹션별 상태 |
| `code-agent confirm doc <architecture\|conventions\|test-strategy\|quality>` | 공통 POLICY 문서 확정 (TTY) |
| `code-agent approve` · `reject --comment <사유>` | 계획 판정 (TTY) |
| `code-agent abort` | 진행 중인 작업 커서 지우기 (작업 폴더·계획·원장은 남는다) |
| `code-agent model [<에이전트\|all> <opus\|sonnet\|haiku>]` | 에이전트별 모델 보기 · 바꾸기 (바꾸기는 터미널에서만, 기본 opus) |

스킬이 부르는 것(= 모델이 Bash 로 부를 수 있는 전부): `start` · `next` · `context` · `status` · `plan submit` · `survey` · `manifest check` · `docs begin|end|skeleton|interview|link`. hook 이 부르는 것: `code-agent hook` (stdin JSON).

## 막히는 자리

| 무엇 | 어디서 | 상태 |
|---|---|---|
| POLICY 문서가 없거나 미확정이면 작업 시작·스테이지 전환·계획 제출·승인이 모두 거부된다 (KNOWLEDGE 는 막지 않는다) | `start` · `next` · `plan submit` · `approve` | ✅ |
| 테스트 전략·품질·보안 기준이 적은 명령 이름이 `code-agent.json` 의 `build`·`test`·`commands` 에 없으면 그 문서는 통과하지 못한다 | `docs` · `confirm doc` | ✅ |
| `01-requirements.md` 에 `## R<n>`(각각 `근거:`)·`## 가정` 이 없으면 영향도로 못 간다 | `next` | ✅ |
| `02-analysis.md` 의 영향 범위 표에 빠진 R 이 있으면 설계로 못 간다 | `next` | ✅ |
| `03-design.md` 의 필수 섹션이 비었거나 근거 없는 `해당 없음` 이면, `04-functional.md` 에 AC 없는 R 이 있으면 계획으로 못 간다 | `next` | ✅ |
| `07-test-spec.md` 가 모든 AC 를 TC 로 덮지 않으면 계획이 제출되지 않는다 | `plan submit` | ✅ |
| `05-plan.md` 는 코드만 쓴다 — 모델의 쓰기는 거부된다 (`plan.json` 을 고쳐 다시 제출) | PreToolUse hook | ✅ |
| 계획의 파일마다 `requirements`, 모든 요구 항목이 어느 파일엔가 닿아야 제출된다 | `plan submit` | ✅ |
| 승인 전 코드 쓰기, 계획 밖 파일, scope·preserve·계층 경계 | PreToolUse hook | ✅ |
| `.code-agent/` 는 도구로 못 쓴다 (커서·제출된 계획·승인 원장) | PreToolUse hook | ✅ |
| Bash 는 스킬이 부르는 `code-agent` 서브명령 · 선언된 명령 · 읽기용 git(파일로 내보내기 없이)만. 연결·리다이렉트 금지 | PreToolUse hook | ✅ |
| 답 없는 질문이 있으면 진행 금지 | `next` · `plan submit` | ✅ |
| 승인·확정은 사람만 | `approve` · `confirm` 의 TTY 검사 | ✅ |

hook 은 사고 방지 장치이지 보안 경계가 아니다 — 개발자는 로컬 설정으로 끌 수 있다.

## 더 읽을 것

| 문서 | 무엇 |
|---|---|
| [`doc/design.md`](doc/design.md) | **정본** — 역할 · 문서 게이트 · 스테이지 · 강제 · 서브에이전트 · 플러그인 자리 · 구현 순서 · 실측 |
| [`doc/usage.md`](doc/usage.md) | 설치부터 승인까지 — 무엇을 치고 어디서 멈추는가 |
| [`doc/requirement.md`](doc/requirement.md) | 작업 지시서 규격 — 자리·머리말 속성·kind 별 필수·승인 묶음 |

흐름·정책이 이 README 와 어긋나면 `doc/design.md` 가 맞다.
