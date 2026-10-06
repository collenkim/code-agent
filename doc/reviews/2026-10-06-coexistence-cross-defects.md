# AI-DLC 공존·Claude·Codex 교차 검증·결함 2단계 수정

기준일: 2026-10-06. 수정 전 기준 커밋: `d7edb18`. 현재 동작은 [설계](../design.md#claudecodex-교차-검증), [사용 가이드](../usage.md), [설치](../install.md), [계획 작업](../planning.md)을 따른다.

## 범위와 결정

외부 결함 보고 두 건(동의 스냅샷 1건, 1.0.0 소스 검토 40건)을 HEAD 기준으로 다시 판정한 뒤 실제 결함부터 고쳤다. 사용자 결정은 다음과 같다.

- 같은 브랜치에 진행 중인 AWS AI-DLC 의도가 있으면 code-agent 를 막는다. 브랜치 담당자는 바뀌지 않는다는 전제이며 팀원이 커밋한 의도도 포함한다. AI-DLC hook 만 설치돼 있고 진행 중인 의도가 없으면 경고만 한다.
- Claude·Codex 두 호스트가 같은 작업을 동시에 진행하는 경우는 없다. 두 호스트 설치는 **교차 검증**을 뜻한다 — 계획 검토(critic)와 코드 리뷰를 다른 호스트가 한 번 더 보고, 두 호스트가 설치되면 필수이며, CLI 가 다른 호스트를 읽기 전용·비대화형으로 직접 실행한다. 어느 쪽이든 차단 지적이 남으면 막고 의견이 갈리면 사람이 판단한다.

## 수정 내용

| 구분 | 결함·항목 | 처리 |
|---|---|---|
| 공존 | AI-DLC 동시 진행 | `request begin`·`docs begin`·`start`·`next`·검증 게이트에서 진행 중 의도를 막고, 작업 중 AI-DLC 명령은 hook 이 사유와 함께 거부. status·doctor·SessionStart 에 경고·차단 표시 |
| 교차 검증 | 계획 검토·코드 리뷰 | `code-agent planning cross --by <호스트>` · `review cross --by <호스트>`. critic 배정·리뷰 회차에 묶어 기록하고 계획 제출·리뷰 게이트가 요구. 교차 질문 번호는 코드가 매김 |
| H4 | SubagentStop 무한 재시도 | 담당이 고칠 수 있는 실패(배정 식별·리뷰 표 형식)만 한 번 돌려보내고, 기록이 끝난 실패·이미 처리한 이벤트·`stop_hook_active` 재시도는 막지 않음 |
| H5 | PowerShell 괄호·CR 우회 | 작은따옴표 밖 `( ) { } @ $` 와 CR 을 거부 (Windows Codex 셸 포함) |
| H6 | worktree 정리 실패로 결과 유실 | 정리 실패를 경고로 바꿔 build·test 결과 저장을 지킴, `worktree prune` |
| H7 | Windows 손자 프로세스·고정 10분 | 시간 초과 시 `taskkill /T /F` 로 트리째 종료, close 대신 exit 후 정리, `commandTimeoutMinutes`(1~240, 승인 해시 밖) |
| H8 | 중단된 회차가 한도 소비 | 실행 기록 없이 올라간 회차는 코드가 그대로면 다시 쓰고, 고쳤으면 새 회차 |
| H9 | 소스 업데이트가 절대 경로를 박음 | `--cli` 를 줬을 때만 바꾸고, 아니면 설치된 hook 꼴을 승계 |
| M1 | 설정 파일 하나가 모든 도구를 막음 | 읽기·`code-agent.json` 수정·`manifest check`·`status`·`help` 만 열고 나머지는 원인과 함께 거부 |
| M4 | fix 재현 테스트가 scope 밖 | 테스트 단계(`kind: test`) 파일은 scope 상한을 받지 않음. 단계 위치·보존 대상은 유지 |
| M6 | 병렬 담당의 질문 번호 충돌 | 담당 번호를 쓰지 않고 코드가 다음 Q 번호를 매기며 결과에도 반영 |
| M10 | 동의 적용 잠금 고착 | 잠금에 pid·호스트·시각 기록, 같은 PC 의 끝난 프로세스 잠금만 되찾음. 끝맺지 못한 `applying` 은 중단으로 알림 |
| M17 | autocrlf 체크아웃의 원장 사슬 오판 | 확정·승인·접수 원장을 CRLF 로 읽어도 같은 사슬. doctor 는 원장 오류에도 진단을 끝까지 냄 |
| M18 잔여 | 공유 git 설정이 동의를 깨뜨림 | 다른 worktree 의 `push -u` 가 남기는 `branch.*` 추적 정보는 스냅샷에서 제외. 추적 감사 파일은 AI-DLC 경고 정책으로 처리 |
| L3 | pre-commit hook 이 커밋에 파일 추가 | 반영 목록 밖 파일을 커밋 뒤 대조해 출력에 경고(되돌리지 않음) |
| L9 | 상대 경로·`\\?\`·UNC 로 키 파일 읽기 | 키 파일 이름·실제 경로로 대조, 읽기용 git 의 `--no-index` 거부 |
| L12 | quotePath 기본값의 한글 경로 | 변경·추적 목록을 `-z` 로 원문 그대로 읽음 |

남은 것: M11(환경 실패를 코드 결함으로 분류·`--retry` 회차 소비)과 M12(컨텍스트 로드 실패를 재현으로 인정)는 회차·재현 정책을 바꾸는 일이라 사용자 결정 대기다. 결함 보고서의 나머지 항목은 이번 단계에서 다루지 않았다.

## 실측 — 두 호스트 전체 흐름

`node scripts/evaluate-full-flow.cjs run new --model opus --hosts both --budget 15 --timeout 40` 을 실제 Claude Code(opus)와 실제 Codex CLI(0.160.1, `gpt-6.1-sol/high`)로 돌렸다. 8턴 · 38분 · $12.63 에서 계획 단계에 멈췄다([원자료](evidence/full-flow-new-2026-10-06-opus-both.json)).

- Codex 교차 계획 검토는 실제로 두 번 완료됐다. 첫 회는 `needs-input` 질문 하나를 냈고 코드가 Q1 로 기록했다. 답(평가 fixture)이 R1~R5 에 걸려 계획 작업이 다시 돌았다. 다음 회는 Claude critic 이 권고만 낸 계획에서 차단 지적 2건(상위 `package.json` type 미확인, README 문자열 존재만 보는 TC)을 냈고 설계·계획이 다시 배정됐다.
- 4턴부터 Codex 실행이 `You hit your spend cap set by the owner of your workspace.` 로 실패했다. 메인은 게이트를 우회하지 않고 원인·재개 방법을 보고했으며, 네 번 같은 실패 뒤 재시도를 멈췄다. 이 때문에 코드 리뷰 교차는 실제 호스트로 확인하지 못했다(가짜 호스트로 자동 검사).
- 같은 저장소에서 `code-agent planning cross --by claude` 를 직접 실행해 Claude 쪽 경로를 확인했다. 68초, `claude -p --agent ca-critic`(opus) 결과가 JSON 으로 파싱·근거 검증·기록됐고 차단 1건(설계가 package.json 을 추가했는데 02 영향 분석이 갱신되지 않음)·권고 2건을 냈다. 세션 안 critic 이 통과시킨 계획이다.

교차 검증은 실제로 다른 결함을 찾았지만 비용이 크다. 교차 질문이 전체 요구에 걸리면 분석 뒤 계획 작업이 모두 다시 돈다. 다른 호스트를 실행할 수 없으면(한도·로그인·장애) 작업이 멈추며 우회 경로는 없다.

## 검증

최종 코드의 `npm test` 단일 전체 실행은 **786개 중 782개 통과·실패 0개·생략 4개**다. 생략은 Windows의 파일명 대소문자 2개와 POSIX 권한 2개다. 앞선 전체 실행 두 번(1단계·교차 뒤 770개 중 1개 실패, 2단계 뒤 786개 중 2개 실패)의 실패는 모두 이번 변경과 테스트 fixture 의 어긋남이었고, fixture 를 고친 뒤 같은 사례가 통과했다. 새 검사는 AI-DLC 공존, 교차 계획 검토·리뷰(가짜 호스트), SubagentStop 종료 코드, 남은 프로세스가 잡은 worktree, 손자 프로세스 시간 초과, 잠금 회수·중단된 적용, CRLF 원장, 깨진 설정에서의 복구 도구, 테스트 단계 scope, 병렬 질문 번호, pre-commit hook 추가 파일, 키 경로 표기, 한글 경로를 다룬다. 문서 9개의 로컬 링크 122개는 모두 존재한다.

Git·파일 시스템·프로세스 종료·worktree 잠금은 실제로 실행했다. 다른 호스트 실행은 자동 검사에서 가짜 실행 파일(`CODE_AGENT_*_BIN`)이고, 실계정 실행은 위 실측에 한정한다. 명령·로그 해시는 [증거 JSON](evidence/coexistence-cross-2026-10-06.json)에 있다.
