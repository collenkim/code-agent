# Codex 관리 실행의 Git 실행 권한

## 변경 범위

code-agent만 수정했다. master-agent 화면이 이 요청 종류를 보여 주고 서명해 보내는 일은 그 저장소의 범위다.

- Codex 관리 실행을 `codex exec --json` 대신 로컬 `codex app-server`(표준 입출력 JSON-RPC)로 돌린다(`master/codexTransport.ts`).
  - 시작 전 `hooks/list`로 이 프로젝트의 code-agent PreToolUse 가 활성·동기 실행·신뢰 상태로 로드됐는지 확인한다. 아니면 모델 턴을 시작하지 않는다.
  - `thread/start`·`thread/resume`의 thread ID 를 실행 기록에 남긴 뒤 `turn/start`로 한 턴을 실행한다. 다른 thread·turn ID 와 하위 에이전트의 알림은 주 세션의 완료로 보지 않는다.
- 샌드박스(`workspace-write`, 네트워크 차단)는 그대로 두고 `approval_policy=on-request`·`approvals_reviewer=user`로 단건 승인 요청을 받는다.
  - 받는 요청은 Codex 의 명령 실행 승인 요청 가운데 저장소 루트의 `code-agent start|verify|repro …`(PowerShell·bash 의 단순 실행 래퍼 포함)뿐이다. 이것만 `host-permission` 요청으로 영속화한다(`master/codexPermissions.ts`).
  - 복합 셸·인라인 코드·직접 Git 변경과 파일·네트워크·MCP 권한 요청은 거절한다.
- 대시보드 사람 채널의 서명된 `permissionDecision`만 원래 살아 있는 thread·turn·RPC 에 한 번 전달한다.
  - 응답 직전에 프로젝트·브랜치·HEAD·작업·세션·실행·소유 세대·사람 채널·만료를 다시 검사한다.
  - 일반 답·업무 동의·위임으로는 이 요청에 답할 수 없고, 권한 응답을 일반 답으로 쓸 수도 없다.
- 전달과 실제 명령 완료를 따로 기록한다(`forwarded`·`executionConfirmed`·`status`·`exitCode`).
  - 요청은 15분과 원래 실행 시간 상한 중 먼저 오는 시각에 만료된다.
  - 다음 경우에는 대기 중인 권한을 닫고 같은 승인을 다시 보내지 않는다: 턴 종료, 프로세스 종료, 서버가 먼저 닫은 호출, 정지·취소, 만료.
- 실행 결과의 권한 거부 목록과 실행 세션 지침(단건 권한 요청 규칙)을 맞췄다. 권한 요청 기록이 생겨 상태 형식 세대(`STATE_SCHEMA`)를 10으로 올렸다. 기능 협상은 `hello.interactions.hostPermissions`다.
- 문서: [Git 실행 권한](../dashboard-interactions.md#codex-git-실행-권한)이 요청·응답·결과 계약이다. [관리 실행 계약](../master-control.md#11-master-실행-세션의-규칙)·`doc/codex.md`·흐름도의 Codex 관리 실행 설명은 app-server 방식에 맞췄다.

## 검증

이 작업을 만든 세션의 근거(빌드 산출물 폴더에 남은 보고서·로그)와 커밋 정리 때의 재확인으로 나눈다. 수치를 합산하지 않는다.

- 작업 세션의 전체 회귀: 1,673개 중 1,669개 통과, 실패 0개, 플랫폼 생략 4개, 약 766초.
- 작업 세션의 실제 Codex 평가(`scripts/evaluate-codex-git-permission.cjs`, 실제 모델 호출): 격리 저장소에서 마지막 실행(2026-10-20T01:23:41Z)이 통과했다.
  - Codex 가 `code-agent start`의 `.git/index.lock` 쓰기 거부 뒤 같은 명령의 단건 실행 권한을 요청했다.
  - 평가 fixture 의 대시보드 응답(`accept` — 사람의 실제 승인이 아니다)을 원래 RPC 에 전달하자 같은 명령이 종료 코드 0으로 끝났다. 작업 `CONSENT-1`이 `feature/CONSENT-1`에서 analysis 단계로 열렸고, 실제 PreToolUse 등 hook 실행이 기록됐다.
  - 같은 날 앞선 7회는 평가 조건을 맞추는 과정에서 실패했다.
- 커밋 정리 때의 재확인(이 변경만 담은 커밋의 단독 빌드·회귀)은 [기계 판독 근거](evidence/2026-10-20-codex-git-permission.json)에 남긴다.

정리 시점 이 PC의 Codex CLI 는 `codex-cli 0.163.0`이다. 평가 보고서에는 당시 버전이 남아 있지 않다.

## 남은 범위

- master-agent 화면이 `kind: "host-permission"`을 따로 보여 주고 `permissionDecision`을 서명해 보내야 한다. 사람 채널·지원 화면이 없으면 Codex 관리 실행의 Git 쓰기는 승인 없이 대기한다.
- 실제 사람의 대시보드 클릭과 브라우저 화면은 검증하지 않았다(평가는 합성 응답이다).
- 일반 터미널·IDE 의 독립 Codex 는 이 경로를 쓰지 않고 그 호스트의 승인 화면을 쓴다.
