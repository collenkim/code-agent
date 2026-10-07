# code-agent 프로세스 흐름도

이 문서는 현재 동작을 정리한 지도다. 기준은 커밋 `c4f3fbf`(2026-10-07)이다. 코드가 정본이므로 문서와 코드가 다르면 코드가 맞고, 이 문서를 고친다.
표의 `file:line`은 위 커밋 기준이다. 다만 계획 오케스트레이션을 다시 쓴 커밋과 그 검토 반영 커밋(§10)이 고친 모듈 — `planning.ts`·`planningState.ts`·`planningHook.ts`·`planningValidation.ts`·`stagedChecks.ts`·`codexHook.ts`·`sessionHook.ts`·`crossCheck.ts`·`handoff.ts` — 의 `file:line`은 검토 반영 커밋 기준이다(`commands.ts` 등 다른 모듈은 위 커밋 기준 그대로다). 줄 번호가 어긋나면 함께 적은 함수 이름으로 찾는다. 경로의 기준은 `src/agent/`이고, `core/`는 `src/core/`, `template/`·`doc/`는 저장소 루트의 같은 폴더다.
이 문서는 현재 동작만 적는다. 결함으로 판정된 동작과 개선안은 [2026-10-07 감사 기록](reviews/2026-10-07-dual-host-process-audit.md)에 있다.

**읽는 순서(에이전트용)** — §2에서 바뀌는 칸을 찾고, §3에서 그 행을 읽은 뒤, §9로 파일을 연다. 이어서 사람 확인(§4)·hook(§5)·호스트 차이(§7)에 걸리는지 본다. 이 문서에 없는 동작은 추측하지 말고 코드를 연다.

## 1. 목적과 갱신 규칙

**목적**은 세 가지다. 개발 에이전트(Claude·Codex)가 코드를 다시 분석하는 시간을 줄이고, 단계·게이트·hook을 잘못 기억해 생기는 오판과 재시도를 줄이며, 변경이 어느 흐름에 영향을 주는지 먼저 판단하게 하는 것이다.

**근거 수준** — 기본은 코드 판독이다. §5의 등록표와 판정 일부는 2026-10-07에 sandbox에서 직접 확인했다(`init --host both` 설치 결과, `codex-event`·`hook`·`stop`·`session-event`에 이벤트를 넣은 결과). 같은 날 검증 단계에서 `init` 호스트 합집합(§7), 세션 없는 상태의 `hook` 판정(§4.1), `git add -f`의 `.gitignore *` 무시(§8)도 sandbox에서 다시 확인했다. 그 밖에 실제 호스트에서 확인하지 않은 동작은 "미확인"이라고 적는다.

### 1.1 변경 → 갱신 대응표

| 바뀐 코드 | 갱신할 섹션 | 함께 맞출 중복 정의 |
|---|---|---|
| `layout.ts` `PHASES`·`AFTER_IMPLEMENT`·`STOP_PHASES` (20-43) | §2, §3 | `commands.ts` `PHASE_LABEL`·`PHASE_COMMAND`(94-122), `template/claude/skills/ca-next/SKILL.md:14-25` 표 |
| `commands.ts` `start`·`next`·`back`·`requireValidatable`·`abort` | §2, §3, §3.3 | 각 단계 스킬의 "자리 확인" 문장 |
| `request.ts` 접수·확정, `docsCommands.ts`·`bootstrap.ts` 준비 | §3.1, §4 | `ca-request`·`ca-adopt`·`ca-docs` SKILL.md |
| `init.ts` hook 등록(186-189, 223-233)·`HOOK_MATCHER`(19) | §5, §7 | `doctor.ts:174` hook 목록, `doctor.ts:244-261`, `update.ts:99` hook 출력, `doc/codex.md:39-45` 이벤트 표, `README.md` 동작 구조 표, `doc/install.md:37`, `doc/usage.md:12` |
| `codexHook.ts` | §4.2, §5.2, §7 | `template/CODEX.block.md`, `template/codex/ca-answer.md` |
| `consent.ts` `ActionSchema`(28-36)·`preview`(258-305)·`applyLocked`(466-509) | §4 | `ca-answer/SKILL.md:44`, `ca-answer/reference.md`, `template/codex/ca-answer.md:16` 동작 목록 |
| `hook.ts` `decide`·`MODEL_SUBCOMMANDS`(89-114) | §5.3, §5.4 | `template/CLAUDE.block.md`, `hook.ts:412-419` 거부 문구 |
| `planning.ts`·`planningState.ts`·`planningHook.ts` | §6.1 | `doc/planning.md` 역할·action 표, 단계 스킬 1~6항(advance `action`을 바꾸면 4항), `ca-plan/contract.md:10,16`(질문 출처·수정 피드백), `ca-plan/SKILL.md` 4-1항·반려 절차와 `crossCriticProblems` 문구(고칠 작업은 지적 내용으로 정한다), `ca-next/SKILL.md:31`(재개 때 실행 중 배정 확인 — Codex는 SessionStart가 없다)·`:51`(자동 되감기 예외), `sessionHook.ts`(실행 중 배정 요약), `handoff.ts` `handoffPlanning`(배정 요약의 `previous`) |
| `lock.ts` | §6.1, §8 | 리뷰 기록·동의 적용·작업 임대가 같은 잠금을 쓴다 — 호출자별 `ageReclaim`·`display`·문구 |
| `stagedChecks.ts`, `planningValidation.ts`·`workDocs.ts`의 게이트 함수 | §6.1 관찰 6단계 | 게이트 함수를 바꾸면 계획 담당 완료 hook의 문서 검사도 함께 바뀐다(같은 함수) |
| `verificationFlow.ts`·`validate.ts`·`evidence.ts`, `core/build.ts` `CommandResult`, `tree.ts` `partialTreeHash`, `testResults.ts`·`testReports.ts`, `retryPolicy.ts` 검증 절 | §3.2 check~integrate, §6.2, §6.3 리뷰 회차, §8 | `ca-check/SKILL.md` 노드 처리 목록, `ca-check`·`ca-test`·`ca-integrate`·`ca-implement`·`ca-fix` 재시도 문장과 `ca-review` 5항, `ca-tester.md` 동결 문장, 장시간 실행 정본 문장(`ca-check`·`ca-test`·`ca-integrate`·`ca-implement` 4곳 글자 그대로) |
| `review.ts`·`reviewHook.ts`·`crossCheck.ts` | §3.2 review, §6.3, §7 | `ca-review/SKILL.md`, `ca-plan/SKILL.md:27`. 리뷰 회차 한도는 `evidence.ts` `reviewRoundUsageOf` 하나다(§6.2·§6.3) |
| `deliver.ts`·`knowledge.ts` | §3.2 deliver, §8 | `ca-integrate/SKILL.md` |
| `hosts.ts` `codexText`(64-82) | §7 | 치환 대상 문장: `hosts.ts:78-80`의 리터럴이 `ca-analyze`·`ca-impact`·`ca-design`·`ca-plan` SKILL.md와 `ca-analyst`·`ca-explorer`·`ca-writer` 에이전트 원문과 글자 그대로 같아야 치환된다 |
| `retryPolicy.ts` `POLICIES`·`LIMITS`·`GRANT_STEP`·`TIMING`·`GUIDE_KEYS`·`GUIDE_VARIANTS`·판정 함수, `lock.ts`, `crossEnv.ts`, `hostText.ts` | §6.4(표는 생성 블록 — `renderRetryPolicyTable()` 출력으로 다시 붙인다), 연결된 판정 지점의 §4·§5·§6.1~§6.3 | §6.4 생성 블록(`docSync.test.ts`가 바이트 대조), 안내 문구 자리표시와 `GUIDE_KEYS`·`GUIDE_VARIANT_KEYS`(`retryPolicy.test.ts`가 대조), `crossFailureText`의 Codex 배너 식(Codex exec 출력 라벨이 바뀌면), `hostText.ts` `SKILL_NAMES`·`ROLE_NAMES`(템플릿 폴더·`hosts.ts` `ROLE_NAMES`와 같아야 한다 — `hostText.test.ts`가 대조) |
| 상태·산출물 경로(`layout.ts`, `handoff.ts`, `deliveryPaths`) | §8 | `.gitignore` 블록(`init.ts:191-192`), `baselineFiles`(`bootstrap.ts:40-62`) |
| 새 파일·모듈 이동 | §9 | — |
| 스킬·서브에이전트 추가·삭제 | §7, §9 | 설치 수(`README.md` 동작 구조 표, `doc/codex.md` 설치 대상 표, `doc/install.md`, `doc/usage.md:188`), `ca-next/SKILL.md` 표, `init.ts`의 Codex 설치 안내 문구. 서브에이전트는 `hosts.ts` `ROLE_NAMES`(10)·`codexText` 역할 정규식(65)과 `modelPolicy.ts` `AGENTS`(5)도 고치고, 계획·리뷰 담당이면 `init.ts:228-231`·`doctor.ts:181` matcher도 고친다 |

**갱신 절차** — 코드 변경과 같은 커밋에서 해당 행과 `file:line`을 고치고, §10에 한 줄을 남긴다. 확인하지 못한 동작은 쓰지 않거나 "미확인"으로 표시한다.

## 2. 전체 흐름 한 장

```mermaid
flowchart TD
  INIT["init --host claude|codex|both<br/>hosts.json · hook · 스킬"] --> RB["request begin<br/>request-session.json"]
  RB --> PREP{"preparationHint<br/>request.ts:603"}
  PREP -- "매니페스트·문서 없음" --> DOCS["/ca-adopt · /ca-docs<br/>docs begin → 작성 → docs end"]
  DOCS --> SETUP(["동의 setup<br/>문서 확정 + 준비 커밋"])
  SETUP --> RS
  PREP -- "준비됨" --> RS["request submit<br/>requirement.md 렌더"]
  RS --> RQ(["동의 request<br/>decideRequest"])
  RQ -- "confirmed" --> ST["start<br/>브랜치 kind/ID · baseCommit · active.json"]
  ST --> AN["analysis · ca-analyst → 01"]
  AN -- "next" --> IM["impact · ca-explorer (+ca-writer) → 02"]
  IM -- "next" --> DE["design · ca-analyst → 03·04"]
  DE -- "next" --> PL["plan · ca-analyst → plan.json·07<br/>ca-critic · both면 planning cross"]
  PL --> PS["plan submit → 05-plan.md"]
  PS --> PA(["동의 plan<br/>decide → 승인 원장"])
  PA -- "next (approved)" --> IMP["implement · Task별 ca-implementer / ca-tester<br/>fix: repro"]
  IMP -- "next (마지막 단계의 마지막 Task)" --> CK["check"]
  CK -- "verify passed → next" --> TS["test"]
  TS -- "verify passed → next" --> RV["review · ca-reviewer<br/>both면 review cross"]
  RV -- "next" --> IN["integrate · 깨끗한 worktree"]
  IN -- "next" --> DL["deliver · 10-pr 모델 구역"]
  DL --> DC(["동의 deliver<br/>로컬 커밋 · 커서 삭제"])
  CK & TS -- "repair / diagnose / decision" --> FIX["수정 루프 (ca-check)"]
  RV & IN -- "지적 · 실패" --> FIX
  FIX -- "check · verify가 커서를 check로" --> CK
```

둥근 칸(`([ ])`)은 사람의 동의다(§4). 새 작업의 기본 동의는 `setup`(최초 준비 때만), `request`, `plan`, `deliver`다. 상황에 따라 `docs`(공통 문서만 다시 확정할 때, `preparationHint` `request.ts:609`), `repro-log`(fix에서 로컬 재현이 안 될 때), `abort` 등이 더해진다(§4.1).

## 3. 스테이지별 표

**공통 전제** (`commands.ts:516-524`) — `next`는 매번 AI-DLC 미진행, 유효한 커서와 `baseCommit`(`requireWork` 158-171), 공통 문서 확정, 요구 확정(`request.ts:350-378`), 답 없는 질문 0(`requireAnswers` 184-193)을 확인한다. analysis~plan에서는 `planningProblems`와 `planningDocumentProblems`도 본다. 게이트에 걸린 `next`는 `Stop`을 던지고 커서는 그대로 둔다.

### 3.1 커서가 생기기 전

| 단계 | 진입 조건 | 담당 | CLI | 산출 | 넘어가는 조건 |
|---|---|---|---|---|---|
| 준비 | 매니페스트가 없거나, 공통 문서가 미확정이거나, 문서 세션이 열려 있다(`preparationHint` `request.ts:603-612`) | 메인 `/ca-adopt`·`/ca-docs`, 서브 `ca-surveyor`·`ca-writer` | `docs recommend·begin·setup·link·end` 등, `survey`, `manifest check`, 동의 `setup` | `code-agent.json`, POLICY 4종(`doc/*.md`), KNOWLEDGE 빈 뼈대(`doc/knowledge/*`, `docs begin`이 만든다 `docsCommands.ts:151,167-177`), `approvals/docs.jsonl`, 준비 커밋. `approvals/docs.jsonl`은 준비 커밋 대상(`baselineFiles` `bootstrap.ts:45-49`)에 없고 첫 반영 커밋에 들어간다(`deliver.ts:324`) | `request submit`의 매니페스트 검사(`request.ts:417-426,645`), `start`의 `requireDocs`(`commands.ts:276`)와 `requirePreparedBranch`(`bootstrap.ts:75-94`) |
| 접수 | `request begin`(`request.ts:428-489`). 문서 세션 열림·AI-DLC·진행 중 작업(같은 ID 포함)·다른 ID 접수·종류 변경이면 거부한다. ID를 생략하면 진행 중인 접수의 ID를 쓰고, 없으면 작업 폴더·확정 원장이 없는 첫 `WORK-0001` 형식(4자리) ID를 발급한다(437-443) | 메인 `/ca-request`(서브 없음) | `request begin`·`request`·`request submit`, 동의 `request` | `doc/work/<ID>/request.json`(모델), `requirement.md`(코드 렌더 785), `approvals/<slug>/request.jsonl` | `decideRequest`가 보여 준 바이트 해시로 `confirmed`를 기록한다(`request.ts:811-893`) |
| start | 요구 확정, 문서 세션 없음, AI-DLC 없음, 매니페스트 있음, 공통 문서 확정, 다른 ID 접수 없음(`commands.ts:266-295`) | 메인(스킬이 호출) | `start <지시서>` | 브랜치 `<kind>/<ID>`, `baseCommit`(새 브랜치는 기준 끝, 기존 브랜치는 merge-base, 333-341), `questions.md`, `active.json`(phase=analysis, planningVersion=1, 354), 접수 세션 삭제(356) | 같은 작업이면 상태만 출력한다. 다른 작업이 진행 중이면 거부한다(297-306). fix는 오류 로그 절이 필요하다(308) |

접수 세션 동안 모델은 `doc/work/<ID>/` 안에만 쓸 수 있고, `requirement.md`는 코드만 쓴다(`hook.ts:307-322`).

### 3.2 커서 단계 (`PHASES` `layout.ts:20-31`)

| 단계 | 담당 (메인 / 서브) | CLI | 산출 | 게이트 (`next`) | 실패 시 |
|---|---|---|---|---|---|
| analysis | `/ca-analyze` / `ca-analyst`(role analysis) | `planning advance` 외, `next` | `01-requirements.md`, `questions.md` | `requireRequirements`: 01 형식과 원문 대조(`commands.ts:531-533`, 196-212) | advance가 `blocked`이면 질문에 답하거나 입력을 고친다. 형식 오류는 `repair`(1회) |
| impact | `/ca-impact` / 기본은 `ca-explorer`(explore)와 `ca-writer`(synthesis). `planning advance`가 impact 작업을 처음 등록할 때 요구 R이 1~3개, 조사 파일이 12개 이하, 합계 96,000바이트 이하면 `ca-explorer` 단독(impact)(`planning.ts:78-85`) | 같음 | `02-analysis.md` | 조사 결과가 current이고 사실 충돌이 없다(`planningState.ts:474-479`). `analysisProblems`(534-538) | 같음. 사실 충돌은 조사를 다시 돌린다 |
| design | `/ca-design` / `ca-analyst`(design) | 같음 | `03-design.md`, `04-functional.md` | `designProblems`와 `functionalProblems`(539-546) | 같음 |
| plan | `/ca-plan` / `ca-analyst`(plan)와 `ca-critic`(critic). 두 호스트 설치 시 `planning cross` | `planning advance·cross`, `plan submit`, 동의 `plan` | `plan.json`, `07-test-spec.md`, `<target>.plan.json`, `05-plan.md`(렌더 1286-1289), 승인 원장 | `reviewedPlanProblems`(critic이 본 plan.json과 제출본이 같다), 계획 존재, 승인 `approved`(547-558) | 반려되면 `ca-plan`의 반려 절차로 원인 작업을 다시 배정하고 재제출한다 |
| implement | `/ca-implement` / `ca-implementer`, 테스트 단계는 `ca-tester`(`handoff.ts:43-44`) | `context --file`, `repro`(fix), `next` | 계획 파일 | 승인 유지, 현재 Task 파일 존재, 같은 단계의 다음 Task로 이동. 단계가 끝나면 `missingPlannedFiles`, fix의 test 단계는 `reproMissing`을 본 뒤 다음 단계나 check로 간다(559-598) | `Stop`이면 빠진 파일을 다시 맡긴다. 승인이 stale이면 재제출·재승인한다 |
| check | `/ca-check` / 수정은 `ca-implementer` | `verify --json [--retry]`(단계만 돌릴 때는 `check`) | `<target>.verify.json`, `08-validation.md`, `.code-agent/log/` | `stageProblems(check)`(`evidence.ts` `stageProblemEntries`) | verify 노드 `repair`·`diagnose`·`decision` — 원인별 카운터(§6.2, 규약 §6.4) |
| test | `/ca-test` / TC 코드가 없을 때 `ca-tester` | `verify --json`(또는 `test`) | 같은 증거, `testCases`, `testFreeze` | `stageProblems(test)`: ⑦의 모든 TC가 `passed` + 동결 뒤 바뀐 kind:test 파일 없음(`testFreezeProblems`) | 같음. 수정 뒤 `verify`로 check부터 다시 |
| review | `/ca-review` / `ca-reviewer` | `review`, `context --file`, 두 호스트면 `review cross --by <다른 호스트>` | `<target>.review.json`, `09-review.md` | `reviewProblems`(`review.ts`) | 계획 안 지적은 수정 루프 → `verify` → 새 회차(리뷰 회차 3회까지, §6.3). 계획 밖 지적은 질문 또는 재계획 |
| integrate | `/ca-integrate` / 없음 | `integrate` | `integrate` 실행 기록, `integrationTestCases`, `.code-agent/log/worktree.lock`(실행 중) | `stageProblems(integrate)`: 통합 TC 전부 passed, 동결 뒤 바뀐 kind:test 파일 없음, fix면 재현 테스트 트리가 일치 | 수정 루프. prepare 실패·중단은 환경으로 분류하고 같은 회차 재실행 2회, 코드 결함은 같은 코드 재실행 거부(§6.2) |
| deliver | `/ca-integrate` 3절 / 없음 | 동의 `deliver`(사람은 TTY `deliver`) | `10-pr.md` 모델 3절, `knowledge.proposal.md`(선택), 로컬 커밋 | `next`로는 끝나지 않는다(618-623). `deliverProblems`(`deliver.ts:189-232`), 작업 브랜치(401-409), 사람 확인(419) | `Stop`이면 커밋하지 않는다. `back`은 거부한다(`commands.ts:763-768`) |

**hook의 쓰기 범위** (`decideWrite` `hook.ts:444-540`, 작업 커서가 있을 때) — 지시서·`05-plan.md`·`08-validation.md`는 언제나 거부한다(447-471). 관찰 흐름의 계획 출력 문서는 메인 쓰기를 거부한다(474). 그 밖의 작업 폴더는 어느 단계에서든 허용한다(475-477). refactor는 추적 중인 기존 테스트 파일을 거부한다(481-490). analysis~plan에서는 작업 폴더 밖을 거부한다(492-497). implement부터는 제출된 계획과 `approved` 승인이 있어야 하고(498-508), implement에서 계획에 tasks가 있으면 현재 Task 파일만 허용한다(509). implement와 그 뒤 단계 모두 파일이 속한 단계 판정(512-521), fix의 재현 순서(548-568), 쓰기 한도(`writeBlockReason` — 고쳐도 다음 회차가 거부될 때만)·테스트 동결(결과가 인식된 실행부터, 수집 수정 1회 예외)(`freezeReason`, §6.2), 경계·계획 대조(532-538)를 적용한다.

### 3.3 커서 이동

| 명령 | 방향 | 조건 | `stages.jsonl`의 `by` |
|---|---|---|---|
| `next` | 한 칸 앞. implement 안에서는 Task·단계 단위로 움직인다 | §3.2 게이트 | `next` |
| `back <단계>` | 뒤로만. `deliver`는 대상이 아니고, deliver에서는 실행 자체를 거부한다 | `commands.ts:758-789`. hook은 모델의 `back`을 허용한다(`hook.ts:94`). "사용자 지시 시에만"은 스킬 규칙이다 — 예외는 계획 `planning advance`의 `rewind-required`·`rewind.auto: true`(같은 사유에 한 번, §6.1)다 | `back` |
| `check`·`verify`(check 진입) | test·review·integrate에서 check로 되감는다 | `REWINDABLE`(633), `requireValidatable`(655-658) | `next`(656) |
| 동의 `deliver` | 커서 삭제 | 커밋 성공(`deliver.ts:424-425`) | `deliver` |
| 동의 `abort` | 커서 삭제, 작업이 없으면 접수 세션 삭제 | `commands.ts:708-722`. 문서·원장·계획은 남는다 | `abort` |

## 4. 사람 확인 지점

### 4.1 동의 동작 (`consent.ts:28-36`, 제목은 62-67)

| action | 제목 | 준비(preview 258-305) | 적용(applyLocked 491-505) | 사람의 직접 CLI 대체 |
|---|---|---|---|---|
| setup | 초기 설정 확정 | `confirmDoc(all)`과 `setupBaseline`의 확인 문구 | 둘을 차례로 실행 | `confirm doc all` + `setup baseline` |
| docs | 공통 문서 확정 | `confirmDoc(kind)` | 같음 | `confirm doc <종류>` |
| baseline | 기준 커밋 생성 | `setupBaseline` | 같음 | `setup baseline` |
| request | 요구사항 확인 | `decideRequest`(reject면 comment 필수) | 같음 | `confirm request <ID>` · `reject request <ID> --comment` |
| plan | 작업 계획 확인 | `decide` | 같음 | `approve` · `reject --comment` |
| deliver | 결과와 로컬 커밋 확인 | `deliver`를 두 번 캡처하고 `knowledgeChoices`를 만든다 | `deliver` | `deliver` |
| knowledge-prune | 지식 문서 정리 | `pruneCandidates` | `knowledgePrune` | `knowledge prune` |
| model | 에이전트 모델 변경 | `validateModelChange` + 표 | `setModel` | `model <역할\|all> <모델>` |
| abort | 작업 진행 종료 | `status` | `abort` | `abort` |
| plugin-add · plugin-remove | 플러그인 등록·제거 | `previewPlugin*` | `pluginAdd` · `pluginRemove` | `plugin add` · `plugin remove` |
| update | code-agent 업데이트 | `previewSourceUpdate` | `updateFromSource` | `update` |
| repro-log | 오류 로그 근거로 수정 진행 | `approveLogBasis` | 같음 | 없음 |

- 직접 CLI의 사람 확인은 명령마다 다르다. `confirm doc`·`confirm request`·`reject request`·`approve`·`reject`·`setup baseline`·`deliver`·`plugin add`는 `confirmOnTerminal`(`tty.ts:76-90`)이 TTY에서 확인 단어 입력을 요구한다. `model` 변경·`plugin remove`·`knowledge prune`은 TTY만 요구한다(`requireTerminal` `tty.ts:55-63`, `models.ts:102`, `plugins/commands.ts:422`, `knowledgeCommands.ts:217`). `abort`(`commands.ts:708-722`)와 `update`(`sourceUpdate.ts`)에서는 TTY 확인 호출을 찾지 못했다.
- 동의 적용 중에는 준비 때 캡처한 문구와 같은 확인만 통과한다(`consent.ts:485-487`).
- 작업·접수·문서 세션 중에 모델이 셸에서 이 동작들을 직접 부르면 hook이 거부한다(§5.4). 세션이 없으면 hook은 `.code-agent`·키 자리 언급만 막으므로(§5.3 3단계) `init`·`update`·`approve`·`setup baseline` 같은 명령도 hook을 지난다(2026-10-07 sandbox 확인). 이때는 위의 TTY 확인과 각 명령의 전제 검사만 남는다.

### 4.2 응답 관찰 — 호스트별

```mermaid
sequenceDiagram
  participant U as 사용자
  participant M as 메인 에이전트
  participant C as code-agent CLI
  participant H as hook
  M->>C: consent prepare action.json (snapshot, pending)
  C-->>M: id, summary, questions, toolInput, codexReply
  alt Claude (channel claude-question)
    M->>H: AskUserQuestion(toolInput) PreToolUse → consent-event
    H->>C: observeConsent Pre: 세션·toolId·질문 결속
    U->>M: 선택
    M->>H: PostToolUse → consent-event
    H->>C: observeConsent Post: 응답 기록 (approved | changes-requested | deferred)
  else Codex (channel codex-prompt)
    M-->>U: summary와 번호 선택지 표시
    U->>H: 대화 메시지 "code-agent consent respond ID 번호들" → UserPromptSubmit
    H->>C: observeCodexConsent → Pre·Post 합성 (tool_use_id codex-prompt:turn_id)
  end
  M->>C: consent finish ID (PreToolUse가 같은 session_id 확인)
  C->>C: 스냅샷 재대조 → applying → 도메인 함수 → applied | failed
```

**결속 규칙** (`consent.ts:362-434`, `510-515`)
- 서브에이전트(`agent_id` 있음)의 질문은 거부한다(372).
- 첫 Pre가 `sessionId`·`channel`·`cwd`를 정한다(391-395). 다른 채널·다른 세션·다른 작업 경로면 거부한다(382, 385, 386).
- Pre의 질문은 준비된 질문과 deep-equal이어야 한다(389).
- Post는 결속된 toolId 하나만 한 번 소비한다(397-402). 시간 초과·추가 질문·메모가 붙은 응답은 승인으로 보지 않는다(405-409).
- `finish`·`apply`는 hook이 같은 `session_id`를 요구한다(510-515). 적용 직전에 스냅샷을 두 번 재대조한다(476, 480).
- 중단된 `applying`은 `failed`로 처리하고 다시 실행하지 않는다(470-473).
- Codex 응답 형식은 `^code-agent consent respond <36자 id> [1-3](,[1-3]){0,3}$`다(`codexHook.ts:36`). 이벤트에 `turn_id`가 있어야 하고(37), 질문 수와 선택 수가 같아야 한다(40).

## 5. hook 등록표

### 5.1 Claude — `.claude/settings.json` (`init.ts:223-233`, sandbox 확인)

| 이벤트 | matcher | 하위 명령 | 처리 | 판정·기록 | 실패 시 |
|---|---|---|---|---|---|
| PreToolUse | `Write\|Edit\|MultiEdit\|NotebookEdit\|Bash\|PowerShell\|Read\|Grep\|Glob` | `hook` | `runHook`→`decide`(`hook.ts:620`, 178) | deny JSON | 예외면 exit 2로 막는다(635-639) |
| PreToolUse | `AskUserQuestion` | `consent-event` | `observeConsent` Pre | 질문 결속 | exit 2(`consent.ts:516-519`) |
| PostToolUse | `AskUserQuestion` | `consent-event` | `observeConsent` Post | 응답 기록 | exit 2 |
| Stop | 없음 | `stop` | `decideStop`(`stopHook.ts:22-54`) | implement~integrate에서 계획 밖 변경이나 미응답 질문이 있으면 `{decision:block}`을 1회 낸다 | 언제나 exit 0(57-69) |
| SubagentStart·Stop | `ca-reviewer` | `review-event` | `observeReviewer`(`reviewHook.ts:36-92`) | review 단계가 아니면 아무것도 하지 않는다(41). Start: 회차 리뷰어 등록. Stop: 형식 검사 후 `## 지적` 재작성 | `subagentExitCode`(31-33): SubagentStop이면서 기록된 실패이거나 `stop_hook_active`면 0, 그 밖(Start 실패 포함)은 2 |
| SubagentStart·Stop | `ca-analyst\|ca-explorer\|ca-writer\|ca-critic` | `planning-event` | `observePlanner`(`planningHook.ts:335-357`) | §6.1 | `subagentExit`(§6.4, `runPlanningHook` 358-366): SubagentStop에서 기록 전의 되돌릴 수 있는 실패(형식·식별·내용)와 기록하지 못한 판정 실패는 `stop_hook_active`가 아니면 2, 기록된 실패·`stop_hook_active`면 0. Start 실패는 2 |
| SessionStart | 없음 | `session-event` | `sessionAnchor`(`sessionHook.ts:18-22`, `progress` 51-78) | 작업 4줄·접수 3줄·문서 세션 2줄의 상태를 stdout에 낸다. 계획 배정이 running으로 기록돼 있으면 그 목록과 안내 한 줄을 더한다(`runningPlanning` 28-49 — 입력 `source`가 startup·resume·clear면 `planning cancel <ID>` 뒤 advance, 그 밖은 advance의 stale·cancel 안내). AI-DLC 경고가 있으면 1줄을 더한다(20). 진행 중인 것이 없으면 출력 없음 | 언제나 exit 0 |

### 5.2 Codex — `.codex/hooks.json` (`init.ts:186-189`, sandbox 확인)

다섯 이벤트가 matcher 없이 모두 `code-agent codex-event` → `runCodexHook`(`codexHook.ts:104-131`) → `codexHook`(62-98)로 들어간다.

| 이벤트 | 처리 | 실패 시 |
|---|---|---|
| PreToolUse | `Bash`·`PowerShell`·`apply_patch`(56)만 판정하고 그 밖은 `{}`를 낸다(64). `apply_patch`는 `patchPaths`의 모든 경로를 `Edit`로 `decide`에 넘긴다(71-78). 셸은 Windows면 `shell: powershell` 규칙으로 판정한다(70). `agent_id`는 넘기지 않는다 | deny JSON(113-116) |
| UserPromptSubmit | `observeCodexConsent`(34-53). `code-agent consent respond`로 시작하지 않는 메시지는 무시한다 | 예외면 stderr와 exit 2(128-129, 형식 오류 메시지로 sandbox 확인). 이때 Codex의 동작은 미확인 |
| SubagentStart·Stop | `commonAgentName`(`ca_x`→`ca-x`)으로 바꾼 뒤 transcript 없이 `observePlanner`(`host: "codex"` — 되돌리지 않고 바로 기록)와 `observeReviewer`에 넘긴다(85-91). 결과는 `last_assistant_message`만 본다. 관찰 대상이 아니면 `{}`·exit 0(진행 중 작업 없는 SubagentStop으로 sandbox 확인) | 예외면 기록 여부와 관계없이 stderr에 사유를 남기고 `{}`·exit 0(`subagentExit` codex, 117-122) — Codex는 exit 2로 담당을 잇지 않는다 |
| Stop | `decideStop` → `{decision:"block"}`(93-95) | `{}`, exit 0(123-127) |

### 5.3 PreToolUse 판정 순서 (`decide`, `hook.ts:178-223`)

1. 셸 명령 검사(182-184): 관찰 명령(`consent-event`·`planning-event`·`review-event`·`codex-event`)을 부르면 거부한다. `consent apply·finish`는 세션 결속을 확인한다.
2. 모드 결정(186-198): 작업 > 문서 세션 > 접수 세션 > 없음. 상태를 읽지 못하면 `decideUnreadable`(230-244).
3. 모드가 없으면 `decideOutside`(255-274): 셸은 키 자리·`.code-agent` 경로 언급만, 읽기는 키 자리만, 쓰기는 키 자리·`:` 경로·`.code-agent`·`.claude`·`.codex`·`.agents`·`doc/work/*/requirement.md`만 거부한다. 저장소 밖 쓰기는 관여하지 않는다(270-272).
4. 셸이면 `decideBash`(387-421): 키 자리 언급과 AI-DLC 실행 언급을 먼저 거부한다(388-394). 연결·리다이렉트·줄바꿈·`$(`(56)를 거부하고, PowerShell이면 작은따옴표 밖의 `(){}@$`와 큰따옴표 안의 `$`도 거부한다(62-71). 모델 명령(§5.4), 선언된 build·test·commands(문서·접수 세션 제외), 읽기 전용 git(`status·diff·log·show`, 목록 보기 `git branch`, `-o`·`--output`·`--no-index` 제외)만 허용한다.
5. 읽기 도구는 키 자리(`~/.code-agent/credentials.json`)만 막는다(205-208).
6. 쓰기는 `guardRepo`·`streamGuard`를 거친 뒤 모드별로 판정한다: 작업은 `decidePlanner`(staging, 428-442) → `decideWrite`(444-540), 접수는 `decideRequestWrite`(307-322), 문서 세션은 `decideDocWrite`(352-364).

### 5.4 모델이 셸로 부를 수 있는 `code-agent` 명령 (세션·작업 중)

- 허용(`hook.ts:89-129`, 접두어 일치)
  - `start`·`next`·`back`·`context`·`read`·`status`·`plan submit`·`planning prepare·advance·status·result·dispatch·repair·cancel·cross`·`docs *`·`survey`·`manifest check`·`request *`
  - `plugin list`·`repro`·`check`·`test`·`verify`·`review *`·`integrate`
  - `consent prepare <파일>`·`consent status·apply·finish <id>`, `model`·`model --host <호스트>`(조회만), `setup`(조회만), `help`, 인자 없는 `code-agent`
- 그 밖은 모두 거부한다. 그중 `abort`·`approve`·`reject`·`confirm`·`model` 변경·`deliver`·`plugin add·remove`·`update`·`knowledge prune`·`setup baseline`은 §4.1 동의로 실행한다. `init`·`usage`·`doctor`·`knowledge`(목록)·`plugin example`은 동의 동작이 없고 사람이 직접 실행한다.

## 6. 오케스트레이션

### 6.1 계획 작업 (analysis·impact·design·plan, `planningVersion=1`)

| 역할 | 단계 | 담당(Claude / Codex) | 출력 | 선행(dependsOn) |
|---|---|---|---|---|
| analysis | analysis | `ca-analyst` / `ca_analyst` | `01-requirements.md` | 없음 |
| explore | impact | `ca-explorer` | 없음(facts만) | analysis |
| impact | impact | `ca-explorer` | `02-analysis.md` | analysis |
| synthesis | impact | `ca-writer` | `02-analysis.md` | explore 전체 |
| design | design | `ca-analyst` | `03-design.md`·`04-functional.md` | impact 또는 synthesis |
| plan | plan | `ca-analyst` | `plan.json`·`07-test-spec.md` | design |
| critic | plan | `ca-critic` | 없음 | plan |

근거: 단계 매핑 `ROLE_PHASE` `planningState.ts:31`(`planning.ts:21`이 `PHASE`로 재수출), 담당 `planningState.ts:16`(Codex 이름은 `hosts.ts:11`), 출력 `planningState.ts:439-442`, 선행 `planning.ts:68-71`.

**배정 — `planning advance`** (`advancePlanning` `planning.ts:405-480`)
1. 계획 단계가 아니면 거부한다. 잠금 밖에서 모든 작업의 current 판정을 한 번 돌려 메모를 채운 뒤(411), 전체 처리를 `<target>.planning.json.lock` 잠금 안에서 한다(`mutatePlanning` 48-64). 잠금은 공통 `acquireLock`(`lock.ts`, `ageReclaim`)이다 — 주인 `{pid, host, at, nonce}`를 적고, 같은 PC의 죽은 주인과 주인 기록 없는 오래된 잠금은 같은 호출에서 회수한다(stderr 한 줄). 살아 있는 주인은 CLI 2초·hook 10초(`TIMING`) 기다린 뒤 "같은 명령을 한 번만 다시 실행" Stop, 다른 PC·주인 불명은 곧바로 사람에게 넘기는 Stop이다(문구에 잠금의 저장소 상대 경로). 잠금 안에서 처음 쓸 때 `retry.since`를 기록한다(58).
2. 이 단계의 기본 작업 중 빠진 것만 등록한다(`defaults` 73-97, `prepareState` 102-141). 새로 만드는 analysis·design 작업은 존재하는 업무 규칙 KNOWLEDGE(`businessRuleFiles` `planningState.ts:500-511`)를 inputs에 넣는다. 이미 있는 작업은 그대로다.
3. 고아 정리(`sweepOrphans` 163-175) — 마지막 시도가 running인 모든 작업을 `orphanState`(§6.4, 관찰 정보는 `runView` `planningState.ts:366-388`)로 판정한다. 연결된 담당이 모두 끝났는데 running이면 확실한 고아라 `orphaned`(`failure.class: dispatch-orphan`)로 표시하고 같은 호출에서 다시 배정한다. 시작이 관찰되지 않은 채(배정 시각과 그 뒤 관찰된 마지막 담당 시작·종료 중 늦은 시각부터) 또는 시작이 관찰된 채 기한이 지나면 의심 고아(`stale`)다. 이 정리는 동시 한도보다 먼저다.
4. 되감기 판정(`rewindOf` 349-374) — 앞 단계 작업 중 current가 아닌 것이 있으면 메모를 모두 버리고 다시 계산해 확정한 뒤, 배정 없이 `rewind`를 낸다. `phase`는 가장 앞 단계, `command`는 `code-agent back <단계>`, `tasks[].staleBecause`는 `staleCauses`(`planningState.ts:398-434`)의 항목별 이유(입력 파일·질문과 출처·선행 결과·기준 커밋·code-agent.json·호스트 지침·출력 문서)다. 같은 사유 키(단계 + 작업별 낡은 원인)의 첫 회만 `auto:true`이고 `retry.rewinds`(최근 20개)에 남긴다. analysis까지 되감거나 원인이 기준 커밋·code-agent.json·호스트 지침이면 `notice`를 붙인다.
5. 이 단계 작업마다 다음 순서로 판정한다(429-468).
   - 현재 결과가 유효하면(`taskCurrent`, `planningState.ts:330-337`) `reused`.
   - 실행 중이면 3의 판정대로 `stale`(의심 고아) 또는 `waiting`.
   - 같은 입력으로 failed면 `blocked` — `class`는 시도의 `failure.class`(같은 입력 실패 한도를 다 썼으면 `same-input-repeat`, 이때 `reasons` 둘째 줄도 재배정 안내 대신 그 한도 안내다), `counter`는 `sameInput`.
   - 마지막 두 시도가 모두 출처(transcript) 확인 실패로 고아(`failure.kind: source`)면 `blocked`(`class: hook-failure`) — 담당이 고칠 수 없는 hook·환경 원인이라 자동으로 다시 배정하지 않는다. 명시 `planning dispatch`는 받는다.
   - 동시 실행 한도(기본 3, 최대 4)에 닿았으면 `blocked`(`class: precondition`).
   - 교정 대기면 `repairState`(310-332), 그 밖은 `dispatchState`(251-276)로 배정한다. 직전 시도가 `orphaned`·`failed`면 새 배정에 `previous`(`previousOf` 281-285 — 상태·원인·사유)를 싣는다. 완료 hook이 기록한 실패는 Claude에서 exit 0이라 메인에게 보이지 않기 때문이다. 한도 거부(`RetryRefused`)는 그 `class`·`counter`로, 그 밖의 `Stop`은 `precondition`으로 `blocked`에 싣는다.
6. `dispatchState`는 선행 결과가 current이고 차단 지적·관련 미결 질문이 없으며 입력 파일이 있어야 배정한다(`readyProblems` `planningState.ts:338-351`). synthesis는 조사 사실 충돌도 없어야 한다(256). 실행 중인 자기 작업은 동시 한도 대신 실행 중·stale 문구로 거부한다(261-265). 한도는 `planningDispatchDecision`(§6.4)이 판정한다 — 같은 `inputHash`의 failed(`sameInput`, 취소·고아는 세지 않는다)와 `retry.since` 이후의 작업별 배정(`taskTotal`, 취소·고아 포함). 사람 허용은 `grantPlanningRetry`(204-216)가 소진된 카운터에만 `retry.grants`로 기록한다(범위는 `grantScope`). 이 함수를 부르는 사람 확인 절차(동의)는 없다 — 같은 작업을 다시 준비해도 시도 기록이 남으므로, 작업 총 배정 한도에 닿은 작업에 남는 길은 작업 종료(abort)다. `repairState`는 교정 1회만 허용하고 입력 해시가 그대로여야 하며 같은 입력 실패 한도만 본다(교정은 같은 시도다).
7. `action`을 정한다(473): `rewind-required` → `dispatch` → `stale` → `wait` → `blocked` → `ready-for-gate`. `running`·`orphaned`·`stale`·`cancel`·`rewind`·`feedback`은 해당할 때만 싣는다. `feedback[]`(`feedbackOf` 380-399)은 이 단계 이하 작업과 현재 critic의 교차 검토가 낸 차단 지적이고, `citedTask`·`citedPhase`는 근거 문서를 낸 작업일 뿐 원인이 아니다 — 차단 지적으로는 되감지 않는다.
8. CLI는 배정 전문을 `.code-agent/work/<ID>/handoff/<dispatchId>.md`에 쓰고 요약(`previous`가 있으면 포함)과 `assignmentFile`만 출력한다(`handoff.ts:91-112`). `planning status`(218-236)는 작업마다 실행 관찰(`run`)·낡은 이유(`staleBecause`)·사용량(`budget`)을 더한다(읽기 전용 — 고아 표시를 저장하지 않는다).

입력 해시(`hashInput` `planningState.ts:304-326`, `taskHash`는 그 값)에 들어가는 것은 작업 정의, `baseCommit`, 매니페스트 해시, 입력 파일 해시, `CLAUDE.md`·`AGENTS.md` 해시(기본 작업의 `contextVersion` 2), 선행 결과 해시, 관련 질문이다. 직렬화 객체는 이전 `taskHash`와 키 순서까지 같고 질문은 고정 투영(`hashedQuestion` 279-283)으로 넣으므로 갱신만으로 진행 중 작업의 결과가 낡지 않는다(골든 값은 `planning.test.ts`가 고정한다). 관련 질문(`questionApplies` 272-277)은 작업의 `questionIds`에 있거나, 검증된 출처가 있으면 출처 작업과 그 후손(dependsOn을 거쳐 출처에 닿는 작업)이고, 출처가 없으면 범위(`[Requirements]`)가 없거나 요구 번호가 겹치는 질문이다. 검증된 출처(`questionOrigin` 264-267)는 `[Origin]` 줄이 질문을 쓴 코드(완료 hook·교차 검토)가 `planning.json` `questionOrigins`에 남긴 값과 같고 그 작업이 상태에 있을 때만이다 — 메인이 직접 적은 `[Origin]`은 출처 없는 규칙으로 떨어진다. 답이 달린 질문도 내용째 들어가므로 답을 적으면 해시가 바뀐다. 새 시도는 해시의 부품(`inputParts` — 입력 파일이 50개 이하면 파일별 해시 포함)을 함께 기록해 낡은 이유를 항목별로 보인다.

**명령 1회 범위 메모** (`withPlanningCache` `planningState.ts:131-135`) — 계획 명령·완료 hook 한 번 안에서 파일 sha와 questions.md 본문은 `(mtimeNs, size, ino)` stat 검증 메모로, `git ls-files`는 root별 메모로, 입력 해시는 판정 메모로 재사용한다. 판정 메모는 `mutatePlanning` 진입과 쓰기 뒤에 버리고, 되감기는 메모를 모두 버린 값으로만 확정한다. 범위 밖(`next`·`plan submit` 게이트 포함)에서는 매번 새로 계산한다.

**관찰 — SubagentStart·Stop** (`observePlanner` `planningHook.ts:335-357`)
- 공통 전제: `session_id`·`agent_id`가 없으면 오류다(339). 갱신은 hook 잠금 대기(`TIMING.hookLockWaitMs`)로 `mutatePlanning` 안에서 한다.
- Start: 실행 중인 같은 담당 종류의 배정이 있으면 담당을 등록하고, 후보가 하나일 때만 `dispatchId`를 연결한다(342-348).
- Stop은 잠금 밖 준비(`prepareStop` 96-118 — 결과 수신 29-50, 파싱, staging 읽기와 그 역할의 문서 검사, 해시 메모) 뒤 잠금 안에서 판정한다(`decideStop` 151-329). 판정은 값으로 돌려준다(예외면 저장하지 않으므로 되돌림 횟수·고아 기록을 남기려고). `return`(기록 없이 같은 담당에게 되돌림)은 Claude(`host: "claude"`)에서 `stop_hook_active`가 아니고 그 담당의 되돌림(`agents[].returns`)이 한도 전일 때만이다. 되돌릴 때 그때까지 판정한 `SubagentHandback` 수(`agents[].judgedHandbacks`)를 남기고, 다음 Stop은 그 뒤의 보고만 본다(없으면 `last_assistant_message`) — 되돌린 옛 보고를 다시 판정하지 않는다. 시도를 `orphaned`로 둘 때(2~4)는 같은 시도에 연결된 다른 미완료 담당이 없을 때만이다(`orphanLinked` 136-139 — `orphanState`와 같은 기준). 순서:
  1. 같은 id·세션의 담당이 없으면 무시하고, 이미 끝난 담당이면 기록된 실패("이미 처리한 완료 이벤트입니다")다(154-155).
  2. 출처(transcript) 검증 실패는 되돌리지 않는다 — 담당 기록(`agents[].failure`)에 남기고 연결된 running 시도를 `orphaned`로 둔다(`failure.kind: source`, 174-180).
  3. 형식 오류(JSON·스키마·크기, 182-225): 식별 필드가 이미 running이 아닌 시도를 가리키면 4와 같은 늦은 결과다. 배정을 특정할 수 없으면 연결 시도가 있을 때 한 번 되돌리고(식별 필드 안내), 아니면 연결 시도를 `orphaned`로 기록한다. 실행 중 단계·입력이 바뀌었으면 시도를 `cancelled`로 둔다. 되돌릴 수 있으면 되돌리고, 아니면 `needs-correction`(교정을 이미 썼거나 결과가 크기 한도 500,000자를 넘어 원본을 보존하지 않으면 `failed`)과 `failure.class: agent-format-error`를 기록한다.
  4. 식별(227-242): `taskId`·`dispatchId`·`inputHash`·담당 종류·시작 시각이 배정과 맞지 않을 때 — 보고한 시도가 이미 running이 아니면(취소·고아·교체·종료) 담당의 시작 연결과 상관없이 늦은 결과다. 담당 기록만 남기고 시도는 건드리지 않으며, 담당의 연결(`dispatchId`)을 보고한 시도로 옮긴다(재배정 뒤 늦게 시작해 새 배정에 연결됐던 담당이 새 배정을 고아로 만들지 않게). 연결 시도가 더는 running이 아니거나 시작이 보고한 배정보다 먼저여도 늦은 결과다. 그 밖(복사 오류)은 한 번 되돌린 뒤, 그다음은 연결 시도를 `orphaned`로 둔다(같은 입력 실패에 세지 않는다).
  5. 실행 중 단계·입력 변경과 선행 조건 문제(244-253)는 시도를 `cancelled`(`failure.class: dispatch-orphan`)로 둔다.
  6. 내용 검사(255-296)는 문제를 모두 모은다 — staging 읽기, 근거가 inputs·선행 근거 안이고 실재하는지, completed의 근거·질문, 질문 요구 범위, 출력 집합, 미완료의 문서, 교정 보존, 그리고 그 역할의 결정적 문서 검사(`stagedDocumentProblems`, 아래 게이트). 문제가 있으면 한 번 되돌리고(교정 시도의 문서 검사 실패는 되돌리지 않는다), 아니면 `failed`와 `failure.class: agent-content-error`를 기록한다.
  7. 기록(298-328): completed면 staging 본문 또는 `content`를 정식 문서로 원자 쓰기하고 staging을 지운다. 질문은 코드가 번호를 매기고 `[Origin]: <작업 ID>`를 붙여 `questions.md`에 붙이고, 출처를 `planning.json` `questionOrigins`에도 기록한다. 담당이 `failed`로 반환했으면 `failure`를 남긴다. 담당에 `finished`·`endedAt`을 적는다.
  - 기록한 실패는 `PlanningFailure`(`RecordedFailure`), 되돌림은 `ReturnToAgent`로 던진다(354-355). 종료 코드는 §5.1·§5.2와 같다 — Claude는 `subagentExit`, Codex(`host: "codex"`)는 되돌리지 않고 언제나 0이다.

**게이트**
- `planningProblems`(`planningState.ts:457-483`): 단계별 필수 역할마다 결과가 하나이고 current이며 차단 지적이 없어야 한다. 앞 단계 역할이 낡았으면 `planning advance`가 되감을 단계를 알려 준다고 덧붙인다. impact 이후에는 조사가 current이고 사실 충돌이 없어야 한다. plan에서는 교차 검토 조건(`crossCriticProblems` 445-455)도 본다.
- `planningDocumentProblems`(`planningValidation.ts:27-53`): 확인 필요·TODO·TBD 표시가 없어야 하고, `파일:줄` 근거가 실재해야 한다. AC에는 내용이, BR에는 `파일:줄` 또는 답이 달린 Q 번호 근거가 있어야 한다.
- 완료 hook이 같은 게이트 함수를 staging 본문에 먼저 돈다(`stagedDocumentProblems` `stagedChecks.ts:17-49`, 문서 덮어보기 `DocOverlay`): analysis는 01 형식·원문 추적, impact·synthesis는 `analysisProblems`, design은 `designProblems`·`functionalProblems`, plan은 07 `testSpecProblems`와 plan.json의 스키마·tasks·AC·요구 커버리지·남은 질문(`planDraftProblems`·`planShapeProblems` `planningValidation.ts:61-81`, `plan submit`과 같은 함수), 그리고 각 출력의 `planningDocumentProblems`다. 순서·경로·preserve·종류별 규칙은 `plan submit`에만 있다. `next`·`plan submit`의 최종 게이트는 그대로다.
- `reviewedPlanProblems`(`planningValidation.ts:13-21`): 제출된 계획이 작업 폴더의 `plan.json`(관찰된 plan 담당이 쓴 초안)과 같은 해시여야 한다. plan 게이트와 승인(`commands.ts:549,1317`)이 본다.

### 6.2 검증 노드 — `verify` (`verificationFlow.ts` `verify`·`assess`)

```mermaid
stateDiagram-v2
  state "check.execute" as CE
  state "check.assess" as CA
  state "test.select" as TSel
  state "test.execute" as TE
  state "test.assess" as TA
  state "review (agent)" as RV
  state "repair (agent)" as RP
  state "diagnose (agent)" as DG
  state "decision (human)" as DC
  [*] --> CE
  CE --> CA : done
  CE --> DC : RetryRefused(한도)
  CA --> TSel : passed (next → test)
  CA --> RP : repair
  CA --> DG : diagnose
  CA --> DC : blocked
  TSel --> TA : recorded
  TSel --> TE : execute
  TE --> TA : done
  TA --> RV : passed (next → review)
  TA --> RP : repair
  TA --> DG : diagnose
  TA --> DC : blocked
```

원인 분류·카운터·한도·판정 함수는 `retryPolicy.ts` 검증 절이 정본이다(§6.4). 증거를 그 입력으로 바꾸는 것은 `evidence.ts` `verifyView`(상태·카운터·예산)·`roundState`·`reviewRoundUsage`다. `check()`·`verify`·hook·`status`·`context`가 같은 함수로 판정한다.

**진입 노드** — 매 호출마다 상태로 다시 계산한다.
- 커서가 review이고 check·test 증거가 유효하면 `review`.
- 커서가 test이고 check가 유효하면 `test.select`. 이 회차의 test 시작 표지가 남아 있으면(끊긴 test) 앞 기록을 판정하지 않고 `test.execute`로 간다.
- 그 밖에는 `requireValidatable('check')`로 커서를 check로 되감는다. 현재 회차의 check 기록이 있고 증거 묶임이 맞으면 `check.assess`, 아니면 `check.execute`.
- `--retry`는 언제나 `check.execute`부터 다시 실행한다. 판정에는 쓰지 않는다 — 같은 코드 재실행은 `--retry`든 `code-agent check` 직접 호출이든 같은 카운터를 쓴다.
- `verify`는 커서가 check·test·review·integrate일 때만 돈다.
- `check.execute`는 회차 판정을 `check()` 한 곳에 맡긴다. `check()`가 한도로 거부하면(`RetryRefused`, class `limit-exceeded`) `decision`이고, 그 밖의 거부(전제 미충족 등)는 사유 그대로 Stop이다.

**상태** (`verifyState`·`roundStateOf`) — 실행마다 `runClass`로 가른다: 통과, 결함(환경이 아닌 failed), 환경(선언 문구·실행 파일 없음·실행 실패·원인 미상 error·플러그인 not-run), 시간 초과, 전제(선언 없는 not-run). 실패 TC는 결함이다. 회차 상태는 `code-defect > precondition > interrupted > environment > result-unconfirmed > passed` 순으로 고른다.
- 회차에 실행·시작 표지가 하나도 없으면 기록 없이 끊긴 회차(`emptyRound`)다.
- test·통합 검증의 시작 표지(`retry.started`)만 남았으면 `interrupted`다.
- 그 회차에 test 기록이 없으면 앞 회차의 마지막 test 상태를 이어받는다 — 실패한 test 뒤 test를 건너뛰고 고쳐도 고쳐 쓰기를 쓴다.
- 같은 회차 재사용(`check()`)이 지운 test·통합 검증의 상태는 `retry.wiped`에 남는다. 지운 test는 그 뒤 test가 돌 때까지 마지막 test 상태이고(다음 회차도 이어받는다), 지운 통합 검증은 그 회차에만 든다. 그 단계가 다시 돌면 끝 저장에서 지운다 — test를 끊거나 환경으로 실패시킨 뒤 `check`로 지우고 고쳐도 고쳐 쓰기를 쓴다.

**판정 `assess`** — `stageProblemEntries`가 게이트 문제마다 종류를 붙인다. stop은 다시 돌려도 남는 것(승인·계획 밖 변경·없는 계획 파일·보존 테스트·동결 뒤 바뀐 테스트·재현 기록), rerun은 다시 돌리면 맞춰지는 것(증거 없음·묶임 네 줄·회차 불일치·⑧ 불일치·integrate의 재현 트리), result는 실행 결과(실패한 실행·확인되지 않은 TC)다.
- 문제가 없으면 `next()`를 부르고 `passed`.
- stop 문제가 있거나 상태가 `precondition`(명령 미선언)이면 노드 없이 Stop이다(`검증 전제가 맞지 않습니다`).
- 실행이 모두 통과했고 rerun 문제만 남았으면(검증 명령이 계획 파일을 고침·⑧·회차) `diagnose`, class `precondition`이다. 재개는 `verify --retry`(check부터 다시)다 — ⑧만 어긋났으면 `--retry` 없는 `verify`는 `check.assess`부터 들어가 ⑧을 다시 렌더하지 않는다. 다시 돈 회차는 통과 뒤 변경이라 고쳐 쓰기를 쓰지 않는다.
- 그 밖은 `verifyNode`가 노드를, `nodeCounter`가 decision의 소진 카운터를 정한다.

| 상태 | 조건 | 노드 | 소진 카운터 |
|---|---|---|---|
| code-defect | 고쳐 쓰기와 총 회차가 남음 | repair | — |
| code-defect | 그 밖 | decision | 고쳐 쓰기 소진이면 fix, 아니면 totalRounds |
| environment·interrupted | 같은 코드 재실행이 남음 | diagnose | — |
| environment·interrupted | 그 밖 | decision | rerun |
| result-unconfirmed | 같은 코드 재실행이 남았거나, (수집 수정이나 고쳐 쓰기가 남았고 총 회차가 남음) | diagnose | — |
| result-unconfirmed | 그 밖 | decision | 고치는 길을 막은 카운터(수집 수정이 남았으면 totalRounds) |

**회차 정책 `check()`** (`nextRoundDecision`) — 실행 전에, 아무것도 쓰기 전에 한 곳에서 판정한다. 거부는 `RetryRefused`(exit 1)다.

| 직전 상태 | 기록 없이 끊김 | 트리 변경 | 결과 | 거부 |
|---|---|---|---|---|
| 증거 없음 | — | — | 새 회차(first) | — |
| 아무것 | 예 | 아니오 | 같은 회차 재사용, 같은 코드 재실행 +1 | 재실행 소진 |
| 아무것 | 예 | 예 | 새 회차(fix) — 끊긴 뒤 고친 것은 고쳐 쓰기다 | 고쳐 쓰기·총 회차 소진 |
| passed | 아니오 | 아니오 | 같은 회차 재사용(카운터 없음) | — |
| passed | 아니오 | 예 | 새 회차(review, 통과 뒤 변경) — 고쳐 쓰기를 쓰지 않는다 | 리뷰 회차·총 회차 소진 |
| code-defect | 아니오 | 아무것 | 새 회차(fix) — 같은 코드의 `--retry`도 고쳐 쓰기다 | 고쳐 쓰기·총 회차 소진 |
| environment·interrupted | 아니오 | 아니오 | 같은 회차 재사용, 재실행 +1 | 재실행 소진 |
| environment·interrupted | 아니오 | 예 | 새 회차(fix) | 고쳐 쓰기·총 회차 소진 |
| result-unconfirmed | 아니오 | 아니오 | 같은 회차 재사용, 재실행 +1 | 재실행 소진 |
| result-unconfirmed | 아니오 | 예 | 수집 수정이 남았으면 새 회차(collect), 아니면 fix | 고쳐 쓰기·총 회차 소진 |
| precondition | 아니오 | 아니오 | 거부 — 선언 없는 명령은 다시 돌려도 같다 | — |
| precondition | 아니오 | 예 | 새 회차(fix) | 고쳐 쓰기·총 회차 소진 |

- 같은 회차 재사용은 그 회차의 check·test·integrate 실행 기록을 모두 비운다 — test도 다시 돈다. 지운 test·통합 검증의 상태는 `retry.wiped`로 남긴다(위 상태). 새 회차는 `rounds+1`과 원인(`retry.causes`)을, 재사용은 재실행 수(`retry.reruns`)를 실행 전에 저장하고 ⑧도 함께 렌더한다.
- fix의 격리 재현 갱신은 다음 회차가 허용된 뒤에만 한다.
- 카운터: 고쳐 쓰기(`fixRounds`, 증거를 처음 만들 때 고정), 수집 수정(fix 작업은 0 — 재현부터 언다), 같은 코드 재실행·통합 검증 재실행(회차당), 리뷰 회차(`review.json`), 총 회차(1+고쳐 쓰기+리뷰+수집). 한도 값은 `LIMITS`와 §6.4 표가 정본이다. 사람이 한도를 늘리는 동의(judgment)는 아직 없다 — 지금은 재계획·재승인·abort다.

**같은 회차 재실행 — test·integrate** (`sameRoundDecision`) — `runTests`는 이 회차의 test 기록이나 시작 표지가 있으면, `integrate`는 이 회차의 통합 검증 기록이나 시작 표지가 있으면 회차를 열지 않고 다시 돈다. 직전이 passed면 그대로, environment·interrupted·result-unconfirmed면 재실행 카운터(통합은 `integrateRerun`)를 쓰고, code-defect·precondition이면 거부한다(같은 코드로 다시 돌리지 않는다).

**환경 분류** (`runSpecs`, `environmentMatch`) — 실패한 실행 출력에 선언 문구(`environmentErrors`)가 있어도, 같은 실행의 결과(콘솔 결과 줄과 새 보고서 파일의 모든 testcase, TC id 유무와 무관)에 실패가 하나라도 있으면 환경이 아니다. 재현(`repro`)만은 문구만으로 환경이다 — 재현에서 환경으로 보는 것은 재현을 인정하지 않는 엄격한 쪽이다. 실행 원인은 `VerifyRun.cause`(timeout·spawn·missing-tool·environment, `CommandResult.timedOut`·`notFound`)로 남는다. 통합 검증의 prepare 실패는 결과(failed)를 그대로 두고 원인만 environment로 단다. 콘솔 출력 속 JUnit XML은 `<?xml` 선언이 있을 때만 읽고, 보고서 탐색이 2만 항목·깊이 12에서 끊기면 실행 기록(`reportScan`)과 출력에 남긴다.

**동결** — kind:test 파일은 결과가 인식된(TC 결과 줄이 있는) 또는 코드 결함으로 실패한 test 실행부터, fix는 재현부터 언다(`testFrozen`). 그때의 파일별 바이트 해시를 증거의 `testFreeze`에 굳히고 test·integrate 게이트가 대조한다(`testFreezeProblems`, stop). 결과 미확인 회차에는 수집 수정 1회 동안 kind:test 파일이 열린다(`collectWindowOpen`, fix는 없다). 새 회차를 열 때 `rebaseTestFreeze`가 수집 수정 회차의 변경 전부와 ⑨ 지적으로 연 파일(`review.json` `used`)만 기준에 받아들이므로 게이트는 `review.json`을 읽지 않는다. ⑨ 지적으로 연 파일은 리뷰 회차마다 한 번만 받아들인다(`testFreeze.rebased[].reviewRound`) — hook은 review 단계의 열린 지적에만 그 파일을 열므로, 같은 리뷰 회차 안에서 check로 되감긴 뒤 다시 바뀐 것은 hook을 거치지 않은 변경이다. `check` 출력은 ⑦ TC id가 계획 파일 어디에도 없으면 `!!` 줄로 미리 알린다(막지 않는다).

**hook 쓰기 차단** (`freezeReason`) — `writeBlockReason`은 고쳐도 다음 회차가 거부될 때만(`nextRoundDecision`의 트리 변경 판정과 같다) 계획 파일 쓰기를 전부 거부하고, 막은 카운터(고쳐 쓰기·리뷰 회차·총 회차)의 문구를 낸다. 그다음 동결을 본다(⑨ 지적·수집 수정 창이 열쇠). `status`의 `다음:` 한도 줄도 증거로 같은 판정을 한다(`verifyLimitHint`).

**시작 표지와 실행 중 보호** — test·통합 검증은 명령을 돌리기 전 저장(⑧ 렌더 포함)에 `retry.started`(phase·round·pid·host·at)를 넣고 끝 저장에서 지운다. 통합 검증은 이 저장을 임시 worktree를 만든 **뒤**에 한다 — 만들지 못해 멈추면 재실행 카운터·표지를 남기지 않는다. 남아 있으면 그 실행은 끊긴 것이다. 표지의 실행이 아직 돌면(같은 PC면 살아 있는 pid, 다른 PC면 나이가 명령 한도×3+10분 안) `check`·`test`는 멈춘다(`requireNotRunning`).

**통합 검증 표지·잔여 worktree** (`claimWorktree`) — 통합 검증과 격리 재현은 카운터를 기록하기 **전에** 체크아웃마다 하나인 `.code-agent/log/worktree.lock`(pid·host·at·id·target·phase·round·worktree)을 원자 생성으로 쥔다. 다른 실행이 돌고 있으면 아무것도 쓰지 않고 멈춘다. 낡은 표지는 회수 가드(`worktree.lock.reclaim`, `lock.ts` `acquireLock`) 안에서 다시 읽어 본 표지 그대로일 때만 회수한다 — 둘이 같은 낡은 표지를 회수해 둘 다 쥐는 경합을 막는다. 그 worktree는 이 체크아웃의 것이고 실제로 남아 있을 때만 지우고 보고한다. 임시 worktree 이름은 `code-agent-integrate-<체크아웃 키 8자>-XXXXXX`이고(`checkoutKey`: 실제 경로의 sha256, Windows는 소문자), 쥔 뒤 `git worktree list`에서 자기 키 접두어의 것만 지운다. 다른 체크아웃의 것과 이전 버전 이름(`code-agent-integrate-XXXXXX`)은 지우지 않고 결과에 보고한다. 표지를 `verify.json`에 두지 않는 이유는 실행 중인 명령의 끝 저장이 표지를 덮기 때문이다.

**재현 시도** (`repro`) — 같은 테스트 트리로 재현하지 못했으면(결과 미확인·전제) 다시 돌리지 않는다. 같은 트리의 환경·중단 재실행과 서로 다른 트리의 시도에 한도가 있다(`reproRerun`·`reproAttempt`). 시도는 실행 전에(격리 재현은 임시 worktree를 만든 뒤에) `retry.repro`에 기록하고, 끝난 원인은 트리별로(`retry.repro.classes`) 남긴다 — 뒤 트리의 시도 기록(`reproAttempt`)이 덮어도 이미 재현하지 못한 트리를 끊긴 시도로 보지 않는다. 재현을 보거나 사람이 로그 근거를 확인하면(`approveLogBasis`) 시도 카운터를 비운다. 격리 재현 갱신이 실패해도 증거의 `treeHash`는 바뀌지 않는다(`carryForRepro`).

**이행** — `retry`가 없는 옛 증거는 `verifyRetryOf`가 추정한다(직전 회차가 모두 통과면 review, 그 밖과 기록 없는 회차 다음은 fix, 총 회차 한 회차 유예). 원래 그 파일을 쓰는 명령이 다음에 저장할 때 기록한다. 옛 규칙보다 엄격해지는 판정은 하나다: 마지막 회차가 실행 기록 없이 끊긴 뒤 코드를 고치면 고쳐 쓰기를 쓴다(옛 규칙은 마지막으로 기록된 실행을 봤다). 진행 중 작업이 여기서 막히면 사람 판단으로 넘긴다. 부분 트리 해시는 파일 바이트로 계산한다 — 유효한 UTF-8 파일은 값이 같고, 바이너리 계획 파일이 있는 진행 중 작업은 검증을 한 번 다시 받는다.

**실행 규칙**
- `runWorkflow`(`core/workflow.ts:22-51`)는 program 노드만 연속 실행하고 agent·human 노드에서 인계를 반환한다. 전이는 32회까지다.
- 이력은 `<target>.verification-flow.json`에 남는다.
- 결과 JSON에 `failure`(class·at·detail·origin·counter)와 `budget`(fix·collect·rerun·integrateRerun·reviewRounds·totalRounds 각각 key·used·limit·left·exhausted)이 붙는다. 텍스트 출력은 `원인:`·`남은 회차:` 줄을 더한다.
- `task`는 원인별 안내다: diagnose는 원인 문구(`guidance`), decision은 한도 문구, repair는 노드 문구에 남은 회차를 붙인다.
- `integrate`의 결과 줄(`remainingNote`)은 환경·시간 초과·결과 미확인에 `integrate` 변형 문구를 쓴다 — 같은 회차는 `code-agent integrate`로 다시 돌고 통합 검증 재실행을 쓴다(`verify --retry`는 check로 되감아 같은 코드 재실행을 쓰고 그 회차 기록을 지운다).
- 재개 명령은 노드별로 다르다: diagnose → `verify --retry`, review → `/ca-review`, decision → `/ca-answer`, 그 밖 → `verify`.
- CLI 종료 코드는 review면 0, 그 밖은 1이다(`cli.ts:253-258`).

### 6.3 리뷰와 교차 검증

**리뷰 회차**
1. `review`(`openRound`, `review.ts`)가 회차를 연다. check·test가 통과해 있어야 하고, 기준·계획·매니페스트가 바뀌었으면 회차를 리셋한다(사람 허용도 함께 버린다). 마지막 회차와 트리가 같으면 새 회차를 거부한다. 리뷰 회차는 3회까지다(`review.json` `limit`, 그 묶임의 첫 회차에 고정, 사람 허용으로 +1). 넘으면 `openRound`가 거부하고(`리뷰 회차 한도 N회를 모두 썼습니다`) `check()`도 리뷰 수정 회차를 거부한다. `limit`이 없는 옛 기록은 이미 3회차 이상이면 한 회차 유예를 받고, 다음 `openRound`가 한도를 고정한다. 리뷰 회차 판정은 `reviewRoundUsageOf` 하나이고, `openRound`는 같은 트리 거부 뒤에 한도를 본다(review.json 저장은 아직 잠금 없이 한다).
2. `ca-reviewer`가 실행되면 hook이 결과를 기록한다(§5).
3. 동결된 테스트 파일은 review 단계에서 마지막 회차가 지금 기준·계획·매니페스트 위에 있고, 그 파일을 가리키는 관찰된(리뷰어 또는 교차 리뷰) "계획 안·열림" 지적이 있을 때 풀린다(`findingOpensFile` `review.ts`). 이 경우 `used` 기록을 남기고, 그 지적 줄은 이후 지울 수 없다(`reviewProblems`). 다른 탈출구는 계획 재승인이다 — `planHash`가 바뀌면 증거가 통째로 무효라 동결도 풀린다(`hook.ts` `freezeReason`). 결과 미확인 회차의 수집 수정 1회 동안은 kind:test 파일이 열린다(fix 는 재현부터 얼어 있어 없다). 동결 뒤 바뀐 파일은 test·integrate 게이트가 증거(`testFreeze`)로 다시 대조한다. ⑨ 지적으로 연 파일(리뷰 회차마다 한 번)과 수집 수정 회차의 파일은 다음 check 가 새 회차를 열 때 기준을 갱신하므로 게이트는 `review.json`을 읽지 않는다.

**교차 검증 (both 설치 전용, `crossRequired` = `hosts.json`에 호스트 2개, `review.ts:167-169`)**

| 지점 | 명령 | 전제 | 실행 | 기록 | 게이트 |
|---|---|---|---|---|---|
| 계획 | `planning cross --by <호스트>` (`crossCheck.ts:178-240`) | `crossRequired`, plan 단계, critic 결과가 completed이고 current | `handoff/cross-critic.md`를 쓰고 다른 호스트의 `ca-critic`을 실행 | `planning.json`의 `cross`(잠금 안), 질문은 같은 잠금 안에서 `questions.md`에 — `[Requirements]`에는 결과 원소에서 뽑은 요구 키만(없으면 critic 요구), `[Origin]: <critic 작업>`과 `questionOrigins` 기록(답은 critic만 낡게 한다). 질문 본문은 담당 결과와 같은 구조 필드 검사를 받는다 | `crossCriticProblems`: 현재 critic `dispatchId`와 일치하고 completed이며 차단 지적 0, 또는 unavailable |
| 리뷰 | `review cross --by <호스트>` (116-165) | `crossRequired`, `requireValidatable('review')`, 열린 회차가 있고 그 회차의 트리·계획·매니페스트가 지금과 일치 | 다른 호스트의 `ca-reviewer` | `review.json`의 `last.cross`, ⑨ `## 교차 지적`(X 번호) | `reviewProblems` 413-421: completed이면서 문서가 기록과 같거나, unavailable |

**다른 호스트 실행** (`runOtherHost` 60-95)
- Claude: `claude -p <prompt> --agent <역할> --model <modelOf: models.json 값, 없으면 opus> --output-format json --setting-sources project --permission-prompts none --allowedTools Read,Grep,Glob`
- Codex: `codex exec -s read-only -C <root> --ephemeral -m <model> -c model_reasoning_effort="<r>" -o <tmp> "<developer_instructions>\n\n---\n\n<prompt>"`
- 시간 제한은 기본 20분이다(`CODE_AGENT_CROSS_TIMEOUT_MIN`).
- 실행 파일 위치는 `hostCommand`(`hosts.ts:29-47`)가 이 순서로 찾는다: `CODE_AGENT_*_BIN` → Windows `%APPDATA%\npm\node_modules`의 Node 진입점 → PATH. Windows에서 PATH로 찾은 `.cmd`·`.bat`는 거부한다(`core/build.ts:305-307`).

**실패 처리**
- 실행 불가(파일 없음·오류·0 아닌 종료·`is_error`·결과 없음)는 `HostUnavailable`로 중지를 기록하고 게이트를 통과시킨다.
- 결과 형식 오류는 `Stop`이고 다시 실행해야 한다(155-159, 212-216).

### 6.4 실패 원인과 재시도 규약 (`retryPolicy.ts`)

실패 원인별 재시도 규약의 원천은 `retryPolicy.ts`(순수 모듈 — `fs`·`zod`·`child_process`·`path`를 import하지 않는다)다. 실패가 나면 원인을 하나로 분류하고, 재시도를 할지·몇 번 할지·고쳐 쓰기 회차를 쓸지·누구에게 넘길지를 그 원인이 정한다. 원인 판정은 코드가 하고, 모델은 결과의 `failure.class`·안내 문구·`budget`을 읽고 따른다. CLI는 스스로 다시 실행하지 않는다. 예외는 같은 호출 안의 죽은 잠금 회수(`lock.ts`)와, Claude 담당에게 hook이 한 번 되돌리는 것(`stop_hook_active`)뿐이다.

**연결 상태** — 계획 쪽(§6.1 배정·관찰, §5.1 planning-event, §5.2 Codex 담당 이벤트)은 이 표에 연결됐다: `planningDispatchDecision`·`orphanState`·`subagentExit`·`lockDecision`(`lock.ts` `acquireLock`)·`guidance`를 쓴다. 계획 쪽의 사람 허용 기록 함수(`grantPlanningRetry`)는 있지만 이를 부르는 동의(`judgment`)는 아직 없다 — 그래서 표의 "+N/사람" 증분은 계획 쪽에서도 아직 쓸 수 없다. 검증 판정 지점(§6.2: `check`·`test`·`integrate`·`repro`·`verify`·hook 쓰기 차단·`status`·`context`)과 리뷰 회차 한도(§6.3 `openRound`)도 이 규약에 연결됐다. 그 밖의 판정 지점(§4 동의, §5 그 밖의 hook 실패 코드, §6.3 교차)은 아직 연결되지 않았다. 각 지점의 현재 동작은 그 절이 정본이다. 지점을 연결하는 커밋이 그 절을 이 표에 맞춰 고친다.

아래 표는 `renderRetryPolicyTable()`이 `POLICIES`에서 렌더한 생성 블록이다. 손으로 고치지 말고 `POLICIES`를 고친 뒤 다시 렌더해 붙인다 — `src/test/docSync.test.ts`가 바이트를 대조한다(줄바꿈 CRLF·LF 차이만 무시). 표의 숫자는 `LIMITS`·`GRANT_STEP`·`TIMING`에서 렌더된다(`code-defect`의 fixRounds 기본값은 매니페스트 스키마의 값이고 `retryPolicy.test.ts`가 대조한다). 대조는 렌더되는 값에만 걸린다 — 표에 나오지 않는 값(`TIMING.crossTimeoutMin`, 표에 없는 `GRANT_STEP`)은 docSync가 잡지 못하므로 이 절의 산문에는 숫자를 쓰지 않는다. 렌더되지 않는 정책 필드 `onExhausted`·`consumesFixRound`는 `retryPolicy.test.ts`가 넘으면·고쳐 쓰기 회차 칸과 맞는지 본다. 보조 원인 둘(`precondition`·`hook-failure`)은 분류 밖으로 새는 Stop과 hook 예외를 담는다.

<!-- generated:retry-policy -->
| 원인 | 판별 | 재시도 | 한도 | 고쳐 쓰기 회차 | 넘으면 |
|---|---|---|---|---|---|
| `code-defect` 코드 결함 | 환경이 아닌 failed 실행·failed TC(환경 문구보다 우선), 계획 안 리뷰 지적 | 계획 안에서 고친 뒤 `verify`. 같은 코드의 `--retry`도 고쳐 쓰기 회차를 쓴다 | 고쳐 쓰기 ≤ fixRounds(기본 2), 리뷰 회차 ≤ 3, 총 회차 ≤ 1+고쳐 쓰기+리뷰+수집 | 씀(통과 뒤 변경은 리뷰 회차) | decision |
| `environment` 환경 | 선언 문구가 있고 그 실행에 실패 TC 없음(재현은 실패 결과가 있어도 문구만으로), 실행 파일 없음·실행 실패, prepare 실패 | 환경을 확인받은 뒤 `verify --retry`(같은 회차). 통합 검증은 `integrate`, 재현은 `repro` | 같은 코드 재실행 ≤ 2/회차, 통합 재실행 ≤ 2/회차, 재현 재실행 ≤ 2/테스트 트리 | 같은 코드면 안 씀, 고치면 씀 | decision |
| `interrupted` 중단·시간 초과 | 명령 제한 시간 초과, 실행 기록 없는 회차, 시작 표지만 남은 test·통합 검증 | 셸 명령의 제한 시간을 길게 주거나 백그라운드로 같은 명령, 같은 회차 | 같은 코드 재실행 ≤ 2/회차, 통합 재실행 ≤ 2/회차 | 같은 코드면 안 씀, 끊긴 뒤 고치면 씀 | decision |
| `result-unconfirmed` 결과 미확인 | 실패 없이 ⑦ TC 가 unknown·skipped·not-run, 재현 못함 | 수집(TC 이름·보고 형식)을 고친 뒤 `verify`, 보고 위치만 고쳤으면 `verify --retry` | 수집 수정 1(fix 작업 0), 재현 시도 3 | 수집 수정 1회는 안 씀, 그 뒤 씀 | decision, 재현은 repro-log 동의 |
| `precondition` 전제·선언 미충족(보조) | 명령 미선언(not-run), 단계·순서·승인·계획 밖 변경 등 전제 Stop | 없음 — 전제를 채운 뒤 한 번 | — | 안 씀 | Stop(사유 그대로) |
| `agent-format-error` 담당 출력 형식 오류 | 결과 JSON·스키마 위반, 리뷰 결과가 지적 표·`- 없음`이 아님 | Claude 는 같은 담당에게 1회 되돌림, 그다음(Codex 는 바로) 형식만 교정 1회. 리뷰어는 같은 회차 재호출 | 되돌림 1, 교정 1, 리뷰어 호출 2/회차 | 안 씀 | 같은 입력 규칙, 리뷰어는 decision |
| `agent-content-error` 담당 결과 내용 오류 | 근거·출력 집합·질문 범위·결정적 문서 검사 실패 | Claude 되돌림 1, 그다음 실패 기록 → 수정 피드백을 입력에 넣어 재배정 | 되돌림 1, 같은 입력 실패 3, 작업 총 배정 6 | 안 씀 | 총 배정 상한 → 사람 판단 |
| `dispatch-orphan` 배정 식별 불일치·고아 실행 | 식별 불일치·특정 불가·출처 검증 실패, 연결 담당이 끝났는데 running, 시작 미관찰 10분·시작 관찰 60분 | Claude 식별 되돌림 1. 확실한 고아는 advance 가 자동 재배정, 의심 고아는 `planning cancel` 뒤 advance | 같은 입력 실패에 안 셈, 작업 총 배정에 셈 | 안 씀 | 총 배정 상한 → 사람 판단 |
| `same-input-repeat` 같은 입력 반복 실패 | 같은 작업·같은 inputHash 로 failed 3 | 입력을 보완한 뒤 `planning dispatch`로 명시할 때만 | 같은 입력 실패 3(+1/사람) | 안 씀 | 질문·사람 판단 |
| `reassign-total` 입력 변경 재배정 총 상한 | 작업별 배정 수(이행 시각 이후, 취소·고아 포함) | 없음 — 자동 재배정을 멈춘다 | 작업 총 배정 6(+3/사람) | 안 씀 | 사람 판단(judgment) |
| `cross-unavailable` 교차 호스트 실행 불가 | 오류 채널의 미설치·인증·한도·네트워크·장애 문구, 실행 파일 없음 | 없음 — 중지 기록 후 진행. 사람이 아닌 중지 지점은 지점 한도 안에서 다시 실행할 수 있다 | 지점 시도 3 | 안 씀 | 진행 |
| `cross-config-error` 교차 호출 설정 오류 | 알 수 없는 옵션·모델 없음·강도 오류, 화이트리스트 밖 비정상 종료, JSON 아님 | 설정을 고친 뒤 같은 명령 1회 | 설정 오류 재실행 1, 지점 시도 3 | 안 씀 | decision(게이트 막힘) |
| `cross-timeout` 교차 시간 초과 | ETIMEDOUT(제한 시간), 끝 기록 없이 끊긴 실행 | 제한 시간이면 백그라운드 1회 | 시간 초과 1, 지점 3 | 안 씀 | 두 번째 제한 시간은 중지 기록 후 진행, 끊긴 실행은 지점 한도 뒤 decision |
| `cross-result-invalid` 교차 결과 형식 오류 | 지적 표·JSON 아님, 표 규칙·근거 범위 위반(F→X 정규화 뒤) | 같은 명령으로 원문의 형식만 교정 1회 | 형식 교정 1, 지점 시도 3 | 안 씀 | decision(게이트 막힘) |
| `host-sandbox-denied` Codex 샌드박스 제한 | 샌드박스 표지(사전 판정), EPERM·EACCES·거부 문구, 샌드박스 안 네트워크 오류 | 권한 상승을 요청해 같은 명령 | — | 안 씀 | 사람(judgment cross-stop) |
| `blocking-finding` 차단 지적 | 열린 F·X 지적, critic·교차 critic 의 blocking 지적 | 재실행으로 지우지 못한다 — 계획 안은 고친 뒤 새 회차, 계획 밖은 질문·재계획 | 리뷰 회차 3 | 안 씀(리뷰 회차를 쓴다) | 사람 기각(judgment waive-finding) |
| `limit-exceeded` 상한 초과 | 사람 허용을 더한 한도를 다 쓴 카운터의 재시도 | 없음 — 자동 재시도 금지 | 카운터별 | — | 사람 판단(judgment retry-grant)·재계획·abort |
| `consent-target-changed` 동의 대상 변경·취소 | 준비·응답·적용 직전의 스냅샷 불일치, 승인이 아닌 응답 | 같은 동의를 다시 묻지 않는다 — 새로 준비 | — | — | 사람 |
| `consent-apply-failed` 동의 적용 중단·실패 | applying 잔존, 앞선 확인 뒤 확인 화면 불일치, 도메인 함수 실패 | 같은 동의로 다시 적용하지 않는다 — 상태 확인 뒤 새로 준비 | 0 | — | 사람 |
| `lock-stale` 잠금 고착 | 같은 PC 의 죽은 pid, 주인 기록 없는 10분 잠금 | 같은 호출에서 회수. 살아 있으면 대기(2초·hook 10초) 뒤 같은 명령 1회 | 대기 재실행 1 | — | 다른 PC·판정 불가면 사람 |
| `hook-failure` hook 판정 실패(보조) | hook 판정 함수 예외, hook 모듈 로드 실패 | 같은 호출을 반복하지 않는다. 종료 코드는 이벤트별(hookFailureExit·subagentExit) | 담당 되돌림 1 | — | 사람(doctor 점검) |
<!-- /generated:retry-policy -->

| 판정 | 함수 (`retryPolicy.ts`) |
|---|---|
| 검증 회차 | `runCauseOf`·`runClass`·`verifyState`·`roundStateOf`·`verifyRetryOf`(옛 증거는 `deriveLegacyCauses`)·`verifyBudget`·`nextRoundDecision`·`sameRoundDecision`·`verifyNode`·`nodeCounter`·`writeBlockReason`·`budgetText`·`environmentMatch` |
| 계획 배정 | `planningDispatchDecision`(같은 입력 실패·작업 총 배정)·`orphanState`(시작 미관찰·시작 관찰 기한)·`subagentExit` |
| 교차 실행 | `crossFailureText`(오류 채널만 — Codex 세션 출력은 끝에서 이어진 `ERROR:` 줄만)·`classifyCrossFailure`·`crossPreflight`·`crossPointState`·`crossBudgets`(지점·원인별 예산)·`crossPointDecision`·`crossPointHint`·`consecutiveCrossStops` |
| 잠금·hook | `lockDecision`(`lock.ts` `acquireLock`이 쓴다 — 회수는 `<잠금>.reclaim` 가드를 잡은 프로세스 하나만, 해제는 자기 기록일 때만)·`hookFailureExit`(입력은 `hookFailureInput`으로만 만든다) |
| 한도·허용·안내 | `limitOf`·`budgetOf`·`grantScope`·`grantFor`·`guidance`(`GUIDE_KEYS`·`GUIDE_VARIANTS`, 기록된 실패는 `recordedVariant`로 변형을 고른다)·`limitExceededText`·`COUNTER_LABEL`(카운터 이름표의 단일 원천)·`retrySummary`(측정 전용) |

**카운터** — 규약상 고쳐 쓰기·수집 수정·같은 코드 재실행·통합 재실행·재현 카운터는 `verify.json` `retry`, 리뷰 회차·리뷰어 호출·교차 지점 시도는 `review.json`, 같은 입력·작업 총 배정·교차 critic 시도는 `planning.json` `retry`·`attempts`에 둔다. 범위는 각 파일의 묶임(기준 커밋·계획·매니페스트)이고, 묶임이 바뀌면 카운터와 사람 허용이 함께 버려진다. 옛 기록은 읽을 때 추정하고(`deriveLegacyCauses`, 리뷰 회차 유예 1회) 쓸 때 기록한다. 추정 카운터는 옛 규칙보다 엄격해지지 않는다. 엄격해지는 판정은 하나다: 마지막 회차가 실행 기록 없이 끊긴 뒤 코드를 고치면 새 규칙은 고쳐 쓰기를 쓴다(옛 규칙은 마지막으로 기록된 실행을 봤다) — 진행 중 작업이 여기서 막히면 `judgment retry-grant`로 넘긴다. 카운터의 사용 수는 이미 쓴 시도·재실행 수이고 사용 수가 한도에 닿으면 소진이다(`Budget`). 교차 설정 오류·제한 시간 초과 재실행은 첫 실패 뒤부터 센다(`crossBudgets`). 사람 허용의 범위 문자열은 `grantScope` 하나가 만든다(검증 `""`·`round:<r>`·`tree:<해시>`, 리뷰 `""`·`round:<n>`, 계획 `planning:<작업>`·`planning:<작업>:<입력 해시>`·`critic:<배정>`).

**사람 판단** — 상한에 닿으면 자동 재시도를 멈추고 사람에게 넘긴다. 규약상 사람은 동의 `judgment`로 고른다: `retry-grant`(카운터별 증분, `GRANT_STEP`), `waive-finding`(지적 기각), `cross-stop`(막힌 교차 지점을 중지로 기록). 재계획·재승인·abort는 그대로 있다. 소진되지 않은 카운터에는 허용을 기록하지 않는다(`grantFor`).

**hook 종료 코드** — 규약상 판정 실패: PreToolUse는 막는다(Claude exit 2, Codex deny). Stop·SessionStart는 막지 않는다. 동의 질문·동의 응답은 막고, 업무 질문·사용자 메시지는 막지 않는다(`hookFailureExit`, 알 수 없으면 막는 쪽). SubagentStop은 `subagentExit`: Claude는 기록 전의 되돌릴 수 있는 실패(형식·내용·식별)를 `stop_hook_active`가 아닐 때 한 번 exit 2로 같은 담당에게 돌려보내고, 그 밖은 기록 후 0을 낸다. Codex는 되돌리지 않고 기록 후 0을 낸다.

**교차 검증** — 규약상 "실행할 수 없음"은 화이트리스트(미설치·인증·한도·네트워크·장애, 그리고 두 번째 제한 시간 초과 — 끊긴 실행은 제외)뿐이다. 이때만 중지로 기록하고 게이트가 통과한다. 패턴은 `crossFailureText`가 고른 오류 채널에만 댄다(전사·사용량 숫자·Codex 배너·되풀이된 프롬프트 제외). 설정 오류·분류되지 않은 종료·형식 오류·샌드박스 거부는 게이트를 막는다. completed 지점은 다시 실행하지 않고, 중지가 completed를 덮지 않는다. 사람이 아닌 중지 지점은 지점 한도 안에서 다시 실행할 수 있다(게이트를 강하게만 한다).

## 7. Claude와 Codex 차이

| 설치 | `hosts.json` | 교차 검증 |
|---|---|---|
| `--host claude` | `["claude"]` | 요구하지 않는다(`crossCriticProblems`·`reviewProblems`가 건너뛴다) |
| `--host codex` | `["codex"]` | 요구하지 않는다 |
| `--host both`, 또는 기존 설치에 다른 호스트 추가 | `claude`·`codex` 둘 다(순서는 이전 기록이 먼저) | `planning cross`·`review cross`를 요구한다. 실행할 수 없으면 중지로 기록하고 통과한다 |

`init`은 `hosts.json`에 이전 기록과 이번 호스트의 합집합을 쓴다(`init.ts:163-167`). 이전 기록이 없으면 Claude PreToolUse hook이 있는지로 이전 호스트를 판정한다. 그래서 Claude 프로젝트에 `--host codex`를 더하면 both가 된다(`hosts.json`이 있을 때와 지운 뒤 모두 sandbox 확인). 반대로 both 설치에 `init --host claude`를 다시 실행해도 `hosts.json`은 둘 다로 남는다(sandbox 확인). 호스트를 줄이려면 `hosts.json`을 사람이 고친다(`doc/codex.md:74`).

두 호스트를 같은 작업에 동시에 쓰지 않는다는 규칙은 문서에만 있다(`doc/codex.md:55`). 동의는 첫 응답 관찰(Pre) 때 채널·세션·작업 경로에 묶이므로(`consent.ts:382-395`), 응답을 받기 시작한 뒤 호스트를 바꾸면 동의를 다시 준비해야 한다.

| 항목 | Claude | Codex | 근거 |
|---|---|---|---|
| 설치 위치 | `.claude/skills`·`.claude/agents/*.md`·`.claude/settings.json`·`CLAUDE.md` | `.agents/skills`·`.codex/agents/*.toml`·`.codex/hooks.json`·`AGENTS.md` | `hosts.ts:83-105`, `init.ts:180-203` |
| 스킬 본문 | 번들 원본 | `codexText` 정규식 변환. `ca-answer`만 `template/codex/ca-answer.md`로 바꾼다 | `hosts.ts:64-90` |
| 서브에이전트 이름 | `ca-analyst` | `ca_analyst`(배정의 `hostAgents.codex`) | `hosts.ts:11`, `planning.ts:291` |
| 모델 기본값 | 모두 opus, 변경값은 `.code-agent/models.json` | `gpt-6.1-sol`. analyst·critic·reviewer는 high, 나머지는 medium. 변경값은 `.code-agent/codex-models.json` | `models.ts:25`, `modelPolicy.ts:16-25` |
| 파일 읽기 | Read·Grep·Glob(키 자리만 막음) | 셸의 `code-agent read <파일> [시작] [줄 수]` | `hook.ts:205-208`, `hosts.ts:81` |
| 파일 쓰기 판정 | Write·Edit·MultiEdit·NotebookEdit | `apply_patch`의 각 경로를 `Edit`로 판정 | `codexHook.ts:71-78` |
| 계획 담당 출력 | staging 파일 + `{path, staged}`. `agent_id`로 담당에게만 연다 | artifacts `{path, content}`. staging은 열리지 않는다 | `hook.ts:428-442`, `hosts.ts:78-80` |
| 담당 결과 수신 | `SubagentHandback` 또는 `last_assistant_message`(되돌린 뒤에는 그때까지 판정한 보고 뒤의 것만) | `last_assistant_message`만 | `planningHook.ts:29-50`, `codexHook.ts:87` |
| 동의 응답 | AskUserQuestion Pre·PostToolUse (`claude-question`) | 사용자 메시지 + UserPromptSubmit (`codex-prompt`) | §4.2 |
| 세션 시작 상태 주입 | SessionStart `session-event` — 실행 중으로 기록된 계획 배정과(시작·재개·비우기면) 취소 명령을 붙인다 | 미등록 — 시작이 관찰되지 않은 배정은 advance의 `stale` 판정(10분)에 기댄다. 시작이 관찰된 담당은 60분 동안 `wait`이므로, 재개 절차(`ca-next` 1항)가 `planning status`의 실행 중 배정을 확인해 이 대화에서 부른 담당이 아니면 cancel한다 | `init.ts:233`, `init.ts:187`, `sessionHook.ts:28-49`, `template/claude/skills/ca-next/SKILL.md:31` |
| 서브에이전트 hook 실패 코드 | 계획 담당: `subagentExit` — 기록 전의 되돌릴 수 있는 실패를 한 번 2로 되돌리고, 기록된 실패·`stop_hook_active`면 0. 리뷰어: `subagentExitCode`(기록된 실패·`stop_hook_active`면 0, 그 밖 2) | 담당 이벤트의 예외는 언제나 `{}`·exit 0(기록 후, 되돌리지 않는다) | `planningHook.ts:358-366`, `reviewHook.ts:31-33`, `codexHook.ts:117-122` |
| 토큰 사용량 집계 | `usage` 지원 | 미지원 | `doc/codex.md:78` |
| 교차 검증 대상일 때 실행 형태 | `claude -p … --agent` | `codex exec -s read-only …` | `crossCheck.ts:68-79` |

## 8. 상태·산출물 파일 지도

`.code-agent/`는 코드만 쓴다. 모델의 도구 쓰기는 모드와 관계없이 hook이 막는다(`stateGuard` `hook.ts:337-345`). 세션이 없을 때는 셸 명령의 `.code-agent` 경로 언급도 막고(276-283), 세션·작업 중에는 셸 허용 목록(§5.4)이 쓰기 명령을 막는다.

| 경로 | 쓰는 곳 | 읽는 곳 | git |
|---|---|---|---|
| `active.json` | `saveActive`(`layout.ts:144-150`): start·next·back·check 되감기. 삭제는 deliver·abort | 모든 명령·hook | 무시(`init.ts:191-192`) |
| `request-session.json` · `docs-session.json` | `request begin` · `docs begin/end` | hook 모드 판정, start | 무시 |
| `hosts.json` · `version` | init | `selectedHosts`, update·doctor | 준비 커밋(`bootstrap.ts:45-46`). `version`은 반영 커밋에도 들어간다(`deliver.ts:321`) |
| `models.json` · `codex-models.json` | 동의 `model` | `modelOf`·`codexModelOf` | 준비·반영 커밋 |
| `approvals/<slug>.jsonl` | `recordDecision`(계획 승인·반려 해시 사슬) | `checkApproval`(`core/approval.ts:342-387`) | 반영 커밋 |
| `approvals/<slug>/request.jsonl` · `<target>-<seq>.plan.json` | `recordRequestDecision` · 승인 스냅샷(`core/approval.ts:438`) | `requestState` · `stale-plan` diff | 반영 커밋 |
| `approvals/docs.jsonl` | `confirmDoc` | 문서 게이트 | 반영 커밋 |
| `consents/<uuid>.json` · `apply.lock` | consent prepare·hook·apply | consent | 무시 |
| `work/<ID>/<target>.plan.json` | `plan submit` | `loadWork` | 반영 커밋 |
| `work/<ID>/<target>.planning.json` (+`.lock`) | planning 명령·planning hook·`planning cross`. `.lock`에는 주인 `{pid, host, at, nonce}`가 있고 같은 PC의 죽은 주인·오래된 빈 잠금은 다음 실행이 회수한다(§6.1). `retry`(이행 시각 `since`·사람 허용 `grants`·자동 되감기 `rewinds`), 코드가 쓴 질문의 출처 `questionOrigins`(질문 ID → 작업 ID), 시도의 `failure`(출처 확인 실패는 `kind: source`)·`inputParts`·`orphaned` 상태, 담당의 `returns`·`judgedHandbacks`·`failure`·`endedAt`은 새로 기록할 때만 붙는다 | 계획 게이트, `approvalDocsHash`(`work.ts:49-56` — 작업별 마지막 시도만 묶고 `agents`·`retry`는 밖이다) | 반영 커밋 |
| `work/<ID>/<target>.verify.json` (원인별 재시도 카운터 `retry`·테스트 동결 기준 `testFreeze` 포함 — `retry.started` 는 test·integrate 실행 중에만, `retry.wiped` 는 같은 회차 재사용 뒤 그 단계가 다시 돌 때까지만 있다) | repro·check·test·integrate | `stageProblems`, `verifyView`(check()·hook·status·context) | 반영 커밋 |
| `work/<ID>/<target>.verification-flow.json` | verify | verify 재개 | 반영 커밋 |
| `work/<ID>/<target>.review.json` | review·review-event·review cross | `reviewProblems`, 동결 해제 | 반영 커밋 |
| `work/<ID>/handoff/` (`<dispatchId>.md`, `context.md`, `cross-critic.md`) | planning advance·dispatch·repair·context --file·planning cross | 서브에이전트 | 폴더 안 `.gitignore *`(`handoff.ts:22-28`)가 있지만, 반영은 `git add -f`로 `work/<ID>`를 폴더째 추가하므로(`deliver.ts:318,348`) handoff 파일도 커밋된다. `git add -f -- <폴더>`가 안쪽 `.gitignore *`를 무시하는 것은 2026-10-07 sandbox git 실험으로 확인했다. `handoff.ts:21`의 주석("`.gitignore`로 뺀다")과 다르다 |
| `log/stages.jsonl`, `log/`(검증 로그) | `logStage`, `runSpecs` | `usage`(집계 전용, 판정에는 쓰지 않음) | 무시 |
| `log/worktree.lock` (+`.reclaim` 회수 가드) | integrate·격리 repro(`claimWorktree`) — 실행하는 동안만 있다. 가드는 낡은 표지를 회수하는 순간만 있다 | 같은 체크아웃의 다른 integrate·격리 repro 가 실행 중이면 멈춘다. 주인 pid 가 죽었거나 낡으면 다음 실행이 회수한다 | 무시 |
| OS 임시 폴더 `code-agent-integrate-<체크아웃 키>-*` (저장소 밖) | integrate·격리 repro(`claimWorktree`·`inCleanWorktree`) — 같은 호출이 끝나면 지운다 | 끊기면 같은 체크아웃의 다음 integrate·격리 repro 가 `git worktree list` 에서 자기 키 접두어만 찾아 지운다. 다른 체크아웃·이전 버전 이름은 보고만 한다 | 저장소 밖 |

| `doc/work/<ID>/` 파일 | 작성 주체 | 비고 |
|---|---|---|
| `request.json`, `consent-action.json` | 메인 | 접수 초안, 동의 동작 |
| `requirement.md` | `request submit` 렌더 | 모델 쓰기 거부 |
| `questions.md` | start 생성. 메인·planning hook·`planning cross`가 추가한다. 코드가 쓰는 질문에는 `[Origin]: <작업 ID>`가 `[Answer]:` 앞에 붙는다 | 미응답이 있으면 `next`·Stop이 막는다. 코드가 출처를 기록한(`planning.json` `questionOrigins`) 질문은 그 작업과 후손만 낡게 한다 — 메인이 적은 `[Origin]`은 무시된다(§6.1) |
| `01`·`02`·`03`·`04`·`07`, `plan.json` | 관찰된 계획 담당(hook이 기록) | 메인 쓰기 거부(`hook.ts:474`). 승인 묶음(`stale-docs`) |
| `05-plan.md` · `08-validation.md` | plan submit · check/test/integrate 렌더 | 모델 쓰기 거부 |
| `09-review.md` | 회차 구역은 review, `## 지적`은 review-event, `## 교차 지적`은 review cross | 게이트가 기록과 대조한다. 회차 구역은 문자열 일치, 지적 절은 `normalizeFindings` 정규화 뒤 비교(`review.ts:152-161,409`) |
| `10-pr.md` | `요약`·`확인 방법`·`위험·되돌리기` 3절은 메인(`deliver.ts:47`), trace 블록은 deliver | 위조는 deliver가 다시 렌더 |
| `knowledge.proposal.md` | 메인(선택) | deliver 동의에서 항목별로 고른다 |
| `.staging/<dispatchId>/` | Claude 계획 담당 | 완료하면 hook이 지운다(`planningHook.ts:301`). 실패·교정 대기·되돌림 중인 배정의 것은 남는다(`planning.ts:29-30`). 폴더 안 `.gitignore *`(`planning.ts:32-36`)가 있지만 반영의 `git add -f`가 `doc/work/<ID>`를 폴더째 추가하므로(`deliver.ts:326,348`) 남은 staging도 커밋된다(handoff와 같은 git 동작) |

공통 문서의 기본 경로는 POLICY가 `doc/architecture.md`·`conventions.md`·`test-strategy.md`·`quality.md`, KNOWLEDGE가 `doc/knowledge/data-dictionary.md`·`api-catalog.md`·`business-rules.md`다(`schemas.ts` defaultPath 44·126·179·236·292·317·342). 매니페스트로 다른 경로를 연결할 수 있다(`docs link`). KNOWLEDGE는 deliver 동의에서 고른 항목만 코드가 키 단위로 바꾸거나 추가한다(`deliver.ts:262-275`, `knowledge.ts:120-127`). 작업 커서가 있는 동안 모델은 작업 폴더와 승인된 계획 파일 밖을 쓸 수 없으므로(§3.2 hook의 쓰기 범위), 계획 파일로 잡히지 않은 공통 문서에 작업 결과가 넘어가는 길은 이 선택 반영뿐이다. 삭제는 `knowledge prune` 동의로만 한다.

## 9. 코드 모듈 지도

| 단계·기능 | 파일 (`src/agent/` 기준) |
|---|---|
| CLI 진입·hook 하위 명령 분기 | `cli.ts`(hook 168-178, 명령 182-396) |
| 설치·갱신·점검 | `init.ts`, `hosts.ts`, `assets.ts`, `update.ts`, `sourceUpdate.ts`, `doctor.ts`, `models.ts`, `modelPolicy.ts` |
| 준비·공통 문서 | `docsCommands.ts`, `docs.ts`, `schemas.ts`, `setup.ts`, `bootstrap.ts`, `survey.ts` |
| 접수 | `request.ts`, `intakeTrace.ts` |
| 커서·게이트·context | `commands.ts`, `work.ts`, `layout.ts`, `git.ts`, `tree.ts` |
| 작업 문서 검사 | `workDocs.ts`, `sourceTrace.ts`, `questions.ts`, `planningValidation.ts`, `stagedChecks.ts`(완료 hook의 게이트 검사) |
| 계획 오케스트레이션 | `planning.ts`, `planningState.ts`, `planningHook.ts`, `handoff.ts`, `lock.ts`(공통), `retryPolicy.ts`(공통) |
| 계획 형식·승인 원장·경계 | `core/plan.ts`, `core/approval.ts`, `core/gate.ts`, `core/manifest.ts`, `core/workOrder.ts` |
| 검증 | `validate.ts`(`check`·`runTests`·`integrate`·`repro`, `claimWorktree`·`checkoutKey`), `evidence.ts`(`verifyView`·`stageProblemEntries`·`reviewRoundUsageOf`), `retryPolicy.ts`(검증 판정), `lock.ts`(`pidAlive`), `testResults.ts`, `testReports.ts`, `tree.ts`(`partialTreeHash`·`fileHashes`), `core/build.ts` |
| 검증 노드 | `verificationFlow.ts`, `core/workflow.ts` |
| 리뷰·교차 검증 | `review.ts`, `reviewHook.ts`, `crossCheck.ts`, `blocks.ts` |
| 반영·지식 | `deliver.ts`, `knowledge.ts`, `knowledgeCommands.ts` |
| 동의 | `consent.ts`, `tty.ts` |
| hook | `hook.ts`, `stopHook.ts`, `sessionHook.ts`, `codexHook.ts` |
| 재시도 규약·공통 기반 (§6.4, 계획 쪽과 검증·리뷰 회차 한도에 연결됨) | `retryPolicy.ts`(원인·카운터·한도·판정·안내 문구 — 순수 모듈), `lock.ts`(공통 파일 잠금 `acquireLock`(회수 가드·자기 기록 해제)·`pidAlive`), `crossEnv.ts`(실행 환경 표지 `runtimeHost`·`crossChild` — 순수 모듈), `hostText.ts`(호스트별 표기 `skill`·`agentName`·`askVia` 등) |
| 기타 | `aidlc.ts`(AI-DLC 공존), `usage.ts`·`prices.ts`(사용량), `plugins/`, `read.ts`(`code-agent read`), `stop.ts`(`Stop` 예외), `core/exemplar.ts`(참조 코드), `core/atomic.ts`(`writeAtomic`), `core/types.ts`(공통 타입) |
| 절차 템플릿 | `template/claude/skills/ca-*/SKILL.md`(+`criteria.md`·`legacy.md`·`contract.md`·`reference.md`), `template/claude/agents/ca-*.md`, `template/CLAUDE.block.md`, `template/CODEX.block.md`, `template/codex/ca-answer.md` |

단계 스킬은 `ca-next/SKILL.md:14-25` 표를 따른다. 서브에이전트 사용처는 다음과 같다.
- `ca-surveyor`: adopt·docs
- `ca-writer`: adopt·docs·synthesis
- `ca-analyst`·`ca-explorer`·`ca-critic`: 계획
- `ca-implementer`: implement·check 수정
- `ca-tester`: implement 테스트 단계·test
- `ca-reviewer`: review

## 10. 변경 이력

| 날짜 | 변경 | 기준 커밋 | 대상 섹션 |
|---|---|---|---|
| 2026-10-07 | 최초 작성. 코드 판독과 sandbox(`init --host both` 설치, `hook`·`codex-event`·`stop`·`session-event` 이벤트 주입, git 실험)로 확인했고, 별도 검증자가 진술 24곳을 코드에 맞춰 고쳤다 | `c4f3fbf` | 전체 |
| 2026-10-07 | 실패 원인별 재시도 규약 공통 모듈(`retryPolicy.ts`·`lock.ts`·`crossEnv.ts`·`hostText.ts`)과 §6.4 생성 블록(`docSync.test.ts`가 대조). 판정 지점에는 아직 연결하지 않아 §4·§5·§6.1~§6.3의 현재 동작은 그대로다 | `2327975` | §1.1, §6.4, §9 |
| 2026-10-07 | 공통 모듈 검토 반영: 잠금 회수 직렬화(`.reclaim` 가드)·자기 기록 해제·읽기 실패와 Windows EPERM 처리, 교차 실패 분류 범위(Codex 세션은 끝의 `ERROR:` 줄만·stdout 은 마지막 응답·Claude stderr 도 오류 줄만), 교차 예산 `crossBudgets`(설정 오류·시간 초과는 첫 실패 뒤부터), 담당 형식·내용 오류의 기본 문구를 되돌림으로(기록은 `record` 변형), 끊긴 교차 실행 안내 변형, 결과 미확인 노드의 재실행 조건. 판정 지점 연결 전이라 §4·§5·§6.1~§6.3은 그대로다 | `3b5e867` | §6.4, §9 |
| 2026-10-07 | 계획 오케스트레이션을 재시도 규약에 연결: 공통 잠금(`acquireLock` — 주인 기록·죽은 주인·오래된 빈 잠금 회수), 같은 입력 실패·작업별 총 배정 한도(`planningDispatchDecision`, `retry.since`·사람 허용 `grantPlanningRetry`), 고아 판정(`orphanState` — 확실한 고아 자동 재배정, 의심 고아 `stale`·`cancel`, 동시 한도보다 먼저), 완료 hook 재구성(잠금 밖 준비·Claude 한 번 되돌림 `subagentExit`·식별 불일치와 출처 실패의 고아 기록·실행 중 입력 변경은 `cancelled`·Codex 담당 이벤트 언제나 0), 완료 hook의 결정적 문서 검사(`stagedChecks.ts`), 질문 출처(`[Origin]` — 출처 작업과 후손만 낡게, 교차 질문은 요구 키만), 질문 본문 구조 필드 검사(파서와 같은 줄 경계·공백), 입력 해시 부품(`inputParts`)·낡은 이유·명령 1회 범위 메모(해시 계약 유지), 앞 단계가 낡았을 때 `rewind-required`(같은 사유에 한 번 자동), 차단 지적 `feedback`(근거 문서 작업만), SessionStart 실행 중 배정 요약, 업무 규칙 KNOWLEDGE 입력 연결, 후보 순위 절단 제거·순회 순서 | `fa70f74` | 머리말, §1.1, §3.2, §3.3, §4.2, §5.1, §5.2, §6.1, §6.3, §6.4 연결 상태, §7, §8, §9 |
| 2026-10-07 | 계획 오케스트레이션 독립 검토 반영: 크기 한도를 넘은 결과는 교정 대기 대신 `failed`, 보고한 시도가 이미 running이 아니면 늦은 결과(담당 연결을 보고한 시도로 옮긴다), 다른 미완료 담당이 연결된 시도는 고아로 두지 않음(`orphanLinked`), 출처 확인 실패가 두 번 이어지면 `blocked`(`hook-failure`), 재배정의 `previous`(직전 실패), 되돌린 뒤에는 그때까지 판정한 SubagentHandback 뒤의 보고만(`judgedHandbacks`), 질문 출처는 코드가 기록한 것(`questionOrigins`)만 믿음(교차 질문은 잠금 안에서 쓴다), `reassign-total` 안내에서 지금 실행할 수 없는 선택지를 뺌, ca-plan 4-1항·반려 절차·`crossCriticProblems`의 고칠 작업 문장, ca-next 재개 때 실행 중 배정 확인 | `110ec6a` | 머리말, §1.1, §6.1, §6.3, §6.4 연결 상태, §7, §8 |
| 2026-10-07 | 검증 재시도를 원인별 카운터로 나누고(고쳐 쓰기·수집 수정·같은 코드 재실행·통합 검증 재실행·리뷰 회차·총 회차) `check()`·`verify`·hook·`status` 가 한 판정 함수로 통일. 통과 뒤 변경은 고쳐 쓰기가 아니라 리뷰 회차·총 회차가 묶는다. 환경 분류는 실패 결과가 없을 때만(재현은 문구만으로), 시간 초과는 원인 필드로, 동결은 결과가 인식된 실행부터(수집 수정 1회 예외)·증거(`testFreeze`)로 게이트 대조, test·통합 검증 시작 표지(끊고 고치면 고쳐 쓰기), 체크아웃별 worktree 표지와 자기 키 잔여 worktree 정리, 파일 바이트 해시, 실패한 재현 갱신이 `treeHash` 를 바꾸지 않음, 재현 시도 한도. 옛 증거에서 엄격해지는 판정은 '끊긴 회차 뒤 수정'(고쳐 쓰기를 쓴다) 하나다. §6.2 는 함수 이름 기준으로 다시 썼다 | `e3e082d` | §1.1, §3.2, §6.2, §6.3, §6.4 연결 상태, §8, §9 |
| 2026-10-07 | 검증 재시도 검토 반영: 통합 검증 결과 줄의 재개 안내를 `code-agent integrate`·통합 검증 재실행 하나로(`GUIDE_VARIANTS` `integrate` 변형), test 실행 전 저장도 ⑧ 을 렌더하고 대조 불일치 진단의 재개는 `verify --retry`, 같은 회차 재사용이 지운 test·통합 검증 상태(`retry.wiped`)를 판정에 남김, 통합 검증·격리 재현은 임시 worktree 를 만든 뒤 카운터·표지 기록, 재현 트리별 원인(`retry.repro.classes`)과 로그 근거 확인의 시도 카운터 비움, ⑨ 지적 재기준은 리뷰 회차마다 한 번, 낡은 worktree 표지 회수 가드와 없는 worktree 미보고, ⑧·⑩ 회차 줄을 `검증 회차 · 고쳐 쓰기 사용/한도`로(옛 증거는 그대로), §6.4 환경 판별에 재현 예외 | `53368a4` | §6.2, §6.3, §6.4 생성 블록, §8 |
