# 교차 검증 무결성 — append-only 기록·원인별 실패 분류·사람 판단 함수

기준일: 2026-10-07. 기준 커밋: `f8d0dda`(C6 병합), 구현 커밋: `a1a70d8`. 독립 검토 반영(2026-10-08)은 `2facbc0` 위 커밋이다(아래 "독립 검토 반영"). 감사 [2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)의 리뷰·교차 검증 지적(묶음 C1)을 실패 원인별 재시도 규약([프로세스 흐름도](../process-flow.md) §6.4)의 교차 지점에 연결했다. 현재 동작은 흐름도 §5.1·§5.2·§6.3이 정본이다.

## 결정

| ID | 판정 | 바꾼 것 |
|---|---|---|
| PVR-1 | 수정 | 교차 시도를 지점(리뷰 회차·critic 배정)마다 append-only `crossAttempts[]`로 남긴다. 완료 지점은 다시 실행하지 않고(`RetryRefused`), 중지가 완료를 덮지 않는다. "실행할 수 없음"은 오류 채널(`crossFailureText`)의 화이트리스트와 두 번째 제한 시간뿐이고, 그 밖의 비정상 종료·JSON 아님은 설정 오류로 게이트를 막는다. 사람이 아닌 중지 지점은 지점 한도 안에서 다시 실행한다(게이트를 강하게만 한다) |
| PVR-2 | 수정 | 리뷰어 실행을 회차마다 append-only `reviewers[]`로 남긴다. 완료된 회차의 새 Start 는 무시 기록, 받아들인 실행이 끝나지 않았으면 동시 호출 무시(먼저 시작한 실행만 결과), 15분 넘으면 고아로 보고 새 호출, 같은 agent 의 끝난 실행 재개는 새 실행. 결과의 표 규칙(표 모양·id·다섯 칸·중복·상태·경로·범위)은 기록 전에 보고 Claude 는 한 번 돌려보낸 뒤 형식 오류로 기록한다(회차당 호출 2) |
| VER-M1 | 수정 | `review.json`의 모든 쓰기를 `mutateReview`(`<review.json>.lock` + 다시 읽기 + ⑨ 구역 재렌더)로 바꿨다. 교차 실행은 시작·끝 기록만 잠그고 다른 호스트를 실행하는 동안은 잠그지 않는다 |
| PVR-6 | 일부 | 사람 판단 함수 `previewWaiveFinding`·`waiveFinding`·`previewCrossStop`·`recordCrossStop`(`reviewJudgment.ts`)과 게이트의 기각 반영(`waived`·`staleWaiver` — 기록한 회차에만, 다음 회차는 지적 내용까지 같을 때만)을 만들었다. 동의 `judgment` 배선은 C5 몫이라 이번에는 연결하지 않았다 |
| PVR-11·HOST-M1 | 수정 | `runtimeHost`로 판별한 지금 호스트와 같은 `--by`를 거부하고, 지점의 호스트를 첫 시도로 고정하며, 시도마다 부른 쪽(`caller`)을 남긴다 |
| HP-9 | 수정 | `classifyCrossFailure`로 원인을 나눈다. `status`(2개 이상)·`doctor`(1개 이상)가 연속 중지를 알리고, `doctor --cross`가 다른 호스트의 `--help`로 교차 실행 옵션을 점검한다(`crossFlags` — 인자에서 만든 목록) |
| HP-8·VER-M2 | 수정 | Codex 샌드박스 표지가 있으면 `claude`를 띄우기 전에 멈추고(`crossPreflight`) 권한 상승을 안내한다(exit 1, 중지 아님). Codex 스킬 사본은 교차 명령을 샌드박스 밖으로 실행하라고 안내한다(`codexText` 치환) |
| PVR-10 | 일부 | 기본 제한 9분, 지점 시도 3, 원인별 재실행(시간 초과·설정 오류·형식 교정 각 1), 형식 오류는 원문을 `handoff/`에 보존하고 형식만 교정, 시도별 소요·비용 기록. `--max-budget-usd` 전달은 미뤘다 |
| HP-10 | 수정 | 9분 제한, 스킬은 timeout 600000ms 또는 백그라운드. 끝 기록 없이 끊긴 시도는 다음 실행이 끊긴 실행으로 닫고(중지가 아니라 지점 한도), 게이트는 같은 고아 보기(`orphanView`)를 저장하지 않고 쓴다 |
| HP-12·PVR-12 | 수정 | 교차 자식 환경에 `CODE_AGENT_CROSS=<호스트>`를 넣고, 자식 안의 Stop·SessionStart·리뷰어·계획 담당 hook 과 Codex 진행 이벤트가 아무것도 하지 않는다. 자식 안의 교차 명령은 거부한다. PreToolUse·동의 판정은 그대로다 |
| HP-13 | 수정 | 교차 결과의 F 번호를 X 로 다시 매기고(`normalized`) 프롬프트에 X 를 쓰라고 적는다 |
| PVR-16 | 수정 | ⑩ 검증 절과 커밋 메시지에 교차 리뷰·교차 계획 검토·사람 판단 줄. 갱신 전 판의 렌더와 파일 전체가 같으면 손 수정 경고를 내지 않는다(`legacy`). 커밋 중 계획 파일이 바뀌면 경고, 커밋 실패 시 고른 KNOWLEDGE 갱신을 되돌린다 |
| HP-20 | 일부 | 끄는 설정은 만들지 않았다(두 호스트 설치 시 필수). 시도별 소요·비용·토큰을 기록해 ⑩에 보인다. `usage` 합산은 C7 몫이다 |

옛 기록(`reviewer`·`cross`만 있음)은 읽을 때 배열로 추정하고, 그 배열에 더하는 쓰기가 처음 배열을 만든다. 옛 필드는 지우지 않고 파생 사본으로 계속 쓴다. 옛 ⑨ 회차 구역은 바이트가 같다(시험으로 고정). 엄격해지는 판정 둘: 표 규칙에 어긋난 옛 리뷰어·교차 완료 결과는 유효하지 않아 한 번 다시 받아야 하고(옛 교차 완료 결과는 독립 검토 반영 뒤 원문을 handoff 로 옮겨 형식만 교정한다 — 아래 #13), 옛 `cross.error`(형식 오류)는 원문이 없어 처음부터 다시 실행한다.

## 설계 명세와 다르게 한 것

- **동의 배선** — `consent.ts`의 `judgment`(C5)는 고치지 않았다. 사람 판단 네 함수는 시험이 직접 부른다(`reviewBudgets`·`planningCrossBudgets`를 직접 부르는 시험은 구현 커밋에 없었다 — 독립 검토 반영 #1에서 더했다). 명세 시험의 동의 부분(`crossReview.test` 4·10·18·23, `planning.test` 새 a·d)은 함수 호출로 바꿨다. §4.1 `judgment` 행은 동의가 들어올 때 쓴다.
- **모듈 배치** — 표 규칙 `reviewResultProblems`는 `crossRecord.ts`에 두고 `review.ts`가 다시 내보낸다(`effectiveReviewer`가 순환 없이 쓴다). ⑩·커밋 메시지 줄(`crossTraceLines`·`crossCommitLines`)은 `deliver.ts` 안에 두었다(리뷰·계획 기록을 읽어 `crossRecord.ts`를 순수하게 둔다). `saveReview`는 시험 픽스처가 쓰므로 내보낸 채 두었다 — 코드의 쓰기는 모두 `mutateReview`다.
- **옛 리뷰어 결과의 배열화** — 표 규칙에 어긋난 옛 완료 결과는 배열을 처음 만들 때 형식 오류로 기록한 실행으로 옮긴다(`materializeReviewers`). 명세는 `effectiveReviewer`가 건너뛰는 것만 적었지만, 그러면 파생 사본(`reviewer`)이 다시 그 결과를 가리켜 이전 판 CLI 가 오판한다.
- **문구** — 리뷰어 실행 중 안내는 `(이 회차 남은 호출 N회)`, 형식 오류만 기록된 회차는 별도 문구를 더했다. 해결된 지적의 기각 준비는 §4.3 문구(`게이트를 막는 지적이 아닙니다`)를 썼다(§9.3-10 의 `열린 지적이 아닙니다`와 다르다). `cross-config-error` 안내의 `doctor --cross` 앞에 `사람이 별도 터미널에서`를 붙였다 — 작업 중 모델의 doctor 실행은 C4 가 연다.
- **`crossCriticProblems(work, state)`** — 질문을 모두 답한 needs-input 을 판정하려면 questions.md 가 필요해 첫 인자를 `root`에서 `work`로 바꿨다. 지점 보기는 `criticCrossPoint`로 묶어 `deliver`·`reviewJudgment`·`planningCrossBudgets`가 같이 쓴다.
- **`pointLabel(보기 배열, awaiting?)`** — 시도 하나가 아니라 지점 보기로 이름을 정한다(`막힘(시간 초과)`를 더했다). 시도 하나의 이름은 `attemptLabel`.
- **실행 프롬프트** — 일반 교차 리뷰 프롬프트에도 계획 파일 목록을 넣는다(범위 칸 불일치를 줄인다). 계획 교차의 형식 교정은 배정 파일 없이 프롬프트에 JSON 형식과 허용 근거 경로를 싣는다.
- **실행 준비 예외** — 모델 설정 형식 오류는 시작 기록 전에 멈추고(시도를 쓰지 않는다), 시작 기록 뒤 실행 준비 중의 예외는 오류 줄 하나인 실패로 바꿔 끝 기록을 남긴다(끝 기록 없는 시도가 남지 않게).
- **기존 시험** — 명세 §9.5 목록 밖에서 둘을 더 고쳤다. `p5` "열린 계획 안 지적이 있으면 풀린다"는 같은 회차 재리뷰에 기대고 있어 두 시험으로 나눴고, "리뷰 중 바뀐 코드에는 완료 기록을 붙이지 않는다"는 시작한 실행이 끝나지 않은 채 남으므로 `/독립 리뷰어가 실행 중입니다/`를 본다. `planning.test` 702-733 은 명세대로 다섯 시험(새 a~e)으로 나눴다.
- **하지 않은 것** — C4 시험(`crossReview.test` 30 임대·32 doctor 허용), 실제 Codex 셸의 `env` 확인과 Codex 메인에서의 실제 교차 실행(§11 단계 12 — 비용이 들어 사용자 확인 필요).

## 근거

- `npm test`: 전체 결과는 아래 "시험" 절. 새 파일 `src/test/cross.test.ts`(순수 함수 15개)·`src/test/crossReview.test.ts`(통합 32개 — 리뷰 1회차까지 세운 저장소를 파일당 한 번 만들고 시험마다 복사해 약 15초)와 `planning.test.ts` 새 다섯 시험, `coexistence.test.ts` 권한 상승 치환 단언.
- 복사 픽스처 확인(`sandbox-stage3/probe-copy.cjs`): 리뷰 1회차까지 세운 저장소에서 저장소 절대 경로가 남는 파일은 적용이 끝난 동의 기록 셋뿐이었다(시험은 그 기록을 다시 쓰지 않는다).
- `doctor --cross` 실측(`sandbox-stage3/doctor-cross`, `init --host both`): 로컬 `claude 2.1.292`·`codex-cli 0.160.1` 의 `--help`에 교차 실행 옵션이 모두 있다(`✓ 교차 실행 옵션(claude)`·`✓ 교차 실행 옵션(codex)`). 모델 호출은 없다.
- 분류 패턴·오류 채널·지점 판정·예산은 공통 모듈 단계의 fixture(`retryPolicy.test.ts`)가 고정한다 — 이번에는 그 함수를 판정 지점에 연결하고 통합 시험으로 확인했다(설정 오류 1·2·3차와 CLI exit 1, 모델 없음·panic·Claude 비JSON, 두 번 제한 시간, 끊긴 실행, 실행 중, 형식·내용 교정, F→X, 샌드박스 사전 판정, 사람이 아닌 중지 재실행).

## 시험

- `npm run build && npm test`(Windows): 1062개 중 1058개 통과·실패 0·생략 4(플랫폼 조건), 약 158초. 기준 커밋 `f8d0dda`는 1009개였다 — 더한 53개는 `cross.test.ts` 15·`crossReview.test.ts` 32·`planning.test.ts` +4(교차 검토 시험 하나를 다섯으로)·`p5.test.ts` +2(동결 해제·교차 리뷰 시험을 둘씩으로)다.
- 기존 시험에서 기대를 바꾼 것은 명세 §9.4·§9.5 의 자리와, 같은 회차 재리뷰에 기대던 `p5` 두 곳(위 "설계 명세와 다르게 한 것")이다. 교차 명령을 부르는 시험은 `withCaller`로 부른 쪽 호스트 표지를 고정한다 — 이 저장소의 시험을 Claude Code(`CLAUDECODE=1`)나 Codex 안에서 돌려도 같은 호스트 거부에 걸리지 않게.

## 독립 검토 반영

구현(`a1a70d8`)·기록(`2facbc0`) 뒤 독립 검토 지적 17건(major 3·minor 14, 그중 두 건은 다른 지적과 같은 문제)을 하나씩 코드와 sandbox(검토자가 남긴 `sandbox-stage3-review/scripts`·`sandbox-stage3/review-c1` 스크립트를 `sandbox-stage3/review-c1-verify/`에 복사해 새 빌드로 다시 돌렸다)로 확인했다. 모두 맞는 지적이라 반영했다 — 한 건(#10)은 권고와 한 곳을 다르게 했고 근거를 적었다. 반영하지 않은 지적은 없다.

| # | 지적 | 판정 | 바꾼 것 |
|---|---|---|---|
| 1 (major) | `reviewBudgets`·`planningCrossBudgets`를 직접 부르는 시험이 없는데 기록은 있다고 적었다(통합 31개도 32개의 오기) | 반영 | `crossReview.test` 두 시험 — 리뷰 회차는 `reviewRoundUsage`(scope `""`, 허용 +1), 리뷰어 호출은 고아 실행까지 센다, 교차 지점·원인별은 고아 보기의 `crossBudgets`(설정 오류 둘 + `round:1` 허용 → used 1 / limit 2, 다른 회차 허용은 세지 않는다), 읽기만 한다(고아 보기를 저장하지 않는다), 묶임이 바뀌면 리뷰 회차 행만, 한 호스트 설치는 교차 행 없음. `planning.test` 한 시험 — critic 완료가 없으면 `[]`, scope `critic:<배정>`, 질문을 답한 옛 needs-input 도 지점 시도, `retry.grants` 반영(다른 지점 허용 제외), 설정 오류 두 번이면 `crossError` 소진. 위 "설계 명세와 다르게 한 것"·"근거"의 문장을 고쳤다 |
| 2 (major)·14 | `syncLegacyPlanning`이 원시 배열의 첫 completed 를 골라 옛 needs-input 이어가기에서 파생 사본 `cross`가 낡고, `feedbackOf`가 그 사본을 읽어 게이트가 막는 C1 을 수정 피드백에서 빠뜨린다 | 반영 | `syncLegacyPlanning(state, id, questions)`이 게이트와 같은 보기(`planningCrossView`)의 첫 completed 를 고른다(동시에 늦게 끝난 completed 는 고르지 않는다 — 질문을 쓴 끝 기록에서는 쓴 뒤의 questions.md 로 고른다). `feedbackOf`는 `criticCrossPoint(work, state).point.completed`의 outcome 을 읽고 기각 필터는 그대로다. `cross.test` 단위(이어가기·답 대기·경합)와 `planning.test` 옛 needs-input 시험(재실행이 차단 C1 → 사본 summary·findings, 게이트, advance `feedback`, 기각 뒤 피드백에서 빠짐). 검토자의 `sync-planning.cjs`·`exp-legacy-planning.cjs`를 새 시그니처로 다시 돌려 사본 = 게이트 보기를 확인했다 |
| 3·17 | `doc/planning.md` 역할 표가 새 문단으로 끊겨 `승인` 행이 떨어졌다 | 반영 | 문단을 표 뒤로 옮기고 표 안의 빈 줄을 지웠다 |
| 4 | 계획 게이트의 열린 지점 안내가 `직전 실행: …` 뿐이라 남은 횟수·다음 행동이 없다 | 반영 | `crossHintText`를 `crossRecord.ts`로 옮겨(`review.ts`는 다시 내보낸다 — `planningState.ts`가 리뷰 모듈을 끌어오지 않게) `crossCriticProblems`도 같은 문구를 붙인다. `planning.test` HP-13 이 `원문을 … 에 보존했습니다 … 형식만 교정합니다(남은 1회)`를 본다 |
| 5 | 시작 기록이 끊긴 시도를 닫은 뒤 거부하면(지점 한도·사전 판정) 닫았다는 알림이 빠진다 | 반영 | 두 명령 모두 거부 문구 앞에 알림을 붙인다(`withNotes`). 회차·계획 기록이 사라진 Stop 에도 붙인다. "끊긴 실행 세 번" 시험을 닫힌 둘 + 죽은 pid 하나로 바꿔 문구 첫 줄과 닫은 시도 저장을 본다 |
| 6 | 흐름도 §8 `09-review.md` 행이 다시 쓴 `review.ts`의 줄 번호를 인용한다 | 반영 | `reviewProblems`의 `renderRoundsBlock` 대조, `observedFindings`·`observedCross`로 |
| 7 | 명세 §9.3 의 11-b 역순·24 끝·29 통합·C6 끝까지 확인이 없다 | 반영 | `crossReview.test`: 동시 호출 역순(r1 Stop 먼저), 고치지 않은 `stop_hook_active` → 형식 오류 기록·`남은 호출 1회`·새 r2 받음, 사람이 아닌 중지 지점 + 죽은 pid 시도 → 게이트 통과·`next` 진행(고아 보기 저장 안 함). `planning.test`: 가짜 claude 가 받은 인자에 `--agent ca-critic --model opus --effort high …`, 결과 줄 `claude(opus/high)` |
| 8 | `doc/usage.md`에 `CODE_AGENT_CROSS_TIMEOUT_MIN`·`CODE_AGENT_CROSS_PREFLIGHT=off`가 없다 | 반영 | `review cross`·`planning cross` 행에 단위·기본값·소수 허용과 사람이 셸에서만 끈다는 문장 |
| 9 | C5 인계에 §5.8 항목 넷이 빠졌다 | 반영(인계) | 아래 "인계 — C5"에 comment 500자 Stop 문구, 네 함수가 공통 검증·`사유:` 줄을 하지 않는다는 것, `ActionSchema` 필드 그대로, judgment 안내 문구가 이미 나가는데 동의가 거부한다는 같은 릴리스 조건과 대조 시험 요청을 더했다 |
| 10 (major) | Codex 세션 분류 창(끝에서 이어진 `ERROR:` 묶음·오류 줄이 없으면 끝 줄·stdout `ERROR:`)이 전사 내용을 실행 불가로 보낸다 | 반영(한 곳 다르게) | `crossFailureText`의 Codex 세션 분기: stderr 맺음 줄 앞 **마지막 한 줄**이 Codex 의 `ERROR:` 줄일 때만 본다(묶음을 합치지 않는다), 신호로 끝난 세션(status null)은 보지 않는다, stdout(마지막 응답)은 세션 전후 모두 보지 않는다, 사유는 전사 줄 대신 종료 코드. **다르게 한 곳**: 모델 차례가 시작되지 않았고(전사 라벨 codex·exec·thinking·명령 끝 줄·토큰 줄 없음 — `CODEX_TURN`) 배너·되풀이된 프롬프트를 뺀 남은 줄이 하나뿐이면 그 줄을 본다. 그때는 전사가 섞일 수 없어 그 줄이 Codex 자신의 출력이고, C6 검토가 요구한 fixture "배너 + 되풀이된 프롬프트 + `Not logged in` → 실행 불가"(사용자 결정 "실행 불가면 중지 후 진행")를 지킨다. 라벨이 바뀌면 라벨 줄 자체가 남은 줄이 되어 둘 이상이므로 엄격 규칙으로 간다(fixture 로 고정). fixture 51 → 61: 검토자의 네 경우(읽은 로그 끝 `ERROR:` + Codex `ERROR:` 400, 신호 종료 뒤 파일 끝 줄 401, Windows 강제 종료 뒤 `quota exceeded` 문장, stdout `ERROR: usage limit` + panic)와 Python `ERROR:root:`, 신호 종료 뒤 진짜 `ERROR:` 한도, 바뀐 라벨, ENOBUFS, Claude 네트워크 둘. 검토자의 `exp-classify.cjs`는 기대가 있는 16건이 모두 맞고, 기대를 두지 않은 3건 중 Claude `API Error: Connection error.`는 네트워크(실행 불가)로 간다 |
| 11 | ENOBUFS 등 알 수 없는 spawn 오류가 잘린 출력으로 분류돼 게이트가 열린다 | 반영 | `classifyCrossFailure`가 ENOENT·ETIMEDOUT·EPERM·EACCES 밖의 spawn 오류는 출력을 보지 않고 `cross-config-error/unclassified`(사유 spawnMessage), 출력 원문은 그대로 `logPath`. fixture 1개, 검토자의 `exp-enobufs.cjs`(약 24MB)가 설정 오류·게이트 막힘 |
| 12 | 지점 호스트 고정에 `preflight` 시도가 들어가 Codex 샌드박스에서 멈춘 뒤 Claude Code 로 옮기면 양쪽 `--by`가 모두 거부된다 | 반영 | `pointHost`(실제로 띄운 첫 review·correct 시도 — preflight·human 제외)를 시작 기록 두 곳, `reviewProblems`·`crossCriticProblems`의 `--by` 안내, ⑨ 실행 기록 줄, 사람 중지 시도·요약, 연속 중지 집계가 같이 쓴다. HP-8 시험이 이어서 `--by codex` 완료·`--by claude` 거부·⑨ `교차(codex): 샌드박스, completed`를 본다. `exp-host-pin.cjs`도 같다 |
| 13 | 옛 완료 교차 결과가 새 표 규칙에 걸리면 원문 없는 형식 오류라 처음부터 다시 실행되고 옛 지적 흔적이 사라진다 | 반영 | 옛 결과에서 추정한 형식 오류 시도에 원문을 `result`로 남기고, 배열을 처음 저장하는 `review cross`가 그 원문을 `handoff/cross-review-r<회차>-1-raw.md`로 옮겨(`rawPath`) 형식만 교정한다(`correct`). 게이트 안내는 `옛 기록의 교차 결과(같은 명령이 handoff 로 옮긴다)`. "옛 기록 출구" 시험과 `exp-legacy-x.cjs`: 두 번째 시도가 `correct`, review.json·handoff 에 옛 X1 원문이 남는다 |
| 15 | 표지 없는 Codex 메인의 `--by claude` 네트워크 실패가 실행 불가로 조용히 빠지고, Claude 의 실제 네트워크 문구는 패턴 밖이다 | 반영 | `crossSandboxSuspect` — 부른 쪽이 codex 이고 `--by claude`이며 그 지점에 아직 `sandbox-network`가 없으면 첫 네트워크 오류를 `host-sandbox-denied`(사유에 그 사실을 붙인다)로 막고 권한 상승을 안내한다. 같은 지점에서 다시 나면 실행 불가로 기록하고 진행한다. 네트워크 패턴에 `Unable to connect to API`·`API Error: Connection error`·`ENETUNREACH`·`EHOSTUNREACH`·`ConnectionRefused`. 문구는 로컬 `claude 2.1.292` 실행 파일의 문자열에서 확인했다(`Unable to connect to API (${…})`·`… Check your internet connection`·SDK `Connection error.`·접두 상수 `API Error`). 두 조각을 이은 실제 출력은 실행해 보지 않았다(미확인). 통합 시험 1개·단위 시험 1개 |
| 16 | 교차 자식 안의 PreToolUse 가 `code-agent next`·계획 파일 쓰기를 그대로 연다(HP-12) | 반영 | C4 를 기다리지 않고 `hook.ts` `decide` 맨 앞에 `crossChildGuard` — 교차 자식이면 쓰기 도구(Codex `apply_patch` 포함)와 읽기 전용 목록(`read <파일>`·`status`·`survey`·`planning status`·`help`, 연결·치환 문자 없이 — `CROSS_CHILD_READONLY`) 밖의 `code-agent` 명령을 `CROSS_CHILD_DENY`(+ 교차 실행이 아니면 셸 설정의 `CODE_AGENT_CROSS`를 지우라는 안내)로 거부한다. 작업 임대는 읽지도 쓰지도 않는다. HP-12 시험에 Claude `decide`·Codex `codexHook` 단언 |

검토 기록이 확인한 그 밖의 항목(PVR-1·PVR-2·VER-M1·끊긴 실행 정리·옛 review.json 호환·hook 우회 없음)은 이번 수정 뒤에도 같은 시험이 통과한다.

새·바뀐 시험: `retryPolicy.test` fixture +10·범위 단언 갱신, `cross.test` +2(파생 사본·지점 호스트와 샌드박스 의심)와 단언 2, `crossReview.test` +6(리뷰어 역순·고치지 않은 내용 오류·고아 보기 통과·네트워크 의심·`reviewBudgets` 둘)과 기존 넷의 단언(끊긴 실행 알림·옛 교차 결과 교정·사전 판정 뒤 호스트·교차 자식 PreToolUse), `planning.test` +1(`planningCrossBudgets`)과 기존 셋의 단언(역할 모델 인자·형식 오류 안내·옛 needs-input 의 사본과 피드백). 고친 곳을 하나씩 되돌린 빌드(dist 변이 여덟 가지 — 파생 사본을 원시 배열에서, 피드백을 파생 사본에서, 거부 알림 없음, 첫 시도로 호스트 고정, 교차 자식 거부 없음, 샌드박스 의심 없음, 옛 결과 원문 옮기지 않음, 계획 안내 없음)에서 각각 해당 시험이 실패하는 것을 확인했다(`sandbox-stage3/review-c1-verify`).

- `npm run build && npm test`(Windows, 검토 반영 뒤): 1071개 중 1067개 통과·실패 0·생략 4(플랫폼 조건), 약 158초. 구현 커밋의 1062개에 더한 9개는 `crossReview.test` 6·`cross.test` 2·`planning.test` 1 이다(`retryPolicy.test` 의 fixture 10건은 한 시험 안에 있다).

## 남은 위험·미확인

- 실제 호스트 오류 문구·Codex 셸 표지(`CODEX_CI`·`CODEX_SANDBOX*`)·교차 자식의 hook 환경 상속은 미확인이다. 판별하지 못하면 같은 호스트 거부·사전 판정이 동작하지 않을 뿐 이전보다 약해지지 않는다.
- 같은 회차 재리뷰를 막았으므로 리뷰어가 틀렸을 때 코드 변경 없이 바로잡는 길은 사람 판단(동의 `judgment`)뿐이다 — 그 동의가 들어오기 전까지는 재계획·재승인·abort 다(C5 와 같은 릴리스 필요).
- 사용자가 리뷰어를 중단하면 15분 동안 새 호출이 결과를 쓰지 않는다(게이트 문구가 시각과 남은 횟수를 알린다).
- 분류 창이 좁아 앞줄에 원인이 있는 실행 불가는 `unclassified`(설정 오류)로 막힌다 — 원문이 `logPath`에 남는다. 독립 검토 반영 뒤 Codex 세션은 마지막 한 줄만 보므로 Codex 가 오류 줄 뒤에 안내 줄을 더 찍는 꼴이면 실행 불가도 막힌다(안전 쪽).
- Codex 세션에서 전사가 화이트리스트로 새는 길로 남은 것은 하나다 — 읽은 파일·도구 출력의 **마지막 줄**이 화이트리스트 문구의 `ERROR:` 줄이고 Codex 가 자기 오류 줄 없이 신호가 아닌 종료 코드로 끝날 때(Windows 강제 종료 등). 명령 출력 바로 뒤의 Codex 자신의 `ERROR:` 줄(도구 실행 뒤 한도 도달)과 글로 가를 수 없어 남겼다.
- 샌드박스 의심(`crossSandboxSuspect`)은 부른 쪽 판별(`runtimeHost` — Codex 셸 표지 미확인)에 기댄다. 판별하지 못하면 이전처럼 네트워크 오류가 실행 불가로 기록된다. 권한 상승을 이미 받은 Codex 메인은 첫 네트워크 오류에서 한 번 더 실행해야 중지가 기록된다.

## 인계

- **C5** — **C1 은 C5 없이 릴리스하지 않는다.** 같은 회차 재리뷰·완료 지점 재실행을 막았고, `ca-review` 4-2·`ca-plan` 4-1 과 게이트·안내 문구(`review.ts` `reviewProblems`·`openRound`, `crossCheck.ts` 완료 지점 거부, `retryPolicy.ts` 교차·한도 안내, `planningState.ts` `crossCriticProblems`)가 이미 `{"action":"judgment",…}`(`waive-finding`·`cross-stop`·`retry-grant <키>`)를 보내라고 안내하는데 지금 `consent.ts` `ActionSchema`는 이 동작을 거부한다 — C5 가 들어오기 전에는 틀린 지적·막힌 지점의 출구가 재계획·재승인·abort 뿐이다. C5 가 할 것(C1 명세 §5.8):
  - 네 함수(`previewWaiveFinding`·`waiveFinding`·`previewCrossStop`·`recordCrossStop`)는 `kind`·`comment`·`id`·`name`을 검증하지 않고 요약에 `사유:` 줄도 붙이지 않는다. 동의 `preview`가 kind 검사, `comment` 필수·500자 상한(Stop 문구 `사람 판단의 사유(comment)는 500자 이하로…`), `waive-finding`의 `id` 필수, `cross-stop`의 `name ∈ {review, planning}`을 먼저 하고 네 함수를 부른 뒤 `사유: <comment>` 줄을 붙인다. `applyLocked`는 `waiveFinding(root, id, 동의 id, comment)`·`recordCrossStop(root, name, 동의 id, comment)`.
  - `ActionSchema`는 기존 `kind`·`name`·`id`·`comment` 필드만 쓴다(필드를 늘리지 않는다). 지점(파일)은 현재 단계가 정한다.
  - 위 judgment 안내 문구(`review.ts`·`crossCheck.ts`·`retryPolicy.ts` 안내·`planningState.ts`·`ca-review`/`ca-plan` 템플릿)에 나오는 action·kind·카운터 키가 `ca-answer` 세 곳(`SKILL.md`·`reference.md`·`template/codex/ca-answer.md`)의 목록과 `ActionSchema`에 모두 있는지 대조하는 시험을 더한다.
  - 그 밖은 앞 판 그대로: 동의 `judgment`의 `waive-finding`·`cross-stop`을 `reviewJudgment.ts` 네 함수로, `retry-grant`의 리뷰 키(`reviewerRuns`·`crossPoint`·`crossError`·`crossFormat`)는 `reviewBudgets(work)` 행(`key`·`point`·`scope`·`used`·`limit`·`left`·`exhausted`)과 `mutateReview`로, 계획 교차 키는 `planningCrossBudgets(work)`와 `mutatePlanning`(`retry.grants`, scope `critic:<배정>`)으로 잇는다. 흐름도 §4.1 `judgment` 행, §6.3 사람 판단 절과 §6.4 연결 상태의 "배선은 아직 없다" 문장, `ca-answer` 세 곳(명세 §7.3 의 의미 문구), `doc/usage.md` 오류 표의 judgment 문장을 같은 커밋에서 고친다.
- **C4** — 교차 자식의 진행 명령·쓰기 거부는 독립 검토 반영에서 `hook.ts` `decide` 맨 앞 `crossChildGuard`로 들어갔다(문구 `CROSS_CHILD_DENY`, 여는 명령 `CROSS_CHILD_READONLY`). 작업 임대 `leaseGuard`는 그 뒤에 두고, 교차 자식이면 열린 읽기 전용 명령에도 임대를 읽거나 쓰지 않는다(명세 시험 30 의 `lease.json` 바이트 불변 단언은 C4 가 더한다 — deny·허용 단언은 `crossReview.test` HP-12 에 있다). doctor 를 작업 중에 열 때 `CROSS_CHILD_READONLY`에는 넣지 않는다. doctor 허용 정규식에 `--cross`를 넣으면 `retryPolicy.ts` `cross-config-error` 안내의 `사람이 별도 터미널에서 … (작업 중에는 모델이 doctor 를 실행할 수 없다)`를 걷는다. `failureHint`의 review·plan 행은 `reviewProblems`·`crossCriticProblems` 또는 `orphanView` 보기의 `crossPointHint`(렌더는 `crossRecord.ts` `crossHintText` — `review.ts`도 다시 내보낸다)를 쓴다 — 시도의 class 를 직접 읽지 않는다. `deliveryPaths`는 쓰기 중에만 있는 `*.review.json.lock`을 뺀다(PVR-7). 명세 시험 30·32.
- **C7** — 교차 시도의 `usage`(소요·비용·토큰)는 `crossRecord.ts` `crossAttemptsOf`·`planningCrossAttemptsOf`로 읽어 합산한다. ⑩ 구역에 줄을 더하면 `renderTraceBlock`의 `legacy` 인자에서 빼야 갱신 전 렌더 대조가 유지된다. `ca-review`에 4-2 가 늘었다(OPT-4 크기 예산).
