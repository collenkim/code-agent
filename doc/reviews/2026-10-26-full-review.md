# 전면 재검토 — 보안 울타리·복구 불가·템플릿 흐름·정리 대상 (작업 지시)

검토 날짜: 2026-10-26. 기준 커밋: `a5f9206`. 구현 커밋: 1-1 `c572537`, 1-2 `a6a1dec`, 1-3·1-4 `c5a35fd`, 1-5·1-6 `d1ccd98`, 1-7 `1323371`, 2-1 `32afa67`, 2-2 `0a18b7f`, 2-3 `5bbd6b8`, 2-4 `ff90e72`, 2-5 `851f65d`, 2-7 `81e177d`, 2-8 `c17ce68`, 2-9(⑥ 제외) `cf060c1`, 1단계 검증 보정 `5f0c837`. 이후 항목은 완료 때 연결한다.

이 문서는 읽기 전용 검토 결과를 **순차 작업 지시**로 정리한 것이다. 검토는 영역 9개(hook·CLI/런타임·동의/대시보드·계획/LangGraph·검증/리뷰/교차·master·템플릿·위생·정리)를 병렬로 보고, 상위 지적은 코드와 실제 PowerShell 5.1 에서 재확인했다. 줄 번호는 기준 커밋에서 실제로 연 줄이다 — 작업 전에 다시 열어 맞춘다. `추정` 표시는 코드 읽기로만 판단한 것이라 수정 전에 재현부터 한다.

## 0. 진행 규칙

- **순서는 1단계 → 2단계 → 3단계 → 4단계**다. 같은 단계 안에서는 번호 순이되, 서로 독립이라 바꿔도 된다. 한 항목(또는 한 묶음)마다 커밋 하나.
- 모든 커밋은 AGENTS.md 「바꿀 때 지킨다」를 따른다 — 같은 커밋에서 `doc/process-flow.md` §1.1 대응표의 해당 절을 고치고 §10 에 한 줄(요지 한 문장 + 커밋), 시험을 함께 고친다. 항목마다 「함께 맞출 것」에 그 자리를 적어 두었다.
- `template/claude/**` 를 고치면 Codex 사본 변환(`src/agent/hosts.ts` `codexText`)·`templateText`·`templateBudget` 시험이 걸린다. 예산을 넘기면 `node scripts/template-sizes.cjs --suggest` 로 다시 잡고 근거를 이 문서 「검증」에 적는다.
- 승인·증거·작업 기록의 **형식**이 바뀌는 항목(1-7)은 `STATE_SCHEMA` 를 올린다.
- 단계가 끝날 때마다 `npm test` 전체를 돌리고 결과(통과·생략·실패 수)를 이 문서 「검증」에 적는다. 기준: 1741건 중 1737 통과·4 생략·0 실패.
- 이 저장소 루트에 `init` 을 실행하지 않는다. 대상 프로젝트 동작은 임시 git 저장소에서 `node dist/agent/cli.js` 로 확인한다.
- 「결정 필요」 항목은 사람의 결정을 받기 전에는 고치지 않고 질문만 올린다.

## 1단계 — 높음: 보안 울타리

### 1-1. PowerShell 스마트 따옴표로 메타문자 검사 우회

- 문제: `src/agent/hook.ts:85-94` `powershellMeta` 는 ASCII `'`·`"` 만 따옴표로 본다. PowerShell 5.1 은 U+2018~U+201B 를 작은따옴표, U+201C~U+201E 를 큰따옴표로도 받는다(`Write-Output ‘x’` 가 `x` 를 출력하는 것을 확인). `git status ‘"’ (Remove-Item src)` 는 검사기에는 큰따옴표 안으로 보여 통과하고 PowerShell 은 괄호를 평가한다. `codexHook.ts:158` 의 `shell: "powershell"` 과 Claude `PowerShell` 도구 모두 해당. `consentTicket.ts:62` `splitCommandArgs` 도 같은 꼴.
- 수정: 검사 전에 U+2018~U+201B → `'`, U+201C~U+201E → `"` 로 접거나, 작은따옴표 밖의 비ASCII 따옴표 문자를 바로 meta 로 거부한다(보수적인 쪽 권장). 접을 때 스마트 ↔ ASCII 가 서로의 짝으로 닫히지 않게 한다.
- 함께 맞출 것: §5.3 4항(셸 명령 검사) 문구. 시험 `gate.test.ts`·`hookPaths.test.ts` 에 스마트 따옴표 사례(Bash·PowerShell·Codex 경로) 추가.

### 1-2. 동의 스냅샷 해시 캐시 오염

- 문제: `src/agent/snapshotCache.ts:15-44` 의 캐시 파일 `.code-agent/consents/snapshot-cache.json` 은 저장소 안에 서명 없이 있다. 저장소 안 스크립트(`node scripts/x.js`, package.json `scripts`)가 새 stat 값과 **옛** sha 를 써 넣으면 `consent.ts:365` `discardIfChanged` 가 캐시 적중으로 바뀐 파일을 보지 못한다. hook 은 `.code-agent` 경로를 가리키는 것만 막고 파일 내용은 보지 않는다(`hook.ts:648-649` 머리말이 인정).
- 수정(택1, 첫째 권장): ① 적용(`applyLocked`·`consent finish`)의 재대조는 캐시 없이 전수 해시한다 — 준비 때만 캐시. ② 캐시 항목을 키 자리(`~/.code-agent/`)의 비밀로 HMAC 한다. ③ 캐시를 저장소 밖(`storeDir`)으로 옮긴다.
- 함께 맞출 것: §4.1·§4.2 스냅샷 문장, `snapshotCache.ts` 머리말, 시험 `consentSnapshot.test.ts`(캐시가 틀린 값을 가져도 적용이 변경을 잡는 사례).

### 1-3. 경로 인자 없는 MCP 셸 도구가 판정을 받지 않음

- 문제: `src/agent/hook.ts:345-358` `decideMcp` 는 `mcpPaths`(`:317-343`)가 빈 도구를 그대로 허용한다. `mcp__jetbrains__execute_terminal_command`·`mcp__serena__execute_shell_command` 류는 `command`/`script` 인자만 있어 plan·deliver 단계의 쓰기 금지와 작업 모드 Bash 허용 목록을 통째로 비껴간다. §5.3 0단계가 한계로 적어 둔 자리.
- 수정: 인자 키가 `command`·`cmd`·`script`·`args` 류이고 문자열이면 그 값을 `decideBash`(작업·세션·triage 모드)로 넘긴다. 모드가 있을 때 판정할 수 없는 꼴은 거부.
- 함께 맞출 것: §5.3 0단계 문장. 시험 `gate.test.ts`.

### 1-4. 하위 에이전트가 진행 명령·동의 준비/적용을 실행할 수 있음

- 문제: `src/agent/hook.ts:493-506` `readOnlyRoleGuard` 는 `ca-critic`·`ca-reviewer`·`ca-surveyor` 만 본다. `agent_id` 가 있는 Bash 가 `leaseGated` 진행 명령(`next`·`back`·`start`·`plan submit`·`planning advance|dispatch|cancel`)을 부르는 것을 막는 곳이 없고, Codex 하위 에이전트는 모두 셸을 가진다(`codexHook.ts:155-158`). `:461-468` 동의 티켓 발급은 `interaction` 티켓(`:455`)과 달리 `!input.agent_id` 조건이 없다. `takeover` 가 `LEASE_FREE`(`:155`)라 읽기 전용 담당도 임대를 풀 수 있다.
- 수정: `agent_id` 가 있는 Bash 는 `leaseGated` 명령과 `consent prepare|apply|finish`·`takeover` 를 거부하고, 담당이 꼭 필요로 하는 것만 역할별로 연다(예: `ca-tester` 의 `code-agent test` 가 의도라면 그것만). 티켓 발급에 `!input.agent_id`. `readOnlyRoleGuard` 의 Bash 분기에 `takeover` 추가.
- 함께 맞출 것: §5.3 판정 순서, §5.4 명령 표(하위 에이전트 칸), `template/claude/agents/*.md` 에서 담당이 부르는 명령 안내가 있으면 맞춘다. 시험 `gate.test.ts`·`hookPaths.test.ts`.

### 1-5. 비테스트 파일 출력만으로 TC 가 passed 로 인식

- 문제: `src/agent/evidence.ts:907-917` `testCaseEvidence` 는 출력에 결과 행이 있으면 테스트 파일 대조를 건너뛴다. 구현 단계(얼지 않는) 파일이 `console.log("ok 1 - TC-7")` 또는 `{"type":"code-agent-test","id":"TC-7","status":"passed"}` 한 줄을 찍으면 TC-7 테스트 없이 통과한다. `tcPrecheck`(`:589-595`)도 id 가 계획 파일 어디에든 있으면 경고하지 않는다.
- 수정: `kind: test` 단계가 선언된 작업은 출력에서 인식된 TC 도 `tcToken` 이 kind:test 파일(refactor 는 기존 테스트)에 있을 때만 passed 로 받고, 없으면 `unknown — 출력에만 있음` 으로 두고 안내한다.
- 함께 맞출 것: §6.2 TC 인식 문장, `ca-test/tc-names.md`(인식 조건 한 줄). 시험 `verification-stages.test.ts`.

### 1-6. 검증 중 기록 보호 대상에 승인 원장이 없음

- 문제: `src/agent/validate.ts:262-265` `guardedStateFiles` 는 review·planning 기록만 대조한다. 검증 명령은 hook 밖에서 돌아 테스트 코드가 `.code-agent/approvals/<slug>.jsonl`(`core/approval.ts:32`)에 줄을 덧붙일 수 있고, 그러면 `carry()`(`validate.ts:195-205`)가 증거를 새로 시작해 회차 카운터가 리셋된다. `추정` — 재현 뒤 수정.
- 수정: 해당 작업 `<slug>.jsonl` 과 `docs.jsonl` 을 `guardedStateFiles` 에 더한다(같은 바이트 대조라 비용 없음).
- 함께 맞출 것: §6.2 「기록 보호」 문장, `doc/design.md` 한계 절. 시험 `verification-stages.test.ts`.

### 1-7. 승인 해시가 질문 답을 묶지 않음 (+ 관찰 판정이 질문 본문을 결속하지 않음)

- 문제 A: `src/agent/workDocs.ts:27` `HASHED_KINDS` 에 `questions.md` 가 없다(`work.ts:48-75`). 작업 폴더는 어느 스테이지에서든 쓸 수 있고(`hook.ts:977-980`), `[Source]: 대화` 답은 내용 검증 없이 통과(`answers.ts:262`)하므로 승인 뒤 답을 바꿔도 승인·코드 쓰기 허용이 유지된다.
- 문제 B: `src/agent/answers.ts:174-178` `observedMatch` 는 Q 번호와 답 글자만 보고 ask 행의 `questionHash`(`:125,131,147` 에 기록되나 미사용)를 현재 질문과 대조하지 않는다. 사람이 답한 뒤 질문 본문을 바꿔도 `observed` 다.
- 수정: A — `approvalDocsState` parts 에 답이 달린 질문의 고정 투영(질문 해시 + 답)을 넣는다. 승인 해시 형식이 바뀌므로 `STATE_SCHEMA` 를 올린다. B — `observedMatch` 가 ask 행의 `questionHash` 와 현재 질문 제목·본문 해시를 함께 대조하고, `ca-answer` 가 질문 도구 본문에 `questions.md` 제목을 그대로 싣게 한다.
- 함께 맞출 것: §3.3(승인 무효 조건)·§4.1·§4.3 판정 문장, `doc/design.md` 승인 절, `ca-answer/SKILL.md` 와 `template/codex/ca-answer.md`(둘은 따로 맞춘다). 시험 `approval.test.ts`·`answers.test.ts`.

## 2단계 — 중: 복구 불가·교착·정합성

### 2-1. 고정 릴리스가 저장소에 없을 때의 교착과 고정 소실 (3건 묶음)

- 문제 ①: `src/agent/runtimeSelect.ts:196-199` 는 `applied` 릴리스가 저장소에 없고 진행 중인 일이 없으면 번들(`self`)로 돈다. `runtimeGate.ts:107-111` `atNextWork` 는 그 릴리스를 쓸 수 없으면 다시 실행하지 않고 그대로 작업을 연다 → 그 뒤 모든 PreToolUse hook 이 `unavailable` → exit 2. `update --bundled` 는 「진행 중인 일」Stop(`runtimeApply.ts:256`), `abort` 는 `RECOVERY`(`cli.ts:31`)에 없어 exit 1. 사람이 `runtime.json` 을 지워야 풀린다.
- 문제 ②: `runtimeApply.ts:249` `templates-only` 의 `target = own?.id` 가 번들에서 `undefined` → `:265` `writeRuntime` 이 `applied`·`home` 을 빼고 써 고정이 조용히 풀린다. doctor 가 여러 ✗ 에 `update --templates-only` 를 처방한다.
- 문제 ③: `runtimeApply.ts:99-103` `writeRuntime` 은 `applied`·`pending` 이 둘 다 없으면 파일을 지워 `stateSchema` 기록이 사라진다 → `update --bundled` 뒤 낮은 세대 릴리스 적용 차단(`:250-251`)이 무력화.
- 수정: ① `atNextWork`(또는 `selectRuntime` 의 `self` 물러섬)에서 `applied` 가 있는데 쓸 수 없으면 「여는 명령」을 거부하고 `update --bundled`/재설치를 안내하고, `abort` 를 `RECOVERY` 에 넣는다. ② `templates-only` 는 `state.applied` 를 보존하고, 지금 코드가 그 릴리스가 아니면 반영하지 않고 재설치를 안내한다. ③ `stateSchema` 가 있으면 `applied` 가 없어도 `runtime.json` 을 남긴다.
- 함께 맞출 것: §7·§8 `runtime.json` 설명, `doc/install.md`·`doc/usage.md` 복구 안내, doctor 처방 문구. 시험 `runtimeRelease.test.ts`(릴리스 삭제 뒤 접수, bundled → 낮은 세대 release 거부).

### 2-2. 깨진 상태 파일 하나가 전체를 멈춤 (hook 경로 우선)

- 문제: `src/agent/hook.ts:520` `executionMode(root)` 호출이 `:554` 의 try 밖이라 `execution.json` 오타(`executionMode.ts:14-15` Stop)가 Read 까지 exit 2 로 막고 사람이 원인을 읽을 수도 없다. `hook.ts:351` `loadTriage` 도 같다. `interactionSources.ts:159-162` 는 `consents/*.json` 을 기록 단위 try 없이 `loadConsent` 하고 `samePath` 의 `realpathSync.native` 가 옮긴 경로에서 던져 대시보드 조회·동기화·버전 적용이 전부 끝난다. `hosts.ts:26` `JSON.parse` 가 깨지면 doctor 자체가 죽는다. `runtimeSelect.ts:112-118` 은 `home` 형식을 검사하지 않아 복구 명령도 죽는다. 전체적으로 `JSON.parse` 145곳 중 47곳이 try·스키마 없이 상태 파일을 읽는다.
- 수정: ① hook 경로 — `managedExecution ?? executionMode`·`loadTriage` 를 try 로 감싸 실패하면 `decideUnreadable`(읽기·status 만 열고 사유 안내)로 보낸다. ② 디렉터리 순회의 `loadConsent` 는 기록 단위 try/catch 로 건너뛰고 사유만 남긴다(`consentState.rebuild` 와 같은 태도). ③ `selectedHosts`·`readRuntime(home·pending.id)` 는 Stop 문구로. ④ 나머지는 `readJson(path, schema)` 공용 헬퍼로 모아 단계적으로 교체(별 커밋 가능).
- 함께 맞출 것: §5.3 「읽지 못한 상태」 문장, §8 파일 지도의 손상 시 동작. 시험 `gate.test.ts`·`dashboardInteractions.test.ts`·`assets-doctor-usage.test.ts`.

### 2-3. PID 만 보는 잠금과 잠금 밖 owner 갱신 (master·그래프)

- 문제 ①: `src/agent/retryPolicy.ts:1354-1360` `lockDecision` 은 같은 PC·pid 생존이면 무조건 `wait`. `master/runs.ts:34-42` 실행 잠금과 `graph/runtime.ts:107-109` `run.lock`(`waitMs:0, ageReclaim:false`)이 비정상 종료 뒤 PID 재사용으로 영구 busy 가 된다 — `submit` 전부 `busy`, `master disable` 거부, `cancel force` 무효, 모든 그래프 명령 Stop. `lock.ts:49-52` `pidAlive` 는 EPERM 도 살아 있음으로 본다. `추정`(재현: 잠금 파일에 살아 있는 무관한 pid 를 적어 둔다).
- 문제 ②: `master/control.ts:445-449` 읽기 요청의 `touchOwner`(`:506-510`)가 `CONTROL_LOCK` 밖에서 owner.json 을 읽고-고쳐-쓴다. 같은 시각의 `handover`(`handover.ts:28,65,77`)가 바꾼 `handover` 필드·`generation` 을 낡은 값으로 덮을 수 있다.
- 문제 ③: `lock.ts:196-198` `OWNER_WRITE_GRACE_MS` 유예가 `waitMs:0` 에는 적용되지 않아 주인이 기록을 쓰기 전 빈 파일을 본 쪽이 「주인 불명 — 지우세요」로 멈춘다(병렬 Bash 호출에서 발생).
- 수정: ① 잠금 기록에 프로세스 시작 시각(또는 `argv[1]` 지문)을 더해 `pidAlive` 뒤 동일성을 대조하고, master 실행 잠금은 `supervisor.marker` 명령줄 대조(`processes.ts` `liveness`)를 쓴다. ② `touchOwner` 를 짧은 대기의 `CONTROL_LOCK` 안에서 하거나 `lastSeenAt` 을 별도 파일로. ③ 유예는 deadline 과 무관하게 최소 `OWNER_WRITE_GRACE_MS` 적용.
- 함께 맞출 것: §6.4 잠금 문단, `doc/master-control.md` 소유·잠금 절, `doc/langgraph.md` 잠금 설명. 시험 `lock.test.ts`·`master.test.ts`·`graphRuntime.test.ts`.

### 2-4. `init` 재실행이 사람이 고친 사본을 경고 없이 덮어씀

- 문제: `src/agent/init.ts:285-291`(Codex)·`:371-375`(Claude)는 `preserve` 없이 `writeIfChanged` 로 모두 쓰고 `templates.json` 도 갱신하지 않는다. `update()`(`update.ts:135,188-193`)·버전 적용(`runtimeApply.ts:172-182`)은 보존하는데 init 만 없다. doctor 가 hook 누락 등 여러 ✗ 에 `code-agent init` 을 처방(`doctor.ts:249,254,344,358,370`).
- 수정: 설치 기록(`version`·`hosts.json`)이 있는 폴더의 init 은 `applyTemplates` 의 보존 판정을 거치게 하거나, doctor 처방을 hook 만 다시 쓰는 경로로 바꾼다.
- 함께 맞출 것: §7 설치 문단, `doc/install.md`, doctor 처방 문구. 시험 `assets-doctor-usage.test.ts`.

### 2-5. 사람의 실제 답이 기록되지 않는 Post 경로 (+ 같은 질문 재질문 차단)

- 문제 ①: `src/agent/consent.ts:1091-1094` 는 `observeNativeQuestion` 이 던지면 `block()` 으로 반환해 `observeAnswerEvent` 에 닿지 않는다. Post 에서 영속 처리가 실패하는 경우(`interactionNative.ts:335` 문맥 변경·만료, `interactionSchema.ts:351` 2000자 초과, 대시보드 선답)는 사람이 이미 답한 뒤라 `answers.jsonl` 에 답이 없어 `unverified` 로 남는다.
- 문제 ②(`추정`): `interactionNative.ts:310-316,362-366` 는 같은 세션·같은 문맥에서 글자가 같은 질문의 두 번째 호출을 「이미 받은 답이 있습니다」로 막아 범용 확인 질문의 다른 결정이 옛 답으로 채워진다.
- 수정: ① `observeAnswerEvent` 를 먼저(또는 `finally`) 실행하고 Post 의 영속 처리 실패는 경고로만 남긴다(Pre 의 사전 답 거부는 유지). ② 같은 key 재사용은 `pending/deferred` 에만 적용하고 이미 `applied` 면 새 요청을 만들거나 Q 번호 없는 질문은 차단하지 않는다.
- 함께 맞출 것: §4.2·§4.3, `doc/dashboard-interactions.md` 호스트 질문 절. 시험 `answers.test.ts`·`interactionRouting.test.ts`.

### 2-6. `.codex/config.toml` 관리 블록의 PC 별 절대 경로 — 결정 필요

- 문제: `src/agent/choiceConfig.ts:26-30` 은 `command = process.execPath`·진입점 cli.js 절대 경로·프로젝트 절대 경로를 쓰고, `bootstrap.ts:54` 는 그 파일을 준비 커밋에 담는다. 팀원 B 의 PC 에는 그 경로가 없어 선택 UI 가 뜨지 않는데 doctor(`choiceConfig.ts:35-41`)는 블록 존재만 보고 ✓. B 가 `update --templates-only --host codex` 로 고치면 `requirePreparedBranch`(`bootstrap.ts:88-93`)가 새 준비 커밋을 요구해 A·B 사이에서 커밋이 왕복한다.
- 선택지: (가) 관리 블록을 PC 별 파일로 보고 `.gitignore`·준비 커밋 대상에서 뺀다. (나) PATH 의 `code-agent` 와 상대 `--root` 로 등록하고 doctor 가 경로 존재를 검사한다. 설계 결정(「선택 UI 관리 블록이 있는 설정은 도입 대상」)과 충돌하므로 **사람 결정 뒤** 진행.
- 함께 맞출 것: §7, `doc/codex.md`, `doc/install.md`. 시험 `codex.test.ts`.

### 2-7. master 연동 정합성 (묶음)

- ① `master/control.ts:316-320`·`master/runs.ts:146-153` — `pause`/`cancel` 의 `waitMs`(최대 5분)를 `CONTROL_LOCK` 안에서 기다려 감독의 `codex.poll()`(`supervisor.ts:220`) → `forwardCodexPermission`(`codexPermissions.ts:119`, 잠금 10초)이 `busy` → `failCodex`(`supervisor.ts:226-229`)로 호스트가 강제 종료·`failed`. `추정`. 수정: 대기를 잠금 밖으로 빼거나 poll 의 잠금 실패를 「다음 주기 재시도」로.
- ② `master/control.ts:118` hello 가 Codex 를 `approvalPolicy: "never"` 로 알린다 — 실제 `supervisor.ts:48` 은 `on-request`. 수정: `"on-request"` 로 고치고 docSync 성격의 시험에 넣는다. `doc/master-control.md:243` 도.
- ③ `master/supervisor.ts:76-85`·`master/codexPermissions.ts:64-65,30` — 현재 폴더 가림 차단(PATH 정리·`shadowingExecutable`)이 `win32` 만. 비Windows 에서 PATH 에 `.`·`./bin`·`node_modules/.bin` 이 있으면 저장소 안 실행 파일로 승인 명령이 바뀐다. `추정`. 수정: PATH 상대·저장소 안 항목 제거와 루트 가림 검사(`code-agent`·`bash`·`sh`)를 플랫폼 무관하게.
- ④ `master/handover.ts:20,95`·`master/admin.ts:140` — `binding.controllers[to]` 가 `constructor`·`toString` 에 truthy. `Object.hasOwn` 으로.
- ⑤ `master/store.ts:203` commandId 파일 이름 `:`→`_` 치환 충돌(`inv:1` = `inv_1`). 해시 이름 또는 기록 안 `commandId` 재대조.
- ⑥ `master/store.ts:259-265` append 와 `events-meta.json` 쓰기 사이에 끊기면 seq 중복. meta 읽을 때 꼬리 seq 와 비교해 큰 쪽.
- ⑦ `master/store.ts:262,270` `events.jsonl` 무한 성장·전체 읽기. 순번 기준 보존 상한. `master-control.md:137` 의 `hasMore` 는 코드에 없다 — 더하거나 문서에서 지운다.
- ⑧ `codexTransport.ts:323-333` → `mutateInteractions`(`interactions.ts:46-56`)가 바뀜과 무관하게 매 주기 state.json 을 다시 쓴다. 변화 없으면 쓰지 않는다.
- ⑨ `master/admin.ts:149-150` 「저장소 전체」glob 검사가 `*.*`·`**/*.ts` 를 통과시킨다. 디렉토리 접두어가 있는 glob 만 받거나 `master-control.md:191` 문구를 좁힌다.
- 함께 맞출 것: `doc/master-control.md`(§11 포함), §9 master 행. 시험 `master*.test.ts`·`codexPermissions.test.ts`.

### 2-8. 검증·교차·반영 견고성 (묶음)

- ① `evidence.ts:584-586` `collectWindowOpen`·`validate.ts:871-886` `rebaseTestFreeze` — 결과 미확인의 수집 수정 창이 얼린 테스트 전부를 열고 새 회차 기준도 전부 받는다. `추정`. 수정: collect 갱신을 TC 토큰이 든 줄만 바뀐 diff 로 제한하거나, `defect` 로 얼린 뒤에는 `collectLimit` 0.
- ② `crossCheck.ts:84-91,500-517` — 교차 리뷰 프롬프트(계획 파일 목록·직전 X 표 전체)를 argv 한 개로 넘긴다. Windows 32,767자 한계에서 spawn 실패가 `cross-config-error(unclassified)` 로 오분류. 수정: `crossCritic`(`:730-731`)처럼 handoff 파일에 쓰고 한 줄만 넘긴다.
- ③ `crossCheck.ts:239-240` `spawnSync … timeout` 은 node 래퍼만 끝낸다(네이티브 codex 는 자식). `core/build.ts:19-26` `killTree` 방식으로 트리째 종료.
- ④ `validate.ts:1173,241-244` 통합 표지가 같은 PC·pid 생존이어도 나이(`runStaleMs`=한도×3+10분)로 회수되어 실행 중 worktree 를 지울 수 있다. 같은 PC 에서 pid 가 살아 있으면 나이와 무관하게 멈춘다. §6.2 「표지와 실행 중 보호」문장을 코드에 맞춘다.
- ⑤ `testResults.ts:197-198` 글리프에 Jest 실패 `✕`(U+2715)·생략 `○` 추가. `ca-test/tc-names.md` 러너 표와 맞춘다.
- ⑥ `deliver.ts:712-716` — `selectKnowledge` 뒤 `deliverImpact`·`writeConsentReceipts` 가 던지면 적용된 KNOWLEDGE 가 커밋 없이 남는다. try 로 묶어 `restoreKnowledge`.
- ⑦ `knowledge.ts:104,158-166,175-182` — 항목 경계가 백틱 없는 `###` 에서 끊기고 새 항목이 파일 끝(`## 변경 이력` 아래)에 붙는다. 백틱 키 `###` 만 경계로, 새 항목은 `## <종류>` 절 뒤에.
- ⑧ `validate.ts:893-895` `check()` 의 실행 중 검사가 묶인 증거만 본다 — `loadEvidence` 로 표지를 먼저 본다.
- ⑨ `sensitiveText.ts:346-357` 누락 패턴: `glpat-`·`AIza`·`sk_live_`/`rk_live_`·`npm_`·`xapp-`·`AccountKey=`·`SharedAccessSignature`·`passphrase`.
- ⑩ `testReports.ts:295-323`·`validate.ts:309-311` — spec 마다 저장소 전체를 두 번 걷고 매치 파일을 전부 해시. 앞 spec 의 after 를 다음 before 로 재사용하고 mtime/size 가 바뀐 파일만 해시(성능, 선택).
- 함께 맞출 것: §6.2·§6.3, `doc/design.md` 한계. 시험 `verification-stages.test.ts`·`crossReview.test.ts`·`integrate-deliver.test.ts`·`knowledgeDocs.test.ts`.

### 2-9. 계획·LangGraph 견고성 (묶음)

- ① `graph/lifecycle.ts:246-252` `planDraft` 조건이 plan 단계의 사람 판정(미결 질문·요구 미확정·AI-DLC·발견)을 `ca-plan` 인계로 바꿔 무인 러너가 반복한다. `추정`. 수정: `planDraft` 를 제거하거나 `view.resume.next.action === "plan-consent"` 일 때만.
- ② `graph/lifecycle.ts:266` `approved` 노드가 `advancePhase` 의 Stop 을 잡지 않아 러너 계약에 없는 `failed` 로 끝난다. Stop 을 `handoff("decision","human",…)` 로.
- ③ `dependencyContracts.ts:395-408` — 호출마다 계약 수 × 3회 git 자식 프로세스. `work.ts:60-61`·`planningState.ts:298,371,406`·`hook.ts:1016`(Write/Edit 마다) 이 부른다. 명령 1회 범위에서 (계약 파일 stat·원본 stat) 키로 메모.
- ④ `graph/transition.ts:353-354,374` — 모르는 스테이지에서 Stop 대신 LangGraph 라우팅 예외. `advancePhase` 진입에서 `PHASES.includes` 를 먼저 보고 `requirePhase` 와 같은 Stop. `추정`.
- ⑤ `cliMain.ts:362` — `consent apply|finish` 가 그래프 `run.lock`(`waitMs:0`)을 지나 통합 검증 중 동의 적용이 즉시 거부. `consentLock` 만 쓰거나 짧은 `waitMs`.
- ⑥ `planning.ts:485-492` — 자동 되감기 허용 소비 시점이 `back` 실행이 아니라 판정 표시 시점. `추정`·설계 확인 뒤.
- ⑦ `consent.ts:768-776` `enterImplement`·`commands.ts:762-773` `advancePassedIntegrate` 가 `next()` 를 직접 불러 「기록 직전 재검사」없이 전진 — `advancePhase` 로 바꾸거나 `doc/langgraph.md` 에 예외로.
- 함께 맞출 것: §6.0·§6.1, `doc/langgraph.md`, `doc/planning.md`. 시험 `graphLifecycle.test.ts`·`planning*.test.ts`·`dependencyContracts.test.ts`.

### 2-10. 설치·갱신 견고성 (묶음)

- ① `core/atomic.ts:51-52` `writeAtomic` 의 rename 재시도 없음(`releaseStore.ts:114-123` `renameDir` 는 20회 재시도). `runtimeApply.ts:260-265` 에서 템플릿 반영 뒤 `writeRuntime` 실패 시 반쪽 상태. `writeRuntime` 을 `applyTemplates` 의 스냅샷·복원 범위 안에 넣거나 `writeAtomic` 에 같은 재시도.
- ② `core/atomic.ts:29-38` `writeIfChanged` 는 truncate 뒤 쓰기 — 호스트가 감시하는 `.claude/settings.json`(`init.ts:207`)이 반쪽으로 읽힐 수 있다. 쓰기만 `writeAtomic` 으로.
- ③ `init.ts:279` Codex Windows hook 명령이 PowerShell 큰따옴표 문자열이라 경로의 `$`·백틱이 확장된다. 작은따옴표(`'`→`''`)로.
- ④ `hook.ts:479`·`runtimeGate.ts:53,130`·`releaseStore.ts:85-96` — npm 진입점에서는 여는 명령마다 PreToolUse hook 안에서 dist 전체 해시와 패키지 복사(node_modules 포함). hook 은 예약·마지막 ID 대조만 하고 복사는 `atNextWork` 에 맡긴다.
- ⑤ `releaseStore.ts:242-263` 패키지 사본의 의존성 복사가 이름 기준 평탄화라 중첩 버전 충돌을 잃는다. 상위에서 찾은 것만 평탄 복사, 중첩은 위치 유지(또는 잠금 파일로 `npm ci --omit=dev`).
- ⑥ `runtimeGate.ts:166,181`·`sourceUpdate.ts:287` — `home` 이 다른 저장소의 릴리스를 `version`·`--release` 가 못 본다. `appliedStore(state)` 와 기본 저장소를 함께.
- 함께 맞출 것: §7·§8. 시험 `runtimeRelease.test.ts`·`build.test.ts`.

### 2-11. 대시보드·질문 티켓 (묶음, 낮~중)

- ① `interactionService.ts:79,83,191-199` — `interactions` 조회마다 응답된 요청 수만큼 `interaction drain` 프로세스를 띄운다. 마지막 drain 시각을 원장에 남겨 일정 간격 안에는 다시 띄우지 않는다.
- ② `interactionTicket.ts:397-408`·`choiceServer.ts:54-55,85` — 질문 티켓 파일 이름이 `sha256(command)` 뿐이라 동시 세션이 서로의 티켓을 가져갈 수 있다. 이름에 세션 ID 를 넣거나 소비 시 호출 측 세션과 대조.
- ③ `consent.ts:956`·`consentTicket.ts:172-174` — TTY 적용 경로는 「응답을 관찰한 세션」결속을 건너뛴다(`추정`, 위조는 아님). TTY 적용은 `preparedSession` 이 없는 기록에만 허용하거나 상위 프로세스 확인.
- 함께 맞출 것: §4.2, `doc/dashboard-interactions.md`. 시험 `dashboard*.test.ts`·`choiceServer.test.ts`.

## 3단계 — 중: 템플릿·흐름·문서 불일치

### 3-1. `kind: test` 단계가 없는 프로젝트는 아무도 테스트를 쓰지 않음 — 결정 필요

- 문제: `template/claude/agents/ca-implementer.md:15` 「테스트는 쓰지 않는다 — ca-tester 가 쓴다」 ↔ `src/agent/handoff.ts:52` 는 `stage.kind === "test"` 일 때만 `ca-tester`. 그래프의 `test` 노드(`graph/lifecycle.ts:105`)는 `route: "check"` 로 바로 verify 를 돌리고 `ca-check/SKILL.md:18` 도 「계획된 테스트 작성이 끝난 상태에서 verify」. ca-adopt 가 `kind: test` 없는 매니페스트를 허용하므로 그런 프로젝트에서는 implementer 가 거부·verify 실패·repair 가 다시 implementer 로 가 회차만 소진된다.
- 선택지: (가) implementer 금지 문장을 「`kind: test` 단계가 있는 프로젝트에서만 테스트를 쓰지 않는다 — 계획 파일 목록의 테스트 파일은 쓴다」로 좁힌다. (나) `test` 노드가 ⑦ 의 TC 코드가 없는 파일이 있으면 verify 전에 `ca-tester` 인계를 낸다. 하나로 정하고 §3.2 test 행과 맞춘다.
- 함께 맞출 것: `ca-implementer.md`·`ca-check/SKILL.md`·`ca-test/SKILL.md`·`ca-implement/SKILL.md:21`·§3.2·`handoff.ts`. 시험 `graphLifecycle.test.ts`·`templateText.test.ts`.

### 3-2. Codex 사본에 Claude 전용 인자가 남음

- 문제: `template/claude/skills/ca-answer/appendix.md:16`(`--for claude`)·`:45`(`--host claude`·`"host":"claude"`)가 `hosts.ts:175-192` `codexText` 에 치환이 없어 Codex 사본에 그대로 옮겨진다. Codex 메인이 따르면 `cliMain.ts:349` 가 Stop.
- 수정: appendix 두 행을 호스트 중립으로 쓰거나 `codexText` 에 `--for claude`→`--for codex`, `--host claude`→`--host codex`, `"host":"claude"`→`"host":"codex"` 치환을 더하고 `hostNotation.test.ts` 금지 목록에 `--for claude` 를 넣는다.

### 3-3. `ca-next` 1항과 재개 표의 모순

- 문제: `template/claude/skills/ca-next/SKILL.md:31` 은 「실행 중(`run` 있음)인 다른 세션의 배정은 cancel 뒤 재배정」, `:61` 표는 「이 대화에서 아직 호출하지 않은 배정이면 지금 호출」.
- 수정: 표 61행 첫 갈래를 「`run` 없이 dispatch 만 된 배정이면 호출, `run` 이 있는데 이 대화의 담당이 아니면 cancel」로 1항과 같은 기준으로.
- 함께 맞출 것: `commands.ts` `nextHint`·`stateView.ts` `RESUME_CODES`·`doc/usage.md` 5절(§1.1 대응표). 또 `commands.ts:458-461`(interaction 을 먼저)·`stateView.ts:396-400`(`wait`·`ownership-conflict` 가 있으면 질문 대기가 코드에 반영되지 않음)·`ca-next:54`(질문 행 맨 위) 의 우선순위를 하나로 정해 세 곳에 적는다.

### 3-4. ca-reviewer 봉투의 `checked` 조건이 지침에 없음

- 문제: `template/claude/agents/ca-reviewer.md:12` 「관련 파일은 계획 밖이어도 읽을 수 있다」·`:29` 봉투 예시 ↔ `crossRecord.ts:121-135` 는 `checked` 에 `planned` 밖 경로가 하나라도 있으면 봉투를 풀지 않아 `reviewResultProblems`(`:173`)가 형식 오류 → 리뷰어 재호출(회차 소모). `추정`.
- 수정: ca-reviewer.md 29행에 「`checked` 에는 계획 파일 경로만(계획 밖 파일은 넣지 않는다), `acceptance` 는 `AC-R<n>-<m>` 꼴만」을 명시하거나, `normalizeReviewTable` 이 계획 밖 `checked` 를 걸러 내고 표만 살린다.

### 3-5. 템플릿 소규모 불일치 (묶음)

- ① `ca-answer/reference.md:9` 가 Codex `consent respond` 를 현행처럼 쓴다 ↔ `template/codex/ca-answer.md:35` 는 호환 경로. 「Codex 의 동의는 `code_agent.confirm` 폼(옛 `consent respond` 는 사용자가 요청할 때만)」으로.
- ② `ca-review/SKILL.md:24` hook 누락 복구를 `code-agent update` 로 안내 ↔ `hook.ts:397` 은 `init` 또는 `update --templates-only`. 후자로.
- ③ `template/CODEX.block.md` 에 `CLAUDE.block.md:8`(검증 결과는 code-agent 가 기록한 것만 유효)·`:10`(비밀값 금지)·`:12`(언어 규칙) 세 규칙이 없다. 셸 표기만 바꿔 더하고 예산(1782/1800) 조정.
- ④ `template/claude/agents/ca-explorer.md:4` `tools` 에 Edit 이 없는데 수정 재배정 문구는 `editVia()`(「Write/Edit 로」). Edit 을 주거나 문구를 역할별 도구에 맞춘다. `추정`.

### 3-6. 현행 문서 ↔ 코드 불일치

- `doc/usage.md:18` Codex hook 수 5개 → 6개(`init.ts:38` `CODEX_EVENTS`).
- `doc/master-control.md:137` `hasMore`(2-7 ⑦ 과 함께), `:239` 「Codex 는 PreToolUse」→「code-agent hook 6개」(`hostProfile.ts:90-92`), `:243` approvalPolicy(2-7 ② 와 함께).
- `doc/process-flow.md` §4.2 `observeConsent` 검사 순서에 「대시보드 응답·종결 여부」(`consent.ts:628` `assertInteractionUnanswered`)를 첫 검사로 더하고 「여섯 거부」로.
- §5 줄 번호 인용 전부 낡음: `:306` `init.ts:334-344`→`382-392`, `:330` `init.ts:236-256`→`294-297`, `:347` `hook.ts:178-223`→`438-471`, `:368-370` 셸 명령 검사·모드 결정·`decideBash`→`539-549`·`552-583`·`870-896`(+`871-877`·`79`·`85-94`), `:384` `hook.ts:106-139`→`112-149`. §6.1: `advancePlanning planning.ts:405-480`→`536-618`(`planningAdvanceStep`), `planningProblems planningState.ts:457-483`→`602-628`, `rewindOf 349-374`→`476-501`, `ROLE_PHASE planningState.ts:31`→`40`. 줄이 자주 밀리는 자리는 절·함수 이름으로 바꿔 인용한다(머리말 규칙).
- §6.2 「표지의 실행이 아직 돌면(같은 PC 면 살아 있는 pid …)」는 2-8 ④ 수정 뒤 코드에 맞춘다.
- §9 개발 스크립트 행에 15개 중 11개가 없다(4-5 와 함께).
- `doc/langgraph.md` 「모든 전진은 transition 그래프」에 2-9 ⑦ 의 두 직접 호출을 예외로 적거나 코드를 고친다.

### 3-7. 템플릿 예산 재산정

- 현재 여유: `ca-review/SKILL.md` 3392/3400, `ca-next` 6938/7000, `ca-plan` 4644/4700, `ca-adopt` 8403/8600, `ca-answer` 8966/9100, `CODEX.block.md` 1782/1800, Claude 흐름 합계 52722/53300. 3단계 수정이 모두 이 파일들을 건드리므로 마지막에 `node scripts/template-sizes.cjs --suggest` 로 `templateBudget.test.ts` `BUDGET` 을 다시 잡고 근거를 이 문서에 적는다. 4-6(계획 스킬 공통 절 분리)을 먼저 하면 여유가 생긴다.

## 4단계 — 정리·제거

### 4-1. 죽은 코드

- 어디서도(시험 포함) 참조되지 않는 export 13개 — 제거: `evidence.ts:338` `missingPlanFiles`, `experience.ts:286` `originWork`, `master/supervisor.ts:292` `hostAlive`(주석은 「재조정이 쓴다」지만 호출자 없음), `survey.ts:134` `sourceFiles`, `planning.ts:43` `export { ROLE_PHASE as PHASE }`, `models.ts:32` `MODELS`, `retryGrant.ts:273` `GRANTABLE_KEYS`, `retryPolicy.ts:13` `RETRY_POLICY_VERSION`, `interactionSchema.ts:5` `INTERACTION_SCHEMA`, `consentState.ts:26` `type ConsentActionName`, `master/protocol.ts:22,44` `type MutatingType`·`type DelegableAction`, `validate.ts:128` `interface ValidateOptions`. 내부 미참조 `retryPolicy.ts:89` `grantTable`.
- 운영 코드 미사용 import 5건: `evidence.ts:6` `StageDef`·`:28` `trackedPaths`, `interactionService.ts:2` `existsSync`, `interactionSources.ts:2` `realpathSync`, `sessionHook.ts:4` `canonical`.
- 시험: `planning.test.ts`·`planningChainFlow.test.ts`·`planningCross.test.ts`·`planningRecovery.test.ts`·`planningFixture.ts` 가 같은 43줄 import 머리말을 복제해 파일당 미사용 import 44~110개 — 각 파일이 쓰는 것만 남긴다(약 130줄). `consentBinding.test.ts` `finishConsent`, `consentScreens.test.ts` `checkApproval`, `crossReview.test.ts` `ReviewLog`, `dependencyContracts.test.ts` `SPEC`, `master.test.ts` `grantOf`·`emit`.
- 재발 방지: `tsconfig.json` 에 `noUnusedLocals: true`(현재 strict 만). 켜고 컴파일 오류를 전부 치운 뒤 커밋.
- 자기 파일에서도 쓰지 않고 시험만 부르는 export(`consent.ts` `consentSnapshot`, `deliver.ts` `deliveryPathspecs`, `evidence.ts` `overFixLimit`, `hostText.ts` `shellLabel`, `models.ts` `modelOf`, `plugins/defaults.ts` `rankCandidates`·`relevantDocSections`, `questions.ts` `unansweredQuestions`, `review.ts` `saveReview`, `work.ts` `approvalDocsHash`, `workDocs.ts` `workDocsHash`, `core/build.ts` `pinRefs`·`verifyByBuild` 등) — 시험이 운영 경로를 거치게 바꾸거나 그대로 두되 「시험 전용」 주석. 선택.
- 자기 파일 안에서만 쓰이는 export 314개(`findings.ts` 17, `contextRender.ts` 15, `retryPolicy.ts` 14 …) — `export` 만 떼면 된다. 선택.

### 4-2. 중복 정의 통합

- 키 정렬 JSON 직렬화: `stateView.ts:111`·`core/approval.ts:160` `canonical` ↔ `master/protocol.ts:251` `canonicalJson`(export) — 하나로.
- `sha256:`+16자리 `sha(text)`: `docs.ts:243`(export)·`core/approval.ts:155` — 하나로.
- sha256 hex 한 줄 래퍼 6종: `answers.ts:46` `sha16`, `dependencyContracts.ts:11` `digest`, `findings.ts:109` `sha`, `stateView.ts:106` `sha`, `triage.ts:15` `hash`, `master/protocol.ts:259` `sha256`(export) — `protocol.sha256` 또는 작은 공용 모듈로.
- 경로 정규화: `sourceUpdate.ts:50` `canonical`·`consent.ts:118` `canonicalRoot` ↔ `layout.ts:150` `canonical`(없는 꼬리 처리) — `layout.canonical` 하나로.
- `samePath` 4종(`consent.ts:125`, `doctor.ts:106`, `sourceUpdate.ts:54`, `codexReadiness.ts:93`)은 의미가 다르다(대소문자만 / realpath+소문자 / realpath 실패 시 문자열) — 한 정의로 모으고 플랫폼 규칙을 한 곳에.
- `readText` 4종(`aidlc.ts:33`, `experience.ts:101`, `knowledgeIndex.ts:79`, `runtimeApply.ts:88`) — 동작 차이(trim·CRLF) 확인 뒤 통합.
- `clock(at)` 동일 람다: `crossCheck.ts:305`·`review.ts:552`.
- **AGENTS.md 「한 모듈 원천」위반**: `evidence.ts:781` `CAUSE_LABEL`(`fix: "고쳐 쓰기"`, `collect: "수집 수정"`)·`:870` `"수집 수정"` 리터럴·`review.ts:722` `"리뷰 회차"` 는 `retryPolicy.ts:46` `COUNTER_LABEL` 과 같은 문구를 재정의 — import 로 바꾼다. `consent.ts:107` `TITLES = CONSENT_TITLES` 별칭(외부 import 없음) 제거.
- 시험 fixture: `kindFlowFixture.ts` ↔ `stageFixture.ts` 의 `write`·`git`·`hook`·`writeFileHook`·`confirmDocs`·`PASS`·`NOT_INSTALLED` 가 글자 그대로 동일. `write()` 21개 파일, `git()` 12개, `hook()` 6개, `mkdtempSync`+`git init` 22개 파일에 반복 — `repoFixture.ts`(임시 폴더+git init+user 설정+정리) 하나로.

### 4-3. 문서 중복 축소

- 명령 표 3개(README 24행, `doc/design.md` §9 46행, `doc/usage.md` 60행) — design.md §9 는 설계 문서에 맞지 않으므로 usage 링크로 대체(약 9KB).
- hook 등록 표 6개 문서(process-flow §5.1 28행, design 16, usage 10, install 5, codex 5, README 1) — process-flow §5 를 정본으로 두고 usage·install·design 중 둘은 개수와 링크만. AGENTS.md 의 「hook 바꾸면 함께 고칠 목록」도 그만큼 줄인다.
- 종료 코드 설명 9개 문서 분산(usage 13, process-flow 12, install 9, design 7) — 정본 하나 정하고 나머지는 링크.
- `doc/process-flow.md` §10: 글머리표 16건(최신순)과 표 42건(오래된 순)으로 형식이 갈리고 `:899` 에 경계 설명 문단까지 있다 — 한 형식으로. 300자 넘는 행 19개(`:940` 1,341바이트·식별자 9개, `:935`, `:941`, `:911` 커밋 8개 나열)를 「요지 한 문장 + 커밋」으로 줄인다(약 10,000자 → 4~5,000자). 글머리표 행의 `[검증 기록]` 링크는 reviews/README 표와 중복이라 커밋만 남긴다. 커밋 해시 73개는 모두 존재한다(없는 해시 없음).
- `doc/design.md` §11 「`kind: "verify"`·`expect` 는 죽은 선언」은 코드로 확인됨(`core/manifest.ts:32,55,90` 스키마만, 읽는 곳 없음). `hashManifest` 영향으로 유지하되 §11 에 그대로 둔다.

### 4-4. 호환 shim 검토 — `추정`

- `crossRecord.ts:293,323,371,401` `legacyReviewAttempts`·`legacyPlanningAttempts`·`syncLegacyRound`·`syncLegacyPlanning`(~110줄), `retryPolicy.ts:782` `deriveLegacyCauses`, `validate.ts:595` `legacyReproClass`, `deliver.ts:233` `renderTraceBlock({legacy})`, 계획 스킬 4개의 `legacy.md`. AGENTS.md 규약(형식 변경 시 `STATE_SCHEMA` 올림, 낮은 세대 릴리스는 적용 안 됨)과 겹치는 이중 방어다. 현재 `STATE_SCHEMA` 아래 세대 작업이 실제로 열리는 경로가 없음을 확인하면 제거(~150줄). 확인 전에는 유지.

### 4-5. 스크립트

- §9 개발 스크립트 행에 15개 전부를 「무료(`prune-dist-tests`·`template-sizes`·`summarize-evaluations`·`smoke-langgraph-bin`·`build-bin`) / 유료·수동(`evaluate-*`·`live-codex`·`diagnose-codex-hooks`)」 두 줄로 적는다.
- 유료 평가 스크립트 7개(`evaluate-model.cjs:82`, `evaluate-review.cjs:18,31`, `evaluate-question-choices.cjs:36`, `evaluate-planning-hosts.cjs:91`, `evaluate-session-recovery.cjs:52`, `evaluate-full-flow.cjs:108`, `evaluate-codex-git-permission.cjs:37`·`evaluate-choice-ui.cjs:21`)는 입력 즉시 실제 모델을 부른다 — 공통 가드(예: `CODE_AGENT_LIVE_EVAL=1` 없으면 사용법만 내고 종료) 한 줄.
- 어디서도 언급되지 않는 `evaluate-choice-ui.cjs`·`evaluate-session-recovery.cjs` — §9 또는 해당 reviews 기록에 연결하거나 제거. `evaluate-model.cjs`·`evaluate-review.cjs` 는 evidence JSON 에서만 언급 — 현행 쓰임이 없으면 제거 후보.
- `scripts/prune-dist-tests.cjs:9-16` — `tsconfig` 에 `sourceMap` 이 없어 `.map` 분기는 죽은 코드. 삭제 조건을 「src/test 에 같은 이름 `.ts` 가 없는 모든 `.js`」로 넓혀 보조 파일(`*Fixture`·`*FakeHost`·`confirmedStart`·`deadPid`) 잔존도 치운다.

### 4-6. 템플릿 중복

- 계획 스킬 4개(`ca-analyze`·`ca-impact`·`ca-design`·`ca-plan` SKILL.md)의 같은 절차 2~5항·되감기 문장 7줄(약 4,000자) — 공통 보조 문서(예: `ca-plan/contract.md` 확장 또는 새 파일)로 빼고 참조. `templateText.test.ts`(「계획 스킬 2·3·4항」대조)·`hosts.ts` `CODEX_SENTENCES` 를 같이 고친다. 3-7 예산 여유가 생긴다.
- 17개 스킬의 질문·동의 공통 문단(217자 × 17)은 설계상 유지(시험이 같은 글자를 대조, Codex 변환이 문장째 치환). `CLAUDE.block.md` 로 올리는 안은 두 시험·`CODEX_SENTENCES` 변경 비용이 있어 선택.
- 보조 문서(`criteria`·`reference`·`appendix`·`legacy`·`contract`·`triage`·`knowledge`·`tc-names`)와 SKILL.md 의 50자 이상 공유 줄은 0 — 겹침 없음.

### 4-7. 저장소 위생

- `.gitignore` 에 `.code-agent/` 추가 — 사용자 수준 hook 이 이 저장소에서 돌며 로그를 쓰는 것을 확인했다(`git status` 에 `?? .code-agent/`). 필요하면 `.claude/`·`.codex/` 도.
- `package.json` `files: ["dist","template"]` 가 `dist/test`(시험 101개·fixture 13개·약 3만 줄)를 패키지·릴리스 사본에 넣는다(`releaseStore.ts:211` 이 그대로 복사). `dist/agent`·`dist/core` 로 좁힌다 — 단 `scripts/evaluate-choice-ui.cjs:12` 등이 `dist/test/consentFixture` 를 require 하므로 빌드는 유지. `runtimeRelease.test.ts:515` 가 모사하는 「실제 npm 설치」 내용과도 맞아진다.
- `src/test/sourceUpdateConfirm.test.ts:78` `{ skip: !!process.stdin.isTTY }` — 터미널에서는 영원히 생략. 비TTY 자식에서 돌리거나 `isTTY` 를 주입.
- `src/test/runtimeRelease.test.ts`(692줄, cli spawn 51회, `timeout: 120_000`)가 가장 긴 파일로 보인다(`추정`). 한 번 `--test-reporter=spec` 으로 파일별 시간을 재고 90초를 넘으면 `:501` 「npm 패키지 진입점」 describe 를 별 파일로.
- `doc/reviews/evidence/2026-10-20-live-session-recovery.json` 은 `.md` 가 아니라 `2026-10-20-session-recovery-live.json:56` 에서만 가리킨다(이름이 뒤바뀐 쌍) — 하나로.
- 의존성 버전 표기: langchain 3종 고정, `zod`·`esbuild`·`postject`·`typescript` 는 caret. lock 이 있어 위험은 낮다 — 통일은 선택. `version: 1.0.0` 이 `releaseStore.ts:105` 사용자 문구에 쓰이므로 릴리스마다 올릴지 결정.
- `retryPolicy.ts` 1,494줄(125KB)은 단일 파일 최대 — 분할 검토 대상(선택).

## 검토에서 결함 없음으로 확인한 범위 (다시 보지 않아도 됨)

- 커서 전진: 커서를 쓰는 자리는 `commands.ts` `start`·`applyNextTransition`·`requireValidatable` 되감기·`back` 넷뿐이고 앞으로 가는 길은 `nextTransition` 결과만 쓴다. 게이트를 건너는 경로 없음.
- 동의: Claude Pre/Post 결속, 대시보드 서명·challenge·채널 세대 검사, 멱등 commandId, 적용 티켓 세션 대조에서 모델 단독 위조 경로 없음. 대시보드 응답과 Claude Pre 의 경쟁은 양방향으로 닫힌다.
- master: 토큰 비교 `timingSafeEqual`, 토큰 파일 `wx`+0600·링크 거부, 페어링 챌린지 nonce·usedAt 선기록, HUMAN_ONLY 위임 삼중 거부. Codex 단건 Git 권한 셸 꼴은 `;`·`&&`·`|`·백틱·`$(...)`·`%VAR%`·`^`·줄바꿈·`-EncodedCommand`·경로 있는 첫 단어 모두 거부.
- 교차 호출: `spawnSync` 인자 배열·셸 미사용으로 인젝션 없음. 재시도 한도 비교 off-by-one 없음. §6.3·§6.4 표와 코드 일치.
- 버전 선택: 위임 루프 없음(`handoff()` 가 있으면 재선택 안 함), 릴리스 설치는 staging→rename 한 번. settings.json·hooks.json 병합은 우리 항목만 교체.
- 경로 별칭: `expandTilde`·`foldStreams`·`foldWindowsAlias`·`canonical`·`shareInside` 조합으로 키 자리·`.code-agent`·호스트 설정 쓰기 우회 못 찾음. hook 출력·종료 코드 표는 §5.1·§5.2 와 일치. hook 경로의 지연 로드 규칙 준수.
- 템플릿: `CODEX_SENTENCES` 5개·장시간 실행 정본 4곳·담당 호출 문장 17곳·공통 문단 17개·계획 스킬 2·3·4항 모두 글자 일치. `AskUserQuestion`·`Bash`·`/ca-*` 등 Claude 전용 표기는 Codex 사본에 없음(3-2 의 `--for`/`--host` 제외). TC 표기·리뷰 표 규칙은 코드와 일치.
- 의존성 4종 모두 사용 중, 버전 실존, engines 근거 있음. 최근 코드 커밋 10개 모두 같은 커밋에서 §10 갱신. reviews 23개 전부 README 표에 있고 evidence·images 미참조 없음. 시험 간 전역 상태 간섭 없음(파일당 프로세스, env 복원, chdir 0건). `execSync` 셸 문자열 조립 0건.

## 검증

기준 커밋 `a5f9206`, Windows 11, Node 24.19.0, PowerShell 5.1.26100.

- 검토 전 `npm test`: 1741건 중 1737 통과, 4 생략(Windows 조건), 0 실패. 벽시계 약 12.5분은 검토 에이전트 9개와 CPU 를 경합한 값이라 기준치(2~3분)와 비교하지 않는다.
- 1-1 재현: PowerShell 5.1 에서 `Write-Output ‘hello’`·`Write-Output “hello”` 가 모두 문자열로 출력됨(스마트 따옴표를 구분자로 받는다). 허용 명령 뒤 괄호식 주입은 검사 코드 읽기로 확인했고 실행으로는 재현하지 않았다.
- 1-2·1-5·1-6·1-7·2-1·2-3 ②·2-7 ②·3-1·4-1·4-2(`CAUSE_LABEL`·`canonical`)는 코드를 직접 열어 확인했다. 그 밖은 영역 검토자의 보고이며 줄 번호는 보고 시점에 연 줄이다.
- 작업 뒤 각 단계의 `npm test` 결과와 템플릿 예산 변경 근거를 여기에 덧붙인다.

- 1-1 구현: PowerShell 명령과 동의 티켓 인자의 스마트 따옴표를 보수적으로 거부한다. Bash의 일반 스마트 따옴표 문자열은 유지하며 셸 치환은 거부한다.
- 1-1 검증: `npm run build`, `gate`·`hookPaths`·`consentBinding` 67 통과·0 생략·0 실패. 시험 출력은 파일 종료 때 모여 나왔으며 전체 실행에 약 6.3분이 걸렸다.
- 1-2 구현·검증: 준비만 캐시를 쓰고 응답 관찰·적용은 전수 해시한다. 새 stat·옛 해시 캐시 오염 회귀를 포함한 `consentSnapshot` 29 통과·0 생략·0 실패, 빌드 통과.
- 1-3·1-4 구현·검증: MCP 명령 인자의 셸 판정과 미해석 인자 거부, 하위 담당 진행·동의·임대 변경 거부와 티켓 차단. 문서·plan·deliver·Codex 경로 및 기존 MCP/읽기 전용 담당 시험 6 통과·0 생략·0 실패, 빌드 통과. 담당 지침은 진행 명령 실행을 요구하지 않아 예외를 열지 않는다.

- 1-5·1-6 재현: 수정 전 두 회귀 시험이 각각 passed 오판과 승인 원장 바이트 변경 미복원으로 실패했다. 현재 carry()는 승인 원장 순번을 비교하지 않아 원장 추가만으로 회차를 초기화한다는 설명은 확인되지 않았다. 확인된 기록 보호 누락을 고쳤다.
- 1-5·1-6 검증: 수정 후 TC 출력/토큰·승인 원장 보호·생략 TC·수집 수정 회귀 6 통과·0 생략·0 실패, 빌드 통과.
- 1-7 구현·검증: 승인에 답변된 질문의 고정 투영을 넣고, 실제 질문 호출의 제목과 당시 문서 해시를 관찰된 답에 결속한다. 상태 세대는 14다. 제목·본문·답 변경 및 질문 호출 불일치 회귀를 추가했고 `answers` 10 통과·0 생략·0 실패, 빌드 통과. 승인·외부 계약 회귀는 단계 전체 시험에서 함께 확인한다.
- 1단계 템플릿: `tc-names.md`의 새 조건을 줄여 1496/1500자로 유지했다. `ca-answer` 8992/9100자, Claude 흐름 합계 52748/53300자이며 예산은 올리지 않았다.
- 1단계 전체 시험의 첫 실행은 상속된 `CODEX_SANDBOX_NETWORK_DISABLED=1` 때문에 가짜 Codex 호스트 준비 검사가 거부되어 중단했다. 시험 프로세스에서 해당 표지를 제거해 전체 시험을 다시 실행한다. 생산 코드의 샌드박스 검사는 유지한다.
- 1단계 전체 시험 재실행: 1750건 중 1743 통과·4 생략·3 실패(1480.7초). 실패 둘은 준비 전용 캐시 및 하위 담당 진행 거부와 맞지 않는 기존 시험 기대값이며 수정했다. 나머지는 모의 Codex 호스트 종료 뒤 임시 폴더 정리의 Windows EPERM으로, 경로 검증과 프로세스 정리를 유지하고 파일 제거의 짧은 재시도를 추가했다. 전체 재검증이 필요하다.

- 1단계 전체 재시험: 1750건 중 1745 통과·4 생략·1 실패(4983.8초). 남은 실패는 준비 시간이 2초를 넘으면 새 파일이 캐시 가능한 나이가 되는 시험의 시간 가정이었다. 캐시 검사에 시각을 명시하고 캐시 파일 미생성도 허용하도록 보정했으며 해당 회귀 1 통과·0 생략·0 실패. 전체 시험을 기본 병렬도로 다시 확인한다.

- 2-1 구현: 없어진 적용 릴리스로 새 세션을 열지 않고, 템플릿 반영은 기존 고정을 유지한다. 번들 복구 뒤에도 상태 세대는 남는다. `abort`를 복구 진입점에 추가했다. `tsc --noEmit` 통과, 실행 회귀는 1단계 전체 시험 종료 뒤 격리 작업 트리에서 검증한다.
- 2-2 구현: hook의 실행 방식·사전 판별 읽기 실패를 제한된 읽기 모드로 보내고, 동의 동기화는 손상·이동한 기록만 건너뛰며 요청별 사유를 표시한다. 공용 JSON 읽기·구조 검사 함수를 실행 방식·호스트·런타임·사전 판별에 적용했다. `tsc --noEmit` 통과, 세 회귀 시험을 추가했다. 실행 검증은 1단계 전체 시험 뒤 진행한다.
- 2-3 재현: 수정 전 빌드에 살아 있는 현재 PID와 다른 시작 식별값을 적은 `run.lock`을 주면 `waitMs: 0`·나이 회수 금지에서 busy로 멈췄다. OS 시작 식별 대조와 master 감독 표지 대조를 추가하고 owner 갱신을 제어 잠금 안으로 옮겼다. 빈 주인 유예는 대기 한도와 분리했다. 잠금·그래프·master 회귀를 추가했으며 `tsc --noEmit` 통과, 실행 검증 대기다.
- 2-1~2-3 검증: 1단계 실행 파일과 분리된 작업 트리에서 빌드 후 새 회귀 9 통과·0 생략·0 실패(33.7초). 기존 잠금 전체·`docSync`·`hookLoad` 48 통과·0 생략·0 실패(51.2초). 잠금 정책 표는 현재 `renderRetryPolicyTable()` 출력으로 다시 생성했다.
- 2-4 구현·검증: 첫 init의 기준 해시 기록과 재실행의 수동 사본 보존을 추가했다. 기준 기록이 없는 이전 설치도 다른 사본을 보존한다. Claude·Codex 사본 보존/Stop hook 복구와 기존 update·손상 설정 회귀 11 통과·0 생략·0 실패(12.1초), 빌드 통과. 내부 update는 이미 계산한 보존 목록을 넘겨 재귀 적용을 피한다.
- 2-5 재현: 수정 전 두 새 회귀가 각각 Post 만료 오류의 exit 2·답 관찰 생략, 적용한 범용 질문의 다음 Pre에서 이미 받은 답 거부로 실패했다. 실제 답을 먼저 관찰하고 Post 영속 갱신 오류는 경고로 남기며, 적용한 native 질문의 새 호출은 새 요청으로 분리했다.

- 2-5 검증: `answers`·`interactionRouting` 21 통과·0 생략·0 실패(485.1초), 빌드 통과.
- 2-7 재현: 수정 전 제어 잠금 경합은 권한 전달에서 busy 예외로 올라왔고, 비Windows 분기는 루트 bash 가림을 허용했다. 수정 후 잠금 재시도·플랫폼 공통 PATH 검사·ID 충돌·메타 중단·이벤트 보관·무변경 원장 회귀 6 통과·0 생략·0 실패(1.3초). 명령 기록 파일 이름과 이벤트 메타의 호환 범위가 달라져 상태 세대를 15로 올린다.

- 2-7 추가 검증: 기존 master 협상·멱등·권한·모의 Codex RPC를 포함해 33 통과·0 생략·0 실패(270.2초).
- 2-8 재현: 수정 전 코드 결함 뒤 수집 수정 예산, 묶임이 다른 오래된 실행 표지, 살아 있는 통합 표지의 나이 회수 회귀 3건이 실패했다. 교차 프로세스 트리 종료 시험은 샌드박스의 종료 권한 제한으로 실패해 일반 권한에서 다시 실행했고, 결과/민감 정보/KNOWLEDGE/프로세스 감독 회귀 5 통과·0 생략·0 실패(3.4초). 선택 항목인 보고서 stat 캐시는 이번 수정에서 적용하지 않는다.

- 2-8 흐름 검증: 18건 중 17 통과·1 실패·0 생략(138.0초). 실패는 긴 프롬프트 시험의 다음 회차 코드가 기존 TC를 깨뜨린 시험 데이터 문제였다. 정상 구현을 유지하도록 시험 데이터를 고친 뒤 해당 회귀와 교차 감독 3 통과·0 생략·0 실패(92.5초). 빌드 통과, TC 안내는 예산 안에서 Jest 표시 설명을 맞췄다.

- 2-9 재현: 수정 전 plan 초안 없는 미응답 질문·모르는 단계·승인 뒤 게이트 Stop 회귀 3건이 실패했다. ①~⑤를 보강하고 ⑦의 동기 전진 예외를 LangGraph 문서에 명시했다. ⑥은 기존 시험이 안내 출력 때 자동 허용 소진을 명시하여 사용자에게 실제 back 때 소진할지 질문했으며, 결정 전에는 바꾸지 않는다.

- 2-9 검증: 사람 판단·모르는 단계·게이트 중단·명령 사이 계약 재검사·그래프 잠금 중 동의 적용 5 통과·0 생략·0 실패(15.1초), 빌드 통과. ⑥은 사용자 결정 대기다.
