# ca-answer 참고 — 필요할 때만 읽는다

## 5개 이상 선택지

전체 후보의 이름과 한 줄 설명을 먼저 짧은 표로 보여 주고, 선택은 도구로 받는다. 추천을 첫 번째로 정렬하고 고유한 후보 이름은 페이지 사이에 바꾸지 않는다.

- 첫 화면: 후보 3개 + `다른 선택지`(설명에 남은 후보 이름).
- 중간 화면: `앞 선택지` + 다음 후보 2개 + `다른 선택지`.
- 마지막 화면: `앞 선택지` + 남은 후보 최대 3개. 따라서 모든 화면은 2~4개 옵션이고 어떤 후보든 선택할 수 있다.
- 5개 후보 예: 첫 화면 A·B·C·다른 선택지 → 마지막 화면 앞 선택지·D·E. 7개 후보 예: A·B·C·다른 선택지 → 앞 선택지·D·E·다른 선택지 → 앞 선택지·F·G.
- 페이지 이동은 답으로 저장하지 않는다. 후보를 고르면 그 결정은 끝내고 다른 페이지를 강제로 질문하지 않는다. 내장 직접 입력으로 다른 페이지의 후보를 명시해도 그 선택을 기록한다.
- 5개 이상을 복수 선택해야 하면 먼저 3개 이하의 의미 있는 그룹을 도구로 선택하게 하고, 선택한 각 그룹의 후보를 최대 4개씩 복수 선택으로 받는다. 이동·그룹 이름을 최종 선택으로 간주하지 않고, 실제 선택한 후보들을 합쳐 기록한다.

## 작업 JSON 필드

| 필드 | 형식과 용도 |
|---|---|
| `action` | 필수 문자열: `setup`, `docs`, `baseline`, `request`, `plan`, `deliver`, `knowledge-prune`, `model`, `abort`, `plugin-add`, `plugin-remove`, `update` 중 하나 |
| `kind` | 선택 문자열: 문서 종류 또는 `all` |
| `id` | 선택 문자열: 요구사항의 작업 ID. `prepare`가 반환하는 동의 UUID와 구분한다 |
| `spec` | 선택 문자열: 사람이 작성한 지시서 경로 |
| `decision` | 선택 문자열: `accept` 또는 `reject`. 실행할 확정·반려 동작이며 실제 동의 응답을 대신하지 않는다 |
| `comment` | 선택 문자열: 사용자가 제시한 반려 사유 등 |
| `agent`, `model` | 선택 문자열: 모델을 바꿀 에이전트와 모델 |
| `name`, `command`, `slots` | 선택 문자열: 플러그인 이름·실행 명령·슬롯 |
| `sendsCode` | 선택 불리언: 플러그인의 코드 전송 여부 |
| `secretEnv` | 선택 문자열: **이미 설정된 환경변수 이름만** 참조한다. 키 값은 넣지 않는다 |

## 상황별 예시

| 상황 | 작업 JSON 예시 |
|---|---|
| 최초 준비 | `{"action":"setup"}` — POLICY 전체 확정(`confirm doc all`)과 필요한 준비 커밋(`setup baseline`: 최초 커밋 또는 기존 저장소의 도입 파일 반영)을 **사용자 질문 하나**로 묶는다 |
| 준비 이후 문서 확정 | `{"action":"docs","kind":"all"}` — 특정 문서만이면 해당 종류를 쓴다 |
| 기준 커밋만 별도 준비 | `{"action":"baseline"}` |
| 접수 요구사항 확정 | `{"action":"request","id":"<작업 ID>"}` — 수기 지시서는 필요하면 `spec`을 포함한다 |
| 계획 승인 | `{"action":"plan"}` |
| 요구사항·계획 반려 기록 | 해당 `request` 또는 `plan`에 `"decision":"reject","comment":"<사용자 사유>"`를 포함한다. 이 동작도 별도 동의 후 적용한다 |
| 검증 결과 반영 | `{"action":"deliver"}` |
| 오래된 지식 항목 정리 | `{"action":"knowledge-prune"}` |
| 모델 변경 | `{"action":"model","host":"claude","agent":"<에이전트|all>","model":"<opus|sonnet|haiku|default>"}` |
| 접수·작업 종료 | `{"action":"abort"}` |
| 플러그인 추가 | `{"action":"plugin-add","name":"<이름>","command":"<명령>","slots":"<슬롯>","sendsCode":false}` — 인증이 필요하면 `secretEnv`로 기존 환경변수 이름만 참조한다 |
| 플러그인 제거 | `{"action":"plugin-remove","name":"<이름>"}` |
| 사용자가 code-agent 업데이트를 요청함 | `{"action":"update"}` — 소스 갱신의 Git pull·빌드·설치 적용 범위를 확인받는다 |

## 수동 대체 경로

독립 TTY CLI는 사용자가 직접 선택하는 **수동 대체 경로**다. 같은 세션의 도구·hook을 사용할 수 없으면 미승인 상태와 사유를 알리고 이 경로를 안내할 수 있다. `code-agent confirm doc all`, `code-agent setup baseline`, `code-agent confirm request <ID> [<지시서>]`, `code-agent approve`, `code-agent deliver` 등은 사용자가 직접 실행할 때만 사용하며 필수 절차로 요구하지 않는다. 에이전트가 TTY 입력을 대신하거나 다른 명령으로 동의를 우회하지 않는다. 수동 처리 뒤에는 현재 상태를 확인하고 중단된 흐름을 재개한다.
