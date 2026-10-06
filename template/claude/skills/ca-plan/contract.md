# 계획 작업 계약

기본 흐름은 analysis(ca-analyst) → 영향도 → design(ca-analyst) → plan(ca-analyst) → critic(ca-critic)이다. 영향도는 작은 기본 조사이면 impact(ca-explorer) 한 담당이 조사와 02 작성을 함께 한다. 나머지는 explore(ca-explorer) → synthesis(ca-writer)다. 메인이 역할을 추가하거나 독립 critic을 생략하지 않고 CLI 배정에 따른다. 새 기본 작업의 contextVersion은 2이며 필요한 정책·직접 선행 문서와 역할별 필수 문서만 입력에 연결한다. 계획의 회귀 위험 입력과 critic의 전체 판단 문서는 보존한다.

큰 영향 영역은 `planning prepare doc/work/<ID>/planning-tasks.json`으로 나눈다. JSON은 `{ "maxParallel": 3, "tasks": [...] }`이며 작업마다 다음 필드를 둔다:

- `id`: 영문 소문자·숫자·하이픈 식별자, `role`, `title`, `requirements`: 담당 R 또는 원문 REQ/DONE/CON ID.
- `inputs`: 직접 읽을 저장소 상대 파일, `scopes`: 조사 역할의 소스 영역. 기본은 ["."]; 넓은 저장소는 영역별로 좁힌다. 선행 문서·공통 정책·확정 지시서는 자동 연결된다. KNOWLEDGE를 읽으면 inputs에 넣고 코드 근거를 확인한다.
- `outputs`: 역할별 고정 출력. analysis는01, impact·synthesis는02, design은03·04, plan은plan.json·07, explore·critic은빈 배열. 경로는 doc/work/<ID>/ 아래다. impact와 explore·synthesis를 섞어 등록하지 않는다.
- `dependsOn`: 선행 작업 ID. synthesis는 모든 explore에 의존해야 한다. `questionIds`: 관련 질문 ID. 질문에는 [Requirements]: R1 처럼 영향 범위를 기록한다. 범위 없는 질문은 전체를 막는다.

현재 단계의 여러 작업을 한 배치로 등록한다. 이미 기본 explore를 등록했다면 그 ID를 첫 영역으로 갱신하고 다른 영역을 더한다. synthesis 의존성도 같은 배치에서 갱신한다. 준비된 조사 작업만 최대 maxParallel개(1~4, 기본3)까지 동시에 배정·호출한다. 선행 결과와 공통 사실 키의 상충이 있으면 합성을 시작할 수 없다. 의미상 같은 사실은 동일 key를 사용한다. 범위 밖 호출자가 발견되면 근거를 추측하지 않고 입력·영역 정의를 보완하여 재배정한다.

입력 파일 내용·영역 파일 목록·관련 정책·질문·선행 결과 내용이 같을 때만 **같은 작업 안에서** 결과를 재사용한다. contextVersion: 2에서는 선행 실행 ID만 달라진 동일 결과를 재사용하되, 선행 작업이 현재 입력에 대해 완료됐는지 먼저 검사한다. 질문·근거·문서·차단 지적 변화는 무효화한다. 명시 작업도 contextVersion: 2로 선택할 수 있고 기존 작업의 계약은 유지한다. 캐시된 KNOWLEDGE 키만으로 조사를 생략하지 않는다. 다른 작업의 오래된 문서는 코드 확인 전까지 단서다.

**수정 피드백** — 작업 폴더의 별도 파일에 기록하고 해당 작업 inputs에 추가해 prepare한다. 잘못된 문서를 직접 덮어쓰지 않는다. 완료 결과에 차단 지적이 남거나 `plan submit`이 거부되면 해당 원인 작업의 입력을 보완해 다시 실행하고 후속 작업과 critic을 다시 실행한다. 중간 단계로 되감는 경우 기존 back 정책을 따른다.

배정 파일(`assignmentFile`)은 `.code-agent/work/<ID>/handoff/`에, 담당의 출력 문서는 `doc/work/<ID>/.staging/<dispatchId>/`에 둔다. 둘 다 커밋되지 않는다. staging은 실행 중인 그 배정의 담당만 쓸 수 있고, 완료 hook이 읽어 정식 문서로 옮긴 뒤 지운다. hook에 서브 에이전트 식별자가 오지 않는 호스트(Codex)의 담당은 staging 대신 결과의 `{path, content}`로 본문을 싣는다.
