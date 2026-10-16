## code-agent

Windows PowerShell에서는 본문·CLI 출력의 code-agent 셸 호출을 code-agent.cmd로 실행한다(.ps1 실행 정책 오류 방지). 그 밖의 셸은 code-agent를 쓴다. 사용자 대화 메시지인 code-agent consent respond는 바꾸지 않는다.

이 프로젝트는 code-agent의 단계·문서·검증 절차를 사용한다. `$ca-request`로 시작하고 `$ca-status`, `$ca-next`로 재개한다. 스킬은 `.agents/skills/ca-*/SKILL.md`, 역할은 `.codex/agents/ca-*.toml`에서 읽는다.

- LangGraph의 `code-agent flow advance --json`으로 재개한다. `procedure`·`instruction`을 수행하고 결과 기록 뒤 같은 명령으로 돌아간다. `kind:wait`는 완료·응답을 기다리며 반복 조회하지 않는다. `context`는 단계 스킬이 시킬 때만 실행하고 담당에게는 `--file` 경로만 넘긴다.
- 공통 지침의 Read·Grep·Glob은 파일 읽기·검색 역할을 뜻한다. 전용 읽기 도구가 없으면 `code-agent read <파일> [시작 줄] [줄 수]`를 사용한다(기본 200줄, 최대 400줄). 배정 inputs와 `code-agent survey`의 경로를 기준으로 읽고, 일반 셸 읽기·연결 명령은 사용하지 않는다. 파일 수정은 `apply_patch`로 처리한다.
- 계획 작업은 `planning advance/status/result/repair/cancel` 계약을 따른다. 사용자 정의 작업은 prepare·dispatch도 지원한다. 배정의 `hostAgents.codex` 이름으로 Codex 서브 에이전트를 호출하고 프롬프트에는 `assignmentFile` 경로(재배정이면 파일에 없는 사유 메모 2~3줄)만 넘겨 결과를 최종 응답으로 반환하게 한다. 담당은 출력 문서를 staging에 apply_patch로 쓰고 결과에는 경로만 넣는다. 훅의 시작·완료 관찰 없이 문서나 결과를 대신 쓰지 않는다.
- `apply_patch`와 셸은 `.codex/hooks.json`의 판정을 받는다. CLI·hook이 거부하면 메인은 `.agents/skills/ca-answer/reference.md`의 **차단 복구**를 따른다. 허용된 조회는 계속하고 새 결정만 질문한다. 상태 파일·확정 원장·계획 밖 파일을 직접 바꾸지 않는다. `codex-event`, `planning-event`, `review-event`, `consent-event`는 호스트 전용이다.
- 질문과 동의는 `.agents/skills/ca-answer/SKILL.md`를 따른다. 업무 질문은 `code_agent.ask`, 동의는 `code_agent.confirm`의 방향키·Enter 선택 UI를 호출한다. 승인·반영은 실제 사용자 응답이 관찰된 동의만 적용한다.
- 구현은 현재 Task의 파일과 완료 조건을 따른다. `code-agent verify`로 검증하고 독립 `ca_reviewer` 결과를 관찰한 뒤 통합한다.
- 설치 후 Codex를 다시 열고 프로젝트 훅을 검토·신뢰해야 한다. 설치 파일이 있다는 사실만으로 훅 실행이 보장되지는 않는다. 역할마다 제품의 기본 모델·추론 강도를 명시한다. `code-agent model --host codex`로 조회하고, 변경은 사용자 요청에 따라 같은 세션의 model 동의 절차로 적용한다. 모델이 스스로 설정 파일을 바꾸지 않는다.
