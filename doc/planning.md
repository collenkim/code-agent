# 요구 분석·설계·계획 작업

Claude와 Codex 모두 아래 계약을 사용한다. Claude는 `planning-event`, Codex는 `codex-event`가 시작·최종 결과를 관찰한다. Claude 역할은 `.claude/agents/ca-*.md` 머리말, Codex 역할은 `.codex/agents/ca-*.toml`에 역할별 기본 모델·추론 강도와 사용자 변경값을 명시한다. `.claude/`·`.codex/`·`.agents/`는 조사 범위에서 제외한다. 설치·모델 설정·승인 차이는 [Codex 연동](codex.md)을 따른다.

새로 시작한 작업은 실제 서브 에이전트 실행 결과를 연결해 다음 단계로 진행한다. 관찰된 계획 작업이 없던 버전에서 시작한 작업은 그 절차로 재개한다. `code-agent status`의 **계획 처리** 줄로 구분한다.

## 역할과 게이트

`planning advance`·`--chain`은 [LangGraph 계획 그래프](langgraph.md#실행-계층)를 실행한다. 아래는 배정·결과·게이트와 명령 출력의 계약이다.

| 단계 | 담당 | 입력 | 출력 | 다음으로 넘어가는 조건 |
|---|---|---|---|---|
| 요구 구체화 | ca-analyst | 확정 지시서·공통 정책 | 01-requirements.md | 원문 대조·관찰된 완료·미결 없음 |
| 영역 조사 | ca-explorer | 담당 요구·영역 파일·선행 문서 | 근거·공통 사실·질문 | 각 영역의 현재 입력에 대한 완료 |
| 작은 기본 조사·정리 | ca-explorer | 확정 요구·전체 조사 범위·공통 정책 | 근거·사실·02-analysis.md | 관찰된 완료·문서 검사·충돌 없음 |
| 영향도 정리 | ca-writer | 모든 영역 조사 결과 | 02-analysis.md | 조사 합류·공통 사실 충돌 없음 |
| 설계·기능 정의 | ca-analyst | 요구·영향도·실제 근거 | 03-design.md·04-functional.md | 설계 판단·구체적 AC·근거 있는 BR |
| 구현 계획 | ca-analyst | 설계·기능·정책 | plan.json·07-test-spec.md | Task·파일·AC·TC 연결 |
| 독립 반박 검토 | ca-critic | 현재 계획과 선행 문서 | 근거와 지적 | 관찰된 완료·blocking 지적 없음 |
| 승인 | 사용자 | 검토를 마친 문서·계획 | 승인 원장 | 기존 같은 세션 동의 또는 직접 TTY |

두 호스트를 설치한 프로젝트는 critic 결과마다 `planning cross --by <다른 호스트>` 를 한 번 받는다(그 critic 배정이 교차 지점이다 — 완료된 지점은 다시 실행하지 않는다). critic 결과에 차단 지적이 남아 있으면 그 판의 교차 검토는 요구하지 않는다 — 계획을 고친 뒤 다시 도는 critic 결과가 교차 지점이고, 그 교차 프롬프트에는 고치기 전 판의 교차 지적(사람이 기각한 것 표시)이 함께 실린다. 교차 질문에는 `[Origin]: <critic 작업 ID>` 가 붙어 답하면 critic 이 다시 배정되고 교차 검토도 새로 받는다. 옛 질문처럼 답이 critic 입력을 바꾸지 않으면 같은 critic 결과로 교차 검토를 한 번 더 실행한다(지점 한도 안). 교차 검토의 차단 지적을 사용자가 기각하면 동의 judgment `waive-finding` 으로 그 critic 결과에만 기록한다. 실행 실패의 원인별 처리는 [프로세스 흐름도](process-flow.md) §6.3이 정본이다.

배정·입력 해시·의존성·파일과 줄·문서 형식 검사는 코드가 실행한다. 해석·설계·반박은 에이전트가 수행하고 업무 질문과 승인은 사용자가 결정한다. CLI가 모델 API를 직접 호출하지 않는다. 메인이 배정 결과에 지정된 Claude 또는 Codex 서브 에이전트를 호출한다.

표는 공통 역할 이름이다. 실제 호출은 Claude에서 배정의 `agent`, Codex에서 `hostAgents.codex`를 사용한다. 예를 들어 `ca-analyst`에 대응하는 Codex 역할 이름은 `ca_analyst`다. CLI 출력의 배정 요약은 지금 호스트가 부를 이름만 싣는다(Claude `agent`, Codex `agent`·`hostAgents.codex`, 호스트를 정할 수 없으면 `hostAgents` 전체). 배정 파일과 함수 반환에는 `hostAgents` 전체가 있다.

## 기본 진행과 결과 전달

완료 hook이 되돌린 결과에는 사유·초안과 재개 관찰 대기가 남는다. `planning advance`가 이 상태를 안내하면 메인은 담당이 종료됐는지 확인하고, 종료됐으면 `planning cancel <ID>` 뒤 재배정한다. 새 담당은 보존된 지적·초안에서 이어 쓴다. 입력별 첫 전달 실패는 총 배정에서 분리하지만 같은 입력의 전달 실패가 반복되면 호스트 복구를 요구한다. 내용을 고치지 않은 반복 실패와 일반 취소는 기존 한도를 따른다.

파일 생성·수정·삭제·이동은 `plan.json`의 `files[].operation`에 `create`·`modify`·`delete`·`move`로 표시한다. 생략하면 생성·수정이다. 이동의 `from`은 원본, `path`는 대상이고 Task의 `files`에는 대상 경로를 넣는다. 분석 단계부터 후보 파일 배열을 JSON으로 저장하고 `code-agent plan preflight <JSON>`으로 기준 커밋·scope·preserve·단계를 확인한다. 원본과 대상이 같은 경우, 중복 경로, 기준에 없는 원본, 기존 대상 덮어쓰기는 거부된다. 승인 뒤 `code-agent plan apply-files`가 현재 Task의 삭제·이동을 수행한다. 삭제할 파일이 남거나 이동 원본이 남으면 다음 단계로 진행하지 않는다.

외부 의존 계약은 [계약 인계](dependency-contracts.md)의 `planning contracts`로 등록한다. 모든 세부 담당의 `inputs`에는 검증된 사본이, `externalContracts`에는 원문 경로·커밋·해시·항목이 실린다. 원문이나 사본 변경은 입력 해시와 승인 문서 해시에 반영된다. 근거가 없거나 계약 항목이 상충하면 배정하지 않으며, 의미상 불명확한 조건은 담당이 질문한다. 등록은 전체 저장소 탐색이나 외부 파일 수정 권한을 주지 않는다.

결과 JSON은 배정된 `resultFile`에 쓰고 `결과: <resultFile>` 한 줄을 반환한다. 응답 앞뒤의 설명은 허용하지만 결과 포인터는 정확히 하나여야 한다. 다른 경로·복수 포인터·손상된 JSON·크기 초과·소유권·스키마·입력 해시 불일치는 거부한다. 판단·질문·지적은 설명 대신 결과 JSON의 해당 필드에 모두 담는다.

`code-agent planning advance`는 현재 단계의 빠진 기본 작업을 준비하고, 완료 결과 재사용·선행 조건·동시 한도를 검사해 실행할 `assignments`를 한 번에 반환한다. 사용자 정의 영역 작업은 유지한다. `action`은 다음과 같다. CLI 출력에는 메인이 할 일 한 줄 `next`가 함께 실린다 — 메인 행동의 원천은 그 줄이고(실패는 재시도 규약의 원인별 문구), 아래 표는 요약이다.

| 값 | 메인의 동작 |
|---|---|
| `rewind-required` | 앞 단계 계획 작업이 지금 입력과 맞지 않는다(배정하지 않는다). `rewind.auto`가 true면 사용자 지시 없이 `rewind.command`(`code-agent back <단계>`)를 실행하고 그 단계 스킬로 잇는다. `rewind.notice`가 있으면 그 한 줄을 먼저 사용자에게 알린다. false면 되감지 않고 `rewind.reason`과 `rewind.tasks[].staleBecause`를 사용자에게 보고해 지시를 받는다. |
| `dispatch` | 배정마다 지정된 담당을 호출한다. 반환한 작업은 이미 배정 상태이므로 dispatch를 다시 호출하지 않는다. |
| `stale` | `returnPending`이면 담당 종료를 확인한 경우에만 cancel 뒤 재배정한다. 그 밖의 시작 미관찰·장기 대기는 이 대화에서 아직 호출하지 않은 배정이면 지금 호출하고, 호출했던 배정이면 `planning cancel <ID>` 뒤 advance 한다. |
| `wait` | 실제 완료 이벤트를 기다린다. 상태를 반복 조회하지 않는다. 담당 호출이 이미 끝났는데도 `wait`이면 `planning cancel <ID>` 뒤 advance 한다. |
| `blocked` | 질문·충돌·입력 변경·한도 등 사유를 해결한다. 항목의 `class`가 `same-input-repeat`·`reassign-total`이면 다시 배정하지 말고 사유와 한도(`counter`)를 사용자에게 보고한다. `hook-failure`(담당 결과의 출처 확인이 두 번 이어서 실패)면 사유를 사용자에게 알리고, 원인을 고친 뒤 `planning dispatch <ID>`로 명시적으로 배정한다. 막힌 작업 없이 critic 뒤 교차 계획 검토만 남았으면(두 호스트 설치) `next` 줄이 그 줄 — `code-agent planning cross --by <호스트>` 또는 사람 판단 — 뒤 advance 를 안내한다. 답은 있는데 출처를 확인할 수 없는 질문은 `미결 질문`이 아니라 `답 출처 미확인 Q<n>`과 받는 길로 적힌다. |
| `ready-for-gate` | 기존 문서 검사·계획 제출·승인 절차로 이어간다. 단계 전환이나 승인 완료를 뜻하지 않는다. |

**연쇄(`--chain`)** — `planning advance --chain`은 analysis·impact·design 에서 결과가 모두 준비돼 `ready-for-gate`일 때만 같은 호출에서 그 단계의 게이트(`code-agent next`)를 한 번 지난다. 결과는 `chain{from, gate, to?, reason?, questions?}`에 싣고, 거부면 exit 1 이며 커서는 그대로다. 출력의 최상위 `phase`는 advance 를 돌린 단계이고, 통과하면 지금 스테이지는 `chain.to`다. `questions`는 답이 없거나 출처를 확인할 수 없는 질문 때문에 거부됐을 때만 싣는다 — AI-DLC·공통 문서·요구 확정 때문에 거부되면 질문이 열려 있어도 `reason`만 있고 `next` 줄은 그 사유를 전하고 멈추라고 한다. 다음 단계 배정은 하지 않는다 — 다음 단계 절차가 자기 1항에서 advance 를 다시 부르므로 배정 전 선택(영역 분할 `planning prepare`)이 그대로 있고 시작이 관찰되지 않은 배정이 연쇄 때문에 생기지 않는다. plan 은 잇지 않는다(계획 제출과 승인은 사람 확인이다). 다른 action·실패·거부에서는 게이트를 시도하지 않고 자동으로 다시 시도하지 않는다. `--chain`으로 부른 호출의 `next` 안내는 다음 advance 에도 `--chain`을 유지한다. 사용자가 한 단계만 요청했으면 스킬이 `--chain`을 빼고 부른다.

우선순위는 표의 위에서 아래다(`rewind-required` → `dispatch` → `stale` → `wait` → `blocked` → `ready-for-gate`). `running`(실행 중 배정의 담당 시작 관찰 여부·배정 뒤 경과 분), `orphaned`(이번 호출이 고아로 표시한 배정), `stale`·`cancel`, `rewind`, `feedback`은 해당할 때만 실린다.

**되감기** — 앞 단계 작업이 낡은 이유는 `rewind.tasks[].staleBecause`(입력 파일·질문·선행 결과·기준 커밋·code-agent.json·호스트 지침 등 항목별)로 보인다. 자동 되감기는 같은 사유(단계와 작업별 낡은 원인)에 한 번이다. 안내를 반복 조회하거나 `back`이 거부되어도 허용은 남고, 해당 대상으로 실제 커서를 옮길 때 소비한다. 기록은 `planning.json`의 `retry.rewinds`(최근 20개)에 남고 승인 묶음 밖이다. 두 번째부터는 `auto:false`로 사람에게 넘긴다 — 계속 바뀌는 입력이 앞 단계를 반복해 돌리는 일을 막는다. analysis까지 되감거나 원인이 기준 커밋·code-agent.json·호스트 지침이면 `rewind.notice`가 다시 도는 작업 수를 한 줄로 알린다. 되감기는 커서만 옮기고 지우는 것이 없으며, 다시 `next`로 모든 게이트를 지난다.

**차단 지적** — `feedback[]`은 이 단계 이하 작업과 현재 critic의 교차 검토가 낸 차단 지적이다. `citedTask`·`citedPhase`는 지적의 근거 문서를 낸 작업일 뿐 원인이 아니다(예: AC→TC 공백은 04를 인용해도 고칠 곳은 07·plan이다). 고칠 작업은 지적 내용으로 정하고, 앞 단계 작업을 고쳐야 하면 원인과 다시 도는 작업을 사용자에게 보고해 지시를 받는다. 차단 지적으로는 자동으로 되감지 않는다.

완료 이벤트 뒤 advance를 다시 호출하면 새로 실행 가능한 작업만 배정한다. 여러 메인이 동시에 호출해도 배정은 같은 잠금 안에서 결정한다. 명시적인 작업 정의에는 기존 `planning prepare <작업.json>`을 사용하며 prepare·dispatch도 계속 지원한다.

### 위임 수와 입력 범위 선택

영향도 단계에 등록된 작업이 없고 확정 R이 1~3개, 조사 대상이 12파일 이하·총 96,000바이트 이하이면 `advance`는 `impact` 한 작업을 만든다. 같은 ca-explorer가 조사 결과와 02 문서를 함께 반환하므로 별도 writer 호출을 줄인다. 조사 대상은 기존 Git 파일 목록에서 상태·호스트 설정·작업 문서와 설치된 `CLAUDE.md`·`AGENTS.md`·`doc/code-agent/` 단계 템플릿을 제외한 범위다. 새 입력 계약도 이 설치 자료를 기본 소스 목록에서 제외하며, 직접 읽어야 하면 `inputs`에 명시한다. 호스트 자체의 지침 적용은 바꾸지 않는다. 파일 수와 크기는 보수적인 시작 기준이며 업무 난이도나 최적 비용을 입증한 수치가 아니다.

그 밖에는 explore → synthesis를 유지한다. 작은 저장소여도 영역을 따로 조사해야 하면 **첫 advance 전에** `planning prepare <작업.json>`으로 분할한다. 인자 없는 prepare도 기존 두 역할 흐름을 선택한다. 한번 준비한 방식은 유지하며 impact와 분할 조사를 섞을 수 없다. 통합 조사는 조사 생략이 아니다. 근거·모든 R의 영향·호출자·회귀 위험을 기록하고 미결 질문·차단 지적·사실 충돌을 동일하게 검사한다. 분석·설계·계획·critic·승인은 유지하므로 작은 기본 흐름의 역할 호출은 6개에서 5개가 된다.

새 기본 작업은 `contextVersion: 4`를 기록한다. 새로 만드는 analysis·design 기본 작업은 존재하는 업무 규칙 KNOWLEDGE(매니페스트의 business-rules 경로 — 파일이면 그 파일, 폴더면 바로 아래 `.md`)를 `inputs`에 넣고, analysis 단계 context는 지시서의 접수 요구 낱말로 고른 참고 문서 절을 싣는다. 이미 준비된 작업의 `inputs`는 바꾸지 않는다(진행 중 작업의 입력 해시를 지킨다). 입력은 직접 의존 작업의 출력과 역할별 필수 문서를 연결한다. 모든 판단 역할에 01을 제공하고 계획에는 회귀 위험 확인용 02, critic에는 01~04와 계획·테스트 명세를 유지한다. explore·synthesis·analysis·design은 아키텍처·컨벤션을 기본 정책으로 받고, plan·critic은 정책 4종(테스트 전략·품질 기준 포함)을 받는다 — 테스트 전략·품질 기준만 고쳐도 analysis·design 결과는 낡지 않는다(contextVersion 2 작업의 analysis·design 은 정책 4종 그대로다). 4 는 지침·context 가 읽으라고 주는 파일을 입력에 더한다 — design·plan·critic 의 참조 표준 파일, critic 의 계획이 가리키는 기존 파일, refactor plan·critic 의 TC id 가 있는 기존 테스트. 그래서 담당이 그 파일을 근거로 인용할 수 있고, 그 파일이 바뀌면 결과가 낡는다(저장소 전체를 열지는 않는다). 후속 담당은 선행 결과의 근거와 사실·지적의 출처 경로(`facts[].source`·`findings[].source`)도 인용할 수 있다. 진행 중이던 작업(3 이하)은 기록된 버전대로 입력 해시를 계산하므로 이 변경으로 낡지 않는다. 추가 정책·KNOWLEDGE·영역 밖 호출자는 `inputs` 또는 명시한 파일 범위로 연결한다. 범위를 벗어난 사실을 추측하지 않는다. 명시 작업도 `contextVersion` 2·3·4를 선택할 수 있다.

같은 계약은 선행 결과의 실행 ID만 바뀐 경우 후속 결과를 재사용한다. 선행 작업이 현재 입력에 대해 완료됐는지 먼저 검사하며 결과의 판단·근거·질문·문서·지적이 바뀌면 무효화한다. 현재 실행의 관찰 식별자 검증은 유지한다. 기존 작업의 contextVersion 없는 입력·해시 계약은 바꾸지 않는다. 상태 파일 버전은 1을 유지하지만 새 impact 역할을 이해하지 못하는 구버전으로 실행 중 작업을 내리지 않는다.

호스트가 직접 제공하는 CLAUDE.md·AGENTS.md는 새 배정에 본문을 중복 전달하지 않아도 해시로 변경을 감지한다. 지침 추가·수정·삭제 뒤에는 이전 판단을 재사용하지 않는다. 조사 입력을 줄이는 것과 판단에 영향을 주는 지침 변경을 무시하는 것은 구분한다.

선행 `dependencies`와 `cached:true`의 결과는 판단·근거·질문·차단 지적을 보존하고 `artifacts`를 `{path, hash, chars}`로 전달한다. 문서 본문은 관찰 기록과 실제 파일에 보존한다. 필요한 경우 해당 파일 또는 `code-agent planning result <ID>`로 상세 결과를 읽는다. 상세 조회도 기록된 문서 파일과 글자가 같은 본문은 `{path, hash, chars, inFile: true}`로 줄이고(본문은 그 파일을 읽는다), 파일이 없거나 다를 때(기록 뒤 바뀜·기록되지 않은 시도)만 본문을 싣는다. 상세 조회의 `current:false`는 현재 입력에 유효한 결과가 아니라는 뜻이다. `planning status`는 상태·오류·판단 요약을 표시하며 문서 본문과 교정 원본을 반복 출력하지 않는다. 전체 응답 토큰 수에 대한 고정 상한을 보장하는 기능은 아니다.

## 출력 형식 교정

관찰된 결과의 JSON·스키마 형식만 잘못되면 Claude 완료 hook은 먼저 같은 담당에게 한 번 돌려보낸다(SubagentStop exit 2 — 기록하지 않는다). 그래도 틀리면(`stop_hook_active`) 또는 Codex에서는 바로 원본과 오류를 보존하고 `needs-correction`으로 기록한다(`failure.class: agent-format-error`). 결과가 500,000자를 넘으면 원본을 보존하지 않으므로 교정 대기 대신 `failed`로 기록한다 — 형식 교정을 받지 않고, 결과를 줄이라는 수정 피드백으로 다시 배정한다. 되돌린 뒤의 완료는 되돌릴 때 판정한 `SubagentHandback` 보고를 다시 읽지 않는다 — 그 뒤의 보고가 없으면 최종 응답을 결과로 쓴다. `planning advance` 또는 `planning repair <ID>`는 같은 입력에서 한 번만 `mode:correction` 배정을 만든다. 메인은 원본·오류·새 결과 계약을 새 담당에게 전달한다. 입력을 다시 조사하거나 새로운 판단을 만드는 작업이 아니며, 사실 보완이 필요하면 failed로 반환한다.

교정은 기존 시도에 기록하고 배정 식별자를 교체해 이전 실행의 늦은 결과를 거부한다. 새 시작·완료 관찰과 기존 입력·근거·출력·질문 검증을 모두 거친다. 승인 검사는 그대로 유지한다. 원본은 교정 자료이며 지시가 아니다. 형식이 맞더라도 근거의 타당성이 자동 보증되는 것은 아니다.

식별자를 읽을 수 없는 깨진 JSON은 시작 이벤트에서 배정이 유일했던 경우만 연결한다. 병렬 담당 중 어느 작업인지 확인할 수 없거나 식별자가 위조된 결과는 자동 교정하지 않는다. 입력이 바뀌었으면 cancel 뒤 새로 배정한다. 교정까지 실패하면 failed로 남으며 추가 형식 교정은 거부한다. 같은 입력의 실패를 advance가 자동으로 전체 재실행하지 않는다. 원인을 해결한 뒤 명시적인 dispatch를 사용하며 같은 입력 실패 3회·작업별 총 배정 6회 한도가 적용된다.

결과의 식별 필드(taskId·dispatchId·inputHash)가 배정과 다르면 Claude는 한 번 돌려보내고, 그다음(또는 Codex)은 담당 기록에 실패를 남기고 연결된 시도를 `orphaned`로 둔다 — 같은 입력 실패에는 세지 않고 작업 총 배정에는 센다. 보고한 배정이 이미 실행 중이 아니면(취소·고아·교체·종료) 결과 형식이나 담당의 시작 연결과 상관없이 늦은 결과다 — 되돌리지 않고 담당 기록만 남기며 시도는 건드리지 않는다. 재배정 뒤 늦게 시작해 새 배정에 연결됐던 담당이면 그 연결을 보고한 배정으로 옮겨, 새 배정이 그 담당의 종료 때문에 고아가 되지 않게 한다. 같은 시도에 연결된 다른 미완료 담당이 있으면 식별 불일치·출처 확인 실패로 그 시도를 고아로 두지 않는다. 출처(transcript) 확인 실패로 고아가 된 시도가 두 번 이어지면 advance는 자동으로 다시 배정하지 않고 `blocked`(`class: hook-failure`)로 넘긴다. 다시 배정할 때 직전 시도가 `orphaned`·`failed`·`needs-input`이면 배정 파일에 `## 직전 시도`(상태, 거부·실패 사유 — 문제가 여럿이거나 길면 잘리지 않은 전체, staging 에 놓인 직전 초안, 직전 질문의 답, 실패로 기록된 질문, 바뀐 입력)가 실리고, CLI 요약의 `previous`에는 상태·원인·사유·초안 경로만 실린다 — 완료 hook이 기록한 실패는 Claude에서 메인에게 보이지 않고, 메인이 같은 내용을 프롬프트에 다시 설명하지 않게 하기 위해서다. 실행 중 단계·입력이 바뀐 결과는 그 시도를 `cancelled`로 둔다. 연결된 담당이 끝났는데 결과가 없는 running 시도(확실한 고아)는 advance·dispatch가 `orphaned`로 표시하고 같은 호출에서 다시 배정한다. 시작이 관찰되지 않은 채 10분(배정 시각과 그 뒤 관찰된 마지막 담당 활동 중 늦은 시각부터)이 지났거나 시작이 관찰된 담당이 60분 넘게 끝나지 않은 배정은 `stale`로 보이며 메인이 판단해 cancel한다. 고아 판정은 동시 한도보다 먼저 한다.

## 수동 배정과 호환 명령

```powershell
code-agent planning prepare
code-agent planning status
code-agent planning dispatch analysis
```

요구 변경안이 확정을 기다리는 동안에는 `prepare`·`dispatch`·`advance`가 요구 확정 대기로 멈춘다. 새 개정이 확정되면 작업 정의가 따르던 확정 요구와 달라진 지금 단계 작업만 요구 범위·입력·선행을 현행으로 맞추고(`prepare` 출력 `aligned`), 같은 확정본 위의 재준비는 정의를 바꾸지 않는다. 분석 뒤 단계에서 요구 항목이 바뀌었으면 흐름이 분석으로 되감기고 그 안내로 멈춘다.

`prepare`를 인자 없이 실행하면 **현재 단계**의 기본 작업을 등록한다. analysis는 `analysis`, impact는 `explore`와 `synthesis`, design은 `design`, plan은 `plan`과 `critic`이다. 의존 순서대로 배정한다. 현재 입력의 완료 결과가 있으면 `dispatch`는 `cached: true`로 결과를 반환한다.

새 배정은 담당 이름, 입력 파일 목록, 선행 결과, 출력 계약, `taskId`·`dispatchId`·`inputHash`를 갖는다. CLI(`advance`·`dispatch`·`repair`)는 배정 전문에 역할별 문서 기준(`ca-*/criteria.md`)과 출력 문서 뼈대를 붙여 `.code-agent/work/<ID>/handoff/<dispatchId>.md`에 쓰고, 출력에는 요약과 `assignmentFile`만 남긴다(배정 ID 는 파일 이름에 있다). 계획 CLI 출력은 최상위 키마다 한 줄이고 빈 배열은 뺀다(`problems`는 남긴다). 배정 파일에는 단계 context(`code-agent context` 출력 — 접수 요구 원문 목록·문서 형식·후보 파일·계획 형식)도 함께 넣는다. 메인은 그 경로를 담당에게 넘기고, 재배정이면 게이트 거부처럼 배정 파일의 `## 직전 시도`에 없는 사유만 2~3줄 덧붙인다 — 배정 본문을 Agent 프롬프트에 옮겨 쓰지 않는다. 담당은 출력 문서를 배정의 `staging` 경로(`doc/work/<ID>/.staging/<dispatchId>/`)에 쓰고, 계약에 맞는 결과 JSON 하나는 배정의 `resultFile`(같은 폴더의 `result.json`)에 써 최종 응답으로 `결과: <resultFile>` 한 줄만 돌려준다 — 결과 본문(사실·근거·요약)이 메인 대화를 거치지 않는다. 쓰기 도구가 없는 critic 이나 쓰기가 거부된 담당은 결과 JSON 을 최종 응답으로 낸다. 결과 JSON의 `artifacts`에는 `{path, staged}`만 넣는다. 정식 문서가 이미 있거나(되감기·수정 피드백 재배정) 직전 시도의 미완성 초안이 남아 있으면 담당 시작 훅이 그 배정의 staging 자리에 미리 넣어 두고(초안이 우선 — 마지막 완료 뒤의 것만), 담당은 고칠 곳만 고친다 — 문서 전체를 다시 출력하지 않는다(형식 교정 배정은 원본 staging 을 옮겨 쓰므로 넣지 않는다). staging은 PreToolUse가 실행 중인 그 배정의 담당(`agent_id`)에게만 열고, 계획 담당은 그 밖을 쓰지 못한다. 두 호스트가 같다 — Codex 담당도 하위 에이전트 hook 입력의 `agent_id`(0.161.0 실측)로 가려져 `apply_patch`로 staging 에 쓴다(배정 문구의 쓰기 도구는 CLI 표기다). 쓰기 도구가 없거나 그 쓰기가 거부되면 `{path, content}`로 전체 내용을 싣는다. 함수(`advancePlanning` 등)의 반환은 전체 배정 그대로다. SubagentStart·SubagentStop의 관찰 훅(Claude는 planning-event, Codex는 codex-event)이 세션·에이전트·배정을 대조하고 결과를 기록한 뒤 지정 문서만 생성한다. 최종 응답의 `결과:` 줄은 실행 중인 그 담당 배정의 `resultFile` 자리일 때만 받는다 — 다른 자리·없는 파일은 형식 오류다. 완료 hook은 기록 전에 그 역할의 게이트 검사(01 형식·원문 추적, 02 영향 표, 03·04 섹션·AC·업무 규칙, 07·plan.json 의 TC·tasks·AC·요구 커버리지·남은 질문과 제출 규칙 — 순서·경로·preserve·검증 명령 파일·fix·refactor, 미결 표시·근거 줄)를 staging 본문에 먼저 돈다 — `next`·`plan submit`과 같은 함수라 더 엄격해지지 않고, critic·교차 검토까지 마친 초안이 제출에서 뒤늦게 같은 규칙에 걸리지 않는다. 그 사이 바뀐 문서·질문·검토 상태는 최종 게이트가 그대로 다시 본다. Claude는 담당이 고쳐 다시 보고할 수 있는 실패(형식·식별·내용 검사)를 같은 담당에게 한 번 돌려보내고(교정 시도의 문서 검사 실패는 제외), 이미 한 번 막힌 재시도(`stop_hook_active`)와 기록이 끝난 실패는 막지 않는다. Codex는 돌려보내지 않고 바로 기록하며 hook은 언제나 0으로 끝난다 — 실패 사유는 `planning advance`의 `blocked`로 메인에게 간다. 메인이 임의로 완료를 신고하는 명령은 없다.

**첫 시도에 맞는 결과를 내게 하는 계약** — 배정 파일에는 그 역할·작업 종류에 걸리는 검사만 고른 `## 제출 전 점검`이 붙는다. 줄마다 규칙 식별자(`[REQ-TRACE]`·`[DOC-REF]`·`[PLN-SEQ]` 등)와 무엇을 확인하는지가 있고, 요구 ID·출력 경로처럼 담당이 옮겨 적거나 셀 값은 코드가 채운다. 검사에 걸리면 같은 식별자가 붙은 문구로 돌아온다 — 문서 문제는 `[ID] 문서:줄: 문제 표현 — 고칠 방향` 꼴이다. 배정의 결과 상태별 계약(`statusContract`)은 completed(출력 전체·근거), needs-input(질문 하나 이상, 요구 ID 는 그 배정의 요구 중에서 — 쓰던 문서는 staging 에 두면 초안으로 남는다), failed(진행할 수 없는 이유)를 정한다. 질문 없는 needs-input 은 거부된다. needs-input·failed 결과의 artifacts 는 거부하지 않고 미완성 초안으로만 기록한다 — 출력 경로이고 그 배정의 staging 자리에 실제로 있는 것만이고, 정식 문서로 옮기지 않으며, 답을 받은 뒤의 재배정이 그 초안에서 이어 쓴다. 이어 쓴 결과도 같은 완료 검사를 처음부터 받는다.

문서와 결과가 준비되면 기존 `code-agent next`를 사용한다. plan은 `code-agent plan submit doc/work/<ID>/plan.json`으로 제출한 뒤 사용자 승인을 받는다. 신규 작업에서는 메인·서브 에이전트의 일반 Write/Edit로 번호 문서와 plan.json을 덮어쓸 수 없다.

## 영역 분할

영역별 조사 작업과 모든 조사에 의존하는 합성 작업을 같은 배치에 등록한다. 기본 조사를 이미 등록했다면 `explore` ID를 첫 영역으로 갱신하고 다른 영역을 더한다.

```json
{
  "maxParallel": 2,
  "tasks": [
    {
      "id": "explore", "role": "explore", "title": "주문 영역 조사",
      "requirements": ["R1"],
      "inputs": ["doc/work/ORD-1/requirement.md"],
      "scopes": ["src/order"], "outputs": [],
      "dependsOn": ["analysis"], "questionIds": []
    },
    {
      "id": "common", "role": "explore", "title": "공통 영역 조사",
      "requirements": ["R1"],
      "inputs": ["doc/work/ORD-1/requirement.md"],
      "scopes": ["src/common"], "outputs": [],
      "dependsOn": ["analysis"], "questionIds": []
    },
    {
      "id": "synthesis", "role": "synthesis", "title": "영향도 정리",
      "requirements": ["R1"],
      "inputs": ["doc/work/ORD-1/requirement.md"],
      "scopes": [], "outputs": ["doc/work/ORD-1/02-analysis.md"],
      "dependsOn": ["explore", "common"], "questionIds": []
    }
  ]
}
```

```powershell
code-agent planning prepare doc/work/ORD-1/planning-tasks.json
code-agent planning dispatch explore
code-agent planning dispatch common
```

동시 배정은 기본 3개, 설정 범위는 1~4개다. 영역 밖 호출자나 설정을 발견하면 작업의 `inputs` 또는 `scopes`를 보완해 재배정한다. 서로 다른 조사의 동일 `facts.key` 값이 충돌하면 합성을 막는다. 자연어 표현이 다른 사실의 의미상 충돌은 critic이 추가로 판단한다.

## 재사용·질문·복구

- 같은 작업에서 입력 내용·영역 파일 목록·기준 커밋·매니페스트·공통 정책·선행 결과·관련 질문이 같을 때만 결과를 재사용한다. 파일의 추가·삭제·내용 변경도 반영한다.
- KNOWLEDGE의 키 존재만으로 조사를 생략하지 않는다. 참조한 KNOWLEDGE는 `inputs`에 넣고 현재 코드 근거를 확인한다. 다른 작업의 지식을 자동으로 최신 사실로 인정하지 않는다. `knowledge prune`은 삭제 후보를 찾는 경로 존재 검사이며 내용의 최신성 검사가 아니다.
- 질문 결과는 `needs-input`으로 반환한다. 코드가 questions.md에 다음 Q 번호(담당이 낸 번호는 쓰지 않는다 — 병렬 담당끼리 겹치지 않게)와 빈 답변·영향 요구·출처(`[Origin]: <작업 ID>`)를 기록한다. 실제 답을 받은 뒤 관련 작업을 다시 배정한다. 출처가 있는 질문은 그 작업과 후속 작업(dependsOn을 거쳐 그 작업에 닿는 작업)에만 적용된다 — 앞 단계 결과는 낡지 않는다. 출처는 코드가 질문을 쓰면서 계획 기록(`questionOrigins`)에도 남긴 것만 효력이 있다. 메인이 직접 적은 `[Origin]` 줄은 검증할 수 없으므로 무시되고 출처 없는 질문으로 다룬다. 교차 검토 질문은 출처가 critic이고, 결과의 요구 원소에서 요구 키만 뽑아 `[Requirements]`에 쓴다(없으면 critic의 요구). 출처 없는 질문(메인이 직접 적은 질문)은 `[Requirements]` 범위가 겹치는 작업에, 범위도 없으면 전체 작업에 적용된다. 질문 본문에는 제목·답변·상태·범위·출처 필드 줄을 넣을 수 없다.
- `[Answer]: 보류`, 상태 설명만 있는 답변, 중복 Q 번호는 미응답이다. `[Status]`를 명시한 문서는 실제 답을 기록할 때 `answered`로 갱신해야 한다.
- 답의 출처를 확인할 수 없는 관련 질문(hook 이 관찰한 질문 도구 응답과 다르고 `[Source]: 대화` 도 없는 답)도 미응답으로 보고 그 작업을 배정하지 않는다(`readyProblems` — `next` 게이트와 같은 판정). 이 버전 전에 시작한 작업의 답은 그대로 인정된다.
- 중단된 배정은 `code-agent planning cancel <ID>`로 취소한다. 늦게 온 이전 배정 결과는 적용하지 않는다. 같은 입력의 실패는 3회까지다(취소·고아는 세지 않는다). 이후에는 원인을 조사하고 입력·작업 정의를 보완한다. 작업마다 배정은 예산 구간마다 총 6회까지다(정상 완료·질문·취소·고아 포함, 형식 교정 제외). 예산 구간은 실행 회차와 사용자가 확정한 요구 항목이 정한다 — 같은 ID 에서 요구 항목을 바꿔 확정하거나 반영 뒤 새 실행 회차를 열면 새 구간에서 다시 세고, 이전 구간의 배정은 기록과 비용 집계에만 남는다. 머리말만 바꾼 개정은 같은 구간이다. 한도에 닿으면 자동 재배정을 멈추고 사유와 한도를 사용자에게 보고해 지시를 받는다. 같은 입력 한도는 입력·작업 정의를 보완해 입력 해시가 바뀌면 새로 세고, 같은 입력의 실패는 구간이 바뀌어도 센다. 총 배정 한도는 같은 작업을 다시 준비(`planning prepare`)하거나 입력을 바꿔도 구간이 그대로라 풀리지 않는다. 새 작업 ID 로 다시 준비해도 막힌 작업은 지워지지 않고 뒤 역할의 선행으로 남는다. 확정하지 않은 지시서 변경은 구간을 바꾸지 않고 준비·배정을 멈춘다. 한도에 닿은 뒤 사용자가 한 번 더 허용을 고르면 `/ca-answer`의 judgment 동의(`{"action":"judgment","kind":"retry-grant","name":"taskTotal","id":"<작업 ID>","comment":"<사유>"}`, 같은 입력은 `"name":"sameInput"`)로 사람 허용(같은 입력 +1·총 배정 +3)을 `retry.grants`에 기록한다 — 소진된 카운터에만 기록되고, 그 예산 구간에서만 쓰이며, 사람의 관찰된 선택 없이는 한도가 늘지 않는다. 고르지 않으면 작업 종료(`abort` 동의)다. `planning status`는 작업마다 실행 관찰(`run`)·낡은 이유(`staleBecause`)·사용량(`budget` — 총 배정에는 지금 구간 이름 `epoch`와 구간 밖 배정 수 `earlier`)을 보인다.
- 피드백은 작업 폴더의 별도 파일에 기록해 고칠 작업의 `inputs`에 추가한다. 고칠 작업은 지적 내용으로 정한다. 앞 단계 작업을 고쳐야 하면 원인과 다시 도는 작업을 사용자에게 보고하고 지시를 받은 뒤 되감는다. 후속 결과와 critic 검토도 다시 필요하다.
- 상태는 `.code-agent/work/<ID>/<target>.planning.json`에 보관한다. 짧은 파일 잠금(`.lock`, 주인 `{pid, host, at, nonce}`)으로 병렬 완료 기록의 덮어쓰기를 방지한다. 같은 PC에서 주인 프로세스가 죽었거나 주인 기록이 없는 잠금이 10분 넘게 남았으면 다음 실행이 회수한다(stderr 한 줄). 주인이 살아 있으면 잠시 기다린 뒤 같은 명령을 한 번만 다시 실행하라고 멈춘다. 다른 PC의 잠금이나 주인을 알 수 없는 잠금은 그 프로세스가 끝났는지 확인한 뒤 사람이 그 잠금 파일만 제거한다.

필수 작업 문서에 `확인 필요`·`TODO`·`TBD`가 있으면 전환·제출·승인을 막는다. 근거 파일·줄이 존재해야 하고 AC는 번호 외에 완료 조건을 가져야 한다. BR은 실제 파일:줄 또는 답변된 Q 번호를 연결한다. 내용의 타당성·충분성은 독립 검토와 사용자 승인이 판단한다.

## 구현 Task

각 Task의 담당 R마다 대응 AC를 `acceptance`에 넣고 07의 실행 가능한 TC로 연결한다. 테스트 담당도 같은 규칙이다. TC에는 입력·호출·기대값 또는 오류 단언을 적는다. 전체 테스트 통과 자체와 기존 파일 보존은 실행 절차·preserve이며 독립 기능 TC로 만들지 않는다. 제출 전 목록과 완료 hook·최종 제출의 같은 검사가 이 연결을 대조한다.

신규 계획에는 기존 `sequence`와 함께 `tasks`가 필수다.

```json
{
  "id": "T1", "stage": "app", "title": "주문 조회 구현",
  "requirements": ["R1"], "files": ["src/order/query.ts"],
  "dependsOn": [], "acceptance": ["AC-R1-1"]
}
```

각 계획 파일의 소유자는 정확히 하나다. 의존성은 앞 Task를 가리키고 순서는 `sequence`의 단계 순서를 따른다. 같은 단계 안에 여러 Task를 둘 수 있다. `context`와 `status`는 현재 Task를 표시하며 hook은 그 Task에 배정된 파일만 구현하도록 제한한다. `next`는 현재 Task의 파일 작업 결과(생성·수정 대상 존재, 삭제 대상 부재, 이동 대상 존재와 원본 부재)와 기준 대비 변경을 확인하고 다음 Task로 이동한다. 이 확인은 검증 완료를 뜻하지 않는다. 최종 완료는 check·test·독립 리뷰·통합 검증으로 판정한다. fix는 테스트 단계의 마지막 Task를 넘기기 전에 재현 증거가 필요하다.

계획 승인은 관찰된 계획 작업 기록에도 묶인다. 검토·작업 정의를 바꾸면 다시 승인받아야 한다. 승인 전에 소스 입력이 바뀌면 조사·검토를 다시 해야 하며, 승인 후 계획에 따른 정상 구현은 조사 당시 소스와 다르다는 이유만으로 승인을 무효화하지 않는다.

관찰된 계획 작업은 동일 입력의 중복 호출을 줄이는 구조다. 실제 모델의 토큰 절감량·지연·판단 품질은 별도 실측 대상이다.

외부 의존 계약은 같은 동기 판정 구간에서 계약 내용·원본 stat이 같을 때 Git 결과를 재사용한다. 다음 비동기 구간이나 파일 변경에는 다시 검증한다.
