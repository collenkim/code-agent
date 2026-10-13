# Codex 실제 선택 UI 연결

Codex의 번호 나열·응답 문자열 복사는 방향키 선택 UI를 제공하지 못했다. 비동기 질문 호출의 `accepted`도 화면 표시와 사용자 답을 증명하지 않는다. 업무 질문과 동의를 로컬 MCP 폼 입력으로 연결한다.

- `code_agent.ask`: 독립 질문 최대 4개를 폼으로 표시하고 실제 선택을 반환한다. Default 모드에서 동작하며 방향키·Enter와 필드 간 좌우 이동을 사용한다.
- `code_agent.confirm`: 모델은 준비한 ID만 전달한다. 같은 세션의 PreToolUse가 발급한 일회용 질문 티켓을 소비하고, 서버가 저장된 요약·질문을 표시한다. 폼 응답을 직접 받아 기존 세션·질문·대상 해시 검사를 거쳐 `codex-elicitation` 출처로 기록한다.
- 취소·거절은 보류, 미응답·잘못된 응답·연결 오류는 승인하지 않는다. 타 세션·하위 담당·교차 실행·답 주입·재사용을 거부한다. 실행은 기존 `consent finish`와 도메인 게이트를 유지한다. Claude 절차는 유지한다.
- init·update는 프로젝트 `.codex/config.toml` 관리 블록에 서버를 등록한다. 블록 밖 설정과 전역 설정을 덮어쓰지 않는다. 관리 블록이 있는 설정은 기존 저장소의 준비 커밋에도 포함한다. doctor는 설치 누락을 안내한다.
- Windows 샌드박스의 OS 사용자 조회 실패는 원장 표시 이름의 환경값·미확인 표기로 보완한다. 승인 여부를 판단하는 검증에는 사용하지 않는다. 커밋을 포함하는 동의는 `.git` 쓰기 제한 시 첫 적용부터 호스트 권한 요청을 사용하고, 실패한 ID를 재실행하지 않는다.

## 실제 호스트 검증

PowerShell·Codex CLI 0.162.1·Default 모드의 임시 Git 저장소에서 실행했다. 별도 모델 지정이나 모드 전환은 하지 않았다.

1. 실제 화면에 `Field 1/2`, `Display style`, `Compact`, `Detailed`, `enter to submit answer | ←/→ to navigate fields | esc to cancel`이 표시됐다.
2. 방향키·Enter로 `Detailed`, 다음 질문에서 `Dark`를 선택했고 MCP 결과에 각각 같은 값이 반환됐다.
3. setup 동의에서 방향키로 `수정 요청`과 `확인하고 진행` 사이를 이동하고 확정했다. 서버가 `approved`를 반환했다.
4. 새 동의의 첫 `consent finish`를 필요한 `.git` 쓰기 권한으로 실행해 `applied`와 실제 준비 커밋 생성을 확인했다. 프로젝트 hook을 사용했고 동의 응답이나 원장을 직접 주입하지 않았다.

증거 요약은 [실제 UI 기록](evidence/2026-10-13-codex-choice-ui.json)에 있다. 수동 재검증은 `npm.cmd run build` 후 `node scripts/evaluate-choice-ui.cjs`로 임시 저장소를 열어 수행한다. `evaluate-question-choices.cjs`의 비대화형 응답 검사는 UI 검증으로 취급하지 않는다.

## 자동 검증

- 관련 회귀 테스트: 49개 통과, 실패·생략 없음.
- 최종 `npm.cmd test`: 1,402개 중 1,398개 통과, 플랫폼 조건으로 4개 생략, 실패 없음(376.4초). 빌드와 Claude·Codex 절차, 설치·갱신, 동의 경계, 문서 정합성 검사를 포함한다.
- 재현 스크립트 구문 검사와 `git diff --check` 통과. 자동 테스트의 합성 응답과 위 실제 호스트 UI 조작은 별도로 기록한다.

## 적용

대상 프로젝트의 PowerShell에서 `code-agent.cmd update --templates-only --host codex`를 실행하고 Codex를 다시 연다. 프로젝트와 변경된 hook을 검토·신뢰하고 MCP 도구를 로드한다. 이미 구현 중인 작업은 설치 갱신의 계획 밖 변경 규칙을 따른다. 실패한 동의는 기존 문서·답을 유지한 채 새로 준비한다. 사용자 프로젝트의 Git 설정·동의 기록은 이 개발 작업에서 변경하지 않았다.

Codex의 MCP 도구 실행 허용과 프로젝트 동의는 별개다. 클라이언트가 폼을 지원하지 않거나 도구가 없으면 복구 안내를 제공하며 번호 나열을 UI 완료로 보고하지 않는다. 전체 요약은 대화에 먼저 표시하고 폼에도 전달한다. 화면 높이에 따른 긴 요약의 표시 범위는 Codex 클라이언트가 정한다.
