# 현재 검증 상태

검증 환경은 Windows 11, Node 24.19.0, PowerShell 5.1.26100이다. 실제 호스트는 Claude Code 2.1.312, codex-cli 0.165.0이 설치돼 있다. [집계 자료](evidence/2026-10-29-validation.json)는 실행별 결과이며 서로 다른 시험 수를 합산하지 않는다. 재현 기준선은 [재현 기준선 자료](evidence/2026-10-29-repro-baseline.json)에 있다.

## 자동 시험

계획 배정 예산 구간(정상 변경과 실패 재시도의 예산 분리)이 닿는 시험 파일과 계획 흐름을 함께 쓰는 이어가기·깨우기 시험을 `node --test --test-concurrency=4`로 묶음별로 실행했다. 닿는 범위는 계획 배정 한도 판정, 사람 허용 범위와 동의 미리보기, `planning status` 사용량, 요구 개정·실행 회차, 교차 critic 과 검증·리뷰 쪽 허용 범위(같은 `grantScope`), 상태 형식 세대, 문서 대조다. 묶음은 동시에 돌리지 않고 차례로 돌렸다.

| 묶음 | 파일 | 결과 | 소요 |
|---|---|---|---:|
| 예산 구간·재시도 규약·문서 대조·동의 | `planningBudgetEpoch`·`retryPolicy`·`docSync`·`docs`·`consentBinding`·`consentOutput` | 143건 모두 통과(`retryPolicy`·`consentBinding`은 기대값을 고친 뒤 다시 실행) | 154.3초 |
| 계획 | `planning`·`planningRecovery`·`planningRetry`·`planningChain` | 125건 모두 통과(`planningRecovery`는 기대값을 고친 뒤 다시 실행) | 213.5초 |
| 요구 개정·상태 조회·연쇄 | `requestRevisionFlow`·`requestRevisions`·`stateView`·`planningChainFlow`·`consentSnapshot` | 78건 모두 통과 | 125.7초 |
| 교차·검증·리뷰 허용 | `crossReview`·`planningCross`·`finalReverify`·`fullReview`·`verification-flow` | 143건 모두 통과 | 277.6초 |
| 상태 형식 세대 | `runtimeRecovery`·`runtimeRelease`·`installRobustness`·`dashboardContinuation` | 33건 모두 통과 | 61.2초 |
| 이어가기·깨우기·재현 | `agentContinuation`·`wakeHook`·`hookLoad`·`reproScenarios` | 50건 모두 통과 | 35.0초 |

- 기대값을 고친 시험은 새 표시를 따른다 — 허용 범위의 `@<구간>`, 허용 문구의 구간 이름, `planning status` 총 배정의 `epoch`, 한도 안내의 "이 예산 구간에서". 다시 실행한 `retryPolicy`·`consentBinding`은 81건, `planningRecovery`는 51건 모두 통과했다.
- `planningBudgetEpoch`는 다음을 본다.
  - 같은 구간에서는 정상 완료까지 세어 6회에서 막는다. 머리말만 바뀐 개정은 요구 항목이 같아 같은 구간이다.
  - 확정한 요구 항목이 바뀌면 새 구간이다. 과거 성공 6회 때문에 허용을 묻지 않고 바로 배정하며, `planning status`는 사용량 1/6 과 구간 밖 배정 6(`earlier`)을 보인다. 지난 구간은 `retry.epochs`에 남고 이전 배정 기록은 지우지 않는다.
  - 준비 반복·작업 정의 변경·입력 파일 변경은 구간을 바꾸지 않아 한도가 그대로다. 모델이 이 길로 한도를 다시 열 수 없다.
  - 새 실행 회차는 새 구간이다. 요구 항목 기록 전(legacy) 구간은 같은 회차에서 항목을 기록해도 다시 세지 않는다.
  - 같은 입력의 실패는 구간과 무관하게 3회에서 막는다. 이전 구간의 허용과 구간 표기 없는 허용은 판정에 쓰이지 않는다.
  - 구간 기록이 없는 이전 기록은 이행 시각부터 지금 구간으로 이어받아 이행 전과 같은 사용량(6/9, 이전 허용 포함)을 보인다. 구간 표기 없는 이전 허용은 그 이행 구간에서만 쓰인다. 새 허용은 `planning:<작업>@<구간>`에 기록되고 동의 확인 화면의 지점에 구간 이름이 실린다. 다음 구간에서 한도는 기본값으로 돌아간다.
- `wakeHook`·`agentContinuation`은 담당 완료 뒤 끝나는 턴의 1회 이어가기, 처리하지 않은 완료가 남은 채 쉬는 메인의 1회 깨우기, 같은 완료의 재알림·동시 hook·재시작에서 한 번만 효과가 나는지, 사람 판단 자리에서 멈추는지를 본다. `reproScenarios`의 `completionStall`은 격리 가짜 호스트에서 완료 뒤 사람 입력 없이 다음 행동까지 20초(`CONTINUATION_BOUND_MS`) 안에 이어지는 것을 고정한다. 이 상한은 자식 프로세스 기동을 포함한 시험 환경의 값이며 실제 호스트 지연의 기준이 아니다.
- 이 변경이 닿지 않는 시험 파일(설치·doctor·update, 관리 실행, 검증 명령 등)은 다시 실행하지 않았다.

이 변경 뒤 전체 시험은 실행하지 않았다. 마지막 전체 시험은 요구 개정 전 코드(`cd8a5f8`)에서 실행했으며 결과는 1807건 중 1803 통과·4 생략·0 실패다. 생략 4건은 플랫폼 조건이다.

## 실제 호스트

담당 완료 뒤 이어가기·깨우기의 실제 호스트 근거다. 예산 구간은 실제 호스트로 실행하지 않았다 — 판정은 결정적 코드이고 범위 시험이 고정한다.

`CODE_AGENT_LIVE_EVAL=1 node scripts/evaluate-planning-hosts.cjs claude s2-continuation --through-impact --timeout-seconds 900`으로 Claude Code 2.1.312 print 모드(`-p`)를 한 번 실행했다. 메인과 담당은 sonnet 이고 한도는 $1.5 다. 준비·요구·모델 선택 동의는 합성 fixture 이며 사람의 승인이 아니다. 첫 프롬프트 뒤 사용자 메시지는 없다.

| 구간 | 관찰 |
|---|---|
| 분석 담당 | Agent 도구가 담당을 백그라운드(`isAsync: true`)로 띄웠다. 메인은 "완료 알림을 기다린다"며 턴을 끝냈다 — 실행 중인 담당이 있어 Stop 은 막지 않았다. 담당은 형식 오류로 한 번 되돌려진 뒤(되돌림 대기) 같은 담당이 이어서 끝냈다 |
| 완료 → 다음 명령 | 완료 알림이 큐에 들어가 호스트가 새 턴을 열었다. 담당 완료 hook 기록 3.6초 뒤 `planning advance`(ready-for-gate)가 시작됐다. 이어서 `next`(분석 게이트 통과·영향도 진입)와 `planning advance`(영향도 배정)가 실행됐다 |
| 영향도 담당 | 같은 꼴이다(되돌림 1회 뒤 완료). 완료 2.7초 뒤 `planning advance`가 ready-for-gate 를 냈다 |
| 끝 | 지시대로 영향도 게이트 앞에서 멈췄다. 마지막 턴 끝에서는 완료가 이미 처리돼 막지 않았다 |

세션 시작부터 마지막 턴 끝까지 2분 32초가 걸렸고 비용은 $0.47 이다. 담당 2명이 모두 완료됐고, 보고 단계의 문서 내용 게이트도 통과했다. 사용량 보고(`usageReport`)는 메인 대화 기록의 완료 알림 두 개를 찾았고, 각 알림에서 다음 행동까지 1.8초씩 걸렸다.

- print 모드에서는 호스트가 완료 알림으로 새 턴을 열어 이어갔다. Stop 의 이어가기 차단은 필요하지 않았고 일어나지 않았다. 실행 중 대기와 정상 종료를 막지 않는 것은 확인했다. 다만 이어가기 차단이 실제 호스트의 턴을 잇는 모습은 이 실행에서 관찰하지 못했다.
- 대화형 세션에서 멈춘 자리는 실제 호스트로 다시 확인하지 않았다. 2.1.306 대상 프로젝트의 세션 기록에서는 인계 메시지를 받은 메인이 턴을 끝냈고, 완료 알림이 새 턴을 열지 않았다. 여기서는 대화형 TTY 를 구동할 수 없어 이 자리를 격리 가짜 호스트(`completionStall`)로만 확인했다.
- 관리 실행(`master supervise`)도 같은 print 모드(`--output-format stream-json`)로 호스트를 띄운다. 하지만 관리 실행 자체는 돌리지 않았다. Codex 실제 호스트도 실행하지 않았다.
- 이 실행의 보고서는 호스트를 다시 부르지 않고 같은 판정(`advancePlanning`·`next`)을 따로 실행해 만들었다. 보고서·로그·임시 저장소는 `dist` 아래에 두며 커밋하지 않는다.

### 쉬는 메인 깨우기

Claude Code 2.1.312 바이너리에서 hook 옵션 `asyncRewake`는 "백그라운드로 돌다가 exit 2 면 모델을 깨운다"이다. 실행 경로를 보면 asyncRewake hook 은 대화형이거나 스트리밍 입력일 때만 백그라운드로 돌고, 그 밖의 `-p`에서는 동기로 돈다. exit 2 의 stderr 는 다음 메시지로 큐에 들어간다.

임시 폴더의 프로젝트 hook 으로 스트리밍 입력 모드(`-p --input-format stream-json`, haiku, 한도 $0.3)를 한 번 실행했다. SubagentStop 에 15초 뒤 exit 2 로 끝나는 asyncRewake hook 을 달았고, 첫 메시지 뒤 사용자 메시지는 없다. 비용은 약 $0.013 이다.

| 시각(UTC) | 관찰 |
|---|---|
| 08:43:11.7 | 메인이 Agent 도구로 담당을 백그라운드로 띄우고 턴을 끝냈다 |
| 08:43:13.2~14.6 | 담당이 끝났다. SubagentStop hook 이 시작됐고(13.3), 메인은 완료 알림으로 열린 턴에서 답하고 쉬었다(14.6) — hook 이 담당 종료를 막지 않았다 |
| 08:43:28.3 | hook 이 exit 2 로 끝났고 26ms 뒤 메인의 새 턴이 열렸다. 메인은 깨움 문구대로 답했다(29.6) |

- SubagentStop 입력에는 `transcript_path`·`agent_id`·`agent_type`·`agent_transcript_path`·`last_assistant_message`가 있고, 메인 대화 기록에는 `"version":"2.1.312"`가 있다. hook 환경은 `CLAUDE_CODE_ENTRYPOINT=sdk-cli`·`CLAUDE_CODE_SESSION_ATTENDED=0`이다. 이 대화형 세션의 hook 환경은 `cli`·`1`이다.
- `-p`와 스트리밍 입력을 hook 환경으로 가를 표지가 없다. 그래서 `wake-event`는 대화형 CLI(`cli`)에서만 기다리고, 그 밖에서는 바로 0 으로 끝낸다. print 모드와 스트리밍 입력에서는 호스트가 완료 알림으로 새 턴을 열어 이어갔다.
- 대화형 세션에서 `wake-event`가 메인을 깨우는 모습은 실제 호스트로 확인하지 않았다. 여기서는 대화형 TTY 를 구동할 수 없다. 근거는 바이너리 실행 경로, 위 스트리밍 입력 실측, 격리 시험(`wakeHook`)이다.

## 재현 기준선

[재현 기준선 자료](evidence/2026-10-29-repro-baseline.json)는 개선 전 빌드에서 `scripts/repro-baseline.cjs --repeat 3`으로 남겼다(fixture `sha256:4be6f82c570ee977`, 세 번 모두 같은 사실).

| 시나리오 | 개선 전 사실 | 지금 | 소요 중앙값(전→후) |
|---|---|---|---:|
| `amendment` | 확정한 요구 2개를 같은 ID 의 추가 요구 1개가 대체한다 | 추가 요구만 든 전체 목록 초안은 거부되고 확정 요구가 남는다. 확정 개정을 부모로 한 변경안(추가 1)이 기존 요구 2개를 보존한 새 개정이 된다 | 17ms → 79ms |
| `staleIds` | 지시서의 요구 ID 는 REQ-1·REQ-2 인데 다시 준비한 분석 배정은 REQ-1 만 가진다 | 다시 확정한 개정으로 준비하면 분석 배정이 REQ-1·REQ-2 를 가진다 | 18ms → 60ms |
| `completionStall` | 담당 완료 뒤 Stop 이 턴을 잇지 않아 사람 입력이 있어야 다음 행동을 실행한다 | 완료 뒤 끝나는 턴을 Stop 이 한 번 막고 사유에 `planning advance`를 싣는다. 사람 입력 없이 다음 행동(ready-for-gate, 게이트 통과)으로 이어진다. 이어 붙인 턴·중복 완료 알림(SubagentStop exit 0)·다른 세션의 턴 끝은 막지 않는다 | 2710ms → 5344ms |

지금 결과는 재생성 가능하므로 커밋하지 않는다. `node scripts/repro-baseline.cjs --repeat 3 --out <후.json>` 뒤 `--compare doc/reviews/evidence/2026-10-29-repro-baseline.json <후.json>`으로 다시 만든다. 지금 시나리오는 지금 계약을 보므로 fixture 해시가 다르다(`sha256:17ab377fa3014d4f`). 비교 스크립트는 이를 알린다. 격리 호스트의 대기 시간은 자식 프로세스 사이 간격이다. 따라서 실제 세션의 대기 시간은 재현하지 않으며, 비교 대상은 Stop 차단 여부·사람 입력 필요 여부·구간 분류다. `reproScenarios.test.ts`는 지금 동작을 고정한다.

## 상태 형식 세대

상태 형식 세대는 20이다. 계획 사람 허용의 범위가 예산 구간을 담고(`planning:<작업>@<구간>`·`planning:<작업>:<입력 해시>@<구간>`), 계획 기록의 `retry`에 지금 구간 `epoch`와 지난 구간 `epochs`가 생겼다. 구간을 모르는 이전 릴리스(세대 19 이하)는 이 프로젝트에 적용되지 않는다 — 그 릴리스는 구간 표기가 붙은 허용을 읽지 못하고 구간 밖 배정까지 세기 때문이다. 세대 19 의 기록은 첫 기록 때 지금 구간을 이행 시각(`retry.since`)부터 이어받아(`migrated`) 이행 전과 같은 사용량을 보이고, 구간 표기 없는 이전 허용은 그 이행 구간에서만 쓰인다. 담당 실행 장부(`agent-runs.json`)는 게이트·배정·승인 판정에 쓰지 않는 이어가기 안내용이라 세대에 넣지 않는다.

## 템플릿 예산

`node scripts/template-sizes.cjs --suggest`는 LF로 정규화한 글자 수에 파일별 1.03, 흐름 합계 1.02를 곱하고 100자 단위로 올린다. 흐름 예산은 Claude 49200자(현재 48331), Codex 45900자(현재 44958)다. 공통 계획 절차는 `ca-plan/contract.md`에 두며 예산은 4100자다. 검증 기록·비밀 값·언어 규칙을 포함한 CODEX.block 예산은 2200자다. 같은 ID 의 요구 변경안 형식은 `ca-request/amend.md`(1284자, 예산 1300)에 둔다. 파일별 상한은 `src/test/templateBudget.test.ts`가 관리한다.

## 배포와 검증 한계

- 패키지 dry-run은 223개 파일이다. `dist/agent/agentHook.js`·`dist/agent/agentRuns.js`·`dist/agent/wakeHook.js`를 포함하고 `dist/test`는 포함하지 않는다. 재현 시나리오와 기준선 스크립트는 이 소스 저장소에서만 실행된다.
- 예산 구간은 계획 배정(작업 총 배정)에만 있다. 검증·리뷰 회차 한도와 교차 지점 한도는 지금처럼 그 회차·지점에서 센다. 비용·시간 안전장치는 따로 두지 않았다 — 작업 총 배정·같은 입력 실패·동시 실행 한도, 시작·실행 기한(고아), 반복 전달 실패 차단이 그 몫이다.
- 새 ID 로 준비한 계획 작업은 그 작업의 예산을 따로 받는다. 이것은 지금 동작이며 계획 작업 수 상한(100개)이 막는다.
- 진행 중 대상(`target`) 변경은 요구 변경으로 받지 않는다. 다른 대상이면 사람이 그 대상의 ID 로 접수한다.
- 분석으로 되감은 뒤 같은 회차의 구현 Task 통과 판정은 기준 커밋과 다른 파일로 본다. 같은 회차에서 이미 고친 Task 파일은 다시 고치지 않아도 그 판정을 지난다 — 새 개정의 반영은 계획 재승인과 검증·리뷰 재실행이 확인한다.
- 이전 회차는 작업 브랜치(없으면 기준 브랜치)의 이력에서 찾는다. 반영 커밋을 기준 브랜치에 넣지 않은 채 작업 브랜치를 지웠으면 첫 회차로 시작한다.
- 쉬는 메인 깨우기는 Claude 대화형 CLI 에서 확인한 호스트 버전(2.1.312 이상)과 asyncRewake 설치가 있을 때만 동작한다. 그 밖에서 완료 알림이 새 턴을 열지 않으면 다음 세션 시작 요약이 처리하지 않은 완료를 알린다. Codex 에는 깨우기 hook 이 없다.
- 실제 Claude 대화형 세션에서 깨우기·이어가기 차단이 턴을 잇는지, 실제 Codex 에서 이어가기 차단이 턴을 잇는지는 확인하지 않았다. Codex 의 완료 알림은 관측하지 않는다.
- 백그라운드로 돌린 긴 검증 명령(Bash `run_in_background`)의 완료는 담당 실행 장부에 남지 않는다. 그래서 이어가기 대상이 아니다.
- Codex UserPromptSubmit 시각의 타임라인 기록은 실제 Codex 에서 확인하지 않았다.
- 자동 회귀를 실제 사람 승인·전체 모델 완주·사용자 사용성의 증거로 해석하지 않는다. 실제 호스트 동작 설명에 붙은 버전은 관찰 조건이며 지원 최소 버전을 뜻하지 않는다.
