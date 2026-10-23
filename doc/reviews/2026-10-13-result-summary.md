# 오류 사전 판별·질문 UI·맥락·토큰·지식·외부 연결·재시도 결과 요약 (2026-10-12~14)

`5815323`..`ea23577`까지 열일곱 커밋(기록 정리·해시 갱신 커밋 `ee6d9a4`·`89ec0f0`·`8597f90`·`4d5f1fb`·`43c77cf`·`17bd089`·`53e81d4`·`10d6a52`·`34e96ac`·`0555096`과 그 뒤 정리 커밋 제외)의 변경 경위와 검증 결과다. 현재 동작은 [프로세스 흐름도](../process-flow.md)와 현행 문서가 기준이고, 여기에는 결정 근거·실제 호스트 확인·측정·예산 근거·확인하지 않은 것만 남긴다. 원자료는 [evidence/2026-10-13-result-summary.json](evidence/2026-10-13-result-summary.json)에 있다. 합친 기록의 원문은 git 이력에 있다([README](README.md) 끝의 Git 명령으로 찾는다).

| 커밋 | 날짜 | 변경 |
|---|---|---|
| `5815323` | 10-12 | Sentry·로그 오류의 사전 판별, 로그 중복 판별과 재발 관리, 접수 용어 구분 |
| `fe843a5` | 10-12 | 문서 누락과 CLI·hook 차단의 원인별 복구·보류 선택 |
| `fb8bd01` | 10-12 | Windows `code-agent.cmd` 호출의 hook 판정 |
| `c7385c4` | 10-12 | 두 호스트의 업무 질문을 실제 도구 호출로, 차단 뒤 허용된 조회는 재확인 없이 |
| `729abe7` | 10-12 | PowerShell 셸 호출은 `.cmd` — 모든 Codex 지침과 읽기 안내 |
| `bcc0f00` | 10-13 | 단계별 선택 표, 선택지 없는 문구 입력 요구의 Stop 교정 |
| `e564bff` | 10-13 | 셸이 주입한 임시 `safe.directory`로 동의가 무효화되던 오탐 제거 |
| `188acda` | 10-13 | Codex 업무 질문·동의를 로컬 MCP 폼(`ask`·`confirm`)으로 |
| `b2fd2b7` | 10-13 | 선택 화면에 다 들어가는 동의·업무 질문 크기 |
| `4e0c786` | 10-13 | Codex 세션 시작 상태 주입, Codex 계획 담당 staging, 계획 상세 조회 축약 |
| `1ededc0` | 10-13 | 토큰 사용 측정 보완(hook 출력·교차 토큰·배정별), 커서 이동·Stop·`read` 출력 축약, 리뷰 재검토 범위, 템플릿 중복 정리 |
| `3c7efc4` | 10-13 | `init` 인자 검사·스킬 머리말 YAML 결함, 토큰 검토 중간 항목 열 가지(M1~M10) |
| `298c4cc` | 10-14 | 요구 확정 동의 적용(`finish`)이 작업 시작까지 한다 |
| `8aec8c8` | 10-14 | 토큰 검토 낮음 항목(L1~L5·L7·L8)과 이 저장소 개발 문서(D1~D3) |
| `52b49b0` | 10-14 | 문서·지식 관리 — 기능·흐름 KNOWLEDGE, 업무 정책 구분·상태, 02 문서 영향과 반영 제안 범위, 요청 시 검색·최신성, `knowledge find` |
| `e45c6c1` | 10-14 | 상위 조정자·러너 연결 준비 — 선택적 작업 경험 기록, 진행 중 발견 보고, 읽기 전용 `status --json` |
| `ea23577` | 10-14 | 재시도·토큰 낭비 줄이기 — 계획 제출 규칙 선검사, 01 근거·출처 파서 통일과 문서 검사 오탐 제거, 규칙 식별자·역할별 제출 전 점검, 재배정 문맥·초안 보존, 검증 수정 배정 파일, `usage` 계획 담당 측정 |

## 오류 사전 판별 (`5815323`)

- 요청: Sentry 오류 → 판별 → 코드 변경 필요 → Jira 생성 → 수정. 자동 서비스 연결 전에 작업 절차부터 검증하고 기존 직접 fix·feature·refactor 접수는 유지한다.
- `ca-fix`의 Sentry·로그 진입과 `triage` CLI만 더했다 — 새 단계·서브에이전트·동의 동작은 없다. 판별 쓰기 경계·코드 근거 대조·중복 판별(`errorFingerprint.ts` v1)·Jira 수동 연결·배포 대기·접수 용어는 흐름도 §3.1 'Sentry 사전 판별'·§5.3과 [사용 가이드](../usage.md)가 정본이다.
- Jira 생성·조회는 사람이 한다 — 자격 증명·네트워크 어댑터가 없어 CLI 는 원격 티켓의 실재를 인증하지 않는다. 접수 횟수는 Sentry 의 발생 횟수가 아니고, 재발 판정에서 배포 버전의 대소를 추측하지 않는다.

## 차단 복구와 질문 도구 (`fe843a5`·`c7385c4`·`bcc0f00`)

- 일괄 중지 지침을 원인별 복구 선택으로 바꿨다 — 동작은 흐름도 §3.2 '차단 복구 선택'·'단계별 사용자 결정'과 §5.1 Stop 행이 정본이다. 작업 중 문서 보완은 기존 abort 동의 뒤 다시 시작하게 했고, 중단 없는 문서 쓰기나 강제 복귀는 만들지 않았다. 모델이 권한 경계를 풀 수 있다고 안내하지 않는다.
- 문제 사례: `planning --help` 거부 뒤 `code-agent help`에도 확인을 요구했다 — 허용된 조회와 이미 고른 방향은 재확인 없이 잇는다.
- 17개 진입의 질문 공통 문단을 같은 글자로 맞췄다. 글머리표 출력은 도구 호출이 아니고, 대화 답은 승인이 아니다.
- 단계별 선택 표는 매 단계 강제 질문 목록이 아니다. Stop 교정은 의미 전체를 판정하지 않고, 목록 항목 둘 이상이 적절한 후보를 보장하지도 않는다.

## Windows 명령 (`fb8bd01`·`729abe7`)

- UZRF-392 접수 중 `code-agent.cmd status`가 셸 허용 목록에서 거부됐다 → 맨 앞의 `code-agent.cmd`만 같은 명령으로 판정하고 경로·래퍼는 새로 허용하지 않는다(흐름도 §5.3).
- `code-agent read`가 npm 의 `.ps1`로 실행 정책에 막혔다 — hook 만 고쳐서는 지침의 명령 선택이 바뀌지 않아, Codex 지침과 CLI·hook 의 파일 도구 안내에 PowerShell 은 `.cmd`라고 적었다(흐름도 §7). 실행 정책은 바꾸지 않는다.

## 동의와 선택 UI (`e564bff`·`188acda`·`b2fd2b7`)

- Windows Codex 셸이 환경변수로 주입한 현재 저장소·하위 경로의 `safe.directory`(출처 `command line:`)가 스냅샷에 들어가, 그 환경이 없는 응답 hook 에서 'Git 설정 변경'으로 거부됐다 → 그 두 값만 비교에서 뺐다(흐름도 §4.2).
- Codex 의 번호 나열·응답 문자열 복사는 방향키 선택 UI 가 아니었고, `request_user_input_async`의 `accepted`는 화면 표시·사용자 답을 증명하지 않았다 → 업무 질문은 `code_agent.ask`, 동의는 `code_agent.confirm` MCP 폼으로 옮겼다(흐름도 §4.2, [Codex 연동](../codex.md)). 커밋이 들어가는 동의는 `.git` 쓰기가 막힌 샌드박스에서 첫 finish 부터 호스트 권한 요청을 쓴다.
- 동의 질문에 요약 전문을 실어 두 호스트 모두 확인 내용과 질문 줄을 함께 볼 수 없었다(아래 실측) → 질문을 10줄 안으로 줄였다(흐름도 §4.2 '선택 화면 크기').

## 실제 호스트 확인

| 커밋 | 호스트 | 확인한 것 |
|---|---|---|
| `729abe7` | PowerShell Restricted | `code-agent.cmd read` 실제 실행 |
| `bcc0f00` | codex·claude 실제 모델(`evaluate-question-choices.cjs`) | Codex: 독립 질문 2개의 `request_user_input_async` 호출과 같은 call_id 의 `accepted: true`(화면 표시·답은 아님). Claude(질문 도구 없는 비대화형): 사유와 질문 2개의 번호 선택지 |
| `188acda` | codex-cli 0.162.1 TUI · PowerShell · Default 모드(사람이 조작) | `ask` 폼 `Field 1/2`에서 방향키·Enter 로 고른 값이 그대로 반환. setup 동의 폼에서 `확인하고 진행` → `approved` → 첫 finish 를 `.git` 쓰기 권한으로 실행해 `applied`와 준비 커밋 생성. 동의 응답·원장 주입 없음 |
| `b2fd2b7` | claude 2.1.296 · codex-cli 0.162.1(PTY 하네스) | 아래 표 — 키 입력은 하네스가 보냈고 동의는 임시 저장소의 setup 을 Esc(보류)로 끝냈다 |
| `4e0c786` | codex-cli 0.162.1 TUI·`codex exec`, `evaluate-planning-hosts.cjs`(gpt-6.1-sol) | 세션 시작·압축 뒤 상태 주입, Codex 계획 담당의 staging 쓰기 — 아래 '맥락·상태 빈곳' |

| 화면 | 수정 전 | 수정 후 |
|---|---|---|
| Claude 120×40 | 108줄 질문의 49~76번째 줄만 보이고 끝이 `…` — 제목·커밋 대상·질문 줄 없음 | 질문 9줄·선택지 3개 전체 |
| Claude 80×24 | — | 질문 9줄·선택지 3개 전체 |
| Codex 80×24 | 요약 앞 18줄, 질문 줄 없음, 선택지 1줄(`option 1/3`) | 안내 2줄·질문 9줄·선택지 3개 전체, Esc → `deferred` |

Codex 폼의 잘림은 소스(`rust-v0.162.1` `codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs` — `message`와 필드 제목을 이어 붙이고 남은 높이로 스크롤 없이 자르며 선택지 설명은 쓰지 않음)로도 확인했다. 비대화형 `codex exec`와 합성 응답 시험은 UI 검증으로 치지 않는다.

## 맥락·상태 빈곳 (`4e0c786`)

별도의 Context & State Manager 나 외부 AI 프레임워크가 필요한지 검토했다. 상태 파일·잠금·작업 임대, `code-agent context`, 배정 파일 전달, 세션 시작 상태 주입, 템플릿 예산, 동의 `--for` 출력이 이미 나뉘어 있어 새 관리자는 만들지 않았다. 대부분의 에이전트 프레임워크는 LLM 루프를 직접 소유해야 해서 호스트 위에서 도는 이 구조와 맞지 않는다. 대신 빈곳을 채우고, 프레임워크 사용 여부는 사용자가 그 뒤에 다시 판단하기로 했다 → [LangGraph 전체 실행 전환](2026-10-16-langgraph.md).

- **Codex 세션 시작 상태 주입**: Codex `rust-v0.162.1` 소스 — SessionStart 입력의 `source`는 `startup`·`resume`·`clear`·`compact`·`fork`이고, `hookSpecificOutput.additionalContext`는 developer 메시지로 다음 턴에 붙는다(`codex-rs/core/tests/suite/hooks.rs`). 실제 TUI(임시 저장소, `--enable hooks --dangerously-bypass-hook-trust -s read-only -a never`)에서 시작 요약을 모델이 그대로 인용했고, `/compact` 뒤 rollout 에 압축 뒤 문장이 든 developer 메시지가 남았다. `codex exec`에서도 붙었다.
- **임대 넘겨받음 줄 반복**: 압축·재개마다 '작업 진행 기록을 넘겨받았습니다' 줄이 되풀이됐다(임대 갱신이 이전 보유자 기록을 그대로 둠). 같은 세션이 쥐고 있던 임대면 내지 않게 고쳤다(두 호스트). 단위 시험으로만 확인했다.
- **CLI 출력 크기**: 전체 시험(1,411개)을 측정 전용 preload 로 돌려 명령 함수 반환 5,620건을 모았다. 대부분 3K 자 아래라 일괄 상한은 두지 않고 이상값 하나 — 계획 상세 조회(`planningResult`, 최대 47,514자) — 만 고쳤다. 기록된 문서 파일과 글자가 같은 본문을 `{path, hash, chars, inFile: true}`로 줄여 47,513 → 2,572자. 기록 뒤 파일이 바뀐 경우는 대조 근거를 잃지 않으려고 본문을 그대로 싣는다.

| 명령 함수 | 건수 | 중앙값 | p90 | 최대 |
|---|---|---|---|---|
| `planningResult`(상세 조회) | 9 | 4,154 | 47,514 | 47,514 |
| `doctor` | 59 | 2,093 | 4,465 | 4,929 |
| `renderConsentOutput` | 1 | 3,592 | 3,592 | 3,592 |
| `planningStatus` | 10 | 968 | 2,857 | 2,857 |
| `context` | 24 | 1,758 | 2,290 | 2,790 |
| `requestBegin` | 90 | 1,961 | 2,070 | 2,198 |
| `status` | 103 | 820 | 1,660 | 2,479 |
| 그 밖 | — | — | ≤ 1,700 | — |

- **Codex 계획 담당 staging**: Codex 담당이 본문을 결과 JSON 에 싣던 근거('hook 에 하위 에이전트 식별자가 오지 않는다')는 0.161.0 실측에서 이미 틀렸다(`agent_id`·`agent_type`이 옴). 배정 계약을 두 호스트 같게 staging 으로 하고, 쓰기 도구 이름만 호스트 표기(`Write/Edit`·`apply_patch`)로 낸다. 메인의 대리 쓰기와 담당의 staging 밖 쓰기는 계속 거부하고, 쓰기가 거부되면 `{path, content}`로 낸다. 평가 스크립트(`evaluate-planning-hosts.cjs`)는 hook 수(6)·`[hooks.state]` 오판·캡처 래퍼 명령을 보정했다.

| 실행(분석 단계, 메인·`ca_analyst` gpt-6.1-sol) | staging 쓰기 | 담당 결과 | 메인에게 간 결과 메시지 |
|---|---|---|---|
| 1회 | hook 허용 → `apply_patch`가 `Failed to create parent directories`로 실패 | `{path, content}`로 대체, 기록·게이트 통과 | 3,409자 |
| 2회(hook 이 폴더 생성) | 성공 | `{path, staged}`, 기록·게이트 통과, 배정 폴더 삭제 | 1,624자 — 문서 2,358자는 메인을 거치지 않음 |

- **Windows 샌드박스 폴더 권한**: 샌드박스 셸이 첫 `apply_patch` 전에 만든 폴더(소유자 `CodexSandboxOffline`)에는 그 뒤 `apply_patch`의 쓰기 SID 권한이 퍼지지 않았다(소스 `windows-sandbox-rs/src/cap.rs` — SID 를 명령 cwd·쓰기 루트별로 둔다. 작은 저장소 실험으로 확인, `%TEMP%` 아래에서는 재현되지 않음). 그래서 staging 폴더는 샌드박스 밖에서 도는 담당 시작 hook 이 만든다. 같은 조건의 접수 폴더·지식 문서 뼈대는 고치지 않고 [Codex 연동](../codex.md)에 조건과 우회만 적었다.

## 토큰 최적화와 결함 (`1ededc0`·`3c7efc4`·`298c4cc`·`8aec8c8`)

토큰을 더 줄일 수 있는 구간을 전수 검토한 뒤(대화 보고) 사용자가 진행 범위를 차례로 정했다 — 측정 공백과 효과 '높음'(`1ededc0`), 검토 중 찾은 결함 둘과 '중간' 전부(`3c7efc4`), 브랜치 생성이 동의 안으로 들어와 사용자 결정으로 남겼던 요구 확정과 `start` 합치기(`298c4cc`). 마지막으로 '낮음'과 이 저장소 개발 문서 항목(`8aec8c8`)이다 — 교차·synthesis 강도는 A/B 측정이 필요해 남겼다.

### 측정과 높음 (`1ededc0`)

| 구분 | 항목 | 처리 |
|---|---|---|
| 측정 | hook 이 모델에게 낸 글을 세지 않았다 | `.code-agent/log/hooks.jsonl`에 길이·해시만 남기고 `usage`가 이벤트별로 센다 |
| 측정 | 교차 실행의 Claude 캐시 토큰·Codex 토큰이 `usage`에 없었다 | 재시도 절에 Claude 토큰 넷과 Codex `tokens used`를 따로 싣는다 |
| 측정 | Claude 교차 자식의 대화 기록을 `usage`가 메인으로 셌다 | `--no-session-persistence` |
| 측정 | 서브에이전트 사용량이 역할로만 묶였다 | 작업 기록의 담당 id 로 `배정별`·`호출별 (배정)` 표 |
| H1 | `start`·`next`·`back`이 매번 전체 status 를 다시 찍었다 | 옮긴 자리 요약 |
| H2 | 리뷰 2회차부터도 계획 파일 전체를 다시 정독했다 | 재검토 범위(바뀐 계획 파일·직전 지적) |
| H3 | Codex `read`가 들여쓴 JSON 이었다 | 머리 한 줄 + `줄번호<탭>본문` |
| H4 | 템플릿 중복·드문 문장 | 일부 — 아래 표 |
| H5 | Stop 목록 상한이 없고 같은 사유로 턴마다 다시 막았다 | 10줄 상한, 같은 세션·같은 사유는 한 번 |

- **측정 근거**: Codex `tokens used`는 `rust-v0.162.1` `exec/src/event_processor_with_human_output.rs`가 stderr 에 쓰는 `blended_total`(캐시 아닌 입력 + 출력)이라 입력·출력으로 나뉘지 않는다. `--no-session-persistence`는 claude 2.1.296 `--help`로 확인했다(`--print`와 함께만). hook 출력 기록은 글을 남기지 않고, 쓰기 실패를 삼키며, hook 경로라 `layout`만 import 한다.
- **H1**: 스테이지 시험 fixture 에서 `start` 410자(같은 자리 전체 status 620), `next` 253~297자(615~762). 검토 때 3개 Task 흐름의 커서 이동 출력은 8회 7,497자였다.
- **H2**: 회차마다 계획 파일별 해시(`files`)를 남기고, 2회차부터 직전 회차와 비교한 바뀐 파일(20개까지)과 직전 F 지적 줄을 `review` 출력·`context`·교차 프롬프트에 싣는다. 옛 기록이나 직전 결과가 없으면 전부 다시 본다. 리뷰 품질과 교환이지만 바뀐 것이 닿는 파일은 다시 읽고 새 지적을 낼 수 있고 교차 리뷰·게이트는 그대로라 받아들였다.
- **H3**(200줄): `src/agent/review.ts` 본문 8,142 → 옛 JSON 17,804 / 새 꼴 8,920자, `ca-plan/SKILL.md` 4,506 → 7,056 / 4,710, `process-flow.md`(긴 줄) 34,221 → 43,924 / 34,999.
- **H5**: 검토 때 계획 밖 파일 200개면 Stop 사유가 턴마다 10,588자였다. 같은 사유 판정은 hook 출력 기록으로 하고, 세션 id 가 없으면 옛 동작이다.

| H4 템플릿(LF 글자 수) | `4e0c786` | `1ededc0` |
|---|---|---|
| `ca-answer/reference.md`(질문·대기와 차단 때마다 읽는다) | 9,574 | 4,432 |
| `ca-answer/appendix.md`(5개 이상 선택지·동작 JSON·대상 변경·수동 대체 — 가리킬 때만) | — | 5,195 |
| `ca-analyze`·`ca-impact`·`ca-design`·`ca-plan` SKILL.md(4·5항을 `next` 줄 원천 규칙으로) | 3,283·3,033·2,838·4,905 | 2,791·2,541·2,346·4,506 |
| `template/codex/ca-answer.md`(AGENTS.md 블록과 같은 두 문장 삭제) | 5,061 | 4,894 |
| `ca-reviewer.md` · `ca-review/SKILL.md`(재검토 범위 문장) | 3,208 · 3,361 | 3,343 · 3,397 |
| Claude 흐름 합계(CLAUDE.block + 흐름 스킬 12) | 53,000 | 51,141 |

ca-feature 는 `ca-next` 스킬 파일(6.6K 자)을 따로 읽지 않는다. Codex 스킬 사본마다 붙던 꼬리말(368자)은 하위 에이전트 TOML 에만 붙인다. 17개 스킬 머리의 공통 '질문·동의' 문단을 상시 블록으로 옮기는 일은 같은 글자 시험·Codex 변환·블록 예산을 함께 바꿔야 해 하지 않았다.

- **실제 CLI**(임시 git 저장소, `node dist/agent/cli.js`): `init --host both`가 두 호스트에 `appendix.md`를 설치하고(보조 문서 12개) Codex `ca-answer`에 PowerShell 문장이 없다. `read a.txt 2 2` → `a.txt · 2-3 / 전체 6줄` + 두 줄 + 이어 읽기 줄. Claude `hook`·Codex `codex-event` PreToolUse 거부가 한 줄씩 기록되고(244·253자, 글 없음) `usage`의 `hook 출력` 절에 나온다. 실제 모델 실행은 하지 않았다.

### 결함과 중간 (`3c7efc4`)

| 구분 | 항목 | 처리 |
|---|---|---|
| 결함 | `init`이 모르는 인자(`--help` 포함)를 받아도 설치했다 — 측정 중 이 저장소 루트에 설치된 원인 | `init`·`doctor`·`update`는 받는 인자 밖이면 사용법과 함께 멈추고 `--help`·`-h`는 사용법만 낸다 |
| 결함 | `argument-hint`가 `[`로 시작하는 스킬 5개(ca-request·ca-analyze·ca-feature·ca-fix·ca-refactor)의 머리말 YAML 이 깨져 스킬 목록 설명이 공통 문단으로 보였다. `ca-docs`는 YAML 로는 맞지만 값이 배열로 읽혔다 | 여섯 값을 큰따옴표로 감싸고, 두 호스트 사본의 머리말 값 꼴을 대조하는 시험 |
| M1 | critic 이 차단한 계획에도 교차 계획 검토를 먼저 요구했고, 다시 돌 때 직전 교차 지적이 프롬프트에 없었다 | critic 차단 지적이 남은 판은 교차를 요구하지 않고 `next` 줄이 수정 피드백 재배정을 먼저 안내한다. 고친 판의 교차 프롬프트에 직전 지점의 교차 지적(기각 표시)을 싣는다 |
| M2 | 수정 재배정 때 담당이 문서 전체를 다시 출력했다 | 정식 문서가 있으면 담당 시작 hook 이 staging 자리에 현행 문서를 넣고 담당은 고칠 곳만 고친다. `ca-analyst`에 Edit 도구를 더했다(Write 만으로는 전체를 다시 쓴다) |
| M3 | analysis·design 입력에 테스트 전략·품질 기준이 통째로 들어가 두 문서만 고쳐도 analysis 부터 되감겼다 | 새 기본 작업 `contextVersion` 3 — analysis·design 의 정책 입력은 아키텍처·컨벤션. 진행 중 작업(2)의 해시 계약은 그대로다 |
| M4 | 구현 Task 마다 담당이 03·04 전체를 다시 읽었다 | 구현 context 에 그 Task 의 AC·업무 규칙 줄(40줄·줄당 300자까지)과 03·04 절 위치(줄 범위), 검증 context 에 절 위치 |
| M5 | 계획 담당 결과 JSON(사실·근거 각 100개, 요약 4,000자까지)이 메인 대화로 들어왔다 | 결과를 배정의 `result.json`에 쓰고 최종 응답은 `결과: <경로>` 한 줄. 완료 hook 은 그 담당 종류의 실행 중 배정 자리일 때만 읽는다 |
| M6 | 왕복 — Task 마다 `context --file`, 계획 승인·통합 검증 뒤 `next`, 리뷰 회차마다 `context --file` | 구현 Task 로 옮긴 `next`·회차를 연 `review`가 context 파일을 쓰고, 계획 승인 적용(`finish`)과 통과한 `integrate`가 커서를 옮긴다 |
| M7 | `verify --json` 실패 경로 — 줄 길이 상한 없음, 남은 회차 문장 세 번, 실패 뒤 `next`가 거부될 `test`를 안내 | 실패 꼬리 줄당 300자·합 4,000자, `budget`은 한 문장, verify 가 부른 요약의 결과 줄 생략, `next` 거부에 `다음:` 줄 |
| M8 | 셸 거부 문구가 원인과 관계없이 늘 전체였다 | 허용 범위 한 줄 + 원인이 맞는 갈래(연결 문자·`code-agent` 하위 명령·git·선언 명령)만 |
| M9 | 대기 중 `consent finish`가 summary 를 다시 냈고, 반영 확인 화면에 파일 목록이 두 번 나왔다 | 대기 중 `finish`는 summary 없이. 커밋 대상 목록은 변경 요약과 겹치는 파일을 개수로 묶고 그 밖의 커밋 파일만 나열하며, 변경 요약에 있지만 커밋하지 않는 파일은 따로 보인다 |
| M10 | `ca-analyst` 본문의 요구 분석 전용 형식(2.1K자)이 design·plan 배정 때도 로드됐고, 계획 담당 넷의 첫 문단이 배정 `instructions`와 겹쳤다 | 요구 분석 형식을 `ca-analyze/criteria.md`(분석 배정 파일의 문서 기준)로 옮기고 첫 문단을 줄였다 |

- **M6 왕복**: 검토 때 셈(접수부터 반영까지 26+2N, N = Task 수)에서 Task 마다 1회, 계획 승인·통합 검증 뒤 각 1회, 리뷰 회차마다 1회가 빠져 리뷰 1회차면 23+N 이다. 요구 확정 뒤 `start`까지 합쳐(아래) 22+N — N=10 이면 46 → 32 다. `next`가 review 로 옮긴 자리는 아직 회차가 없어 context 를 쓰지 않는다. 계획 승인 뒤 이동은 `finish`만 한다 — `apply`·사람의 TTY `approve`·시험 fixture 는 전처럼 `next`를 따로 부른다. 동의 결과의 담당 필드 이름은 `contextAgent`다 — `agent`로 두면 Codex 사본 변환(`` `agent` `` → `` `hostAgents.codex` ``, 계획 배정 필드용)에 걸려 `ca-implement` 1항이 없는 필드를 가리켰다(임시 저장소 설치본에서 발견해 고쳤다).
- **M8**(스테이지 fixture, 작업 중): Claude `ls` 거부 106자·Codex 283자(검토 때 755~994자). 연결 문자를 쓴 `code-agent` 명령은 648·887자, git 쓰기는 167·344자. Codex 는 PowerShell `.cmd` 문장이 붙는다. 실제 진입(`node cli.js hook`·`codex-event`)으로도 같은 문구를 확인했다.
- **M7**: 30,000자 한 줄 로그의 꼬리가 313자, 그런 줄이 섞인 60줄 로그가 3,879자다(검토 때 `verify --json` 출력 32.7K자).
- **M9**: 대기 중 `finish`에서 summary(검토 fixture 3.5K자)가 빠진다. 반영 확인 화면의 목록 표시는 사람에게 보이는 화면이 바뀌는 일이라 검토 때 사용자 결정으로 분류했는데, 사용자가 중간 항목 전부를 진행하기로 해 반영했다. 커밋되는 파일 집합(`deliveryPaths`)은 그대로다.
- **M2·M5 경계**: 시작 hook 은 샌드박스 밖에서 그 배정의 staging 폴더에만 정식 문서를 복사한다(교정 시도·이미 있는 staging 파일은 건드리지 않는다). 결과 파일 자리는 `decidePlanner`가 실행 중인 그 배정 담당에게만 열고 메인은 쓸 수 없다. 응답 줄이 가리키는 경로가 그 자리가 아니거나 파일이 없으면 형식 오류로 되돌린다. 출처(transcript) 검증은 그대로다. critic 은 쓰기 도구가 없어 JSON 으로 답한다.
- **M3**: 진행 중 작업의 입력 해시는 바뀌지 않는다(골든 해시 시험 그대로). 버전 3 작업을 옛 CLI 가 읽으면 스키마(2 만 받음)에서 거부된다 — CLI 와 템플릿을 함께 갱신하는 설치 규칙과 같다.
- **실제 CLI**(임시 git 저장소, `node dist/agent/cli.js`): `init --help`는 사용법만 내고(종료 0) 아무것도 쓰지 않았다. `init --hots both`·`init extra`·`doctor --bogus`·`update --bogus`는 사용법과 받지 않는 인자를 내고 종료 1, 파일은 그대로였다. `init --host both`는 설치했고, 설치된 두 호스트 사본 44개의 머리말이 모두 값 꼴 규칙을 지키며 `argument-hint` 여섯 개가 큰따옴표 값이다. Codex 사본의 `ca-implement`·`ca-review`·`ca-integrate` 바뀐 문장과 `.codex/agents/ca-analyst.toml`의 새 소개 문장, Claude `ca-analyst`의 `tools: … Write, Edit`를 확인했다. `next`·`review`·`integrate` CLI 출력과 계획 승인 `finish`는 시험(consent.test)이 실제 CLI 를 띄워 본다. 실제 모델 실행은 하지 않았다.

### 요구 확정과 시작 합치기 (`298c4cc`)

- 조건·확인 화면·결과 필드(`started`·`startBlocked`·`next`)는 흐름도 §3.3 이 정본이다. 기준 브랜치·대상은 접수 세션의 값이라, 손으로 쓴 지시서만 있고 접수 세션이 없으면 시작하지 않는다. 반려·`apply`·사람의 TTY `confirm request`·진행 중인 작업의 재확정과 다시 한 `finish`도 시작하지 않는다(계획 승인 뒤 이동과 같은 규칙).
- 요구사항 확인 문구(`decideRequest`가 띄우는 확인 화면)는 바꾸지 않았다 — TTY 확정이 같은 문구를 쓰고, 적용 때 준비한 확인 화면과 글자 그대로 대조하기 때문이다.
- 시작이 막히면(미커밋 변경·hook 누락·대상 여럿 등) 확정은 남기고 자동으로 다시 시도하지 않는다 — 막는 사유 대부분이 사람이 할 일이다.
- 왕복: 확정 적용 뒤 `start` 한 번(출력 419자, 시험 fixture)이 빠지고 `finish` 출력 510자 하나가 남는다.
- **실제 CLI**(임시 git 저장소에 `init --host both`, `node dist/agent/cli.js`): hook 이 본 `consent prepare --action request`·`consent finish`, Claude 는 `consent-event`의 질문 Pre/Post, Codex 는 `codex-event`의 `consent respond` 응답으로 적용했다. 두 호스트 모두 `feature/CONSENT-1` 브랜치·`analysis`였다. 미추적 파일을 둔 저장소는 확인 화면에 `시작 전 정리 필요: [A] stray.txt` 줄이 뜨고, 적용 뒤 `startBlocked`·`next`가 나오며 브랜치는 `master` 그대로였다.

### 낮음 (`8aec8c8`)

| 구분 | 항목 | 처리 |
|---|---|---|
| L1 | 계획 담당 되돌림이 zod 오류 JSON 을 그대로 실었다 | `경로: 메시지` 줄(20개까지) |
| L2 | 계획 CLI 출력이 들여쓴 JSON 이고 `hostAgents`·`dispatchId`가 `agent`·`assignmentFile`과 겹쳤다 | 최상위 키마다 한 줄, 빈 배열 생략(`problems`는 남김). 배정 요약은 지금 호스트가 부를 담당 이름만(Claude `agent`, Codex 에 `hostAgents.codex`), 배정 ID 는 파일 이름으로 |
| L3 | 긴 선언 명령(기본 node build 의 인라인 스크립트)이 검증 요약·⑧ 단계 문제 줄·셸 거부 문구에 argv 그대로 실렸다 | 120자까지와 글자 수. 셸 거부는 같은 실행 파일의 선언만 싣는다. 사람이 보는 준비 화면·⑧ 표·실행 로그는 그대로 |
| L4 | 오타 명령에 사용법 전문이 나왔다 | 가까운 명령과 `help <명령>` 안내(exit 1). `help <명령>`은 그 명령의 줄만 내고 hook 이 모델에게 연다 |
| L5 | 리뷰 표의 범위·경로·상태처럼 판단이 아닌 칸이 틀려도 판단 등급 담당을 다시 불렀다(Codex 는 새 리뷰어, 교차는 같은 판단 모델로 교정) | 기록 전에 코드가 고친다(`normalizeReviewTable` — 범위는 계획 대조 값, 경로의 백틱·`./`·끝 줄번호는 걷어 위치를 지적 칸으로, 상태 영어·동의어는 열림·해결). 교차 형식 교정(`correct`)은 writer 역할 설정(실행 등급)으로 돈다 |
| L6 | 교차 전용 강도 medium·synthesis writer 강도 low | 하지 않았다 — 남은 일 |
| L7 | 도입(`ca-docs`) 때 surveyor 초안이 메인 대화를 거쳐 writer 프롬프트로 다시 출력됐다 | surveyor 가 `doc/.survey/<영역>.md`에 쓰고 경로만 돌려준다. hook 이 surveyor 에게 그 자리 바로 아래 `.md`만 연다. 문서 세션이 폴더(안쪽 `.gitignore *`)를 만들고 닫을 때 지운다 |
| L8 | 세션 시작 요약의 고정 두 줄이 설치 지침 블록과 겹쳤다 | 이어가기 안내는 머리 줄의 스킬 이름만, 동의 줄은 응답·적용을 기다리는 동의가 있을 때만 |
| D1 | `AGENTS.md`의 '함께 맞출 중복 정의' 목록이 흐름도 §1.1 과 겹쳤다 | §1.1 셋째 칸을 정본으로 하고, 빠져 있던 규칙(동의 제목·준비 문구·`[Source]`·`COUNTER_LABEL`·`UNRENDERED_GUIDES`·단가표·연쇄·`parseFindings`·`CODEX_TURN`·표기 함수·교차 자식 명령·허용 키)을 §1.1 로 옮겼다. `AGENTS.md`에는 대조하는 시험 이름과 시험이 없거나 일부만 보는 항목·코드 규칙만 남겼다 |
| D2 | 흐름도 전문을 읽게 했다 | §1.1·§9 로 절을 찾고 그 절만 읽는다 |
| D3 | 흐름도에 2,000자 넘는 줄이 둘(§5.2 Codex 등록 문단, §6.3 실행 전 판정) | 글자를 바꾸지 않고 문단·목록으로 나눴다 |

- **측정**: L1 흔한 형식 오류(문제 7개) 1,696 → 456자. L2 시험 fixture 의 advance 출력 analysis 배정 695 → 416, 대기 561 → 428, 게이트 준비 329 → 251, impact 배정 728 → 442자(합 2,313 → 1,537, −34%) — 작업당 advance 는 9회쯤이다. L3 기본 node build 선언 441 → 128자. L4 오타 7,638 → 106자, `help planning` 753자. L8 작업 요약 −147자(머리 줄 +13자). D1 `AGENTS.md` 6,995 → 4,324자. D3 가장 긴 줄 2,255 → 1,924자.
- **L2 호환**: 함수 반환·배정 파일은 그대로이고 CLI 출력만 줄였다. Claude 스킬은 `agent`를, Codex 사본은 `hostAgents.codex`를 읽는다(변환 규칙 그대로). 호스트를 정할 수 없는 CLI(두 호스트 설치·호스트 표지 없음)는 `hostAgents` 전체를 싣는다.
- **L5 경계**: 범위 칸은 계획 파일 목록에서 정해지는 값이라 다시 써도 판단이 바뀌지 않는다. 뜻을 정할 수 없는 상태(`열림(경미)`·`해결 안 됨` 등)·빈 경로는 고치지 않고 표 규칙이 그대로 잡는다. 동의어를 `열림`으로 고친 계획 안 지적은 리뷰어가 뜻한 그대로 그 파일을 고칠 열쇠가 된다(시험 3개의 기대를 이 동작으로 바꿨다 — 옛 기대는 거부·되돌림이었다). 손으로 고친 ⑨ 의 상태·범위 칸은 게이트가 여전히 글자 그대로 본다. Claude 독립 리뷰어는 여전히 남은 문제가 있으면 같은 담당에게 한 번 돌려보낸다. 교차 교정 모델은 사람이 `code-agent model writer …`로 바꾼 값을 따른다 — 역할 정책·기본값(`ROLE_POLICY`·`TIER_DEFAULTS`)은 바꾸지 않아 model 동의의 정책 지문도 그대로다.
- **L7 경계**: surveyor 는 여전히 코드를 쓰지 못한다 — 초안 자리 밖 쓰기와 진행 명령은 hook 이 두 호스트 모두 거부하고(하위 에이전트 PreToolUse 의 `agent_type`), 초안 자리 쓰기도 문서 세션 규칙을 그대로 지난다. 폴더 안 `.gitignore *`로 Git·동의 스냅샷·준비 커밋에 들지 않고, 문서 경로를 폴더로 등록한 저장소에서도 점으로 시작하는 폴더는 문서로 세지 않는다.
- **실제 CLI**(임시 git 저장소, `node dist/agent/cli.js`): `planning advance`는 Claude 표기에서 배정 요약에 `agent`만, Codex 표기(`CODE_AGENT_HOST=codex`)에서 `hostAgents: {codex: ca_analyst}`를 더해 416·452자였다. 기본 node build 를 선언한 작업에서 `node -e 1`은 Claude `hook`·Codex `codex-event` 모두 선언을 `… (441자)`로 줄여 거부했다(427·604자 — Codex 는 PowerShell `.cmd` 문장 포함). `planing`은 exit 1 과 106자, `help consent`는 660자. 작업 중 `session-event`·Codex SessionStart 는 고정 두 줄 없이 머리 줄에 `/ca-next`·`$ca-next`를 실었다. `init --host both` 한 저장소에서 `docs begin`이 `doc/.survey/.gitignore`(`*`)를 만들었고, `agent_type` surveyor 의 초안 자리 쓰기는 Claude `Write`·Codex `apply_patch` 모두 허용, `doc/architecture.md`·`doc/conventions.md`·`app.js`는 거부였다. 초안은 `git status -uall`에 나오지 않았고 `docs end` 뒤 폴더가 없었다.
- **L6 을 하지 않은 이유**: 교차 리뷰·계획 검토의 추론 강도와 synthesis 강도를 낮추면 비용은 줄지만 판단 품질이 바뀐다. 같은 입력으로 A/B 를 재야 정할 수 있고 그 측정은 유료 평가다. 형식 교정은 판단이 없는 일이라 L5 에서 writer 설정으로 옮겼다.

## 문서·지식 관리 (`52b49b0`)

요청은 대상 프로젝트의 기능·업무 정책·업무 흐름을 최신으로 유지하고 다음 작업의 맥락을 빠르게 찾게 하되 **문서 생성량을 늘리지 말라**는 것이었다. 현재 동작은 [design.md §2.2](../design.md#22-공통-knowledge--비어서-시작하고-반영마다-자란다)와 usage 의 KNOWLEDGE·`knowledge` 절이 정본이다.

- **사용자 결정**: 인덱스는 요청 시 계산(저장 파일 없음), 기능 문서는 종류별 한 파일(`features.md`·`flows.md`), 문서 영향 판단은 새 작업(`knowledgeVersion: 1`)만 게이트. 구현 전에 차이·최소 범위·변경 파일·호환·시험 계획을 제시하고 받았다.
- **검토 내용 대조**(기준 `43c77cf`) — 일곱 가지 모두 해당했다.

| 검토 내용 | 근거 |
|---|---|
| POLICY 4종 · KNOWLEDGE 3종 | `schemas.ts` `POLICY_KINDS`·`KNOWLEDGE_KINDS` |
| 기능별 최신 문서·전체 흐름 없음 | 03·04 는 작업 단위다. 여러 작업을 합친 현재 기능·흐름 문서가 없었다 |
| 업무 규칙 빈 뼈대, 지식 갱신 선택적 | `ca-integrate` 2항이 "올릴 것이 있으면" 이었고 제안이 없어도 반영이 지났다 — 바꿀 항목을 판단한 기록이 없었다 |
| context.docs 기본이 제목 중심 | `plugins/defaults.ts` 제목 매칭 — 제목과 본문 첫 200자의 키워드 수 |
| 코드 변경으로 낡는 것을 못 본다 | `knowledge prune` 은 근거 경로가 **전부** 사라진 항목만 본다 |
| 컨벤션 대 참조 코드는 참조 코드 우선 | `ca-implementer.md` 한 문장 — 필수·권장 구분이 없었다 |

| 결정 | 이유 |
|---|---|
| `knowledge find` 만 모델에게 연다 | 읽기 전용이라 임대·쓰기 경계를 건드리지 않는다. 목록·`prune`은 사람의 자리. 교차 자식(`CROSS_CHILD_READONLY`)에는 넣지 않았다 — 받은 문서와 코드를 읽는 자리다 |
| 플러그인 프로토콜은 그대로 | 줄 범위·최신성·반드시 적용 정책은 플러그인 결과가 인덱스의 항목·절과 맞을 때 code-agent 가 붙인다 |
| `- 관련 정책:` 도 `정책:` 으로 읽는다 | 실제 CLI 확인에서 손으로 쓴 `관련 정책` 필드의 연결과 반드시 적용 정책이 빠졌다. 필드 이름 앞 `관련`을 뗀다 |
| 04 의 BR 키 대조는 낱말 경계로 | 부분 문자열이면 `BR-ORDER-1` 이 `BR-ORDER-10` 줄의 근거로 통과한다 |

- **호환**: 매니페스트 `docs.knowledge.features`·`flows`는 선택이고 파일이 없어도 막지 않는다(`docs begin`·`docs skeleton knowledge`·첫 반영에서 생긴다). 승인·계획 입력 해시는 그대로다. 문서 영향 게이트·`지식 제안:` 줄·⑩ `문서 영향` 표·업무 정책 필드 필수는 새 작업에만, 이전 작업의 제안은 R 번호·경로 검사만 받는다. 계획 `conflicts`의 `level`은 선택 필드다.
- **측정** — 같은 `stageFixture` 작업을 기준 빌드(`43c77cf`, 별도 worktree)와 지금 빌드로 진행하며 단계별 `context` 글자 수를 쟀다. '지식 있음'은 업무 정책 4(필수 확정·권장·다른 도메인 필수·관찰)·데이터 2·API 2·기능 1·흐름 1·컨벤션 `[필수]` 1줄이다.

| 단계 | 지식 없음 기준 → 지금 | 지식 있음 기준 → 지금 |
|---|---:|---:|
| analysis | 1,472 → 1,514 | 2,070 → 2,399 |
| impact | 1,542 → 2,048 | 2,121 → 2,914 |
| design | 1,643 → 1,736 | 2,222 → 2,602 |
| plan | 2,195 → 2,258 | 2,774 → 3,124 |
| implement (Task 3개) | 764 · 771 · 713 → 같음 | 764 · 771 · 713 → 1,096 · 1,103 · 812 |

  출력은 늘었다 — impact 는 문서 영향 지시·예시, 지식이 있으면 항목마다 줄 범위·상태·걸린 이유, implement 는 그 Task 파일에 걸린 정책과 `[필수]` 줄. 담당이 지식 문서 전문 대신 줄 범위만 읽어 줄어드는 탐색과 수정 왕복은 모델 실행으로 재지 않아 개선율을 주장하지 않는다. `usage`의 `문서 탐색` 줄(스테이지별 공통 문서 읽기·검색·`knowledge find`)이 그 비교의 자리다.
- **실제 CLI**(임시 저장소, `node dist/agent/cli.js`): `init --host both`가 `ca-integrate/knowledge.md`를 두 호스트에 같은 글로 설치하고 Codex `ca-integrate/SKILL.md`는 `.agents/skills/…`를 가리켰다. check 단계에서 Claude `hook`은 `knowledge find` 허용·`knowledge`·`prune`·`doc/knowledge/features.md` Write 거부, Codex `codex-event`는 Bash·PowerShell `knowledge find` 허용·`prune`·`apply_patch` 거부였다. 반영 단계 `next`·`status`가 `지식 제안: \`FEAT-ORDER-REGISTER\`(신규) · 02 에서 판단하지 않은 관련 항목 \`FEAT-ORDER-QUERY\` …`, `context`가 같은 범위의 `## 지식 제안` 절을 냈다. `knowledge`는 근거 파일을 바꾼 커밋 뒤 `[재검토 필요: <커밋> 가 src/order/cancel.ts 를 바꿈]`, `usage`는 `문서 탐색(…): impact 2`.
- **첫 구현의 되감기**: 처음에는 계획 파일에 걸린 미판단 문서 영향을 계획 제출에서 막았는데, 02 는 계획 단계에서 고칠 수 없어 막으면 되감기가 된다 — 반영의 `지식 제안:` 줄이 알리게 옮겼다.
- **정리 커밋에서 고친 것**: 단계 context 의 절 이름이 `참고 문서`로 바뀐 것을 템플릿 네 곳(`ca-analyze/criteria.md`, `ca-design/criteria.md`·`legacy.md`, `ca-impact/legacy.md`)과 design·requirement 문서에 맞추고, 흐름도 §1.1 에 그 이름과 KNOWLEDGE 종류 목록을 함께 맞출 곳으로 더했다.

## 상위 조정자·러너 연결 준비 (`e45c6c1`)

요청은 기존 절차를 유지한 채 나중에 상위 조정자(master-agent)가 붙을 수 있게 작업 경험 기록·검색, 진행 중 발견의 구조화 보고, 상태·증거·재개를 읽는 버전 있는 계약을 만드는 것이었다. master-agent·LangGraph·조직 UI·Jira·Notion 연동·원격 push·PR·배포는 만들지 않았고, master 없이 CLI 와 두 호스트에서 그대로 동작한다. 현재 동작은 [design.md §1 '외부 실행기와의 경계'·§2.6](../design.md#26-작업-경험과-진행-중-발견--선택-기록과-보고), [usage.md 5절](../usage.md#code-agent-status---json--기계-판독용-상태), 흐름도 §3.2·§5.3·§5.4·§8·§9 가 정본이다.

- **기존 기능 판정**(기준 `53e81d4`) — 승인·무효 원인(`approvalOf`·`staleEarliest`), 재시도 사용량·한도(`retrySummary`·`verifyView`), 증거 묶임, 실패 안내, 작업 임대는 그대로 불러 노출만 한다. 경험 → 정책은 지식 제안·반영 동의, 발견 a 는 수정 루프와 한도, b 는 `back plan` 재계획·재승인으로 이미 충족된다. 같은 요청 중복·이전 시도의 늦은 결과도 기존 경로가 막는다 — 계획 배정의 `dispatchId` 대조(취소·교체 배정의 늦은 결과는 되돌리지 않고 늦은 결과로만), 끝맺지 못한 동의 적용은 다시 돌리지 않음(`applyLocked`). 계획 작업의 시도 기록·고아 판정·재진입 안내를 전체 실행의 복구 보장으로 넓히지 않았다. 프로세스 생존·로그·종료·취소·실행 소유권은 러너, 조직 권한·배정·DAG·예산·서비스 간 승인·전체 복구는 상위 조정자의 몫으로 남겼다.

| 결정(이어서 진행하라는 지시로 기본값) | 고르지 않은 대안과 이유 |
|---|---|
| 경험은 원래 작업 폴더의 선택 파일 `experience.md` | KNOWLEDGE 6번째 문서 — 정본(현재 동작·확정 정책)과 당시 관찰이 섞이고 반영마다 사람 선택이 필요하다. `.code-agent/` — 사람이 읽고 리뷰할 수 없다 |
| 경험 ID `EXP-<작업 ID>-<순번>`, 지난 작업은 뒤 작업이 버전 +1 로 | 전역 순번 — 병렬 작업의 반영이 같은 번호를 낸다. 원래 파일 수정 — 반영된 작업 폴더(이력)를 바꾼다 |
| `검증됨` 은 그 작업의 통과한 검증 기록과 이어질 때만 | 모델 선언 — 요구가 금지했다. 사람 확인 동의 — 별도 승인 단계를 늘린다 |
| 발견은 코드만 쓰는 `findings.json`, ID 는 작업·분류·제목·근거 목록의 해시 | 작업 폴더 마크다운 — 버전 대조·중복 판정을 지킬 수 없다. 제목만 해시 — 근거가 다른 발견을 합친다 |
| 상태는 기존 `status` 의 `--json` | 별도 어댑터 — 같은 판정의 두 번째 진입점 |
| 직접 재개 명령을 두지 않는다 | 기존 명령·동의 경로가 이미 승인·임대·한도를 확인한다. 실행 직전 `--expect-*` 대조로 오래된 요청을 거른다 |
| 초안 자리 고정·기록 뒤 삭제·반영 제외 | 아래 '진행 중 고친 것' |

- **진행 중 고친 것**: 저장소 루트에 둔 초안이 `status` 의 계획 밖 변경으로 잡혀 초안 자리를 작업 폴더로 정하고 기록 뒤 지운다. 비밀 값 때문에 거부되어 남은 초안이 작업 폴더째 반영 커밋에 들어갈 수 있어 `deliveryExcludes` 에 두 초안 자리를 넣었다(실제 반영 경로 시험). `finding list --work` 값이 경로 조각으로 쓰여 작업 ID 꼴만 받는다. 상태 조회의 `git status` 가 색인을 갱신하지 않게 `GIT_OPTIONAL_LOCKS=0`. 손상 원장 시험이 마지막 줄만 바꿔 사슬 검사를 지나가(사슬은 다음 줄이 앞 줄을 묶는다) JSON 이 아닌 줄을 덧붙이게 고쳤다.
- **실제 CLI**(임시 git 저장소, `node dist/agent/cli.js`): 작업 없음 `no-work`, check 뒤 `ready`·시도 `verify:r1:1`·승인·한도·묶임, 같은 기대 종료 0·다른 시도 종료 3(`stale-request`), `--json` 없는 대조 옵션은 사용법(종료 1). 경험 기록·초안 삭제·비밀 값 거부(값 미노출)·목록·`show`·`knowledge find` 의 따로 센 경험 절. 발견 기록·재전송 하나로·d 기록·`--json`, 차단 c 뒤 `needs-human`(`finding-c`)·`stateVersion` 변경, 사람용 `status` 의 `발견:`·`작업 경험:` 줄.
- **두 호스트 hook**(실제 `hook`·`codex-event` 프로세스): 다른 세션이 임대를 쥔 상태에서 `status --json`(대조·식별 옵션 포함)·`experience list·show`·`finding list` 는 허용, `finding report`·`experience add` 는 임대로 거부. `experience.md`·`findings.json` 직접 쓰기는 Claude `Write`·Codex `apply_patch` 모두 거부, 초안 자리는 허용.
- **시험이 보는 것**: 경험·가설이 반드시 적용하는 업무 정책에 끼거나 정책 결과를 밀어내지 않음, 폐기·대체됨·낡은 근거·근거 경로 없음 표시, 같은 발견 재전송은 하나·근거가 다르면 따로, 무관한 개선은 재개 코드·진행을 막지 않음, b·c 등록이 쓰기 경계·승인 원장·커서를 바꾸지 않음, 조회 전후 모든 파일(내용·수정 시각)·승인·커서·재시도 카운터 불변, 승인 무효(`reapproval-required`·`replan-required`)·소유권 충돌·관측 불가(파일 그대로)·대기·사람 판단·오래된 요청의 구분, 끝맺지 못한 동의 적용의 `unobservable`, 옛 작업의 사람용 `status` 불변, 두 호스트 템플릿 사본. 중복 요청·늦은 결과는 기존 시험(`planning.test.ts` 늦은 결과 넷, `consent.test.ts` 중단된 적용·취소 재생)이 본다.

## 재시도·토큰 낭비 줄이기 (`ea23577`)

요청은 검증·승인·쓰기 범위·테스트 동결·근거 추적을 완화하지 않고, 정상 결과의 오탐·지침과 검사의 모순·뒤늦은 실패·재배정 때의 문맥 손실을 먼저 없애 불필요한 재시도와 토큰을 줄이는 것이었다. 재시도 한도·프롬프트 예산은 먼저 늘리지 않고, 모델이 정확히 옮기거나 셀 필요가 없는 값은 코드가 주며, 지침은 역할·작업 종류에 필요한 것만 준다. master-agent 개발이 아니다. 현재 동작은 흐름도 §6.1·§6.2·§8·§9, [계획 작업](../planning.md), [사용 가이드](../usage.md) verify 표·usage 절이 정본이다.

검토 항목을 `34e96ac` + 작업 트리의 코드로 다시 판정했다(**확인** — 검토대로 문제가 있었다, **부분** — 일부만 해당, **해결됨** — 이미 처리하고 있었다).

| 항목 | 판정 | 처리 |
|---|---|---|
| plan 완료 hook 이 제출 규칙 일부만 봄 | 확인 | 순서·preserve·검증 명령 파일·fix·refactor·경로를 `planRuleProblems`로 옮겨 `plan submit`과 완료 hook(07 staging 덮어보기)이 함께 쓴다. hook 은 `submitPlan`을 부르지 않고 명령 모듈을 import 하지 않는다(`hookLoad` 통과). 최종 제출·승인의 재검사와 critic·교차 무효화는 그대로 |
| sourceTrace 쉼표·마침표 누락을 요구 누락으로 판정 | 확인 | 양쪽이 글자·숫자가 아닌 자리의 좁은 문장부호만 무시. 소수점·음수·비교 연산자·경로·버전 반례는 계속 누락 |
| `- 근거:`·강조 근거, `근거: "인용" (REQ-1)` 뒤 표기, 첫 `출처:` 줄만 읽음 | 확인 | `requirementFields.ts` 한 파서 — 목록 기호·`**근거**:`·`**근거:**`·전각 콜론, 따옴표 안만 인용, 블록의 출처 줄 전부. 잘못된 ID 꼴(`req-1`·`REQ1`)은 계속 거부 |
| 로그 인용 안 `OrderService.java:42`·URL·JDBC `호스트:포트`를 파일 근거로 검사 | 확인 | 지시서 `## 오류 로그`에 있는 내용을 백틱·코드 블록으로 인용한 부분과 `//`·`@` 뒤 자리만 뺀다. 그 밖의 백틱 `src/a.ts:10`은 계속 검사 |
| 근거 있는 BR 정의를 AC 에서 참조해도 근거 요구 | 확인 | 정의 줄의 근거를 확인한 BR 만 번호 참조 허용. 없는 BR·중복 정의·근거 없는 정의는 거부 |
| 미결 표시 오류에 줄·표현 없음 | 확인 | 문서마다 `N행 '표현'`(최대 5개)과 고칠 방향 |
| critic 의 기존 계획 파일·참조 표준·refactor 기존 TC 테스트가 입력 밖 | 확인 | `contextVersion` 4 `supportFiles` |
| 후속 담당 허용 근거에 `facts.source`·`findings.source` 누락 | 확인 | 직접 선행 결과의 두 출처 경로를 허용 근거에 더함. 자기 출력·저장소 전체는 여전히 아님 |
| analysis 질문 REQ/DONE/CON vs 후속 R | 해결됨 | 질문 요구 범위가 이미 작업의 실제 요구 ID 였다. R↔원문 ID 자동 치환은 하지 않음(요청대로) |
| 결과 상태별 계약·needs-input 질문 | 확인 | 배정에 `statusContract`, 질문 없는 needs-input 거부(`RES-STATUS`) |
| 미완성 초안 보존·재배정 | 확인 | `keepDrafts`(출력 경로·이 배정 staging·실재), `latestDrafts`·`seedStaging`, 정식 승격 없음 |
| 유효 질문 소실 | 부분 | 실패로 기록된 결과의 형식·범위가 맞는 질문을 `pendingQuestions`로 남겨 다음 배정에만 넘긴다 |
| 재배정 문맥(이전 초안·새 답·바뀐 입력·실패 이유) | 확인 | `previous` 확장과 배정 파일 `## 직전 시도`, 1,000자 요약 대신 전체 `problems` |
| 형식 교정 "형식만" | 해결됨 | 그대로 둠 |
| fix 영향도 로그 대응 형식 | 부분 | 검사(`IMP-LOG`)는 있었다. 배정의 `## 제출 전 점검`에 로그 있는 작업일 때만 그 줄이 실린다 |
| writer `확인 필요` ↔ synthesis 완료 문서 | 확인 | `ca-writer.md` — 계획 배정은 문서 기준대로 미결 표시를 남기지 않는다 |
| impact·design 기술 가정 → 승인 묶음, critic BR 키 | 확인 | 02·03 `## 가정`(선택 절) → `workAssumptions`로 제출 결과·승인 화면·05-plan(01 은 고치지 않는다). `ca-plan/criteria.md` BR 정의 근거에 업무 정책 키 |
| 후보 파일·지식 표시 상한 밖 누락 | 부분 | 전체 주입은 하지 않는다. `IMP-DOC` 점검 줄이 `knowledge find`·검색으로 확인하게 한다 |
| "제출 전 점검" 역할·종류별, 공통 규칙 ID | 확인 | `planningRules.ts` `RULES` — 문구 태그와 점검 목록이 한 표, 시험이 둘이 빠짐없이 같은지 본다 |
| ca-check "파일별로 맡긴다" | 확인 | 원인 단위 묶음, `repairFile`(실패 명령·로그 경로·실패 TC→AC→Task·고칠 수 있는 파일·동결 테스트·남은 회차) |
| TC 결과 인식 규칙 안내 | 부분 | 사전 점검은 이미 있었다. 파일 탐색 경계를 결과 인식과 맞추고(`TC-6_empty`는 있음, `TC-1a`는 아님) `TC_3` 같은 표기를 알린다. 러너별 표는 보조 문서 `ca-test/tc-names.md` |

| 결정 | 고르지 않은 대안과 이유 |
|---|---|
| 제출 규칙은 부작용 없는 `planRuleProblems`를 두 자리가 import | hook 에서 `submitPlan` 호출 — 명령 모듈 정적 import 금지·부작용(파일 쓰기). 규칙 복제 — 둘이 어긋나면 같은 초안이 뒤늦게 걸린다 |
| 문장부호는 양쪽이 글자·숫자가 아닌 자리의 `, . ; ! ?`(전각 포함)만 | 기호 일괄 제거 — `1.5`→`15`, `-3`, `>=` 누락을 통과시킨다 |
| 로그·URL 은 지시서 오류 로그와 같은 인용·`//`·`@` 뒤로 구분 | 백틱 전체 제외 — 정상 `src/a.ts:10` 근거 검사가 사라진다 |
| 새 입력 파일은 `contextVersion` 4 로만 | 기존 버전에 더하기 — 진행 중 작업의 입력 해시가 바뀌어 결과가 낡는다 |
| 미완성 결과의 문서는 초안으로만 기록·재배정 staging 에 놓음 | 정식 문서로 승격 — 검사를 지나지 않은 문서가 게이트 근거가 된다. 버림 — 같은 본문을 다시 출력한다 |
| 실패 결과의 질문은 다음 배정 `previous`로만 | `questions.md`에 바로 기록 — 내용 검사에 걸린 결과의 질문을 사람에게 묻는다 |
| 수정 배정은 코드가 파일로 모아 경로만 넘김 | 메인이 실패를 옮겨 적음 — 메인 대화에 로그가 실리고 빠뜨린다 |
| 측정은 기존 `usage` 재시도 줄에 첫 시도 통과·규칙별 거부·초안 이어 쓰기 | 새 명령 — 같은 기록을 읽는 두 번째 진입점. 되돌림·형식 교정은 이미 `retrySummary` 카운터라 다시 세지 않는다 |

- **호환·버전**: 새 계획 작업만 `contextVersion` 4 다. 버전은 작업 정의에 남으므로 진행 중이던 작업(3 이하)의 입력 해시·결과는 그대로이고, 옛 코드는 4 를 읽지 못한다(진행 중 작업을 구버전으로 내리지 않는 기존 방침). 결과 계약은 needs-input 에 질문이 하나 이상이어야 한다 — 진행 중 배정이 질문 없는 needs-input 을 내면 Claude 는 한 번 되돌리고, 그 뒤·Codex 는 내용 실패다. 미완료 결과의 artifacts 는 거부하지 않고 초안으로 남긴다(정식 문서·게이트 영향 없음). 시도 기록의 `drafts`·`pendingQuestions`, 담당 기록의 `returnedRules`(측정용)는 선택 필드라 옛 기록은 그대로 읽힌다. 02·03 의 `## 가정`은 선택 절이다.
- **진행 중 고친 것**: 수정 배정 파일의 `## 문제`가 실패한 명령 줄을 되풀이해 그 줄을 뺐다. 결과가 인식돼 실패한 TC 뿐인데 게이트가 "TC id 를 남기세요"를 안내해, 실패만 있으면 "테스트를 약하게 하지 않고 계획 안의 코드를 고칩니다"로 나눴다. 측정에 되돌림·형식 교정을 따로 세던 중복 정의를 지웠다(이미 `retrySummary` 카운터). TC 사전 점검이 `\b` 경계로 `TC-6_empty`(Go 하위 테스트 이름)를 없는 것으로 알려 결과 인식과 같은 경계(`tcToken`)로 바꿨다.
- **실제 CLI**(임시 저장소, `node dist/agent/cli.js`): `verify --json`의 `repairFile`(`.code-agent/work/ORD-1/handoff/repair-1.md`)과 파일 내용(실패 명령·로그 경로·`TC-1` → `AC-R1-1` 표·계획 파일·동결 테스트·남은 회차), 텍스트 출력의 `수정 배정:` 줄, 테스트 파일에 `TC_1`만 있을 때 `check` 요약의 표기 안내, `init --host both` 뒤 `.agents/skills/ca-test/tc-names.md` 설치와 `ca-tester.toml` 경로·`ca-check` 2항 기다림 문장 치환.
- **시험이 보는 것**: 파서·문장부호 반례·로그·URL·BR(`planningRules.test.ts`), 질문·초안·재배정·Claude 되돌림·`contextVersion` 4·점검 목록과 규칙 표 대조(`planningRetry.test.ts`), 수정 배정 파일·로그의 계획 파일·TC 표기 안내·결과 인식 경계·02·03 가정(`repairLoop.test.ts`), plan 완료 hook 과 제출의 같은 규칙(`planning.test.ts`), 계획 담당 측정(`assets-doctor-usage.test.ts`).

## 템플릿 예산

| 파일 | 예산(자) | 근거 |
|---|---|---|
| `ca-fix/triage.md`(새 보조 문서) | 3,400 → 4,000 | 판별·후보 비교·중복 종료·배포 확인·재발 절차. 판별 때만 읽는다 |
| `ca-fix/SKILL.md` · `ca-request/SKILL.md` | 3,400 → 4,000 · 5,200 → 5,500 | Sentry 진입 분기와 인계 |
| `ca-answer/reference.md` · `appendix.md` | 5,300 → 4,600 · 새 5,400 | 차단 복구 표, 복구 참조·도구 가용성, 단계별 선택 표를 더했고(가장 클 때 9,600) 드문 절을 `appendix.md`로 나눴다 |
| `ca-answer/SKILL.md` · `ca-docs/SKILL.md` | 8,400 → 8,700 · 6,600 → 6,900 | 도구 호출과 단순 출력의 구분·대체 안내, 테스트·품질 기준 선택 형태 |
| `template/codex/ca-answer.md` | 4,100 → 5,100 | Codex 질문 정본, `.cmd` 규칙, 단계별 선택 참조 |
| `ca-analyze`·`ca-impact`·`ca-design`·`ca-plan` SKILL.md | 3,300·3,100·2,900·5,000 → 2,900·2,700·2,500·4,700 | 4·5항을 `next` 줄 원천 규칙으로 줄인 크기에 묶었다 |
| `CLAUDE.block.md` · `CODEX.block.md` | 1,600 → 1,700 · 1,500 → 1,800 | 복구 참조, PowerShell `.cmd` 규칙(담당도 읽도록 공통 블록에) |
| 계획 담당 넷(`ca-analyst`·`ca-critic`·`ca-explorer`·`ca-writer`) · `ca-analyze/criteria.md` | 3,100·2,000·2,400·2,800 → 800·1,900·2,200·2,600 · 600 → 2,700 | 요구 분석 형식을 분석 배정의 문서 기준으로 옮겼다(실측 2,915·1,859·2,305·2,711 → 781·1,779·2,084·2,491, criteria 497 → 2,513). 분석 배정 파일은 전과 같은 글을 싣고, design·plan 배정은 그만큼 덜 읽는다 |
| `ca-docs/SKILL.md` · `ca-integrate/SKILL.md` · `ca-integrate/knowledge.md`(새 보조 문서) | 6,900 → 7,300 · 2,900 → 3,100 · 새 1,400 | 기능·흐름 KNOWLEDGE 의 표 행·인자·종류 목록, `지식 제안:` 줄을 따르는 두 문장(실측 6,858 → 6,993 · 2,842 → 2,983 · 1,359). 제안 형식(필드·예시·삭제·대체·보류·충돌)은 제안을 쓸 때만 읽도록 보조 문서로 뺐다 |
| `ca-check/SKILL.md` · `ca-integrate/SKILL.md` | 4,900 → 5,200 · 3,100 → 3,300 | 수정 루프 3항의 발견 보고 한 문장, 반영 준비 3항의 선택적 작업 경험 한 문장(실측 4,885 → 5,069 · 2,983 → 3,174). 칸 형식은 인자 없는 `code-agent experience`·`finding` 출력에 두어 쓸 때만 읽는다 |
| `ca-test/tc-names.md`(새 보조 문서) | 새 1,500 | 러너별 TC 이름 표(실측 1,402). `ca-tester.md`(1,793/1,800)에 넣지 않고 TC 표기가 걸릴 때만 읽는다. `ea23577`은 다른 파일 예산을 올리지 않았다 — `ca-implementer.md`·`ca-writer.md`는 문장을 줄여 1,399/1,400·2,591/2,600 |
| 흐름 합계 Claude · Codex | 51,700 → 52,200 · 49,500 → 52,300 | 위 진입 문장의 합. 가장 클 때 53,200·53,400 이었고 템플릿 중복을 줄인 크기에 다시 묶었다. `52b49b0` 뒤 Claude 51,509 · Codex 47,533, `e45c6c1` 뒤 51,884 · 47,908, `ea23577` 뒤 52,149 · 48,173 |

## 검증 수치

| 커밋 | 전체 `npm test` | 전체를 돌리지 않은 커밋의 관련 시험 |
|---|---|---|
| `5815323` | 1,376개 중 1,372 통과·생략 4 | 판별 19개 포함 관련 96개 |
| `fe843a5` | 1,376개 중 1,372 통과·생략 4 | |
| `fb8bd01` | — | hookPaths·consentBinding·hookLoad·docSync·finalReverify 106개 |
| `c7385c4` | 1,379개 중 1,375 통과·생략 4 | |
| `729abe7` | — | hook·호스트 표기·템플릿·Codex 103개 |
| `bcc0f00` | 1,385개 중 1,381 통과·생략 4 | |
| `e564bff` | — | consentSnapshot·consentBinding·docSync·hookLoad 87개 |
| `188acda` | 1,402개 중 1,398 통과·생략 4 | |
| `b2fd2b7` | 1,410개 중 1,406 통과·생략 4 | |
| `4e0c786` | 1,411개 중 1,407 통과·생략 4(staging hook 변경 전후 같음) | |
| `1ededc0` | 1,418개 중 1,414 통과·생략 4 | |
| `3c7efc4` | 1,429개 중 1,425 통과·생략 4 | |
| `298c4cc` | 1,431개 중 1,427 통과·생략 4 | |
| `8aec8c8` | 1,436개 중 1,432 통과·생략 4 | |
| `52b49b0` | 1,450개 중 1,446 통과·생략 4 | 새 `knowledgeDocs` 13개·04 BR 키 근거 1개. 중간 실행에서 반영 context 의 '제안 없음' 문구에 제안 파일 경로가 빠져 1개 실패 → 문구 수정 |
| `e45c6c1` | 1,482개 중 1,478 통과·생략 4 | 새 `experience` 10·`findings` 8·`stateView` 13·반영 1. 중간 실행에서 손상 원장 시험 1개 실패 → 시험 입력 수정 |
| `ea23577` | 1,500개 중 1,496 통과·생략 4 | 새 `planningRules` 5·`planningRetry` 6·`repairLoop` 5·`planning` 1·`assets-doctor-usage` 1. 중간 실행에서 5개 실패 — 새 보조 문서로 바뀐 설치 수(보조 문서 13→14개, Codex 자산 39→40개)와 새 작업 버전(3→4)을 기대한 시험이라 기대값 수정 |

실패는 모두 0 이다. 생략 4개는 플랫폼 조건이다. Windows 샌드박스 안에서는 OS 사용자 정보 조회(`uv_os_get_passwd`)가 ENOMEM 으로 실패하는 시험이 있어 전체·관련 시험을 샌드박스 밖에서 돌렸다. `consentScreens` T-15-1(2초 대기 뒤 캐시 생성)은 부하에서 한 번 실패한 뒤 단독·재실행에서 통과했다.

## 확인하지 않은 것

- 실제 cloud 저장소·Sentry 이벤트·Jira 계정·배포 연동 — 판별 정확도와 티켓 생성은 합성 입력으로만 시험했다. 중복 상태는 로컬 체크아웃에만 있어 여러 PC·서버에는 공용 저장소와 원자적 예약이 필요하다.
- 실제 대화에서 차단 → 복구 선택 → 재개까지의 흐름, Claude 동의 화면에서 답 → 적용까지(표시만 실측).
- 접수부터 반영까지의 실제 모델 완주 → [복원·실제 모델 기록](2026-10-20-session-recovery-live.md)에서 Claude 통과·Codex 미통과(`start`의 `.git/index.lock` 권한 거부)로 확인. 리뷰 재검토 범위의 실제 회차 비용·품질은 그 실측에도 없다(독립 리뷰 1회만 관찰).
- 임대 넘겨받음 줄 수정의 실제 호스트 재확인.
- Codex hook 의 `agent_id`가 하위 에이전트 기록의 thread id 와 같은지 — 다르면 Codex 배정별 표가 빈다.
- 결과 파일·미리 넣은 문서·context 근거 줄을 담당이 지침대로 쓰는지, 요구 확정 적용 뒤 메인이 `started`·`startBlocked`를 읽고 잇거나 멈추는지(모델 행동)와 그 실제 토큰 효과 — 모델 완주 실측이 필요하다. Codex Windows 샌드박스에서 훅이 만든 배정 폴더·문서 사본을 `apply_patch`로 고칠 수 있는지도 확인하지 않았다(거부되면 `{path, content}`로 낸다).
- surveyor 가 초안을 `doc/.survey/`에 쓰고 경로만 돌려주며 writer 가 그 파일을 읽는지(모델 행동)와 실제 도입의 토큰 효과, 교차 형식 교정을 writer 모델로 돌린 결과의 품질 — 모델을 부르는 실측이 필요하다.
- 문서·지식 변경의 모델 완주 효과 — context 출력 증가는 쟀고, 줄 범위 읽기로 줄어드는 탐색·수정 왕복과 담당이 `문서 영향`·`지식 제안`을 지침대로 쓰는지는 모델 실행이 필요하다. 셸이 없는 조사·리뷰 담당은 `knowledge find`를 부를 수 없어 context 의 줄 범위와 문서 검색으로 찾는다. 검색은 낱말 단위라 조사가 붙은 형태는 별칭·키로 보완한다.
- 연결 준비의 모델 행동 — 모델이 수정 루프에서 발견을 남기고 반영 준비에서 경험을 고르는지(유료 평가), 다른 PC 의 동의 적용·실행 중 배정의 프로세스 생존(러너 몫), 민감 정보 꼴 검사가 놓치는 자격 증명 형식. 실제 러너·상위 조정자와의 왕복(이 저장소에 없다). 상위 조정자와의 왕복은 뒤에 `code-agent.master` v1(`master call`)로 [master 연동 기록](2026-10-15-master-control.md)에서 실제 Claude 로 확인했으나, 이 기록의 `status --json` 대조·경험·발견 계약을 러너가 쓰는 왕복은 확인하지 않았다.
- 재시도 줄이기의 효과 — 실제 모델로 첫 시도 통과율·규칙별 거부·작업당 토큰을 변경 전후로 재지 않았고 토큰 절감을 주장하지 않는다. `usage`의 첫 시도 통과·거부 규칙·재배정과 토큰 표를 같은 시나리오·호스트·모델로 비교해야 한다(유료 평가). `ca-test/tc-names.md`의 Jest·Vitest·JUnit 5 줄은 보고서 이름 규칙에 따른 안내이고 그 러너로 실행해 보지 않았다.
- 대상 프로젝트의 설치본은 갱신하지 않았다 — 이 저장소의 변경은 `code-agent update --templates-only --host <호스트>`와 호스트 재시작 뒤에 적용된다([설치 §5](../install.md#5-code-agent-update--갱신)).

## 남은 일

- 교차 리뷰·계획 검토 전용 추론 강도(medium)와 synthesis writer 강도(low) — 같은 입력의 A/B 로 품질 영향을 잰 뒤 정한다(유료 평가. 역할 정책을 바꾸면 model 동의의 정책 지문도 바뀐다).
- 문서·지식 — 같은 요구를 기준(`43c77cf`)·지금 빌드로 완주시켜 `usage`의 문서 탐색·토큰·재배정을 비교한다(유료 평가).
- 연결 계약의 상대편 — 러너: 실행 직전 `status --json --expect-state <v> --expect-work <ID> --expect-attempt <시도>` 재조회(종료 코드 3 이면 실행하지 않는다), `ready` 일 때만 기존 재개 경로로 세션을 띄움, `ownership-conflict`·`wait` 의 프로세스 생존 확인과 사람 확인 뒤 `takeover`, 실행 로그·종료·취소, `--run-id` 상관관계. 상위 조정자: 저장소별 `status --json`·`finding list --json` 수집, 사람 판단 코드의 연결, 분류 c 의 관련 프로젝트 확정·서비스 간 조정, 재배정·PR 중복 방지·전체 복구 — 전달한 조직 ID·승인 문자열은 권한이 아니다.
- 재시도 줄이기 — 실제 모델로 변경 전후를 비교한다(`scripts/evaluate-full-flow.cjs`, 실행 여부는 사람이 정한다). 규칙 식별자는 계획 문서·결과 검사에만 있고 검증·리뷰 단계 실패는 원인 분류(`failure.class`)로만 센다. 리뷰 지적 수정은 수정 배정 파일이 없어 지적 id·파일·근거를 메인이 넘긴다(⑨ 표가 원천). 초안 이어 쓰기 수는 초안이 남은 채 재배정한 수이고 담당이 실제로 이어 썼는지는 세지 않는다. Windows 작업 트리(autocrlf)에서 설치한 Codex 에이전트 TOML 의 지침 문자열에 `\r` 이스케이프가 들어가는 문제는 이 변경 전부터 모든 에이전트에 있던 것으로 고치지 않았다.
