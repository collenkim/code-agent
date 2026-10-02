## code-agent

이 프로젝트는 code-agent의 단계·문서·검증 절차를 사용한다. `$ca-request`로 시작하고 `$ca-status`, `$ca-next`로 재개한다. 스킬은 `.agents/skills/ca-*/SKILL.md`, 역할은 `.codex/agents/ca-*.toml`에서 읽는다.

- 먼저 `code-agent status`, `code-agent context`로 현재 단계와 범위를 확인한다. 프로그램이 수행하는 단계는 CLI로 실행한다. 추론이 필요한 단계만 해당 스킬·서브 에이전트로 넘긴다.
- 공통 지침의 Read·Grep·Glob은 파일 읽기·검색 역할을 뜻한다. 현재 Codex가 제공하는 파일 도구나 셸의 `rg`를 사용하고, 파일 수정은 `apply_patch`로 처리한다.
- 계획 작업은 `planning advance/status/result/repair/cancel` 계약을 따른다. 사용자 정의 작업은 prepare·dispatch도 지원한다. 배정의 `hostAgents.codex` 이름으로 Codex 서브 에이전트를 호출하고 결과를 최종 응답으로 반환하게 한다. 훅의 시작·완료 관찰 없이 문서나 결과를 대신 쓰지 않는다.
- `apply_patch`와 셸은 `.codex/hooks.json`의 판정을 받는다. 상태 파일·확정 원장·계획 밖 파일을 직접 바꾸지 않는다. `codex-event`, `planning-event`, `review-event`, `consent-event`는 호스트 전용이다.
- 질문과 동의는 `.agents/skills/ca-answer/SKILL.md`를 따른다. 승인·반영은 실제 사용자 응답이 관찰된 동의만 적용한다.
- 구현은 현재 Task의 파일과 완료 조건을 따른다. `code-agent verify`로 검증하고 독립 `ca_reviewer` 결과를 관찰한 뒤 통합한다.
- 설치 후 Codex를 다시 열고 프로젝트 훅을 검토·신뢰해야 한다. 설치 파일이 있다는 사실만으로 훅 실행이 보장되지는 않는다. 역할마다 제품의 기본 모델·추론 강도를 명시한다. `code-agent model --host codex`로 조회하고, 변경은 사용자 요청에 따라 같은 세션의 model 동의 절차로 적용한다. 모델이 스스로 설정 파일을 바꾸지 않는다.
