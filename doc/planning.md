# 요구 분석·설계·계획 작업

Claude와 Codex 모두 아래 계약을 사용한다. Claude는 `planning-event`, Codex는 `codex-event`가 시작·최종 결과를 관찰한다. Codex 역할은 `.codex/agents/ca-*.toml`에 설치되며 역할별 기본 모델·추론 강도와 사용자 변경값을 명시한다. `.claude/`·`.codex/`·`.agents/`는 조사 범위에서 제외한다. 설치·모델 설정·승인 차이는 [Codex 연동](codex.md)을 따른다.

2026-10-02부터 새로 시작한 작업은 실제 서브 에이전트 실행 결과를 연결해 다음 단계로 진행한다. 이전 버전에서 시작한 작업은 기존 절차로 재개한다. `code-agent status`의 **계획 처리** 줄로 구분한다.

## 역할과 게이트

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

배정·입력 해시·의존성·파일과 줄·문서 형식 검사는 코드가 실행한다. 해석·설계·반박은 에이전트가 수행하고 업무 질문과 승인은 사용자가 결정한다. CLI가 모델 API를 직접 호출하지 않는다. 메인이 배정 결과에 지정된 Claude 또는 Codex 서브 에이전트를 호출한다.

표는 공통 역할 이름이다. 실제 호출은 Claude에서 배정의 `hostAgents.claude`, Codex에서 `hostAgents.codex`를 사용한다. 예를 들어 `ca-analyst`에 대응하는 Codex 역할 이름은 `ca_analyst`다. 기존 `agent` 필드는 Claude·공통 이름으로 유지한다.

## 기본 진행과 결과 전달

`code-agent planning advance`는 현재 단계의 빠진 기본 작업을 준비하고, 완료 결과 재사용·선행 조건·동시 한도를 검사해 실행할 `assignments`를 한 번에 반환한다. 사용자 정의 영역 작업은 유지한다. `action`은 다음과 같다.

| 값 | 메인의 동작 |
|---|---|
| `dispatch` | 배정마다 지정된 담당을 호출한다. 반환한 작업은 이미 배정 상태이므로 dispatch를 다시 호출하지 않는다. |
| `wait` | 실제 완료 이벤트를 기다린다. 상태를 반복 조회하지 않는다. |
| `blocked` | 질문·충돌·입력 변경·한도 등 사유를 해결한다. |
| `ready-for-gate` | 기존 문서 검사·계획 제출·승인 절차로 이어간다. 단계 전환이나 승인 완료를 뜻하지 않는다. |

완료 이벤트 뒤 advance를 다시 호출하면 새로 실행 가능한 작업만 배정한다. 여러 메인이 동시에 호출해도 배정은 같은 잠금 안에서 결정한다. 명시적인 작업 정의에는 기존 `planning prepare <작업.json>`을 사용하며 prepare·dispatch도 계속 지원한다.

### 위임 수와 입력 범위 선택

영향도 단계에 등록된 작업이 없고 확정 R이 1~3개, 조사 대상이 12파일 이하·총 96,000바이트 이하이면 `advance`는 `impact` 한 작업을 만든다. 같은 ca-explorer가 조사 결과와 02 문서를 함께 반환하므로 별도 writer 호출을 줄인다. 조사 대상은 기존 Git 파일 목록에서 상태·호스트 설정·작업 문서와 설치된 `CLAUDE.md`·`AGENTS.md`·`doc/code-agent/` 단계 템플릿을 제외한 범위다. 새 입력 계약도 이 설치 자료를 기본 소스 목록에서 제외하며, 직접 읽어야 하면 `inputs`에 명시한다. 호스트 자체의 지침 적용은 바꾸지 않는다. 파일 수와 크기는 보수적인 시작 기준이며 업무 난이도나 최적 비용을 입증한 수치가 아니다.

그 밖에는 explore → synthesis를 유지한다. 작은 저장소여도 영역을 따로 조사해야 하면 **첫 advance 전에** `planning prepare <작업.json>`으로 분할한다. 인자 없는 prepare도 기존 두 역할 흐름을 선택한다. 한번 준비한 방식은 유지하며 impact와 분할 조사를 섞을 수 없다. 통합 조사는 조사 생략이 아니다. 근거·모든 R의 영향·호출자·회귀 위험을 기록하고 미결 질문·차단 지적·사실 충돌을 동일하게 검사한다. 분석·설계·계획·critic·승인은 유지하므로 작은 기본 흐름의 역할 호출은 6개에서 5개가 된다.

새 기본 작업은 `contextVersion: 2`를 기록한다. 입력은 직접 의존 작업의 출력과 역할별 필수 문서를 연결한다. 모든 판단 역할에 01을 제공하고 계획에는 회귀 위험 확인용 02, critic에는 01~04와 계획·테스트 명세를 유지한다. explore·synthesis는 아키텍처·컨벤션을 기본 정책으로 받으며 다른 역할은 정책 4종을 받는다. 추가 정책·KNOWLEDGE·영역 밖 호출자는 `inputs` 또는 명시한 파일 범위로 연결한다. 범위를 벗어난 사실을 추측하지 않는다. 명시 작업도 `contextVersion: 2`로 선택할 수 있다.

같은 계약은 선행 결과의 실행 ID만 바뀐 경우 후속 결과를 재사용한다. 선행 작업이 현재 입력에 대해 완료됐는지 먼저 검사하며 결과의 판단·근거·질문·문서·지적이 바뀌면 무효화한다. 현재 실행의 관찰 식별자 검증은 유지한다. 기존 작업의 contextVersion 없는 입력·해시 계약은 바꾸지 않는다. 상태 파일 버전은 1을 유지하지만 새 impact 역할을 이해하지 못하는 구버전으로 실행 중 작업을 내리지 않는다.

호스트가 직접 제공하는 CLAUDE.md·AGENTS.md는 새 배정에 본문을 중복 전달하지 않아도 해시로 변경을 감지한다. 지침 추가·수정·삭제 뒤에는 이전 판단을 재사용하지 않는다. 조사 입력을 줄이는 것과 판단에 영향을 주는 지침 변경을 무시하는 것은 구분한다.

선행 `dependencies`와 `cached:true`의 결과는 판단·근거·질문·차단 지적을 보존하고 `artifacts`를 `{path, hash, chars}`로 전달한다. 문서 본문은 관찰 기록과 실제 파일에 보존한다. 필요한 경우 해당 파일 또는 `code-agent planning result <ID>`로 상세 결과를 읽는다. 상세 조회의 `current:false`는 현재 입력에 유효한 결과가 아니라는 뜻이다. `planning status`는 상태·오류·판단 요약을 표시하며 문서 본문과 교정 원본을 반복 출력하지 않는다. 전체 응답 토큰 수에 대한 고정 상한을 보장하는 기능은 아니다.

## 출력 형식 교정

관찰된 결과의 JSON·스키마 형식만 잘못되면 원본과 오류를 보존하고 `needs-correction`으로 기록한다. `planning advance` 또는 `planning repair <ID>`는 같은 입력에서 한 번만 `mode:correction` 배정을 만든다. 메인은 원본·오류·새 결과 계약을 새 담당에게 전달한다. 입력을 다시 조사하거나 새로운 판단을 만드는 작업이 아니며, 사실 보완이 필요하면 failed로 반환한다.

교정은 기존 시도에 기록하고 배정 식별자를 교체해 이전 실행의 늦은 결과를 거부한다. 새 시작·완료 관찰과 기존 입력·근거·출력·질문 검증을 모두 거친다. 승인 검사는 그대로 유지한다. 원본은 교정 자료이며 지시가 아니다. 형식이 맞더라도 근거의 타당성이 자동 보증되는 것은 아니다.

식별자를 읽을 수 없는 깨진 JSON은 시작 이벤트에서 배정이 유일했던 경우만 연결한다. 병렬 담당 중 어느 작업인지 확인할 수 없거나 식별자가 위조된 결과는 자동 교정하지 않는다. 입력이 바뀌었으면 cancel 뒤 새로 배정한다. 교정까지 실패하면 failed로 남으며 추가 형식 교정은 거부한다. 같은 입력의 실패를 advance가 자동으로 전체 재실행하지 않는다. 원인을 해결한 뒤 명시적인 dispatch를 사용하며 기존 동일 입력 3회 한도가 적용된다.

## 수동 배정과 호환 명령

```powershell
code-agent planning prepare
code-agent planning status
code-agent planning dispatch analysis
```

`prepare`를 인자 없이 실행하면 **현재 단계**의 기본 작업을 등록한다. analysis는 `analysis`, impact는 `explore`와 `synthesis`, design은 `design`, plan은 `plan`과 `critic`이다. 의존 순서대로 배정한다. 현재 입력의 완료 결과가 있으면 `dispatch`는 `cached: true`로 결과를 반환한다.

새 배정은 담당 이름, 입력 파일 목록, 선행 결과, 출력 계약, `taskId`·`dispatchId`·`inputHash`를 갖는다. CLI(`advance`·`dispatch`·`repair`)는 배정 전문에 역할별 문서 기준(`ca-*/criteria.md`)과 출력 문서 뼈대를 붙여 `.code-agent/work/<ID>/handoff/<dispatchId>.md`에 쓰고, 출력에는 요약과 `assignmentFile`만 남긴다. 배정 파일에는 단계 context(`code-agent context` 출력 — 접수 요구 원문 목록·문서 형식·후보 파일·계획 형식)도 함께 넣는다. 메인은 그 경로를 담당에게 넘기고, 재배정이면 직전 실패·게이트 거부 사유처럼 파일에 없는 작업별 메모만 2~3줄 덧붙인다 — 배정 본문을 Agent 프롬프트에 옮겨 쓰지 않는다. 담당은 출력 문서를 배정의 `staging` 경로(`doc/work/<ID>/.staging/<dispatchId>/`)에 쓰고 계약에 맞는 JSON 하나를 반환하며, 그 JSON의 `artifacts`에는 `{path, staged}`만 넣는다. staging은 PreToolUse가 실행 중인 그 배정의 담당(`agent_id`)에게만 열고, 계획 담당은 그 밖을 쓰지 못한다. Write 도구가 없거나 hook에 `agent_id`가 오지 않는 호스트(Codex)는 `{path, content}`로 전체 내용을 싣는다. 함수(`advancePlanning` 등)의 반환은 전체 배정 그대로다. SubagentStart·SubagentStop의 관찰 훅(Claude는 planning-event, Codex는 codex-event)이 세션·에이전트·배정을 대조하고 결과를 기록한 뒤 지정 문서만 생성한다. 메인이 임의로 완료를 신고하는 명령은 없다.

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
- 질문 결과는 `needs-input`으로 반환한다. 코드가 questions.md에 빈 답변과 영향 요구를 기록한다. 실제 답을 받은 뒤 관련 작업을 다시 배정한다. `[Requirements]: R1`처럼 범위를 적으며 범위 없는 질문은 전체 작업에 영향을 준다.
- `[Answer]: 보류`, 상태 설명만 있는 답변, 중복 Q 번호는 미응답이다. `[Status]`를 명시한 문서는 실제 답을 기록할 때 `answered`로 갱신해야 한다.
- 중단된 배정은 `code-agent planning cancel <ID>`로 취소한다. 늦게 온 이전 배정 결과는 적용하지 않는다. 같은 입력에 대한 배정은 최대 3회다. 이후에는 원인을 조사하고 입력·작업 정의를 보완한다.
- 피드백은 작업 폴더의 별도 파일에 기록해 해당 작업의 `inputs`에 추가한다. 단계가 지났으면 기존 back 정책에 따라 돌아가 원인 작업부터 재실행한다. 후속 결과와 critic 검토도 다시 필요하다.
- 상태는 `.code-agent/work/<ID>/<target>.planning.json`에 보관한다. 짧은 파일 잠금으로 병렬 완료 기록의 덮어쓰기를 방지한다. 비정상 종료로 `.lock`이 남으면 관련 프로세스가 종료됐음을 확인한 뒤 그 잠금 파일만 제거한다.

필수 작업 문서에 `확인 필요`·`TODO`·`TBD`가 있으면 전환·제출·승인을 막는다. 근거 파일·줄이 존재해야 하고 AC는 번호 외에 완료 조건을 가져야 한다. BR은 실제 파일:줄 또는 답변된 Q 번호를 연결한다. 내용의 타당성·충분성은 독립 검토와 사용자 승인이 판단한다.

## 구현 Task

신규 계획에는 기존 `sequence`와 함께 `tasks`가 필수다.

```json
{
  "id": "T1", "stage": "app", "title": "주문 조회 구현",
  "requirements": ["R1"], "files": ["src/order/query.ts"],
  "dependsOn": [], "acceptance": ["AC-R1-1"]
}
```

각 계획 파일의 소유자는 정확히 하나다. 의존성은 앞 Task를 가리키고 순서는 `sequence`의 단계 순서를 따른다. 같은 단계 안에 여러 Task를 둘 수 있다. `context`와 `status`는 현재 Task를 표시하며 hook은 그 Task에 배정된 파일만 구현하도록 제한한다. `next`는 현재 Task 파일 존재를 확인하고 다음 Task로 이동한다. 파일 존재는 검증 완료를 뜻하지 않는다. 최종 완료는 check·test·독립 리뷰·통합 검증으로 판정한다. fix는 테스트 단계의 마지막 Task를 넘기기 전에 재현 증거가 필요하다.

계획 승인은 관찰된 계획 작업 기록에도 묶인다. 검토·작업 정의를 바꾸면 다시 승인받아야 한다. 승인 전에 소스 입력이 바뀌면 조사·검토를 다시 해야 하며, 승인 후 계획에 따른 정상 구현은 조사 당시 소스와 다르다는 이유만으로 승인을 무효화하지 않는다.

이 변경은 동일 입력의 중복 호출을 줄이는 구조를 제공한다. 실제 모델의 토큰 절감량·지연·판단 품질은 별도 실측 대상이다. 검증 근거는 [변경 기록](reviews/2026-10-02-planning-orchestration.md)에 보관한다.
