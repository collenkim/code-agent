# 교차 검증 무결성 — append-only 기록·원인별 실패 분류·사람 판단 함수

기준일: 2026-10-07. 기준 커밋: `f8d0dda`(C6 병합), 구현 커밋: `a1a70d8`. 감사 [2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)의 리뷰·교차 검증 지적(묶음 C1)을 실패 원인별 재시도 규약([프로세스 흐름도](../process-flow.md) §6.4)의 교차 지점에 연결했다. 현재 동작은 흐름도 §5.1·§5.2·§6.3이 정본이다.

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

옛 기록(`reviewer`·`cross`만 있음)은 읽을 때 배열로 추정하고, 그 배열에 더하는 쓰기가 처음 배열을 만든다. 옛 필드는 지우지 않고 파생 사본으로 계속 쓴다. 옛 ⑨ 회차 구역은 바이트가 같다(시험으로 고정). 엄격해지는 판정 둘: 표 규칙에 어긋난 옛 리뷰어·교차 완료 결과는 유효하지 않아 한 번 다시 받아야 하고, 옛 `cross.error`(형식 오류)는 원문이 없어 처음부터 다시 실행한다.

## 설계 명세와 다르게 한 것

- **동의 배선** — `consent.ts`의 `judgment`(C5)는 고치지 않았다. 사람 판단 네 함수와 `reviewBudgets`·`planningCrossBudgets`는 시험이 직접 부른다. 명세 시험의 동의 부분(`crossReview.test` 4·10·18·23, `planning.test` 새 a·d)은 함수 호출로 바꿨다. §4.1 `judgment` 행은 동의가 들어올 때 쓴다.
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

- `npm test`: 전체 결과는 아래 "시험" 절. 새 파일 `src/test/cross.test.ts`(순수 함수 15개)·`src/test/crossReview.test.ts`(통합 31개 — 리뷰 1회차까지 세운 저장소를 파일당 한 번 만들고 시험마다 복사해 약 15초)와 `planning.test.ts` 새 다섯 시험, `coexistence.test.ts` 권한 상승 치환 단언.
- 복사 픽스처 확인(`sandbox-stage3/probe-copy.cjs`): 리뷰 1회차까지 세운 저장소에서 저장소 절대 경로가 남는 파일은 적용이 끝난 동의 기록 셋뿐이었다(시험은 그 기록을 다시 쓰지 않는다).
- `doctor --cross` 실측(`sandbox-stage3/doctor-cross`, `init --host both`): 로컬 `claude 2.1.292`·`codex-cli 0.160.1` 의 `--help`에 교차 실행 옵션이 모두 있다(`✓ 교차 실행 옵션(claude)`·`✓ 교차 실행 옵션(codex)`). 모델 호출은 없다.
- 분류 패턴·오류 채널·지점 판정·예산은 공통 모듈 단계의 fixture(`retryPolicy.test.ts`)가 고정한다 — 이번에는 그 함수를 판정 지점에 연결하고 통합 시험으로 확인했다(설정 오류 1·2·3차와 CLI exit 1, 모델 없음·panic·Claude 비JSON, 두 번 제한 시간, 끊긴 실행, 실행 중, 형식·내용 교정, F→X, 샌드박스 사전 판정, 사람이 아닌 중지 재실행).

## 시험

- `npm run build && npm test`(Windows): 1062개 중 1058개 통과·실패 0·생략 4(플랫폼 조건), 약 158초. 기준 커밋 `f8d0dda`는 1009개였다 — 더한 53개는 `cross.test.ts` 15·`crossReview.test.ts` 32·`planning.test.ts` +4(교차 검토 시험 하나를 다섯으로)·`p5.test.ts` +2(동결 해제·교차 리뷰 시험을 둘씩으로)다.
- 기존 시험에서 기대를 바꾼 것은 명세 §9.4·§9.5 의 자리와, 같은 회차 재리뷰에 기대던 `p5` 두 곳(위 "설계 명세와 다르게 한 것")이다. 교차 명령을 부르는 시험은 `withCaller`로 부른 쪽 호스트 표지를 고정한다 — 이 저장소의 시험을 Claude Code(`CLAUDECODE=1`)나 Codex 안에서 돌려도 같은 호스트 거부에 걸리지 않게.

## 남은 위험·미확인

- 실제 호스트 오류 문구·Codex 셸 표지(`CODEX_CI`·`CODEX_SANDBOX*`)·교차 자식의 hook 환경 상속은 미확인이다. 판별하지 못하면 같은 호스트 거부·사전 판정이 동작하지 않을 뿐 이전보다 약해지지 않는다.
- 같은 회차 재리뷰를 막았으므로 리뷰어가 틀렸을 때 코드 변경 없이 바로잡는 길은 사람 판단(동의 `judgment`)뿐이다 — 그 동의가 들어오기 전까지는 재계획·재승인·abort 다(C5 와 같은 릴리스 필요).
- 사용자가 리뷰어를 중단하면 15분 동안 새 호출이 결과를 쓰지 않는다(게이트 문구가 시각과 남은 횟수를 알린다).
- 분류 창이 좁아 앞줄에 원인이 있는 실행 불가는 `unclassified`(설정 오류)로 막힌다 — 원문이 `logPath`에 남는다.

## 인계

- **C5** — 동의 `judgment`의 `waive-finding`·`cross-stop`을 `reviewJudgment.ts` 네 함수로, `retry-grant`의 리뷰 키(`reviewerRuns`·`crossPoint`·`crossError`·`crossFormat`)는 `reviewBudgets(work)` 행(`key`·`point`·`scope`·`used`·`limit`·`left`·`exhausted`)과 `mutateReview`로, 계획 교차 키는 `planningCrossBudgets(work)`와 `mutatePlanning`(`retry.grants`, scope `critic:<배정>`)으로 잇는다. 흐름도 §4.1 `judgment` 행, §6.3 사람 판단 절과 §6.4 연결 상태의 "배선은 아직 없다" 문장, `ca-answer` 세 곳(명세 §7.3 의 의미 문구), `doc/usage.md` 오류 표의 judgment 문장을 같은 커밋에서 고친다.
- **C4** — 작업 임대 `leaseGuard` 맨 앞에 `crossChild()`면 `CROSS_CHILD_DENY`(`crossEnv.ts`에 있다). doctor 허용 정규식에 `--cross`를 넣으면 `retryPolicy.ts` `cross-config-error` 안내의 `사람이 별도 터미널에서 … (작업 중에는 모델이 doctor 를 실행할 수 없다)`를 걷는다. `failureHint`의 review·plan 행은 `reviewProblems`·`crossCriticProblems` 또는 `orphanView` 보기의 `crossPointHint`(렌더는 `review.ts` `crossHintText`)를 쓴다 — 시도의 class 를 직접 읽지 않는다. `deliveryPaths`는 쓰기 중에만 있는 `*.review.json.lock`을 뺀다(PVR-7). 명세 시험 30·32.
- **C7** — 교차 시도의 `usage`(소요·비용·토큰)는 `crossRecord.ts` `crossAttemptsOf`·`planningCrossAttemptsOf`로 읽어 합산한다. ⑩ 구역에 줄을 더하면 `renderTraceBlock`의 `legacy` 인자에서 빼야 갱신 전 렌더 대조가 유지된다. `ca-review`에 4-2 가 늘었다(OPT-4 크기 예산).
