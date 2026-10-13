# 토큰 최적화 — 측정 공백과 높은 효과 항목 (2026-10-13)

`f837f9d` 다음 변경의 경위와 검증 결과다. 현재 동작은 [프로세스 흐름도](../process-flow.md) §3.3·§5.1·§5.2·§6.3·§7·§8과 [사용 가이드](../usage.md)의 `code-agent usage`, [Codex 연동](../codex.md)이 기준이다.

## 배경

토큰을 더 줄일 수 있는 구간을 전수 검토했다(대화 보고). 사용자는 **측정 공백부터**, 그다음 **효과 '높음' 항목까지** 진행하라고 정했다. 중간·낮음 항목과 검토에서 함께 찾은 결함(아래 '남은 것')은 이번 범위가 아니다.

| 구분 | 항목 | 처리 |
|---|---|---|
| 측정 | hook 이 모델에게 낸 글(거부·차단·되돌림·세션 시작 주입)을 세지 않았다 | 반영 — `.code-agent/log/hooks.jsonl`에 길이·해시만 남기고 `usage`가 이벤트별로 센다 |
| 측정 | 교차 실행의 Claude 캐시 토큰·Codex 토큰이 `usage`에 나오지 않았다 | 반영 — 재시도 절에 Claude 토큰 넷과 Codex `tokens used`를 따로 싣는다 |
| 측정 | Claude 교차 자식의 대화 기록이 저장소 기록 폴더에 남아 `usage`가 메인으로 셌다 | 반영 — `--no-session-persistence` |
| 측정 | 서브에이전트 사용량을 역할로만 묶어 어느 배정·리뷰 회차가 비쌌는지 몰랐다 | 반영 — 작업 기록의 담당 id 로 `배정별`·`호출별 (배정)` 표 |
| 측정 | 접수부터 반영까지의 완주 기준선 | 하지 않았다 — 유료 평가(`scripts/evaluate-full-flow.cjs`)라 실행은 사람이 정한다 |
| H1 | `start`·`next`·`back`이 매번 전체 status 를 다시 찍었다(호출 수에 비례해 쌓인다) | 반영 — 옮긴 자리 요약 |
| H2 | 리뷰 2회차부터도 리뷰어·교차 리뷰가 계획 파일 전체를 다시 정독했다 | 반영 — 재검토 범위(바뀐 계획 파일·직전 지적) |
| H3 | Codex `code-agent read`가 들여쓴 JSON 이라 본문보다 크게 늘었다 | 반영 — 머리 한 줄 + `줄번호<탭>본문` |
| H4 | 템플릿 중복·드문 문장(ca-answer 참고 문서의 드문 절, 계획 스킬 4·5항과 `next` 줄의 중복, ca-feature 의 ca-next 읽기, Codex 스킬마다 붙던 꼬리말) | 일부 반영 — 아래 4절 |
| H5 | Stop 차단 목록에 상한이 없고 같은 사유로 턴마다 다시 막았다 | 반영 — 10줄 상한, 같은 세션·같은 사유는 한 번 |

## 1. 측정 공백

- **hook 출력 기록**(`hookLog.ts`): PreToolUse 거부(Claude `hook`, Codex `codex-event`), Stop 차단(두 호스트), 질문 도구 exit 2(동의 관찰 실패·화면 크기), 계획 담당·리뷰어 되돌림(Claude SubagentStop exit 2), SessionStart 주입을 `{at, host, event, kind, tool, chars, key, session, agent}`로 남긴다. 글 자체는 남기지 않는다(해시 앞 12자). `.code-agent/`가 있을 때만 쓰고, 2MB 를 넘으면 `.old`로 한 번 밀어내며, 쓰기 실패는 삼킨다. hook 경로 모듈이라 `layout`만 import 한다(`hookLoad.test.ts` 통과).
- **교차 토큰**: Claude 는 결과 JSON 의 입력·출력·캐시 쓰기·캐시 읽기를 이미 시도마다 남기고 있었고 출력만 하지 않았다. Codex 는 `codex exec`가 stderr 에 쓰는 `tokens used` 합계를 읽는다(`codexTokensUsed`). Codex `rust-v0.162.1` 소스 확인: `exec/src/event_processor_with_human_output.rs`가 `eprintln`으로 쓰고 값은 `blended_total`(캐시 아닌 입력 + 출력)이라 입력·출력으로 나뉘지 않는다. ANSI 색·천 단위 쉼표·같은 줄 `: N` 꼴을 받는다.
- **`--no-session-persistence`**: claude 2.1.296 `--help`에서 확인(`--print`와 함께만 유효). `doctor --cross`의 점검 목록은 인자에서 만들어지므로 자동으로 이 옵션도 본다.
- **배정별 사용량**: Claude 는 `subagents/agent-<id>.jsonl`의 id 를 `planning.json`의 담당 기록(`agents[]` — dispatchId 또는 시도의 agentId)과 `review.json` 회차의 `reviewers[]`에 잇는다. Codex 는 하위 에이전트 기록의 `session_meta.id`(thread id)를 같은 표에 잇는다 — **Codex hook 의 `agent_id`가 그 thread id 와 같다는 것은 실제 기록으로 확인하지 않았다.** 같지 않으면 Codex 배정별 표가 빈다(오류는 없다).

## 2. H1 — 커서 이동 출력

`start`·`next`·`back`은 전체 status 대신 작업·스테이지 흐름, implement 면 단계·Task, 계획 밖 변경 10개까지, status 와 같은 `다음:` 줄만 낸다. '이미 진행 중' 경로와 동의 중단 경로는 전체 status 그대로다.

스테이지 시험 fixture 에서 잰 출력 글자 수(옛 출력은 머리 줄 + 같은 자리의 전체 status):

| 자리 | 새 출력 | 전체 status |
|---|---|---|
| start | 410 | 620 |
| next → impact·design·plan | 253~284 | 615~646 |
| next → implement · Task | 289~297 | 751~762 |

실제 저장소의 status 는 문서 확인·hook·교차 안내 줄이 더해져 이보다 길다(검토 때 3개 Task 흐름에서 8회 7,497자).

## 3. H2 — 리뷰 재검토 범위

- `review`가 회차를 열 때 계획 파일별 바이트 해시(`files`)를 남긴다. 게이트(마지막 회차 트리 해시·열린 지적 0)는 바꾸지 않았다.
- 2회차부터 직전 회차와 이번 회차가 모두 `files`를 남겼고 직전 회차에 유효한 리뷰어 결과가 있으면, `review` 출력과 `context` ⑨ 절이 바뀐 계획 파일(20개까지)과 직전 회차 F 지적 줄을 싣는다. `ca-reviewer.md`는 바뀐 파일·호출자·테스트와 직전 지적부터 대조하고 바뀌지 않은 파일은 직전 판정을 이어받게 한다. 교차 리뷰 프롬프트도 직전 교차 결과가 있을 때 같은 범위를 싣는다.
- 옛 기록(`files` 없음)이나 직전 결과가 없으면 범위를 싣지 않고 전부 다시 본다.
- 판단: 리뷰 품질과 교환이다. 바뀐 것이 닿는 파일은 다시 읽고 새 지적을 낼 수 있게 했고, 교차 리뷰·게이트는 그대로라 받아들였다. 실제 모델로 회차 비용을 잰 결과는 없다(유료 평가).

## 4. H3·H4·H5

- **H3 `read`**: 200줄 기준 — `src/agent/review.ts` 본문 8,142자 → 옛 JSON 17,804자 / 새 꼴 8,920자. `ca-plan/SKILL.md` 4,506 → 7,056 / 4,710. `process-flow.md`(긴 줄) 34,221 → 43,924 / 34,999.
- **H4 템플릿**(LF 글자 수, `f837f9d` → 지금):

| 파일 | 전 | 후 |
|---|---|---|
| `ca-answer/reference.md`(질문·대기와 차단 때마다 읽는다) | 9,574 | 4,432 |
| `ca-answer/appendix.md`(5개 이상 선택지·동작 JSON·대상 변경·수동 대체 — 가리킬 때만) | — | 5,195 |
| `ca-analyze`·`ca-impact`·`ca-design`·`ca-plan` SKILL.md | 3,283·3,033·2,838·4,905 | 2,791·2,541·2,346·4,506 |
| `template/codex/ca-answer.md`(AGENTS.md 블록과 같은 두 문장 삭제) | 5,061 | 4,894 |
| Claude 흐름 합계(CLAUDE.block + 흐름 스킬 12) | 53,000 | 51,141 |

  - 계획 스킬 4·5항은 `next` 줄이 행동의 원천이라는 규칙만 남겼다(대기·`cancel`·되감기·재배정 한도·차단 지적을 줄마다 다시 설명하지 않는다). 네 스킬 2·3·4항 같은 글자 규칙은 그대로다.
  - ca-feature 는 `ca-next` 스킬 파일을 따로 읽지 않는다(그 표 6.6K 자가 흐름마다 실리던 것). ca-fix·ca-refactor 가 ca-feature 를 읽는 구조는 그대로다.
  - Codex 스킬 사본마다 붙던 PowerShell·`read` 꼬리말(368자)은 하위 에이전트 TOML 에만 붙인다 — 메인은 같은 두 문장이 든 AGENTS.md 블록을 늘 싣는다.
  - 늘어난 곳: ca-reviewer.md +135자(재검토 범위 한 줄), ca-review 5항 +36자. ca-answer SKILL.md 는 `appendix.md` 안내를 더하고 같은 폴더 경로를 줄여 8,699 → 8,679자다.
  - 예산(`templateBudget.test.ts`): 줄어든 계획 스킬 4개·`reference.md`·흐름 합계(Claude 53,200 → 52,200, Codex 53,400 → 52,300)를 지금 크기 ×1.03(합계 ×1.02)으로 다시 묶고 `appendix.md`를 더했다.
  - 하지 않은 것: 17개 스킬 머리의 공통 '질문·동의' 문단을 CLAUDE·CODEX 블록으로 옮기는 일. 같은 글자 시험·Codex 변환·블록 예산을 함께 바꿔야 해 이번에 하지 않았다.
- **H5 Stop**: 목록 10줄(`STOP_LIST_LIMIT`) + `외 N개`. 같은 세션에서 글이 같은 사유로 이미 막았으면 다시 막지 않는다(hook 출력 기록으로 판정 — 세션 id 가 없으면 옛 동작). 목록이 바뀌면 다시 막는다. 검토 때 계획 밖 파일 200개면 턴마다 10,588자였다.

## 5. 검증

- `npm run build`, `npm test`: 1,418개 중 1,414 통과, 실패 0, 생략 4(플랫폼 조건). 첫 전체 실행에서는 보조 문서 수(11 → 12)·Codex 설치 파일 수(37 → 38)·`read` JSON 을 가정한 시험·새 리뷰 시험의 커서 이동이 실패해 고쳤고, `consentScreens` T-15-1(2초 대기 뒤 캐시 생성)은 전체 실행 부하에서 한 번 실패한 뒤 단독·전체 재실행에서 통과했다.
- 새 시험: Stop 10줄 상한·같은 세션 재차단 억제·목록 변경 시 재차단(실제 `runStopHook`), PreToolUse 거부 기록(실제 `runHook` — 글은 기록에 없다), `usage`의 hook 출력 절·배정별 표·교차 토큰 줄, `codexTokensUsed` 꼴 넷, `start`·`next`·`back` 요약과 status 의 같은 `다음:`, 2회차 재검토 범위(`openRound`·`context`·`roundChanges`).
- 임시 git 저장소에서 실제 CLI(`node dist/agent/cli.js`): `init --host both`가 두 호스트에 `appendix.md`를 설치하고 Codex `ca-answer`에 PowerShell 문장이 없다. `read a.txt 2 2` → `a.txt · 2-3 / 전체 6줄` + 두 줄 + 이어 읽기 줄. Claude `hook`·Codex `codex-event` PreToolUse 거부가 각각 한 줄씩 기록되고(글자 수 244·253, 글 없음) `usage`가 `hook 출력` 절에 두 줄로 낸다.
- 실제 모델 실행(완주 평가·교차 실행)은 하지 않았다.

## 남은 것

- 검토의 중간·낮음 항목(critic 차단 계획의 교차 선실행, 재작업의 문서 전체 재작성, 분석·설계 입력의 테스트 전략·품질 문서, 구현 Task 의 03·04 재읽기, 계획 결과 JSON, 왕복 수, `verify --json` 실패 줄 상한, bash 거부 문구 길이, 동의 finish pending 의 요약 반복 등).
- 검토에서 함께 찾은 결함: `argument-hint` 값이 `[`로 시작하는 스킬 5개(ca-request·ca-analyze·ca-feature·ca-fix·ca-refactor)의 머리말 YAML 이 깨져 스킬 목록 설명이 공통 문단으로 보이는 문제, `init`이 모르는 인자(`--help` 포함)를 받아도 설치를 진행하는 문제.
- Codex 배정별 사용량의 thread id ↔ hook `agent_id` 대응 실측, 완주 기준선 측정.
