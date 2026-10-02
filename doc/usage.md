# 사용 가이드 — 설치부터 승인까지

Claude의 `/ca-*`와 Codex의 `$ca-*`가 같은 단계와 게이트를 사용한다. Codex는 `init --host codex` 후 훅을 신뢰하고 시작한다. 승인 응답은 [Codex 연동의 사용자 확인](codex.md#사용자-확인)을 따른다. 아래 선택 도구 예시는 Claude 기준이며, Codex에서 도구 이름을 그대로 실행하지 않는다.

> 설계와 근거는 [design.md](design.md), 지시서 규격은 [requirement.md](requirement.md).
> 이 문서는 **무엇을 치고 어디서 멈추는가**다.

code-agent는 **Claude Code 또는 Codex 안에서** 실행한다. `init`은 스킬·서브에이전트·hook을 프로젝트에 설치하고 종료한다. 같은 프로젝트에서 Claude는 `/ca-request <요구사항>`, Codex는 `$ca-request <요구사항>`으로 시작한다. 별도 서버나 수동 에이전트 등록은 필요 없다.

일반 요구사항 접수는 `/ca-request`, 신규·기능 추가·기능 변경을 명시하는 진입점은 `/ca-feature`, 결함 수정은 `/ca-fix`, 동작 보존 구조 개선은 `/ca-refactor`다. 종류별 명령도 같은 접수 절차를 사용한다. 하나로 접수한 뒤 질문·확인에 답하면 이어가며, `/ca-next`는 중단 후 재개할 때 사용한다.

모델이 도구를 직접 쓰고 규칙은 스킬·에이전트 정의에 있다. Claude는 `.claude/`, Codex는 `.agents/skills/`와 `.codex/agents/`를 읽는다. 진행 조건 검사와 결과 기록은 Claude hook 등록 8개(이벤트 5종), Codex 공통 hook 등록 5개와 `code-agent` CLI가 맡는다.

사용자 안내는 **준비 → 요구 확인 → 계획 확인 → 개발·검증 → 결과 확인**으로 요약한다. 내부 단계 명령을 기억할 필요 없이 요구를 말하고 필요한 선택에 답하면 사이클을 이어간다. 문서·요구·계획·반영 확인은 같은 세션에서 호스트별 응답 절차로 받는다.

기존 언어·프레임워크·테스트 도구는 그대로 사용한다. 초기 준비의 `code-agent setup`은 환경·명령·기준 커밋만 확인하며 테스트를 실행하지 않는다. 새 저장소는 `code-agent setup baseline`이 준비 파일을 보여주고 확인 뒤 최초 커밋을 만든다. 실제 소스 뼈대·실행 설정·테스트는 승인된 Task에서 작성한다.

요구사항 적합성 검토에서는 원문→요구→AC→예정 TC를 문서로 대조한다. 구현 후 기존 테스트 명령을 실행하고 콘솔 결과 또는 새로 생성·갱신된 JUnit XML 보고서를 자동으로 읽는다. 사용자에게 러너별 설정 선택을 요구하지 않는다. 성공·실패·생략·결과 미확인을 구분해 보고하며, 오래된 보고서를 이번 성공으로 재사용하지 않는다. fix만 수정 전 실패 재현이 추가된다.

설치 후에는 같은 Claude Code 대화에서 작업과 확인을 진행한다. 직접 CLI를 원할 때만 일반 터미널의 보조 경로를 사용한다.

| 창 | 무엇 | 왜 |
|---|---|---|
| Claude Code (`claude`) | `/ca-*` 스킬로 작업을 진행한다 | 모델이 일하는 자리 |
| 터미널 (PowerShell · Windows Terminal) | `confirm request` · `confirm doc` · `approve` · `reject` · `deliver` · `status` | 판정은 사람이 한다. 기본은 같은 세션의 관찰된 선택 응답이며, 직접 CLI는 수동 보조 경로다 |

---

## 검증 노드 실행기

전체 작업 흐름의 check·test는 `code-agent verify [--json] [--retry]`로 실행한다. 계획된 코드와 테스트 작성이 끝난 뒤 사용한다. check에서 시작하면 정적 검증·게이트·테스트·TC 판정까지 코드가 연속 처리한다. test에서 재개하면 유효한 check 증거를 재사용한다. 통과하면 커서는 review에 있으므로 `next`를 추가 호출하지 않고 `/ca-review`를 진행한다.

| 반환 노드 | 실행 주체 | 다음 행동 |
|---|---|---|
| `review` | agent | 독립 리뷰 진행 |
| `repair` | agent | 증거·로그를 분석하고 계획 안에서 수정 후 같은 verify 실행 |
| `diagnose` | agent | 미실행·실행 오류·생략·TC 결과 미확인 원인 해결 후 verify --retry |
| `decision` | human | 한도 초과를 보고하고 기존 질문·재계획·재승인 절차 진행 |

`--json`은 node·executor·task·problems·summaries·evidence·plannedFiles·resume을 반환한다. 종료 코드는 review 인계 시 0, 수정·진단·사용자 판단 요청 시 1이다. 실행 전제 거부는 기존 CLI 오류로 반환하며 유효한 노드 JSON과 구분한다. 프로그램이 에이전트 작업이나 사용자 응답을 대신 완료하지 않는다.

중단 후 같은 명령으로 재개한다. 입력이 같은 실패는 재실행하지 않고 요청을 다시 반환한다. 코드 수정은 check부터 재검증하며, 환경 문제를 해결하고 동일 코드를 재실행할 때만 `--retry`를 사용한다. 최초 1회와 `fixRounds`만큼의 수정 회차를 공유한다. 명령이 exit 0이어도 필수 TC가 passed가 아니면 통과가 아니며 한도를 적용한다. 검증 중 프로세스가 중단돼도 이미 증가한 회차는 되돌리지 않는다.

`.code-agent/work/<ID>/<대상>.verification-flow.json`에는 노드별 실행·대기·오류와 입력 해시를 기록한다. 판정의 근거는 기존 verify.json과 08-validation.md다. 이력 파일을 수정해 완료를 선언하지 않는다. 기존 프로젝트에 새 필수 설정은 없으며 구버전 작업도 재개할 수 있다. 단일 단계만 실행할 때는 기존 `check`, `test`, `next`를 사용한다.

변경·검증 기록은 [문서 이력](reviews/README.md)에서 확인한다.

전용 파일 읽기 도구가 없는 호스트는 `code-agent read <파일> [시작 줄] [줄 수]`를 사용한다. 저장소 안의 1 MB 이하 텍스트를 줄 번호와 함께 반환하며, 기본 200줄·최대 400줄이다. 배정받은 입력 범위는 그대로 지켜야 한다. 명령은 파일을 읽을 뿐 작업 완료나 실행 관찰을 대신하지 않는다.

## 목차

- [1. 설치](#1-설치)
- [2. 흐름 — 지금 어디까지 도는가](#2-흐름--지금-어디까지-도는가)
- [3. 한 바퀴](#3-한-바퀴)
- [4. 슬래시 명령 (Claude Code 안)](#4-슬래시-명령-claude-code-안)
- [5. 터미널 명령 (사람)](#5-터미널-명령-사람)
- [6. 스킬이 부르는 명령](#6-스킬이-부르는-명령)
- [7. 만들어지는 파일](#7-만들어지는-파일)
- [8. 질문과 가정](#8-질문과-가정)
- [9. 승인과 반영 — 같은 Claude Code 세션에서](#9-승인과-반영--같은-claude-code-세션에서)
- [10. 플러그인 (선택)](#10-플러그인-선택)
- [11. 막히면](#11-막히면)
- [12. 아직 없는 것](#12-아직-없는-것)

---

## 1. 설치

```
npm install -g <code-agent 저장소 경로>   # 한 번 — Node 22 이상
cd <개발할 프로젝트>
code-agent init                          # 프로젝트마다 설치
claude                                   # 이 안에서 /ca-request 입력
```

`init` 이 대상 저장소에 하는 일.

| 무엇 | 자리 | 커밋 |
|---|---|---|
| 스킬·에이전트 | `.claude/skills/ca-*` · `.claude/agents/ca-*` | O |
| PreToolUse hook | `.claude/settings.json` — matcher `Write\|Edit\|MultiEdit\|NotebookEdit\|Bash\|Read\|Grep\|Glob`, command `code-agent hook` | O |
| Stop hook | `.claude/settings.json` — `code-agent stop` | O |
| ca-reviewer SubagentStart/Stop | `.claude/settings.json` — 독립 리뷰 실행·결과를 기록하는 `code-agent review-event` | O |
| 절차 블록 | `CLAUDE.md` 의 `<!-- code-agent:start -->` ~ `end` 사이 | O |
| 제외 목록 | `.gitignore` 의 `# code-agent:start` ~ `end` 사이 | O |
| 버전 고정 | `.code-agent/version` | O |

표시된 블록 **안쪽만** 바꾼다. `settings.json` 의 다른 hook·설정과 `CLAUDE.md` 의 블록 밖은 건드리지 않는다.

`--cli <경로>` 는 hook 이 부를 CLI 를 바꾼다 — `node "<경로>" hook` 이 된다. code-agent 자체를 고치면서 쓸 때만 쓴다.

```
code-agent init --cli C:/IdeaProjects/code-agent/dist/agent/cli.js
```

설치한 파일은 커밋해 팀과 공유한다.

설치는 두 가지다 — npm 전역, 그리고 Node 가 필요 없는 **단일 실행 파일**(`npm run build:bin` → `dist-bin/code-agent(.exe)`, OS 별 ~90 MB).
저장소에 들어가는 것은 어느 쪽이든 같다(hook 명령이 PATH 에서 풀린다). 바이너리 만들기와 서명 · `doctor` 의 검사 항목 · `update` 가 보존하는 것 ·
지우는 순서는 [install.md](install.md).

---

## 2. 흐름 — 지금 어디까지 도는가

목표 흐름과, 지금 CLI 가 실제로 가진 스테이지의 대응. **`#` 는 13단계 목표 흐름의 번호**이고 CLI 가 찍는 스테이지 번호와 다르다 —
CLI 는 검증 스테이지를 `7 check` · `8 test` · `9 review` · `10 integrate` · `11 deliver` 로 센다 (재현은 번호가 없다 — `implement` 안에서 돈다).
**요구사항 접수(1)에는 스테이지 번호가 없다** — 작업 커서가 생기기 전이라, 문서 작성처럼 **세션**으로 돈다.

| # | 목표 흐름 | 스테이지 (`active.json` 의 `phase`) | 산출물 | 상태 |
|---|---|---|---|---|
| — | 공통 POLICY 4종 · KNOWLEDGE 3종 | (스테이지 밖 게이트) | `doc/architecture.md` · 컨벤션 · `doc/test-strategy.md` · `doc/quality.md` · `doc/knowledge/*.md` | **구현됨** P2 2종 · P4 2종 + KNOWLEDGE |
| 1 | 요구사항 접수 | (스테이지 밖 — 접수 세션) | `request.json` → 코드가 지시서 `requirement.md` 렌더 + 사람의 확정 원장 | **구현됨** |
| 2 | 분석·명세화 | `analysis` | ① `01-requirements.md` | **구현됨** P4 (P3 의 `analysis.md`) |
| 3 | 영향도 분석 | `impact` | ② `02-analysis.md` | **구현됨** P4 |
| 4·5 | 시스템 설계 + 기능·API·데이터 정의 | `design` | ③ `03-design.md` · ④ `04-functional.md` | **구현됨** P4 |
| 6 | 구현 계획 | `plan` | ⑤ `plan.json` → 코드가 `05-plan.md` 렌더 · ⑦ `07-test-spec.md` | **구현됨** P3 · ⑤ 렌더·⑦ P4 |
| 7 | 코드 생성 | `implement` | ⑥ 소스 코드 (`06-` 파일은 없다). `fix` 는 테스트 단계가 먼저이고 `code-agent repro` 가 재현을 본 뒤에 고친다 | **구현됨** P3 (단계 커서 + hook 울타리) · 재현 P6 |
| 8 | 정적 분석·컴파일 | `check` | ⑧ `08-validation.md` (코드만 쓴다) | **구현됨** P5 |
| 9 | 테스트 생성·실행 | `test` | 테스트 코드 (⑦ 의 TC 만) + ⑧ · 이후 테스트 동결 | **구현됨** P5 |
| 10 | 결과 분석 · 수정 루프 (8 부터 다시, 기본 2회) | — | ⑧ 의 `수정 루프` | **구현됨** P5 |
| 11 | 코드 리뷰 (지적은 수정 루프로) | `review` | ⑨ `09-review.md` | **구현됨** P5 |
| 12 | 통합 검증 | `integrate` | ⑧ 의 마지막 회차 | **구현됨** P5 |
| 13 | 반영 — 사람 최종 확인 → 로컬 커밋 | `deliver` | ⑩ `10-pr.md` + KNOWLEDGE 3종 갱신 | **구현됨** P5 |

- **요구사항은 명령으로 받는다.** 사람이 손으로 `requirement.md` 를 쓰던 자리가 `/ca-request`의 **공통 접수**로 바뀌었다 —
  사람은 서술·티켓·파일을 말로 주고, 모델이 `request.json` 으로 정리하고, 코드가 지시서를 렌더하고, **사람이 같은 세션에서 확정**한다.
  확정된 지시서만 `code-agent start` 가 받는다. 손으로 쓴 지시서도 그대로 쓰지만 **확정은 똑같이** 받는다.
- P3 의 `research` 한 칸은 P4 에서 `impact`(영향도) 와 `design`(설계·정의) 둘로 갈렸다. `02`·`03`·`04` 는 **모든 작업에 필수**다 (크기는 작업에 맞게).
- 검증은 모델이 보고하는 것이 아니라 **코드가 명령을 돌려 남긴 증거**다 — `code-agent check` · `test` · `integrate` 가 `.code-agent/work/<ID>/<대상>.verify.json` 에 적고 거기서 ⑧ 을 렌더한다.
  증거는 기준 커밋 · 계획 파일의 부분 트리 해시 · `manifestHash` · `planHash` 에 묶여, 통과 뒤 코드를 고치거나 검증 명령을 약하게 바꾸면 무효가 된다.
- `/ca-next`는 반영 단계에서도 같은 세션의 결과 확인을 받고 로컬 커밋까지 이어간다.
- **push · MR/PR 생성은 하지 않는다.** git 호스트가 붙을 때까지 보류한 것이고, 붙으면 그때 정한다 (2026-09-29 결정). 병합은 사람이 한다.

> **P4 로 올라오면서 P3 때 받은 계획 승인은 전부 무효가 됐다.** POLICY 가 2 → 4 종이 되고 승인 묶음이 바뀌어 해시 계산식이 달라졌다 —
> `stale-docs` 로 떨어지므로 같은 세션에서 다시 승인한다. 옛 형식으로 제출돼 있던 `plan.json` 은 `plan submit` 으로 다시 제출해야 한다.
> `code-agent.json` 쪽은 안전하다(경로 등록은 매니페스트 해시에 들어가지 않는다).

---

## 3. 한 바퀴

```
code-agent init                   # 일반 터미널: 설치만 하고 종료
claude                           # 같은 프로젝트에서 Claude Code 실행
  /ca-request UZRF-145 "결제 뒤 24시간 안에는 주문을 취소할 수 있게"
      원문 보관 → 공통 문서·설정 확인 → 없으면 /ca-adopt · /ca-docs로 준비
  ────────────────────────────────  초기 준비: 같은 세션에서 공통 문서와 준비 파일 확인
                                    최초 커밋이 없으면: 같은 setup 확인에 기준 커밋 포함
  /ca-next                         원문·ID를 유지한 채 같은 접수로 복귀
      접수      /ca-request   → request.json → code-agent request submit
                              → 코드가 doc/work/UZRF-145/requirement.md 를 렌더하고 멈춤
  ────────────────────────────────  같은 세션: 원문·정리 확인 후 요구사항 확정
                                    (반려는 code-agent reject request UZRF-145 --comment "사유")
  /ca-next (또는 /ca-analyze)                       (= code-agent start + 사이클을 plan 까지)
      analysis  /ca-analyze   → 01-requirements.md   질문 → AskUserQuestion → 답 기록 후 진행
      impact    /ca-impact    → 02-analysis.md
      design    /ca-design    → 03-design.md · 04-functional.md
      plan      /ca-plan      → plan.json + 07-test-spec.md → 제출(코드가 05-plan.md 렌더) 후 멈춤
  ────────────────────────────────  같은 세션: Task·순서·검증 계획 승인
  /ca-next                                          (= 단계 명령을 이어 도는 사이클)
      implement /ca-implement → 계획의 단계마다 서브에이전트, 커서가 check 에 닿을 때까지
        fix 면    → 테스트 단계가 먼저. 재현 테스트를 쓰고 code-agent repro (실패를 봐야 고칠 파일이 열린다)
      check     /ca-check     → build · 정적 분석·보안 명령 → 08-validation.md (코드만 쓴다)
      test      /ca-test      → ca-tester 가 ⑦ 의 TC 만 쓰고 CLI 가 돌린다 → 이후 테스트 동결
        실패 → 계획 안이면 고치고 check 부터 다시 (기본 2회) / 계획 밖이면 질문·재승인
      review    /ca-review    → 독립 ca-reviewer 호출·완료 관찰 → hook이 09-review.md 기록 → 수정 루프
      integrate /ca-integrate → 깨끗한 worktree 에서 전체 build · test
      deliver                 → 10-pr.md 의 요약·확인 방법·위험 (/ca-integrate가 작성 후 같은 세션 확인)
  ────────────────────────────────  같은 세션: 결과 확인 → 작업 브랜치 로컬 커밋
```

ID 없이 `/ca-request "원하는 동작"`으로 시작해도 된다. ID는 자동 발급하며, 설정·문서가 없으면 원문을 보존한 채 준비하고 같은 접수를 이어간다. 신규·기능 변경이라고 정한 경우 `/ca-feature`도 같은 접수를 수행한다. 신규 추천은 웹·API(JavaScript), 자동화(Python), 직접 선택이다. 기본 구성은 `docs recommend`와 `docs setup node|python`으로 만든다.

사람이 멈추는 자리는 **문서 확정(처음 또는 변경 시) · 요구사항 확정 · 필요한 질문 답변 · 계획 승인 · 반영 확인**이다. 문서는 한 번에 확정하고 기술 세부는 추천값으로 묶어서 보여 준다. 일반 작업은 요구사항 확정·계획 승인·반영 확인의 세 판정을 유지한다.

가운데 열이 **단계 명령**이다. 한 단계씩 끊어 결과를 보고 보완하고 싶으면 그것을 직접 부르고, 쭉 몰고 싶으면 `/ca-next` 를 부른다 —
절차는 단계 스킬 **하나**에만 있어 어느 쪽으로 가도 같은 파일을 읽는다. 잘못 온 자리는 `code-agent back <스테이지>` 로 **뒤로만** 되감는다.

---

## 4. 슬래시 명령 (Claude Code 안)

설치되는 스킬은 모두 **18개**다 — 아래 표의 8개와 [단계별 명령](#단계별-명령) 10개.

| 명령 | 하는 일 | 사용자 확인 | 상태 |
|---|---|---|---|
| `/ca-adopt` | 첫 도입 — 소스 기준·사용자 입력·기존 문서 연결로 문서와 설정 준비 | 같은 세션에서 준비 확인 | 구현됨 |
| `/ca-docs [종류]` | 공통 문서 점검·작성 (POLICY 4종 · KNOWLEDGE 3종) | 같은 세션에서 문서 확인 | 구현됨 |
| `/ca-feature [ID] <요구사항>` | 신규 개발·기능 추가·변경의 접수부터 개발·검증·로컬 반영까지 | 요구사항 · 질문 · 계획 · 결과 | 구현됨 |
| `/ca-answer` | 미응답 질문을 선택 도구로 다시 열고 기록 | — | 구현됨 |
| `/ca-next` | **사이클** — 지금 스테이지의 단계 스킬을 따르고 다음으로 이어 간다 | 선택·확인을 받고 이어간다 | 구현됨 (로컬 반영까지) |
| `/ca-status` | 위치·막힌 이유·다음 할 일 | — | 구현됨 |
| `/ca-fix [ID] <결함>` | 결함 수정 — 현행 분석·재현 테스트를 앞세운다 (`code-agent repro` 로 재현을 본 뒤에 고친다) | **요구사항 확정** · 질문 · 계획 승인 | 구현됨 (P6) |
| `/ca-refactor [ID] <요청>` | 리팩토링 — 보존 조건이 계획의 중심, 기존 테스트는 손댈 수 없다 | **요구사항 확정** · 질문 · 계획 승인 | 구현됨 (P6) |

### 단계별 명령

스테이지마다 명령이 하나씩이다. 하는 일은 **그 단계 스킬에만** 적혀 있고 `/ca-next` 사이클도 같은 파일을 읽는다 —
단계로 끊어 돌든 사이클로 몰든 절차가 갈리지 않는다.

| 스테이지 | 명령 | 하는 일 | 어디서 멈추나 |
|---|---|---|---|
| 접수 (작업 커서 전) | `/ca-request [ID] [--kind <종류>] <요구사항>` | 사람이 준 원문을 보관하고 `request.json` 으로 정리해 제출 → 코드가 지시서를 렌더 | **같은 세션의 요구사항 확인** |
| `analysis` | `/ca-analyze [--base] [--target]` | ① `01-requirements.md` — analyst. 진행 중인 작업이 없고 요구사항이 `확정됨` 이면 `code-agent start doc/work/<ID>/requirement.md` 부터 | 질문 · `code-agent next` |
| `impact` | `/ca-impact` | ② `02-analysis.md` — explorer 병렬 → writer | 질문 · `code-agent next` |
| `design` | `/ca-design` | ③ `03-design.md` · ④ `04-functional.md` — writer | 질문 · `code-agent next` |
| `plan` | `/ca-plan` | ⑤ `plan.json` · ⑦ `07-test-spec.md` → critic → `plan submit`. 반려 사유를 읽는 자리도 여기다 | **같은 세션의 계획 승인** |
| `implement` | `/ca-implement` | 계획의 단계마다 implementer(테스트 단계는 tester), 커서가 `check` 에 닿을 때까지. `fix` 는 테스트 단계가 먼저이고 그 뒤 `code-agent repro` | hook 거부 · 재현 실패 · 질문 · `check` 도달 |
| `check` | `/ca-check` | `code-agent check` — build + 정적 분석·보안. **↺ 수정 루프의 정의가 여기 있다** | 실패 · `code-agent next` |
| `test` | `/ca-test` | tester 가 ⑦ 의 TC 만 → `code-agent test`, 이후 테스트 동결 | 실패 · `code-agent next` |
| `review` | `/ca-review` | 독립 reviewer 실행·완료를 관찰한 hook이 ⑨ `09-review.md`에 자동 기록 | 열린 지적 · `code-agent next` |
| `integrate` | `/ca-integrate` | `code-agent integrate` → 이어서 ⑩ `10-pr.md` 의 모델 구역 | **같은 세션의 최종 반영 확인** |

`code-agent approve` · `reject` 는 **스테이지에 묶이지 않는다.** `plan` 에서만 받는 것이 아니라, `implement` 이후에 승인이
`stale-*` 로 돌아서 다시 받아야 할 때도 같은 명령 그대로다 — 커서가 어디에 있든 제출된 계획이 있으면 판정한다.

각 단계 스킬은 먼저 `code-agent status` 로 **자리를 확인한다.** 커서가 그 스테이지가 아니면 일하지 않는다 —
아직 이르면 먼저 할 명령을 알려 주고, 이미 지났으면 `code-agent back <스테이지>` 로 되감아야 한다고 알린다.
**되감기는 사용자가 되돌리라고 말했을 때만** 돈다.

`code-agent back <스테이지>` 는 **뒤로만** 간다. 커서만 움직이고 증거·승인 원장·작업 문서는 그대로 둔다 — 그래서:

- `design` 이하로 되감아 `01`~`04`·`07` 을 고치면 계획 승인이 `stale-docs` 가 된다. 다시 제출하고 다시 승인받아야 코드를 쓸 수 있다.
- 되감아도 **수정 회차는 초기화되지 않는다.** 증거가 `planHash` 에 묶여 있어 같은 계획이면 같은 카운터다.
- `plan` 으로 되감아 **같은 계획을 그대로** 다시 제출하면 승인은 살아 있다.
- `implement` 로 되감아도 **테스트 동결과 고쳐 쓰기 한도는 그대로다.** 둘 다 커서가 아니라 증거를 보고 막는다.
- `deliver` 에서는 되감지 않는다 — 사람이 확인 화면 앞에 서 있는 자리다. 되돌릴 일이 있으면 사람이 직접 돌린다.

### `/ca-adopt`

레거시 저장소에 처음 들일 때. `code-agent docs begin` 으로 문서 세션을 열고 `code-agent survey` 로 저장소 개요와 **도구 후보**(테스트·정적 분석·보안 의존성, CI 설정)를 받은 뒤,
`ca-surveyor` 여럿을 병렬로 돌려 POLICY 4종 초안과 KNOWLEDGE 3종 뼈대를 쓰고, `code-agent.json` 을 만든다.

사람이 하는 일 — 신규에서는 목적에 맞는 추천 또는 직접 선택. 기존에서는 탐지한 설정을 묶어서 확인한다. 내부 속성을 하나씩 결정할 필요는 없고, 기술 기본값과 근거는 문서·설정 요약에서 검토한다.
끝나면 `code-agent manifest check` 가 ✓ 여야 한다. `- 확인:` 으로 시작하는 줄은 **경고**다 (종료 코드 0) —
종류별로 돌 단계가 0개거나, `kind: "test"` 단계가 없거나, 참조 파일을 선언한 단계가 없으면 여기서 알려 준다.

- **`kinds`** — 코드 단계·테스트 단계에는 `["feature", "fix", "refactor"]` 를 기본으로 단다. 비우면 모든 종류에서 돌지만,
  명시하는 쪽이 매니페스트만 읽고도 어떤 종류가 도는지 보인다. 종류 하나만 도는 단계(신규 도메인 뼈대 등)가 있으면 거기만 좁힌다.
- **`prepare`** (선택) — 통합 검증의 깨끗한 worktree 에서 `build`·`test` **앞에** 한 번 도는 준비 명령 (예: `["npm", "ci"]`).
  기준 커밋을 뜬 트리에는 의존성처럼 커밋되지 않는 것이 없어서 두는 자리다. 필요 없으면 **아예 적지 않는다** — 빈 배열(`[]`)은 형식 오류다
  (선언은 해시를 바꾸고 `manifest check` 에도 실려 "돈다" 로 읽히는데 `integrate` 는 건너뛴다).
  `check`·`test` 에서는 돌지 않고 — POLICY 문서의 명령 목록에 `prepare` 를 적어도 거기서는 풀리지 않는다 —
  `commands` 의 키로도 쓸 수 없다 (`build`·`test` 와 같은 예약 이름).

**소스 파일이 없는 저장소** — `code-agent survey` 가 `소스 파일이 없습니다 — 신규(빈) 저장소입니다` 를 찍으면 역공학할 것이 없다.
(빌드 파일은 있는데 아는 확장자의 소스만 없으면 `지원 목록 밖 언어입니다` 로 찍힌다 — 그때는 **사람에게 확인하고** 갈라진다.)
`/ca-adopt` 는 `ca-surveyor` 를 부르지 않고 **인터뷰**로 간다 — POLICY 4종은 `docs interview`, `code-agent.json` 은 사용자에게 묻는다
(언어 · 소스 루트 · 단계 목록과 `outputDirs` · 테스트 단계의 `"kind": "test"` · `build`·`test`·`prepare` · `git.base`).
`referenceDomain` 은 적지 않고 `exemplars` 는 전부 `[]` 로 두며, 복제할 표준이 없으므로 단계는 `"scope": "project"` 가 자연스럽다.
그 뒤 `code-agent context` 는 참조 표준 코드 대신 **아키텍처·컨벤션 문서**를 가리킨다.
"빈 저장소" 는 **소스가 없는 저장소**이지 커밋이 없는 저장소가 아니다 — `start` 는 기준 커밋을 굳힐 수 없으면 거부하므로,
`/ca-adopt` 가 만든 것을 사람이 한 번 커밋한 뒤에 작업이 시작된다.

### `/ca-docs [종류]`

공통 문서 게이트를 여는 명령. 레거시의 필수 문서가 없거나 부족하면 선택 도구로 **소스·설정 기준으로 작성(추천) / 사용자 선택·입력으로 작성 / 기존 문서 연결** 중 한 방식을 고른다. 사용자 입력이 현재 코드와 다르면 현행과 변경할 방향을 구분한다. 문서 작성으로 코드 변경을 승인하지 않는다. 빈 저장소는 초기 구성 선택에 따라 문서를 만들고 확정 전까지 분석을 막는다. 이미 답한 방식이나 완성된 문서 때문에 질문을 반복하지 않는다.

| 경로 | 언제 | 어떻게 |
|---|---|---|
| 기본으로 생성 | 코드가 있을 때 | `survey` → `ca-surveyor` 병렬 → `ca-writer` 가 작성. 코드로 알 수 없는 것은 POLICY 면 `확인 필요`, KNOWLEDGE 면 **빈칸** |
| 대화로 생성 | 신규거나, 의도·정책·임계처럼 코드에 없는 것 | `code-agent docs interview <종류>`의 후보로 메인이 AskUserQuestion을 구성하고 답을 기록한다 (한 번에 최대 4개 질문) |
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
모델이 임의로 확정하지 않는다. 사용자가 같은 세션에서 문서를 읽고 일괄 확정한다. 개별 확정과 직접 TTY 경로도 유지한다.

테스트 전략의 `도구와 실행 명령`, 품질·보안 기준의 `정적 분석`·`보안 검사` 는 **명령 이름 대조**를 더 받는다 —
첫 목록의 백틱 이름(``- `unit`: …``)이 `code-agent.json` 의 `build`·`test`·`commands` 키에 실재해야 한다.
없으면 섹션 미충족으로 막힌다. 자동 검사가 없는 갈래는 `없음` 으로 적고, `없음` 은 대조하지 않는다.

**KNOWLEDGE 3종**은 **파일 존재만** 본다. 섹션 검사도 확정도 없고, 비어 있어도 작업을 막지 않는다.
모델은 작업 중에 이 파일들을 쓰지 않는다 — 인용만 하고, 제안은 `doc/work/<ID>/knowledge.proposal.md` 에 적는다.
갱신은 반영(`code-agent deliver`)에서 사람이 항목을 고른 뒤 코드가 한다 (키 단위 upsert, 삭제 없음).

### `/ca-request [ID] [--kind <feature|fix|refactor>] <요구사항>`

**요구사항 접수** — 13단계의 1이다. 사람이 손으로 지시서를 쓰던 자리가 여기다.
요구사항은 **말로** 준다 — 서술이든, 붙여넣은 티켓이든, 저장소 안의 파일 경로든.

1. `code-agent request begin [ID] --kind <종류> [--base <기준 브랜치>] [--target <대상>]` — 접수 세션(`.code-agent/request-session.json`)을 열고
   초안 형식 · 규칙 · **대상 후보**(도메인 디렉토리)를 찍는다 — `feature` 는 `- <이름> (<경로>)` 로 보여 주고 `target` 에는 **이름**만 쓰고, `fix`·`refactor` 는 경로를 보여 주고 경로를 쓴다.
   다시 보려면 `code-agent request` (접수 중에는 `code-agent context` 도 같은 것을 준다).
   `--base`·`--target` 은 세션 파일에 남아 **확정 뒤 `start` 가 쓴다** — 접수와 시작 사이에 사람의 확정이 끼어 명령이 끊기기 때문이다 (`start` 에 직접 준 값이 이긴다).
   **ID는 선택이다** — 티켓 ID는 그대로, 생략하면 CLI가 미사용 WORK 번호를 발급한다 (명시적 ID는 영문·숫자로 시작, `[A-Za-z0-9._-]` 64자 이하).
   일반 접수 쓰기는 `doc/work/<ID>/` 안이며 **지시서 자체는 코드가 렌더한다**. 준비가 필요하면 접수를 유지한 채 `docs begin`으로 문서 세션을 열고 그 허용 범위에서 공통 문서·설정을 보완한다.
2. 모델이 `doc/work/<ID>/request.json` 을 쓴다. **원문은 한 글자도 바꾸지 않는다** — 글이면 `original`,
   파일이면 `originalFile` 에 저장소 기준 경로를 적고 **코드가 그 파일을 그대로 옮긴다**.
   원문을 먼저 저장하고 설정·공통 문서가 없으면 준비·확정 뒤 같은 접수로 돌아온다. `sourceMap`으로 원문과 구조화 항목을 연결하며 미연결은 확정 요청 전에 보완한다.
   원문에 없는 요구는 더하지 않는다 — 있으면 좋겠다 싶은 것은 질문으로 (AskUserQuestion으로 최대 4개 질문씩, 실제 답은 `clarifications`에 그대로).
3. `code-agent request submit doc/work/<ID>/request.json` — 형식을 검사하고 `requirement.md` 를 렌더한다.
   렌더한 결과는 **손으로 쓴 지시서와 똑같은 검사**를 받고(머리말 규격 · `target`·`scope` 실재 · 프로젝트 확장 속성),
   머리말에 옮긴 값이 그대로 다시 읽히는지(round-trip)까지 본다. 하나라도 어긋나면 **파일을 쓰지 않는다**.
4. 사람이 **같은 세션**의 request 확인에서 — 원문과 정리를 나란히 읽고 확정한다.
   지시서를 생략하면 진행 중인 작업의 지시서, 없으면 `doc/work/<ID>/requirement.md` 다 — **다른 자리에 손으로 쓴 지시서는 경로를 함께 준다.**
   반려는 `code-agent reject request <ID> [<지시서>] --comment "사유"` (사유 필수). 판정은 `.code-agent/approvals/<ID>/request.jsonl` 에 해시 사슬로 남는다 —
   원장은 **같은 ID 이면서 같은 지시서 경로**인 줄만 그 지시서의 판정으로 읽는다.
5. 확정되면 `/ca-next`(또는 `/ca-analyze`)가 `code-agent start doc/work/<ID>/requirement.md` 로 분석을 시작한다.

```jsonc
// doc/work/ORD-12/request.json — 모델이 쓴다
{
  "kind": "fix",
  "id": "ORD-12",
  "title": "결제 뒤 24시간 안에는 주문을 취소할 수 있게",
  "target": ["src/main/app/order"],
  "scope": ["src/main/app/order"],
  "preserve": ["주문번호 발급 규칙", "POST /orders 응답 형식"],
  "original": "결제 뒤 24시간 안에는 주문을 취소할 수 있게 해 주세요.\n\n배송이 시작되면 안 됩니다.",
  "background": "고객센터에 취소 문의가 하루 20건씩 들어온다.",
  "requirements": ["결제 뒤 24시간 안의 주문을 취소한다", "배송이 시작된 주문은 취소하지 않는다"],
  "done": [],
  "outOfScope": ["부분 취소"],
  "constraints": [],
  "clarifications": [{ "question": "24시간은 결제 시각 기준인가요?", "answer": "네, 결제 완료 시각부터입니다" }]
}
```

- `original` 과 `originalFile` 은 **정확히 하나**만 쓴다. `requirements` 는 1개 이상.
- 머리말에 들어가는 값(`title` · `target` · `scope` · `preserve` · `approver` · `extra`)은 **한 줄씩**, 따옴표나 `[ ]` 로 감싸지 않는다.
- `fix` · `refactor` 는 `target` 이 **저장소에 있는 경로**이고 `scope` · `preserve` 가 필수다. `feature` 의 `target` 은 이제부터 만들 도메인·기능 이름이라 경로가 아니어도 된다.
- `extra` 는 `code-agent.json` 이 선언한 확장 속성만 — 예약 이름(`kind` `id` `title` `target` `scope` `preserve` `approver`)은 쓸 수 없고,
  속성 이름은 **영문으로 시작하는 `[A-Za-z0-9_-]`** 여야 한다 (머리말 파서가 읽는 이름 규칙 그대로).
- **반려된 그 내용 그대로는 다시 제출되지 않는다** — 사유를 읽지 않은 재제출은 사람에게 같은 화면을 한 번 더 보일 뿐이라 `request submit` 이 거부한다.

렌더되는 지시서 (`doc/work/ORD-12/requirement.md` — **코드만 쓴다**).

```markdown
---
kind: fix
id: ORD-12
title: 결제 뒤 24시간 안에는 주문을 취소할 수 있게
target:
  - src/main/app/order
scope:
  - src/main/app/order
preserve:
  - 주문번호 발급 규칙
  - POST /orders 응답 형식
---

<!-- 이 파일은 code-agent request submit 이 doc/work/ORD-12/request.json 에서 렌더한다. … -->

# ORD-12 요구사항 — 결제 뒤 24시간 안에는 주문을 취소할 수 있게

## 원문

<!-- 원문: 사람이 준 글 (접수 초안의 original) -->
> 결제 뒤 24시간 안에는 주문을 취소할 수 있게 해 주세요.
>
> 배송이 시작되면 안 됩니다.

## 배경

고객센터에 취소 문의가 하루 20건씩 들어온다.

## 요구 내용

- 결제 뒤 24시간 안의 주문을 취소한다
- 배송이 시작된 주문은 취소하지 않는다

## 완료 조건

- 원문에 없음 — 분석 단계의 수락 기준(AC)에서 정한다

## 범위 밖

- 부분 취소

## 제약

- 없음

## 접수 때 정한 것

- Q: 24시간은 결제 시각 기준인가요?
  - A: 네, 결제 완료 시각부터입니다
```

`## 원문` 은 **사람이 준 글 그대로** 인용으로만 감싼 것이다 — 확정하는 사람이 정리본과 나란히 읽는 자리다.
요약·교정하다 뜻이 달라지면 거기서 잡힌다.

접수 중에 `code-agent status` 를 치면 작업 대신 접수가 보인다.

```
작업: 아직 시작 전
접수: ORD-12 (fix) — 작업 폴더 doc/work/ORD-12/ · 시작할 때 기준 브랜치 develop · 대상 src/main/app/order
초안: doc/work/ORD-12/request.json
요구사항: 확정 대기
다음: 현재 Claude 세션에서 요구사항을 확인한 뒤 분석으로 이어갑니다.
```

`시작할 때 …` 꼬리는 `request begin` 에 `--base`·`--target` 을 준 경우에만 붙는다 — 확정 뒤 `start` 가 쓸 값이 그것이라는 표시다.

**손으로 쓴 지시서도 그대로 쓴다** — 접수를 거치지 않고 `doc/work/<ID>/requirement.md` 를 사람이 써 둬도 되고,
형식은 [requirement.md](requirement.md) 그대로다. 다만 **확정은 똑같이 받는다** (`code-agent confirm request <ID>`).
**다른 자리에 썼으면 경로를 함께 준다** — `code-agent confirm request <ID> <지시서>`. 확정은 그 경로에 묶이므로,
확정한 지시서와 `start` 에 넘기는 지시서가 같은 파일이어야 한다. `start` 가 거부할 때는 **그 경로가 박힌 확정 명령을 그대로 찍어 준다.**
확정 뒤에 지시서를 손으로 고치면 그 즉시 확정이 풀리고, 계획 승인도 `stale-docs`(머리말을 고쳤으면 `stale-order`) 가 된다.
시작은 `/ca-analyze <지시서>` (또는 터미널의 `code-agent start <지시서>`) 로 한다 — 그 자리에 접수를 다시 돌리지 않는다. `request submit` 은 사람이 쓴 지시서를 덮지 않는다.

### `/ca-feature [ID] <요구사항> [--base <기준 브랜치>] [--target <대상>]`

신규 개발·기능 추가·기능 변경을 `feature`로 접수하고 **계획 제출까지** 간다. 인자는 지시서 경로가 아니라 **작업 ID 와 요구사항**이다 (티켓을 그대로 붙여넣어도 된다).

1. 접수 — 작업도 접수도 없으면 바로 위 `/ca-request` 의 절차를 **종류 `feature`** 로 그대로 돈다.
   제출하면 같은 세션의 선택 화면에서 확정을 받고 분석으로 이어간다.
2. `code-agent start` — 확정된 지시서만 받는다. 머리말을 검사하고, 작업 브랜치 `<종류>/<ID>` 를 따고, `questions.md` 를 만들고,
   커서를 `analysis` 에 두고 **접수 세션을 닫는다**.
3. 그 뒤는 **사이클을 `plan` 까지** 돈 것과 같다 — `/ca-analyze` → `/ca-impact` → `/ca-design` → `/ca-plan`.
   각 단계가 무엇을 하는지는 [단계별 명령](#단계별-명령)과 [단계마다 실제로 도는 것](#단계마다-실제로-도는-것).
4. 계획을 제출하면 같은 세션의 선택 화면에서 승인받고 구현으로 이어간다.

지시서는 `doc/work/<Jira 키>/requirement.md` 다. **모델은 이 파일을 쓸 수 없다** — 접수 중에도, 작업 중에도 hook 이 거부한다.
요구가 모호하면 지시서를 고치는 대신 `questions.md` 에 질문으로 남는다. 요구사항 자체가 틀렸으면 `request.json` 을 고쳐 다시 제출하고,
**사람이 다시 확정한다** (작업 중에도 같은 ID 면 다시 낼 수 있다 — 그 대신 이미 받은 계획 승인이 무효가 된다).
그때 초안 형식은 `code-agent request` 가 작업 중에도 그대로 보여 준다 (`code-agent context` 는 작업 중이면 스테이지 컨텍스트를 준다).

중간에 한 단계를 다시 보고 싶으면 그 명령을 직접 부르면 된다 (`code-agent back <스테이지>` 로 되감은 뒤 `/ca-design` 처럼).

문서마다 Bash: `code-agent docs skeleton <종류>` 로 뼈대를 받아 쓴다. **`05-plan.md` 는 모델이 쓸 수 없다** — 고칠 것이 있으면 `plan.json` 을 고쳐 다시 제출한다.

기준 브랜치는 `code-agent start --base` > **접수 때 준 `--base`** > `code-agent.json` 의 `git.base` > `master` 순이다.
지시서에 `target` 이 여럿이면 `--target` 으로 고른다 — 이것도 접수 때 준 값이 세션에 남아 있다가 `start` 가 쓰고, `start` 에 직접 준 값이 이긴다.
접수와 시작 사이에는 사람의 확정이 끼어 명령이 끊기므로, 여기 남겨 두지 않으면 `/ca-feature … --base develop` 의 기준 브랜치가 확정 뒤에 사라진다.

### `/ca-answer`

`/ca-answer`는 모든 명령이 공유하는 선택형 질의응답 절차이며, 직접 호출하면 미응답 질문을 재개한다. 메인이 `AskUserQuestion`을 호출하고 선택한 이름 또는 직접 입력을 `[Answer]:`에 그대로 기록한다. 다른 명령에서 이 절차를 사용할 때는 답을 받은 뒤 그 명령으로 복귀한다. 질문이 생겼다는 이유만으로 `/ca-answer`를 다시 입력하게 하지 않는다.

추천할 근거가 있으면 첫 후보에 `(추천)`과 이유를 붙인다. 초기 언어·구성은 7개 후보이며 Node/Python은 `docs setup`, 나머지는 `/ca-adopt`의 문서·설정 작성으로 연결한다. 대안이 많은 질문은 최소 5개 실제 후보를 제공하고, 후보가 적은 업무 결정은 억지로 늘리지 않는다. 5개 이상 후보는 전체 목록을 먼저 보여 주고 최대 4개 옵션 안에서 `다른 선택지`·`앞 선택지`로 이동한다. 페이지 이동은 답이 아니다.

작업 ID가 있으면 `doc/work/<ID>/questions.md`, ID 없는 문서 준비는 열린 문서 세션의 `doc/code-agent/setup-questions.md`에 질문·후보를 먼저 기록한다. 읽기 전용 명령은 대화의 도구 응답을 사용한다. 도구가 없거나 거부되면 미응답을 유지하고 대화형 Claude Code에서 이어가도록 안내한다.
필수 업무 질문을 모르면 비워 둔다. 기존 구성으로 정할 수 있는 기술 선택은 근거를 가정에 기록하고 다시 묻지 않는다. ‘추천대로’라는 선택은 기술 결정에 적용하며 업무 규칙을 지어내지 않는다. 주석·구분선만 있는 답은 미응답이다. 답이 모두 채워지면 에이전트가 현재 단계부터 자동 재개한다.

### `/ca-next`

**사이클**이다. `code-agent status` 로 스테이지를 보고, 그 스테이지의 단계 스킬(`.claude/skills/ca-<명령>/SKILL.md`)을 그대로 따르고,
게이트를 지나면 다음 스테이지의 단계 스킬로 이어 간다. **사용자 판단이 필요하면 같은 세션에서 질문한다.**
필수 질문 미응답·보류·취소, 반려, 계획 밖 실패·지적, 수정 한도 초과, 명령 거부에서는 멈춘다. 정상적인 요구·계획·결과 확인은 같은 세션에서 선택받고 이어간다.

작업이 아직 시작 전이고 접수 중이면 **접수가 첫 칸**이다 — `/ca-request` 의 절차를 따르고, 요구사항이 `확정됨` 이면
`code-agent start doc/work/<ID>/requirement.md` 로 시작해 `analysis` 로 이어 간다.

사이클 자체에는 절차가 없다. 그래서 `/ca-next` 로 몰든 단계 명령으로 끊어 돌든 도는 내용이 갈리지 않는다.
사용자가 되돌리라고 하면 `code-agent back <스테이지>` 를 돌리고 그 자리부터 다시 돈다 — 사이클이 스스로 되감지는 않는다.

### 단계마다 실제로 도는 것

신규 작업의 분석·영향도·설계·계획은 [관찰된 계획 작업](planning.md)의 배정·완료 계약으로 아래 내용을 생성한다. 번호 문서는 관찰 hook이 기록하고, 이전 버전 작업은 기존 작성 절차로 재개한다.

- 접수(`/ca-request`) — `request.json`을 쓰고 `code-agent request submit`으로 지시서를 렌더한 뒤 같은 세션에서 확정받고 분석으로 이어간다. 요구 정리는 원문과 명령 출력을 근거로 하며, 공통 문서 준비가 필요하면 별도의 준비 절차에서 기존 소스를 확인한다.
  확정은 사람이 같은 세션의 선택 화면에서 하고, 그 전에는 작업 폴더 밖이 전부 닫혀 있다 (빌드·테스트 명령도 열리지 않는다 — 돌릴 코드가 아직 없는 자리다).
- `analysis`(`/ca-analyze`) — ① `01-requirements.md`. `ca-analyst` 가 요구 항목 `## R<n>`(각각 `근거:`)·`## 가정`·`## 범위 밖` 을 뽑는다. 질문은 선택 도구로 받고 답을 반영한다. 필수 답이 없으면 멈춘다.
  `근거:` 는 접수가 렌더한 지시서에서는 `## 원문` · `## 요구 내용` · `## 완료 조건` · `## 접수 때 정한 것` 에서 찾는다 (손으로 쓴 지시서는 그 본문에서 인용한다).
- `impact`(`/ca-impact`) — ② `02-analysis.md`. 요구 항목을 닿는 영역으로 묶어 `ca-explorer` 를 병렬로 돌리고 `ca-writer` 가 쓴다.
  `doc/knowledge/` 에 키가 있어도 explorer가 현재 코드와 호출자 영향을 확인한 뒤 인용한다.
- `design`(`/ca-design`) — ③ `03-design.md` · ④ `04-functional.md` 를 `ca-analyst` 가 판단해 같은 스테이지에서 함께 작성한다. AC(`AC-R<n>-<m>`)가 여기서 나온다.
  지시서의 `## 완료 조건`(또는 수락 기준) 문장은 **그대로** AC 에 옮긴다 — 사람이 확정한 완료 조건을 다듬다 뜻이 달라지는 자리를 막는다.
- `plan`(`/ca-plan`) — ⑤ `plan.json` + ⑦ `07-test-spec.md` → `ca-critic` 반박 검토 → `code-agent plan submit` (통과하면 코드가 `05-plan.md` 를 렌더한다).
  여기서는 `code-agent next` 를 돌리지 않는다 — 이 문을 여는 것은 게이트가 아니라 같은 세션의 관찰된 승인이다. 반려 사유를 읽고 다시 내는 자리도 여기다.
- `implement`(`/ca-implement`) — 단계마다 `code-agent context` 로 만들 파일·단계 규칙·참조 표준 코드를 받아 `ca-implementer`(테스트 단계면 `ca-tester`)에게 넘기고, 끝나면 `code-agent next`.
  **`fix` 는 `kind: "test"` 단계가 맨 앞에 선다** — 재현 테스트를 쓰고 `code-agent repro` 로 지금 코드에서 그 TC 가 실패하는 것을 봐야 나머지 단계의 파일이 열린다.
  참조 도메인이 없는 저장소에서는 context 가 참조 표준 코드 대신 아키텍처·컨벤션 문서를 가리킨다(`참조 없음 — 아키텍처·컨벤션 문서로`).
- `check`(`/ca-check`) — `code-agent check` 가 `build` + 품질·보안 기준의 명령을 돌린 결과만 게이트를 연다. 모델이 직접 돌린 빌드는 세지 않는다.
- `test`(`/ca-test`) — ⑦ 에 코드가 없는 TC 가 남아 있으면 `ca-tester` 가 **그대로, 그것만** 쓰고(매니페스트에 `kind: test` 단계가 있으면 `implement` 에서 이미 다 썼다) `code-agent test` 가 돌린다.
  필수 TC마다 실제 `passed` 결과가 있어야 한다. skip·미실행·결과 누락은 통과하지 않는다. 같은 기준을 깨끗한 worktree 통합 검증에도 별도로 적용한다.
  이 실행 뒤 `kind: test` 단계의 파일은 **언다** — 실패해도 단언을 고쳐 통과시킬 수 없다.
- `review`(`/ca-review`) — context와 확정 지시서·01~04·07·08 문서, 이번 실행 로그, 영향도 문서에서 지정한 호출자·공유 모듈·기존 회귀 테스트 경로를 독립 `ca-reviewer`에게 준다.
  요구사항 명확성·기능 위반·기존 기능에 미치는 영향·전체 테스트와 실패 케이스를 대조한다. 실패 상황을 검증하는 테스트도 실제 결과는 passed여야 한다. 필요한 근거가 없으면 검증 공백으로 보고하며, 계획 밖 관련 파일은 읽기만 할 수 있다.
  리뷰어는 전달된 범위에서 검토하고 `| id | 계획 파일 | 범위 | 상태 | 지적 |` 표로 답한다 — 열 순서는 코드가 칸 위치로 읽어 고정이고,
  계획 파일은 저장소 기준 경로 그대로(백틱·`:줄번호` 없이), 상태는 `열림` · `해결` 둘뿐이다. SubagentStart·SubagentStop hook이 실행·결과를 회차에 묶고 `09-review.md`의 `## 지적`을 자동 기록한다. 메인은 표나 상태를 바꾸지 않는다.
  회차 머리(번호·시각·기준 트리 해시)는 코드가 적는다. 마지막 회차의 **독립 리뷰 완료 기록·결과 일치·현재 트리 일치**가 필요하고 열린 지적이나 계획 밖 지적이 있으면 통과하지 못한다. 설치를 갱신한 뒤 `code-agent doctor`에서 리뷰 hook 두 개도 확인한다.
  얼어 있던 테스트 파일을 지적으로 푼 경우 **그 줄은 코드가 기억한다** — 쓰고 나서 지우면 `review` → `integrate` 가 막힌다.
- `integrate`(`/ca-integrate`) — `code-agent integrate` 가 기준 커밋에서 뜬 깨끗한 worktree 에 계획 파일만 얹고 전체 build·test 를 돌린다.
  매니페스트에 `prepare` 가 있으면 **그것이 먼저** 돌고, 실패하면 build·test 는 돌지 않는다 — 준비되지 않은 트리 위의 통과는 증거가 아니다.
- `deliver` — 같은 `/ca-integrate` 가 이어서 한다. 모델은 ⑩ `10-pr.md`의 `요약`·`확인 방법`·`위험·되돌리기`를 작성한 뒤 같은 세션에서 최종 확인을 받는다. 추적표·검증 블록과 커밋은 `code-agent deliver` 의 몫이다.
- **↺ 수정 루프** (정의는 `/ca-check` 에 있고 `test`·`review`·`integrate` 가 그것을 가리킨다) — 실패·지적 중 **계획 안**은 `ca-implementer` 가 지목된 파일만 고치고 `check` 부터 다시 돈다.
  `code-agent check` 는 `test` · `review` · `integrate` 어디서 불러도 커서를 그 자리로 되감는다. 회차는 코드가 세고 기본 2회이며, 한 번 시작한 루프는 시작할 때의 한도로 끝난다.
  **계획 밖**은 고치지 않는다 — `questions.md` 에 질문으로 남기거나 계획을 고쳐 재승인한다. 한도를 넘기면 hook 이 계획 파일 쓰기를 전부 막고 보고만 남는다.
- 모든 명령의 질의응답은 메인이 `AskUserQuestion`으로 받는다. 질문만 마지막 메시지에 나열하고 끝내지 않는다.

### `/ca-status`

`code-agent status` 를 그대로 보여 주고 마지막 `다음:` 줄을 한 문장으로 풀어 준다.

### `/ca-fix` · `/ca-refactor`

`/ca-feature` 와 **같은 단계 스킬을 같은 순서로** 돌아 계획 제출까지 간다 — 접수도 같고, 종류만 `fix` · `refactor` 로 간다.
접수에서 `target` 은 **저장소에 있는 경로**(결함이 나는 곳 · 바꿀 곳)이고 `scope`(건드려도 되는 경로) · `preserve`(바뀌면 안 되는 것)가 **필수**다 —
원문으로 정할 수 없으면 접수에서 묻는다. 다른 점은 **전부 코드가 막는다** — 스킬 지시가 아니다.

**`fix` — 재현이 먼저다.**

| 자리 | 무엇 | 어디서 막히나 |
|---|---|---|
| ② `02-analysis.md` | `기존 시스템 분석` 에 **결함이 나는 경로**를. `해당 없음` 으로 비울 수 없고 근거 `path:line` 이 최소 하나 | `code-agent next`(impact) |
| ⑦ `07-test-spec.md` | `## 재현` 절에 재현 TC id 를 `- TC-1` 로 한 줄씩. 수준은 무엇이든 되고, 적은 id 는 표에 실재해야 한다 | `code-agent next` · `plan submit` |
| ⑤ `plan.json` | `sequence[0]` 이 `kind: "test"` 단계이고, `files[]` 에 그 단계의 파일이 있을 것. 그 단계에 적은 파일은 **그 단계가 밝힌 테스트 자리 안**이어야 한다 — 고칠 파일을 테스트 단계에 적어 넣으면 재현이 비껴간다 | `code-agent plan submit` |
| `implement` | 커서가 **테스트 단계에 먼저** 선다. 재현 테스트를 쓰고 `code-agent repro` — 지금 코드에서 그 TC 가 **실패**해야 고칠 파일이 열린다 | PreToolUse hook · `code-agent repro` |
| `test` | 같은 TC 가 이제 **통과**해야 한다 | `code-agent next` |

`code-agent repro` 가 인정하는 것은 `failed` 뿐이다. `passed` 는 재현하지 못한 것이고, `not-run`·`error` 는 아무것도 증명하지 않는다.
그리고 **재현 TC id 가 실패한 그 실행의 출력에 찍혀야** 한다 — 테스트 파일에 id 가 적혀 있는 것은 여기서 인정하지 않는다
(파일을 grep 한 것은 *무엇이* 실패했는지 말해 주지 않아, 다른 TC 의 실패도 깨진 import 도 같은 `failed` 로 보인다).
컨벤션의 `테스트 규칙` 대로 테스트 이름에 TC id 를 남기면 실패 보고에 그대로 찍힌다.
비-테스트 계획 파일이 이미 바뀌어 있으면 거부한다 — 재현은 "테스트만 바뀐 트리" 에서 봐야 증거가 된다.
통과하면 그 순간부터 `kind: "test"` 단계의 파일이 **언다** (테스트가 아직 한 번도 돌지 않았어도).
`code-agent back implement` 로도 풀리지 않는다 — 증거로 재기 때문이다. 계획을 다시 승인하면 재현 증거도 함께 버려져 다시 봐야 한다.
⑨ 지적으로 동결을 풀어 재현 테스트를 고쳤으면 **통합 검증 앞에서 걸린다** — ⑧·⑩ 이 찍는 재현 줄은 반영될 테스트를 가리켜야 한다.

**`refactor` — 동작 보존.**

| 자리 | 무엇 | 어디서 막히나 |
|---|---|---|
| ② `02-analysis.md` | `기존 시스템 분석` 에 **지금 동작**을 (fix 와 같은 두 규칙) | `code-agent next`(impact) |
| ⑤ `plan.json` | 지시서의 `preserve` 문장을 **그대로** 전부. **기준 커밋에 이미 있던 `kind: "test"` 단계 파일은 넣을 수 없다** | `code-agent plan submit` |
| 쓰기 | 그 테스트 파일을 고치거나 지우려 하면 거부 | PreToolUse hook |
| `check`·`test`·`integrate` | 그 파일이 바뀐 채로는 검증이 서지 않고, 기존 테스트 스위트가 통째로 통과해야 한다 (`not-run` 은 통과가 아니다) | `code-agent check` · `next` |

고쳐야 할 이유가 보이면 고치지 말고 `questions.md` 로 묻는다 — **동작이 보존되는지 보는 것이 그 테스트**다.

무엇이 "기존 테스트" 인지는 **매니페스트의 모든 `kind: "test"` 단계가 밝힌 자리**로 정한다 — `scope: "project"` 의 `outputDirs`
또는 `base`, 그 둘뿐이다. `kinds` 로 거르지 않으므로 `kinds` 에서 `refactor` 를 빼도 보호는 그대로 걸리고, `domainBase` 로 물러서지
않으므로 테스트가 소스 옆에 있는 프로젝트에서 소스 루트 전체가 테스트로 읽히는 일도 없다. 자리를 밝히지 않은 단계는 **보호가 없다** —
`code-agent manifest check` 가 그 사실을 경고한다.

**종류별 단계** — 어떤 종류로 어떤 단계가 도는지는 `code-agent.json` 의 `stages[].kinds` 가 정한다 (비우면 모든 종류).
`fix` 로 돌 `kind: "test"` 단계가 없으면 `plan submit` 이 재현 테스트를 넣을 자리를 찾지 못하고, 종류별 단계가 0개면 `start` 가 거부한다.
`code-agent manifest check` 가 그 둘과 **자리를 밝히지 않은 `kind: "test"` 단계**를 **경고**로 미리 낸다 (경고는 종료 코드 0).

검증 스테이지(`check` · `test` · `review` · `integrate` · `deliver`)의 나머지는 종류를 가리지 않고 그대로 돈다.

---

## 5. 터미널 명령 (사람)

아래 표는 직접 CLI를 선택한 사용자를 위한 참조다. 일반 사용의 확인은 같은 Claude Code 세션에서 처리하며, 이 명령들을 따로 입력할 필요가 없다.

| 명령 | 하는 일 | TTY 필요 |
|---|---|---|
| `code-agent init [--cli <경로>]` | 이 저장소에 설치 | — |
| `code-agent doctor` | 설치·환경 점검 — `✓` 확인 · `✗` 막는 것(다음 줄에 고치는 법) · `·` 알림. `✗` 가 없으면 종료 코드 0 ([install.md §4](install.md#4-code-agent-doctor--점검)) | — |
| `code-agent update [--cli <경로>]` | 로컬 Git 소스 갱신·필요 의존성 설치·빌드 후 새 CLI로 스킬·에이전트·hook 적용. `--templates-only`는 현재 번들만 적용. 다른 hook · 블록 밖 · 모델 오버라이드는 그대로 ([install.md §5](install.md#5-code-agent-update--갱신)) | — |
| `code-agent status` | 문서·작업·스테이지·질문·승인 상태와 다음 할 일 | — |
| `code-agent docs` | 공통 문서의 섹션별 상태와 확정 여부 (KNOWLEDGE 는 있음/없음만) | — |
| `code-agent confirm doc <architecture\|conventions\|test-strategy\|quality>` | POLICY 문서 확정 — 해시를 원장에 남긴다. **넷 다** 해야 작업이 시작된다 | **O** |
| `code-agent confirm request <ID> [<지시서>]` | 요구사항 확정 — 지시서(원문 + 정리)를 통째로 보여 주고 확정한다. **확정된 요구사항만** `start` 가 받고 그 뒤 모든 단계가 지금 내용의 확정을 다시 본다. 지시서를 생략하면 진행 중인 작업의 지시서, 없으면 `doc/work/<ID>/requirement.md` | **O** |
| `code-agent reject request <ID> [<지시서>] --comment "<사유>"` | 요구사항 반려 (사유 필수) — `/ca-request` 가 사유를 읽고 다시 정리한다 | **O** |
| `code-agent approve` | 제출된 계획 승인 | **O** |
| `code-agent reject --comment "<사유>"` | 제출된 계획 반려 (사유 필수) | **O** |
| `code-agent deliver` | 반영 — 추적표·검증 증거·변경 파일을 보여 주고 확인을 받은 뒤 작업 브랜치에 **로컬 커밋**. push·MR/PR 생성은 하지 않는다 | **O** |
| `code-agent abort` | 진행 커서(`.code-agent/active.json`)만 지운다. 진행 중인 작업이 없으면 **접수 세션**(`request-session.json`)을 닫는다 | — |
| `code-agent model [<역할\|all> <모델\|default>] [--host claude\|codex] [--reasoning 강도]` | 호스트별 역할 모델 조회·변경·복원. Claude와 Codex의 변경값을 각각 `.code-agent/models.json`·`.code-agent/codex-models.json`에 저장하며 설치·갱신 때 다시 적용한다 | 변경은 같은 세션의 model 동의 또는 직접 TTY |
| `code-agent usage [--work <ID>] [--since <날짜>]` | 이 저장소의 Claude Code 기록에서 스테이지·에이전트별 토큰과 비용 **추정**을 집계 (아래) | — |
| `code-agent knowledge` | 공통 KNOWLEDGE 문서 3종의 항목과 그것을 마지막으로 넣은 작업 ID (아래) | — |
| `code-agent knowledge prune` | 근거 경로가 트리에서 사라진 항목을 보여 주고 **사람이 고른 것만** 지운다. 자동 삭제는 없다 | **O** |
| `code-agent plugin list` | 자리 · 기본 구현 · 감지된 무료 도구 · 등록된 플러그인 · 저장소 선언 ([10. 플러그인](#10-플러그인-선택)) | — |
| `code-agent plugin add <이름> --command "<argv>" [--slots a,b] [--sends-code]` · `plugin remove <이름>` | 이 PC 에 플러그인 등록 · 해제. 키와 동의는 `~/.code-agent/credentials.json` 에만 들어간다 | **O** |
| `code-agent plugin example [--out <경로>]` | 번들에 든 예시 어댑터를 파일로 꺼낸다 (기본 `./echo-adapter.js`, 있는 파일은 덮지 않는다) | — |

`abort` 는 작업 폴더·제출된 계획·원장을 남긴다. 같은 지시서로 다시 `start` 할 수 있다.
접수 중에 치면 접수 세션만 닫는다 — `request.json` 과 지시서, 확정 원장은 그대로라 같은 ID 로 다시 접수할 수 있다.

`deliver` 는 화면을 그리기 **전에** 게이트를 한 번 더 돌린다 — 증거가 지금 트리와 맞는지, 승인이 아직 `approved` 인지,
⑨ 에 열린 `계획 안` 지적이 없고 마지막 회차의 트리 해시가 지금과 같은지. 하나라도 어긋나면 **커밋하지 않고** 무엇이 어긋났는지 찍는다.
KNOWLEDGE 갱신은 `doc/work/<ID>/knowledge.proposal.md` 의 항목을 화면에서 고른 것만 반영한다 (삭제는 없다).

`status` 가 보여 주는 것 — 프로젝트 문서 ✓/✗, 작업 id·제목·종류·대상, 지시서 경로, **요구사항 확정 상태**, 작업 폴더, 브랜치와 기준,
스테이지(전체 흐름에서 지금 자리를 `[ ]` 로), `implement` 면 단계 목록, 답 없는 질문, 계획·승인 상태, `다음:` 한 줄.
작업이 아직 없는데 접수 중이면 그 자리(`접수: <ID> (<종류>)` · 초안 · 요구사항 상태)가 대신 뜬다.

| `요구사항:` 줄 | 뜻 | 할 일 |
|---|---|---|
| `확정 대기` | 렌더됐는데 아직 판정이 없다 | 같은 세션에서 요구사항 확정 |
| `확정됨 (<해시 끝 12자> · <날짜>)` | 지금 내용 그대로 확정됐다 | `/ca-next` · `/ca-analyze` |
| `반려됨 — <사유>` | 사람이 반려했다 | `/ca-request` — 사유대로 고쳐 다시 제출 |
| `다시 제출됨 — 확정 대기` | 반려 뒤 다시 냈다 | 같은 세션에서 다시 확정 |
| `확정 뒤 바뀜 — 다시 확정 필요` | 확정한 뒤 지시서가 바뀌었다 (다시 제출했거나 손으로 고쳤다) | 같은 세션에서 다시 확정. 계획 승인도 함께 무효가 된다 |
| `확정에 사람이 관측되지 않음 — 같은 세션에서 다시 확정 필요` | `code-agent.json` 의 `workOrder.requireVerifiedApproval` 이 `true` 인데 확정 기록에 사람 관측이 없다 | 같은 세션에서 다시 확정 |
| `아직 렌더되지 않음` | 지시서 파일이 없다 | `/ca-request` 로 접수 |

`requireVerifiedApproval` 은 **계획 승인만이 아니라 요구사항 확정에도 걸린다** — 관측되지 않은 확정은 `start`·`next` 를 비롯한 모든 단계가 거부한다.

### `code-agent usage` — 토큰과 비용(추정)

무엇이 비쌌는지를 **스테이지별·에이전트별**로 본다. 숫자의 출처는 Claude Code 가 남기는 대화 기록이다 — code-agent 가 따로 재지 않는다.

| 무엇 | 어디서 |
|---|---|
| 토큰 | `~/.claude/projects/<인코딩한 저장소 경로>/*.jsonl` 의 `assistant` 줄에 실린 `usage` (메인) · 그 아래 `<세션>/subagents/agent-*.jsonl` (서브에이전트) |
| 인코딩 | 저장소 절대경로의 영숫자 아닌 글자를 전부 `-` 로 — `C:\IdeaProjects\code-agent` → `C--IdeaProjects-code-agent` |
| 스테이지 | `.code-agent/log/stages.jsonl` — 스테이지가 바뀔 때마다 `{at, id, target, phase, stage, by}` 한 줄이 붙는다. 메시지의 시각이 어느 구간에 드는지로 가른다 (커밋되지 않는다 — `.gitignore` 의 `.code-agent/log/`). **요구사항 접수는 `request`** 로 뜬다 — 커서가 생기기 전이라 `phase` 자리에 그 이름이 들어간다 |
| 에이전트 | 서브에이전트 기록 짝의 `.meta.json` 에 있는 `agentType`. 메인 세션은 `main`, 알 수 없으면 `(알 수 없음)` |

```
ORD-1 · C:\IdeaProjects\shop · 2026-09-28 ~ 2026-09-30
기록: ~/.claude/projects/C--IdeaProjects-shop (세션 4 · 서브에이전트 11)

스테이지별
  스테이지            입력      캐시읽기    캐시쓰기      출력     비용(추정)
  implement/domain     882   3,104,556     341,020    52,117       $5.40
  analysis           1,204   1,930,441     212,880    18,302       $2.31
  …
  합계                                                            $17.71

에이전트별
  에이전트        입력      캐시읽기    캐시쓰기      출력     비용(추정)
  ca-explorer     …                                            $8.90
  main            …                                            $3.02

비용은 추정치입니다 — 2026-06-24 기준 공개 단가표로 계산했고 실제 청구와 다를 수 있습니다.
```

두 표 다 **비용이 큰 순서**다 — 스테이지 흐름 순서가 아니다. 무엇이 비쌌는지를 먼저 보려고 그렇게 둔다.

`--work <ID>` 는 그 작업의 구간만, `--since <날짜>` 는 그 시각 이후만 센다. 두 깃발 다 값이 없으면 멈춘다 —
`--since` 만 치면 전 기간을 세면서 그럴듯한데 틀린 숫자가 나온다.

**단가표** ($/1M 토큰, 2026-06-24 기준). 캐시 읽기 배수가 모델마다 달라 배수가 아니라 값으로 박아 두었다 — 단가가 바뀌면 이 표를 고친다.

| 모델 | 입력 | 캐시 읽기 | 캐시 쓰기 5분 | 캐시 쓰기 1시간 | 출력 |
|---|---|---|---|---|---|
| `claude-opus-5` | 5.00 | 0.50 | 6.25 | 10.00 | 25.00 |
| `claude-opus-5-5` | 4.00 | 0.20 | 5.00 | 8.00 | 20.00 |
| `claude-sonnet-5` | 2.00 | 0.20 | 2.50 | 4.00 | 10.00 |
| `claude-haiku-4-5` | 1.00 | 0.10 | 1.25 | 2.00 | 5.00 |
| `claude-fable-5-1` | 10.00 | 0.25 | 12.50 | 20.00 | 50.00 |

읽을 때 알아 둘 것.

- **같은 요청이 기록에 여러 줄로 나온다** — 같은 `message.id` 의 줄들은 출력 토큰이 늘어나는 중간 상태라서 마지막 줄만 센다. 그냥 더하면 2~3배가 된다.
- **표에 없는 모델은 비용 0** 으로 세고 꼬리에 그 이름을 적는다. 토큰 수는 그대로 실린다.
- **기록이 없으면 종료 코드 0 으로 안내만** 한다 — 이 저장소를 이 경로에서 Claude Code 로 연 적이 없거나, 다른 PC 의 기록이다.
- **`stages.jsonl` 이 없으면** 구간을 가르지 못해 전부 `(작업 전)` 한 칸으로 묶이고 그 사실을 한 줄로 알린다 — 스테이지 기록이 들어오기 전에 시작한 작업이다. 반영·중단 뒤의 메시지는 `(작업 밖)` 이다.
- 비용은 **추정**이다. 공개 단가표로 곱한 값이고 실제 청구와 다를 수 있다.

### `code-agent knowledge` — 공통 KNOWLEDGE 점검

```
doc/knowledge/data-dictionary.md (항목 4)
  ORDER            ORD-1     src/main/java/.../Order.java:31
  ORDER_ITEM       ORD-1     src/main/java/.../OrderItem.java:12
  PAYMENT          (미상)     근거 경로 없음
```

작업 ID 는 문서에 적혀 있는 것이 아니라 **git 이력에서 복원한다** — 항목 제목 줄을 마지막으로 건드린 커밋의 제목(`[<ID>] …`)에서 뽑는다.
그래서 "그 키를 **마지막으로 쓴** 작업"이고, 사람이 손으로 넣었거나 아직 커밋되지 않았으면 `(미상)` 이다.

`code-agent knowledge prune`은 **근거가 사라진 항목**을 고른다. 기본은 같은 세션의 `knowledge-prune` 확인이며, 직접 CLI는 TTY에서 실행한다.

| 규칙 | 왜 |
|---|---|
| 항목 본문의 경로 참조가 **전부** 없을 때만 표시한다 | 하나만 없는 것은 리팩터링의 흔적이라 잡음이다 |
| 참조가 0개인 항목은 표시하지 않고 개수만 센다 | `business-rules` 는 사람의 답에서 오므로 경로가 없는 게 정상이다 |
| URL 은 참조가 아니다 | 트리에 없는 것이 당연하다 |
| 항목 한 덩어리는 다음 `#`~`###` 제목까지다 — `####` 이상의 소제목은 **항목 안**이다 | 소제목에서 자르면 그 아래의 살아 있는 경로가 보이지 않아 멀쩡한 항목을 지우자고 묻고, 지울 때는 소제목 덩어리가 문서에 고아로 남는다 |
| 항목마다 지금 본문과 없는 경로를 보여 주고 하나씩 묻는다 — **`y` 인 것만** 지운다 | 자동 삭제는 되돌릴 근거가 없다 ([design.md §2.2](design.md#22-공통-knowledge--비어서-시작하고-반영마다-자란다-p4--생성--p5-갱신)) |

지운 뒤 `git add`·`commit` 은 사람이 한다 — 명령은 파일만 고치고 커밋하지 않는다.

---

## 6. 스킬이 부르는 명령

사람이 칠 일은 거의 없다. 무엇이 왜 거부됐는지 읽을 때 필요하다.

| 명령 | 하는 일 |
|---|---|
| `code-agent docs begin` · `end` | 문서 작성 세션. 도는 동안 hook 이 문서 자리 밖 쓰기를 막는다 |
| `code-agent docs skeleton <종류>` | 빈 문서의 섹션 뼈대. 종류 — POLICY: `architecture` `conventions` `test-strategy` `quality` · KNOWLEDGE: `data-dictionary` `api-catalog` `business-rules`(`knowledge` 면 셋을 한 번에) · 작업 문서: `01-requirements` `02-analysis` `03-design` `04-functional` `07-test-spec` |
| `code-agent docs interview <종류> [--sections a,b]` | 대화로 채울 때 물을 것 |
| `code-agent docs link <종류> <경로...>` | 이미 있는 문서를 `code-agent.json`에 등록. 작업 중에는 거부한다. 접수 중에는 `docs begin`으로 준비 세션을 연 뒤 연결하고 `docs end` 후 접수를 이어간다 |
| `code-agent docs recommend` · `docs setup node\|python` | 신규 추천 설명 · 설정과 POLICY·단계 규칙 생성. setup은 문서 세션에서만 가능하고 기존 프로젝트 파일은 덮지 않는다 |
| `code-agent survey` | 뼈대 역공학용 저장소 개요 — 빌드 파일·언어·디렉토리·계층 후보·표본·**도구 후보**(테스트·정적 분석·보안 의존성, CI 설정)·이미 있는 문서 |
| `code-agent manifest check` | `code-agent.json` 이 참조 파일을 실제로 찾는지 (✗ 면 exit 1) |
| `code-agent plugin list` | 자리마다 지금 무엇이 채우는지 (읽기만 한다 — `plugin add`·`remove` 는 사람의 터미널 명령이다) |
| `code-agent request begin [ID] --kind <feature\|fix\|refactor> [--base <기준 브랜치>] [--target <대상>]` | 1 요구사항 접수를 연다. 도는 동안 hook 이 `doc/work/<ID>/` 밖 쓰기와 지시서 쓰기를 막는다. `--base`·`--target` 은 세션에 남아 확정 뒤 `start` 가 쓴다 |
| `code-agent request submit <request.json>` | 접수 초안 검사 → `doc/work/<ID>/requirement.md` 렌더 (확정은 사람이). 어긋나면 파일을 쓰지 않는다. 반려된 내용 그대로의 재제출도 거부한다 |
| `code-agent request` | 접수 중이거나 작업이 진행 중이면 접수 형식을 준다 — 초안 형식·규칙·대상 후보·지금 상태 (작업 중이면 그 작업의 요구사항을 고칠 때 쓴다). 둘 다 없으면 접수를 열라고 세우고, 문서 세션이 열려 있어도 거부한다 |
| `code-agent start <지시서> [--target <대상>] [--base <기준 브랜치>]` | 작업 시작 — **사람이 지금 내용으로 확정한 요구사항만** 받는다. 통과하면 접수 세션을 닫는다 |
| `code-agent next` | 게이트를 확인하고 다음 스테이지·단계로 |
| `code-agent back <스테이지>` | 커서를 **이전** 스테이지로 되감는다 (`analysis`\|`impact`\|`design`\|`plan`\|`implement`\|`check`\|`test`\|`review`\|`integrate`). 앞으로는 못 가고, `deliver` 에서는(사람의 자리) 되감지 않으며, 진행 중인 작업이 없으면 거부한다. 무엇이 무효가 되는지 함께 찍는다 — 증거·승인 원장·작업 문서는 지우지 않는다 |
| `code-agent context` | 지금 스테이지에 필요한 것 — 경로·형식·참조 코드·단계 규칙. 작업 전 접수 중에는 `code-agent request` 와 같은 접수 형식을 준다 (작업 중에는 스테이지 컨텍스트다) |
| `code-agent plan submit <초안.json>` | 계획 검사 후 제출 |
| `code-agent repro` | 재현 — **`fix` 에서만** 돈다 (번호가 없다 — `implement` 안에서 돈다). `kind: "test"` 단계 파일만 바뀐 트리에서 테스트 명령을 돌려 ⑦ 의 `## 재현` TC 가 **실패**하는 것을 확인하고 증거에 적는다. 통과해야 고칠 파일 쓰기가 열리고, 그 순간 테스트가 언다 |
| `code-agent check` | 정적 분석·컴파일 — build와 품질·보안 기준 명령 실행 후 ⑧ 기록 |
| `code-agent test` | 테스트 — 기존 명령을 실행하고 ⑦의 필수 TC별 실제 passed 확인. 이후 테스트 동결 |
| `code-agent review` | 독립 리뷰 회차를 열어 기준 트리 고정. hook이 리뷰어 시작·완료와 ⑨ 결과 기록 |
| `code-agent integrate` | 통합 검증 — 기준 커밋의 깨끗한 worktree에 변경을 얹고 prepare → build·test. prepare 실패 시 후속 실행 중단 |
| `code-agent review-event` | ca-reviewer SubagentStart/Stop hook 전용. 리뷰어 실행·결과 기록 |
| `code-agent hook` | PreToolUse 판정 (stdin JSON). 사람이 부르지 않는다 |
| `code-agent stop` | Stop 판정 (stdin JSON) — `implement`~`integrate` 에서 계획 밖 변경·답 없는 질문이 있으면 턴을 **한 번 막는다**(`decision: block`). 이어 붙은 다음 턴은 그대로 놓아 주고, 판정 자체가 실패하면 막지 않는다. 사람이 부르지 않는다 |

`code-agent hook` · `code-agent stop` · `code-agent review-event`는 hook 전용이며 모델 Bash에 허용되지 않는다. 모델은 허용된 절차·상태 명령을 사용하고 사람 전용 승인 명령을 대신 실행하지 않는다.
`init` · `abort` · `approve` · `reject` · `confirm doc` · `confirm request` · `reject request` · `deliver` · `model` · `plugin add` · `plugin remove` 도 hook 이 거부한다 (사람의 터미널 명령이다).
열려 있는 것은 `request begin` · `request submit` 까지다 — **확정은 열리지 않는다.**
이 **명령 허용 목록**은 작업 · 문서 세션 · 접수 세션이 도는 동안에만 선다. 셋 다 없을 때도 hook 이 손을 놓는 것은 아니다 — 아래 네 자리는 **언제나** 막힌다.

| 언제나 막히는 것 | 무엇 |
|---|---|
| `.code-agent/` 쓰기 | 도구(Write·Edit·MultiEdit·NotebookEdit)로는 대소문자를 가리지 않고 쓸 수 없다 — 상태·승인·확정 원장은 code-agent 명령만 바꾼다 |
| `doc/work/<ID>/requirement.md` 쓰기 | 지시서는 `request submit` 이 렌더하거나 사람이 편집기로 쓴다 (문서 세션에서도 같다) |
| `~/.code-agent/` | `Read`·`Grep`·`Glob`·쓰기 전부. 등록된 플러그인 키가 사는 자리다 |
| 그 자리를 가리키는 Bash | `~/.code-agent` 나 `.code-agent` **경로**를 적은 명령은 거부한다. CLI 이름 `code-agent` 는 앞에 점이 없어 걸리지 않는다 |

그 밖의 것은 세션이 없으면 여전히 판정하지 않는다 — code-agent 로 하는 작업이 아닐 때까지 막을 이유는 없다.
이 넷을 언제나 닫아 두는 이유는 **세션이 열리기 직전의 틈** 때문이다. 그 틈이 열려 있으면 모델이 지시서와 확정 원장을 손으로 써 넣고 사람의 확정 없이 `start` 를 지날 수 있다.

그리고 **모든 모드에서**, 경로에 `:` 가 든 쓰기는 거부한다 — Windows 의 대체 데이터 스트림 표기(`requirement.md::$DATA`)는 같은 파일을 다른 이름으로 가리켜 이름 대조를 비껴간다.

다만 **hook 은 사고 방지 장치이지 보안 경계가 아니다.** Bash 는 그 자리를 *가리키는 것*만 막으므로, 글자를 쪼개 돌려 쓰는 셸 명령까지는 막지 못한다.
확정된 사용자 선택과 해시 원장이 진행 조건을 정하고, hook은 모델이 실수로 그 조건을 건너뛰지 않도록 검사한다. 직접 CLI에서는 TTY 확인을 지원한다.

---

## 7. 만들어지는 파일

자리는 둘로 나뉜다. `doc/work/<ID>/` 는 **모델과 사람이** 쓰고, `.code-agent/` 는 **코드만** 쓴다 (hook 이 모든 도구 쓰기를 막는다).

| 경로 | 무엇 | 누가 쓴다 | 커밋 |
|---|---|---|---|
| `doc/architecture.md` · 컨벤션 · `doc/test-strategy.md` · `doc/quality.md` | 공통 POLICY 4종 — 확정해야 작업이 시작된다 | 모델 초안 + **사람 확정** | O |
| `doc/knowledge/data-dictionary.md` · `api-catalog.md` · `business-rules.md` | 공통 KNOWLEDGE 3종 — 도입에 빈 뼈대, 반영마다 자란다 | `docs begin` 이 없는 것을 빈 뼈대로 만들고 `deliver` 가 갱신 (사람이 고른 항목만) | O |
| `doc/work/<ID>/request.json` | 접수 초안 — 원문(`original`\|`originalFile`) · 머리말 값 · 요구 내용 · 접수 때 정한 것 | 모델 (접수에서) | O |
| `doc/work/<ID>/requirement.md` | 작업 지시서 — 작업의 입력. **사람이 확정해야** 작업이 시작된다 | **`request submit` 만** (hook 이 모델 쓰기 거부) · 사람이 손으로 써도 된다 | O |
| `doc/work/<ID>/questions.md` | 질문과 답 | `start` 가 만들고 모델이 덧붙인다 | O |
| `doc/work/<ID>/01-requirements.md` ① | 요구 항목 `## R<n>` · 가정 · 범위 밖 | 모델 (`ca-analyst` 결과) | O |
| `doc/work/<ID>/02-analysis.md` ② | 기존 시스템 분석 · 영향 범위 · Risk | 모델 (`ca-explorer` → `ca-writer`) | O |
| `doc/work/<ID>/03-design.md` ③ | 구성 요소 · 처리 흐름 · API · 데이터 · 설계 결정 | 모델 결과 + 관찰 hook | O |
| `doc/work/<ID>/04-functional.md` ④ | 기능 · 업무 규칙 · 예외 · 수락 기준(AC) | 모델 결과 + 관찰 hook | O |
| `doc/work/<ID>/plan.json` ⑤ | 계획 초안 | 모델 | O |
| `doc/work/<ID>/05-plan.md` ⑤ | 사람이 읽는 계획 — `plan.json` 의 뷰 | **`plan submit` 만** (hook 이 모델 쓰기 거부) | O |
| `doc/work/<ID>/07-test-spec.md` ⑦ | AC 마다 테스트 케이스 — **구현 전에** 쓴다 | 모델 | O |
| `doc/work/<ID>/08-validation.md` ⑧ | 검증 보고서 — 기준·실행 결과·TC·수정 루프·실패 로그 | **`repro`·`check`·`test`·`integrate` 만** (hook 이 모델 쓰기 거부, 재렌더 바이트 대조) | O |
| `doc/work/<ID>/09-review.md` ⑨ | 리뷰 회차 · 지적 표(`id · 계획 파일 · 범위 · 상태 · 지적`) | 독립 리뷰어가 판정하고 hook이 실행 기록과 함께 결과를 기록 | O |
| `doc/work/<ID>/10-pr.md` ⑩ | MR/PR 본문 — 요약 · 추적표 · 검증 · 확인 방법 · 위험 | `code-agent:trace` 블록은 **`deliver` 만**, 나머지는 모델 | O |
| `doc/work/<ID>/knowledge.proposal.md` | KNOWLEDGE 갱신 제안 — `deliver` 가 항목별로 물어 고른 것만 반영 | 모델이 적고 사람이 고른다 | O |
| `.code-agent/work/<ID>/<대상>.plan.json` | 제출된 계획 | `plan submit` 만 | O |
| `.code-agent/work/<ID>/<대상>.verify.json` | 검증 증거 — 기준 커밋 · 부분 트리 해시 · `manifestHash` · `planHash` · 회차 · 실행 목록 · (`fix` 면) 재현 증거 `repro`(재현 TC · 그때의 테스트 파일 트리 해시) | `repro` · `check` · `test` · `integrate` 만 | O (증거) |
| `.code-agent/approvals/docs.jsonl` | 문서 확정 원장 (해시 사슬) | `confirm doc` 만 | O |
| `.code-agent/approvals/<ID>/request.jsonl` | 요구사항 확정·반려 원장 (해시 사슬 — 확정한 지시서의 경로·해시·사유) | `confirm request` · `reject request` 만 | O |
| `.code-agent/approvals/<ID>.jsonl` | 계획 승인·반려 원장 (해시 사슬) | `approve` · `reject` 만 | O |
| `.code-agent/approvals/<ID>/<대상>-<n>.plan.json` | 판정한 그 계획의 사본 — 재승인 때 바뀐 곳을 이것과 대조해 보여 준다 | `approve` · `reject` 만 | O |
| `.code-agent/version` | 설치된 code-agent 버전 | `init` | O |
| `.code-agent/active.json` | 진행 커서 (id·지시서·대상·스테이지·단계·브랜치) | `start` · `next` · `back` · `check`(수정 루프의 되감기) 가 쓰고, `abort` · `deliver` 가 지운다 | X |
| `.code-agent/docs-session.json` | 문서 작성 세션 표시 | `docs begin` · `end` | X |
| `.code-agent/request-session.json` | 요구사항 접수 세션 표시 (id·종류·연 시각 · 접수 때 준 `base`·`target`) | `request begin` 이 쓰고 `start` · `abort` 가 지운다 | X |
| `.code-agent/log/` | 검증 명령의 전체 로그 (`<스테이지>-<회차>-<종류>.log` — 재현은 `repro-0-<종류>.log`) — ⑧ 에는 꼬리만 남는다 | `repro` · `check` · `test` · `integrate` | X |
| `.code-agent/log/plugins/<자리>.jsonl` | 플러그인 호출 기록 — 요청 요약·소요·결과. 마지막 200줄만, **키 값은 들어가지 않는다** | 플러그인을 부르는 명령 | X |

`<ID>`는 지시서 머리말의 `id`다. 티켓 ID를 주면 그대로 쓰고 생략하면 CLI가 미사용 WORK 번호를 발급한다. 모델이 임의 번호를 만들지 않으며 지시서 ID와 작업 폴더 이름은 같아야 한다.

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

## 재현
- TC-2
```

AC 는 **R 마다 최소 하나**, TC 는 **AC 마다 최소 하나**다. 하나라도 비면 계획이 제출되지 않는다.

`## 재현` 절은 **`fix` 에서만 필수**다 — 결함을 재현하는 TC id 를 `- TC-<n>` 으로 한 줄씩 적는다.
**수준(Unit/Integration/E2E)은 무엇이든 된다.** 적은 id 는 표에 실재해야 하고, `code-agent repro` 가 그 TC 의 실패를 보기 전에는 고칠 파일을 쓸 수 없다.
표의 열 순서·개수는 종류와 무관하게 고정이다 — 재현 표시는 열이 아니라 이 절이 든다.
⑦ 은 승인 묶음에 들어가므로 **승인 뒤에 고치면 `stale-docs` 로 코드 쓰기가 멈춘다** — 테스트가 통과하지 않는다고 기대치를 낮추는 길이 닫힌다.

### `questions.md` — 한 질문에 한 결정

```markdown
## Q3 · 요구사항 분석
주문 취소 후 재주문이 가능한가?
A. 가능 — 새 주문번호
B. 불가
[Answer]: 가능
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
  "sequence": [{ "step": "파일이 있는 단계 key", "why": "그 차례인 이유 (02 의 Risk 가 큰 것부터)" }],
  "approach": "구현 방법 한 문단 — 03 의 설계를 어떤 방식으로 옮기는가",
  "conventions": [{ "rule": "적용할 규칙", "source": "근거 위치" }],
  "conflicts": [{ "topic": "", "docSays": "", "codeSays": "", "decision": "" }],
  "openQuestions": [],
  "reasoning": "판단 근거"
}
```

`fix` · `refactor` 는 `domain*` 대신 `preserve: [{ "item": "지시서 문장 그대로", "how": "어떻게 지켜지는지" }]` 가 들어간다.

- **`fix`** — `sequence[0]` 의 `step` 이 `kind: "test"` 단계 key 여야 하고, `files[]` 에 그 단계의 파일(재현 테스트)이 있어야 한다.
  그 단계에 적는 파일은 **그 단계가 밝힌 테스트 자리 안**이어야 한다 — '재현 먼저' 는 단계 이름표로 재므로, 고칠 파일을 테스트 단계에
  적어 넣으면 재현 없이 열린다.
- **`refactor`** — `files[]` 에 **기준 커밋에 이미 있던 `kind: "test"` 단계 파일**을 넣을 수 없다.

제출이 통과하려면 — `openQuestions` 가 비어 있고, 파일마다 `requirements` 가 있고, 모든 요구 항목이 어느 파일엔가 닿고,
경로가 단계의 위치·지시서 `scope`·계층 경계 안이고, **`07-test-spec.md` 의 모든 TC 가 `04` 에 실재하는 AC 를 가리키며 모든 AC 가 덮여야** 한다.
통과하면 코드가 `05-plan.md` 를 렌더한다 — 사람이 승인 화면에서 읽는 것이 그것이다. 그 파일은 손으로 고치지 않는다.

`sequence` · `approach`는 필수다. `sequence.step`에는 계획 파일이 있는 단계 key를 정확히 한 번씩 적는다. 모르는 단계·중복·누락·빈 이유는 거부한다. 실제 실행도 이 순서 그대로이며 매니페스트 순서로 다시 정렬하지 않는다. fix는 모든 테스트 단계가 수정 단계보다 먼저다.

Task(T1, T2…)는 이 순서와 파일 목록에서 자동 생성한다. 별도 Task 파일을 중복 관리하지 않는다. 모든 요구 R은 Task 파일에 연결돼야 하고, 승인 화면·진행 상태·완료 보고에서 같은 연결을 보여 준다. 구현 완료와 검증 완료는 구분한다.

---

## 8. 질문과 가정

모든 모호함을 질문으로 막으면 한 줄짜리 요구에도 사람 왕복이 세 번 쌓인다. 그래서 둘로 나눈다.

| | 질문 | 가정 |
|---|---|---|
| 무엇 | 업무 규칙 · 범위 · 권한 · 데이터의 의미 · 외부·다른 도메인과의 계약 | 이름 · 정렬 · 숫자 정밀도 · 테스트 케이스 목록 · 메시지 문구 · 범위 밖으로 둘 부수 작업 |
| 기준 | 모델이 정하면 **지어낸 것**이 된다 | 컨벤션·참조 코드·일반 관행으로 **기본값을 댈 수 있다** |
| 어디에 | `doc/work/<ID>/questions.md` | `01-requirements.md` 의 `## 가정` — 근거를 반드시 단다 |
| 진행 | **막는다** — 답이 없으면 다음 스테이지로 못 간다 | 막지 않는다 |
| 사람은 언제 보나 | 그때 바로 선택 도구로 (중단한 질문은 `/ca-answer`) | 승인 화면에 그대로 뜬다 — 계획과 함께 받아들이거나 반려한다 |

**질문 하나에 결정 하나.** 두 결정을 한 질문에 묶으면 한쪽만 답이 오고 되묻게 된다 (실측에서 나온 왕복이다).

선택 도구의 직접 입력으로도 답할 수 있다. 사용자가 먼저 대화에 적어 준 명확한 업무 답은 재질문 없이 반영한다. 문서·요구사항 확정, 계획 승인, 결과 반영은 같은 세션의 별도 동의 질문으로 확인한다. 업무 답변만으로 승인하지 않는다.

---

## 9. 승인과 반영 — 같은 Claude Code 세션에서

문서 확정·기준 커밋·요구사항 확정·계획 승인·최종 반영은 모두 현재 대화의 선택형 질문으로 처리한다. 메인이 검토할 내용과 파일을 보여 주고, 사용자는 `확인하고 진행`, `수정 요청`, `보류` 중 선택한다. 확인 후에는 호출한 단계로 돌아가 자동으로 진행한다. `/ca-next`는 중단 후 재개에 사용한다.

### 확인할 내용

| 확인 | 검토 대상 | 확인 후 동작 |
|---|---|---|
| 최초 준비 (`setup`) | POLICY 4종, 최초 기준 커밋이 필요한 경우 저장할 준비 파일 | 문서 확정과 필요한 최초 커밋 후 접수 계속 |
| 요구사항 (`request`) | 원문과 정리본, 범위·완료 조건·제약 | 확정한 지시서로 분석 시작 |
| 계획 (`plan`) | 요구사항별 Task·파일·순서·테스트·가정 | 승인된 순서로 구현 |
| 반영 (`deliver`) | 추적표·테스트·리뷰·통합 결과, 남은 위험, 커밋 대상 | 선택한 지식 문서와 작업 결과를 로컬 커밋 |

요구사항·계획 반려 사유는 먼저 질문으로 확인하고, 반려 기록을 남길 내용도 별도 동의 후 적용한다. 지식 문서 변경은 항목별 적용·유지를 먼저 선택한 뒤 최종 반영을 확인한다. 항목 선택만으로 파일을 바꾸지 않는다.

### 내부 처리

1. 메인은 실행할 action JSON을 허용된 작업 문서 경로에 작성한다.
2. `code-agent consent prepare <action.json>`이 표시할 요약과 질문을 생성한다.
3. 메인은 요약·파일 링크를 보여 주고 반환된 **toolInput 전체**를 그대로 `AskUserQuestion`에 전달한다. `questions`와 `metadata.source`를 유지하며 답을 미리 채우지 않는다.
4. 질문의 PreToolUse·PostToolUse hook이 같은 세션·호출·작업 경로의 실제 응답을 관찰한다.
5. `code-agent consent status <ID>`에 남은 질문이 있으면 다시 표시한다. `approved`일 때만 `code-agent consent apply <ID>`를 실행한다.
6. 적용 후 상태를 읽고 다음 절차를 계속한다. 업데이트는 새 hook을 읽도록 Claude Code를 재시작한 뒤 재개한다.

취소·보류·응답 누락·시간 초과·추가 질문·다른 세션은 승인으로 처리하지 않는다. 확인 이후 파일·설정·Git 상태가 바뀌면 새로 준비하여 확인한다. 같은 요청을 중복 적용해도 커밋을 반복하지 않는다. 이 기록은 신뢰하는 로컬 hook의 관찰이며 사용자 신원 증명이나 OS 보안 경계는 아니다.

계획 승인은 지시서·계획·매니페스트·POLICY와 지정된 분석·설계·테스트 문서의 해시에 묶인다. 해당 내용이 바뀌면 기존 승인을 재사용할 수 없다. 요구사항 자체가 바뀌면 요구사항과 계획을 모두 다시 확인한다.

### 최종 반영 범위

반영 직전에 기존 검증 게이트를 다시 검사한다. 필수 증거가 현재 트리와 맞고 승인과 최신 독립 리뷰가 유효해야 한다. 작업 파일·작업 문서·증거·해당 작업 승인 원장·선택한 KNOWLEDGE, 존재하는 `.code-agent/version`·`.code-agent/models.json`·`.code-agent/codex-models.json`·`.code-agent/approvals/docs.jsonl`을 명시적으로 커밋한다. 다른 작업의 스테이징된 파일은 포함하지 않는다.

확인하면 작업 브랜치에 로컬 커밋하고 작업 커서를 지운다. push·PR/MR 생성·배포는 하지 않는다. 검증 결과와 남은 위험은 `10-pr.md`에 남긴다.

### 직접 CLI를 원하는 경우

`code-agent confirm doc all`, `code-agent setup baseline`, `code-agent confirm request <ID> [<지시서>]`, `code-agent approve`, `code-agent deliver`를 일반 TTY에서 직접 실행할 수도 있다. 이 보조 경로는 표시된 단어를 직접 입력하는 확인을 유지한다. 같은 세션 사용에 별도 터미널을 필수로 요구하지 않는다.

---

## 10. 플러그인 (선택)

**등록하지 않아도 전 과정이 돈다.** 자리마다 기본 구현이 있고, 플러그인은 그 자리를 대신 채울 뿐이다.
플러그인은 **명령 어댑터**다 — stdin 으로 JSON 한 벌을 받아 stdout 으로 JSON 한 벌을 내는 실행 파일 하나.
계약·형식·보안은 [plugins.md](plugins.md) 가 정본이고, 여기는 **무엇을 치는가**다.

| 명령 | 하는 일 | TTY 필요 |
|---|---|---|
| `code-agent plugin list` | 자리 · 기본 구현 · 감지된 무료 도구 · 이 PC 의 등록 · 저장소 선언 · **지금 무엇이 채우는가** | — (모델도 부를 수 있다) |
| `code-agent plugin add <이름> --command "<argv>" [--slots a,b] [--sends-code]` | 이 PC 에 등록 — `describe` → 동의 → 키 → `probe` 순서로 묻는다 | **O** |
| `code-agent plugin remove <이름>` | 등록 해제 — 키·동의·probe 기록을 함께 지운다 | **O** |
| `code-agent plugin example [--out <경로>]` | 예시 어댑터를 파일로 꺼낸다 — 단일 실행 파일 안에도 들어 있다 | — |

`add` · `remove` 는 `approve` · `deliver` 와 같은 문이다 — **직접 호출은 막고 같은 세션의 consent로 적용한다**.
등록은 사람이 동의를 주는 자리라서다. `list` 는 상태만 읽으므로 스킬도 부른다.

### 지금 무엇이 채우고 있나

```
> code-agent plugin list

| 자리 | 기본 구현 | 지금 채우는 것 |
|---|---|---|
| survey.classify  | 경로 규칙 + surveyor (code-agent survey)  | 기본 구현 |
| candidates.rank  | 내장 키워드 스캔 (code-agent context)     | 플러그인 jev |
| review.prefilter | reviewer 가 전부 봄 (code-agent review)   | 기본 구현 |
| context.docs     | 제목 매칭 (code-agent context)            | 기본 구현 |
| code.index       | 없음 — 예약 (이 버전은 부르지 않는다)      | 예약 — 부르는 지점이 없습니다 |
| verify.extra     | 매니페스트 commands (code-agent check)    | 기본 구현 |
```

`ripgrep` 이 깔려 있어도 `candidates.rank` 는 쓰지 않는다 — rg 의 ignore 규칙·단어 경계가 달라
**같은 저장소에서 사람마다 다른 순위**가 나오기 때문이다. `plugin list` 의 `감지된 무료 도구:` 줄이
`ripgrep: 있음 (<경로>) — candidates.rank 는 쓰지 않습니다(사람마다 순위가 갈리지 않게 내장 스캔으로 고정)` 로 그렇게 보고한다.

### 등록

기본은 같은 세션의 `plugin-add` 확인이다. 아래 예시는 직접 TTY 경로이며, 세션에서는 키를 입력받지 않고 `secretEnv`로 기존 환경변수 이름만 지정한다. 자세한 절차는 [플러그인 문서](plugins.md)를 따른다.

```
> code-agent plugin add example --command "node C:/tools/code-agent/template/plugin-example/echo-adapter.js"
```

어댑터에게 `describe` 를 한 번 물어 **무엇을 채우는지 · 코드를 밖으로 보내는지 · 키가 필요한지**를 받는다.
사람에게는 그 답이 그대로 보인다.

- 코드를 밖으로 보내는 플러그인이면 경고가 뜨고 **플러그인 이름을 그대로 입력**해야 통과한다
  (`approve` · `deliver` 와 같은 확인이다).
- 자리마다 **무엇이 어댑터로 나가는지**를 등록 화면이 적는다. `sendsCode: false` 라고 답한 어댑터에도
  그 자리의 입력(경로 목록 · 요구 항목 문장 · 컨벤션 규칙)은 간다 — 그 답은 게이트 대상이 스스로 한 것이다.
- 누가·언제·어느 자리를 열었는지는 **언제나** 기록된다 (`sendsCode` 여부와 무관하다).
- 키가 필요하다고 하면 그때 묻는다. **키 입력은 화면에 보인다** — 프롬프트가 그 사실을 말한다.
- 마지막으로 `probe` 를 한 번 보낸다. **실패하면 키도 저장하지 않고 등록하지 않는다.**

키와 등록은 `~/.code-agent/credentials.json` (이 PC · 이 사용자)에만 들어간다 — 프로젝트의 확인 기록에는 변수 이름과 설명만 남기며 실제 키는 넣지 않는다.
`plugin list` 는 `키 등록됨` 만 찍고 값을 되출력하지 않는다.
작업 중에는 **모델이 그 파일을 읽지 못한다** — `Read`·`Grep`·`Glob` 도, Bash 로 그 경로를 가리키는 명령도 hook 이 막는다.
읽기 셋이 hook 까지 오는 것은 PreToolUse matcher 에 `Read`·`Grep`·`Glob` 이 들어 있기 때문이다 — 그 전에 깔린 저장소는
`code-agent update` 로 matcher 를 갱신해야 이 문이 선다 (`code-agent doctor` 가 `matcher 가 Read · Grep · Glob 를 넘기지 않습니다` 로 ✗ 를 낸다).

### 저장소가 쓸지 말지는 `code-agent.json` 이 정한다

등록만으로는 아무 일도 일어나지 않는다. 저장소가 그 자리를 선언해야 돈다.

```jsonc
// code-agent.json — 커밋해 팀과 공유한다. 키는 여기 없다
"plugins": { "jev": { "slots": ["candidates.rank", "review.prefilter"] } }
```

- **키가 없는 팀원은 기본 구현으로 돈다** — 알림 한 줄이 뜨고 작업은 그대로 진행된다.
- 개인이 등록해 뒀어도 저장소가 선언하지 않았으면 기본 구현이 돈다 (등록은 개인 것, 선언은 팀 것).
- 한 자리를 두 플러그인이 선언하면 `code-agent.json` 형식 오류다.
- `plugins` 는 매니페스트 해시에 들어가지 않는다 — **더해도 기존 계획 승인이 무효가 되지 않는다.**

### 어디에 나타나나

| 명령 | 무엇이 붙나 |
|---|---|
| `code-agent context` (`impact`·`design`) | `## 관련 후보 파일 (순위 …)` — 출처 줄이 `기본 구현` 인지 `플러그인 <이름>` 인지 찍는다 |
| `code-agent context` (`impact`·`design`·`plan`) | `## 참고 문서 섹션 (제목 매칭 …)` |
| `code-agent review` | `## 의심 항목` — **단서일 뿐 판정이 아니다.** ⑨ 에 적히는 지적은 `ca-reviewer` 가 낸 것뿐이다 |
| `code-agent check` | `verify.extra` 의 결과가 증거 런으로 **추가**된다 (`kind: "plugin:<이름>:…"`). 더하기만 하므로 실패한 빌드를 통과로 만들 수 없다 |
| `code-agent survey` | 계층·컴포넌트 분류 블록 (플러그인이 없으면 출력이 지금과 같다) |

실제 Jev 는 아직 붙지 않았다 — A/B 토큰 비교 절차는 [plugins.md §8](plugins.md#8-ab-토큰-비교-jev-가-붙으면).

---

## 11. 막히면

### 직접 CLI에서 TTY 오류가 난다

현재 Claude 세션에서는 직접 `confirm`·`approve`·`deliver`를 호출하지 않고 위의 consent 절차를 사용한다. `code-agent doctor`로 질문 hook 설치를 확인하고, 갱신했다면 Claude Code를 다시 연다. 질문 도구나 hook이 없으면 미승인 상태를 유지한다.

일반 터미널에서 직접 실행하려는 사용자는 실제 대화형 TTY가 필요하다. 파이프·CI·모델의 셸 입력을 사람 확인으로 간주하지 않는다.

### hook 이 거부했다

거부 사유는 모델에게 그대로 보인다. 우회하지 않는 것이 규칙이다.

| 거부 문구 | 뜻 | 할 일 |
|---|---|---|
| `지금은 analysis 스테이지라 작업 폴더(...) 밖은 쓸 수 없습니다` | 승인 전에 코드를 쓰려 했다 | 계획까지 진행하고 승인을 받는다 |
| `계획이 승인되지 않았습니다 (none)` | 제출·승인 전 쓰기 | 같은 세션에서 계획 승인 |
| `계획이 승인되지 않았습니다 (stale-docs)` | 승인 뒤 근거 문서가 바뀌었다 | 다시 승인 |
| `승인된 계획에 없는 파일입니다: <경로>` | 계획 밖 파일 | 사람에게 알린다. 계획을 고치면 재승인 |
| `[지시서 scope 밖]` · `[do-not-touch 경계]` | 지시서 `scope` 밖이거나 계층 경계를 넘었다 | 아래 참고 |
| `[보존 대상]` | `preserve` 로 지킨다고 한 것을 건드렸다 | 계획을 고치거나 질문으로 |
| `작업 지시서(...)는 고칠 수 없습니다` | 작업 중에 모델이 `requirement.md` 를 고치려 했다 | 모호하면 `questions.md` 에 질문으로. 요구사항 자체를 고치려면 `request.json` 을 고쳐 다시 제출하고 사람이 다시 확정한다 |
| `doc/work/<ID>/requirement.md 는 코드가 렌더합니다` | 접수 중에 모델이 지시서를 직접 쓰려 했다 | 고칠 것은 `request.json` 에 쓰고 `code-agent request submit` 으로 다시 낸다. 원문은 사람이 준 그대로 둔다 |
| `작업 지시서(...)는 code-agent request submit 이 렌더합니다` | **작업도 접수도 없는데** — 또는 문서 세션 중에 — 어느 `doc/work/*/requirement.md` 를 쓰려 했다 | 요구사항은 `/ca-request` 로 접수한다. 사람이 직접 쓰는 지시서는 사람이 편집기로 쓴다 |
| `요구사항 접수 중에는 작업 폴더(...) 밖은 쓸 수 없습니다` | 확정 전에 코드·문서를 "미리" 고치려 했다 | 접수에서 쓰는 것은 `doc/work/<ID>/` 뿐이다. 코드와 문서는 확정하고 분석이 시작된 뒤에 |
| `05-plan.md 는 코드가 렌더합니다` | 모델이 렌더된 계획 문서를 고치려 했다 | `plan.json` 을 고쳐 `plan submit` 으로 다시 제출한다 |
| `08-validation.md 는 코드가 렌더합니다` | 검증 보고서를 손으로 고치려 했다 | 결과를 바꾸려면 고쳐서 `code-agent check` 부터 다시 돈다 |
| `테스트가 이미 돌아 얼어 있는 파일입니다` | `code-agent test` 가 한 번 돈 뒤 — `fix` 는 `code-agent repro` 가 재현을 본 뒤 — 의 `kind: test` 단계 파일이다 | 고치지 말고 근거와 함께 보고한다. 풀리는 길은 ⑨ 의 그 파일을 가리키는 열린 계획 안 지적, 또는 계획 재승인이다 |
| `재현을 먼저 봐야 이 파일을 고칠 수 있습니다: <경로> (fix)` | `fix` 인데 재현 증거가 없다 | `kind: "test"` 단계의 계획 파일을 쓰고 `code-agent repro` 로 지금 코드에서 **실패**하는 것을 본다 |
| `재현을 본 뒤 테스트 파일이 바뀌었습니다` | 재현을 본 트리와 지금 테스트 파일이 다르다 (첫 `check` 전에만 본다) | `code-agent repro` 를 다시 돌린다 |
| `리팩토링은 기존 테스트를 고치지 않습니다` | 기준 커밋에 이미 있던 `kind: test` 단계 파일을 건드렸다 | 되돌린다. **동작이 보존되는지 보는 것이 그 테스트**다 — 고쳐야 할 이유가 보이면 `questions.md` 로 묻는다 |
| `고쳐 쓰기 2회를 넘겨…` | `fixRounds` 한도를 넘겼다 | 덮지 않고 보고하는 자리다. `questions.md` 에 적고 사람에게 알린다 |
| `작업 상태·제출된 계획·승인과 확정 기록은 도구로 고칠 수 없습니다` | `.code-agent/` 쓰기 (작업·세션이 없을 때도 막힌다) | `next` · `plan submit` · `confirm` 으로만 바뀐다 |
| `` `.code-agent/` 는 code-agent 명령으로만 바뀝니다 `` | Bash 가 `.code-agent` 경로를 가리켰다 (세션 밖에서도) | 상태는 `code-agent status` 로 본다. CLI 이름 `code-agent` 를 부르는 것은 막지 않는다 |
| `등록된 플러그인 키가 있는 자리는 읽을 수 없습니다` | `~/.code-agent/` 를 읽거나 쓰거나 Bash 로 가리켰다 | 무엇이 등록돼 있는지는 `code-agent plugin list` 가 값을 빼고 보여 준다. 키가 필요하면 사람에게 묻는다 |
| `경로에 ':' 가 든 파일은 쓸 수 없습니다` | Windows 의 대체 데이터 스트림 표기(`requirement.md::$DATA`)다 — 이름 대조를 비껴가는 길이라 모든 모드에서 막는다 | 보통의 경로로 쓴다 |
| `문서 작성 중에는 문서 자리(...) 밖은 쓸 수 없습니다` | 문서 세션 중 코드 쓰기 | 문서에 적고 사람에게 알린다. 세션은 `docs end` |
| `작업 중에는 Bash 로 code-agent 명령(…), 선언된 명령, 읽기용 git 만` | 허용 밖 명령 | 파일은 Write/Edit, 읽기는 Read/Grep/Glob. `init`·`abort`·`approve`·`reject`·`confirm`·`deliver`·`model`·`plugin add`·`plugin remove` 는 직접 호출 대신 같은 세션 consent를 사용한다 (`plugin list`는 열려 있다) |
| `연결·리다이렉트(; && \| >)는 안 됩니다` | 명령을 이어 붙였다 | 한 번에 하나씩 실행한다 |

**공통 모듈이 경계에 걸릴 때** — 새 오류 코드처럼 도메인 밖 공통 파일을 고쳐야 하는 계획은 경계 검사에서 거부된다.
`code-agent.json` 에 `"scope": "project"` 인 공통 단계를 두면 풀린다 (순서는 도메인 단계보다 앞).
지시서의 `scope` 를 넓혀야 하는 경우라면 그건 사람이 고친다.

### `code-agent next` 가 넘어가지 않는다

| 문구 | 뜻 |
|---|---|
| `요구사항이 확정되지 않았습니다 (<지시서>)` | 사람이 아직 확정하지 않았다. `start` 는 물론 `next` · `plan submit` · `approve` · `check` · `test` · `review` · `integrate` · `deliver` · `repro` 가 모두 이것을 본다 — 별도 같은 세션에서 요구사항 확정. **지시서가 기본 자리가 아니면 거부문이 경로까지 박은 명령을 그대로 찍어 준다** |
| `요구사항이 반려됐습니다 (<지시서>): <사유>` | 사람이 반려했다 — `/ca-request` 가 사유대로 고쳐 다시 낸다 |
| `요구사항이 확정 뒤 바뀌었습니다 (<지시서>). 다시 확정해야 진행합니다.` | 확정한 뒤 지시서가 바뀌었다 (다시 제출했거나 손으로 고쳤다) |
| `요구사항이 다시 제출돼 확정을 기다립니다 (<지시서>)` | 반려 뒤 다시 냈다 — 사람의 확정이 남았다 |
| `요구사항 확정에 사람이 관측되지 않았습니다 (<지시서> · <사유>)` | `workOrder.requireVerifiedApproval` 이 `true` 인데 확정 기록에 관측이 없다 — 같은 세션에서 다시 확정한다 (경로가 기본 자리가 아니면 거부문이 그 경로까지 박아 찍는다) |
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
| 최종 반영 대기 | 같은 세션에서 결과·문서 변경·커밋 경로를 확인하면 로컬 반영한다 |
| `굳혀 둔 기준 커밋이 없습니다` | 증거 코어 이전에 시작된 커서다. `code-agent abort` 뒤 다시 시작한다 (작업 폴더는 남는다) |
| `fix 는 기존 시스템 분석에 결함이 나는 경로를 적습니다` · `refactor 는 … 지금 동작을 적습니다` | ② 의 그 절이 `해당 없음` **뿐**이거나(다 쓴 분석에 섞인 한 줄은 막지 않는다) 근거 `path:line` 이 하나도 없다 |
| `재현을 아직 보지 못했습니다` | `fix` 의 테스트 단계를 끝냈는데 `code-agent repro` 를 돌리지 않았다 |
| `재현을 본 테스트 트리가 지금과 다릅니다` | `code-agent check`가 기준 코드와 수정된 테스트를 임시 worktree에 적용해 재현을 갱신한다. 작업 코드는 보존한다. 재현 실패 확인 후 수정 코드의 check·test·독립 리뷰를 다시 거친다. 기준 코드에서도 통과하는 테스트는 차단한다 |
| `리팩토링이 기존 테스트를 고쳤습니다: [M] <경로>` | 기준 커밋에 있던 테스트 파일이 바뀌었다(지워도 같다). 되돌린다 |
| `prepare: failed (…)` · `prepare: error` | 통합 검증의 준비 명령이 실패했다. build·test 는 돌지 않았다 — 매니페스트의 `prepare` 나 환경을 본다 (계획 파일 문제가 아니다) |
| `test: not-run (선언 없음)` | `code-agent.json` 에 `test` 명령이 없다. 아무것도 돌리지 않은 결과는 통과가 아니다 |

### `code-agent request begin` · `submit` 이 거부했다

| 문구 | 할 일 |
|---|---|
| ID 형식 오류 | 명시적 ID는 영문·숫자로 시작하고 `[A-Za-z0-9._-]` 64자 이하다. 티켓 번호가 없으면 생략해 자동 발급한다 |
| `작업 종류가 필요합니다: (없음) — feature \| fix \| refactor` | `--kind` 로 종류를 고른다 — `/ca-feature` · `/ca-fix` · `/ca-refactor` 가 넘기는 값이다 |
| `문서 작성 세션이 열려 있습니다 — code-agent docs end 로 닫은 뒤…` | 문서 세션과 접수는 같이 돌지 않는다. `code-agent docs end` |
| `진행 중인 작업이 있습니다: <ID> (<스테이지>)` · `접수 중인 요구사항이 있습니다: <ID>` | 한 번에 하나다. 끝내거나 사람이 `code-agent abort` 로 닫는다 |
| `접수 중인 요구사항이 없습니다 — code-agent request begin [ID] --kind <종류> 로…` | 접수를 먼저 연다 (`/ca-request`) |
| `접수 초안의 형식이 맞지 않습니다:` | `request.json` 의 형식 오류다. 자리마다 사유가 붙는다 — 형식은 `code-agent request` 가 보여 준다 |
| `원문은 original … 과 originalFile … 중 정확히 하나로 줍니다` | 둘 다 적었거나 둘 다 비었다 |
| `originalFile 이 저장소 안의 파일이 아닙니다` · `originalFile 이 비었습니다` | 저장소 밖 파일이면 사람에게 저장소 안에 두라고 묻는다 |
| `초안의 id(<x>) 가 접수 중인 작업(<y>) 과 다릅니다` · `초안의 kind(...) 가 접수한 종류(...) 와 다릅니다` | 세션의 ID(티켓 ID 또는 CLI 발급 번호)와 접수 때 판단·지정한 종류에 초안을 맞춘다 |
| `extra 에 예약 속성을 쓸 수 없습니다: <이름…>` | `kind`·`id`·`title`·`target`·`scope`·`preserve`·`approver` 는 같은 이름의 자리에 쓴다 |
| `extra 의 속성 이름은 영문으로 시작하는 [A-Za-z0-9_-] 입니다: <이름…>` | 머리말 파서가 읽지 못하는 이름이다. `code-agent.json` 의 `workOrder.attributes` 에 선언된 이름을 쓴다 |
| `접수 내용이 지시서 규격에 맞지 않아 렌더하지 않았습니다:` | 손으로 쓴 지시서와 **같은 검사**다 — `target`·`scope` 가 실재하는 경로인지, 프로젝트 확장 속성이 갖춰졌는지. 머리말을 읽다 난 오류도 전부 여기로 온다. 원문으로 정할 수 없으면 사람에게 묻는다 |
| `반려된 내용과 같습니다 — 다시 제출하지 않았습니다. 반려 사유: <사유>` | 반려된 그 내용을 그대로 다시 냈다. 사유가 가리키는 곳을 초안에서 고친다 — 사유만으로 정할 수 없으면 사람에게 묻는다 |
| `머리말로 옮기면 값이 달라집니다: <자리…>` | 따옴표나 `[ ]` 로 감싼 값·빈 항목이다. 한 줄 그대로 적는다 |
| `이 작업은 <지시서> 로 시작됐습니다 — 그 지시서는 사람이 직접 고치고 다시 확정합니다` | 접수를 거치지 않고 시작된 작업이다. 지시서는 사람이 고친다 |

### `code-agent plan submit` 이 거부했다

| 문구 | 할 일 |
|---|---|
| `어느 요구 항목을 위한 파일인지 requirements 에 적으세요` | 파일마다 담당 요구 항목 번호를 단다 |
| `어떤 파일에도 닿지 않는 요구 항목: R3` | 파일을 더하거나, 이번 범위가 아니면 질문으로 확인 |
| `남은 질문이 있습니다` | `openQuestions` 를 `questions.md` 로 옮겨 답을 받는다 |
| `preserve 가 계획에 없습니다: <문장>` | 지시서의 보존 조건을 **문장 그대로** 옮긴다 |
| `알 수 없는 단계 <key>` | `code-agent context` 가 보여 준 단계 key 를 쓴다 |
| `fix 는 ## 재현 절에 … TC id 를 최소 하나 적습니다` | ⑦ 에 `## 재현` 절을 두고 `- TC-1` 처럼 적는다 (수준은 무엇이든 된다) |
| `## 재현 이 표에 없는 TC 를 가리킵니다: TC-9` | `테스트 케이스` 표에 그 id 가 없다. 오타이거나 표에 줄을 더해야 한다 |
| `계획의 sequence[0] 이 테스트 단계가 아닙니다` | `fix` 는 재현 테스트가 먼저다. 받는 값(단계 key)이 메시지에 함께 나온다 |
| `fix 의 계획에 kind:"test" 단계의 파일이 없습니다` | 재현 테스트 파일을 `files[]` 에 넣는다 |
| `이 프로젝트에는 fix 로 도는 kind:"test" 단계가 없습니다` | `code-agent.json` 의 `stages` 에 `"kind": "test"` 단계를 두고 `kinds` 에 `"fix"` 를 넣는다 (확인: `code-agent manifest check`) |
| `계획이 kind:"test" 단계에 테스트 자리 밖의 파일을 넣었습니다: <경로>` | 고칠 파일을 테스트 단계에 적었다. 그 파일은 코드 단계로 옮긴다 — 재현은 테스트 자리로 잰다 |
| `kind:"test" 단계(<key>)가 자리를 밝히지 않아 재현 테스트를 가려낼 수 없습니다` | 그 단계에 `scope: "project"` 의 `outputDirs` 나 `base` 를 적는다 (확인: `code-agent manifest check`) |
| `리팩토링은 기존 테스트를 고치지 않습니다 — 계획에서 빼세요` | 기준 커밋에 이미 있던 테스트 파일이 `files[]` 에 있다 |

### `code-agent repro` 가 거부했다 (`fix` 전용)

| 문구 | 뜻 | 할 일 |
|---|---|---|
| `code-agent repro 는 fix 작업에서만 돕니다 (지금: feature)` | 종류가 `fix` 가 아니다 | 그냥 `/ca-implement` 를 잇는다 |
| `재현은 implement 스테이지에서 돕니다 (지금: <phase>)` | 자리가 아니다 | `code-agent status` 의 `다음:` 줄을 따른다 |
| `재현을 보기 전에 이미 바뀐 계획 파일이 있습니다: <경로…>` | 비-테스트 계획 파일이 기준 커밋과 다르다 | 되돌린 뒤 다시 돌린다 — 재현은 **테스트만 바뀐 트리**에서 봐야 증거가 된다 |
| `재현하지 못했습니다 — <kind>: passed` | 지금 코드에서 그 TC 가 통과한다 | **고치지 않는다.** ⑦ 의 `## 재현` 케이스가 결함을 실제로 찌르는지 다시 보고, 안 되면 사람에게 보고한다 |
| `재현 명령이 돌지 못했습니다 (<kind>: not-run\|error)` | 테스트 명령이 선언되지 않았거나 실행 파일이 없다 | `code-agent.json` 의 `test` 를 확인한다. `not-run`·`error` 는 아무것도 증명하지 않는다 |
| `재현 TC 가 실패한 실행의 출력에 없습니다: TC-1` | **실패한** 실행의 출력에 그 id 가 찍히지 않았다 (파일에 적혀 있는 것은 인정하지 않는다 — 무엇이 실패했는지 말해 주지 않는다) | 테스트 **이름**에 TC id 를 남겨 실패 보고에 찍히게 한다 (컨벤션의 `테스트 규칙`). 다른 TC 만 빨간 것이면 ⑦ 의 `## 재현` 케이스를 다시 본다 |
| `이미 재현을 봤습니다 (…)` | 거부가 아니다 — 멱등이다 | 고칠 파일을 쓴다 |

### 그 밖

| 상황 | 뜻 |
|---|---|
| `code-agent.json 이 없습니다` | `/ca-adopt` 로 먼저 도입 |
| `이 프로젝트에는 fix 로 돌 단계가 선언돼 있지 않습니다` | `code-agent.json` 의 `stages[].kinds` 에 그 종류를 더한다 (비우면 모든 종류). 메시지가 단계별 `kinds` 목록을 함께 찍는다 — 확인은 `code-agent manifest check` |
| `진행 중인 작업이 있습니다: <ID>` | 끝내거나 `code-agent abort` 뒤에 시작 |
| `작업이 진행 중입니다 ... 근거 문서는 작업 도중에 바꾸지 않습니다` | `/ca-docs` 를 작업 중에 열었다. 작업을 끝내거나 `abort` |
| `요구사항을 접수 중입니다 (<ID>). … code-agent docs begin 으로 준비 세션을 연 뒤에 합니다` | 원문·ID를 유지한 채 `docs begin`으로 준비 세션을 열어 문서를 보완하고 `docs end` 후 접수로 돌아간다. 접수 취소는 필요 없다 |
| `진행 중인 작업도 접수 중인 요구사항도 없습니다` | `code-agent abort` 가 닫을 것이 없다 |
| `지시서가 없습니다: <경로> — /ca-request 로 접수해 …` | `confirm request` 가 확정할 파일이 없다. 접수부터 — **다른 자리에 손으로 쓴 지시서면 경로를 함께 준다** (`code-agent confirm request <ID> <지시서>`, 거부문도 그렇게 안내한다) |
| `사슬이 끊겼습니다 — 누가 원장을 고쳤는지 확인하세요` | `.code-agent/approvals/*.jsonl` 이 손으로 바뀌었다. git 이력으로 확인한다 |
| `기준 브랜치가 없습니다: master` | `start --base <브랜치>` 또는 `code-agent.json` 의 `git.base` |
| `code-agent hook 이 판정에 실패해 막았습니다` | hook 자체가 터졌다. 막는 쪽으로 닫힌다 — 메시지를 보고 `code-agent status` 로 상태를 확인 |
| `승인된 계획 밖의 변경이 남아 있습니다 (도구를 거치지 않고 생긴 파일일 수 있습니다):` (턴 끝) | Stop hook 이 기준 커밋과 대조해 턴을 한 번 막은 것이다 (이어 붙은 다음 턴은 그대로 간다). 되돌리거나 사람에게 알린다 — 계획을 넓히려면 재승인 |
| `검증 증거가 지금 트리와 맞지 않습니다` | 통과 뒤에 코드·계획·매니페스트가 바뀌었다. `code-agent check` 부터 다시 돈다 |
| `플러그인 jev(candidates.rank) 가 실패해 기본 구현으로 돕니다: <이유>` | 어댑터가 제한 시간·응답 형식·종료 코드 중 하나에서 걸렸다. **명령은 정상 종료한다** — 그 자리의 결과가 기본 구현의 것일 뿐이다. 이유별 뜻은 [plugins.md §5](plugins.md#5-자리-해결-순서와-실패), 자세한 것은 `.code-agent/log/plugins/<자리>.jsonl` |
| `자리 candidates.rank 는 code-agent.json 이 jev 를 선언했지만 이 PC 에 등록돼 있지 않습니다` | 이 저장소가 쓰는 플러그인을 아직 등록하지 않았다. 그대로 둬도 기본 구현으로 돈다 — 쓰려면 현재 세션에서 플러그인 등록을 요청한다 |

---

## 12. 아직 없는 것

| 단계 | 내용 | 상태 |
|---|---|---|
| P1 뼈대 | CLI · hook · `.claude/` 템플릿 · 작업 폴더 | ✅ |
| P2 프로젝트 문서 | 문서 스키마 · `docs` · `confirm doc` · `/ca-docs` · `/ca-adopt` | ✅ |
| P3 분석·조사·계획 | `analysis.md` · 작업 문서 · 계획 검사 · 승인 · 구현 울타리 | ✅ |
| P4 문서 모델 전환 + 영향도·설계 | POLICY 2 → 4 · KNOWLEDGE 3종 빈 뼈대 · 번호 작업 문서(`01`~`04`·`07`, `05` 는 코드 렌더) · `impact`·`design` 스테이지 · 영향 표/AC/TC 게이트 · 승인 묶음 고정 | ✅ |
| P5 구현·검증·반영 | 정적 분석 · 테스트 실행 · 테스트 동결 · 수정 루프 · 코드 리뷰 · 통합 검증 · 반영(같은 세션 확인 · 로컬 커밋 · `10-pr.md`) · KNOWLEDGE 갱신 · Stop hook | ✅ |
| P6 fix·refactor·신규 저장소 | 재현 테스트 먼저(`code-agent repro`) · 기존 테스트 보호 · 종류별 단계(`stages[].kinds`) · 빈 저장소 도입 · `deliver` 커밋 범위 · `integrate` 의 `prepare` | 코드 ✅ · 완주 실측 |
| P7 플러그인 | 자리 6개 · 명령 어댑터 계약 · `plugin list/add/remove` · 등록한 사람만 opt-in · 기본 구현(내장 키워드 스캔 · 제목 매칭) — [10. 플러그인](#10-플러그인-선택) | 코드 ✅ · Jev A/B 실측 |
| P8 정리·배포 | 단일 실행 파일([install.md](install.md)) · `doctor` · `update` · `usage`(토큰 집계) · `knowledge` · 문서 세트 | ✅ |

지금 완주할 수 있는 것은 **작업 브랜치의 로컬 커밋까지**다. push · MR/PR 생성 · 병합은 사람이 손으로 한다 —
git 호스트가 붙을 때까지 보류한 자리이고, 붙으면 그때 정한다.


## 관찰된 계획 작업

신규 작업은 `status`의 계획 처리 줄에 관찰 흐름으로 표시된다. 각 단계에서 `planning advance`가 준비·재사용·선행 조건·동시 한도를 확인하고 반환한 배정별로 서브 에이전트를 호출한다. 실제 시작·완료 hook이 결과를 기록한다. 영역을 직접 나눌 때는 `planning prepare <작업.json>`을 먼저 사용한다. 전체 단계별 내용 기준은 동일하며 번호 문서와 plan.json은 관찰된 결과로 생성한다. 이전 버전 작업은 기존 작성 절차로 재개한다.

`planning status`는 요약, `planning result <ID>`는 원문 산출물과 현재 입력에 대한 유효성을 조회한다. 선행 결과는 문서 본문 대신 경로·해시를 전달한다. 관찰된 출력 형식 오류는 `planning advance` 또는 `planning repair <ID>`로 같은 입력에서 1회 교정한다. 새 담당의 시작·완료 관찰이 필요하며 입력 변경·근거 오류·미결 질문·승인을 우회하지 않는다. `ready-for-gate`는 기존 게이트로 넘어갈 준비 상태이며 승인 완료가 아니다.

기본 역할 순서는 analysis → 영향도 → design → plan → critic이다. 작은 기본 영향도는 impact 한 담당이 조사·문서 정리를 함께 하고 나머지는 explore → synthesis로 진행한다. 분할 조사가 필요하면 첫 advance 전에 prepare로 준비한다. 설계·계획 판단은 ca-analyst, 분할 조사 정리는 ca-writer다. 새 작업은 역할별 필요한 입력만 연결하고 선행 실행 ID만 바뀐 동일 결과를 재사용한다. 선행 작업의 현재 입력·완료·충돌은 계속 검사한다. 계획 제출·승인은 관찰된 critic 완료가 필수다. 구현은 tasks의 현재 파일 범위만 허용한다. 선택 기준·예시·질문 상태·취소·재시도·피드백 반영은 [계획 작업 안내](planning.md)에 정리했다.
