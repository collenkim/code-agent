# Codex 연동

code-agent의 접수·분석·설계·계획·구현·검증·리뷰·통합 절차를 Codex에서도 사용한다. 단계와 증거 판정은 Claude와 같은 CLI가 담당하고 설치 파일·도구 입력·사용자 응답 관찰만 호스트별로 처리한다.

## 설치와 시작

```sh
code-agent init --host codex
code-agent doctor --host codex
codex
```

Codex 대화에서 `$ca-request <요구사항>`으로 시작한다. 중단한 작업은 `$ca-status`, `$ca-next`로 이어간다. 다른 단계도 같은 이름의 `$ca-*` 스킬을 사용한다. 스킬 호출을 입력하는 곳은 대화창이며 셸이 아니다.

Claude도 함께 사용할 프로젝트는 `code-agent init --host both`로 설치한다. 두 호스트를 함께 쓰는 목적은 **교차 검증**이다 — 같은 작업을 동시에 진행하지 않고, 계획 반박 검토와 코드 리뷰를 다른 호스트의 모델이 한 번 더 본다(`planning cross`·`review cross`). 두 호스트를 모두 실행할 수 있을 때만 쓴다 — 다른 호스트를 실행할 수 없으면(미설치·로그인·사용 한도·장애) 그 지점의 교차 검증은 중지로 기록하고 작업은 진행한다. 실행 파일 변수(`CODE_AGENT_*_BIN`)가 없는 파일을 가리키거나 PATH 에 셸 스크립트만 있으면(단일 실행 파일에서 변수가 가리킨 `.js`를 돌릴 `node`가 PATH 에 없을 때도) 실행 불가가 아니라 설정 오류라 그 지점의 게이트가 막힌다 — 사람이 고친 뒤 다시 실행하고, 고칠 수 없으면 사람이 중지를 정한다. `init`·`status`·`doctor` 가 지금 쓸 수 있는지와 어느 쪽인지 알린다(`doctor` 는 설정 오류를 막는 문제 `✗` 로 센다). Codex 메인에서 교차 명령은 샌드박스 밖(권한 상승)으로 실행한다 — 다른 호스트를 띄우고 네트워크를 쓴다. 샌드박스 안이면(셸에 샌드박스 표지가 있고 연결 확인이 `EACCES`·`EPERM`으로 거부되면) CLI 가 실행 전에 멈추고 안내한다(`CODE_AGENT_CROSS_PREFLIGHT=off` 로 사람이 끌 수 있다). 셸에 샌드박스 표지가 없어도 `--by claude` 의 네트워크 오류는 같은 지점에서 몇 번째든 중지가 아니라 샌드박스 거부로 보고 게이트를 막는다 — Codex 표지가 없는 셸(사람의 터미널)에서 다시 실행해도, 그 지점을 Codex 에서 부른 적이 있으면 같다. 첫 번째는 권한 상승을 안내하고, 권한 상승 뒤에도(샌드박스 안이라 실행 전에 멈춘 뒤 권한 상승한 첫 실행 포함) 같으면 실제 네트워크 문제일 수 있으므로 사람이 네트워크를 확인해 다시 실행하거나 중지(`judgment cross-stop`)를 정한다. 그때 게이트 줄은 실행 명령을 앞세우지 않고 '사용자가 네트워크를 확인한 뒤 다시 실행할 명령'으로 뒤에 싣는다. 모델이 혼자 중지를 기록하지 않는다. Claude 메인이 부른 codex 의 네트워크 오류와, 네트워크가 아닌 실행 불가(미설치·로그인·사용 한도·장애)는 위처럼 중지로 기록하고 진행한다. 상세는 [설계 — Claude·Codex 교차 검증](design.md#claudecodex-교차-검증). 기존 Claude 프로젝트에 `--host codex`만 추가해도 Claude 설정은 보존된다. 설치 이력이 없는 프로젝트에서 `--host`를 생략하면 Claude를 설치한다. 이후 `init`·`update`·`doctor`는 `.code-agent/hosts.json`에 기록된 호스트를 대상으로 한다. `--host claude|codex|both`로 명시할 수도 있다.

| 설치 대상 | Codex 경로 |
|---|---|
| 스킬 18개 | `.agents/skills/ca-*/SKILL.md` |
| 역할 8개 | `.codex/agents/ca-*.toml` |
| 훅 6종 | `.codex/hooks.json` |
| 프로젝트 지침 | `AGENTS.md`의 code-agent 표시 블록 |
| 설치 이력 | `.code-agent/hosts.json`, `.code-agent/version` |

기존 `AGENTS.md`의 표시 블록 밖 내용, 다른 훅, `.codex/config.toml`의 선택 UI 관리 블록 밖 설정은 보존한다. 스킬과 역할 파일은 번들 사본이므로 갱신하면 덮어쓴다. 프로젝트 규칙은 `AGENTS.md`의 블록 밖이나 프로젝트 문서에 둔다. 역할마다 제품 기본 모델·추론 강도를 명시하며 사용자의 역할별 변경값은 갱신 뒤에도 유지한다.

설치 후 Codex 대화형 세션에서 이 저장소를 열어 프로젝트를 신뢰하고, 'Hooks need review' 화면에서 프로젝트 훅을 검토·신뢰한다. Codex 는 프로젝트 신뢰(`config.toml`의 `[projects.'<경로>'] trust_level = "trusted"` — Windows 는 경로를 소문자로 적는다)와 훅 신뢰가 둘 다 있어야 프로젝트 훅을 돌리고, `codex exec`는 신뢰되지 않은 훅을 알리지 않고 건너뛴다(0.161.0 실측). `.codex/hooks.json`이 바뀌면(갱신 뒤) 다시 검토한다. 자동으로 신뢰 설정을 바꾸지 않는다. `doctor --host codex`는 `config.toml`을 읽기만 해 `Codex 프로젝트 신뢰`(이 저장소의 `trust_level` — 상위 폴더 항목만 있으면 Codex 가 그것을 이 저장소에 적용하는지 확인하지 못해 '확인 필요')와 `Codex 훅 신뢰`(훅 신뢰 기록 — 기록의 키 꼴을 확인하지 못해, 찾지 못하면 '확인 필요')를 알린다. 호스트가 훅을 무시하거나 설치된 역할을 선택하는 서브 에이전트 호출을 지원하지 않으면 관찰 결과가 없어 계획·리뷰 게이트를 통과할 수 없다. `doctor`는 설치 파일과 명령을 검사하며 실제 훅 실행·모델 실행 성공을 인증하지 않는다. 2026-10-02 추가 검사는 `codex-cli 0.160.0`에서 수행했다. 앞선 0.159.3 기능 조회와 구분하며 지원 최소 버전으로 단정하지 않는다. 이 검사(Windows, 실제 모델 `gpt-6.1-sol`, 초기 준비·요구 확정은 합성 fixture)에서 분석·통합 영향도 담당의 시작·완료 훅 호출, 결과 수락, 내용 게이트 통과를 확인했다. 접수부터 반영까지의 전체 흐름은 실제 Codex 로 확인하지 않았다. 기록은 `git show 2c97a43:doc/reviews/2026-10-02-codex-hook-recovery.md`로 보고, 지금 구현에서 실제 호스트로 확인하지 않은 것은 [결과 요약](reviews/2026-10-08-procedure-fix-summary.md#실제-호스트에서-확인하지-않은-것)에 있다.

공식 설치 형식은 [로컬 스킬](https://learn.chatgpt.com/docs/build-skills), [커스텀 에이전트](https://learn.chatgpt.com/docs/agent-configuration/subagents), [훅](https://learn.chatgpt.com/docs/hooks)을 참고한다.

## 동작과 검증

계획의 `planning advance [--chain]`(출력의 `next` 줄이 다음 행동), 요약 `planning status`, 상세 `planning result <ID>`, 형식 교정 `planning repair <ID>`는 Claude와 같은 구현을 사용한다. Codex 스킬도 같은 배정·대기·차단·게이트 준비 상태와 1회 교정 절차를 제공한다.

소규모 impact 통합·역할별 입력·동일 결과 재사용도 같은 구현과 생성 템플릿을 사용한다. Codex에서는 통합 조사에 `ca_explorer`를 호출한다. 독립 critic과 승인 절차는 유지한다. [선택 기준](planning.md#위임-수와-입력-범위-선택)을 따른다.

배정의 `agent`와 `hostAgents.claude`는 `ca-analyst` 꼴 이름이다. Codex는 `hostAgents.codex`의 `ca_analyst`처럼 밑줄 이름으로 호출한다. 모든 Codex 역할의 TOML `name`과 스킬의 호출 지침을 변환하며, 훅에서는 공통 역할로 연결한다. 기존 설치를 갱신할 수 있도록 역할 파일 경로 `.codex/agents/ca-analyst.toml`은 유지한다. 스킬 이름 `ca-analyze`는 역할 이름과 별개다.

| 이벤트 | code-agent 처리 |
|---|---|
| PreToolUse | 셸 명령과 패치의 모든 추가·수정·삭제·이동 전후 경로, MCP 도구(`mcp__서버__도구`)의 로컬 경로 인자를 기존 쓰기·읽기 게이트에 대조. 허용한 동의 준비·적용 명령과 `code_agent.confirm`은 이 세션의 티켓을 남긴다. 판정하지 않는 그 밖의 도구 이름은 작업·세션 중에만 `.code-agent/log/codex-tools.json`에 세고 doctor 가 알린다(하위 에이전트 조율 도구 `collaboration…`은 세지 않는다). 하위 에이전트 안의 호출은 `agent_id`·`agent_type`을 싣는다 — 읽기 전용 담당(critic·reviewer, surveyor 는 초안 자리 `doc/.survey/` 밖)의 쓰기·진행 명령과 실행 중인 계획 담당의 파일 쓰기를 거부한다 |
| UserPromptSubmit | 준비된 확인 요청에 대한 명시적 사용자 메시지(확인 코드 포함)를 동의 기록에 연결. 그 밖의 메시지는 기록하지 않는다(업무 답 관찰 없음) |
| SubagentStart | 계획 담당·독립 리뷰어의 세션과 실행 ID 관찰 |
| SubagentStop | 호스트가 전달한 최종 응답을 배정·입력 해시·근거·출력 계약·문서 검사에 대조. 실패는 되돌리지 않고 기록하며 판정 실패도 `{}`·exit 0으로 통과시킨다(사유는 stderr) |
| Stop | 계획 밖 변경·미결 질문 검사와 필요한 후속 안내. 목록은 10줄까지 싣고, 같은 세션에서 같은 사유로 이미 막았으면 다시 막지 않는다 |
| SessionStart | Claude 와 같은 진행 상태 요약(작업·스테이지·실행 중 계획 배정·압축 뒤 ca-answer 다시 읽기)을 `additionalContext`로 붙이고, 작업 임대를 이 세션으로 넘겨받는다(대화 압축 제외 — Claude 와 같은 규칙). codex-cli 0.162.1 은 수동·자동 압축 뒤에도 이 훅을 부른다 |

여섯 이벤트는 `code-agent codex-event` 하나로 들어온다. Codex의 셸 훅은 `Bash`와 `tool_input.command`를 사용하고(Windows 에서도 같다 — 스크립트는 PowerShell, 0.161.0 실측. 권한 상승 여부는 PreToolUse 입력에 없고 PermissionRequest 에만 있다), 패치는 `apply_patch`의 `command`를 사용한다. 패치 일부라도 금지 경로이면 호출 전체를 거부한다. 판정 대상은 셸·패치와 MCP 도구(`mcp__*`)의 경로 인자이며, 그 밖의 도구는 판정하지 않고 이름만 기록한다(위 표). Codex 는 hook 의 exit 2 와 stderr 사유를 막음으로 받는다(0.161.0 — PreToolUse·UserPromptSubmit 은 실제 호출로 확인). code-agent 는 PreToolUse 판정 실패를 거부 응답으로 막고(입력을 읽지 못해도 같다) exit 2 는 판정 전 프로세스 실패의 닫힘으로만 쓴다 — PreToolUse 항목만 비Windows 명령을 `… codex-event || exit 2`로 설치해 판정 전에 프로세스가 죽어도 막는다. Windows 용 `commandWindows`는 Codex 가 `powershell.exe -NoProfile -Command`로 돌리고 Windows PowerShell 5.1 이 exit 2 를 1 로 바꾸므로, PreToolUse 는 `cmd /c code-agent codex-event; if ($LASTEXITCODE -ne 0) { exit 2 }`, UserPromptSubmit 은 `cmd /c code-agent codex-event; exit $LASTEXITCODE`, 나머지는 `cmd /c code-agent codex-event`로 설치한다(`cmd /c`는 실행 정책 Restricted 에서 막히는 npm 의 `code-agent.ps1` 대신 `.cmd`를 고른다). 이전 버전으로 설치한 저장소는 `code-agent update --templates-only --host codex`로 이 꼴이 된다 — 옛 꼴이면 doctor 가 그 이벤트 줄을 `✗`로 알린다(`commandWindows`가 없어도 Codex 가 돌리는 `command`가 이 꼴과 같은 이벤트 — `--cli` 설치의 Stop·Subagent·SessionStart — 는 알리지 않는다). UserPromptSubmit 판정 실패는 동의 응답(`code-agent consent respond`로 시작하는 메시지)만 막고 사유를 보이며, 그 밖의 사용자 메시지는 막지 않는다. `codex exec`에서는 hook 거부가 출력에 드러나지 않는다 — 동의 응답이 막히면 사유 없이 `turn.completed`(사용량 0)만 남고, PreToolUse 가 거부한 명령은 이벤트에 없이 모델 답(`Command blocked by PreToolUse hook: <사유>`)으로만 보인다(0.161.0 실측). exec 로 동의 응답을 보냈으면 `consent status`로 기록됐는지 확인한다. Stop 판정 실패는 Claude와 같이 턴을 막지 않는다. 하위 실행 transcript는 파싱하지 않고 `last_assistant_message`만 결과로 받는다. 담당은 `SubagentHandback` 대신 최종 응답으로 계약에 맞는 JSON 또는 리뷰 지적을 반환한다.

전용 Read 도구가 없는 Codex에서는 `code-agent read <파일> [시작 줄] [줄 수]`로 파일을 읽는다. 머리 한 줄(`<경로> · <시작>-<끝> / 전체 N줄`)과 `줄번호<탭>본문`을 내고, 남은 줄이 있으면 `(이어서: code-agent read <경로> <다음 줄>)`을 붙인다. 기본 200줄·최대 400줄이다. 저장소 안의 1 MB 이하 텍스트만 허용하고 연결 경로를 통한 저장소 밖 접근도 거부한다. 연결자 없이 쓴 이 명령은 상태·설정을 읽지 못한 때(깨진 `code-agent.json` 의 원인 확인)와 세션 밖에서 hook 설정 파일을 읽을 때도 열린다 — hook 의 거부 문구도 Codex 에서는 `code-agent read`·`apply_patch` 로 안내한다. 일반 셸 읽기·연결 명령을 허용하도록 게이트를 풀지 않는다.

Codex 셸의 환경 표지와 네트워크(Windows, codex-cli 0.161.0 실측) — 교차 명령의 사전 판정과 지금 호스트 판별이 이 값에 기댄다.

| 셸 | `CODEX_SANDBOX_NETWORK_DISABLED` | `CODEX_SANDBOX` | 네트워크 |
|---|---|---|---|
| workspace-write | `1` | 없음 | 막힘 |
| read-only | `1` | 없음 | 막힘 |
| 권한 상승(승인한 `require_escalated`) | `1` | 없음 | 됨 |
| danger-full-access · bypass | 없음 | 없음 | 됨 |

모든 셸에 `CODEX_CI=1`·`CODEX_THREAD_ID`(= `CODEX_SESSION_ID`)·`CODEX_VERSION`·`CODEX_MANAGED_BY_NPM`·`CODEX_MANAGED_PACKAGE_ROOT`가 있어 지금 호스트는 언제나 codex 로 판별된다. 샌드박스 셸의 연결은 `connect EACCES`로 거부되고, 그 안에서 띄운 claude 는 `ECONNREFUSED`로 약 3분 재시도한 뒤 네트워크 오류로 끝난다. 표지만으로는 권한 상승 셸을 가르지 못하므로 CLI 는 claude 를 띄우기 전에 연결을 한 번 확인한다(`EACCES`·`EPERM`일 때만 멈춘다).

Windows 자동화에서 프로젝트 신뢰 키는 호스트 네이티브 경로(`C:\...`)를 유지한다. `codex-cli 0.160.0` 검증 환경에서는 이를 `/`로 바꾸면 프로젝트 훅이 호출되지 않았다. 하위 에이전트를 사용하는 실제 검증에는 부모 기록이 필요한 만큼 `--ephemeral`을 사용하지 않는다.

계획 작업은 [계획 작업 문서](planning.md)의 의존성·동시 실행 한도·같은 입력 재사용·재시도(같은 입력 실패 3회·작업별 총 배정 6회)·미결 질문·질문 출처·자동 되감기 규칙을 그대로 따른다. 다만 Codex 담당은 exit 2로 되돌리지 않고(Codex 의 SubagentStop 되돌림은 확인하지 않아 쓰지 않는다) 형식·식별·내용 검사 실패를 즉시 기록한다. Codex 의 SessionStart 훅은 Claude 와 같이 실행 중으로 기록된 배정과 (대화를 새로 열었거나 재개·분기·비웠으면) 취소 명령을 진행 상태에 붙인다. 훅 출력이 없는 경우(신뢰하지 않은 훅·옛 Codex)에는 시작이 관찰되지 않은 배정만 `planning advance`의 `stale` 판정(10분)과 `cancel` 목록에 잡히고, 시작이 관찰된 담당은 60분 동안 `wait`로 보인다. 그래서 대화를 새로 열어 재개할 때는 `$ca-next` 절차대로 `planning status`의 실행 중 배정을 확인하고, 이 대화에서 부른 담당이 아니면 `planning cancel <ID>` 뒤 advance 한다. 프로그램 노드는 CLI로 실행하고 추론 노드만 담당에게 넘긴다. 기준 커밋에는 Codex 설치 파일과 호스트 이력이 포함된다. `.agents/`·`.codex/`는 탐색 입력 범위에서 제외하고 모델의 직접 설정 변경도 거부한다.

훅은 작업 절차의 오류를 줄이는 장치다. 호스트가 관찰하지 않는 도구나 외부 프로세스까지 완전히 통제하는 OS 보안 경계는 아니다. 두 호스트를 같은 작업에 동시에 사용하지 않는다 — 작업 임대(`.code-agent/lease.json`)가 막는다. 진행 명령·쓰기를 처음 한 세션(호스트)이 임대를 잡고, 다른 세션의 진행 명령·쓰기는 PreToolUse 가 거부한다(조회·읽기는 연다). 두 호스트 모두 호스트와 세션을 비교한다 — 하위 에이전트의 훅은 부모 `session_id`를 싣고, 재개(Claude `--resume`·`--continue`, Codex `resume`)도 같은 `session_id`다(실측). 그래서 두 터미널이 같은 세션을 이어 열면 임대는 둘을 한 주인으로 본다. 세션 시작(SessionStart — 두 호스트)은 같은 호스트 임대를 넘겨받아 재시작·`/clear`가 막히지 않는다(대화 압축은 같은 세션이라 넘겨받지 않는다 — 압축된 이전 세션이 새 세션의 임대를 되찾지 않는다). 다른 호스트로 옮겨 이어가려면 저쪽 작업을 멈춘 뒤 사용자 확인을 받아 `code-agent takeover`로 넘겨받는다(마지막 활동 뒤 30분이 지나면 자동으로 넘어간다). `takeover`는 모델이 부를 수 있는 명령이라 사용자 확인을 코드가 강제하지 않는다 — 임대는 모르는 사이의 동시 진행을 막는 사고 방지 장치이고, 넘겨받기 전 확인은 `ca-next` 재개표 규칙이다.

CLI·hook 의 안내 문구(`다음:`·거부 사유)는 호스트 표기로 나온다 — 스킬은 `$ca-x`, 서브에이전트는 `ca_x`, 질문 도구·셸·파일 도구도 Codex 이름이다. 표기는 `CODE_AGENT_HOST`(사람이 셸 설정으로 고정하는 표기 전용 값 — 교차 거부·임대 판정에는 쓰지 않는다) → `.code-agent/hosts.json`(설치 호스트가 하나면 그것) → 실행 환경 표지(`CLAUDECODE`·Codex 표지, 두 호스트 표지가 함께 보이면 판별하지 않음) → 중립 `/ca-x($ca-x)` 순으로 정한다. Codex hook(`codex-event`)은 언제나 Codex 표기다. 파일·확인 화면에 기록되는 문자열(⑧·⑨·⑩, 원장, 동의 확인 화면)은 표기를 바꾸지 않는다.

## 사용자 확인

업무 질문은 프로젝트에 설치한 `code_agent.ask` MCP 도구로 표시한다. Default 모드에서 방향키·Enter로 선택하고, 여러 질문은 좌우 방향키로 이동한다. 질문 본문이 선택 화면 10줄(80칸 기준, 한글은 두 칸)을 넘거나 선택지가 3줄을 넘으면 폼을 열지 않고 줄이라는 오류를 돌려준다 — 긴 근거는 호출 전에 대화에 쓴다. 일반 질문 도구의 모드 제한이나 비동기 호출 접수 성공에 UI 표시를 의존하지 않는다. 받은 답의 원문은 `[Answer]:`와 `[Source]: 대화`에 기록한다. 업무 답 원장 대조는 Claude와 달리 자동 관찰하지 않는다.

1. 메인이 같은 세션의 셸에서 `consent prepare --action <동작> … --for codex` 또는 `consent prepare <파일> --for codex`로 실행 대상과 질문을 준비한다.
2. 요약 전문을 보여 주고 `code_agent.confirm`에 반환된 `id`만 전달한다. MCP 도구 실행 허용은 프로젝트 동의와 별개다.
3. PreToolUse가 준비 세션을 대조하고 일회용 질문 티켓을 발급한다. 서버가 저장된 질문으로 폼을 열고 사용자 선택을 직접 받는다. 폼은 화면 높이를 넘는 본문을 스크롤 없이 자르므로 질문에는 요약 앞부분·생략 줄 수·전문 파일(`.code-agent/consents/confirm-<내용 해시>.md`) 경로만 싣고, 폼 안내 문구에 요약을 다시 넣지 않는다. 번호·확인 코드 복사는 요구하지 않는다. Esc·취소는 보류이며 자동 승인하지 않는다.
4. 서버는 폼 표시 전후에 세션·호출·질문·대상 해시를 검증한다. `approved`가 반환되면 메인이 같은 턴에 `consent finish <ID>`로 적용하고 `next`대로 이어간다. 원장 출처는 `codex-elicitation`이다.

다른 세션·서브 에이전트·미리 넣은 답·질문 밖 응답·내용 변경·연결 종료는 승인하지 않는다. 이 처리는 신뢰하는 로컬 MCP 클라이언트와 hook의 관찰이며 사용자 신원 증명은 아니다. 서버에는 답을 전달하는 별도 도구나 CLI 옵션이 없다. 이미 실패한 동의는 새로 준비한다.

`init --host codex`와 `update --templates-only --host codex`는 프로젝트 `.codex/config.toml`의 관리 블록에 선택 UI 서버를 등록한다. 블록 밖 사용자 설정과 전역 설정은 유지한다. Codex를 다시 열어 프로젝트·hook을 신뢰해야 한다. `doctor`는 MCP 설치 누락을 점검하며, 실제 UI 표시는 대화형 Codex에서 확인한다. MCP 폼 미지원·도구 오류는 원인을 알리고 복구하며 번호 나열을 UI 완료로 보고하지 않는다. 비대화형 `codex exec`는 UI 검증 수단이 아니다.

`code-agent consent respond <ID> <번호들> <확인 코드>`와 UserPromptSubmit 관찰은 사용자가 명시적으로 요청한 대화 입력 호환 경로다. 이 경로는 `codex-prompt` 출처를 유지한다. 훅을 사용할 수 없다면 사람이 터미널에서 직접 `confirm`·`approve`·`deliver`를 실행할 수 있으나 계획·리뷰의 실행 관찰 요구는 유지한다.

## 갱신·제거·지원 범위

현재 번들만 적용할 때는 `code-agent update --templates-only [--host codex]`를 사용한다. Git 소스 설치는 `code-agent update [--host codex]`로 소스·빌드·적용·점검을 진행한다 — 호스트 밖의 터미널(TTY)에서 미리보기를 보고 `update`를 입력해야 실행되고, 비TTY·호스트 셸(Codex·Claude Code 표지가 있는 셸)에서는 멈춘다. 대화 안에서는 `ca-answer`의 `update` 동의를 쓴다. 세션이 없어도 모델 셸의 소스 `update`(`--templates-only` 제외)는 훅이 거부한다. 양쪽을 설치하고 `--host`를 생략하면 둘 다 갱신한다. `--cli` 개발용 경로도 호스트별로 승계한다. 갱신으로 `.codex/hooks.json`이 바뀌면 Codex 를 다시 열어 'Hooks need review' 화면에서 다시 검토·신뢰한다. CLI 만 새 버전이고 `.codex/hooks.json`에 SessionStart 가 없는 옛 설치는 새 Codex 세션이 임대를 넘겨받지 못한다 — 이전 세션의 마지막 활동 뒤 30분 안에 새 세션의 첫 진행 명령이 '다른 세션이 이 작업을 진행 중'으로 거부되고 `takeover`가 필요하다. `code-agent update --templates-only --host codex`로 SessionStart 를 설치한다(doctor 가 `Codex SessionStart: 설치되지 않았습니다`를 `✗`로 알리고 같은 명령을 안내한다 — 진행 중인 작업이 있으면 `.codex/hooks.json`을 다시 쓰는 것이 그 작업의 계획 밖 변경이 되므로 작업이 끝난 뒤로 미룬다).

제거할 때는 본 제품이 설치한 `.agents/skills/ca-*`, `.codex/agents/ca-*.toml`, `AGENTS.md` 표시 블록, `hooks.json`의 `code-agent codex-event` 항목과 `.codex/config.toml`의 `# code-agent:choices:start`부터 `# code-agent:choices:end`까지의 관리 블록만 제거한다. 다른 사용자 설정을 포함한 디렉토리 전체를 지우지 않는다. 양쪽 중 Codex만 제거했다면 `.code-agent/hosts.json`에서 `codex`만 빼고 `claude`를 남긴다.

모든 호스트를 제거했다면 `hosts.json`도 제거한다. 빈 배열로 남기지 않는다. 작업 문서와 증거 보존 여부는 별도로 결정한다.

`code-agent usage`는 Codex 설치면 Codex 세션 기록(`$CODEX_HOME/sessions`, 없으면 `~/.codex/sessions` 아래 `rollout-*.jsonl`)에서 이 저장소의 세션을 골라 스테이지별·에이전트별 토큰(입력·캐시 입력·캐시 쓰기·출력·추론 출력)·요청·도구 호출·도구 결과 글자와 `code-agent` 명령별 호출·파일 변경 수를 센다. 형식은 codex-cli 0.161.0 의 실제 기록으로 확인했다 — 토큰은 응답마다 한 줄인 `token_usage_record`(없는 기록만 `token_count`)로, 셸 명령은 `CommandExecution` 항목(`powershell.exe -Command` 같은 래퍼는 벗긴다)으로 센다. 하위 에이전트 기록(`ca_explorer` 같은 담당, 승인 검토 `guardian`)은 따로 행을 두고, 그 앞머리에 복사된 부모 대화는 세지 않는다. 모르는 줄은 버리고 0으로 센다. 단가표가 없어 비용은 산정하지 않는다(호스트 화면에서 확인한다).

메인 컨텍스트 절감은 두 호스트가 같다. Codex 계획 담당도 출력 문서와 결과 파일(`result.json`)을 배정의 staging 경로에 `apply_patch`로 쓰고 최종 응답은 `결과: <경로>` 한 줄이며, 결과 JSON의 `artifacts`에는 `{path, staged}`만 넣는다 — 훅은 하위 에이전트 입력의 `agent_id`·`agent_type`(0.161.0 실측)으로 실행 중인 그 배정의 담당에게만 staging 을 열고, 그 담당의 다른 파일 쓰기는 거부한다. 쓰기가 거부되면 `{path, content}`로 낸다. staging 폴더(정식 문서가 이미 있는 재배정이면 그 배정 폴더와 현행 문서 사본까지)는 샌드박스 밖인 담당 시작 훅이 만든다 — Windows 샌드박스 셸(`code-agent` 명령 포함)이 만든 폴더는 그 작업 공간에서 `apply_patch`를 처음 쓰기 전에 생기면 이후에도 `apply_patch`로 쓸 수 없다(0.162.1 실측, 첫 `apply_patch` 뒤에 생긴 폴더는 쓸 수 있다). 훅이 미리 넣은 현행 문서 사본을 Codex 담당이 `apply_patch`로 고치는 동작은 실제 호스트에서 아직 확인하지 않았다(미확인) — 거부되면 `{path, content}`로 낸다. 배정 파일(`assignmentFile`)과 `context --file` 전달도 두 호스트가 같다.

**Windows 샌드박스의 폴더 권한** — Windows Codex 샌드박스(0.162.1, `[windows] sandbox = "elevated"` 실측)는 작업 공간에서 `apply_patch`를 처음 쓰기 전에 샌드박스 셸이 만든 폴더·파일을 그 뒤에도 `apply_patch`로 쓰지 못한다(`Failed to create parent directories`·`Failed to write file`). 첫 `apply_patch` 뒤에 셸이 만든 것과 사람이 만든 것은 쓸 수 있다. staging 은 훅이 만들어 이 경우를 피하지만, 접수 폴더(`doc/work/<ID>/`)와 도입의 지식 문서 뼈대는 CLI 가 셸 안에서 만든다. Codex 로 처음 쓰는 저장소라면 아무 파일이나 `apply_patch`로 한 번 고친 뒤 시작하고, 이미 막힌 폴더는 사람이 지운 뒤 다시 만든다.

자동 검증은 합성한 호스트 이벤트, 실제 CLI 프로세스, 임시 Git 저장소의 전체 작업 흐름으로 수행한다. Codex UI의 수동 사용성·실제 사람 승인·전체 개발 흐름 실계정 측정은 자동 검증 범위 밖이다.

재현 검사는 `npm run build` 후 `node scripts/evaluate-planning-hosts.cjs codex <새-기록이름> --vetted-hooks --model gpt-6.1-sol`로 실행한다. 실제 모델 호출이 발생하며 초기 준비·요구 동의는 합성 fixture다. `--model`은 검사 메인만 바꾸고 제품 역할별 기본값은 유지한다. `--vetted-hooks`는 생성된 훅만 확인한 격리 검사에 한정한다. `--through-impact`는 분석 다음 영향도까지 실제 호출로 확인한다. 실사용 설치에서 훅 신뢰 검토를 생략하는 안내가 아니다.

실행 전에 `node scripts/diagnose-codex-hooks.cjs --standalone --native-trust-path`로 짧은 실제 훅 호출부터 확인할 수 있다. 전체 역할 실행은 부모 기록을 유지하므로 호스트에도 세션이 남는다. 문서 내용 게이트 실패는 ready-for-gate와 별개이며, 진단 결과나 관찰 기록을 대신 만들어 완료 처리하지 않는다.

## 역할별 모델 기본값과 변경

초보 사용자가 호스트의 전역 설정을 따로 맞추지 않아도 두 호스트 모두 역할 정의에 모델과 추론 강도를 명시한다 — Claude는 `.claude/agents/ca-*.md` 머리말의 `model`·`effort`, Codex는 TOML의 `model`·`model_reasoning_effort`다. 역할은 업무 성격에 따라 판단과 실행 두 등급으로 나눈다. 기본값은 다음과 같으며 모델을 자동으로 바꾸는 라우팅은 하지 않는다.

| 역할 | 등급 | Claude 모델 / 강도 | Codex 모델 / 강도 |
|---|---|---|---|
| analyst · critic · reviewer | 판단 | opus / high | gpt-6.1-sol / high |
| surveyor · explorer · writer · implementer · tester | 실행 | sonnet / medium | gpt-6.1-sol / medium |

역할별 선택 이유(원천은 `src/agent/modelPolicy.ts` `ROLE_POLICY`):

- analyst — 요구 구체화·설계 대안·계획을 판단한다 — 오판이 뒤 단계 전체로 번진다
- critic — 계획을 독립적으로 반박한다 — 여기서 놓친 결함은 그대로 승인된다
- reviewer — 구현을 독립 반박 검토한다 — 반영 전 마지막 판단이다
- surveyor — survey 표본을 읽고 근거 경로를 단 사실을 정리한다 — 확정은 사람이 한다
- explorer — 영역 코드에서 근거와 사실을 찾는다 — 해석은 판단 역할과 게이트가 검사한다
- writer — 받은 재료를 뼈대 형식으로 옮긴다 — 새 판단을 만들지 않는다
- implementer — 승인된 계획·context대로 쓴다 — check·test·review 게이트가 결과를 검증한다
- tester — 07의 TC를 그대로 구현한다 — check·test·review 게이트가 검증한다

이는 품질과 실행량을 함께 고려한 제품의 시작값이다. 실제 최적 비용·성능 조합을 입증한 벤치마크 결과는 아니다(완주 작업당 비교 방법은 [설계](design.md)의 모델 문단). 계정에서 제공하지 않는 모델이면 사용 가능한 모델을 선택해야 하며 조용히 다른 모델로 대체하지 않는다. Codex 기본 모델과 추론 강도의 근거는 [공식 커스텀 에이전트 문서](https://learn.chatgpt.com/docs/agent-configuration/subagents)다.

Claude 모델은 `opus`·`sonnet`·`haiku`·`fable` 또는 `claude-`로 시작하는 전체 ID, 추론 강도는 `low`·`medium`·`high`·`xhigh`·`max`다. haiku(`haiku`·`claude-haiku-*`), Sonnet 4.5 이하 4 세대(`claude-sonnet-4-5`·`claude-sonnet-4-0`·`claude-sonnet-4-20250514` 등), Opus 4·4.1(`claude-opus-4-1` 등), 이전 명명 체계(`claude-3-5-haiku-*`·`claude-3-opus-*` 등 `claude-<숫자>`로 시작하는 ID)는 추론 강도를 받지 않는다 — 정의 파일에 `effort:` 줄을 쓰지 않고 강도 지정을 거부한다(번들 claude-api 스킬 표: 4 세대의 effort는 Opus 4.5·Sonnet 4.6부터). 목록에 없는 새 ID는 강도를 받는 것으로 본다. 그 밖에 모델이 지원하지 않는 높은 단계(`xhigh`·`max`)는 Claude Code가 `high`로 낮춘다(바이너리 확인, 실제 호출 미확인).

```sh
code-agent model --host codex
code-agent model writer gpt-6-luna --host codex --reasoning high
code-agent model writer default --host codex
code-agent model all default --host codex
code-agent model --host claude
code-agent model implementer opus --host claude --effort high
code-agent model reviewer default --host claude
```

조회는 메인도 실행할 수 있고 작업 중에도 열린다(작업 중이면 표의 변경 줄이 변경 거부와 작업이 끝난 뒤의 방법을 알린다). 위 변경 명령은 사람이 직접 TTY에서 실행한다. 진행 중인 작업(접수부터 반영·종료 전까지)이 있으면 변경은 거부된다 — 정의 파일·변경값 파일은 커밋되는 설치 파일이라 작업 중에 바꾸면 그 작업의 계획 밖 변경이 된다. 작업을 반영(`deliver`)하거나 종료(`abort`)한 뒤 바꾼다(동의 `model`도 같다). `--effort`는 `--reasoning`과 같은 뜻이며 둘 중 하나만 쓴다. 대화에서 변경할 때는 `ca-answer`가 `{"action":"model","host":"codex","agent":"writer","model":"gpt-6-luna","reasoning":"high"}` 또는 `{"action":"model","host":"claude","agent":"implementer","model":"opus","reasoning":"high"}`로 기존 같은 세션 동의 절차를 사용한다. `model:"default"`는 모델·추론 강도를 함께 기본값으로 복원한다. 모델만 지정하면 해당 역할의 기존 추론 강도를 유지한다. 준비해 둔 `model` 동의는 그 사이 code-agent의 모델 정책이 바뀌면 `변경 대상: 모델 정책`으로 거부되므로 다시 준비한다.

Codex 변경값은 `.code-agent/codex-models.json`, Claude 변경값은 `.code-agent/models.json`에 분리한다. `models.json`의 역할 값은 모델 문자열이고, 강도 변경은 예약 키 `effort`(`{"effort":{"reviewer":"max"}}`)에 둔다 — 이전 code-agent도 역할 값을 그대로 읽고 `effort` 키는 무시한다(버전이 섞인 팀에서 이전 버전은 강도를 적용하지 않고 바꾸지 않은 역할을 opus로 설치하므로, 팀은 같은 code-agent를 쓴다). 형식이 잘못된 파일은 고치는 법과 함께 멈추고, `init`·`update`는 이때 파일을 하나도 쓰지 않는다(두 호스트 설치면 두 설정 파일을 모두 먼저 읽는다). `models.json` 값은 위 모델 이름만 받는다 — 손으로 넣어 둔 다른 값(예: 대문자 `"Opus"`)은 거부되므로 고친 뒤 갱신한다. 설정 우선순위는 **역할별 사용자 변경값 → 제품의 역할별 기본값**이다. 양쪽 호스트를 설치했다면 변경 대상 `--host`를 반드시 지정한다. 단독 설치에서는 생략할 수 있다. 재설치·업데이트·doctor도 이 값을 사용하며, 존재하는 Codex 변경값 파일은 기준 커밋과 최종 반영의 명시적 경로에 포함한다.

적용 후 호스트를 재시작해 역할 설정을 다시 읽는다. 실행 중인 담당이나 메인 세션의 모델을 변경하지 않는다. 부모 설정을 상속하던 이전 Codex 설치는 업데이트 후 위 기본값을 사용하며, 원하는 모델은 변경 명령으로 명시한다. 이전 code-agent로 설치한 Claude 정의 파일(opus·강도 없음)도 업데이트가 위 기본값(바꾼 역할은 변경값)으로 다시 쓰고 역할별 전후 값을 출력한다. 정의 파일 머리말이 설정과 다르면 `code-agent doctor`의 "에이전트 모델"이 알린다. 전역 `.codex/config.toml`은 수정하지 않는다.

## 차단 시 복구 선택

Windows PowerShell에서는 지침과 CLI 출력의 `code-agent` 셸 호출을 `code-agent.cmd`로 실행한다. 예: `code-agent.cmd read .agents/skills/ca-adopt/SKILL.md 1 300`. 이 안내와 `code-agent read` 안내는 메인에게는 AGENTS.md 블록으로 늘 실리고, 하위 에이전트에게는 `.codex/agents/*.toml` 지침 끝에 붙는다(스킬 사본에는 붙이지 않는다). 확장자 없는 호출이 npm의 `.ps1`을 선택하여 실행 정책 오류가 나더라도 정책을 완화하지 않는다. 사용자 대화 응답 `code-agent consent respond …`는 원래 형식을 유지한다. Bash·macOS·Linux에는 `.cmd`를 붙이지 않는다.

Codex 메인은 CLI·hook 차단 시 `.agents/skills/ca-answer/reference.md`의 차단 복구를 따른다. 허용된 도움말·상태 조회와 이미 선택한 방향은 재확인 없이 이어가고 새 결정만 질문한다. `code_agent.ask`의 MCP 선택 UI를 실제로 호출한다. 도구가 없거나 거부되면 설치·클라이언트 지원을 점검하고 번호 나열을 UI 완료로 보고하지 않는다. 도구를 호출할 수 있는데 글머리표만 출력하고 끝내지 않는다. 동의가 필요한 실행은 ca-answer의 Codex 동의 절차를 별도로 거친다. 외부 권한·hook 차단은 진단과 사용자 환경 확인으로 연결하며, 사용자의 거절·보류를 다른 도구로 우회하지 않는다. 작업 중 공통 문서 보완은 중단 동의 후 같은 작업 ID로 재개하고 필요한 계획·승인을 다시 검증한다.
