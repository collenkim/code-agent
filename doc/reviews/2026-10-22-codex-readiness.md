# Codex 실행 준비 판정 — 실제 조회·상태 구분·실행 방식별 준비

## 문제

- `codexTrust.ts`는 사용자 `config.toml`을 정규식으로 읽어 프로젝트·hook 신뢰를 추정했다. 상위 폴더 신뢰는 언제나 '확인 불가'였고, 관리 실행이 띄우는 실행 파일·계정·작업 경로와 무관한 근거였다.
- `master/hostProfile.ts`는 상위 폴더·확인 불가도 미신뢰 오류로 바꿨다. 설치 누락·프로젝트 미신뢰·hook 검토 필요·조회 실패가 한 오류로 섞였다.
- 프로젝트 설정이 꺼져 Codex 가 hook 을 읽지 않았는데도 hook 신뢰 경고를 함께 냈다 — 검토 대상을 알 수 없는 경고였다.
- `hello`의 실행 방식(`claude`·`codex`·`both`)은 설치 기록만 보고 고를 수 있다고 알렸고, 그 방식이 실행 준비가 됐는지와 막는 이유는 알리지 않았다.
- `init` 완료 안내는 설치만 알렸다. 감독(`codexTransport.ts`)의 실제 검사는 `hooks/list`의 PreToolUse 하나였고, 사전 진단과 기준이 달랐다.

## 변경 범위

현재 계약은 [흐름도](../process-flow.md) §5.2 '신뢰'·§7 관리 실행, [master 연동](../master-control.md) §3 `managedHost`·§11, [Codex 연동](../codex.md) 설치 문단, [설치](../install.md) doctor 표에 있다. 여기에는 바뀐 자리만 적는다.

- `codexReadiness.ts`(새 파일, `codexTrust.ts` 삭제): app-server 에 `initialize` → `config/read`(`includeLayers`, 작업 경로) → `hooks/list`를 묻고 판정한다. 상태는 `not-installed`·`project-untrusted`·`hooks-review`·`query-failed`·`checking`·`ready`이고, 앞 단계가 막히면 뒤 단계는 판정하지 않는다. 조회 방식은 `fresh`(doctor·CLI init, 상한 20초)·`reuse`(접수·재개·복원 — 기한 안의 판정을 다시 쓰고 없으면 8초)·`stored`(hello — 묻지 않고 판정 기록만 읽는다)다.
- 판정 기록: 사용자 키 자리의 `cache/codex-readiness/`, 키는 code-agent 버전·저장소·`CODEX_HOME`·실행 파일. 실행 파일·Codex 사용자 설정·프로젝트 hook·설정 파일의 지문을 조회 앞뒤로 찍어 같을 때만 남긴다. 기한은 10분, 조회 실패는 30초.
- hello 는 연동한 프로젝트에서만, 실행 파일이 절대 경로일 때만 분리 프로세스(`code-agent master codex-check`)로 다시 묻게 한다.
- 조회 worker: 동기 호출자가 `Atomics.wait`로 기다린다. 답을 얻으면 stdin 을 닫고 app-server 가 끝나기를 1초까지 기다린 뒤 돌려준다. 상한을 넘기거나 끝나지 않으면 Windows 는 `taskkill /T /F`로 프로세스 트리를 끝낸다.
- `hosts.ts` `hostLaunch`·`crossEnv.ts` `hostBaseEnv`: 감독과 준비 조회가 같은 실행 파일 해석과 같은 환경을 쓴다.
- `master/hostProfile.ts`: `managedHost`에 `state`·`runReadiness`(실행 방식마다 `ready`·`state`·`blocking`), `hosts[kind]`에 `state`·`checkedAt`·`target`. `both`는 주 호스트마다 그 호스트의 관리 실행 준비와 다른 호스트의 교차 검증 준비(`crossHostReadiness` — 설치와 실행 파일)를 합친다. 접수·재개·복원은 `requireRunHosts`를 쓴다.
- `master/codexTransport.ts`: 감독이 실행할 app-server 에 `config/read`·`hooks/list`를 물어 사전 진단과 같은 분류(`classifyCodexReadiness`)가 준비 완료일 때만 턴을 연다.
- `interactionService.ts`: 사람 응답 뒤 재개가 조회 실패·확인 중으로 거부되면 `blocked` 대신 `queued`로 남긴다. 미신뢰는 `blocked`다.
- `doctor.ts`: `Codex 프로젝트 신뢰`·`Codex 훅 신뢰` 두 줄을 상태별로 쓰고 물은 대상(Codex 버전·실행 파일·`CODEX_HOME`)을 붙인다. `init.ts`: CLI init 끝에 `Codex 실행 준비` 줄(준비 완료·설치 완료 · 신뢰 확인 필요·hook 검토 필요·신뢰 확인 실패·신뢰 확인 중·설치 확인 필요)과 재검사 경로.
- master-agent(별도 저장소): `pairing.mjs`가 `state`·`runReadiness`를 정규화하고 고른 실행 방식이 확정 준비(`ready === true`)일 때만 요청을 통과시킨다. `runReadiness`가 없는 옛 code-agent 는 기존 판정을 쓴다. 대시보드 카드·요청 창이 실행 방식별 준비와 차단 이유를 보여 준다.

## 설계 판단

판정 근거를 관리 실행과 같은 Codex 로 옮긴 이유: 신뢰 기록의 형식(경로 표기·상위 폴더·관리 정책)은 Codex 가 정하고 버전마다 바뀐다. 설정 파일을 다시 해석하면 Codex 와 다르게 판정할 수 있고, doctor 와 관리 실행이 다른 실행 파일·계정을 보면 둘 다 맞게 보여도 실행이 막힌다. 그래서 실행 파일 해석(`hostLaunch`)과 환경(`hostBaseEnv`)을 감독과 공유하고, 결과에 물은 대상을 싣는다.

조회 실패는 준비로 보지 않는다. 접수는 `invalid-state`로 거부하고 `detail.state`로 일시 상태임을 알린다. 다만 사람 응답 뒤 재개는 응답을 다시 받을 수 없으므로 막힘으로 굳히지 않고 다음 적용이 다시 판정한다.

hello 는 묻지 않는다. 대시보드의 hello 상한(5초) 안에 app-server 기동과 조회를 넣으면 피드 전체가 실패할 수 있다. 판정 기록을 읽고, 없으면 `checking`으로 답하며 분리 프로세스가 기록을 채운다. 인증 없는 요청이 실행을 일으키므로 연동한 프로젝트·절대 경로 실행 파일로 한정한다.

`both`의 상대 호스트는 실행 파일만 본다. 교차 검증의 Codex 는 `exec -s read-only --ephemeral`로 돌아 프로젝트 hook 을 쓰지 않으므로 신뢰가 필요 없다.

`STATE_SCHEMA`는 유지한다. 승인·증거·작업 기록의 형식은 그대로이고, 판정 기록은 사용자 키 자리의 캐시(자체 `version`)이며 `hello` 출력은 필드만 더했다.

설계 비평(하위 에이전트) 16개의 처리:

| 지적 | 처리 |
|---|---|
| 1 hello 안의 조회가 대시보드 상한을 위협 | 반영 — hello 는 기록만 읽고 분리 갱신 |
| 2 분리 갱신의 잠금 폴더 미생성 | 반영 — 잠금 전에 폴더(0700) 생성 |
| 3 제어 잠금 안의 20초 조회, 재개의 일시 상태 고착 | 반영 — 잠금 안 상한 8초, 재개는 `queued` |
| 4 `both` 상대 호스트 검사가 실제 교차와 다름 | 반영 — 실행 파일만(`crossHostReadiness`) |
| 5 `config/read` 없는 옛 Codex | 반영 — `hooks/list`만 묻고, 하나도 로드되지 않으면 `codex-unsupported`. 버전은 `target.version` |
| 6 지문을 조회 뒤에 찍음, 키에 버전 없음 | 반영 — 조회 앞뒤 비교, 키에 code-agent 버전 |
| 7 공유 임시 폴더 | 반영 — 사용자 키 자리 0700, 임시 파일 `wx`·0600 |
| 8 인증 없는 hello 가 실행을 일으킴 | 반영 — 연동한 프로젝트·절대 경로 실행 파일만 |
| 9 옛 master-agent 호환을 위해 일시 상태에서 `ready: null` | 반영하지 않음 — `ready`는 `false`로 둔다. 옛 master-agent 는 `false`를 막힘으로 보므로 '조회 실패를 실행 가능으로 보지 않는다'와 맞고, `null`은 옛 소비자가 판정 없음(허용)으로 읽을 수 있다. 새 master-agent 는 `state`로 일시 상태를 가린다 |
| 10 doctor `✗` 범위, 샌드박스 | 반영 — 조회 실패·확인 전은 `·`, 샌드박스 안은 '터미널에서 확인' |
| 11 Windows 고아 프로세스 | 반영 — 시간 초과 시 프로세스 트리 종료. 정상 종료도 app-server 가 끝난 뒤 돌려준다 |
| 12 hook 기능 꺼짐, 신뢰 외 비활성화 사유 | 반영 — `codex-hooks-disabled`(실측), 신뢰 외 사유는 `codex-project-disabled` |
| 13 doctor 와 hello 의 환경 차이 | 반영 — 결과에 Codex 버전·실행 파일·`CODEX_HOME` |
| 14 감독을 같은 분류로 | 이미 반영돼 있었다 |
| 15 hook 경로 import·교차 안내에서 조회하지 않기 | 확인 — 문제 없음. `crossNotice`·`crossEnabled`는 조회하지 않는다 |
| 16 hello 는 기록만 읽는 대안 | 1과 합쳐 반영 |

## 검증

Windows 11·Node 24.19.0·codex-cli 0.163.0, 기준 커밋 `111793d`. `npm run build` 통과.

실제 Codex 실측(임시 저장소·임시 `CODE_AGENT_HOME`, 사용자 `~/.codex`의 신뢰 기록은 바꾸지 않음):

- 신뢰 항목 없음·`untrusted`·상위 폴더만 신뢰 — 셋 다 `config/read`의 project 층에 비활성화 사유가 있고 `hooks/list`는 hook 을 돌려주지 않는다 → `project-untrusted`(`codex-project-untrusted`), hook 경고 없음.
- 프로젝트 신뢰 뒤 hook 6개 미검토 → `hooks-review`, 전부 신뢰 → `ready`, 하나의 해시가 바뀌면 그 hook(PreToolUse)만 '바뀌어 다시 검토'.
- `[features] hooks = false` → `codex-hooks-disabled`. 없는 실행 파일 → `codex-not-found`(약 20ms). Codex 샌드박스 표지 → 묻지 않고 `codex-sandboxed`.
- 조회 약 140~410ms. 기록 읽기(`stored`) 약 1ms. 설정을 바꾸면 `stored`는 `checking`, `reuse`는 다시 묻는다. 분리 갱신은 몇 초 안에 기록을 남긴다.
- 2초 상한으로 시간 초과를 일으킨 뒤 남은 node·Codex 프로세스 0개. 정상 조회 직후 작업 폴더 삭제 3/3 성공(161~266ms).

집중 시험: `codexReadiness`·`masterCodex`·`masterPairing`·`dashboardCodexResume`·`sessionRecovery`·`master` 64개, `codex`·`fullReview`·`coexistence`·`executionMode`·`hookPaths`·`codexReadiness` 86개 통과.

- 분류·조회 방식·기록·분리 갱신(`codexReadiness.test`), doctor 의 상태별 두 줄과 앞 단계 막힘(`codex.test` H5), hello·접수와 감독 직전 검사의 일치(`masterCodex.test`), 재개의 `queued`·`blocked`(`dashboardCodexResume.test`), 설치가 막히면 Codex 신뢰를 묻지 않음(`masterPairing.test`).
- doctor·CLI init 을 부르는 시험(`codex`·`fullReview`·`coexistence`·`hookPaths`·`executionMode`·`runtimeRelease`)은 실제 Codex·사용자 `CODEX_HOME` 대신 조회 대역이나 모의 app-server 로 답한다. 실제 Codex 로 조회한 직후 시험 폴더를 지우지 못하던 실패(`EPERM`)는 이 대역과 app-server 종료 대기(설계 판단 11)로 막았다.

새 시험은 새 모듈(`codexReadiness.ts`)에 의존해 기준 커밋 빌드에서 '수정 전 실패'를 확인하지 않았다.

전체 회귀(마지막 빌드, `npm test`와 같은 단계를 동시 실행 6·격리 `CODE_AGENT_HOME`으로): 1,736개 중 1,729개 통과, 실패 3개, 플랫폼 생략 4개, 약 2,806초. 실패 3개(`codex`·`consentBinding`·`consentScreens` 각 1개)는 모두 동의 확인 사이 'Git 설정'이 바뀌었다는 거부였다. 동의 스냅샷은 전역 설정을 포함하는데, 사용자 `~/.gitconfig`가 시험 도중 이 저장소 밖에서 다시 쓰였다. code-agent 에는 전역 Git 설정을 쓰는 코드가 없고, 세 시험을 다시 돌려 모두 통과했다.

실제 Codex 로 감독이 턴을 시작하는 경로(`scripts/evaluate-codex-git-permission.cjs`, 실제 모델 호출, Claude 세션 환경 변수를 뺀 터미널 실행): 접수의 준비 검사와 감독의 실행 직전 검사가 실제 app-server 에 물어 통과했고, thread 를 열어 턴을 실행했으며 hook(`sessionStart`·`userPromptSubmit`·`preToolUse` 3회·`stop`)이 실제로 돌았다. 평가의 뒷부분(Git 쓰기 단건 승인)은 모델이 PowerShell 실행 정책에 막힌 뒤 `cmd.exe /c '…'`로 다시 시도해, 승인 대상 셸에 cmd 가 없는 기존 Git 권한 판정(`codexPermissions.ts` `gitOperationCommand`, 이번에 바꾸지 않음)이 거부했고 실행은 `blocked`로 끝났다.

대시보드 화면(실제 headless Chrome·대시보드 API, 격리 카탈로그, 요청 실행·모델 호출 없음): 실제 Codex 로 조회한 code-agent `hello`(미신뢰·hook 검토 필요·준비 완료)와 확인 전 `hello`로 카드와 요청 창을 확인했다 — 실행 방식마다 준비와 막힌 이유, 미신뢰 동안 hook 검토 경고 없음, 확정 준비만 '선택 가능', `both`(주 Claude)는 Codex 미신뢰여도 선택 가능, 확인 전은 막힘, 390·320px 너비. `runReadiness`가 없는 옛 형식 code-agent 는 기존 문구를 그대로 쓴다(master-agent `smoke-dashboard-request-host.mjs`).

master-agent: `request-host`·`pairing`·`preparation`·`managed-host`·`dashboard` 44개 통과.

수치와 범위는 [근거 JSON](evidence/2026-10-22-codex-readiness.json)에 남긴다.

## 확인하지 않은 범위

- 관리 정책·Codex 갱신처럼 지문 밖의 변화는 기한(10분)으로만 반영한다.
- 실제 Codex 평가의 Git 쓰기 단건 승인은 이번 범위 밖의 거부(`cmd.exe` 재시도)로 끝까지 확인하지 못했다.
