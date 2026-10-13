---
name: ca-answer
description: Codex에서 업무 질문과 사용자 동의를 처리하고 미응답 작업을 재개한다.
---

Windows PowerShell에서는 본문·CLI 출력의 code-agent 셸 호출을 code-agent.cmd로 실행한다(.ps1 실행 정책 오류 방지). 그 밖의 셸은 code-agent를 쓴다. 사용자 대화 메시지인 code-agent consent respond는 바꾸지 않는다.

메인이 질문과 승인 처리를 담당한다. 서브 에이전트는 질문 후보만 반환한다.

전용 읽기 도구가 없으면 `code-agent read <파일> [시작 줄] [줄 수]`로 기존 요구·답·동의 자료를 읽는다. 기본 200줄이며 최대 400줄이다.

CLI·hook 차단이면 같은 폴더 `reference.md`의 **차단 복구**를 읽는다. 허용된 도움말·상태 조회와 이미 선택한 방향의 진행은 재확인 없이 수행하고, 새 결정이 필요할 때만 아래 업무 질문을 사용한다. 읽기마저 차단되면 받은 사유로 가능한 조치·보류를 묻는다. 사용자 취소·보류·승인 거절은 되묻지 않는다.

## 업무 질문

도구 이름을 말하거나 글머리표를 출력한 것은 도구 호출이 아니다. 실제 호출 결과 없이 “선택 도구로 제시했다”고 보고하지 않는다. 호출하지 못했으면 “현재 질문 도구를 사용할 수 없어 대화로 받습니다”라고 알리고 각 질문에 번호 선택지를 붙인다.

질문하거나 사용자 답을 기다리기 전 같은 폴더 `reference.md`의 **단계별 선택**을 따른다. 미응답 안내·특정 문구 입력 요청만으로 끝내지 않는다. 도구를 사용할 수 없으면 그 이유와 번호 선택지를 함께 제시한다. 준비 질문을 재개할 때는 기존 답을 보존하고 미응답 선택지를 제시한다. 이미 답을 기다리는 질문은 중복 호출하지 않는다.

문서 작성 방식·초기 구성·복구 방향은 업무 질문이다. 현재 모드에서 사용 가능한 질문 도구를 **실제로 호출**한다. `request_user_input_async`가 있으면 질문과 선택지를 전달하고 실제 답을 기다린다. `request_user_input`은 현재 모드와 도구의 사용 조건이 허용할 때만 호출한다. 도구별 인자 형식·선택지 수 제한을 따른다. 도구를 호출할 수 있는데 글머리표만 출력하고 끝내지 않는다. 도구가 없거나 호출이 거부되면 이유를 짧게 알리고 **번호·선택지 이름·결과**를 대화에 표시해 번호 또는 직접 입력으로 답하게 한다. 도구를 쓰려고 모드를 임의 변경하지 않는다. 응답이 올 때까지 선택에 의존하는 작업은 진행하지 않는다. 승인은 이 도구의 답으로 처리하지 않고 아래 사용자 동의를 따른다.

기존 요구와 답부터 읽고 사람이 결정해야 하는 사항만 묻는다. 질문 하나에는 결정 하나를 넣고 후보마다 결과를 설명한다. 도구가 있으면 Codex 질문 도구를 사용하고, 없으면 대화에서 물어 실제 답을 기다린다. 추천·기본 선택·시간 경과·빈 답을 응답으로 기록하지 않는다. 작업 질문은 `doc/work/<ID>/questions.md`, 준비 질문은 `doc/code-agent/setup-questions.md`에 원문 답을 기록한다. 미응답은 `[Answer]:`를 비워 둔다. 업무 답은 승인과 별개다. 관찰된 계획 작업 질문의 `[Origin]:` 줄은 지우거나 바꾸지 않는다. Codex 에서 받은 업무 답은 질문 도구로 받았든 대화로 받았든 그 원문(고른 선택지 이름 또는 사용자가 쓴 글)을 `[Answer]:`에 그대로 적고 다음 줄에 `[Source]: 대화`를 둔다. Codex 에서는 훅이 업무 답을 관찰하지 않으므로 이 답은 계획 승인·반영 화면에 '관찰 안 됨'으로 이름과 함께 표시된다. 동의를 준비한 뒤 응답·적용 전에는 업무 질문을 하지 않는다.

## 승인·확정·반영

동작 JSON의 `action`은 `setup`, `docs`, `baseline`, `request`, `plan`, `deliver`, `knowledge-prune`, `model`, `abort`, `plugin-add`, `plugin-remove`, `update`, `repro-log`, `judgment` 중 하나다. 문서 종류는 `kind`, 작업 식별자는 `id`, 지시서 경로는 `spec`을 사용한다. 요청·계획 반려는 `decision: "reject"`와 `comment`로 준비한다. 플러그인은 `name`, `command`, `slots`, `sendsCode`, 필요 시 실제 키 대신 환경 변수 이름인 `secretEnv`를 사용한다. 관련 없는 필드는 넣지 않는다. 예: `{"action":"request","id":"작업 ID"}`, `{"action":"plan"}`. `judgment`는 `kind`(`retry-grant`·`waive-finding`·`cross-stop`), `name`·`id`, 필수 `comment`를 쓰며 사용자가 그 선택을 고른 뒤에만 준비한다. 지적 기각(waive-finding)은 그 회차에만 적용되고, 교차 중지(cross-stop)는 설정 오류·형식 오류·샌드박스 거절로 막힌 지점에만 준비할 수 있다. 자유 문구가 없는 동작(`setup`·`docs`·`baseline`·`request`·`plan`·`deliver`·`knowledge-prune`·`abort`·`update`·`repro-log`)은 파일 없이 `code-agent consent prepare --action <동작> [--id <작업 ID>] [--kind <종류>] [--spec <지시서>] --for codex`로 준비한다. 반려·`model`·플러그인·`judgment`처럼 자유 문구나 여러 필드가 필요한 동작만 JSON 파일로 준비한다.

1. 실행 내용을 구체화하고, 파일이 필요한 동작이면 허용된 작업 문서 폴더에 동작 JSON을 작성한다. `code-agent consent prepare <파일> --for codex`(또는 위의 `--action` 형식)로 준비한다. 동작 종류와 필드는 CLI의 검증을 따른다. `consent prepare`는 이 대화의 셸에서 이 꼴 그대로 실행한다(훅이 이 세션에 묶는다). 셸 연결자나 리디렉션을 붙이지 않는다.
2. 처음 한 번 반환된 `summary` 전문을 보여 준다. 그다음 `codexReply.questions`의 질문과 번호 선택지를 순서대로 그대로 보여 주고 `codexReply.format`에 따라 이 대화에서 답하도록 안내한다. 질문 하나라면 `code-agent consent respond <ID> 1 <확인 코드>`다. 확인 코드는 `codexReply` 마지막 질문 끝의 `확인 코드:` 6자다. 요약·질문을 줄이지 말고 확인 코드 줄까지 모두 보여 준다 — 코드는 요약 전문이 사용자에게 갔는지 보는 장치라, 요약을 줄인 채 코드 줄만 보여 주면 확인이 되지 않는다. 응답 문자열을 대신 완성해 주지 않는다 — 번호와 코드는 사용자가 직접 적는다. 이 문자열은 셸 명령이 아니라 **사용자가 직접 보내는 대화 메시지**다. 질문 여러 개는 질문 순서대로 `1,2`처럼 선택한다. 선택지 이름·번호를 바꾸거나 승인만 따로 강조하지 않는다.
3. 여기서 실제 사용자 메시지를 기다린다. 메인·서브 에이전트가 대신 메시지를 만들거나 `codex-event`를 호출하지 않는다. 선택 도구의 일반 답, 자동 추천, 짧은 '네'를 승인으로 바꾸지 않는다. 공식 `UserPromptSubmit` 훅이 대화의 응답을 기존 대상 해시·세션·호출에 묶어 기록한다.
4. 다음 턴에 `code-agent consent finish <ID>`로 확인한다. `approved`일 때만 그 자리에서 적용되고 결과·`phase`·`next`가 돌아온다(나눠서 `code-agent consent status <ID>` 확인 뒤 `code-agent consent apply <ID>`를 실행해도 같다). 적용되면 `next`대로 원래 작업을 이어간다(status를 다시 부르지 않는다). `pending`이면 summary 없이 남은 `codexReply.questions`만 보여 준다. 결과에 `failure`가 있으면 같은 ID로 다시 묻거나 적용하지 않고 `failure.guide`를 따른다(보류·명시적 선택 없음이면 멈추고 다시 묻지 않는다). `warning`은 사용자에게 그대로 알린다.
5. 응답했는데 계속 `pending`이면 훅 신뢰 여부와 `code-agent doctor --host codex`를 확인한다. 기록을 직접 만들지 않는다. 훅을 지원하지 않는 환경에서는 사람이 직접 터미널의 기존 `confirm`·`approve`·`deliver` 명령을 사용할 수 있다.

모델은 먼저 `code-agent model --host codex`로 역할별 현재값을 조회한다. 사용자가 변경을 요청하면 `{"action":"model","host":"codex","agent":"writer","model":"gpt-6-luna","reasoning":"high"}`처럼 준비한다. 두 호스트를 함께 설치했으면 Claude 역할은 `--host claude`로 조회하고 `"host":"claude"`로 준비한다(강도 low·medium·high·xhigh·max, haiku는 강도를 넣지 않는다). `agent:"all"`은 모든 역할, `model:"default"`는 제품 기본값 복원이다. 복원에는 reasoning을 넣지 않는다. 모델만 지정하면 기존 추론 강도를 유지한다. 진행 중인 작업이 있으면 준비가 거부되므로 작업을 반영하거나 종료한 뒤 요청하게 한다. 계정에서 사용할 수 있는 모델인지 확인하고, 오류가 나면 사용자에게 알려 사용 가능한 모델을 선택하게 한다. 임의로 다른 모델로 바꾸지 않는다.

`update`나 `model`을 적용한 뒤에는 Codex를 다시 열어 역할 설정을 다시 로드한다. update로 훅이 바뀌었으면 확인·신뢰한 다음 이어간다. Claude 역할을 바꿨으면 Claude도 다시 연다.

직접 이 스킬을 호출했다면 `code-agent status`로 현재 작업을 찾고 미응답 질문부터 처리한다. 답이 모이면 현재 단계로 복귀한다.
