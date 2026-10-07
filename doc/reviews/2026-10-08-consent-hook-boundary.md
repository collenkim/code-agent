# 동의·업무 답 관찰·hook 경계 — 동의 쪽 재시도 규약과 사람 판단 동의

기준일: 2026-10-08. 기준 커밋: `77407a9`(C1 독립 검토 반영). 감사 [2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)의 동의·hook 지적(묶음 C5)을 실패 원인별 재시도 규약([프로세스 흐름도](../process-flow.md) §6.4)의 동의 지점에 연결하고, 앞 묶음(C1·C2·C3)이 함수만 만들어 둔 사람 판단을 동의 `judgment`로 이었다. 현재 동작은 흐름도 §4·§5·§6.4가 정본이다.

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
- **하지 않은 것** — T-4-5 의 stale-manifest 재승인 화면 단언은 화면 함수가 아니라 `checkApproval`의 `diff`로 본다(경계가 바뀌면 계획 작업 입력 해시도 바뀌어 화면까지 가려면 계획을 다시 돌려야 한다). 모듈 로드 실패의 실제 프로세스 시험은 C7 `hookLoad.test` 몫이다.

## 남는 한계와 미확인

- Codex PreToolUse 와 UserPromptSubmit 의 `session_id`가 실제로 같은 값인지 실측하지 않았다 — 다르면 새로 준비한 Codex 동의가 모두 "준비한 세션의 응답이 아닙니다"로 막힌다(출시 전 `scripts/diagnose-codex-hooks.cjs`로 확인).
- Codex 셸의 실제 환경 표지(`CODEX_MARKERS`)와 PTY 실행 여부, Codex `commandWindows`의 실행 셸, Claude Code 의 PowerShell 대체 버전은 미확인이다.
- `codex exec resume`으로 보낸 프롬프트, 프로세스 안의 기록 직접 조작, `[Source]: 대화`의 자기 선언은 막지 못한다(화면에 드러낼 뿐이다). MCP 쓰기 여부는 도구 이름 동사로 추정한다.
- Claude hook 프로세스의 PATH 누락·timeout 은 여전히 비차단이다(감지만).

## 근거

- `npm test`: **1123개 중 1119개 통과·실패 0개·생략 4개**(약 163초, Windows). 새 파일 `consentBinding.test.ts`(25)·`answers.test.ts`(8)·`hookPaths.test.ts`(10)·`consentScreens.test.ts`(9)·`sourceUpdateConfirm.test.ts`(1). 시작 전 같은 브랜치 전체는 1071개였다.
- sandbox(`scratchpad/sandbox-stage4/` — 원본 저장소를 소스로 쓰는 update 는 실행하지 않았다): 1만 파일 저장소의 동의 스냅샷 1회차 642ms → 캐시 2회차 313ms(48.8%), 캐시를 지우면 다시 601ms, 해시는 셋 다 같다. 첫 준비 뒤 `consents/index.json`이 생기고 열린 동의가 하나 든다. Windows Git 이 접합점 아래 파일을 나열하는 것을 확인했다. 원자료는 [consent-hook-boundary-2026-10-08.json](evidence/consent-hook-boundary-2026-10-08.json).
