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
