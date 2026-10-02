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

기존 `AGENTS.md`의 표시 블록 밖 내용, 다른 훅, `.codex/config.toml`은 보존한다. 스킬과 역할 파일은 번들 사본이므로 갱신하면 덮어쓴다. 프로젝트 규칙은 `AGENTS.md`의 블록 밖이나 프로젝트 문서에 둔다. 역할마다 제품 기본 모델·추론 강도를 명시하며 사용자의 역할별 변경값은 갱신 뒤에도 유지한다.

설치 후 Codex를 다시 열고 프로젝트 훅을 검토·신뢰한다. 자동으로 신뢰 설정을 바꾸지 않는다. 호스트가 훅을 무시하거나 설치된 역할을 선택하는 서브 에이전트 호출을 지원하지 않으면 관찰 결과가 없어 계획·리뷰 게이트를 통과할 수 없다. `doctor`는 설치 파일과 명령을 검사하며 실제 훅 신뢰·모델 실행 성공을 인증하지 않는다. 2026-10-02 추가 검사는 `codex-cli 0.160.0`에서 수행했다. 앞선 0.159.3 기능 조회와 구분하며 지원 최소 버전으로 단정하지 않는다.

공식 설치 형식은 [로컬 스킬](https://learn.chatgpt.com/docs/build-skills), [커스텀 에이전트](https://learn.chatgpt.com/docs/agent-configuration/subagents), [훅](https://learn.chatgpt.com/docs/hooks)을 참고한다.

## 동작과 검증

계획의 `planning advance`, 요약 `planning status`, 상세 `planning result <ID>`, 형식 교정 `planning repair <ID>`는 Claude와 같은 구현을 사용한다. Codex 스킬도 같은 배정·대기·차단·게이트 준비 상태와 1회 교정 절차를 제공한다. 설치 후 기존 프로젝트에는 템플릿 갱신과 호스트 재시작이 필요하다. 변경별 검증 범위는 [계획 실행 효율 개선 이력](reviews/2026-10-02-planning-efficiency.md)에 기록한다.

우선순위 2의 소규모 impact 통합·역할별 입력·동일 결과 재사용도 같은 구현과 생성 템플릿을 사용한다. Codex에서는 통합 조사에 `ca_explorer`를 호출한다. 독립 critic과 승인 절차는 유지한다. [선택 기준](planning.md#위임-수와-입력-범위-선택)과 [추가 실제 검증 이력](reviews/2026-10-02-priority-two-native-codex.md)을 따른다.

배정의 `agent`와 `hostAgents.claude`는 기존 `ca-analyst` 이름이다. Codex는 `hostAgents.codex`의 `ca_analyst`처럼 밑줄 이름으로 호출한다. 모든 Codex 역할의 TOML `name`과 스킬의 호출 지침을 변환하며, 훅에서는 공통 역할로 연결한다. 기존 설치를 갱신할 수 있도록 역할 파일 경로 `.codex/agents/ca-analyst.toml`은 유지한다. 스킬 이름 `ca-analyze`는 역할 이름과 별개다.

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

`code-agent usage`의 토큰·비용 집계는 현재 Claude 기록만 지원하며 Codex 사용량을 0으로 간주하지 않는다. Codex 사용량은 호스트 화면에서 확인한다.

자동 검증은 합성한 호스트 이벤트, 실제 CLI 프로세스, 임시 Git 저장소의 전체 작업 흐름으로 수행한다. 실제 Codex 추가 검사에서는 하위 호출과 결과 반환이 있어도 관찰된 시작·완료가 없어 계획이 running에 머물렀다. 검증 도구의 프로젝트 신뢰 경로 인자를 고친 뒤에도 완료 훅은 관찰되지 않았다. App Server 조회에서 훅 5개를 인식한 것과 실제 실행 성공은 구분한다. 두 호스트의 실사용 호환성이 모두 확인되었다는 의미는 아니다. Codex UI의 수동 사용성·실제 사람의 승인·전체 개발 흐름 실계정 측정도 별도 범위다. 결과와 원인 해석의 한계는 [최신 변경·검증 이력](reviews/2026-10-02-priority-two-native-codex.md)에 기록한다.

재현 검사는 `npm run build` 후 `node scripts/evaluate-planning-hosts.cjs codex <새-기록이름> --vetted-hooks --model gpt-6.1-sol`로 실행한다. 실제 모델 호출이 발생하며 초기 준비·요구 동의는 합성 fixture다. `--model`은 검사 메인만 바꾸고 제품 역할별 기본값은 유지한다. `--vetted-hooks`는 생성된 훅만 확인한 격리 검사에 한정한다. `--through-impact`는 분석 다음 영향도까지 실제 호출로 확인한다. 실사용 설치에서 훅 신뢰 검토를 생략하는 안내가 아니다.

## 역할별 모델 기본값과 변경

초보 사용자가 호스트의 전역 설정을 따로 맞추지 않아도 각 역할의 TOML에 `model`과 `model_reasoning_effort`를 명시한다. 기본값은 다음과 같으며 모델을 자동으로 바꾸는 라우팅은 하지 않는다.

| 역할 | 기본 모델 | 추론 강도 |
|---|---|---|
| analyst · critic · reviewer | gpt-6.1-sol | high |
| surveyor · explorer · writer · implementer · tester | gpt-6.1-sol | medium |

이는 품질과 실행량을 함께 고려한 제품의 시작값이다. 실제 최적 비용·성능 조합을 입증한 벤치마크 결과는 아니다. 계정에서 제공하지 않는 모델이면 사용 가능한 모델을 선택해야 하며 조용히 다른 모델로 대체하지 않는다. 기본 모델과 추론 강도의 근거는 [공식 커스텀 에이전트 문서](https://learn.chatgpt.com/docs/agent-configuration/subagents)다.

```sh
code-agent model --host codex
code-agent model writer gpt-6-luna --host codex --reasoning high
code-agent model writer default --host codex
code-agent model all default --host codex
```

조회는 메인도 실행할 수 있다. 위 변경 명령은 사람이 직접 TTY에서 실행한다. 대화에서 변경할 때는 `ca-answer`가 `{"action":"model","host":"codex","agent":"writer","model":"gpt-6-luna","reasoning":"high"}`로 기존 같은 세션 동의 절차를 사용한다. `model:"default"`는 모델·추론 강도를 함께 기본값으로 복원한다. 모델만 지정하면 해당 역할의 기존 추론 강도를 유지한다.

Codex 변경값은 `.code-agent/codex-models.json`, Claude 변경값은 기존 `.code-agent/models.json`에 분리한다. 설정 우선순위는 **역할별 사용자 변경값 → 제품의 역할별 기본값**이다. 양쪽 호스트를 설치했다면 변경 대상 `--host`를 반드시 지정한다. 단독 설치에서는 생략할 수 있다. 재설치·업데이트·doctor도 이 값을 사용하며, 존재하는 Codex 변경값 파일은 기준 커밋과 최종 반영의 명시적 경로에 포함한다.

적용 후 호스트를 재시작해 역할 설정을 다시 읽는다. 실행 중인 담당이나 메인 세션의 모델을 변경하지 않는다. 부모 설정을 상속하던 이전 Codex 설치는 업데이트 후 위 기본값을 사용하며, 원하는 모델은 변경 명령으로 명시한다. 전역 `.codex/config.toml`은 수정하지 않는다.
