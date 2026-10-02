# Codex 연동

code-agent의 접수·분석·설계·계획·구현·검증·리뷰·통합 절차를 Codex에서도 사용한다. 단계와 증거 판정은 Claude와 같은 CLI가 담당하고 설치 파일·도구 입력·사용자 응답 관찰만 호스트별로 처리한다.

## 설치와 시작

```sh
code-agent init --host codex
code-agent doctor --host codex
codex
```

Codex 대화에서 `$ca-request <요구사항>`으로 시작한다. 중단한 작업은 `$ca-status`, `$ca-next`로 이어간다. 다른 단계도 같은 이름의 `$ca-*` 스킬을 사용한다. 스킬 호출을 입력하는 곳은 대화창이며 셸이 아니다.

Claude도 함께 사용할 프로젝트는 `code-agent init --host both`로 설치한다. 기존 Claude 프로젝트에 `--host codex`만 추가해도 Claude 설정은 보존된다. 설치 이력이 없는 프로젝트에서 `--host`를 생략하면 기존처럼 Claude를 설치한다. 이후 `init`·`update`·`doctor`는 `.code-agent/hosts.json`에 기록된 호스트를 대상으로 한다. `--host claude|codex|both`로 명시할 수도 있다.

| 설치 대상 | Codex 경로 |
|---|---|
| 스킬 18개 | `.agents/skills/ca-*/SKILL.md` |
| 역할 8개 | `.codex/agents/ca-*.toml` |
| 훅 5종 | `.codex/hooks.json` |
| 프로젝트 지침 | `AGENTS.md`의 code-agent 표시 블록 |
| 설치 이력 | `.code-agent/hosts.json`, `.code-agent/version` |

기존 `AGENTS.md`의 표시 블록 밖 내용, 다른 훅, `.codex/config.toml`은 보존한다. 스킬과 역할 파일은 번들 사본이므로 갱신하면 덮어쓴다. 프로젝트 규칙은 `AGENTS.md`의 블록 밖이나 프로젝트 문서에 둔다. 역할의 모델·추론 강도는 Codex 부모 설정을 상속한다.

설치 후 Codex를 다시 열고 프로젝트 훅을 검토·신뢰한다. 자동으로 신뢰 설정을 바꾸지 않는다. 호스트가 훅을 무시하거나 서브 에이전트를 지원하지 않으면 관찰 결과가 없어 계획·리뷰 게이트를 통과할 수 없다. `doctor`는 설치 파일과 명령을 검사하며 실제 훅 신뢰·모델 실행 성공을 인증하지 않는다. 로컬 기능 조회 기준은 `codex-cli 0.159.3`의 `hooks`, `multi_agent` 활성 상태다. 이를 지원 최소 버전으로 단정하지 않는다.

공식 설치 형식은 [로컬 스킬](https://learn.chatgpt.com/docs/build-skills), [커스텀 에이전트](https://learn.chatgpt.com/docs/agent-configuration/subagents), [훅](https://learn.chatgpt.com/docs/hooks)을 참고한다.

## 동작과 검증

| 이벤트 | code-agent 처리 |
|---|---|
| PreToolUse | 셸 명령과 패치의 모든 추가·수정·삭제·이동 전후 경로를 기존 쓰기 게이트에 대조 |
| UserPromptSubmit | 준비된 확인 요청에 대한 명시적 사용자 메시지를 동의 기록에 연결 |
| SubagentStart | 계획 담당·독립 리뷰어의 세션과 실행 ID 관찰 |
| SubagentStop | 호스트가 전달한 최종 응답을 배정·입력 해시·근거·출력 계약에 대조 |
| Stop | 계획 밖 변경·미결 질문 검사와 필요한 후속 안내 |

다섯 이벤트는 `code-agent codex-event` 하나로 들어온다. Codex의 셸 훅은 `Bash`와 `tool_input.command`를 사용하고, 패치는 `apply_patch`의 `command`를 사용한다. 패치 일부라도 금지 경로이면 호출 전체를 거부한다. 하위 실행 transcript는 파싱하지 않고 `last_assistant_message`만 결과로 받는다. 담당은 `SubagentHandback` 대신 최종 응답으로 계약에 맞는 JSON 또는 리뷰 지적을 반환한다.

계획 작업은 [계획 작업 문서](planning.md)의 의존성·동시 실행 한도·같은 입력 재사용·재시도·미결 질문 규칙을 그대로 따른다. 프로그램 노드는 CLI로 실행하고 추론 노드만 담당에게 넘긴다. 기준 커밋에는 Codex 설치 파일과 호스트 이력이 포함된다. `.agents/`·`.codex/`는 탐색 입력 범위에서 제외하고 모델의 직접 설정 변경도 거부한다.

훅은 작업 절차의 오류를 줄이는 장치다. 호스트가 관찰하지 않는 도구나 외부 프로세스까지 완전히 통제하는 OS 보안 경계는 아니다. 두 호스트를 같은 작업에 동시에 사용하지 말고, 현재 작업을 멈춘 뒤 다른 호스트에서 상태를 확인해 재개한다.

## 사용자 확인

일반 업무 질문은 Codex 질문 도구 또는 대화로 받는다. 승인·확정·반영은 다음 절차를 따른다.

1. 메인이 `consent prepare`로 동작과 대상 해시를 준비한다.
2. 요약과 질문·선택지를 모두 표시한다. `codexReply`에는 질문 순서와 선택지 번호가 있다.
3. 사용자가 같은 대화에서 `code-agent consent respond <요청 ID> <번호>`를 직접 보낸다. 질문이 여러 개면 `1,2`처럼 질문 순서대로 적는다. 이것은 셸 명령이 아니다.
4. `UserPromptSubmit`이 실제 메시지를 관찰한다. 메인은 다음 턴에서 `consent status`를 조회하고, 승인된 경우만 `consent apply`로 이어간다.

첫 번째 선택지가 항상 승인이라는 가정으로 실행하지 않는다. 화면에 표시한 번호와 뜻을 확인한다. 보류·수정 요청은 그 상태로 기록하며, ‘네’ 같은 일반 답이나 모델이 대신 만든 메시지를 승인으로 바꾸지 않는다. 변경된 대상, 서브 에이전트 응답, 누락된 세션, 이미 소비한 응답은 승인이 되지 않는다. 승인 원장의 출처는 `codex-prompt`다. Claude의 선택 도구 출처 `claude-question`과 구분한다.

훅을 사용할 수 없다면 사람이 직접 터미널에서 기존 `confirm`·`approve`·`deliver`를 실행할 수 있다. 이 수동 승인만으로 계획·리뷰의 실행 관찰 요구가 없어지지는 않는다.

## 갱신·제거·지원 범위

현재 번들만 적용할 때는 `code-agent update --templates-only [--host codex]`를 사용한다. Git 소스 설치는 기존 `code-agent update [--host codex]`로 소스·빌드·적용·점검을 진행한다. 양쪽을 설치하고 `--host`를 생략하면 둘 다 갱신한다. `--cli` 개발용 경로도 호스트별로 승계한다. 갱신 뒤 Codex를 다시 열고 변경된 훅을 확인한다.

제거할 때는 본 제품이 설치한 `.agents/skills/ca-*`, `.codex/agents/ca-*.toml`, `AGENTS.md` 표시 블록 및 `hooks.json`의 `code-agent codex-event` 항목만 제거한다. 다른 사용자 설정을 포함한 디렉토리 전체를 지우지 않는다. 양쪽 중 Codex만 제거했다면 `.code-agent/hosts.json`에서 `codex`만 빼고 `claude`를 남긴다.

모든 호스트를 제거했다면 `hosts.json`도 제거한다. 빈 배열로 남기지 않는다. 작업 문서와 증거 보존 여부는 별도로 결정한다.

`code-agent model`은 Claude 모델 설정 전용이다. Codex는 부모 설정에서 모델과 추론 강도를 바꾼다. `code-agent usage`의 토큰·비용 집계도 현재 Claude 기록만 지원하며 Codex 사용량을 0으로 간주하지 않는다. Codex 사용량은 호스트 화면에서 확인한다.

검증은 합성한 호스트 이벤트, 실제 CLI 프로세스, 임시 Git 저장소의 전체 작업 흐름으로 수행한다. 실계정 모델 호출이나 Codex UI에서 훅을 신뢰한 뒤 수행하는 수동 사용성 측정은 포함하지 않는다. 결과는 [최신 변경·검증 이력](reviews/2026-10-02-codex-support.md)에 기록한다.
