# Codex 단건 Git 권한 — 셸 꼴 안내·cmd 래퍼·현재 폴더 가림 차단

구현 커밋: `4dd40da`.

## 문제

- [Codex 실행 준비 판정](2026-10-22-codex-readiness.md) 검증의 실제 Codex 평가에서 모델은 PowerShell 로 `code-agent start …`를 부른 뒤 .ps1 실행 정책에 막혔다고 보고하고 `"C:\\WINDOWS\\system32\\cmd.exe" /c 'code-agent start …'`로 다시 시도했다. 샌드박스가 `.git/index.lock`을 거부했고, 그 명령의 단건 권한 요청은 `gitOperationCommand`가 받지 않는 셸(cmd)이라 자동 거절돼 실행이 `blocked`로 끝났다.
- 감독의 Codex 세션 지침(`developer_instructions`)에는 PowerShell 에서 `code-agent.cmd`를 쓰라는 안내가 없었고, 공용 규칙 '`code-agent` 명령은 `code-agent` 로 부른다'가 프로젝트 지침(`CODEX.block.md`)의 같은 안내와 글자 그대로 충돌했다.
- 자동 거절은 결과에 명령 없이 '호스트 실행 권한이 거절·취소되었습니다'로만 남아 사람의 거절과 구분되지 않았다.
- 검토 중 확인한 기존 결함: 래퍼 셸을 이름(basename)으로만 판정해 `.\powershell.exe`·저장소 안 `tools\powershell.exe`도 받았다. Windows 의 cmd(npm 의 `code-agent.cmd` shim 이 `node`를 찾을 때 포함)와 Node 의 자식 실행(`code-agent`가 부르는 `git`)은 PATH 보다 현재 폴더를 먼저 찾으므로, 이미 받던 PowerShell `code-agent.cmd` 꼴도 저장소 루트의 `node.cmd`·`git.exe`로 바뀔 수 있었다. `splitCommandArgs`는 U+3000·NBSP·VT 등을 공백으로 나누지만 cmd 는 명령 이름의 일부로 읽어, 사람이 보는 명령과 실제로 찾는 파일이 달라질 수 있었다.

## 변경 범위

현재 계약은 [흐름도](../process-flow.md) §5.4·§7, [대시보드 응답](../dashboard-interactions.md#codex-git-실행-권한), [master 연동](../master-control.md) §11, [Codex 연동](../codex.md)에 있다. 여기에는 바뀐 자리만 적는다.

- `master/codexPermissions.ts` `gitOperationCommand`: 래퍼 표(`WRAPPERS`)에 `cmd.exe`·`cmd`(깃발 `/d`·`/s`·`/q`, 명령 깃발 `/c`)를 더했다. 래퍼 셸은 맨 이름이거나 알려진 설치 경로(목록은 [대시보드 응답](../dashboard-interactions.md#codex-git-실행-권한))와 대소문자 무시로 같아야 한다 — 하위 폴더 전체를 받지 않는다(아래 설계 판단). Codex 가 큰따옴표 안 역슬래시를 겹쳐 보내므로 `resolve`로 접어 대조한다. UNC 경로는 받지 않는다. 공백·탭 밖의 공백 문자와 제어 문자, cmd 이스케이프 `^`도 받지 않는다.
- 같은 파일 `shadowingExecutable`: Windows 에서 저장소 루트에 `code-agent`·`node`·`git` 이름의 실행 파일(PATHEXT·`.com`·`.exe`·`.bat`·`.cmd`)이 있으면 `permissionUnavailable`이 요청 발행과 전달 직전 모두 거부하고 파일 이름과 지울 것을 알린다.
- `master/supervisor.ts`: Windows 의 Codex 실행 환경(`hostEnv`)에 `NoDefaultCurrentDirectoryInExePath=1`을 넣고 PATH 의 빈·상대·`\\?\`·`\\.\`·저장소 안 항목을 지운다. app-server 인자에 `shell_environment_policy.set.NoDefaultCurrentDirectoryInExePath="1"`을 더해 사용자 설정의 `shell_environment_policy`가 상속 변수를 줄여도 셸 명령 환경에 남게 한다. Codex 갈래 지침에 `POWERSHELL_COMMAND_GUIDE`(`hostText.ts`)와 `CODEX_PERMISSION_FORM`(`runGuard.ts`)을 넣고, 공용 규칙은 '(node 경로로 부르지 않는다)'로 한정했다. Claude 갈래 프롬프트는 바뀌지 않는다.
- `master/runGuard.ts` `CODEX_PERMISSION_FORM`: 받는 꼴 한 문장. 감독 지침과 세션 안내(`masterRunNote`)가 함께 쓴다. `gitOperationCommand`와 함께 맞출 중복 정의로 §1.1 master 행에 올렸다.
- `master/codexTransport.ts`·`supervisor.ts` `finalState`: 감독이 받지 않은 요청은 `permission.denied` 행에 `automatic: true`와 명령(앞 500자)을 남기고, 실행 사유를 '감독이 호스트 권한 요청을 받지 않았습니다: <받는 꼴 안내>'로 쓴다. 거절 문구에 받는 꼴(`code-agent start·verify·repro` 한 줄, Windows PowerShell 은 `code-agent.cmd …`)을 붙였다.
- `scripts/evaluate-codex-git-permission.cjs`: 실패한 실행에서도 모델이 고른 셸 명령(`commands`)과 권한 요청·거절 행(`permissionRows`)을 보고서에 남긴다.

## 설계 판단

cmd 래퍼를 받는 이유: 지침은 모델이 따르지 않을 수 있다. 같은 평가 프롬프트로 [Git 실행 권한](2026-10-20-codex-git-permission.md) 검증 때는 `code-agent.cmd`를, 실행 준비 판정 검증 때는 cmd 재시도를 골랐다. 안내만 더하면 다른 재시도 꼴에서 다시 막히므로, 내부 명령이 같은 단순 한 줄일 때는 cmd 래퍼도 받는다. 실행 정책 옵션(`-ExecutionPolicy`)과 `&` 호출은 받지 않는다 — 셸 해석을 바꾸는 꼴을 넓히지 않고 지침으로 `.cmd` 꼴을 알린다.

현재 폴더 검색을 환경으로 끄는 이유: 위험은 cmd 문자열 해석이 아니라 실행 파일 검색 순서다. PowerShell 자체는 현재 폴더에서 명령을 찾지 않지만 그 아래 `.cmd` shim(cmd)과 Node 의 자식 실행은 찾는다. 셸 꼴 판정으로는 막을 수 없고, 저장소 루트는 `workspace-write` 샌드박스가 쓸 수 있는 자리다. 그래서 감독 환경과 Codex 셸 정책 두 곳에 변수를 두고, 변수가 무력해지는 PATH 항목(상대·저장소 안)을 지운다. 루트 가림 파일 검사는 판정과 실행 사이에 파일이 생기는 경우를 막지 못하므로 보조 방어다.

셸 경로를 정확한 목록으로 둔 이유: `SystemRoot`·`Program Files` 하위 전체를 받으면 `C:\WINDOWS\Tasks`·`tracing`처럼 일반 사용자가 쓸 수 있는 폴더의 같은 이름 파일을 받는다. 맨 이름은 받는다 — 지침의 꼴이고, 그 해석은 Codex 가 시스템 검색 경로로 한다.

cmd 의 `/d`(AutoRun 끄기)는 요구하지 않는다. 실제 요청에 `/d`가 없었고, AutoRun 은 사용자 레지스트리 설정이라 샌드박스 안의 모델이 바꿀 수 없다.

반박 검토(하위 에이전트 3개 — cmd 수용 안·지침 안내 안·기존 결함)의 지적 가운데 현재 폴더 가림(cmd 수용, 이미 받던 `code-agent.cmd` 꼴의 shim `node` 검색, `code-agent`가 부르는 `git`), 공백 문자, 셸 이름 판정과 `SystemRoot` 하위 전체 허용 초안, 공용 규칙 충돌, 자동 거절 기록은 위 문제·변경 범위·설계 판단대로 반영했고, 평가는 수정 뒤 3회 돌렸다(아래). 반영하지 않은 것은 `/d` 필수화(위 설계 판단)와 평가에 미끼 `node.cmd`를 두는 안이다 — 루트 가림 검사가 요청을 거부하므로 승인 실행까지 가지 않고, 시험(`codexPermissions.test`)으로 거부를 확인했다. 실패 실행에서 cmd 꼴이 hook 판정을 어떻게 지났는지는 확인하지 않았다(아래 범위).

## 검증

Windows 11·Node 24.19.0·codex-cli 0.163.0, 기준 커밋 `53aca6a`.

실험(스크래치 저장소, 실제 cmd·PowerShell·Node):

- 현재 폴더에 `code-agent.cmd`를 둔 `cmd /c code-agent …` — 변수가 없으면 그 파일이 실행되고, 변수=1이면 PATH 의 실제 shim 이 실행됐다.
- npm shim 사본(`node.exe`가 shim 옆에 없을 때 `node`를 찾는 꼴) — cmd·PowerShell 어느 쪽으로 불러도 변수가 없으면 현재 폴더의 `node.bat`, 변수=1이면 실제 Node.
- Node `spawn("git")` — 변수가 없으면 현재 폴더의 `git.exe`(다른 실행 파일 사본)가, 변수=1이면 실제 Git 이 실행됐다.
- PowerShell `-Command "cafake …"`는 변수 없이도 현재 폴더 파일을 실행하지 않았다.
- app-server `config/read`가 `-c shell_environment_policy.set.NoDefaultCurrentDirectoryInExePath="1"`을 `set`에 반영했다.

실제 Codex(`scripts/evaluate-codex-git-permission.cjs`, 실제 모델 호출, 합성 대시보드 승인 — 사람 승인 아님, Claude 세션 변수와 `NoDefaultCurrentDirectoryInExePath`를 뺀 환경에서 실행):

- 수정 뒤 3회 모두 통과([근거 JSON](evidence/2026-10-23-codex-git-wrapper.json)의 `live.evaluations`). 세 실행 모두 모델이 처음부터 `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'code-agent.cmd start doc/work/CONSENT-1/requirement.md'`를 썼고, 샌드박스 실패(exit 1) → 단건 권한 요청 1건 → 합성 승인 → 원래 호출 실행(exit 0) → 작업 `CONSENT-1`·브랜치 `feature/CONSENT-1`, hook `sessionStart`·`userPromptSubmit`·`preToolUse` 3회·`stop`, 자동 거절 0건이었다.
- 평가 스크립트가 모델을 부르기 전 접수 준비에서 멈춘 실행 2회는 세지 않았다 — 실행한 터미널에 Claude 세션 변수가 남아 접수가 '이 호스트(Claude Code)는 설치 기록에 없다'로 거부됐고, 변수를 빼고 다시 돌렸다.
- 환경 전달: 같은 감독 경로로 Codex 에 `cmd.exe /d /c set NoDefaultCurrentDirectoryInExePath`를 실행하게 해(권한 상승 없음) 출력 `NoDefaultCurrentDirectoryInExePath=1`을 받았다 — 실행한 터미널에는 이 변수가 없었다.

집중 시험: `codexPermissions`·`masterCodex` 21개 통과. cmd 래퍼(깃발·인자 수), 공백 문자 거부, 겹 역슬래시 원문 허용과 `Tasks`·`tracing`·UNC·저장소 경로 거부, 루트 `code-agent.cmd`·`Code-Agent.BAT`·`node.cmd`·`git.exe` 가림의 발행 거부와 전달 취소, 자동 거절 결과(`MODE=permission-unsupported` 모의 호스트), Codex 지침의 안내·받는 꼴과 Claude 프롬프트에 `code-agent.cmd`가 없음, `shell_environment_policy` 인자, `hostEnv` 변수·PATH 정리. 기준 커밋 빌드로 새 시험을 돌려 수정 전 실패를 확인하지는 않았다.

전체 회귀(`npm test`와 같은 단계, 동시 실행 3·격리 `CODE_AGENT_HOME`): 1,741개 중 1,737개 통과, 실패 0, 플랫폼 생략 4개, 약 1,610초.

## 확인하지 않은 범위

- 승인받아 샌드박스 밖에서 도는 실행의 자식 환경에 변수가 실리는지는 직접 보지 않았다. 샌드박스 안 셸 명령에서만 확인했다.
- 루트 가림 검사와 실제 실행 사이에 파일이 생기는 경우(판정 시점과 실행 시점의 차이) — 환경 변수가 1차 방어다.
- 맨 이름 셸을 Codex 가 어떻게 찾는지(Codex 내부 해석).
- 실행 준비 판정 검증 때 실패한 실행의 cmd 재시도가 PreToolUse hook 판정을 어떻게 지났는지, .ps1 실행 정책 차단(모델 보고 — 이 PC 정책은 `RemoteSigned`)의 실제 원인.
- 수정 뒤 실제 평가에서 모델이 cmd 꼴을 고른 실행이 없어, cmd 래퍼 수용은 시험으로만 확인했다.
