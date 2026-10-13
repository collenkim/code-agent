# 맥락·상태 빈곳 보완 (2026-10-13)

`f6a8b72` 다음 커밋의 변경 경위와 검증 결과다. 현재 동작은 [프로세스 흐름도](../process-flow.md) §5.1·§5.2·§6.1·§7과 [Codex 연동](../codex.md)·[계획 작업](../planning.md)이 기준이다. 원자료는 [evidence/2026-10-13-context-gaps.json](evidence/2026-10-13-context-gaps.json)에 있다.

## 배경

별도의 Context & State Manager 나 외부 AI 프레임워크가 필요한지 검토했다(대화 보고). 상태 파일·잠금·작업 임대, `code-agent context`, 배정 파일 전달, 세션 시작 상태 주입, 템플릿 예산, 동의 `--for` 출력이 이미 나뉘어 구현돼 있어 새 관리자는 만들지 않았다. 대부분의 에이전트 프레임워크는 LLM 루프를 직접 소유해야 해서 호스트(Claude Code·Codex) 위에서 도는 이 구조와 맞지 않는다. 대신 빈곳 네 가지를 먼저 채우고, 프레임워크 사용 여부는 사용자가 그 뒤에 다시 판단하기로 했다.

| 빈곳 | 처리 |
|---|---|
| 1. Codex 대화 압축 뒤 상태 재주입 | 반영 — 세션 시작 hook 이 Claude 와 같은 진행 상태를 붙인다 |
| 2. CLI 출력 크기 | 측정 뒤 이상값 하나(계획 상세 조회)만 고쳤다. 일괄 상한은 두지 않았다 |
| 3. 완주 실측 | 하지 않았다 — 유료 평가라 실행은 사람이 정한다 |
| 4. Codex 계획 담당 결과가 메인 대화를 거침 | 반영 — Codex 담당도 staging 에 쓴다. 실측에서 찾은 Windows 샌드박스 폴더 권한 문제로 staging 폴더는 담당 시작 hook 이 만든다 |

## 1. Codex 세션 시작 상태 주입

- 근거: Codex `rust-v0.162.1` 소스 — SessionStart 입력의 `source`는 `startup`·`resume`·`clear`·`compact`·`fork`이고, 출력 `hookSpecificOutput.additionalContext`(일반 stdout 도)는 developer 메시지로 다음 턴에 붙는다(`codex-rs/core/tests/suite/hooks.rs` `compact_session_start_hook_records_additional_context_for_next_turn`).
- 변경: `codex-event`의 SessionStart 분기가 Claude 와 같은 진행 요약을 Codex 표기(`$ca-…`, `ca_…`, `.agents/skills/…`)로 낸다. 교차 검증 자식 세션은 `{}`다.
- 실제 TUI(codex-cli 0.162.1, 임시 저장소, `--enable hooks --dangerously-bypass-hook-trust -s read-only -a never`): 시작 때 붙은 요약을 모델이 그대로 인용했다(`작업 ORD-1 (feature) · 스테이지 analysis · 계획 미제출 …`). `/compact` 뒤 rollout 에 압축 전후 developer 메시지가 둘 남았고 두 번째에 압축 뒤 문장(`대화가 압축·비워졌다 — … .agents/skills/ca-answer/SKILL.md …`)이 있었다. 모델은 내부 맥락의 원문 복사는 거절하고 요약으로 답했다. 화면의 경고 2개 중 하나는 하네스 플래그(`--enable`) 때문이었고, 다른 하나는 열어 보지 않았다.
- 비대화형 `codex exec`에서도 같은 요약이 붙었다(아래 4의 실측 hook 기록).
- 발견: 압축·재개마다 '작업 진행 기록을 넘겨받았습니다(이전: …)' 줄이 되풀이됐다. 임대 갱신이 이전 보유자 기록을 그대로 두기 때문이다. 같은 세션이 이미 쥐고 있던 임대면 넘겨받음 줄을 내지 않게 고쳤다(Claude 에도 해당). 단위 시험으로 확인했고 실제 호스트에서 다시 보지는 않았다.

## 2. CLI 출력 크기

전체 시험(1,411개)을 측정 전용 preload 로 돌려, 시험 코드가 직접 부른 명령 함수의 반환 글자 수 5,620건을 모았다(저장소 코드는 바꾸지 않음).

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

- 판단: 대부분 3K 자 아래이고, `doctor`는 사람이 돌리는 진단이며, 동의 출력은 `7ade5a6`에서 이미 줄였다. 일괄 상한·잘라 내기 장치는 두지 않고 이상값만 고쳤다.
- 변경: 상세 조회가 기록된 문서 파일과 글자가 같은 본문을 `{path, hash, chars, inFile: true}`로 줄인다. 같은 시험에서 47,513 → 2,572자, 나머지 상세 조회도 4.1K → 3.2K 안팎. 기록 뒤 파일이 바뀐 경우(시험의 47,514자)는 관찰된 본문을 그대로 싣는다 — 대조 근거를 잃지 않으려고.

## 3. 완주 실측

`scripts/evaluate-full-flow.cjs`는 실제 모델로 접수부터 반영까지 도는 유료 평가라 이번에 돌리지 않았다. 실행 여부와 범위는 사람이 정한다.

## 4. Codex 계획 담당 staging

- Codex 담당이 본문을 결과 JSON 에 싣게 한 근거는 'hook 에 하위 에이전트 식별자가 오지 않는다'였는데, 0.161.0 실측에서 이미 PreToolUse·SubagentStart·SubagentStop 입력에 `agent_id`·`agent_type`이 왔다. 그런데도 Codex 담당의 문서 본문이 메인 대화를 거쳤다.
- 변경: 배정 계약을 두 호스트 같게 staging 으로 하고, 지침 문구의 쓰기 도구는 CLI 표기(Claude `Write/Edit`, Codex `apply_patch`)로 낸다. Codex 사본은 담당 에이전트 문장의 쓰기 도구만 바꾼다. 메인이 staging 을 대신 쓰는 것과 담당의 staging 밖 쓰기는 계속 거부한다. 쓰기가 거부되면 `{path, content}`로 낸다.
- 평가 스크립트(`scripts/evaluate-planning-hosts.cjs`) 보정: 설치 hook 수를 5 에서 `CODEX_EVENTS` 길이(세션 시작 포함 6)로, 사용자 설정의 `[hooks.state]`(호스트가 기록한 hook 신뢰 상태)를 인라인 hook 으로 보던 오판을 제외, 캡처 래퍼 명령 끝에 `codex-event`를 붙여 `status`가 hook 누락으로 보지 않게 했다. 보정 전 실행에서는 모델이 'Codex 훅 6종 누락'을 보고 담당을 부르기 전에 멈췄다(올바른 중단).
- 실제 확인(`evaluate-planning-hosts.cjs codex … --vetted-hooks`, 메인·`ca_analyst` 모두 gpt-6.1-sol, 분석 단계만):

| 실행 | staging 쓰기 | 담당 결과 | 메인에게 간 결과 메시지 |
|---|---|---|---|
| 1회(`staging2`) | hook 허용 → Codex `apply_patch`가 `Failed to create parent directories`로 실패 | `{path, content}`로 대체, 기록·게이트 통과 | 3,409자(artifacts 1,838자) |
| 2회(`staging3`, hook 이 폴더 생성) | hook 허용 → 성공 | `{path, staged}`, 기록·게이트 통과, 배정 폴더 삭제 | 1,624자(artifacts 145자) — 문서 2,358자는 메인을 거치지 않음 |

- 원인(Windows 샌드박스): `planning advance`가 샌드박스 셸에서 `.staging`을 미리 만들었는데(소유자 `CodexSandboxOffline`), 그 작업 공간의 첫 `apply_patch`가 저장소 루트에 더한 쓰기 SID 권한이 그 폴더로 퍼지지 않았다. 사용자 소유 폴더에는 퍼졌다. Codex 소스(`windows-sandbox-rs/src/cap.rs`)는 SID 를 명령 cwd 별·쓰기 루트별로 따로 둔다. 작은 저장소 실험으로 확인했다 — 첫 `apply_patch` 전에 셸이 만든 폴더는 그 뒤 세션에서도 `apply_patch`로 쓸 수 없고, 첫 `apply_patch` 뒤에 셸이 만든 폴더와 새 폴더는 쓸 수 있다. `%TEMP%` 아래에서는 재현되지 않았다.
- 처리: staging 폴더(`.gitignore` 포함)는 샌드박스 밖에서 사용자 권한으로 도는 담당 시작 hook 이 만든다(두 호스트 같다). Claude 로 접수하고 Codex 로 계획을 잇는 두 호스트 설치에서는 Codex 의 첫 `apply_patch`가 계획 단계에서 일어날 수 있다(실제로 관찰한 것은 평가 스크립트의 경우뿐이다).
- 고치지 않은 것: 같은 조건에서 CLI 가 셸 안에서 만드는 접수 폴더(`doc/work/<ID>/`)와 도입의 지식 문서 뼈대도 막힐 수 있다. 호스트 결함이고, CLI 가 셸 안에서 만드는 폴더·파일을 모두 hook 으로 옮길 수는 없어서(지식 문서 뼈대는 CLI 가 내용을 쓴다) [Codex 연동](../codex.md)에 조건과 우회(처음 쓰는 저장소는 `apply_patch`를 한 번 쓴 뒤 시작, 막힌 폴더는 사람이 지우고 다시 만듦)만 적었다.

## 검증 수치

- 전체 `npm test`: staging hook 변경 전 1,411개 중 1,407 통과·실패 0·생략 4(212.7초), 변경 뒤 같은 수(272.5초).
- 템플릿 예산: 올리지 않았다. Codex 흐름 합계 53,396 → 53,208자(staging 대체 문장이 빠짐), Claude 흐름 합계 53,000자.
