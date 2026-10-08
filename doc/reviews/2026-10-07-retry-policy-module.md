# 실패 원인별 재시도 규약 공통 모듈 (2026-10-07)

감사([2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)) 뒤 첫 구현 커밋이다. 판정 지점(계획·검증·리뷰·교차·동의·hook)에 연결하기 **전에** 공통 모듈과 문서 생성 블록을 먼저 넣었다 — 기존 모듈의 동작은 이 단계에서 바꾸지 않았고, 각 지점은 뒤 묶음(C1~C7)이 연결했다. 이 기록은 두 커밋(`2327975` 구현, `3b5e867` 독립 검토 반영)을 뒤에 정리한 것이다 — 당시 검토 메모는 작업 scratchpad 의 인계(`handoff-F.md`)였고 저장소에는 커밋 메시지와 흐름도만 남아 있었다.

## 구현 (`2327975`)

- `retryPolicy.ts` — 원인 21개(앞 19개는 감사 과제의 원인, `precondition`·`hook-failure`는 분류 밖으로 새는 Stop·hook 예외를 담는 보조 분류)의 정책·카운터·한도·사람 허용 범위(`grantScope`), 검증 회차·계획 배정·교차 실행 분류·교차 지점·잠금·hook 실패 코드 판정 함수, 호스트 중립 안내 문구와 `GUIDE_KEYS` 계약, 측정용 `retrySummary`, 흐름도 표 렌더. 순수 모듈이다(`stop.ts`만 import — hook 이 매번 읽는다).
- `lock.ts` — 공통 파일 잠금 `acquireLock`(주인 기록, 같은 PC 의 죽은 pid·주인 없는 10분 잠금 회수, 대기·중지 문구)과 `pidAlive`.
- `crossEnv.ts` — 실행 환경 표지(`runtimeHost`·`crossChild`·`sandboxMarkers`·`hostMarked`·`crossChildEnv`, 순수 모듈).
- `hostText.ts` — 호스트별 표기(`skill`·`agentName`·`askVia`·`viaShell`·`shellLabel`·`fileToolsHint`)와 `notationFor` 판정 순서.
- 시험: retryPolicy·lock·crossEnv·hostText·docSync — 교차 실패 분류 fixture 40건, 회차·지점 진리표, 순수성 검사, 생성 블록 바이트 대조.
- `doc/process-flow.md` §6.4 생성 블록(`renderRetryPolicyTable()`)과 §1.1·§9·§10, `AGENTS.md` 중복 정의 두 줄.

## 독립 검토 반영 (`3b5e867`)

검토 지적 14건을 코드로 확인했다. 주요 반영은 다음과 같다.

| 지적 | 처리 |
|---|---|
| 담당 형식·내용 오류의 기본 안내가 기록 문구라 C2 되돌림과 어긋난다(major) | 기본 문구를 되돌림 문구로, 기록 문구는 `record` 변형으로 옮기고 `recordedVariant`로 고른다(끊긴 교차 실행은 `interrupted` 변형) |
| 교차 실패 분류의 거짓 양성 — 전사·모델 문장·hook 안내가 화이트리스트로 샌다(major) | `crossFailureText`가 Codex 세션 출력은 끝에서 이어진 `ERROR:` 줄만(없으면 마지막 줄), stdout 은 끝의 `ERROR:` 줄만, Claude stderr 도 오류 줄만 본다. 거짓 양성 7건을 fixture 로 고정(40 → 51건), Codex probe 의 `sentPrompt`는 타입으로 필수 |
| 교차 카운터의 사용 수 의미가 갈린다 | `crossBudgets` 하나가 지점·원인별 예산을 계산한다 — 설정 오류·시간 초과는 첫 실패 뒤의 재실행 수. 연속이 아닌 두 번째 제한 시간 초과는 연속이라 쓰지 않는다 |
| 동시 회수가 남의 새 잠금을 지운다 | 회수를 `<잠금>.reclaim` 가드로 직렬화하고 가드 안에서 다시 판정, 주인 기록에 nonce·자기 기록만 해제, Windows EPERM·EACCES 재시도 |
| `COUNTER_LABEL`·`hookFailureInput`·옛 증거의 엄격해지는 판정·결과 미확인 노드 | 이름표의 단일 원천 선언, hookFailureExit 입력은 `hookFailureInput`으로만, 끊긴 회차 뒤 수정을 고쳐 쓰기로 세는 단 하나의 엄격해지는 판정을 주석·§6.4 산문에, 결과 미확인 노드·`nodeCounter` 진리표 |

## 인계(뒤 묶음이 한 일)

각 판정 지점의 연결은 C1(리뷰·교차)·C2(계획)·C3(검증)·C4(단계·CLI)·C5(동의)·C6(역할별 모델)·C7(최적화)의 기록에 있다. 이 모듈의 뒤 수정(사람 허용 줄·통과 뒤 변경의 리뷰 회차·안내 문구 단일 원천 등)은 [전체 검토 반영](2026-10-08-full-review.md)에 있다.
