---
name: ca-answer
description: Codex에서 업무 질문과 사용자 동의를 처리하고 미응답 작업을 재개한다.
---

메인이 질문과 승인 처리를 담당한다. 서브 에이전트는 질문 후보만 반환한다.

전용 읽기 도구가 없으면 `code-agent read <파일> [시작 줄] [줄 수]`로 기존 요구·답·동의 자료를 읽는다. 기본 200줄이며 최대 400줄이다.

## 업무 질문

기존 요구와 답부터 읽고 사람이 결정해야 하는 사항만 묻는다. 질문 하나에는 결정 하나를 넣고 후보마다 결과를 설명한다. 도구가 있으면 Codex 질문 도구를 사용하고, 없으면 대화에서 물어 실제 답을 기다린다. 추천·기본 선택·시간 경과·빈 답을 응답으로 기록하지 않는다. 작업 질문은 `doc/work/<ID>/questions.md`, 준비 질문은 `doc/code-agent/setup-questions.md`에 원문 답을 기록한다. 미응답은 `[Answer]:`를 비워 둔다. 업무 답은 승인과 별개다.

## 승인·확정·반영

동작 JSON의 `action`은 `setup`, `docs`, `baseline`, `request`, `plan`, `deliver`, `knowledge-prune`, `model`, `abort`, `plugin-add`, `plugin-remove`, `update` 중 하나다. 문서 종류는 `kind`, 작업 식별자는 `id`, 지시서 경로는 `spec`을 사용한다. 요청·계획 반려는 `decision: "reject"`와 `comment`로 준비한다. 플러그인은 `name`, `command`, `slots`, `sendsCode`, 필요 시 실제 키 대신 환경 변수 이름인 `secretEnv`를 사용한다. 관련 없는 필드는 넣지 않는다. 예: `{"action":"request","id":"작업 ID"}`, `{"action":"plan"}`.

1. 실행 내용을 구체화하고 허용된 작업 문서 폴더에 동작 JSON을 작성한다. `code-agent consent prepare <파일>`로 준비한다. 동작 종류와 필드는 CLI의 검증을 따른다.
2. 반환된 `summary`와 `questions` 전체를 보여 준다. 각 질문의 선택지를 번호 순서대로 보여 주고 `codexReply.format`에 따라 이 대화에서 답하도록 안내한다. 예를 들어 질문 하나라면 `code-agent consent respond <ID> 1`이다. 이 문자열은 셸 명령이 아니라 **사용자가 직접 보내는 대화 메시지**다. 질문 여러 개는 질문 순서대로 `1,2`처럼 선택한다. 선택지 이름·번호를 바꾸거나 승인만 따로 강조하지 않는다.
3. 여기서 실제 사용자 메시지를 기다린다. 메인·서브 에이전트가 대신 메시지를 만들거나 `codex-event`를 호출하지 않는다. 선택 도구의 일반 답, 자동 추천, 짧은 '네'를 승인으로 바꾸지 않는다. 공식 `UserPromptSubmit` 훅이 대화의 응답을 기존 대상 해시·세션·호출에 묶어 기록한다.
4. 다음 턴에 `code-agent consent finish <ID>`로 확인한다. `approved`일 때만 그 자리에서 적용되고 결과가 돌아온다(나눠서 `code-agent consent status <ID>` 확인 뒤 `code-agent consent apply <ID>`를 실행해도 같다). 적용되면 원래 작업을 이어간다. `pending`이면 남은 질문을 보여 준다. 보류·수정 요청·실패이면 해당 결정을 따른다. 대상이 바뀌면 현재 내용으로 새로 준비한다.
5. 응답했는데 계속 `pending`이면 훅 신뢰 여부와 `code-agent doctor --host codex`를 확인한다. 기록을 직접 만들지 않는다. 훅을 지원하지 않는 환경에서는 사람이 직접 터미널의 기존 `confirm`·`approve`·`deliver` 명령을 사용할 수 있다.

모델은 먼저 `code-agent model --host codex`로 역할별 현재값을 조회한다. 사용자가 변경을 요청하면 `{"action":"model","host":"codex","agent":"writer","model":"gpt-6-luna","reasoning":"high"}`처럼 준비한다. `agent:"all"`은 모든 역할, `model:"default"`는 제품 기본값 복원이다. 복원에는 reasoning을 넣지 않는다. 모델만 지정하면 기존 추론 강도를 유지한다. 계정에서 사용할 수 있는 모델인지 확인하고, 오류가 나면 사용자에게 알려 사용 가능한 모델을 선택하게 한다. 임의로 다른 모델로 바꾸지 않는다.

`update`나 `model`을 적용한 뒤에는 Codex를 다시 열어 역할 설정을 다시 로드한다. update로 훅이 바뀌었으면 확인·신뢰한 다음 이어간다.

직접 이 스킬을 호출했다면 `code-agent status`로 현재 작업을 찾고 미응답 질문부터 처리한다. 답이 모이면 현재 단계로 복귀한다.
