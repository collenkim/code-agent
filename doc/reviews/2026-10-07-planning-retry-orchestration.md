# 계획 오케스트레이션 — 교착·무효화 범위·결정적 문서 검사와 재시도 규약 연결

- 날짜: 2026-10-07
- 기준: 브랜치 `fix/procedure-retry-optimization`, 부모 커밋 `3b5e867`(재시도 규약 공통 모듈 검토 반영)
- 범위: 계획 단계(analysis·impact·design·plan)의 배정·완료 관찰·질문·잠금·후보 순위. 검증 노드·리뷰·동의·교차 실행 분류는 이 변경의 범위가 아니다.

## 경위

[2026-10-07 감사](2026-10-07-dual-host-process-audit.md)의 계획 쪽 지적을 실패 원인별 재시도 규약(`retryPolicy.ts`, [흐름도 §6.4](../process-flow.md#64-실패-원인과-재시도-규약-retrypolicyts))에 연결했다. 사용자 결정은 다음과 같다: 절차 결함 보완, 실패 원인별 재시도 규약은 코드가 강제하고 문서화, 사람 확인 지점 유지, 자가 학습 보류. 공통 모듈(`retryPolicy.ts`·`lock.ts`)은 앞선 커밋의 것을 그대로 썼고 고치지 않았다.

## 지적별 결정

| 지적 | 결정 | 구현 |
|---|---|---|
| FLOW-01 — 앞 단계 질문·입력 변경이 교착을 부른다 | fix | 담당·교차 검토 질문에 `[Origin]: <작업 ID>`를 기록하고, 출처가 있는 질문은 출처 작업과 그 후손에만 적용한다. 그래도 앞 단계 작업이 낡으면 `planning advance`가 배정 대신 `rewind-required`를 낸다 — 같은 사유의 첫 회만 `rewind.auto: true`(스킬이 사용자 지시 없이 되감는 유일한 예외), analysis까지 또는 기준 커밋·code-agent.json·호스트 지침 변경이면 `rewind.notice` 한 줄. 차단 지적은 `feedback[].citedTask`(근거 문서를 낸 작업)만 보이고 되감지 않는다 |
| FLOW-14 — 질문 무효화 범위가 넓다 | partial | 교차 질문의 `[Requirements]`는 결과 원소에서 뽑은 요구 키만 쓰고 비면 critic 요구로 채운다. 메인이 쓰는 질문은 계약·ca-answer 문장으로 `[Origin]`을 안내한다(강제하지 않음). `staleBecause`가 어느 질문 때문인지 보인다 |
| FLOW-04 — 고아 배정이 영영 running이다 | fix | `orphanState` 세 갈래. 확실한 고아(연결 담당이 끝났는데 결과 없음)는 advance·dispatch가 `orphaned`로 표시하고 같은 호출에서 재배정한다. 의심 고아(시작 미관찰 10분 — 배정 뒤 마지막 담당 활동부터, 시작 관찰 60분)는 `stale`·`cancel`. 고아 정리는 동시 한도보다 먼저. `planning status`의 `run`, SessionStart의 실행 중 배정 요약 |
| PVR-5 — 식별 불일치가 기록 없이 반복된다 | fix | 완료 hook을 잠금 밖 준비 + 잠금 안 판정(값 반환)으로 재구성. 식별 불일치·특정 불가·출처 검증 실패도 담당 `failure`를 남기고 연결 시도를 `orphaned`로 둔다. Claude 첫 Stop만 되돌리고(`subagentExit`), Codex 담당 이벤트는 기록 후 언제나 0 |
| FLOW-M1 — 잠금이 고착된다 | fix | `mutatePlanning`이 공통 `acquireLock`을 쓴다(주인 기록, 같은 PC의 죽은 주인·10분 넘은 빈 잠금 회수, hook 대기 10초, 문구에 저장소 상대 경로) |
| PVR-17 — 재배정 한도가 원인을 구분하지 않는다 | partial(계획 쪽) | 같은 inputHash의 failed만 3회(`sameInput`), `retry.since` 이후 작업별 배정 6회(`taskTotal`, 취소·고아 포함), 사람 허용(`grantPlanningRetry`). 검증 쪽은 다른 묶음 |
| OPT-5 — 문서 형식 실패를 게이트에서야 안다 | fix | `stagedChecks.ts` — 완료 hook이 staging 본문에 그 역할의 게이트 함수(`next`·`plan submit`과 같은 함수)를 먼저 돌린다. plan 역할은 07과 plan.json의 스키마·tasks·AC·요구 커버리지·남은 질문까지(`planShapeProblems`를 `plan submit`과 공유). 최종 게이트는 그대로 |
| GAP-1 — 후보 순위가 3,000개에서 잘린다 | fix | 경로 점수는 전 파일, 본문은 32 MiB 예산 안에서 경로 일치 → 테스트 아님 → 테스트 순서로 읽는다. 순회는 오름차순 깊이 우선. 잘렸으면 `- 범위:` 줄 |
| CON-7 — 질문 본문 주입 검사가 파서보다 약하다 | fix | `QUESTION_FIELD_LINE`(m 플래그 `^\s*`, `[Origin]`·`[Source]` 포함)을 담당·교차 결과 모두에 적용. 출처는 `[Answer]:` 앞 `\n` 줄의 마지막 `[Origin]:` 줄에서 `ORIGIN_ID`로 읽는다 |
| LRN-2 — 업무 규칙 KNOWLEDGE를 먼저 찾지 않는다 | fix | 새 analysis·design 기본 작업의 inputs에 업무 규칙 KNOWLEDGE를 넣고, analysis context에 접수 요구 낱말로 고른 참고 문서 절을 싣는다. 기존 작업은 그대로 |
| PVR-18 — 같은 해시를 여러 번 계산한다 | fix | 명령 1회 범위 메모(`withPlanningCache`) — 파일 sha·질문 본문은 bigint stat `(mtimeNs, size, ino)` 검증, `git ls-files`는 root별, 입력 해시는 진입·쓰기 때 버리는 판정 메모. 되감기는 메모를 모두 버린 값으로만 확정 |

## 하위 호환

- `planning.json`은 `version: 1` 그대로이고 새 필드는 모두 선택이다. `retry`는 처음 쓸 때 `since = 지금`으로 만들어 옛 시도는 작업 총 배정에 세지 않는다. 옛 빈 `.lock`은 10분 뒤 회수된다.
- 입력 해시의 직렬화 객체는 키 순서까지 그대로이고, 질문은 고정 투영(`hashedQuestion`)으로 넣는다. 선택지 줄·`[Status]`·범위 없는 질문이 있는 옛 `questions.md`의 해시를 구현 전 dist로 뽑아 골든 값(`sha256:db1f7ff0e520c33d`, 옛 계약 `sha256:c21019bbdf154ea9`)으로 고정했다 — 진행 중 작업의 완료 결과가 갱신만으로 낡지 않는다.
- 승인 해시는 작업별 마지막 시도만 묶는다. 새 필드(`inputParts`·`failure`)는 새로 기록하는 시도에만 붙고, `agents`·`retry`는 승인 해시 밖이다.

## 명세와 다르게 정한 것

- advance의 같은 입력 failed 항목은 같은 입력 실패 한도를 다 썼을 때 `class: same-input-repeat`(그 전에는 시도의 `failure.class`)로 낸다 — 한도를 다 쓴 작업은 명시 배정도 거부되므로 재배정 안내 대신 한도 안내를 준다(테스트 T13이 기대하는 값). 그래서 `reasons` 둘째 줄도 명세 §3.5의 "그대로"(`원인을 해결한 뒤 planning dispatch로 명시적으로 재배정하세요.`)가 아니라 `guidance("same-input-repeat")` 문구로 바뀐다(한도 전에는 그대로다).
- 입력 해시 메모 키에 작업 그래프(조상·작업 목록)를 더했다. 명세의 키보다 넓어 같은 명령 안의 작업 등록 변화도 놓치지 않는다.
- 실행 관찰(`runView`)은 `planningState.ts`에 두었다 — SessionStart hook이 `planning.ts`를 읽지 않게 하려고.
- SessionStart의 취소 안내는 실제 ID를 넣는다(`code-agent planning cancel analysis`).
- 500,000자를 넘는 결과는 형식 오류로 다루되 원본을 보존하지 않는다(상태 파일 비대 방지). 교정할 원본이 없으므로 Claude 첫 Stop의 되돌림 뒤(또는 Codex)에는 `needs-correction`이 아니라 `failed`로 기록한다(독립 검토 반영 1). 교정으로 기록된 결과는 이전 형식 오류의 `failure`를 지운다.
- 교차 critic 결과 스키마(`CrossCriticSchema`)를 테스트를 위해 export했다.

## 검증

- 단계마다 `npm run build` 뒤 해당 테스트 파일을 돌렸고(명세 §10), 마지막에 `npm test` 전체를 돌렸다: **915개 중 911개 통과·실패 0개·생략 4개**(이 기록을 쓴 시점의 단일 전체 실행).
- 새 테스트(`planning.test.ts` 40개, `p7.test.ts` 1개)는 질문 출처·되감기(auto·반복·notice)·메모의 stat 검증·교차 질문 주입·해시 골든·출처 범위·stale·고아·되돌림(Claude)·즉시 기록(Codex)·문서 검사·한도·이행·사람 허용·잠금 회수·구조 필드 검사·업무 규칙 연결·SessionStart·status·차단 지적 후보·Codex 사본 문장을 확인한다. 기존 테스트 기대값은 명세가 정한 다섯 곳만 바꿨다(세 번 취소 → 총 배정 6회, 완료 hook 되돌림 순서, 교차 질문 주석과 plan current, 입력 변경 완료의 `cancelled`, Codex 담당 이벤트 판정 실패의 exit 0).
- 실제 호스트(Claude·Codex)에서 SubagentStop exit 2로 담당이 staging을 고쳐 다시 반환하는지는 확인하지 않았다. `agents[].returns` 상한이 반복을 막는다.

## 남은 위험

- 시작 관찰 60분은 근거 없는 보수적 값이다. 큰 영역 조사가 넘으면 `stale`로 보여 살아 있는 담당이 취소될 수 있다(`elapsedMin`·`observedStart`를 함께 보인다).
- 같은 사유 판정 키는 낡은 원인 문구로 만든다. 같은 파일을 정당하게 두 번 고쳐도 두 번째는 사람에게 묻는다(보수 쪽).
- 메인이 쓰는 출처 없는 질문은 여전히 겹치는 모든 작업을 낡게 한다(안내만 한다).
- 작업 총 배정 6회는 질문 답에 따른 정상 재배정도 센다(plan·critic은 critic 지적·교차 지적·critic 질문만으로도 닿을 수 있다). 사람 허용을 동의로 기록하는 경로(`judgment retry-grant` → `grantPlanningRetry`)는 동의 묶음과 같은 릴리스에 들어가야 막힌 작업의 탈출구가 생긴다 — 이 커밋까지는 같은 작업을 다시 준비해도 시도 기록이 남아 남는 길이 작업 종료(abort)뿐이다. 거부 문구와 현행 문서는 지금 실행할 수 있는 길만 적었다(독립 검토 반영 7).
- Codex 담당 이벤트의 판정 실패를 언제나 0으로 통과시키므로, 리뷰어 형식 오류를 기록하도록 바꾸기 전에는 Codex 리뷰어 형식 오류가 stderr에만 남는다.

## 독립 검토 반영

독립 검토의 지적 13건(major 1·minor 12)을 코드와 sandbox(`s4-late-start`·`s5-total`·`s6-source-orphan`·`s7-handback` 재현 스크립트)로 하나씩 확인했다. 모두 재현됐고, 아래처럼 반영했다.

| # | 지적 | 판단 | 반영 |
|---|---|---|---|
| 1 | minor — 500,000자를 넘는 결과가 빈 원본으로 `needs-correction`이 되어 교정 대조가 건너뛰어진다 | 반영 | 교정할 원본이 없으므로 Claude 첫 Stop의 되돌림 뒤(또는 Codex)에는 `failed`(`agent-format-error`)로 기록한다. 교정은 거부된다 |
| 2 | minor — 연결하지 못한 담당이 취소·교체된 배정의 결과를 늦게 내면 복사 오류로 되돌린다 | 반영 | 보고한 시도가 이미 running이 아니면(취소·고아·교체·종료) 담당의 시작 연결과 상관없이 늦은 결과다. 형식 오류 분기도 식별 필드로 같은 판정을 한다 — 늦은 담당이 형식까지 틀린 결과를 내면 같은 이유로 새 배정이 되돌림·고아 표시를 받았기 때문이다 |
| 3 | minor — 같은 입력 failed의 `reasons` 둘째 줄이 명세와 다르다 | 코드 유지 | 한도를 다 쓴 작업은 명시 배정도 거부되므로 한도 안내가 맞다. 위 "명세와 다르게 정한 것"에 적고, C7 `planningNextLine`이 이 문구를 기대하도록 병합 계약에 넘긴다 |
| 4·10 | minor — ca-plan 4-1항·반려 절차·`crossCriticProblems`가 아직 "원인 작업을 다시 배정" | 반영 | 세 곳을 4항·`contract.md:16`과 같은 뜻으로 맞췄다: 고칠 작업은 지적(사유) 내용으로 정하고, 앞 단계 작업이면 원인과 비용을 보고하고 지시를 받는다. Codex 사본의 고정 치환 문장과는 겹치지 않는다 |
| 5 | minor — `planning.md`의 잠금 주인 필드에 `nonce`가 없다 | 반영 | `{pid, host, at, nonce}`로 고쳤다(`planning.ts` 주석도) |
| 6 | minor — plan 문서 검사 실패와 메모 범위 밖 재계산의 단언이 약하다 | 반영 | plan 시도의 `failed`·`agent-content-error`, 범위 밖에서 같은 stat·다른 내용이면 새 sha를 단언한다 |
| 7 | major — 작업 총 배정 한도를 다 쓰면 탈출 경로가 없는데 문구·문서는 사람 허용·재계획을 지금 있는 것처럼 안내한다 | 부분 반영 | 거부 문구(`retryPolicy.ts` `reassign-total` guide — 공통 모듈의 한 문장)와 `planning.md`·`usage.md`·`design.md`·흐름도에서 지금 실행할 수 없는 선택지를 뺐다. 같은 작업을 다시 준비해도 시도 기록이 남는다는 것과 지금 남는 길(abort)을 적고 테스트로 고정했다. 사람 허용을 기록하는 동의(`judgment retry-grant` → `grantPlanningRetry`)는 동의 묶음이 같은 릴리스에서 연결하는 병합 전제로 넘긴다(통합 테스트: 소진 → 동의 → 한도 9 → 배정) |
| 8 | minor — 취소된 배정의 담당이 재배정 뒤 늦게 시작해 새 배정에 연결되면 새 배정이 고아가 된다 | 반영 | 2의 늦은 결과 판정에 더해, 늦은 담당의 연결을 보고한 시도로 옮긴다(새 배정이 그 담당의 종료로 고아 판정되지 않는다). 시도를 고아로 둘 때는 같은 시도에 연결된 다른 미완료 담당이 없을 때만이다(`orphanLinked`). **반영하지 않음**: SubagentStart에서 유일 후보에 미완료 연결 담당이 있으면 연결하지 않는 안. 그러면 s4의 진짜 담당이 미연결이 되고, 늦은 담당이 끝나는 순간 연결 담당이 모두 끝난 것으로 보여 새 배정이 고아로 판정된다. 위 두 변경으로 같은 문제가 막히므로 시작 연결은 그대로 둔다 |
| 9 | minor — 완료 hook이 기록한 고아·실패를 advance가 사유 없이 다시 배정하고, 출처 확인 실패를 반복한다 | 반영 | 다시 배정할 때 직전 시도가 `orphaned`·`failed`면 배정과 CLI 요약에 `previous`(상태·원인·사유)를 싣는다. 출처(transcript) 확인 실패로 고아가 된 시도(`failure.kind: source`)가 두 번 이어지면 자동 재배정 대신 `blocked`(`class: hook-failure`)다. 명시 `planning dispatch`는 받는다 |
| 11 | minor — 메인이 잘못 적은 `[Origin]`이 앞 단계 작업의 무효화를 막는다 | 반영(다른 방식) | 제안된 "출처 작업의 요구와 겹치지 않으면 무시"는 지적한 예(R1 업무 결정에 `[Origin]: critic` — critic도 R1을 가진다)를 막지 못한다. 그래서 질문을 쓴 코드(완료 hook·교차 검토)가 `planning.json` `questionOrigins`에 출처를 남기고, `[Origin]` 줄은 그 기록과 같을 때만 믿는다. 메인이 적은 출처는 무시되고 요구 겹침 규칙을 따른다. 계약(`contract.md:10`)에서 메인의 `[Origin]` 작성 안내를 뺐다. 교차 질문은 계획 기록 잠금 안에서 써서 질문과 출처 기록이 함께 보인다 |
| 12 | minor — 되돌린 뒤 담당이 고친 결과를 최종 응답으로 내도 transcript의 옛 SubagentHandback으로 다시 판정한다 | 반영(시각 대신 순서) | 제안된 `returnedAt` 시각 대신 되돌릴 때까지 판정한 보고 수(`agents[].judgedHandbacks`)를 남기고 그 뒤의 보고만 본다. 없으면 최종 응답을 쓴다. 보고 시각이 되돌린 시각보다 늦게 찍히면(s7처럼) 시각 기준은 옛 보고를 다시 읽기 때문이다 |
| 13 | minor — Codex는 SessionStart가 없어 시작이 관찰된 담당이 끊기면 60분 동안 `wait`이다 | 반영 | `ca-next` 1항에 재개 때 `planning status`의 실행 중 배정을 확인해 이 대화에서 부른 담당이 아니면 cancel 뒤 advance 하는 문장을 넣었다. `codex.md`·흐름도 §7에 60분 경우를 적었다 |

- 하위 호환: 새 필드(`questionOrigins`, `agents[].judgedHandbacks`, 시도 `failure.kind: source`)는 모두 선택이다. 이 브랜치의 앞 커밋으로 진행한 작업에 `[Origin]` 줄은 있고 `questionOrigins` 기록이 없는 질문이 있으면 출처 없는 질문으로 다룬다(더 넓게 무효화하는 쪽). `planningVersion`이 없는 옛 작업과 `[Origin]`이 없는 옛 `questions.md`는 영향이 없다(해시 골든 그대로).
- 검증: 재현 스크립트 넷이 모두 기대대로 바뀌었다(s4: `cancelled,completed`, s5: 거부 문구에 실행할 수 없는 선택지 없음, s6: 두 번째 뒤 `blocked`·`hook-failure`, s7: `completed`). 새 테스트 9개(크기 한도 Claude·Codex, 늦은 결과 세 경우(미연결 담당·재배정 뒤 늦은 시작·형식까지 틀린 늦은 결과), 고아 표시 범위, 출처 반복·`previous`, 되돌린 보고 두 경우)는 이 반영 전 코드에서 실패한다(되돌린 뒤 새 보고를 내는 경우는 반영 전에도 통과하는 대조 사례다). `npm run build && npm test` 전체: **924개 중 920개 통과·실패 0개·생략 4개**.
