# 최적화 — hook 지연 로드·동의 왕복·계획 연쇄·측정·템플릿 예산·테스트 분할

기준일: 2026-10-08. 기준 커밋: `4b1333b`(C4 독립 검토 반영 — C1~C6 병합 뒤). 감사 [2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)의 C7 묶음(OPT-1·2·3·4·6·11·14·15·16, PVR-19)을 구현한다. 현재 동작은 [프로세스 흐름도](../process-flow.md)가 정본이다.

사용자 결정: 최적화는 진행하되 작은 작업용 경량 경로(HX-5)는 제외한다. 자가 학습은 보류한다 — 측정은 기록을 읽기만 하고 교훈·retro 같은 환류를 만들지 않는다. 사람 확인 지점(요구 확정·계획 승인·결과 반영)은 줄이지 않는다 — 연쇄 모드도 계획 승인을 건너뛰지 않는다. 연쇄는 실패(`failure`)가 생기면 즉시 멈추고 자동으로 다시 시도하지 않는다.

## 기준 측정(S0, `4b1333b`)

- `npm test`: 1197개 중 1193개 통과·실패 0·생략 4, `duration_ms` 207,052(Windows, 같은 PC 에서 측정 도구를 함께 돌림).
- hook 프로세스 전체 시간(spawn~종료, 21회 중앙값, Node 24.19, `init --host both` + 관찰 흐름 작업 시작 sandbox — `scratchpad/sandbox-stage6/hooktime.cjs`): PreToolUse Read 105ms·Bash `code-agent status` 104ms, Stop 85ms, SessionStart 93ms, SubagentStart(계획 담당 아님) 87ms, Codex PreToolUse 112ms·UserPromptSubmit(일반 메시지) 104ms·Stop 111ms.
- hook 진입 모듈 그래프(dist 모듈 수, zod 79 파일 별도 — `graph.cjs`): `hook.js` 63, `codexHook.js` 69, `stopHook.js` 28, `sessionHook.js` 34. `hook.js` 가 `consent.ts` 를 정적으로 읽어 commands·deliver·validate·sourceUpdate·plugins/commands·init 까지 끌어왔다.

## OPT-15 — hook 기동 시간

| 바꾼 것 | 근거 |
|---|---|
| `hook.ts` 가 `consent.ts` 를 셸 명령이 `code-agent consent apply\|finish ` 꼴일 때만 읽는다(`consentCommandGuard`). 접두어가 가드 정규식보다 넓어 가드가 보던 명령은 모두 가드를 지난다 | 가드는 그 꼴에서만 결과를 낸다 |
| `codexHook.ts` 는 `hook.ts` 만 정적으로 읽고 이벤트별 모듈을 그 분기에서 읽는다 — Subagent `planningHook`·`reviewHook`, Stop `stopHook`, UserPromptSubmit 은 `code-agent consent respond` 로 시작할 때만 `consent.ts` | 사용자 메시지마다 도는 이벤트에서 동의 그래프를 읽지 않는다 |
| `request.ts` 가 `init.ts` 를 접수 시작(`requestBegin` 의 `requireStartHooks`)에서만 읽는다 | hook 이 `loadRequestSession` 때문에 `request.ts` 를 읽는다 |
| `hookLoad.test.ts`(새, 21개) — hook·codexHook·stopHook·sessionHook 그래프에 명령 모듈(`HEAVY` 13개)이 없음(SessionStart 만 hook 누락 경고 때문에 `init` 허용), `retryPolicy` 순수성, `cli.js stop` 이 `cliMain` 을 읽지 않음, 실행 경로(작업 중 Bash `code-agent status`·Codex 일반 메시지는 `consent.js` 를 읽지 않고 `consent finish <UUID>` 는 읽어 가드를 돈다), 모듈 로드 실패 12행이 `hookFailureExit(hookFailureInput(...))` 와 같은 종료 코드·stdout | — |

`cli.ts` 지연 로드 진입(`HOOKS`·`runHookCommand`)과 `hookFailureExit` 연결은 C5 가 이미 했다(명세 §3.1.1·3.1.2 는 그대로 있었다).

| 측정 | S0 | 뒤 |
|---|---|---|
| `hook.js` dist 모듈 | 63 | 45 |
| `codexHook.js` dist 모듈 | 69 | 46 |
| PreToolUse Read / Bash status / Bash git diff | 105 / 104 / 105ms | 95 / 95 / 95ms |
| Codex PreToolUse / UserPromptSubmit / Stop | 112 / 104 / 111ms | 97 / 93 / 96ms |
| Stop·SessionStart·SubagentStart | 85·93·87ms | 85·93·88ms(바뀌지 않음 — 원래 명령 모듈을 읽지 않았다) |

남는 고정 비용은 zod(79 파일, `core/manifest.ts`)와 Node 기동이다. hook 전용 번들은 명세대로 미룬다(설치 세 경로의 hook 명령 문자열이 갈린다).

## OPT-6 — 측정(읽기 전용)

| 바꾼 것 | 비고 |
|---|---|
| `usage` 가 토큰 표 뒤에 호출 통계를 낸다 — `호출별 (스테이지)`·`호출별 (에이전트)`(요청·도구 호출·도구 결과 글자), `도구별 호출`·`code-agent 명령별 호출`·`스킬 읽기` 줄 | 기존 세 표와 꼬리 두 줄은 한 글자도 바꾸지 않았다(P8 `table()` 기대값 그대로). 새 절은 `$` 를 쓰지 않는다 |
| `retryReport.ts`(새) — `.code-agent/work/<ID>/` 의 verify·planning·review·verification-flow 기록에서 `retrySummary` 카운터, 배정·재배정 수, 정해진 경로의 `failure.class`, 교차 시도 `usage` 합(C1 이 넘긴 몫). `--work` 가 없으면 동의 기록의 실패 원인 `(동의)` | 쓰기·환류 없음(시험이 기록 폴더가 그대로인지 본다). 카운터 이름표는 `COUNTER_LABEL` import(기반 인계 #7) |
| `codexUsage.ts`(새) — `$CODEX_HOME/sessions/**/rollout-*.jsonl` 에서 이 저장소 세션의 토큰·요청·도구 호출·도구 결과 | 이 PC 에 Codex 기록이 없어 **형식 미확인**(공개 형식 가정). 출력에 그렇게 적고 비용은 내지 않는다 |
| `usage --json`(`usageReport`), 모르는 깃발은 사용법으로 멈춤 | — |
| `scripts/evaluate-full-flow.cjs` 보고서에 `usageData`·`retry`·턴별 `numTurns`·`codexAgents`, scope 에 "동의 왕복은 fixture 라 usageData 에 없다". 새 `scripts/summarize-evaluations.cjs <시나리오> <label 접두어>`(n·평균·최소·최대, 파일을 쓰지 않는다) | 실제 모델을 부르는 평가 실행은 하지 않았다(사용자 결정 — 측정 도구만 준비) |

확인: 이 PC 의 실제 Claude 기록으로 `node dist/agent/cli.js usage --json` 이 JSON 을 낸다(이 저장소 기록 세션 1 — 요청 96·도구 호출 125·도구 결과 443,665자, 도구 Bash 61·Edit 28·Read 12). `summarize-evaluations.cjs new 2026` 은 기존 보고서 6개의 비용·소요만 내고 새 지표는 n=0 이다(옛 보고서에 `usageData` 가 없다).

## OPT-1·OPT-2 — 동의 왕복과 호스트별 출력

| 바꾼 것 | 비고 |
|---|---|
| `consent prepare --action <동작> [--id] [--kind] [--spec]` — 자유 문구가 없는 동작(`INLINE_ACTIONS` 10개)은 JSON 파일 없이 준비한다(동의마다 메인의 Write 1회가 준다) | 반려·model·plugin·judgment 는 파일 그대로 |
| 준비 인자 문법을 hook(`consentCommandOf`)과 CLI 가 같은 함수(`splitCommandArgs`·`parsePrepareArgs`)로 본다 — 문법이 틀린 명령에는 티켓이 나지 않고, CLI 는 티켓을 꺼내기 전에 사용법으로 멈춘다 | **명세와 다름**: 명세의 `prepareTicketKey`(인자 전체 키)는 만들지 않았다. C5 최종본의 준비 티켓이 인자와 무관한 저장소당 하나라(C5 인계) 키가 어긋날 수 없다 — 명세 §3.3.4 끝 문단의 처리(문법 검사만 hook·CLI 공용) |
| `--for claude\|codex` — 기록 `form` 에 남기고 prepare·status·finish CLI 출력에서 그 호스트가 쓰지 않는 필드를 뺀다(`renderConsentOutput`). `--for` 가 티켓의 호스트와 다르면 거부. `--for` 가 없으면 전체 그대로(옛 템플릿 호환) | 함수 반환은 전체 — Codex 응답 관찰(`observeCodexConsent`)·hook 은 그대로. `failure`·`warning`·확인 코드 줄은 남는다(C5 인계) |
| `consent finish` 적용 결과에 `phase`·`next` — `commands.ts` `nextStep`(status `다음:` 과 같은 값, status 출력 바이트는 그대로 — 기존 status 시험 전부 통과), 흐름을 멈추는 동작은 고정 문구(`AFTER_APPLY`). `finishConsent(root, id, caller)` 는 caller 를 그대로 넘긴다 | 적용 뒤 `code-agent status` 재호출 1회가 준다 |
| 템플릿: ca-answer 1·2·3·5·6·7항(인라인·`--for claude`·summary 처음 한 번·`toolInput.questions`·`next`), reference.md 한 줄, Codex ca-answer 동작 목록 뒤 인라인 문장·1·2·4항, ca-request 끝·ca-integrate 동의 문장(`toolInput` 지시 재수록 제거) | — |
| `consentOutput.test.ts`(새, 8개) — hook 판정 → CLI 자식 프로세스 왕복(Claude 인라인·Codex 파일), 깃발 순서·따옴표, 호스트 불일치·연결자·관찰 안 된 준비 거부, 인라인=파일, 문법 오류 5종과 티켓 없음, CLI finish 의 적용 티켓·caller 없는 거부, 멈추는 동작의 고정 `next` | — |

동의 준비 출력 글자 수(`scratchpad/sandbox-stage6/consent-size.cjs`, 새 Node 프로젝트):

| 동작 | 전체(`--for` 없음) | `--for claude` | `--for codex` |
|---|---|---|---|
| `setup` | 11,743 | 5,644(−52%) | 5,739(−51%) |
| `docs` | 6,379 | 2,962(−54%) | 3,057(−52%) |
| `docs --kind architecture` | 3,203 | 1,374(−57%) | 1,469(−54%) |

pending 이 이어지는 동의(문서·지식 선택)는 `finish` 마다 같은 비율로 준다. 적용 뒤에는 `code-agent status`(작업이 없는 저장소 623자, 작업 중 1~2K자) 한 번이 준다. 실제 흐름에서의 호출 수 감소는 유료 평가를 돌리지 않아 미측정이다(평가 드라이버는 동의를 TTY fixture 로 대신해 원래 이 왕복을 재지 못한다 — OPT-6 의 `consent prepare`·`consent finish`·`status` 명령별 호출로 실제 세션에서 잰다).
