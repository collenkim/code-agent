# 오류 사전 판별·질문 UI·맥락·토큰 결과 요약 (2026-10-12~14)

`5815323`..`8aec8c8`까지 열네 커밋(기록 정리 커밋 `ee6d9a4`·`89ec0f0`·`8597f90` 제외)의 변경 경위와 검증 결과다. 현재 동작은 [프로세스 흐름도](../process-flow.md)와 현행 문서가 기준이고, 여기에는 결정 근거·실제 호스트 확인·측정·예산 근거·확인하지 않은 것만 남긴다. 원자료는 [evidence/2026-10-13-result-summary.json](evidence/2026-10-13-result-summary.json)에 있다. 합친 기록의 원문은 git 이력에 있다(README 의 '지운 기록').

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

## 오류 사전 판별 (`5815323`)

- 요청: Sentry 오류 → 판별 → 코드 변경 필요 → Jira 생성 → 수정. 자동 서비스 연결 전에 작업 절차부터 검증하고 기존 직접 fix·feature·refactor 접수는 유지한다.
- `ca-fix`의 Sentry·로그 진입과 `triage` CLI만 더했다 — 새 단계·서브에이전트·동의 동작은 없다. 판별 중에는 초안 밖 쓰기·일반 셸·알려진 외부 MCP 쓰기를 막고, 원인과 코드 변경 필요 여부를 따로 판단한다. 코드 근거는 실제 경로·줄 인용·파일 해시로 대조하고, 불필요·판단 보류·중복 미조회는 Jira 준비와 인계를 막는다.
- Jira 생성·조회는 사람이 한다. CLI 는 본문·추적 표지를 렌더하고 사람이 확인한 키·URL 을 연결할 뿐 원격 티켓의 실재를 인증하지 않는다(자격 증명·네트워크 어댑터 없음).
- 중복 판별(`errorFingerprint.ts` v1)은 예외·스택이 있는 로그만 자동으로 한다. 이벤트·요청·추적 ID 와 ISO 시각은 정규화하고 숫자·오류 코드·스택은 보존한다. 불충분·유사 로그는 후보 비교를 요구하고 버리지 않는다. 접수 횟수는 Sentry 의 발생 횟수가 아니다. 같은 저장소의 중복 조회와 새 조사 예약은 한 잠금 안이다.
- 로컬 반영은 '배포 대기'이며 배포 완료를 추정하지 않는다. `deployed`는 사람이 확인한 버전·근거를 적고, 같은 배포 버전의 재발은 새 조사, 다른 버전·버전 불명은 관계 확인으로 가른다(버전 대소를 추측하지 않는다).
- 용어: 실행 명령(`/ca-fix`·`$ca-fix`), 작업 ID(외부 식별자 재사용 또는 `WORK-0001` 발급), 외부 업무 식별자(Jira 키·Notion 페이지 ID), 조사 ID(판별 기록 — Jira 키와 다름). 판별의 외부 연결은 Jira 전용이다.

## 차단 복구와 질문 도구 (`fe843a5`·`c7385c4`·`bcc0f00`)

- 일괄 중지 지침을 원인별 복구 선택으로 바꿨다. 공통 문서 누락은 작성·기존 문서 연결·보류, 미확정은 확정 동의·보류. 작업 중 문서 보완은 기존 abort 동의 뒤 같은 지시서로 다시 시작해 계획·승인을 다시 검증한다 — 중단 없는 문서 쓰기나 강제 복귀는 만들지 않았다. 외부 권한·hook 은 읽기 전용 진단과 사용자 설정 확인으로만 잇고, 모델이 권한 경계를 풀 수 있다고 안내하지 않는다.
- 차단된 동작만 멈추고 허용된 도움말·상태 조회와 이미 고른 방향은 재확인 없이 잇는다(`planning --help` 거부 뒤 `code-agent help`에도 확인을 요구하던 사례). 명시적 취소·보류는 되묻지 않는다.
- 17개 진입의 질문 공통 문단을 같은 글자로 맞췄다. 글머리표 출력은 도구 호출이 아니다 — 도구가 없거나 거부될 때만 대화로 번호 선택지를 받고, 대화 답은 승인이 아니다.
- 단계별 선택 표는 필요할 때 읽는 `ca-answer/reference.md`에 둔다. 매 단계 강제 질문 목록이 아니다. Stop 은 마지막 응답의 '선택지 없는 특정 문구 입력 요구'만 한 번 교정한다(인용 로그·코드·동의 안내 제외). 의미 전체를 판정하지 않고, 목록 항목 둘 이상이 적절한 후보를 보장하지도 않는다.

## Windows 명령 (`fb8bd01`·`729abe7`)

- UZRF-392 접수 중 `code-agent.cmd status`가 셸 허용 목록에서 거부됐다. `decide` 진입에서 맨 앞의 `code-agent.cmd`만 기존 이름으로 정규화한다 — 교차 자식·읽기 전용 담당·임대·동의 결속·티켓 발급보다 먼저. 인자·연결 문자는 그대로 보고 경로·래퍼를 새로 허용하지 않는다.
- `code-agent read`가 npm 의 `.ps1`로 실행 정책에 막힌 사례 — hook 만 고쳐서는 지침의 명령 선택이 바뀌지 않아, Codex 지침과 CLI·hook 의 파일 도구 안내에 PowerShell 은 `.cmd`라고 적었다. 실행 정책은 바꾸지 않고, 동의 대화 메시지(`consent respond`)는 그대로 둔다. 이 안내는 메인이 늘 싣는 AGENTS.md 블록과 하위 에이전트 지침에 둔다 — 스킬 사본마다 붙이던 꼬리말은 `1ededc0`에서 뺐다.

## 동의와 선택 UI (`e564bff`·`188acda`·`b2fd2b7`)

- Windows Codex 셸이 환경변수로 주입한 현재 저장소·하위 경로의 `safe.directory`(출처 `command line:`)가 스냅샷에 들어가, 그 환경이 없는 응답 hook 에서 'Git 설정 변경'으로 거부됐다. 그 두 값만 빼고(경로는 구분자·대소문자 정규화) 설정 파일의 신뢰 경로, 다른 경로·`*`, 사용자·hook·서명 설정 변경은 계속 동의를 무효화한다.
- Codex 의 번호 나열·응답 문자열 복사는 방향키 선택 UI 가 아니었고, `request_user_input_async`의 `accepted`는 화면 표시·사용자 답을 증명하지 않았다. 업무 질문은 `code_agent.ask`, 동의는 `code_agent.confirm`(ID 만 받음 — PreToolUse 의 일회용 질문 티켓을 소비하고 서버가 폼 응답을 직접 받아 `codex-elicitation`으로 기록)으로 옮겼다. 취소·거절은 보류, 미응답·잘못된 응답·연결 오류는 승인하지 않는다. 커밋이 들어가는 동의는 `.git` 쓰기가 막힌 샌드박스에서 첫 finish 부터 호스트 권한 요청을 쓰고, 실패한 ID 를 다시 실행하지 않는다.
- 동의 질문에 요약 전문을 실어 두 호스트 모두 확인 내용과 질문 줄을 함께 볼 수 없었다(아래 실측). 질문에는 앞부분·생략 줄 수·전문 파일(`consents/confirm-<내용 해시>.md`) 경로·질문 줄만 10줄 안에 싣고, 화면을 넘는 업무 질문은 표시 전에 돌려보낸다.

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

별도의 Context & State Manager 나 외부 AI 프레임워크가 필요한지 검토했다. 상태 파일·잠금·작업 임대, `code-agent context`, 배정 파일 전달, 세션 시작 상태 주입, 템플릿 예산, 동의 `--for` 출력이 이미 나뉘어 있어 새 관리자는 만들지 않았다. 대부분의 에이전트 프레임워크는 LLM 루프를 직접 소유해야 해서 호스트 위에서 도는 이 구조와 맞지 않는다. 대신 빈곳을 채우고, 프레임워크 사용 여부는 사용자가 그 뒤에 다시 판단하기로 했다.

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

- 요구 확정 동의를 `finish`로 적용하면 진행 중인 작업이 없고 그 ID 를 접수 중일 때 그 자리에서 `start`를 부른다. 기준 브랜치·대상은 접수 세션의 값이다(손으로 쓴 지시서만 있고 접수 세션이 없으면 시작 인자를 알 수 없어 시작하지 않는다). 결과에 `started`(시작 줄·브랜치 줄 — 상태 줄은 `next`가 맡는다)와 `phase: analysis`가 붙는다.
- 시작하지 않는 경로: 반려, `apply`, 사람의 TTY `confirm request`, 진행 중인 작업의 재확정. 다시 `finish`해도 다시 시작하지 않는다(계획 승인 뒤 이동과 같은 규칙).
- 브랜치 생성이 동의 안으로 들어오므로 확인 화면(summary)에 만들 브랜치·기준(이미 있으면 전환)과 시작을 막을 미커밋 변경을 싣는다. 요구사항 확인 문구(`decideRequest`가 띄우는 확인 화면)는 바꾸지 않았다 — TTY 확정이 같은 문구를 쓰고, 적용 때 준비한 확인 화면과 글자 그대로 대조하기 때문이다.
- 시작이 막히면(미커밋 변경·hook 누락·대상 여럿 등) 확정은 남기고 `startBlocked`(사유)와 `next`(`code-agent start <지시서>`)를 낸다. 자동으로 다시 시도하지 않는다 — 막는 사유 대부분이 사람이 할 일이다.
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
| 흐름 합계 Claude · Codex | 51,700 → 52,200 · 49,500 → 52,300 | 위 진입 문장의 합. 가장 클 때 53,200·53,400 이었고 템플릿 중복을 줄인 크기에 다시 묶었다 |

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

실패는 모두 0 이다. 생략 4개는 플랫폼 조건이다. Windows 샌드박스 안에서는 OS 사용자 정보 조회(`uv_os_get_passwd`)가 ENOMEM 으로 실패하는 시험이 있어 전체·관련 시험을 샌드박스 밖에서 돌렸다. `consentScreens` T-15-1(2초 대기 뒤 캐시 생성)은 부하에서 한 번 실패한 뒤 단독·재실행에서 통과했다.

## 확인하지 않은 것

- 실제 cloud 저장소·Sentry 이벤트·Jira 계정·배포 연동 — 판별 정확도와 티켓 생성은 합성 입력으로만 시험했다. 중복 상태는 로컬 체크아웃에만 있어 여러 PC·서버에는 공용 저장소와 원자적 예약이 필요하다.
- 실제 대화에서 차단 → 복구 선택 → 재개까지의 흐름, Claude 동의 화면에서 답 → 적용까지(표시만 실측).
- 접수부터 반영까지의 실제 모델 완주(`scripts/evaluate-full-flow.cjs`) — 유료 평가라 실행은 사람이 정한다. 리뷰 재검토 범위의 실제 회차 비용·품질도 이 실측에 달려 있다.
- 임대 넘겨받음 줄 수정의 실제 호스트 재확인.
- Codex hook 의 `agent_id`가 하위 에이전트 기록의 thread id 와 같은지 — 다르면 Codex 배정별 표가 빈다.
- 결과 파일·미리 넣은 문서·context 근거 줄을 담당이 지침대로 쓰는지, 요구 확정 적용 뒤 메인이 `started`·`startBlocked`를 읽고 잇거나 멈추는지(모델 행동)와 그 실제 토큰 효과 — 모델 완주 실측이 필요하다. Codex Windows 샌드박스에서 훅이 만든 배정 폴더·문서 사본을 `apply_patch`로 고칠 수 있는지도 확인하지 않았다(거부되면 `{path, content}`로 낸다).
- surveyor 가 초안을 `doc/.survey/`에 쓰고 경로만 돌려주며 writer 가 그 파일을 읽는지(모델 행동)와 실제 도입의 토큰 효과, 교차 형식 교정을 writer 모델로 돌린 결과의 품질 — 모델을 부르는 실측이 필요하다.
- 대상 프로젝트의 설치본 — 이 저장소의 변경은 `code-agent update --templates-only --host <호스트>`와 호스트 재시작 뒤에 적용된다.

## 남은 일

- 교차 리뷰·계획 검토 전용 추론 강도(medium)와 synthesis writer 강도(low) — 같은 입력의 A/B 로 품질 영향을 잰 뒤 정한다(유료 평가. 역할 정책을 바꾸면 model 동의의 정책 지문도 바뀐다).
