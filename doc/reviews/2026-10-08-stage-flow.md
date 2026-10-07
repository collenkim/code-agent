# 단계 전이·CLI 안내·반영 범위·동시 사용 — 재진입 안내·작업 임대·호스트별 표기

기준일: 2026-10-08. 기준 커밋: `6584910`(C5 독립 검토 반영). 감사 [2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)의 C4 묶음(FLOW-02·03·07·08·09·10·11·12·13·16·17, HP-5·HP-11, OPT-8, DOC-8, PVR-7, 재시도 규약 §7.4)을 구현했다. 현재 동작은 [프로세스 흐름도](../process-flow.md) §3·§5·§7·§8 이 정본이다.

## 결정

| ID | 판정 | 바꾼 것 |
|---|---|---|
| FLOW-02 | 수정 | deliver 단계의 작업 폴더 밖 쓰기를 hook 이 거부한다(⑩·지식 제안·질문은 쓴다). 사용자 지시가 있으면 deliver 에서도 `back` 이 되감고 준비해 둔 반영 동의가 무효가 된다는 줄을 붙인다. 사람이 계획 파일을 고쳐 증거 묶임이 깨졌을 때만 `check`·`verify` 가 deliver 에서 check 로 되감는다(맞으면 `back check` 안내와 함께 거부). `STOP_PHASES` 에 deliver. TTY `deliver` 는 확인 뒤 커서·게이트를 다시 대조한다 |
| FLOW-03 | 수정 | 승인이 무효면 `reentry.ts` `reentryHint` 하나로 재진입 순서를 만든다 — `status`·`next` 의 `다음:`, hook 쓰기 거부, 검증·재현 거부가 같은 문장. 관찰 흐름은 낡은 계획 작업의 가장 앞 단계(`staleEarliest`)로 되감기 → 그 단계 스킬로 재실행 → `plan submit` → plan 동의, 낡은 작업이 없으면 그 자리 재승인. 옛 흐름 `stale-docs`·`stale-order` 는 두 갈래(계획을 바꿔야 하면 / 그대로면), 그 밖은 그 자리 재승인. 이 되감기는 사용자 지시 없이 하는 예외로 단계 스킬 9개·`ca-next` 에 적었다 |
| FLOW-07 | 수정 | 새 작업 브랜치를 딸 때 `start` 가 미커밋·미추적 변경을 거부한다(`request.ts` `startBlockers` — 작업 폴더·`.code-agent`·지시서·준비 커밋에 담을 도입 파일 제외, 이미 있는 브랜치는 보지 않는다). `request begin` 은 경고 줄, 접수 중 `status` 는 `시작 전 정리 필요:` 줄. `status` 의 `계획 밖 변경:` 줄을 모든 스테이지로 |
| FLOW-08 | 수정 | 작업(ID)당 대상 하나 — 초안 스키마 `target` `.max(1)`, `start` 가 진행 중 확인 뒤·브랜치 전환 앞에서 다중 대상 지시서를 거부(초안 유무로 고칠 파일을 다르게 안내). 진행 중인 작업은 `이미 진행 중입니다` 로 그대로 잇는다. `core/workOrder.ts` 는 여러 대상을 계속 읽는다 |
| FLOW-09 | 수정 | `preparationHint` 가 기준 커밋을 보고 setup·docs·baseline 동의 하나를 고른다. `requireDocs`·`checkDoc`·`docsStatus` 문구를 상태별로(작성 → `ca-docs`, 확정 → 동의, TTY 명령은 "직접 CLI") |
| FLOW-10 | 수정 | `doctor [--host claude|codex|both] [--cross]`(순서 무관)를 작업·세션 중 hook 허용 목록에. `retryPolicy` `cross-config-error` 안내의 "사람이 별도 터미널에서 … (작업 중에는 모델이 doctor 를 실행할 수 없다)" 를 걷었다 |
| FLOW-11·HP-5·OPT-8 | 수정 | CLI·hook 의 사용자 문구를 `hostText.ts` 표기 함수로(스킬·역할·질문 도구·셸·파일 도구). `cliMain.ts` `useNotation(notationFor(root))`, hook 진입 `withNotation`(Claude 하위 명령 claude, `codexHook` codex), `codexHook` 사후 치환 두 곳 삭제, `hosts.ts` 가 `ROLE_NAMES`·이름 변환을 다시 내보내고 역할 정규식을 그 목록으로 만든다. `codexText` 에 장시간 실행·교차 4-1 문장째 치환과 `Bash 로`·`Bash 등으로` 치환. Claude 표기는 배선 전 바이트와 같다 — 예외 셋(`setup.ts` 추천의 `AskUserQuestion으로 묻습니다`, setup 의 `현재 호스트 세션에서`, 요구 반려의 `Claude Code 에서 ` 삭제). 파일·확인 화면 문자열(`setupStatus` 포함)은 리터럴 |
| FLOW-12 | 수정 | 관찰 흐름 analysis~plan 의 `다음:` 이 `planning advance` 를 안내한다. check·test 의 진입 명령은 `verify --json`(판정·원인·한도 문구는 C3 증거 기반 갈래 그대로) |
| FLOW-13 | 수정 | 작업·접수 없는 `status` 가 AI-DLC 차단·문서 세션·준비 동의를 먼저 본다. 작업이 있을 때도 `nextHint` 맨 앞이 AI-DLC. `ca-next` 에 '멈춘 자리별 재개' 표 |
| FLOW-16·HP-11 | 수정 | 작업 임대 `.code-agent/lease.json`(`lease.ts`). PreToolUse 가 작업 모드에서 기존 판정이 허용일 때만(동의 티켓 발급 전) 진행 명령·쓰기의 임대를 본다 — 다른 세션의 신선한 임대는 거부(`precondition`), Claude SessionStart 는 `source` 와 무관하게 같은 호스트 임대를 넘겨받고, 다른 호스트는 `takeover`(사용자 확인 — 스킬 규칙)나 30분 무활동으로만. Codex 는 호스트만 비교. 교차 실행 자식은 임대를 읽지도 쓰지도 않는다. 기록(잠금·쓰기) 실패는 막지 않는다. `status` 에 `진행 세션:` 줄, `.gitignore` 블록에 `lease.json*`(동의 스냅샷 제외는 C5 가 미리 넣었다) |
| FLOW-17 | 수정 | `approve`·`reject`·`confirm` 의 남는 인자는 사용법 오류. `approve request …` 는 `confirm request` 를 안내. 사용법에 `[<지시서>]` |
| DOC-8 | 수정 | `--help` 를 호스트 중립 문구로(`takeover`·`approve [--comment]`·doctor 작업 중 조회) |
| PVR-7 | 수정 | 반영 커밋이 handoff·`.staging`(`:(exclude,literal)`)과 작업 상태 폴더 바로 아래 `*.lock`(`:(exclude,glob)`, 글롭 문자는 `[[]` 꼴로)을 뺀다. 포함 경로를 index 기준으로 걸러 빈 경로의 commit 실패를 막는다. `committedOutside`·동의 미리보기의 커밋 대상 목록이 같은 규칙(`isDeliveryExcluded`). `handoffDir` 는 `layout.ts` 로(순환 회피) |
| 규약 §7.4 | 수정 | `다음:` 판정 순서: AI-DLC → 요구 → 질문 → 승인 무효 → 검증 한도(`verifyLimitHint`, check·test) → `failureHint` → 스테이지. `failureHint.ts` 는 원천이 `다음:` 에 닿지 않는 두 자리만 — 관찰 흐름의 배정 실패·고아(원인 이름표 + `planning advance`, 고아 판정은 `runView`), deliver 동의 실패(`guidance(cls, {detail})`). 검증·리뷰·교차 기록은 읽지 않는다 |

## 설계 명세와 다르게 한 것

- **표기 모듈** — `hostText.ts` 는 공통 모듈 단계에서 이미 있었다. 이 묶음은 배선만 했다. `useNotation` 은 명세의 `cli.ts main` 대신 `cliMain.ts runCommand` 에서 부른다(C5 가 진입을 나눴다). 새 표기 시험은 `hostNotation.test.ts`(새 파일)에 두고, 공통 모듈 시험 `hostText.test.ts` 의 "hook 문자열과 바이트가 같다"(배선 전 리터럴 확인)는 배선 확인으로 바꿨다.
- **교차 4-1 치환** — `ca-plan` 4-1 의 실제 문장이 명세 리터럴과 달라(`(CLI 가 9분에 끊으므로 timeout 600000ms 또는 백그라운드)`) 세 번째 문장째 치환을 더했다.
- **명세 목록 밖의 표기** — C1·C5 가 더한 사용자 문구(`review.ts` 게이트 문구의 `ca-reviewer`, `reviewHook.ts` 기록 실패 문구, `retryGrant.ts` 재개 문구, `doctor.ts`·`bootstrap.ts`·`knowledgeCommands.ts`·`update.ts`)도 표기 함수로 바꿨다. Claude 바이트는 같다.
- **start 사전 검사** — 준비 커밋에 담을 도입 파일(`baselineFiles`)도 뺀다. `start` 는 `requirePreparedBranch` 가 먼저 따로 거부하고, 빼지 않으면 준비 중인 접수에서 setup 동의가 커밋할 파일을 "사람이 커밋·stash 하라" 고 잘못 알린다.
- **준비 동의 선택** — 작업이 진행 중이면 준비 커밋을 보지 않는다(`setupBaseline` 이 작업 중에는 거부한다).
- **재진입 안내** — 반려 줄에 사유(120자)를 붙였다. plan 칸에서는 `none` 을 빼고 무효 승인 + 낡은 계획 작업일 때만 재진입 순서를 낸다.
- **임대 시험 장치** — `leaseGuard`·`sessionStartLease` 에 잠금 대기 인자(기본 hook 10초)를 두어 잠금 경합 시험을 짧게 돈다. `releaseLease` 는 `.code-agent` 가 없으면 기록 없음으로 답하고, `takeover` 는 남는 인자를 거부한다. hook 셸 거부 문구의 명령 목록에 `doctor(조회)` 를 붙였다.
- **반영 pathspec** — 글롭 문자 ID 의 잠금 제외 시험을 위해 `deliveryPathspecs` 를 내보냈다(작업 ID `W[1]` 은 브랜치 이름이 될 수 없어 시작 흐름으로는 만들 수 없다). `ls-files` 실패·빈 포함 경로도 KNOWLEDGE 갱신을 되돌린다.
- **시험 위치** — 관찰 흐름 FLOW-03(지시서 변경 → `back analysis`)은 `planning.test.ts` 대신 새 파일 `stageFlow.test.ts` 에 두었다. p5 의 픽스처를 `stageFixture.ts` 로 꺼냈다(C7 OPT-11 과 겹친다). failureHint 시험 5(교차 원천)는 "failureHint 는 교차·리뷰를 다루지 않는다" 만 본다 — 교차 문구 자체는 C1 시험이 본다. SessionStart 넘겨받기는 `sessionAnchor` 를 직접 부르고, 실제 `session-event` 진입은 sandbox 로 확인했다.
- **기존 시험** — 명세 §8.2 의 넷(p5 Stop·back, agent 허용 목록, consentFixture `.gitignore`) 말고 p7 44b(doctor 가 이제 허용)를 고쳤고, start 사전 검사에 걸린 픽스처 셋(adoption H1 — 무관한 미커밋 파일이 이제 start 를 막는다는 기대로, agent refactor·request 손 지시서 — 앞 작업의 작업 폴더를 커밋)을 고쳤다.

## 남는 한계와 미확인

- SessionStart 의 `session_id`가 같은 세션의 다음 PreToolUse 와 같다는 전제는 실제 호스트에서 확인하지 않았다(다르면 세션 시작 직후 첫 진행 명령이 거부되고 `takeover` 가 필요하다 — 안전 쪽 실패). Codex 서브 에이전트의 `session_id` 가 메인과 같은지 몰라 Codex 는 호스트만 비교한다 — Codex 두 세션의 동시 진행은 막지 못한다.
- 진행 중인 세션을 두고 보기만 하려고 두 번째 Claude 세션을 열어도 임대가 그쪽으로 간다(원래 세션의 다음 진행 명령이 거부되고 `takeover` 로 되찾는다). 임대 30분은 사람이 응답을 30분 넘게 미루는 동안 다른 세션이 넘겨받을 수 있다는 뜻이다.
- `takeover` 의 사용자 확인은 코드가 강제하지 않는다(스킬 규칙). 임대는 권한 경계가 아니다.
- ⑩ 의 `변경 요약` 은 여전히 기준 커밋과의 차이 전부(반영하지 않는 handoff·staging·잠금 포함)를 보인다 — 커밋 대상 목록(동의 미리보기)과 커밋 자체는 뺀다.
- Codex 셸 환경 표지(`CODEX_MARKERS`)는 미확인이다 — 틀려도 두 호스트 설치에서 Codex 출력이 중립 표기로 떨어질 뿐이다.
- 잠금 파일 제외의 문자 클래스 이스케이프(`[[]`)는 Windows git 2.55 에서만 확인했다.

## 근거

- `npm test`: **1187개 중 1183개 통과·실패 0개·생략 4개**(Windows, 약 200초). 시작 전 같은 브랜치는 1134개였다. 새 파일 `lease.test.ts`(11)·`stageFlow.test.ts`(22)·`failureHint.test.ts`(8)·`hostNotation.test.ts`(12), 꺼낸 픽스처 `stageFixture.ts`.
- 표기 배선 전후 템플릿 사본 sha256 비교(`scratchpad/sandbox-stage5/assets-before.json`·`assets-after.json`): 달라진 것은 이 묶음이 고친 템플릿 12개와 그 Codex 사본, 그리고 새 치환이 걸린 `.codex/agents/ca-implementer.toml` 뿐이다 — 역할 정규식을 `ROLE_NAMES` 로 다시 만든 것이 다른 사본을 바꾸지 않았다. Codex 사본 전체에 `/ca-`·`AskUserQuestion`·`Bash`·`run_in_background`·`600000ms`·`timeout 을` 0건, 장시간 실행 문장 치환 4곳.
- sandbox 실호출(`scratchpad/sandbox-stage5/lease-e2e.cjs`, `init --host both` 프로젝트): Claude `hook` 세션 A 의 `code-agent next` 허용 → 세션 B 거부(`다른 세션이 이 작업을 진행 중입니다`)·`status` 허용 → `codex-event` 세션 C 거부 → `takeover` 뒤 B 허용(`previous.why: takeover`) → `session-event` D `startup` 이 넘겨받기 줄을 내고 D 의 `next` 바로 허용 → B 다시 거부. 표지 없는 셸의 `status` 는 중립 표기 `/ca-analyze($ca-analyze)`. 원본 저장소를 소스로 쓰는 update 는 실행하지 않았다.

## 독립 검토 반영

구현(`9d3e285`) 뒤 독립 검토 지적 14건(모두 minor — 그중 ca-next 빈 줄은 두 번, `decideUnreadable` 문구는 두 건에 걸쳐 나왔다)을 하나씩 코드와 sandbox(검토자가 남긴 `sandbox-stage5-review/scripts`의 `r1-deliver`·`r9-unreadable`·`r9b`·`r10-compact`·`r12-update-midwork`를 새 빌드로 다시 돌렸다 — 원본 저장소를 소스로 쓰는 update 는 실행하지 않았다)로 확인했다. 모두 맞는 지적이라 반영했고, 하나(설치 파일 변경이 계획 밖 변경이 되는 근본 처리)는 권고대로 결정을 넘겼다.

| # | 지적 | 판정 | 바꾼 것 |
|---|---|---|---|
| 1 | 매니페스트 없이 문서 세션만 열린 상태(`ca-adopt` 도중)의 `status` `다음:`이 문서 세션 중에는 거부되는 `/ca-request` 접수를 가리킨다(명세 §3.8 코드 조각 순서) | 반영 | 작업·접수 없음 분기가 매니페스트 검사 전에 문서 세션을 본다. `preparationHint` 1단계도 문서 세션이면 `/ca-adopt 로 설정(code-agent.json)·공통 문서를 마저 준비합니다 — 문서 세션이 열려 있습니다. 다 쓰면 code-agent docs end`. 시험: stageFlow FLOW-13(init 없는 폴더 → `docs begin` → `status`·`preparationHint`가 같은 줄, `request begin` 거부 확인). `ca-next` 재개표의 문서 세션 행에 `/ca-adopt` |
| 2·11 | hook 거부 문구 두 곳(세션 밖 hook 설정 `읽기는 Read 도구로`, 상태 읽기 실패 `Read 로 … Write/Edit 로`)에 Claude 도구 이름이 남아 Codex 에도 나가고, 상태 읽기 실패 때 Codex 의 유일한 읽기 길 `code-agent read`가 허용 목록 밖이다 | 반영 | `hostText.ts`에 문장 조각 `readVia`(`Read 로`/`code-agent read 로`)·`readToolVia`(`Read 도구로`/`code-agent read 로`)·`editVia`(`Write/Edit 로`/`apply_patch 로`)를 더해 두 문구를 바꿨다 — Claude 바이트는 같다. 연결·리다이렉트·치환 없는 `code-agent read <파일>`(PowerShell 은 작은따옴표 밖 `(){}@$`도 없이)을 `decideUnreadable` 셸 허용과 세션 밖 `HOST_CONFIG` 거부의 예외로 연다 — 읽기 자체는 그 명령이 Read 판정(키 자리)을 다시 거친다. 시험: hostNotation 둘(Claude 문구 전체 바이트, Codex 문구, 안내한 명령 허용, 연결자·PowerShell 치환은 그대로 거부, Codex `apply_patch` 경로). sandbox: Codex 단독 설치에서 `code-agent.json` 손상 → `codex-event` 셸·패치 거부 문구가 `code-agent read 로 … apply_patch 로`, `code-agent read code-agent.json` 허용·실제 출력 |
| 3·14 | `ca-next` 4항 마지막 줄과 '멈춘 자리별 재개' 문단 사이에 빈 줄이 없어 Markdown 에서 그 항목 문단에 붙는다 | 반영 | 빈 줄을 넣고 흐름도 §1.1 의 인용을 `:49`(재개표)·`:71`(되감기 예외 셋)으로 |
| 4 | `requirement.md` 승인 해시 표·본문의 '대상마다 전부', `design.md`의 Stop hook 범위 `implement`~`integrate` | 반영 | '그 지시서로 받은 승인이 무효(`stale-order`)', `implement`~`deliver` |
| 5 | 흐름도에 옮기거나 다시 쓴 코드의 `file:line`(`init.ts:191-192`, `request.ts:603`·`:609`, `hosts.ts:11`)이 남아 머리말과 모순 | 반영 | `init.ts` `GITIGNORE_LINES`, `request.ts` `preparationHint`(mermaid 라벨 포함), `hostText.ts` `codexAgentName`(`hosts.ts`가 다시 내보냄). 같은 표의 `hosts.ts:83-105`·`:64-90`·`:81`·`:78-80`(이 묶음이 고친 `codexText`·`hostAssets`)도 함수 이름으로 |
| 6 | `usage.md` 오류 표·`status` 설명에 이 묶음의 새 문구가 없고 `stale-docs` 행의 할 일이 '다시 승인' 하나다 | 반영 | hook 표에 반영 단계 쓰기 거부·다른 세션 진행 중(임대), 검증 표에 `반영 단계에서는 검증을 다시 돌리지 않습니다`, 접수 표에 `target 은 하나만`, 그 밖 표에 start 의 미커밋 변경·`대상이 N개입니다`, next 표에 implement 이후의 승인 무효, `stale-docs` 행은 재진입 두 갈래, 상태 읽기 실패·hook 설정 행에 `code-agent read`. `status` 설명에 `진행 세션:`·`계획 밖 변경:`(모든 스테이지)·`시작 전 정리 필요:` |
| 7 | 여러 대상 지시서로 이미 시작한 작업의 `request submit` 재제출이 '대상마다 별도 ID 로 접수합니다'로만 거부돼 잘못된 방향으로 이끈다 | 반영 | 스키마 오류가 `target`의 개수 초과이고 초안 `id`가 진행 중인 작업이면 `진행 중인 작업(<ID>)의 요구사항을 고치는 중이면 target 에 진행 중인 대상(<대상>) 하나만 남겨 다시 제출합니다 — 나머지 대상은 이 작업을 끝낸 뒤 대상마다 별도 ID 로 접수합니다`를 덧붙인다. 시험: stageFlow FLOW-08(덧붙음, 다른 형식 오류에는 붙지 않음) |
| 8 | Claude 바이트 시험(명세 §8.1 hostText 14)이 템플릿을 표기 함수로 다시 조립해 리터럴과 견주는 동어반복이다 | 반영 | 실제 함수를 부른다 — 미응답 질문이 있는 `next()`의 Stop 첫 줄·끝 줄, check 스테이지 `context()`의 계획 밖 질문 줄(둘 다 배선 전 `6584910` 리터럴 전체, Codex 표기도), fix 작업 implement 의 `context()` 재현 줄(p6 fix 픽스처, Claude `2. Bash:`·Codex `2. 셸:`). 둘레 문장을 바꾸면 실패하는 것을 확인했다 |
| 9 | `install.md`의 '게이트에 걸리지 않는다'는 lease 줄만 맞다 — 진행 중 작업이 있는 설치에서 `update --templates-only`가 바꾼 `.gitignore` 블록·스킬 사본은 계획 밖 변경이 되어 verify·next·deliver 를 막고 커밋해도 풀리지 않는다 | 반영(문서 + 알림, 근본 처리는 인계) | `install.md` 머리 안내와 §5 갱신 절에 '진행 중인 작업이 있으면 반영하거나 끝낸 뒤 갱신 — 설치 파일 변경이 계획 밖 변경이 되고 커밋해도 풀리지 않는다, lease 줄 자체는 무해'를 적었다. `update`가 갱신 전후의 계획 밖 변경을 견줘 이번 갱신이 만든 것만 `!! 이번 갱신이 바꾼 설치 파일이 진행 중인 작업(<ID> · <스테이지>)의 계획 밖 변경이 됐습니다: …`와 길(사람이 되돌리고 작업을 마친 뒤 다시 갱신)로 알린다 — 막지는 않는다(MIDWAY 근거 그대로). 소스 `update`도 마지막에 새 CLI 의 `update --templates-only`를 부르므로 같은 줄이 나온다. 시험: stageFlow(check 스테이지에서 갱신 → 알림, 갱신 전부터 있던 변경은 빠짐, 다시 갱신하면 알림 없음). sandbox `r12-update-midwork`: 알림에 `.gitignore`. `outsideChanges`가 code-agent 소유 설치 파일을 따로 다룰지는 정하지 않았다(아래 인계) |
| 10 | SessionStart 넘겨받기가 `source`를 보지 않아 세션 ID 가 그대로인 `compact`(자동 압축)도 임대를 claim — 새로 연 세션 B 의 임대를 이전 세션 A 가 압축만으로 되찾고 B 가 거부된다 | 반영 | `sessionStartLease(work, session, source)` — `compact`면 `sessionStart` 없이 판정한다(같은 세션이면 갱신만, 다른 세션의 신선한 임대면 쓰지 않고 `- 이 작업의 진행 기록은 다른 세션(…)이 N분 전까지 쥐고 있습니다 — 대화 압축은 진행 기록을 넘겨받지 않으므로 이 세션의 진행 명령은 거부됩니다. … code-agent takeover`, 30분 무활동이면 그 규칙대로 넘겨받는다). 시험: lease.test(검토자 재현 순서 — A 쥠 → B startup → A 거부 → A compact 는 줄만·임대 그대로 → A 거부·B 허용, 같은 세션 압축, 무활동). sandbox `r10-compact`도 같다. 흐름도 §5.1·§7, `lease.ts` 머리 주석, `codex.md`·`design.md`·`usage.md`, `ca-next` 재개표 행. 명세 진리표 5 의 'source 와 무관'은 이 기록으로 고친다 |
| 12 | 흐름도 §1.1 은 승인 무효 문장을 `next`도 같이 쓴다고 적지만 `next`는 implement 갈래만 — check·test 는 게이트 목록(`… check 로 다시 돌리세요`), review 는 `리뷰 회차가 없습니다`를 낸다 | 반영(코드) | `next`가 implement 이후 모든 스테이지에서 스테이지 게이트보다 먼저 `계획이 승인되지 않았습니다 (<상태>). <reentryHint>`로 멈춘다(implement 갈래의 중복 검사는 지웠다). 시험: stageFlow FLOW-03(check·test·review 에서 문장 전체 일치, 커서 그대로). 기존 p5 '통과 뒤 test 명령을 약하게' 시험은 승인도 `stale-manifest`가 되므로 먼저 재진입 문장, 그 자리 재승인 뒤 `경계·검증 선언이 바뀌었습니다`로 두 단계를 본다. sandbox `r10-compact`: review·stale-docs 의 `next`가 재진입 문장 |
| 13 | deliver 에서 사람이 계획 파일을 고쳐 증거 묶임이 깨져도 `다음:`은 'deliver 동의 절차로 확인하고 반영' 그대로다 | 반영 | `nextHint` deliver 갈래가 `evidenceBroken`이면 `/ca-check (또는 /ca-next 로 사이클) — 반영할 트리가 검증 뒤 바뀌었습니다(…). code-agent verify --json 이 check 로 되감아 다시 검증합니다 — 바꾼 것을 되돌리려면 사람이 되돌립니다`. `ca-next` 재개표에 그 행, `ca-integrate` 반영 준비 문단에 한 줄. 시험: stageFlow FLOW-02(수정 전 동의 안내, 수정 뒤 verify 안내, 커서 그대로). sandbox `r1-deliver`의 '계획 파일 수정 뒤' 출력이 바뀌었다 |

고친 곳을 하나씩 되돌린 변이(문서 세션 분기·`preparationHint` 각각, hook 문구·`code-agent read` 허용, compact 판정, `next` 승인 검사·deliver 증거 갈래 각각, 재제출 안내, `update` 알림, 그리고 #8 은 `commands.ts`의 둘레 문장 세 곳)에서 해당 시험이 실패하고 되돌리면 통과하는 것을 확인했다.

- `npm run build && npm test`(Windows, 검토 반영 뒤): **1197개 중 1193개 통과·실패 0·생략 4**(플랫폼 조건), 약 205초. 구현 커밋의 1187개에 더한 10개 — stageFlow 5·hostNotation 3·lease 1·p6 1(hostNotation 의 동어반복 단언 셋은 지웠다).

### 남는 한계와 인계

- **설치 파일과 계획 밖 변경**(#9) — `update --templates-only`가 바꾼 `.gitignore` 블록·`.claude/skills/ca-*` 사본·hook 설정은 진행 중인 작업의 계획 밖 변경이 된다(이전 템플릿 변경 때부터 있던 메커니즘). 지금은 알리기만 한다. `outsideChanges`가 code-agent 소유 설치 파일(`init`이 쓰는 경로)을 따로 다룰지 — 예: 게이트에서 빼고 반영 커밋에도 넣지 않거나, 작업 중 갱신을 막거나 — 는 사용자 결정으로 넘긴다.
- **`code-agent read` 허용 범위**(#2·#11) — 세션 밖 hook 설정 언급의 예외는 연결자 없는 `code-agent read <파일>` 하나다. `cat .codex/hooks.json` 같은 일반 셸 읽기는 그대로 막는다(별칭·변수 조립은 이전과 같은 한계).
- **압축 뒤의 이전 세션**(#10) — 압축된 이전 세션은 임대를 되찾지 않지만, 사용자가 그 세션에서 계속하려면 `takeover`가 필요하다(재개표 규칙 — 사용자 확인 뒤).
