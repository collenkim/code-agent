# 동의·업무 답 관찰·hook 경계 — 동의 쪽 재시도 규약과 사람 판단 동의

기준일: 2026-10-08. 기준 커밋: `77407a9`(C1 독립 검토 반영), 구현 커밋: `248e704`. 독립 검토 반영은 `248e704` 위 커밋이다(아래 "독립 검토 반영"). 감사 [2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)의 동의·hook 지적(묶음 C5)을 실패 원인별 재시도 규약([프로세스 흐름도](../process-flow.md) §6.4)의 동의 지점에 연결하고, 앞 묶음(C1·C2·C3)이 함수만 만들어 둔 사람 판단을 동의 `judgment`로 이었다. 현재 동작은 흐름도 §4·§5·§6.4가 정본이다.

## 결정

| ID | 판정 | 바꾼 것 |
|---|---|---|
| RP-C5 | 수정 | 대상 변경·응답 거부·적용 실패를 동의 기록 `failure{class, kind, at, detail}`로 남긴다(`status` 값은 늘리지 않는다). 갈래(`target`·`response-change`·`response-defer`·`response-none`·`response-invalid`·`apply`)마다 출력 `failure.guide`가 다르다 — 보류·명시적 선택 없음은 다시 묻지 않는다. 대상 변경은 그 동의를 폐기하고 되돌려도 다시 적용하지 않는다. 적용 때 확인 화면 불일치는 첫 확인 전이면 대상 변경(업그레이드로 화면이 바뀐 경우), 앞선 확인 뒤면 적용 실패다. 같은 동작의 최근 종료 둘이 모두 대상 변경이면 준비 결과에 `warning`. 동의 잠금은 공통 `acquireLock`(나이 회수 없음, CLI 2초·hook 10초 대기) |
| 스냅샷 범위 | 수정 | 동의 스냅샷에서 `consents/`·`log/`·`lease.json*`을 뺀다(`SNAPSHOT_EXCLUDED` — C4 임대 파일까지 한 상수). 업무 답 기록 `work/<ID>/answers.jsonl`은 남긴다 |
| judgment | 수정 | 새 동의 동작 `judgment`(`retry-grant`·`waive-finding`·`cross-stop`). 공통 검증(kind·comment 500자·id·name)은 동의 `preview` 한 곳. `retryGrant.ts`가 카운터 키마다 기록 파일·소유 함수·범위·잠금 안 재확인을 고정한다 — 검증(`patchEvidence`, 기록 뒤 다시 읽어 확인), 리뷰(`reviewBudgets`·`mutateReview`), 계획 교차(`planningCrossBudgets`·`mutatePlanning`), 계획 배정(`planningBudget`·`grantPlanningRetry`). 범위는 코드가 지금 단계·회차·테스트 트리·critic 지점에서 정하고, 모델이 주는 값은 `taskTotal`·`sameInput`의 계획 작업 ID 하나다. `waive-finding`·`cross-stop`은 C1 네 함수를 부른다 |
| CON-1·CON-2 | 수정 | 준비 티켓(저장소당 하나, 인자 글자와 무관)과 적용 티켓(동의 UUID). CLI 준비·적용은 hook 이 그 명령을 본 세션의 티켓이 있어야 하고(적용은 호스트 표지 없는 TTY 도), 동의에 준비 세션을 적어 응답·적용을 그 세션에서만 받는다. 세션 검사를 스냅샷 대조보다 먼저 해 남의 세션이 동의를 폐기하지 못한다. 세션 밖에서 응답·적용을 기다리는 동의가 있으면 30분 동안 셸을 code-agent 명령과 읽기용 git 으로 좁힌다 |
| CON-3 | 수정 | 문서 세션 쓰기 범위를 `docs begin` 때의 매니페스트로 `docs-session.json` `writable`에 고정한다. `doc/` 밖은 `.md`만, `docs link`로 연결한 문서만 더해진다. 연결은 `.md` 파일(KNOWLEDGE 는 파일 하나)만 받는다 |
| CON-4 | 수정 | 계획 승인 화면에 "경계·검증 선언" 절. 승인 때 경계 스냅샷(`<target>-<seq>.manifest.json`)과 문서별 해시를 남겨 stale-manifest·stale-docs 재승인이 바뀐 것을 보인다(`hashManifest` 값은 그대로 — 골든 고정). `setup` 화면에 추가 명령·환경 오류 문구·단계 경계 |
| CON-5 | 수정 | Codex 응답에 6자 확인 코드(지금 질문 묶음 해시). `codexReply` 마지막 질문 끝에만 있고, 이전 형식 기록은 코드 없이 받는다 |
| CON-6 | 일부 | Claude 업무 질문의 Pre/Post 를 `answers.jsonl`에 기록하고 게이트(`next`·Stop·반영·계획 배정·`status`)가 `[Answer]`를 관찰된 응답과 대조한다. 관찰할 수 없는 답은 `[Source]: 대화`로 통과시키되 승인·반영 화면에 이름과 답을 싣는다. 접수 중 답은 확정 지시서의 "접수 때 정한 것"과 같을 때만 접수 답이다. Codex 사용자 메시지 원문은 기록하지 않는다 |
| CON-8 | 수정 | Grep `glob`·Glob `pattern`의 정적 접두와 검색 루트, 키 저장소 상위 폴더 검색을 모든 모드에서 거부 |
| CON-9 | 수정 | Windows 이름 끝 점·공백 거부, 로컬 관리 공유·장치 경로를 드라이브 경로로 접어 판정 |
| CON-13 | 일부 | Claude matcher `mcp__.*`, MCP 경로 인자 판정(로컬 파일 서버는 모든 경로, 그 밖은 저장소·키 저장소 안 절대 경로·`file://`만). Codex 는 `mcp__*` 판정과 미지 도구 기록(doctor). hook 모듈 로드 실패는 진입점 JS catch 가 `hookFailureExit` 표로 닫는다. 셸 `|| exit 2`는 Codex PreToolUse 비Windows 명령에만 |
| CON-14 | 수정 | 제어 경로 아래 링크는 따라가지 않고 `link:<대상>`으로 해시(Git 이 접합점 아래 파일을 나열해도 링크 하나로). 제어 루트·제어 파일·문서 경로 자체·조상 링크는 계속 거부 |
| CON-15 | 일부 | 내용 해시 캐시(size·mtime·ctime·ino), 비플러그인 적용의 재대조 한 번, 한 스냅샷 안의 조상 검사 메모와 마지막 구성요소 lstat 재사용, 동의 잠금 중 쓰기 거부. hook timeout 명시는 하지 않는다 |
| CON-16 | 수정 | 반영 커밋에 동의 영수증 `approvals/<slug>/consents.jsonl`, 적용된 plan·request 동의마다 원장 판정 줄 대조(끝줄 삭제 감지), 원장 주석을 실제 보장으로 |
| CON-17 | 일부 | 세션 밖 셸의 hook 설정 파일 언급 거부, SessionStart·`status` 경고, 실행 중인 호스트의 hook 이 빠지면 `start`·`request begin`·`docs begin` 거부(다른 호스트·판별 불가는 경고). 폴더 단위 삭제는 막지 않는다 |
| CONS-M1 | 수정 | 계획 밖 변경의 KNOWLEDGE 예외와 반영을 `.md` 경로로 한정, `manifest check`가 `.md` 아님·코드 자리 안 KNOWLEDGE 를 ✗ |
| LRN-5 | 수정 | 직접 CLI 소스 `update`에 미리보기 + `confirmOnTerminal(update)`, 세션 밖 hook 도 소스 update 거부(`--templates-only` 제외) |

## 설계 명세와 다르게 한 것

- **hook 진입 구조** — 명세의 "최소 구조"를 C7 §3.1.1 꼴로 만들었다: `cli.ts`는 hook 하위 명령을 지연 로드하고(`HOOKS`) 모듈 로드·stdin 실패를 `hookFailureExit(hookFailureInput(...))`로 끝내며, 나머지 명령은 `cliMain.ts`(`runCommand`)로 옮겼다. 정적 import 를 그대로 둔 채 머리에서 분기할 수 없어서다(CommonJS 는 import 가 먼저 실행된다). `hook.ts`의 consent 지연 로드·`codexHook` 분기별 지연 로드·`hookLoad.test`는 C7 몫으로 남겼다.
- **스냅샷 제외 상수** — C4 FLOW-16 의 `lease.json`·`lease.json.lock`까지 한 상수에 미리 넣었다(명세 T-RP-7 이 임대 파일을 쓰고 스냅샷이 같다고 본다).
- **링크 아래 Git 파일** — Windows Git 은 접합점 아래 파일을 `ls-files`로 나열한다(sandbox 확인). 명세의 `walk` 변경만으로는 그 파일들의 조상 링크 검사에 걸려 준비가 실패하므로, 따라가지 않는 링크 아래 파일은 해시에서 뺀다(링크 자체는 `link:<대상>`).
- **스냅샷 속도** — 명세 §8 측정(1만 파일 저장소에서 2회차 ≤ 50%)을 위해 한 스냅샷 안의 조상 폴더 검사 메모와 마지막 구성요소 lstat 재사용을 더했다(해시 값 불변).
- **열린 동의 색인·제목** — 색인 읽기(`openConsent`)·적용 잠금 확인(`consentLockHeld`)·동의 제목(`CONSENT_TITLES`)을 가벼운 `consentState.ts`에 두고 `consent.ts`가 다시 내보낸다 — hook 이 consent 그래프를 읽지 않고 쓸 수 있게(C7 OPT-15).
- **`boundEvidence`** — C3 에 요청한 묶인 증거 함수를 `evidence.ts`에 만들고 `check()`가 쓰게 했다(동작 불변).
- **`reassign-total`·`same-input-repeat` 안내** — 사람 허용이 연결됐으므로 C2 가 뺀 judgment 선택지를 다시 넣었다(자리표시는 그대로). `grantPlanningRetry`의 반환 문구는 쓰지 않고 `retryGrant.ts`가 같은 꼴(`<카운터> 한도를 a→b회로 늘렸습니다(사람 판단, 동의 <앞 8자>) — <재개 명령>`)으로 만든다.
- **허용 단계** — 검증 키는 check·test·review·integrate(재현 키는 implement 까지, fix 작업만), 리뷰 키는 review, 계획 교차 키는 analysis~plan, 계획 배정 키는 analysis~plan 단계에서 받는다.
- **기존 시험** — 명세 §6.2 표 밖에서 넷을 고쳤다: `consentSnapshot` "changed `.code-agent/log/stages.jsonl` remains protected"(로그는 이제 스냅샷 밖 — 대신 T-RP-7 이 로그가 동의를 깨지 않음을 본다), 같은 파일 "ignored preparation document is included…"(대상이 바뀐 동의는 `pending`이 아니라 `failed`·`kind: target`), `planning.test`의 `write` 도우미(질문 답을 쓰면 관찰된 것으로 둔다 — 출처 판정은 `answers.test`가 본다), `agent.test` "답이 없는 질문" (관찰 전에는 출처 미확인으로 막히는 것까지 본다).
- **하지 않은 것** — T-4-5 의 stale-manifest 재승인 화면 단언은 `decide` 화면 전체가 아니라 그 절을 만드는 함수(`approvalChangeLines` — 독립 검토 반영 #3)와 `checkApproval`의 `diff`로 본다(경계가 바뀌면 계획 작업 입력 해시도 바뀌어 화면까지 가려면 계획을 다시 돌려야 한다). 모듈 로드 실패의 실제 프로세스 시험은 C7 `hookLoad.test` 몫이다.

## 남는 한계와 미확인

- Codex PreToolUse 와 UserPromptSubmit 의 `session_id`가 실제로 같은 값인지 실측하지 않았다 — 다르면 새로 준비한 Codex 동의가 모두 "준비한 세션의 응답이 아닙니다"로 막힌다(출시 전 실측 — 아래 독립 검토 반영 #16). 로컬 `codex-cli 0.160.1` 바이너리의 훅 입력 스키마는 두 이벤트 모두 `session_id`를 필수 필드로 둔다(값의 동일성은 스키마로 알 수 없다).
- Codex 셸의 실제 환경 표지(`CODEX_MARKERS`)와 PTY 실행 여부, Codex `commandWindows`의 실행 셸, Claude Code 의 PowerShell 대체 버전은 미확인이다.
- `codex exec resume`으로 보낸 프롬프트, 프로세스 안의 기록 직접 조작, `[Source]: 대화`의 자기 선언은 막지 못한다(화면에 드러낼 뿐이다). MCP 쓰기 여부는 도구 이름 동사로 추정한다.
- Claude hook 프로세스의 PATH 누락·timeout 은 여전히 비차단이다(감지만).

## 근거

- `npm test`(구현 커밋): **1123개 중 1119개 통과·실패 0개·생략 4개**(약 163초, Windows). 독립 검토 반영 뒤는 아래 절. 새 파일 `consentBinding.test.ts`(25)·`answers.test.ts`(8)·`hookPaths.test.ts`(10)·`consentScreens.test.ts`(9)·`sourceUpdateConfirm.test.ts`(1). 시작 전 같은 브랜치 전체는 1071개였다.
- sandbox(`scratchpad/sandbox-stage4/` — 원본 저장소를 소스로 쓰는 update 는 실행하지 않았다): 1만 파일 저장소의 동의 스냅샷 1회차 642ms → 캐시 2회차 313ms(48.8%), 캐시를 지우면 다시 601ms, 해시는 셋 다 같다. 첫 준비 뒤 `consents/index.json`이 생기고 열린 동의가 하나 든다. Windows Git 이 접합점 아래 파일을 나열하는 것을 확인했다. 원자료는 [consent-hook-boundary-2026-10-08.json](evidence/consent-hook-boundary-2026-10-08.json).

## 독립 검토 반영

구현(`248e704`) 뒤 독립 검토 지적 16건(major 1·minor 15)을 하나씩 코드와 sandbox(검토자가 남긴 `sandbox-stage4-review/scripts`의 `hookpaths.cjs`·`shellalias.cjs`·`subdir.cjs`를 새 빌드로 다시 돌렸다 — 원본 저장소를 소스로 쓰는 update 는 실행하지 않았다)로 확인했다. 열넷은 반영했고, 둘(#8·#16)은 권고의 한쪽 안을 골랐거나 이 PC 에서 실측할 수 없어 근거를 보강하고 인계했다. 틀린 지적은 없었다.

| # | 지적 | 판정 | 바꾼 것 |
|---|---|---|---|
| 7 (major) | hook 이 경로의 `~`를 작업 경로 상대로 풀어 Grep·Glob `path:"~/.code-agent"`·`glob`·MCP 파일 서버 경로로 키 저장소를 모든 모드에서 읽을 수 있고, 세션 밖 Write `~/<저장소>/.code-agent/…`도 hook 판정은 허용이다 | 반영 | `hook.ts` `expandTilde`(맨 앞 `~` 뒤가 끝이거나 구분자일 때만, `~user` 는 풀지 않는다)를 `readDenied`의 경로·`pattern`·`glob`, `insideStore`·`ancestorOfStore`, `repoPath`(모든 모드의 쓰기), `mcpPaths`에 둔다 — 호스트 정규화에 기대지 않는다. 이 세션의 Glob `path:"~/…"`가 홈 아래 파일을 실제로 찾는 것을 다시 확인했다. 시험: 세션 밖·작업 중 Grep·Glob·Read·MCP 일곱 꼴, 세션 밖 Write `~/<저장소>/` 다섯 경로, `expandTilde` 단위. 흐름도 §5.3 5단계 |
| 1 | `consent.ts`가 judgment 소유 모듈을 정적으로 읽어 매 PreToolUse·consent-event 가 교차·검증 흐름 모듈까지 읽는다(명세 §3.2.1 과 어긋남) | 반영 | `judgmentModules()`가 `judgment`의 준비·적용 분기에서만 `require`한다. hook 진입 그래프 66 → 59 모듈(기준 `77407a9` 53 + C5 의 동의 모듈 여섯 — `consentState`·`consentTicket`·`snapshotCache`·`consentReceipts`·`answers`·`init`), 로드 중앙값 70.4ms(기준 71.1ms, 7회). 시험: `hook.js`·`consent.js`를 새 프로세스로 읽어 `retryGrant`·`reviewJudgment`·`crossCheck`·`verificationFlow`가 없음을 본다. `hook.ts`의 consent 지연 로드는 C7 OPT-15 몫으로 남긴다 |
| 2 | 명세 §6.2 의 `consent.test` 보강 단언과 `kind: apply` 시험이 없다 | 반영 | `applying` 잔존 → `consent-apply-failed`·`apply`·사유, 스냅샷 세 시점(묻기 전·응답 중·적용 전) → `failed`·`consent-target-changed`·`target`·`확인 대상 변경: 파일 …`, 근거 문서 변경 → `failed`·`target`. 새 시험: 작업도 접수도 없는 저장소의 abort 동의 — 적용 때 도메인 함수의 Stop 이 `kind: apply`와 그 첫 줄 사유로 남고 다시 적용하지 않는다 |
| 3 | T-4-5 재승인 화면의 바뀐 것 절과 이전 기록용 문구를 시험하지 않는다 | 반영 | `commands.ts` `decide`의 절 조립을 `approvalChangeLines(state)`로 꺼내 stale-manifest(차이·경계 스냅샷 없음 문구)·stale-docs(경로·문서별 해시 없음 문구)·변경 없음을 `consentScreens.test`에서 본다 |
| 4 | `doc/codex.md` 판정 대상 문장이 MCP 판정과 어긋나고, 갱신 절에 미리보기·`update` 입력과 세션 밖 hook 거부가 없다 | 반영 | 판정 대상을 셸·패치·`mcp__*` 경로 인자(그 밖은 이름만 기록)로, 갱신 절에 호스트 밖 TTY 미리보기·`update` 입력, 비TTY·호스트 셸 거부, 대화 안의 `update` 동의, 세션 밖 hook 거부 |
| 5 | README 와 CLI USAGE 가 무인 update 로 적고, consent prepare·apply 의 티켓 조건이 없다 | 반영 | README 표·갱신 절(미리보기·`update` 입력·비TTY·호스트 셸 멈춤, `--templates-only`는 확인 없음, 모델 셸 실행은 hook 거부), USAGE update 줄 `(호스트 밖 TTY 에서만)`과 consent 세 명령의 티켓·TTY 조건 |
| 6 | 흐름도 §4.2 그림의 Codex 응답에 확인 코드가 없고, §6.2 가 옛 `cli.ts` 줄을 인용한다 | 반영 | 그림 `… 번호들 확인코드`, `cliMain.ts` `runCommand`의 verify 분기 |
| 8 | 열린 동의 창(30분)이 풀린 뒤에도 답하지 않은 동의는 `pending`이라 프로세스 안 위조가 다시 통하고, 열린 동의가 없을 때의 자기 완결 한 줄도 막히지 않는데 문서가 드러내지 않는다 | 반영(안 b — 문서) | 응답 구간을 창과 맞추는 안(a)은 고르지 않았다: Codex 응답은 사람이 답할 때 Pre·Post 가 함께 합성되므로 30분 넘게 읽고 답한 사람의 정상 응답이 거부되고(사람 확인 지점을 늘린다), 자기 완결 한 줄(F1·F2)은 (a)로도 막히지 않는다 — 명세 §3.3.5 의 TTL 거부 결정과 "프로세스 안 조작은 막지 못한다" 한계(§3.3.6)를 유지했다. `design.md` 한계 문단·`usage.md` 동의 절·`codex.md` 한계 문장·흐름도 §4.2 에 "30분이 지나도 답하지 않은 동의는 다시 보호 밖 — 새로 준비"와 자기 완결 한 줄을 적었다 |
| 9 | 관리 공유 접기 목록에 IPv6 리터럴 UNC·이 PC 의 LAN 주소·FQDN 이 없어 세션 밖 `.code-agent` 쓰기가 비켜 간다 | 반영 | `layout.ts` `localHost` — `localhost`·PC 이름과 `os.networkInterfaces()` 주소(IPv6 는 영역을 떼고 URL 정규화로 비교), `*.ipv6-literal.net` 디코딩. 이름으로 접지 못한 UNC(FQDN·사용자 공유)는 `shareInside`가 공유에 닿을 때 가장 가까운 기존 조상부터 (dev, ino)를 저장소 루트와 견주어 저장소 안으로 접는다(쓰기 판정 `repoPath`). 이 PC 에서 `\\localhost`·`\\0--1.ipv6-literal.net`·`\\127.0.0.1`·`\\<PC 이름>` 의 `C$` 가 로컬 경로와 같은 (dev, ino)임을 확인했다. 시험: 접기 단위(IPv6 리터럴·`[::1]`·남의 주소·비win32), 세션 밖 Write·Codex `apply_patch`의 IPv6 리터럴 경로 거부, `shareInside` 단위(관리 공유에 닿지 못하면 건너뛴다). 읽기 쪽의 FQDN·사용자 공유 별칭은 이름 목록만 본다(키 파일 이름 검사는 그대로) |
| 10 | 세션 밖 셸 판정이 `.code-agent./`·`CODE-A~1`·`.claude./settings.json` 같은 Windows 별칭을 놓친다 | 반영 | `mentionsState`가 대소문자·이름 끝 점·공백·8.3 `code-a~<n>`을, `HOST_CONFIG`가 `.claude`·`.codex` 끝 점·공백, `claude~<n>`·`codex~<n>`, `./`, `settin~<n>.jso`·`hooks~<n>.jso`·`config~<n>.tom`을 본다(이 PC 의 실제 8.3 이름을 `dir /x`로 확인). `git log HEAD~1`·`.code-agent.json`은 걸리지 않는다. 와일드카드·변수 조립은 그대로 한계다 |
| 11 | Q 번호 없는 관찰 응답이 같은 정규화 답을 가진 모든 질문을 '관찰됨'으로 만든다 | 반영(더 엄격하게) | `observedMatch`는 같은 Q 번호의 응답만 본다 — 질문 본문 해시 대체는 넣지 않았다(기록된 해시는 도구 질문 원문이고 `questions.md` 본문은 파서가 보관하지 않아 대조가 글자 하나에도 깨진다. ca-answer 1-5 가 질문을 Q 번호로 시작하게 한다). Q 없는 응답은 기록만 한다. 시험: 검토자의 재현(Q 없는 '예'·'A' → Q4·Q5 는 출처 미확인), 같은 Q 번호 응답은 관찰됨. ca-answer 1-5·흐름도 §4.3 |
| 12 | 하위 폴더 세션의 적용 명령 결속 검사가 하위 폴더에서 동의 기록을 읽어 적용 티켓이 나오지 않는다 | 반영 | `consentCommandGuard`가 `findRepoRoot`로 티켓·CLI 와 같은 루트의 기록을 읽는다. 시험 T-1-6b: 하위 폴더 세션의 준비 → 응답 → 다른 세션 거부 → 같은 세션 finish 티켓 → CLI 적용. 검토자 `subdir.cjs`도 `applied`. `decideTool`의 루트 전체를 바꾸는 안은 인계로 남겼다(아래) |
| 13 | Codex 확인 코드는 모델도 보는 값인데 주석·문서가 사람이 끝까지 본 것을 묶는다고 적는다 | 반영 | `consent.ts` `replyCode`·`codexHook.ts` 주석, `codex.md` 2항·한계 문단, `design.md` 동의 문단, 흐름도 §4.2 를 "요약이 잘려 코드 줄이 빠지는 실수를 막을 뿐 사람 입력의 증명은 아니다(`codex exec resume` 한계와 같다)"로. Codex ca-answer 2단계에 "요약을 줄인 채 코드 줄만 보여 주면 확인이 되지 않는다" |
| 14 | 세션 밖 hook 의 소스 update 정규식이 `code-agent  update`·`npx`·`cli.js update`를 놓치고, 직접 CLI 확인이 호스트 표지를 보지 않는다 | 반영(범위 한정) | `updateFromSourceConfirmed`가 호스트 표지(`hostMarked`)가 있으면 미리보기 전에 `HOST_SHELL_UPDATE`로 거부한다(동의 적용의 `terminalCaller` 규칙과 같다). hook `SOURCE_UPDATE`가 공백 여러 칸·`npx`·경로·`.cmd`·`cli.js update`를 보고 `--templates-only`는 연다. 시험: 표지가 있으면 fetch·npm 없이 거부, 기존 비TTY 시험은 표지를 지우고 돈다(이 저장소의 시험을 Claude Code 안에서 돌려도 같은 결과), 명령 꼴 넷. `confirmOnTerminal`·`requireTerminal` 전체에 표지 규칙을 거는 안은 approve·deliver·confirm 같은 기존 직접 경로를 바꾸므로 인계로 남겼다 |
| 15 | 새 거부 문구가 usage 오류 표에 없다 | 반영 | `PREPARE_UNOBSERVED`·`APPLY_UNOBSERVED`·준비 세션 불일치·적용 세션 불일치(CLI·hook)·열린 동의 창·Codex 확인 코드·적용 중 쓰기·소스 update(hook·호스트 셸)·hook 설정 셸·이름 끝 점·공백·키 저장소 상위 폴더 검색·시작 게이트 행 |
| 16 | 새 Codex 동의가 PreToolUse 와 UserPromptSubmit 의 `session_id` 동일성에 기댄다(미실측) | 일부(근거 보강·인계) | 이 PC 의 Codex 는 로그인돼 있지 않아(`codex login status` → `Not logged in`) 실제 이벤트를 찍을 수 없었다. 대신 로컬 `codex-cli 0.160.1` 바이너리에 든 훅 입력 JSON 스키마를 읽었다 — `pre-tool-use.command.input`·`user-prompt-submit.command.input` 모두 `session_id`(string)와 `turn_id`가 필수다(존재는 확인, 값의 동일성은 미확인). 폴백(Codex 기록은 첫 응답 결속)은 넣지 않았다 — 실측 전에 결속을 약하게 하는 쪽이라, 다르면 막히고(fail-closed) 사람의 TTY 경로가 남는 지금 동작을 유지한다. 실측은 인계 |

새·바뀐 시험: `consent.test` +1(도메인 함수 실패)과 기존 다섯의 단언, `consentBinding.test` +2(하위 폴더 finish·judgment 모듈 미로드), `hookPaths.test` +6(`~` 둘·Windows 별칭 둘·셸 별칭·update 명령 꼴), `answers.test` +1, `sourceUpdateConfirm.test` +1과 기존 하나의 환경 고정, `consentScreens.test` 기존 하나의 단언. 고친 곳을 하나씩 되돌린 dist 변이 열다섯 가지(judgment 정적 로드, `applying` 잔존 kind, 도메인 실패 kind, 스냅샷 폐기 kind, 경계 스냅샷 없음 문구, 문서별 해시 없음 문구, `~` 전개 읽기·쓰기, IPv6 리터럴, 상태 별칭, 설정 8.3, Q 없는 관찰, 하위 폴더 기록 루트, 호스트 셸 update, update 명령 꼴)에서 각각 해당 시험이 실패하고, 되돌리면 통과하는 것을 확인했다(`scratchpad/c5/mutate.cjs`). `shareInside`를 `repoPath`가 부르는지는 이 PC 에서 이름 목록 밖의 로컬 별칭(FQDN·`127.1` 등)이 닿지 않아 hook 경유로는 시험하지 못하고 함수 단위로만 본다.

- `npm run build && npm test`(Windows, 검토 반영 뒤): **1134개 중 1130개 통과·실패 0·생략 4**(플랫폼 조건), 약 166초. 구현 커밋의 1123개에 더한 11개는 위 목록이다. 원자료는 [consent-hook-boundary-2026-10-08.json](evidence/consent-hook-boundary-2026-10-08.json)의 `independentReview`.

### 인계

- **C7 (OPT-15)** — hook 진입 그래프에서 judgment 모듈은 뺐지만 `hook.ts`는 여전히 `consentCommandGuard` 때문에 `consent.ts`(→ `commands.ts`·`deliver.ts` 등)를 읽는다. consent-event 는 consent.ts 가 필요하므로, `hook.ts`의 consent 지연 로드(적용 명령 꼴일 때만)와 `consent.ts`의 명령 모듈(`commands`·`deliver`·`docsCommands`·`validate`) 분기별 지연 로드를 C7 이 `hookLoad.test`와 함께 한다.
- **하위 폴더 세션의 hook 루트** — `decideTool`의 `repoRoot`가 `CLAUDE_PROJECT_DIR` 그대로라, Claude 를 저장소 하위 폴더에서 열면 hook 이 진행 중인 작업·세션·열린 동의 창을 보지 못하고 세션 밖 규칙만 적용한다(Codex 는 `findRepoRoot(cwd)`라 해당 없음). 이번에는 적용 명령 결속(#12)만 고쳤다. 루트 전체를 `findRepoRoot`로 맞추는 것은 상대 경로 해석 기준·모든 모드 판정이 바뀌므로, Claude Code 가 하위 폴더에서 연 세션에 저장소 루트의 `.claude/settings.json` hook 을 싣는지부터 실측한 뒤 별도 단계로 한다.
- **직접 CLI 확인의 호스트 표지** — `confirmOnTerminal`·`requireTerminal`(approve·deliver·confirm·setup baseline·model·plugin·knowledge prune)은 아직 호스트 표지를 보지 않는다. Codex 가 모델 명령을 PTY 로 돌리고 입력을 넣을 수 있다면(미확인) 세션 밖에서 그 확인 단어를 모델이 넣을 수 있다. 소스 update 와 같은 규칙(`hostMarked`면 거부, Claude `!` 셸의 영향 확인)을 걸지는 Codex 셸 표지·PTY 실측(`CODEX_MARKERS`)과 함께 정한다.
- **Codex `session_id` 실측(출시 전)** — 로그인된 Codex 에서 `scripts/diagnose-codex-hooks.cjs`를 도구 호출이 있는 프롬프트로 바꿔(또는 같은 꼴의 격리 진단으로) PreToolUse·UserPromptSubmit 의 `session_id`를 찍어 evidence 에 남긴다. 다르면 Codex 준비 티켓의 결속 키를 바꾸거나 Codex 기록에 한해 첫 응답 결속으로 떨어지는 경로와 그 한계 문서를 둔다.
