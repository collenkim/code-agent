# 현재 검증 상태

검증 환경은 Windows 11, Node 24.19.0, PowerShell 5.1.26100이다. 실제 호스트는 Claude Code 2.1.312, codex-cli 0.165.0이 설치돼 있다. [집계 자료](evidence/2026-10-29-validation.json)는 실행별 결과이며 서로 다른 시험 수를 합산하지 않는다. 재현 기준선은 [재현 기준선 자료](evidence/2026-10-29-repro-baseline.json)에 있다.

## 자동 시험

담당 완료 뒤 이어가기가 닿는 시험 파일을 `node --test --test-concurrency=2`로 묶음별로 실행했다. 닿는 범위는 담당 실행 장부, 구현·테스트 담당 hook, Stop 의 이어가기, 세션 시작 요약, 진행 명령의 완료 소비, 담당 호출 문장이다. 묶음은 서로 겹치지 않게 차례로 돌렸고, 셋째 묶음은 실제 호스트 평가와 함께 돌았다.

| 묶음 | 파일 | 결과 | 소요 |
|---|---|---|---:|
| 이어가기·hook·문서·템플릿 | `agentContinuation`·`reproScenarios`·`hookLoad`·`docSync`·`docs`·`templateText`·`templateBudget`·`hostNotation`·`hostText`·`retryPolicy`·`codex`·`stage-commands`·`questionPresentation`·`timeline`·`hookPaths`·`assets-doctor-usage` | 328건 모두 통과(`templateText`·`hookLoad`는 시험을 고친 뒤 다시 실행) | 161.9초 |
| 계획·리뷰·상태 조회 | `planning`·`planningRecovery`·`planningRetry`·`planningChainFlow`·`resultContracts`·`review-gate`·`crossReview`·`fullReview`·`finalReverify`·`stateView`·`lease` | 290건 모두 통과(`planning`은 시험을 고친 뒤 다시 실행) | 464.7초 |
| 동의·진행 명령·재개 | `consentBinding`·`consentOutput`·`consentSnapshot`·`consentScreens`·`answers`·`command`·`coexistence`·`choiceProtocol`·`choiceServer`·`branchCursor`·`branchResume`·`triage`·`experience`·`verification-flow`·`verification-stages`·`stageFlow`·`masterCodex`·`nodeRuntime`·`build`·`runtimeRelease`·`agent`·`adoption`·`codexReadiness`·`process`·`selection`·`masterRuns`·`installRobustness`·`master`·`executionMode`·`masterPairing` | 482건 모두 통과 | 717.3초 |
| 계획 교차·연쇄·요구 개정·반영 | `planningCross`·`planningChain`·`dependencyContracts`·`scripts`·`modelPolicy`·`requestRevisionFlow`·`integrate-deliver` | 96건 모두 통과 | 184.7초 |

- `templateText` H7 은 담당을 부르는 줄(출력의 `` `담당`을 부른다 `` 꼴 포함 14줄)마다 결과 수신 문장과 Codex 치환을 대조한다. `planning`은 설치 hook 11개와 `agent-event` 설치를 확인한다.
- `agentContinuation`은 다음을 본다.
  - 구현 담당 완료 뒤 다음 명령 없이 끝나는 턴을 한 번 막고 `next`를 알린다. 실행 중인 담당이 있거나, 이어 붙인 턴이거나, 같은 완료의 두 번째 턴 끝이면 막지 않는다. 조회 명령은 완료를 지우지 않고 진행 명령은 지운다.
  - 병렬 담당은 모두 끝나야 잇고, 새 담당 시작은 앞 완료를 처리한 것으로 본다. Codex 담당 이벤트도 장부에 남고 Codex Stop 이 Codex 표기로 잇는다.
  - 계획 담당 완료는 `planning advance`로 잇는다. 앞서 있던 답 없는 질문·응답을 기다리는 동의가 있으면 막지 않고, 담당이 낸 질문(needs-input)은 `planning advance`가 질문으로 넘기도록 잇는다. 세션 시작 요약이 처리하지 않은 완료를 알린다.
  - 다음 행동이 없는 종료(중복·늦은 결과)는 완료로 남기지 않는다. 끝을 관찰하지 못한 오래된 실행은 세지 않고, hook 실패 정리는 한 번만 한다. `agent-event`는 hook 실패 표에서 언제나 0이고 `init`이 구현·테스트 담당 matcher 로 설치한다.
  - 기록한 리뷰 결과는 `ca-review` 4-1부터 잇고, 이미 기록한 결과의 재알림은 완료로 남기지 않는다.
- `reproScenarios`의 `completionStall`은 격리 가짜 호스트에서 다음을 고정한다. 담당 완료 뒤 끝나는 턴은 한 번 막히고 사유에 `planning advance`가 든다. 이어 붙인 턴, 중복 완료 알림, 다른 세션(재시작)의 턴 끝은 막지 않는다. 사람 입력 없이 다음 행동까지 20초(`CONTINUATION_BOUND_MS`) 안에 이어진다. 이 상한은 자식 프로세스 기동을 포함한 시험 환경의 값이며 실제 호스트 지연의 기준이 아니다.
- 이 변경이 닿지 않는 시험 파일은 다시 실행하지 않았다.

이 변경 뒤 전체 시험은 실행하지 않았다. 마지막 전체 시험은 요구 개정 전 코드(`cd8a5f8`)에서 실행했으며 결과는 1807건 중 1803 통과·4 생략·0 실패다. 생략 4건은 플랫폼 조건이다.

## 실제 호스트

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

## 재현 기준선

[재현 기준선 자료](evidence/2026-10-29-repro-baseline.json)는 개선 전 빌드에서 `scripts/repro-baseline.cjs --repeat 3`으로 남겼다(fixture `sha256:4be6f82c570ee977`, 세 번 모두 같은 사실).

| 시나리오 | 개선 전 사실 | 지금 | 소요 중앙값(전→후) |
|---|---|---|---:|
| `amendment` | 확정한 요구 2개를 같은 ID 의 추가 요구 1개가 대체한다 | 추가 요구만 든 전체 목록 초안은 거부되고 확정 요구가 남는다. 확정 개정을 부모로 한 변경안(추가 1)이 기존 요구 2개를 보존한 새 개정이 된다 | 17ms → 79ms |
| `staleIds` | 지시서의 요구 ID 는 REQ-1·REQ-2 인데 다시 준비한 분석 배정은 REQ-1 만 가진다 | 다시 확정한 개정으로 준비하면 분석 배정이 REQ-1·REQ-2 를 가진다 | 18ms → 60ms |
| `completionStall` | 담당 완료 뒤 Stop 이 턴을 잇지 않아 사람 입력이 있어야 다음 행동을 실행한다 | 완료 뒤 끝나는 턴을 Stop 이 한 번 막고 사유에 `planning advance`를 싣는다. 사람 입력 없이 다음 행동(ready-for-gate, 게이트 통과)으로 이어진다. 이어 붙인 턴·중복 완료 알림(SubagentStop exit 0)·다른 세션의 턴 끝은 막지 않는다 | 2710ms → 5344ms |

지금 결과는 재생성 가능하므로 커밋하지 않는다. `node scripts/repro-baseline.cjs --repeat 3 --out <후.json>` 뒤 `--compare doc/reviews/evidence/2026-10-29-repro-baseline.json <후.json>`으로 다시 만든다. 지금 시나리오는 지금 계약을 보므로 fixture 해시가 다르다(`sha256:17ab377fa3014d4f`). 비교 스크립트는 이를 알린다. 격리 호스트의 대기 시간은 자식 프로세스 사이 간격이다. 따라서 실제 세션의 대기 시간은 재현하지 않으며, 비교 대상은 Stop 차단 여부·사람 입력 필요 여부·구간 분류다. `reproScenarios.test.ts`는 지금 동작을 고정한다.

## 상태 형식 세대

상태 형식 세대는 19이다. 담당 실행 장부(`.code-agent/agent-runs.json`)는 새 파일이지만 세대를 올리지 않는다. 승인·증거·작업 기록의 형식은 그대로다. 장부는 게이트·배정·승인 판정에 쓰지 않는 이어가기 안내용이다. 장부를 모르는 이전 릴리스는 이 파일을 읽지 않고, 그 릴리스의 담당 hook 은 장부를 쓰지 않는다. 그래서 이어가기 안내만 없을 뿐 흐름의 판정은 같다. 세대 19의 근거는 요구 개정 기록, 확정 원장의 `revision`, 커서의 `request`·`cycle`, 계획 작업의 `basis`, 반영 커밋의 실행 회차 기록이다.

## 템플릿 예산

`node scripts/template-sizes.cjs --suggest`는 LF로 정규화한 글자 수에 파일별 1.03, 흐름 합계 1.02를 곱하고 100자 단위로 올린다. 흐름 예산은 Claude 49200자(현재 48331), Codex 45900자(현재 44958)다. 공통 계획 절차는 `ca-plan/contract.md`에 두며 예산은 4100자다. 검증 기록·비밀 값·언어 규칙을 포함한 CODEX.block 예산은 2200자다. 같은 ID 의 요구 변경안 형식은 `ca-request/amend.md`(1284자, 예산 1300)에 둔다. 파일별 상한은 `src/test/templateBudget.test.ts`가 관리한다.

## 배포와 검증 한계

- 패키지 dry-run은 222개 파일이다. `dist/agent/agentHook.js`·`dist/agent/agentRuns.js`를 포함하고 `dist/test`는 포함하지 않는다. 재현 시나리오와 기준선 스크립트는 이 소스 저장소에서만 실행된다.
- 진행 중 대상(`target`) 변경은 요구 변경으로 받지 않는다. 다른 대상이면 사람이 그 대상의 ID 로 접수한다.
- 분석으로 되감은 뒤 같은 회차의 구현 Task 통과 판정은 기준 커밋과 다른 파일로 본다. 같은 회차에서 이미 고친 Task 파일은 다시 고치지 않아도 그 판정을 지난다 — 새 개정의 반영은 계획 재승인과 검증·리뷰 재실행이 확인한다.
- 이전 회차는 작업 브랜치(없으면 기준 브랜치)의 이력에서 찾는다. 반영 커밋을 기준 브랜치에 넣지 않은 채 작업 브랜치를 지웠으면 첫 회차로 시작한다.
- 메인이 쉬는 동안 완료 알림이 새 턴을 열지 않으면 hook 이 메인을 깨울 길은 없다. 이때는 다음 세션 시작 요약이 처리하지 않은 완료를 알린다.
- 실제 Claude 대화형 세션과 실제 Codex 에서 이어가기 차단이 턴을 잇는지는 확인하지 않았다. Codex 의 완료 알림은 관측하지 않는다.
- 백그라운드로 돌린 긴 검증 명령(Bash `run_in_background`)의 완료는 담당 실행 장부에 남지 않는다. 그래서 이어가기 대상이 아니다.
- Codex UserPromptSubmit 시각의 타임라인 기록은 실제 Codex 에서 확인하지 않았다.
- 자동 회귀를 실제 사람 승인·전체 모델 완주·사용자 사용성의 증거로 해석하지 않는다. 실제 호스트 동작 설명에 붙은 버전은 관찰 조건이며 지원 최소 버전을 뜻하지 않는다.
