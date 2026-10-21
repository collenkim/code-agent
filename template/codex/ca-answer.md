---
name: ca-answer
description: Codex에서 업무 질문과 사용자 동의를 처리하고 미응답 작업을 재개한다.
---

메인이 질문과 승인 처리를 담당한다. 서브 에이전트는 질문 후보만 반환한다.

결정이 필요한 질문은 모든 단계에서 실제 선택 UI로 표시한다. 단독 실행은 호스트 질문 도구, 대시보드 연결 실행은 같은 폴더 `dashboard.md`를 따른다. 비대화형 실행도 대시보드 사람 채널을 먼저 확인한다.

CLI·hook 차단이면 같은 폴더 `reference.md`의 **차단 복구**를 읽는다. 허용된 도움말·상태 조회와 이미 선택한 방향의 진행은 재확인 없이 수행하고, 새 결정이 필요할 때만 아래 업무 질문을 사용한다. 읽기마저 차단되면 받은 사유로 가능한 조치·보류를 묻는다. 사용자 취소·보류·승인 거절은 되묻지 않는다.

## 업무 질문

질문은 `code_agent` MCP의 `ask`로 표시한다(도구 이름 `mcp__code_agent__ask`). Default 모드에서도 방향키·Enter로 선택하는 폼이다. 도구 이름을 말하거나 글머리표를 출력한 것은 도구 호출이 아니다. 실제 호출 결과 없이 UI 완료를 보고하지 않는다. 접수는 답이 아니다.

질문하거나 사용자 답을 기다리기 전 같은 폴더 `reference.md`의 **단계별 선택**을 따른다. 미응답 안내·특정 문구 입력 요청만으로 끝내지 않는다. 준비 질문을 재개할 때는 기존 답을 보존하고 미응답만 표시한다. 이미 답을 기다리는 질문은 중복 호출하지 않는다. 선택 UI가 없으면 아래 설치 복구를 안내한다. 번호 입력을 선택 UI의 대체 완료로 보고하지 않는다. 선택지가 5개 이상이거나 동의 오류에 `변경 대상:`이 표시되면 같은 폴더 `appendix.md`의 **5개 이상 선택지**·**대상 변경 안내**를 읽는다.

문서 작성 방식·초기 구성·복구 방향은 업무 질문이다. `ask`를 **실제로 호출**하며 인자는 `{"questions":[{"title":"질문과 후보별 결과","options":["추천안","수정","보류"]}]}`다. 한 호출에 독립 질문 1~4개를 넣는다. 실제 `answered` 결과의 답만 기록한다. `cancelled`·오류·시간 경과는 답이 아니다. `request_user_input_async`의 접수 성공을 선택창 표시로 보지 않으며, `request_user_input`의 모드 제한을 우회하지 않는다. 도구를 쓰려고 모드를 임의 변경하지 않는다. 승인은 이 도구의 답으로 처리하지 않고 아래 `confirm`을 사용한다.

MCP 도구가 없거나 폼이 거부되면 `code-agent doctor --host codex`로 설치·hook 신뢰를 확인하고 연결 복구 뒤 Codex를 다시 연다. 템플릿 갱신은 doctor가 안내하는 진행 중 작업 제한을 따른다. 도구 실행 승인과 프로젝트 동의는 별개다. 사용자가 취소하면 재호출하지 않는다. 선택에 의존하는 작업은 응답 전 진행하지 않는다.

기존 요구와 답부터 읽고 사람이 결정해야 하는 사항만 묻는다. 질문 하나에는 결정 하나를 넣고 후보마다 결과를 설명한다. 선택 UI가 없으면 연결을 복구하고 같은 질문을 표시하며 번호 입력으로 대체하지 않는다. 표시 실패(`presentation.state: failed`)는 사용자 보류가 아니므로 연결 복구 뒤 재표시한다. 추천·기본 선택·시간 경과·빈 답을 응답으로 기록하지 않는다. 작업 질문은 `doc/work/<ID>/questions.md`, 준비 질문은 `doc/code-agent/setup-questions.md`에 원문 답을 기록한다. 미응답은 `[Answer]:`를 비워 둔다. 업무 답은 승인과 별개다. 관찰된 계획 작업 질문의 `[Origin]:` 줄은 지우거나 바꾸지 않는다. Codex 에서 받은 업무 답의 원문(고른 선택지 이름 또는 사용자가 먼저 쓴 명확한 답)을 `[Answer]:`에 그대로 적고 다음 줄에 `[Source]: 대화`를 둔다. 질문 원장의 UI 응답과 별개로 이 문서 답은 계획 승인·반영 화면에 '관찰 안 됨'으로 표시된다. 동의를 준비한 뒤 응답·적용 전에는 업무 질문을 하지 않는다.

## 승인·확정·반영

기존 계약 재인용은 `code-agent planning reuse-answer <Q번호> <계약ID> <항목키>`로 기록한다. 등록된 Git 근거와 같은 원문만 받으며 사람 답·동의가 아니다. 근거가 없거나 요구와 상충하면 질문하고 `[Source]: 대화`로 대신 적지 않는다.

동작 JSON의 `action`은 `setup`, `docs`, `baseline`, `request`, `plan`, `deliver`, `knowledge-prune`, `model`, `abort`, `plugin-add`, `plugin-remove`, `update`, `repro-log`, `judgment` 중 하나다. 문서 종류는 `kind`, 작업 식별자는 `id`, 지시서 경로는 `spec`을 사용한다. 요청·계획 반려는 `decision: "reject"`와 `comment`로 준비한다. 플러그인은 `name`, `command`, `slots`, `sendsCode`, 필요 시 실제 키 대신 환경 변수 이름인 `secretEnv`를 사용한다. 관련 없는 필드는 넣지 않는다. 예: `{"action":"request","id":"작업 ID"}`, `{"action":"plan"}`. `judgment`는 `kind`(`retry-grant`·`waive-finding`·`cross-stop`), `name`·`id`, 필수 `comment`를 쓰며 사용자가 그 선택을 고른 뒤에만 준비한다. 지적 기각(waive-finding)은 그 회차에만 적용되고, 교차 중지(cross-stop)는 설정 오류·형식 오류·샌드박스 거절로 막힌 지점에만 준비할 수 있다. 자유 문구가 없는 동작(`setup`·`docs`·`baseline`·`request`·`plan`·`deliver`·`knowledge-prune`·`abort`·`update`·`repro-log`)은 파일 없이 `code-agent consent prepare --action <동작> [--id <작업 ID>] [--kind <종류>] [--spec <지시서>] --for codex`로 준비한다. 반려·`model`·플러그인·`judgment`처럼 자유 문구나 여러 필드가 필요한 동작만 JSON 파일로 준비한다.

1. 실행 내용을 구체화하고, 파일이 필요한 동작이면 허용된 작업 문서 폴더에 동작 JSON을 작성한다. `code-agent consent prepare <파일> --for codex`(또는 위의 `--action` 형식)로 준비한다. 동작 종류와 필드는 CLI의 검증을 따른다. `consent prepare`는 이 대화의 셸에서 이 꼴 그대로 실행한다(훅이 이 세션에 묶는다). 셸 연결자나 리디렉션을 붙이지 않는다.
2. 반환된 `summary` 전문을 보여 주고 `code_agent.confirm`(`mcp__code_agent__confirm`)에 `{"id":"반환된 ID"}`만 전달한다. 폼에는 요약 앞부분·전문 파일 경로·질문만 보인다. 답이나 확인 코드를 인자로 받지 않는다. 사용자는 방향키로 이동하고 Enter로 확정하며 Esc는 보류다. 여러 질문은 화면의 필드 이동으로 각각 선택한다.
3. 실제 폼 응답을 기다린다. 메인·서브 에이전트가 대신 응답하거나 `codex-event`를 호출하지 않는다. MCP 실행을 허용한 것은 프로젝트 동의가 아니다. 서버는 PreToolUse의 세션 티켓과 UI 응답을 기존 대상 해시·질문 호출에 묶어 기록한다. 일반 업무 답·추천·짧은 '네'는 승인이 아니다.
4. 반환된 상태가 `approved`이면 같은 턴에 `code-agent consent finish <ID>`로 적용한다. 결과·`phase`·`next`에 따라 원래 작업을 이어간다. `pending`이면 남은 질문을 같은 `confirm`으로 표시한다. `failure`가 있으면 같은 ID로 다시 묻거나 적용하지 않고 `failure.guide`를 따른다. 보류·취소·수정 요청이면 멈추고 자동 재질문하지 않는다. `warning`은 그대로 알린다.
   Git 커밋이 포함된 setup·baseline·deliver는 샌드박스가 `.git` 쓰기를 제한하면 첫 finish부터 셸의 권한 요청(`sandbox_permissions: "require_escalated"`)을 사용한다. 호스트 권한 승인은 프로젝트 동의와 별개다. 실패한 ID를 권한 상승만 해서 재실행하지 않는다.
5. UI 오류는 설치·hook 신뢰를 점검하고 기록을 직접 만들지 않는다. 옛 `code-agent consent respond <ID> …`는 사용자가 명시적으로 요청한 대화 입력 호환 경로이며 기본 안내로 제시하지 않는다(`UserPromptSubmit` 관찰). 실패한 ID는 재사용하지 않는다.

모델은 먼저 `code-agent model --host codex`로 역할별 현재값을 조회한다. 사용자가 변경을 요청하면 `{"action":"model","host":"codex","agent":"writer","model":"gpt-6-luna","reasoning":"high"}`처럼 준비한다. 두 호스트를 함께 설치했으면 Claude 역할은 `--host claude`로 조회하고 `"host":"claude"`로 준비한다(강도 low·medium·high·xhigh·max, haiku는 강도를 넣지 않는다). `agent:"all"`은 모든 역할, `model:"default"`는 제품 기본값 복원이다. 복원에는 reasoning을 넣지 않는다. 모델만 지정하면 기존 추론 강도를 유지한다. 진행 중인 작업이 있으면 준비가 거부되므로 작업을 반영하거나 종료한 뒤 요청하게 한다. 계정에서 사용할 수 있는 모델인지 확인하고, 오류가 나면 사용자에게 알려 사용 가능한 모델을 선택하게 한다. 임의로 다른 모델로 바꾸지 않는다.

`model`을 적용한 뒤에는 Codex를 다시 열어 역할 설정을 다시 로드한다. Claude 역할을 바꿨으면 Claude도 다시 연다. `update`는 결과의 '호스트를 다시 열어야 하는 것'이 있을 때만 다시 열고(훅이 바뀌었으면 확인·신뢰한 다음 이어간다), 없으면 결과가 다시 읽으라는 지침·스킬 파일을 읽고 이어간다. `update` 적용은 네트워크와 사용자 홈의 릴리스 저장소를 쓰므로 샌드박스 밖(권한 상승)으로 실행한다.

직접 이 스킬을 호출했다면 `code-agent status`로 현재 작업을 찾고 미응답 질문부터 처리한다. 답이 모이면 현재 단계로 복귀한다.
