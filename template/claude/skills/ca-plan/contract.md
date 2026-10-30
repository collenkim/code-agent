# 계획 작업 계약

## 공통 진행·되감기

현재 단계가 요청한 단계보다 앞이면 status의 `다음:`을 먼저 따른다. 이미 지났으면 `code-agent back <단계>`가 필요하다고 알린다. **되감기는 사용자가 되돌리라고 말했을 때만** 한다. 승인 무효로 status가 되감기를 안내하거나 `planning advance`가 `rewind-required`, `rewind.auto: true`를 낸 경우는 예외다. 뒤로 이동하는 명령이 무효화 범위를 알린다.

1. 이후는 출력의 `next` 줄(action별 다음 행동)을 따르고 그 줄의 명령은 **글자 그대로** 쓴다. `action:dispatch`이면 `assignments`마다 `agent` 서브에이전트를 호출하고(형식만 고치는 교정 배정 `mode:correction`도 같다), 프롬프트에는 **`assignmentFile` 경로와 "이 파일을 읽고 그 계약대로 결과 JSON 하나를 반환하라"**만 쓴다 — 배정·문서 기준·뼈대·context·staging 경로는 그 파일에 있다. 담당은 백그라운드로 끝날 수 있다 — 결과(호출 결과·인계 메시지·완료 알림 중 먼저 온 것)를 받은 그 턴에 다음 단계로 간다. 재배정이면 직전 시도의 거부·실패 사유·초안·답은 배정 파일의 `## 직전 시도` 에 있으니 다시 쓰지 않고, 게이트 거부처럼 파일에 없는 사유만 2~3줄 덧붙인다.
2. 담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다. 식별·해시 검사·문서 기록과 한 번의 되돌림은 시작·완료 hook이 한다 — 메인은 완료 처리하거나 번호 문서·plan.json을 직접 고치지 않고, 원문이 필요할 때만 그 파일이나 `planning result <ID>`를 읽는다. 질문의 답은 ca-answer로 받은 실제 답뿐이고 보류·상태 메모는 답이 아니다. 같은 명령을 스스로 반복하지 않는다.
3. `next` 줄이 싣는 행동의 요지는 그 줄이 원천이다 — 대기·`cancel` 목록·되감기(`rewind.auto`)·재배정 한도·차단 지적(`feedback`)마다 그 줄의 행동만 하고 덧붙이지 않는다. 줄이 사용자 보고·지시를 요구하면 보고하고 기다린다.
4. `ready-for-gate`는 문서 검증이나 승인이 아니다 — `next` 줄대로 끝으로 간다. `chain.gate`가 `passed`면 게이트는 이미 지났고 지금 스테이지는 `chain.to`다(최상위 `phase`는 advance 를 돌린 단계).

plan은 관찰된 critic 완료와 차단 지적 해소 후에만 제출한다. 승인·교차 검토와 제출 이후 절차는 ca-plan의 해당 항목을 따른다.

## 작업 등록·입력·피드백

기본 흐름은 analysis(ca-analyst) → 영향도 → design(ca-analyst) → plan(ca-analyst) → critic(ca-critic)이다. 영향도는 작은 기본 조사이면 impact(ca-explorer) 한 담당이 조사와 02 작성을 함께 한다. 나머지는 explore(ca-explorer) → synthesis(ca-writer)다. 메인이 역할을 추가하거나 독립 critic을 생략하지 않고 CLI 배정에 따른다. 새 기본 작업의 contextVersion은 2이며 필요한 정책·직접 선행 문서와 역할별 필수 문서만 입력에 연결한다. 계획의 회귀 위험 입력과 critic의 전체 판단 문서는 보존한다.

큰 영향 영역은 `planning prepare doc/work/<ID>/planning-tasks.json`으로 나눈다. JSON은 `{ "maxParallel": 3, "tasks": [...] }`이며 작업마다 다음 필드를 둔다:

- `id`: 영문 소문자·숫자·하이픈 식별자, `role`, `title`, `requirements`: 담당 R 또는 원문 REQ/DONE/CON ID.
- `inputs`: 직접 읽을 저장소 상대 파일, `scopes`: 조사 역할의 소스 영역. 기본은 ["."]; 넓은 저장소는 영역별로 좁힌다. 선행 문서·공통 정책·확정 지시서는 자동 연결된다. KNOWLEDGE를 읽으면 inputs에 넣고 코드 근거를 확인한다.
- `outputs`: 역할별 고정 출력. analysis는01, impact·synthesis는02, design은03·04, plan은plan.json·07, explore·critic은빈 배열. 경로는 doc/work/<ID>/ 아래다. impact와 explore·synthesis를 섞어 등록하지 않는다.
- `dependsOn`: 선행 작업 ID. synthesis는 모든 explore에 의존해야 한다. `questionIds`: 관련 질문 ID. 담당·교차 검토가 낸 질문에는 코드가 `[Origin]: <작업 ID>`를 붙여, 답하면 그 작업과 후속 작업만 다시 돈다. 메인이 직접 적는 질문에는 `[Requirements]: R1`을 `[Answer]:` 줄 앞에 적는다. `[Origin]`은 코드가 질문을 쓰면서 계획 기록에도 남긴 출처만 효력이 있다 — 메인이 적은 `[Origin]`은 무시된다. 출처가 없으면 범위가 겹치는 모든 작업이, 범위도 없으면 전체가 다시 돈다(앞 단계 작업이 낡으면 advance가 되감기를 알린다). `[Kind]`가 operation이면 어느 작업도, wording·test면 plan·critic만 다시 돌고 셋 다 승인 묶음에 들지 않는다.

현재 단계의 여러 작업을 한 배치로 등록한다. 이미 기본 explore를 등록했다면 그 ID를 첫 영역으로 갱신하고 다른 영역을 더한다. synthesis 의존성도 같은 배치에서 갱신한다. 준비된 조사 작업만 최대 maxParallel개(1~4, 기본3)까지 동시에 배정·호출한다. 선행 결과와 공통 사실 키의 상충이 있으면 합성을 시작할 수 없다. 의미상 같은 사실은 동일 key를 사용한다. 범위 밖 호출자가 발견되면 근거를 추측하지 않고 입력·영역 정의를 보완하여 재배정한다.

입력 파일 내용·영역 파일 목록·관련 정책·질문·선행 결과 내용이 같을 때만 **같은 작업 안에서** 결과를 재사용한다. contextVersion 2 이상에서는 선행 실행 ID만 달라진 동일 결과를 재사용하되, 선행 작업이 현재 입력에 대해 완료됐는지 먼저 검사한다. 질문·근거·문서·차단 지적 변화는 무효화한다. 새 기본 작업은 3(analysis·design 정책 입력이 아키텍처·컨벤션뿐)이고, 명시 작업도 2·3을 선택할 수 있으며 기존 작업의 계약은 유지한다. 캐시된 KNOWLEDGE 키만으로 조사를 생략하지 않는다. 다른 작업의 오래된 문서는 코드 확인 전까지 단서다.

**수정 피드백** — 작업 폴더의 별도 파일에 기록하고 고칠 작업의 inputs에 추가해 prepare한다. 잘못된 문서를 직접 덮어쓰지 않는다. advisory 지적은 수정 피드백·재실행·되감기의 사유가 아니다. 완료 결과에 차단 지적이 남거나 `plan submit`이 거부되면 지적 내용으로 고칠 작업을 정한다 — `planning advance`의 `feedback[].citedTask`는 근거 문서를 낸 작업이라 원인이 아닐 수 있다(예: AC→TC 공백은 04를 인용해도 고칠 곳은 07·plan이다). 고칠 작업이 이 단계면 그 작업과 후속 작업·critic을 다시 실행한다. 앞 단계 작업을 고쳐야 하면 원인과 비용(다시 도는 단계·작업)을 사용자에게 한 줄로 보고하고 지시를 받은 뒤 되감는다. 그때 피드백 파일은 원인 작업의 inputs(그 단계에서 prepare)와, 이 단계로 돌아와 실제로 고칠 후속 작업의 inputs에 모두 넣는다.

배정 파일(`assignmentFile`)은 `.code-agent/work/<ID>/handoff/`에, 담당의 출력 문서와 결과 파일(`result.json`)은 `doc/work/<ID>/.staging/<dispatchId>/`에 둔다. 둘 다 커밋되지 않는다. staging은 실행 중인 그 배정의 담당만 쓸 수 있고, 완료 hook이 읽어 정식 문서로 옮긴 뒤 지운다. 쓰기가 거부되면 결과의 `{path, content}`로 본문을 싣는다.
