# 절차 보완·재시도 규약·최적화 작업 요약 (2026-10-08)

[2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md) 뒤의 구현 전체를 한 곳에 모은 이력 기록이다. 범위는 공통 모듈 `2327975`부터 최적화 독립 검토 반영 `934e5fe`까지의 구현과, 그 전체를 다시 검토해 고친 `d12bd46`이다. 이 요약 기록(`16ae5ec`)까지 다시 검증해 찾은 남은 문제 여섯 건(R1~R6)을 고친 후속 커밋도 9단계로 더했다 — 처리는 [전체 검토 기록의 후속 수정 절](2026-10-08-full-review.md#후속-수정최종-재검증-지적)에 있다. 현재 동작은 [프로세스 흐름도](../process-flow.md)가 정본이다. 이 문서의 한도·수치는 `d12bd46` 시점의 값이고(9단계는 그 커밋 시점), 단계 기록에 적힌 수치만 인용했다. 원자료는 [procedure-fix-2026-10-08.json](evidence/procedure-fix-2026-10-08.json)이다. 지적마다의 처리 메모는 [감사 160건 처리 현황](2026-10-08-audit-disposition.md)과 그 원자료가 원본이다.

## 사용자 결정

| 결정 | 이번 작업에서 |
|---|---|
| 절차 결함 보완 | 게이트가 잘못 열리는 결함(PVR-1·PVR-2), 질문 하나로 멈추는 교착(FLOW-01), 승인 무효의 재진입(FLOW-03) 등을 C1~C5에서 고쳤다 |
| 실패 원인별 재시도 규약 — 코드가 강제하고 문서화한다 | 공통 모듈 `retryPolicy.ts`가 원인 21개를 정의하고 판정 지점마다 그 표를 쓴다. 흐름도 §6.4 표는 이 모듈이 렌더한 생성 블록이다 |
| 최적화 — HX-5(작은 작업용 경량 경로) 제외 | C7에서 진행했다. HX-5는 범위 밖으로 두었다 |
| Claude 역할별 모델 — 판단 opus/high, 실행 sonnet/medium | C6에서 반영했다. 비용·품질 A/B 실측은 사용자 승인 뒤로 미뤘다 |
| 자가 학습 보류 | 측정(OPT-6)은 기록을 읽기만 하고 다음 작업으로 환류하지 않는다. 자가 학습 지적 17건과 호스트 자체 기억(GAP-3)은 범위 밖이다 |
| 사람 확인 지점(요구 확정·계획 승인·결과 반영) 유지 | 연쇄 모드(`planning advance --chain`)도 계획 승인을 잇지 않는다. 한도를 넘으면 자동 재시도를 멈추고 사람 판단 동의(`judgment`)로 넘긴다 |
| 교차 실행 불가 시 중지 기록 후 진행, 두 호스트 설치 시 교차 필수 | 실행 불가는 화이트리스트(미설치·인증·한도·네트워크·장애)만이다. 설정 오류·형식 오류·샌드박스 거부·끊긴 실행은 게이트를 막는다. 교차를 끄는 설정은 두지 않았다(HP-20) |

작업 규칙: `code-agent update`는 실행하지 않았다. 실제 Claude·Codex 모델도 부르지 않았다 — 교차 실행은 가짜 호스트 실행 파일(`CODE_AGENT_CLAUDE_BIN`·`CODE_AGENT_CODEX_BIN`)로 확인했다. 실험은 작업 scratchpad 의 sandbox 임시 저장소에서 했고, 이 저장소 루트에는 `init`을 실행하지 않았다.

## 단계와 커밋

| 단계 | 묶음 | 커밋 | 기록 | 단계 끝 `npm test`(실패 0·생략 4) |
|---|---|---|---|---|
| 감사 | 이중 호스트 프로세스 감사·흐름도·개발 지침(코드 변경 없음) | `ff13950` | [감사](2026-10-07-dual-host-process-audit.md) | 802개 중 798개 통과(기준 `c4f3fbf`) |
| 1 | 공통 재시도 규약 모듈 | `2327975`·`3b5e867` | [공통 모듈](2026-10-07-retry-policy-module.md) | 874개 중 870개(`3b5e867` — 역할별 모델 기록의 기준 커밋 값) |
| 2 | C2 계획 오케스트레이션 | `fa70f74`·`110ec6a`, 병합 `de8a073` | [계획](2026-10-07-planning-retry-orchestration.md) | 915개 중 911개(기록 시점) |
| 2 | C3 검증 재시도 | `e3e082d`·`53368a4`, 병합 `7e169c2` | [검증](2026-10-07-verify-retry.md) | 924개 중 920개(검토 반영 뒤) |
| 2 | C6 역할별 모델 | `eaad713`·`ca36d3e`, 병합 `f8d0dda` | [역할별 모델](2026-10-07-role-models.md) | 909개 중 905개(검토 반영 뒤). 세 묶음 병합 뒤 `f8d0dda`는 1009개 |
| 3 | C1 리뷰·교차 검증 무결성 | `a1a70d8`·`2facbc0`·`77407a9` | [교차](2026-10-07-cross-integrity.md) | 1071개 중 1067개 |
| 4 | C5 동의·업무 답 관찰·hook 경계 | `248e704`·`6584910` | [동의·hook](2026-10-08-consent-hook-boundary.md) | 1134개 중 1130개 |
| 5 | C4 단계 전이·CLI 안내·반영 범위·작업 임대 | `9d3e285`·`4b1333b` | [단계 전이](2026-10-08-stage-flow.md) | 1197개 중 1193개 |
| 6 | C7 최적화 | `669aa66`·`f3b34ff`·`df22bdf`·`f230734`·`64d1c50`·`69fbe28`·`337ab1f`·`1141beb`·`934e5fe` | [최적화](2026-10-08-optimization.md) | 1265개 중 1261개 |
| 7 | 전체 검토 반영(지적 43건)·흐름도 대조 시험·감사 처리 현황 | `d12bd46` | [전체 검토](2026-10-08-full-review.md)·[처리 현황](2026-10-08-audit-disposition.md) | 1292개 중 1288개 |
| 8 | 이 요약 기록(문서만) | `16ae5ec` | 이 문서 | [최종 테스트 결과](#최종-테스트-결과) — 1292개 중 1288개 |
| 9 | 최종 재검증 지적 R1~R6 반영(사용자 수준 호스트 설정의 다른 이름, 검증 명령의 기록 변경 판정, 교차 안내의 설정 오류, 리뷰 없이 쓴 리뷰 회차의 선택지, 흐름도 줄 인용, 시험의 죽은 pid) | 이 커밋(부모 `16ae5ec`) | [전체 검토 — 후속 수정](2026-10-08-full-review.md#후속-수정최종-재검증-지적) | 1311개 중 1307개 |

2단계의 C2·C3·C6은 따로 작업한 뒤 차례로 병합했다. 묶음마다 구현 커밋 뒤에 독립 검토를 거쳤고, 지적을 코드로 확인한 반영 커밋을 따로 두었다. 7단계는 `ff13950..934e5fe` 전체를 네 관점(e2e·재시도 규약·hook·문서)으로 다시 검토한 결과다. 9단계는 `d12bd46`·`16ae5ec`을 다시 검증해 남은 문제를 고친 결과다.

## 실패 원인별 재시도 규약 요지

원칙은 다음 여섯이다(규약 명세 §0.1 — 구현도 같다).

1. 원인 판정은 코드가 한다. 모델은 결과의 `failure.class`·안내 문구·`budget`을 읽고 따른다.
2. CLI는 스스로 다시 실행하지 않는다. 예외는 같은 호출 안의 죽은 잠금 회수와, hook이 Claude 담당에게 한 번 되돌리는 것뿐이다.
3. 같은 입력으로 같은 실패를 되풀이하지 않는다. 원인마다 다시 시도하려면 무엇(코드·환경·입력·설정·사람 판단)이 바뀌어야 하는지 정해져 있다.
4. 재실행으로 기록을 지우지 않는다. 교차 시도·리뷰어 실행은 append-only이고, 완료 지점은 다시 실행하지 않는다.
5. 상한에 닿으면 자동 재시도를 멈추고 사람에게 넘긴다. 한도는 관찰된 동의 `judgment`(`retry-grant`·`waive-finding`·`cross-stop`)로만 는다.
6. 원천은 `retryPolicy.ts` 하나다. 흐름도 §6.4 표는 `renderRetryPolicyTable()`의 생성 블록이고 `docSync.test.ts`가 바이트를 대조한다.

원인은 21개다. 19개는 감사 과제에 나열된 원인이고, `precondition`·`hook-failure`는 분류 밖으로 새는 Stop과 hook 예외를 담는 보조 분류다. 묶음은 규약 명세 §2의 구분을 따랐다.

| 묶음 | 원인 | 요지(`d12bd46` 기준) | 연결 |
|---|---|---|---|
| 검증(check·test·integrate·repro) | `code-defect`·`environment`·`interrupted`·`result-unconfirmed`, 보조 `precondition` | 원인별 카운터: 고쳐 쓰기(fixRounds 기본 2)·수집 수정 1·같은 코드 재실행 2/회차·통합 재실행 2/회차·재현 재실행 2/테스트 트리·재현 시도 3·리뷰 회차 3·총 회차. 환경 분류는 그 실행에 실패 TC가 없을 때만 한다. 넘으면 verify `decision`이다 | C3, 전체 검토(E13·E17·E24) |
| 계획 배정 | `agent-format-error`·`agent-content-error`·`dispatch-orphan`·`same-input-repeat`·`reassign-total` | Claude 담당은 한 번 되돌린다. 그다음은 형식만 교정 1회, 또는 수정 피드백을 넣어 재배정한다. 같은 입력 실패 3·작업 총 배정 6. 확실한 고아는 자동 재배정, 의심 고아는 cancel 뒤 advance. 넘으면 사람 판단이다 | C2 |
| 교차 실행 | `cross-unavailable`·`cross-config-error`·`cross-timeout`·`cross-result-invalid`·`host-sandbox-denied` | 실행 불가(화이트리스트)만 중지 기록 후 진행한다. 설정 오류는 1회 재실행, 형식 오류는 형식만 1회 교정한 뒤 게이트를 막는다. 시간 초과는 백그라운드로 1회 다시 실행하고, 샌드박스 거부는 권한 상승 후 같은 명령을 낸다. 지점 시도 3 | C1, 전체 검토(E18·E20·E22) |
| 지적·상한 | `blocking-finding`·`limit-exceeded` | 차단 지적은 재실행으로 지우지 못한다 — 고친 뒤 새 회차를 열거나 사람이 기각한다. 한도를 다 쓴 카운터의 재시도는 자동으로 하지 않는다 — 사람 허용·재계획·abort 중에서 고른다 | C1·C3·C5 |
| 동의·잠금·hook | `consent-target-changed`·`consent-apply-failed`·`lock-stale`, 보조 `hook-failure` | 대상이 바뀐 동의와 적용이 중단된 동의는 다시 쓰지 않고 새로 준비한다. 죽은 잠금은 같은 호출에서 회수한다. hook 판정 실패의 종료 코드는 이벤트별 표(`hookFailureExit`·`subagentExit`)를 따른다 | 공통 모듈·C5, 전체 검토(E19·E21·E23) |

판별 규칙·카운터 위치·사람 허용 범위·판정 함수는 [흐름도 §6.4](../process-flow.md#64-실패-원인과-재시도-규약-retrypolicyts)에 있다. 원인별 안내 문구도 이 모듈 하나가 원천이다. 렌더하지 않는 문구 셋(차단 지적·잠금 고착·hook 판정 실패)은 `UNRENDERED_GUIDES`에 실제 원천과 함께 적는다(E23).

## 묶음별 주요 변경

괄호 안은 감사 지적 ID다. 상태는 아래 [처리 현황](#감사-160건-처리-현황)에 있다.

- **공통 모듈**(`2327975`·`3b5e867`) — `retryPolicy.ts`(원인 21개의 정책·카운터·한도·사람 허용 범위, 판정 함수, 호스트 중립 안내 문구), 공통 잠금 `lock.ts`, 실행 환경 표지 `crossEnv.ts`, 호스트별 표기 `hostText.ts`, §6.4 생성 블록과 바이트 대조. 독립 검토 14건으로 잠금 회수 직렬화·교차 실패 분류 범위·`crossBudgets`·안내 변형을 고쳤다.
- **C2 계획** — 질문 출처 `[Origin]`·`questionOrigins`로 출처 작업과 그 후손만 낡게 한다. 앞 단계가 낡으면 `rewind-required`로 되감고, 같은 사유면 한 번 자동으로 되감는다(FLOW-01, FLOW-14 일부). 고아 배정 정리 `orphanState`(FLOW-04), 완료 hook 재구성과 결정적 문서 검사 `stagedChecks.ts`(PVR-5·OPT-5), 같은 입력 실패·작업 총 배정 한도(PVR-17), 공통 잠금(FLOW-M1), 질문 본문 구조 필드 검사(CON-7), 업무 규칙 KNOWLEDGE 입력(LRN-2), 후보 순위 절단 제거(GAP-1), 명령 1회 범위 메모와 입력 해시 골든 고정(PVR-18).
- **C3 검증** — 검증 회차를 원인별 카운터로 나누고 `check`·`verify`·hook·`status`가 한 판정 함수를 쓴다(PVR-3). 환경 분류는 실패 결과가 없을 때만 한다(PVR-4). 테스트 동결 시작과 증거 대조 `testFreeze`(FLOW-05·PVR-9·PVR-15), 체크아웃별 worktree 표지(PVR-8), 파일 바이트 해시(PVR-13), 리뷰 회차 한도의 단일 원천 `reviewRoundUsageOf`(FLOW-06), 재현 시도 한도도 넣었다.
- **C6 역할별 모델** — `ROLE_POLICY`·`TIER_DEFAULTS`, 정의 파일 머리말 `effort`, `models.json` 예약 키 `effort`(이전 버전 호환), `model --effort`, model 동의 스냅샷의 모델 정책, doctor·update 보고, 단가표 `claude-sonnet-5-5`·`claude-fable-5`(OPT-12·HX-9·OPT-13).
- **C1 리뷰·교차** — 교차 시도·리뷰어 실행의 append-only 기록과 완료 지점 재실행 거부(PVR-1·PVR-2), `review.json` 잠금 저장 `mutateReview`(VER-M1), 오류 채널만 보는 원인별 교차 실패 분류(HP-9), 형식만 교정(HP-13), Codex 샌드박스 사전 판정(HP-8·VER-M2), 같은 호스트 `--by` 거부(PVR-11·HOST-M1), 9분 제한(HP-10), 교차 자식의 hook 통과·진행 거부(HP-12·PVR-12), 사람 판단 함수(PVR-6), ⑩·커밋 메시지의 교차 줄(PVR-16), `doctor --cross`.
- **C5 동의·hook** — 동의 실패 기록 `failure{class,kind}`와 갈래별 안내, 준비·적용 티켓과 준비 세션 결속·30분 열린 동의 창(CON-1·CON-2), Codex 확인 코드(CON-5), 사람 판단 동의 `judgment`(카운터별 허용 `retryGrant.ts`, 지적 기각·교차 중지 연결), Claude 업무 답 관찰(CON-6 일부), 문서 세션 범위 고정(CON-3)과 KNOWLEDGE `.md` 한정(CONS-M1), 승인 화면 경계 절(CON-4), 소스 update 확인(LRN-5), hook 경로 판정(Grep·Glob·Windows 별칭·MCP — CON-8·CON-9·CON-13), 링크 해시·내용 해시 캐시(CON-14·CON-15), hook 누락 감지와 시작 게이트(CON-17 일부), 동의 영수증(CON-16), `cli.ts` 지연 로드와 `hookFailureExit` 연결.
- **C4 단계·CLI·임대** — deliver 의 쓰기 거부와 되감기(FLOW-02), 재진입 안내 `reentry.ts`(FLOW-03), start 사전 검사(FLOW-07), 작업당 대상 하나(FLOW-08), 준비 동의 선택(FLOW-09), 작업 중 doctor 허용(FLOW-10), 관찰 흐름의 `다음:`(FLOW-12), `ca-next` 멈춘 자리별 재개표(FLOW-13), 작업 임대 `lease.ts`(FLOW-16·HP-11), 남는 인자 거부(FLOW-17), 호스트별 표기 배선(FLOW-11·HP-5·OPT-8), 반영 제외 `deliveryExcludes`(PVR-7), 장시간 실행 문장의 문장째 치환(VER-M3), 연결자 없는 `code-agent read` 허용(HP-2).
- **C7 최적화** — hook 경로의 명령 모듈 지연 로드(OPT-15 일부), `usage` 호출 통계·재시도 기록(읽기만)·Codex 세션 집계(OPT-6), 동의 인라인 준비·호스트별 출력 `--for`·적용 결과의 `next`(OPT-1·OPT-2 일부), 계획 advance 의 `next` 줄과 연쇄 `--chain`·계획 스킬 공통 항목(OPT-14·OPT-1), ca-answer 조건부 읽기(OPT-3 일부), Task 완료 판정(PVR-19 일부), context 렌더러 분리(OPT-16 일부), 템플릿 크기 예산(OPT-4), 시험 파일 분할(OPT-11), `CODEX_SENTENCES`와 원문 시험(HX-12, OPT-9 일부).
- **전체 검토**(`d12bd46`) — 지적 43건 중 반영 36·일부 5·일부이면서 사용자 결정 1(E2)·결정 1(E16). 주요 반영: 진단 노드의 재개 명령(E1), 소진 안내의 사람 선택지(E10), 통과 뒤 변경 회차가 리뷰 회차 예산을 씀(E13 일부), 검증 명령이 상태 기록을 바꾸면 되돌리고 받지 않음(E15), ⑧·⑩·커밋 메시지의 사람 허용 줄(E8), 반영 확인 화면의 PR 본문 구역(E7), 계획 승인 화면의 계획 검토 절(E12), Codex 담당 배정 계약 `{path, content}`(E9 — HP-16), 실행 파일 설정 오류 분류(E20 — HP-14 일부), 하위 폴더 세션의 hook 루트(E25), 사용자 수준 hook 설정 쓰기 거부(E29). 흐름도 §4.1·§5.1·§5.2·§3.2·§7을 코드·`init` 설치 결과와 대조하는 시험을 `docSync.test.ts`에 더했다. 문서 지적(E31~E43)도 반영했다.
- **최종 재검증 후속 수정**(9단계) — 여섯 건 모두 반영했다. (R1) 사용자 수준 호스트 설정 쓰기 거부가 같은 파일의 다른 이름을 접어 본다 — NTFS 스트림 표기, 폴더 스트림, 긴 경로 접두, 관리 공유, 끝 점·공백, 8.3, 상대 경로를 접고, 하드 링크는 (dev, ino)로 견준다. Codex `apply_patch`와 셸 언급(겹친 `..`)도 같다. (R2) 검증 명령이 code-agent 기록을 바꿔 되돌린 실행은 전제 미충족(`precondition`, 실행 원인 `guard`)으로 남는다. 게이트·verify·`다음:`·재실행 거부가 같은 문장을 쓰고, `다음:`은 지금 회차의 실행과 게이트를 본다. (R3) 교차 안내가 설정 오류(게이트 막힘)와 실행 불가(중지 기록 후 진행)를 나눠 쓴다. (R4) 리뷰를 열지 않고 쓴 리뷰 회차는 허용을 받지 않는다 — 안내가 실제로 받는 세 선택지만 싣는다. (R5) 흐름도의 `template/`·`doc/` 줄 인용을 맞추고 시험이 대조한다. (R6) 시험의 죽은 pid 는 재사용될 수 없는 값이다.

## Claude 역할별 모델

원천은 `modelPolicy.ts` `ROLE_POLICY`·`TIER_DEFAULTS`이고, 정의 파일 머리말과 `doc/codex.md` 표를 `modelPolicy.test.ts`가 대조한다. `d12bd46` 기준 값이다.

| 역할 | 등급 | Claude 모델 / 강도 | Codex 모델 / 강도 | 선택 이유(`ROLE_POLICY`) |
|---|---|---|---|---|
| analyst | 판단 | opus / high | gpt-6.1-sol / high | 요구 구체화·설계 대안·계획을 판단한다 — 오판이 뒤 단계 전체로 번진다 |
| critic | 판단 | opus / high | gpt-6.1-sol / high | 계획을 독립적으로 반박한다 — 여기서 놓친 결함은 그대로 승인된다 |
| reviewer | 판단 | opus / high | gpt-6.1-sol / high | 구현을 독립 반박 검토한다 — 반영 전 마지막 판단이다 |
| surveyor | 실행 | sonnet / medium | gpt-6.1-sol / medium | survey 표본을 읽고 근거 경로를 단 사실을 정리한다 — 확정은 사람이 한다 |
| explorer | 실행 | sonnet / medium | gpt-6.1-sol / medium | 영역 코드에서 근거와 사실을 찾는다 — 해석은 판단 역할과 게이트가 검사한다 |
| writer | 실행 | sonnet / medium | gpt-6.1-sol / medium | 받은 재료를 뼈대 형식으로 옮긴다 — 새 판단을 만들지 않는다 |
| implementer | 실행 | sonnet / medium | gpt-6.1-sol / medium | 승인된 계획·context대로 쓴다 — check·test·review 게이트가 결과를 검증한다 |
| tester | 실행 | sonnet / medium | gpt-6.1-sol / medium | 07의 TC를 그대로 구현한다 — check·test·review 게이트가 검증한다 |

이 값은 제품의 시작값이고 벤치마크로 입증한 최적 조합이 아니다. 실행 역할을 sonnet/medium으로 내려서 생기는 check 실패·리뷰 지적·재배정 증가가 절감을 상쇄하는지는 측정하지 않았다(아래 [남은 일](#미확인사용자-결정-필요남은-일)의 유료 A/B).

## 최적화 실측

아래 수치는 [최적화 기록](2026-10-08-optimization.md)과 [동의·hook 기록](2026-10-08-consent-hook-boundary.md)의 원자료를 그대로 옮긴 것이다(Windows, Node 24.19, sandbox, 실제 모델 호출 없음).

**hook 프로세스 시간**(spawn~종료, 기준 빌드 `4b1333b`와 독립 검토 반영 빌드를 같은 반복 안에서 번갈아 돌린 31회 중앙값):

| hook | 기준 | 뒤 |
|---|---|---|
| PreToolUse Read / Bash status / Bash git diff | 104.0 / 104.0 / 104.5ms | 95.3 / 94.9 / 94.7ms |
| PreToolUse Bash `code-agent consent finish <UUID>` | 101.5ms | 102.4ms(+0.9 — 이 꼴에서만 `consent.js`를 읽는다) |
| consent-event 업무 질문 / 동의 질문 | 100.8 / 105.2ms | 101.1 / 105.5ms(바뀌지 않음) |
| Codex PreToolUse / UserPromptSubmit(일반 메시지) / Stop / SubagentStop | 112.2 / 103.9 / 110.9 / 103.8ms | 96.7 / 92.6 / 96.0 / 94.8ms |
| Codex UserPromptSubmit(동의 응답) | 105.6ms | 102.4ms |
| Stop · SessionStart startup · compact · SubagentStart | 85.0 · 92.6 · 92.3 · 87.1ms | 84.7 · 93.2 · 93.1 · 87.5ms(바뀌지 않음) |

hook 진입 모듈 그래프(dist 모듈 수, zod 79 파일 별도): `hook.js` 63→45, `codexHook.js` 69→46, `stopHook.js` 28→28, `sessionHook.js` 34→35.

**동의 준비 출력 글자 수**(새 Node 프로젝트):

| 동작 | 전체(`--for` 없음) | `--for claude` | `--for codex` |
|---|---|---|---|
| `setup` | 11,743 | 5,644(−52%) | 5,739(−51%) |
| `docs` | 6,379 | 2,962(−54%) | 3,057(−52%) |
| `docs --kind architecture` | 3,203 | 1,374(−57%) | 1,469(−54%) |

summary 가 크면 비율이 작아진다(독립 검토 측정: plan 7,868→3,707·abort 4,840→2,193). 적용 결과에 `next`가 붙어 줄어드는 `code-agent status` 한 번은 작업이 없는 저장소 약 620~730자, 작업 중 약 0.6~0.9K자다. `request`·`request begin` 출력은 2,161→1,810자(−16%)다.

**템플릿 크기**(LF 글자, `scripts/template-sizes.cjs`, 기준 `4b1333b`):

| | 기준 | 뒤 | 차이 |
|---|---|---|---|
| 계획 스킬 4개(analyze·impact·design·plan) | 14,248 | 13,698 | −550 |
| Claude 흐름 합계(CLAUDE.block + 흐름 스킬 12) | 50,566 | 50,803 | +237 |
| Codex 흐름 합계(CODEX.block + .agents 스킬 12) | 48,127 | 48,607 | +480 |

흐름 합계 예산은 Claude 51,700자·Codex 49,500자다(`templateBudget.test.ts`). 공통 문단·자리 확인·ca-answer 인라인 문장이 늘었고 계획 스킬의 반복 문단이 줄었다. 대신 `planning advance` 출력마다 `next` 한 줄(약 70~300자)이 더해진다.

**시험 시간**(OPT-11, 같은 PC, 시험 수 1253개로 같음): `npm test` `duration_ms` 207,972 → 112,205(−46%). 가장 긴 파일은 fix-flow 73초다. 최종 `d12bd46` 실행(1292개)은 130,705ms인데, 시험 수가 달라 위 수치와 직접 견주지 않는다.

**그 밖**: 동의 스냅샷 내용 해시 캐시(C5, 파일 1만 개 sandbox)는 1회차 642ms → 2회차 313ms·3회차 307ms(2회차/1회차 48.8%, 해시 같음), 캐시를 지운 뒤 601ms였다. context 렌더러 분리(OPT-16)는 32개 골든 출력이 바이트 동일했다.

**미측정**: 실제 흐름에서 메인 요청·도구 호출·비용이 얼마나 주는지는 유료 평가를 돌리지 않아 재지 않았다. 명세 추정(메인 도구 호출 약 −11회: 연쇄 −3, 동의 JSON Write −4, 적용 뒤 status −4)은 확인되지 않았다. ca-answer 재읽기 감소(상한 3회×8.1K자 → 압축 뒤 0~1회)도 설계상 상한이다. 실제 횟수는 `usage`의 스킬 읽기 줄로 잰다.

## 감사 160건 처리 현황

판정은 문서 관점 독립 검토가 지적마다 코드·단계 기록과 대조한 결과다. 여기에 전체 검토 반영(`d12bd46`)의 처리를 더했다. 검토자 판정(반영 78·일부 29·범위 밖 35·보류 18)에서 `d12bd46`이 아홉 건의 상태를 바꿨다 — DOC-3·DOC-4·DOC-9(일부→반영), DOC-5·DOC-6·DOC-14·DOC-M1(보류→반영), HP-16(범위 밖→반영), HP-14(보류→일부). DOC-7은 일부 그대로이고 메모만 바뀌었다.

| 상태 | 수 | high | medium | low | info |
|---|---|---|---|---|---|
| 반영 | 86 | 3 | 39 | 42 | 2 |
| 일부 | 27 | 1 | 9 | 14 | 3 |
| 범위 밖 | 34 | 3 | 9 | 18 | 4 |
| 보류 | 13 | 0 | 1 | 12 | 0 |
| 계 | 160 | 7 | 58 | 86 | 9 |

DOC-2·DOC-11·HX-3·OPT-17·PVR-20(흐름 문서의 기계 대조)은 `d12bd46`이 대조 시험을 §4.1·§5.1·§5.2·§3.2·§7 표로 넓힌 뒤에도 일부다. 코드가 생성하는 블록은 여전히 §6.4 하나이고, 수치·링크·USAGE 대조는 없다.

### 반영 86

처음 적은 묶음 기준으로 묶었다. 괄호는 함께 처리한 묶음이다.

| 묶음 | 수 | ID |
|---|---|---|
| 감사 `ff13950` | 3 | DOC-1, HX-2, LEARN-M2(+C5) |
| C2 계획 | 10 | FLOW-01, GAP-1, FLOW-04, LRN-2, OPT-5, PVR-5, CON-7, FLOW-M1, PVR-18, PVR-17(+C3) |
| C3 검증 | 8 | FLOW-05, PVR-3, PVR-4, PVR-8, PVR-9, FLOW-06, PVR-13, PVR-15 |
| C6 역할별 모델 | 4 | OPT-12, HX-9, OPT-13, HP-3(+C5) |
| C1 리뷰·교차 | 14 | PVR-1, PVR-2, HP-8, HP-9, VER-M1, VER-M2, HOST-M1, HP-10, HP-12, HP-13, PVR-11, PVR-12, PVR-16, PVR-6(+C5) |
| C5 동의·hook | 16 | CON-1, CON-2, CON-3, CON-4, CON-5, CON-8, LRN-5, CON-9, CON-14, CON-16, CONS-M1, OPT-10, CON-12(+C7), FLOW-18(+C6), DOC-3(+전체 검토), DOC-4(+전체 검토) |
| C4 단계·CLI·임대 | 20 | FLOW-02, FLOW-03, FLOW-07, FLOW-08, FLOW-11, HP-5, OPT-8, PVR-7, DOC-8, FLOW-09, FLOW-10, FLOW-12, FLOW-13, FLOW-16, FLOW-17, HP-2, VER-M3, HP-4(+C7), HP-11(+C1), DOC-9(+전체 검토) |
| C7 최적화 | 6 | OPT-1, OPT-6, HX-12, OPT-14, OPT-4, OPT-11 |
| 전체 검토 `d12bd46` | 5 | DOC-5, DOC-6, DOC-14, DOC-M1, HP-16 |

### 일부 27

| ID | 심각도 | 처리 | 남은 부분 |
|---|---|---|---|
| DOC-2 | high | 감사 + 공통 모듈 | 코드 생성 블록은 §6.4 하나, usage·design 의 중복 흐름 서술 |
| CON-6 | medium | C5 | Codex 업무 답은 관찰하지 않는다 — `[Source]: 대화`로 화면에 드러낼 뿐이다 |
| DOC-10 | medium | C5 | `update.ts` hook 출력은 인라인 9개, 문서의 hook 수 반복 |
| DOC-11 | medium | 공통 모듈 + C5·C6·C7 | 수치·링크·USAGE 대조 없음 |
| FLOW-14 | medium | C2 | 메인이 쓴 출처 없는 질문은 여전히 겹치는 모든 작업을 낡게 한다 |
| FLOW-15 | medium | C4 + C7 | 흐름도 생성·템플릿 명령 lint 없음 |
| HX-3 | medium | 공통 모듈 + C5·C6·C7 | DOC-11 과 같은 범위의 기계 대조만, doc-gardening 없음 |
| OPT-2 | medium | C7 | `--for` 없으면 전체 출력, summary 첫 표시 유지 |
| OPT-9 | medium | C4 + C7 | 호스트 조건 블록 전환 안 함(정규식 변환 유지) |
| OPT-17 | medium | 감사 | 코드 대조는 §6.4·일부 표만 |
| CON-13 | low | C5 | Claude 쪽 hook 프로세스 실패(PATH·timeout)는 비차단 |
| CON-15 | low | C5 | hook timeout 명시 안 함 |
| CON-17 | low | C5 | 폴더 단위 삭제(`rm -rf .claude`)는 못 막음 |
| DOC-7 | low | C1 + C4 + 전체 검토 | design.md §6 표의 verify·read·planning·consent 행 |
| DOC-13 | low | C5 + C7 | CLI 명령 상수 없음 |
| HP-14 | low | 전체 검토 | `.cmd` 래퍼 파싱(다음 묶음 — 호스트 동등성) |
| HP-15 | low | C2 + C1 | Codex 담당 되돌림(block) — 지원 미확인이라 안 함 |
| HP-20 | low | C1 + C7 | 교차를 끄는 설정은 두지 않음(사용자 결정) |
| OPT-3 | low | C7 | 질문·동의 파일 분리 |
| OPT-15 | low | C5 + C7 | hook 전용 번들 |
| OPT-16 | low | C7 | `submitPlan` 등 거대 함수·템플릿 조각 |
| PVR-10 | low | C1 | `--max-budget-usd` 전달 |
| PVR-14 | low | C3 | TAP 헤더 요구·보고서 경로 선언 |
| PVR-19 | low | C7 | 독립 Task 병렬화는 하지 않음(Codex `agent_id` 없음) |
| CON-18 | info | C5 | 모드×호스트×도구 판정표·흐름도 생성 |
| HP-22 | info | C4 | 변환 문구 품질 전수 점검 |
| PVR-20 | info | 감사 | 코드 생성은 §6.4 하나 |

### 범위 밖 34

| 사유 | 수 | ID |
|---|---|---|
| 자가 학습 보류(사용자 결정) | 17 | HX-1, LRN-1, HX-4, HX-10, HX-11, LEARN-M1, LRN-4, LRN-6, LRN-7, LRN-8, LRN-9, LRN-10, LRN-11, LRN-12, LRN-13, LRN-14, PVR-21 |
| 호스트 자체 기억 — 자가 학습과 같은 축 | 1 | GAP-3 |
| HX-5 경량 경로 제외(사용자 결정) | 1 | HX-5 |
| 실제 모델 호출 금지(이번 규칙) | 1 | HP-21 |
| Codex 호스트 동등성 — 이번 다섯 갈래(절차 결함·재시도 규약·최적화·역할별 모델·교차) 밖 | 14 | HP-1(Codex 검색 수단 없음), GAP-2(AGENTS.md 32KiB 한도), HAR-M1(Codex 메인 평가 하네스), HX-6·HP-6·CON-10(Codex SessionStart), HP-7·HOST-M2(역할 TOML 쓰기 제한), CON-11(Codex Stop 반복 차단 상한), DOC-M2·OPT-M1(Codex `ca-answer/reference.md` 고아), HP-17(`code-agent read` JSON 출력), HP-18(Codex 단독 doctor·update 검사), HP-19(상시 지침 블록 표류) |

LEARN-M1 의 KNOWLEDGE 256KB 이후 항목 누락은 자가 학습과 묶어 범위 밖으로 두었지만 결함은 남아 있다.

### 보류 13

| ID | 심각도 | 다음 |
|---|---|---|
| HX-7 | medium | 배포·버전 — version 1.0.0 고정과 `templateHash`의 상류 변경 오인은 릴리스 절차와 함께 정한다(C6 이 머리말 model·effort 줄만 뺐다) |
| GAP-4 | low | 측정 — 평가 스크립트의 날짜 고정 파일명·모델은 유료 평가 실행(사용자 승인)과 함께 고친다 |
| GAP-5 | low | 사용자 결정 필요 — CI 도입과 실행 플랫폼(지금 Windows 단일) |
| DOC-12 | low | 문서 구조 — README 변경 이력 문단·목차 밖 절 정리 |
| DOC-M3 | low | 문서 구조 — README 흐름 표의 입력할 곳 열을 호스트 중립으로 |
| HX-8 | low | 검증 효율 — 기준선 build·Task별 증분 build |
| HX-13 | low | 측정 — 스킬 description 호출 경계·진입률 평가(실제 모델 호출 필요) |
| LRN-3 | low | KNOWLEDGE 반영 — 같은 키 upsert 가 항목 전체를 교체 |
| LRN-15 | low | KNOWLEDGE 반영 — 항목 출처(작업 ID) 기록 |
| LRN-16 | low | KNOWLEDGE 반영 — 근거 부족 제안 사유를 확인 화면에 |
| LRN-17 | low | KNOWLEDGE 반영 — knowledge prune 결과의 다음 deliver 혼입 |
| LRN-18 | low | KNOWLEDGE 반영 — 같은 제안 파일의 중복 키 검사 |
| OPT-7 | low | 최적화 2차 — critic 과 교차 계획 검토의 병렬화(교차 지점 정의를 바꾼다) |

## 최종 테스트 결과

- **`d12bd46` 재검증** — 작업 트리가 깨끗한 상태에서 `npm run build && npm test`를 한 번에 실행했다. build·test 모두 exit 0이다. tests 1292 · suites 183 · pass 1288 · fail 0 · cancelled 0 · skipped 4 · todo 0, `duration_ms` 130,705(약 131초)이고, 빌드를 합친 벽시계는 132초다. 생략 4개는 플랫폼 조건(대소문자 구분 없는 파일 시스템 2개, POSIX chmod 2개)이다. [전체 검토 기록](2026-10-08-full-review.md)의 결과(1292개 중 1288개 통과·실패 0·생략 4, 130초)와 같다. 그 기록이 적은 crossReview 고아 pid 시험의 간헐 실패(Windows pid 재사용)는 이번 실행에서 나오지 않았다.
- **e2e 재실행**(가짜 호스트 실행 파일, 23개 실행, 421초) — 검사 수가 이전과 같다(e2e-claude 104, codex 98, claude-x 107, codex-x 102, claude-reentry 55, codex-reentry 54, claude-b2 59, codex-b2 57, claude-modelpre 106, question 12/11, planfmt 6/5, crossblock 3, crossfix 1). 이전 major 지적 E1(허용 적용 뒤 next 가 `verify --json`)은 사라졌다. 이제 `code-agent verify --json --retry`가 나온다. E10·E7·E8·E11·E5·E12 반영과 E2 경고를 출력에서 확인했다. 의도된 변경 때문에 낡은 가정으로 실패한 실행이 셋 있다. 하나, e2e-both 계열은 미설치 흉내로 쓴 없는 파일을 E20이 이제 설정 오류로 분류해서 실패했다 — 미설치 흉내를 '인증 안 됨' 가짜로 바꾼 사본에서 both 128 · both-codex 127 · both-x 131 · both-codex-x 134 검사, 지적 0, 모두 exit 0이다. 둘, e2e-cxstaging-codex 는 E9가 Codex 배정 계약에서 staging 을 뺐기 때문에 실패했다. 셋, e2e-claude-model·e2e-both-model 의 E2 지적은 경고만 더했고 근본 처리는 사용자 결정이라 남는다.
- **재시도 규약 탐침**(policy run-all) — P7(실행 중 교차 시도의 분류)·P8(동의 안내 문구의 두 원천)은 재현되지 않았다(E22·E23으로 고쳐짐). P1~P6 은 문서화된 이유로 그대로 확인된다: P1 총 회차는 허용 대상이 아니라는 설계 조건, P2 E16 사용자 결정, P3 순수 판정 함수 수준, P4 기록하지 못한 실패 입력, P5 '안내만' 문구, P6 탐침이 설정 오류 표지 없이 분류 함수를 부름. 실제 경로(`hostCommand` → `hostCommandConfigError`)는 `cross-config-error`로 분류된다.
- **hook 판정 행렬**(실제 hook 프로세스, 5,040 경우 × 빌드 셋) — `934e5fe`→`d12bd46`에서 약해진 판정 0, 강해진 판정 56이다(모두 MCP 도구의 프로젝트 상대 경로 키 사례, Claude 28·Codex 28 — E30). 감사 기준 `c4f3fbf`→`d12bd46`에서 약해진 판정 72는 모두 세션 중 셸의 `takeover`·`doctor --cross` 허용이다(C4 의 FLOW-10·작업 임대 — 의도한 변경).
- **요약 기록 커밋(`16ae5ec`)** — 문서만 바꿨다. 커밋 전 이 트리에서 `npm test`(tsc 포함)를 실행했다. 첫 실행은 1292개 중 1287개 통과·실패 1·생략 4(144,355ms)였다. 실패한 시험은 전체 검토 기록이 적은 그 간헐 실패(crossReview '게이트 쪽 고아 보기 — 사람이 아닌 중지 지점에 끝 기록 없는 시도(죽은 pid)…')다. 죽은 pid 를 병렬 시험이 다시 받아 실행 중으로 보인 것이고, 문서 변경과는 관계없다. 그 파일만 두 번 돌리면 40개 모두 통과하고, `docSync.test.js`는 6개 모두 통과한다. 다시 돌린 전체 실행은 **1292개 중 1288개 통과·실패 0·생략 4**(suites 183, `duration_ms` 141,251)다. 이 간헐 실패는 9단계 R6 이 고쳤다.
- **최종 재검증 후속 수정(9단계)** — `npm run build && npm test` 단일 전체 실행에서 build·test 모두 exit 0 이다. tests 1311 · suites 189 · pass 1307 · fail 0 · cancelled 0 · skipped 4 · todo 0, `duration_ms` 137,876(빌드를 합친 벽시계 140초)이다. 더한 19개는 `finalReverify.test.ts`의 R 시험이고, 수정 열 군데를 하나씩 되돌린 변이 검사에서 해당 R 시험이 모두 깨졌다. crossReview 를 단독으로 6회 돌려 모두 40/40 이었다. pid 를 쓰는 시험 파일 8개를 동시에 띄운 부하 실행 2회(16 실행)도 실패 0 이다. 실제 hook 프로세스에 임시 홈을 주고 넣은 R1 별칭(36개 × 도구 5개, 셸 8꼴)에서 새는 길은 0 이다.

## 미확인·사용자 결정 필요·남은 일

**사용자 결정 필요**([전체 검토](2026-10-08-full-review.md#사용자-결정-필요))

1. 작업 중 역할 모델 변경(E2, C4 인계 #9) — 진행 중 작업에서 `model` 동의나 `update --templates-only`가 커밋된 설치 파일(`.claude/agents/ca-*.md`·`.codex/agents/ca-*.toml` 등)을 바꾸면 계획 밖 변경이 된다. 설치 파일을 계획 밖 변경 대조에서 뺄지, 작업 중에는 이 둘을 막을지 정해야 한다. 지금은 경고만 낸다.
2. 샌드박스 의심 지점의 두 번째 네트워크 오류(E16) — 지금은 실행 불가로 중지 기록 후 진행한다. 사람 `judgment cross-stop`으로만 중지하게 바꾸면 '교차 실행 불가 시 중지 기록 후 진행'과 부딪힌다. 그대로 두면 모델이 한 번 재실행해 교차가 빠질 수 있다.
3. 실행 파일 설정 오류의 분류(E20) — 없는 파일을 가리키는 실행 파일 변수와 PATH 의 셸 스크립트를 설정 오류(게이트 막힘)로 엄격화했다. 명세 §2.3(실행 불가)과 다르므로 확인을 권한다.
4. CI 도입과 실행 플랫폼(GAP-5) — 지금은 Windows 한 대에서만 돈다.

**실제 호스트에서 확인할 항목**(모두 실제 모델 호출 없이 판독·바이너리·fixture로만 확인했다)

- 실제 Claude·Codex 오류 문구(인증·한도·모델 없음·네트워크) — 교차 실패 분류 화이트리스트(C1). 처음 보는 문구는 설정 오류(막힘)로 간다.
- Codex 셸의 환경 표지(`CODEX_CI`·`CODEX_SANDBOX*`·`CODEX_THREAD_ID`)와 PTY 실행 여부 — 같은 호스트 거부·샌드박스 사전 판정·표기 판정이 기댄다(C1·C4·C5). 직접 CLI 확인(`confirmOnTerminal`)이 호스트 표지를 보지 않는 한계도 여기에 걸린다.
- `session_id` 동일성 — Codex PreToolUse 와 UserPromptSubmit(C5 — 바이너리 스키마로 존재만 확인), SessionStart 와 다음 PreToolUse(C4), Codex 서브 에이전트와 메인.
- SubagentStop exit 2 로 담당이 실제로 고쳐 다시 반환하는지(Claude), Codex SubagentStop 의 되돌림 지원(HP-15).
- 교차 자식의 hook 환경 상속(C1).
- 교차 실행 인자 `--effort`·`model_reasoning_effort`의 실제 호출, Claude Code 가 `xhigh`·`max`를 `high`로 낮추는지(바이너리 문자열로만 확인), 이전 설치의 하위 에이전트가 세션 강도를 물려받았는지(C6).
- Codex 세션 기록 형식(`rollout-*.jsonl`)과 셸 래퍼 꼴(C7 — 이 PC 에 Codex 기록이 없어 공개 형식 가정).
- SessionStart `source`(compact·clear) 값, AskUserQuestion 이 긴 본문을 자르는지(C7).
- Codex `commandWindows`의 실행 셸, Claude Code 의 PowerShell 대체 버전(C5).
- Codex 를 메인으로 한 접수부터 반영까지의 전체 흐름(HP-21).
- 단일 실행 파일(SEA) 빌드 — 돌리지 않았다. esbuild 번들로 지연 `require`만 확인했다(C7).

**유료 A/B 측정**(사용자 승인 뒤)

- 역할별 모델(C6) — `node scripts/evaluate-full-flow.cjs run new --model opus --agents exec-opus --label c6-execopus-<n>`과 `--agents policy --label c6-policy-<n>`을 각 3회 돌린다. 두 쪽은 실행 역할의 모델 하나만 다르다.
- 최적화 효과(C7) — `scripts/evaluate-full-flow.cjs` 3회(보고서의 `usageData`·`retry`·`numTurns`)와 `scripts/summarize-evaluations.cjs`로 흐름당 메인 요청·도구 호출·비용을 잰다. 동의 왕복은 평가 드라이버가 TTY fixture 로 대신하므로 실제 세션의 `usage` 명령별 호출로 잰다.

**범위 밖**(이번 결정)

- 자가 학습 — 교훈·recall·retro·환류(지적 17건, GAP-3 포함 18건). 측정은 읽기만 한다.
- HX-5 — 작은 작업용 경량 경로.
- Codex 호스트 동등성 14건 — Codex 검색 수단(`code-agent grep`·`files` 없음, HP-1), Codex SessionStart(HX-6·HP-6·CON-10), 역할 TOML 쓰기 제한(HP-7·HOST-M2), Codex Stop 반복 차단 상한(CON-11), AGENTS.md 32KiB 한도(GAP-2), `ca-answer/reference.md` 고아(DOC-M2·OPT-M1), `code-agent read` JSON 출력(HP-17), Codex 단독 doctor·update 검사(HP-18), 상시 지침 블록 대조(HP-19), Codex 메인 평가 하네스(HAR-M1).

**남은 일**

- 보류 13건의 다음 배정(위 표) — 배포·버전, 측정, 문서 구조, 검증 효율, KNOWLEDGE 반영, 최적화 2차.
- 일부 27건의 남은 부분(위 표).
- 전체 검토에서 일부만 반영한 것 — E13 의 (b)안(총 회차를 사람 허용 대상에), E19 의 기록하지 못한 판정 실패(2로 남김), E26 의 동의 적용 잠금 나이 상한, E27 의 다른 세션 경고 줄, E30 의 판정하지 못한 MCP 이름 기록.
- 문서화된 한계 — Codex 두 세션의 동시 진행은 작업 임대가 막지 못한다(호스트 단위 비교). `codex exec resume` 프롬프트는 가르지 못한다(CON-1). Codex 확인 코드는 사람 입력의 증명이 아니다(CON-5).
- 최종 재검증(9단계)에서 남긴 것 — hook 의 셸 언급 판정은 여전히 글자 그대로 쓴 경로만 본다. 따옴표로 쪼갠 이름이나 변수로 조립한 이름은 잡지 못한다(R1, hook 은 보안 경계가 아니다). 이름으로 모르는 UNC(FQDN 등)로 사용자 수준 호스트 설정을 가리키면 파일 시스템이 주는 (dev, ino)에 기댄다. SMB 가 파일 번호를 다르게 주면 놓칠 수 있다. 검증 명령이 code-agent 기록을 바꾼 실행에서 verify 는 결과 JSON 을 내지 않는다(R2 — `precondition`의 노드 없는 Stop 설계). 흐름도의 `src/` 줄 인용은 머리말 규칙대로 기준 커밋 기준이라 HEAD 와 기계 대조하지 않는다(R5).

## 근거

- 단계별 기록: [공통 모듈](2026-10-07-retry-policy-module.md) · [계획](2026-10-07-planning-retry-orchestration.md) · [검증](2026-10-07-verify-retry.md) · [역할별 모델](2026-10-07-role-models.md) · [교차](2026-10-07-cross-integrity.md) · [동의·hook](2026-10-08-consent-hook-boundary.md) · [단계 전이](2026-10-08-stage-flow.md) · [최적화](2026-10-08-optimization.md) · [전체 검토](2026-10-08-full-review.md) · [감사 처리 현황](2026-10-08-audit-disposition.md)
- 원자료: [procedure-fix-2026-10-08.json](evidence/procedure-fix-2026-10-08.json)(처리 현황 160건·커밋·테스트·실측), [audit-disposition-2026-10-08.json](evidence/audit-disposition-2026-10-08.json), [consent-hook-boundary-2026-10-08.json](evidence/consent-hook-boundary-2026-10-08.json), [process-audit-2026-10-07.json](evidence/process-audit-2026-10-07.json)
- 재검증 로그와 sandbox 는 작업 scratchpad(`reverify/` — build·test 로그, e2e·policy 실행 출력, hook 판정 행렬)에 있다. `dist/`와 함께 재생성 가능한 로컬 산출물이라 커밋하지 않았다.
