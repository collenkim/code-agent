# PowerShell 실행 파일 안내

`code-agent read`가 npm의 `code-agent.ps1`을 선택해 PowerShell 실행 정책으로 거부된 사례다. `.cmd`를 허용한 hook 수정만으로는 생성 지침의 명령 선택을 바로잡지 못했다.

모든 Codex 변환본(단계·보조 문서·역할), 별도 ca-answer와 설치 공통 블록에 PowerShell 셸 호출은 `.cmd`로 하라는 규칙을 명시했다. CLI·hook의 파일 도구 안내에도 같은 규칙을 연결했다. 셸에 전달하는 실행 파일 이름만 바꾸며 Bash·macOS·Linux, 파일 경로와 동의 대화 메시지는 보존한다. Claude 공통 블록도 PowerShell을 사용하는 경우에만 적용하도록 안내한다. 실행 정책은 변경하지 않는다.

공통 규칙이 개별 지침만 읽는 담당에게도 전달되어야 하므로 Codex 변환본에 포함한다. 템플릿 예산은 Claude 블록 1,600→1,700자, Codex 블록 1,600→1,800자, Codex ca-answer 4,700→4,900자, Codex 흐름 합계 50,500→53,000자로 조정한다. Claude 흐름 합계는 유지한다.

회귀 검증은 모든 Codex 산출물의 안내·대화 응답 예외와 Claude 변환본 보존, PowerShell Restricted에서 .cmd read의 실제 실행을 포함한다. cloud 설치본은 갱신하지 않았다.

빌드 통과. hookPaths·hostText·templateText·templateBudget·codex·hostNotation·docSync·finalReverify 103개 통과, 실패·생략 0개(40.0초). 첫 검증의 문구 기대값·Codex 도구 이름 검사 충돌과 새 PowerShell 시험의 cwd 누락을 수정한 뒤 같은 묶음을 재검증했다. 전체 테스트는 이번 변경에서 다시 실행하지 않았다. `git diff --check` 통과. [검증 수치](evidence/2026-10-12-powershell-command.json).
