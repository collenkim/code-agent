# 전체 검토 반영과 흐름도·코드 대조 시험 (2026-10-08)

감사([2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)) 뒤 구현 전체(`ff13950..934e5fe` — 공통 재시도 규약 모듈, C2 계획, C3 검증, C6 역할별 모델, C1 리뷰·교차, C5 동의, C4 단계·CLI·임대, C7 최적화)를 네 관점(e2e·재시도 규약·hook·문서)으로 독립 검토한 지적 43건을 처리했다. 지적마다 코드로 확인하고, 맞으면 고친 뒤 회귀 시험을 더했다. 시험은 수정을 되돌리면 실패하는 것까지 확인했다. 틀린 지적은 근거를 적고 반영하지 않았다. 사용자 결정을 바꾸는 수정은 하지 않고 아래 '사용자 결정'에 남겼다 — 그 셋(E2·E16·E20)은 2026-10-08 사용자 결정을 받아 끝 절 '사용자 결정 반영(D1~D3)'에서 처리했다.

## 방법

- 기준은 `934e5fe`다. 실험은 작업 scratchpad 의 `sandbox-stage7-final/` 임시 저장소에서 했다. 이 저장소 루트에는 init 하지 않았다.
- 실제 Claude·Codex 모델은 부르지 않았다. 교차 실행은 가짜 호스트 실행 파일(`CODE_AGENT_CLAUDE_BIN`·`CODE_AGENT_CODEX_BIN`)로 확인했다. `code-agent update` 는 쓰지 않았다.
- 회귀 시험은 주로 [`fullReview.test.ts`](../../src/test/fullReview.test.ts)에 있다(임시 git 저장소 `stageFixture` 에 실제 함수를 부른다). 나머지는 기존 주제 파일에 더했다. 시험 이름에 지적 번호(E1~E43)를 붙였다.
- 사용자 결정(절차 결함 보완, 실패 원인별 재시도 규약, 최적화 — HX-5 제외, Claude 역할별 모델, 자가 학습 보류, 사람 확인 지점 셋 유지, 교차 실행 불가 시 중지 기록 후 진행, 두 호스트 설치 시 교차 필수)은 그대로 두었다.

## 지적과 처리

상태: **반영**(지적대로 고침) · **일부**(핵심을 고치고 남은 부분을 적음) · **결정**(사용자 결정 필요 — 코드는 바꾸지 않거나 최소안만) · **반영(사용자 결정 2026-10-08)**(결정을 받아 처리 — 끝 절).

### e2e (E1~E12)

| 번호 | 지적 | 상태 | 처리 | 시험 |
|---|---|---|---|---|
| E1 | 환경 오류로 진단 노드일 때 `다음:`·허용 적용 뒤 next 가 `verify --json`(재실행 없음)을 안내한다 | 반영 | `nextHint` check·test 갈래가 진단(전제 조건 제외)이면 `code-agent verify --json --retry` | fullReview E1 |
| E2 | 작업 중 `model` 동의가 커밋된 설치 파일을 바꿔 계획 밖 변경이 되고, 빠져나갈 길이 없다 | 반영(사용자 결정 2026-10-08) | 결정 D1: 진행 중인 작업(접수 세션부터 반영·종료 전까지)이 있으면 역할 모델·추론 강도 변경을 거부한다. 동의 준비(질문 전)·동의 적용 시점 재확인(대상 변경으로 폐기)·터미널 `code-agent model <역할> <모델>`(TTY 확인 전)이 같은 `model-in-work` 문구(`models.ts` `requireNoWorkInProgress`)를 쓴다. 조회는 연다. 경고 `modelWorkWarning`은 지웠다. doctor '에이전트 모델' ✗ 안내는 작업 중이면 작업이 끝난 뒤 `update --templates-only` 를 말한다(검토 반영 때는 경고만 냈다) 반박 검증(G3·G4)으로 doctor 'Codex 스킬·에이전트' 안내와 모델 표의 변경 줄도 같은 규칙으로 고쳤다 | fullReview D1(E2) 7개 · D1 doctor(Codex)·모델 표(반박 검증) |
| E3 | 교차 설정 오류·결과 형식 오류 재실행 한도를 다 쓴 뒤에도 '한 번 더 실행할 수 있습니다(남은 0회)' | 반영 | `cross-config-error`·`cross-result-invalid` 에 `exhausted` 안내 변형, 남은 수 0이면 그 문구 | crossReview E3 |
| E4 | 한도를 다 쓴 교차 지점의 `다음:` 이 실행 명령을 맨 앞에 둔다 | 반영 | 리뷰·계획의 교차 줄이 `limit-exceeded` 면 실행 명령 없이 사람 판단만 | crossReview E4 · planning E4 |
| E5 | critic 뒤 계획 advance 가 `blocked: []` 와 일반 문구만 내고 교차 검토 명령이 없다 | 반영 | 교차 검토가 남았으면 blocked 사유·next 가 교차 명령 → 그다음 advance, `다음:` plan 갈래에도 교차 줄 | planningChain E5 · planning E5 |
| E6 | 출처 미확인 답이 '미결 질문 Q1' 로만 막혀 이유를 알 수 없다 | 반영 | `답 출처 미확인 Q1 — 질문 도구 응답이 관찰되지 않은 답…[Source]: 대화…`(`unverifiedAnswerHint`), status 미응답 줄에도 | planning E6 |
| E7 | 반영 확인 화면에 PR 본문(요약·확인 방법·위험·되돌리기)이 없다 | 반영 | `proseSectionLines` — 네 구역을 화면에 싣고 상한(`PROSE_SHOWN_LIMIT`)을 넘으면 잘림 표시 | fullReview E7 |
| E8 | 사람의 재실행 한도 허용이 ⑧·⑩·커밋 메시지에 드러나지 않는다 | 반영 | ⑧ `## 사람 허용` 절, ⑩ 검증 절 `사람 판단: 한도 허용(…)` 줄(변조 판정에도 포함), 커밋 메시지 사람 판단 줄 — 문구 원천 `grantText` | fullReview E8 |
| E9 | Codex 단일 설치에서도 배정 계약이 staging·`{path, staged}` 를 안내한다 | 반영 | `codexContract` — 담당 호스트가 Codex 면 staging 없이 `{path, content}` 와 '파일은 쓰지 말고' | planning E9 |
| E10 | 같은 코드 재실행 소진 `다음:` 에 사람 선택지가 없다 | 반영 | 소진 갈래마다 `사람이 고릅니다: 허용(ca-answer judgment retry-grant <키>) · 계획을 고쳐 재승인 · 작업 종료`, 허용이 없는 총 회차는 허용 없이 | fullReview E13·E14·E10 |
| E11 | 통합 검증 실패 뒤 `다음:` 이 진입 문구뿐이다 | 반영 | 실패 실행이 있으면 `<종류>(<결과>) — integrate 변형 안내(같은 회차 재실행·남은 수)` | fullReview E11 |
| E12 | 계획 승인 화면에 critic·교차 계획 검토 결과와 사람 기각이 없다 | 반영 | `planReviewLines` — `## 계획 검토` 절(critic 상태·차단 수, 교차 지점, 사람 판단)을 승인 화면에 | planning E12 |

### 재시도 규약 (E13~E23)

| 번호 | 지적 | 상태 | 처리 | 시험 |
|---|---|---|---|---|
| E13 | 통과 뒤 변경 회차가 리뷰 회차를 쓰지 않아, 리뷰 없는 루프는 허용 길이 없는 총 회차로만 막히는데 문구는 '한 회차 더 허용'을 낸다 | 일부 | (a)안 — `reviewRoundBudget` = 리뷰 회차 기록과 지금 묶인 회차의 통과 뒤 변경 수 중 큰 값. 총 회차 문구는 허용 선택지 없이(`no-grant` 변형). 원래 원인은 열린 지적이 있으면 `blocking-finding`, 없으면 `code-defect`(표가 통과 뒤 변경을 code-defect 행에 둔다). (b)안(총 회차를 허용 대상에)은 C5 설계가 뺀 것이고 리뷰 없는 루프가 여전히 리뷰 회차를 안 쓰므로 고르지 않았다 | fullReview E13·E14·E10 · verifyRetry |
| E14 | 리뷰 회차 소진의 허용이 review 단계만 받아, check 로 되감긴 뒤에는 허용할 수 없다 | 반영 | 허용 단계를 검증 단계 전체로. 리뷰 회차 기록이 없으면 그 사실을 알리는 Stop | fullReview E13·E14·E10 · consentBinding T-J-1 |
| E15 | 검증 명령(모델이 쓴 테스트)이 `review.json` 을 지우면 리뷰 회차 한도가 풀린다 | 반영 | `guardedStateFiles`(review.json·planning.json)를 실행 전에 떠 두고, 바뀌면 되돌린 뒤 그 실행을 받지 않는다. 다른 기록의 한계는 design.md 에 | fullReview E15 |
| E16 | 샌드박스 의심 지점의 두 번째 네트워크 오류가 실행 불가(중지 기록 후 진행)가 되어 사람 판단 없이 교차가 빠진다 | 반영(사용자 결정 2026-10-08) | 결정 D2: Codex 메인이 부른 `--by claude`의 네트워크 오류는 같은 지점에서 몇 번째든 `host-sandbox-denied`(막힘)이고, 두 번째부터 사람에게 넘기는 안내(`network-repeat`·`network-exhausted`)를 낸다. 지점 시도 한도에 세므로 기록은 3개에서 멈춘다. 사람이 `judgment cross-stop`으로 중지를 기록한다(검토 반영 때는 코드를 두고 §6.4 에 문서화만 했다). 반박 검증(G2·G5~G7)으로 지점 이력·사전 거부 뒤·중지 지점·게이트 줄 명령 자리를 보완했다 | crossReview D2(E16) 4개 · planning D2(E16) · cross D2 · docSync §6.4 · 반박 검증 시험(아래 절) |
| E17 | 끊긴 test 의 재실행 한도 거부(`RetryRefused`)를 test.execute 가 잡지 않아 verify 가 예외로 끝난다 | 반영 | test.execute 도 `limit-exceeded` 면 blocked → decision(§6.2 TE→DC) | fullReview E17 |
| E18 | 샌드박스 표지 사전 거부가 부를 때마다 시도를 하나씩 쌓는다 | 반영 | 같은 사유 사전 거부가 마지막 시도면 다시 쌓지 않는다(리뷰·계획 양쪽) | crossReview E18 |
| E19 | SubagentStop 판정 실패가 원인과 무관하게 exit 2 이고 기록이 없어 실행이 고아 기한까지 '실행 중' | 일부 | 리뷰어 실행에 `hook-failure` 를 기록하고 0(새 호출을 받는다), 형식 되돌림(`ReturnToReviewer`)만 2. 기록하지 못한 판정 실패는 2로 남긴다 — 계획 쪽 일시 잠금 실패 재시도에 쓰이는 §5.1 문서화 동작이다. §6.4 산문·표를 이 규칙으로 맞췄다 | crossReview E19 |
| E20 | 실행 파일 변수가 없는 파일을 가리키거나 PATH 에 셸 스크립트만 있어도 실행 불가로 진행한다 | 반영(사용자 결정 2026-10-08) | `hostCommandConfigError` → `cross-config-error`(kind config)로 막는다. 미설치만 실행 불가. '두 호스트 설치 시 교차 필수'에 맞춘 엄격화다. 결정 D3: 이 엄격화를 현행대로 확정했다(코드 변경 없음, doctor ✗·exit 1 도 유지) | review-gate E20 · retryPolicy fixture · finalReverify R3 |
| E21 | lock-stale 행의 '대기 재실행 1'을 아무 코드도 세지 않는다 | 반영 | 표 문구를 `대기 재실행 1(안내만 — 기록·강제 없음)` 으로 | docSync §6.4 |
| E22 | 실행 중인 다른 교차 시도를 lock-stale 로 분류한다 | 반영 | `precondition`(kind `cross-busy`) | retryPolicy E22 |
| E23 | 동의 대상 변경 안내가 consent.ts 와 retryPolicy 두 곳에 있고, 렌더되지 않는 guide 가 셋 있다 | 반영 | consent GUIDES 를 retryPolicy 변형(`response-change`·`defer`·`none`·`invalid`)으로 옮겨 `guidance()` 로. 렌더 안 되는 셋(blocking-finding·lock-stale·hook-failure)은 `UNRENDERED_GUIDES` 로 선언하고 시험이 소스와 대조(지적이 고른 두 번째 방법) | retryPolicy E23 · failureHint |

### hook (E24~E30)

| 번호 | 지적 | 상태 | 처리 | 시험 |
|---|---|---|---|---|
| E24 | 시간 초과·환경 문구로 끊긴 test 뒤에는 테스트 파일이 얼지 않아 모델이 테스트를 고쳐 통과시킬 수 있다 | 반영 | `freezingTestRun` — 결과 인식·코드 결함에 더해 시간 초과·선언된 환경 문구로 끝난 실행도 동결(테스트가 실제로 돈 실행). 도구 없음·spawn 실패는 동결하지 않음 | verifyRetry E24 |
| E25 | 하위 폴더에서 연 Claude 세션은 루트의 `.code-agent/**` 를 저장소 밖으로 본다 | 반영 | `decideTool`·`decideMcp`·Stop·SessionStart 의 루트를 `findRepoRoot` 로 | fullReview E25 |
| E26 | 동의 적용 잠금의 pid 가 살아 보이면 모든 모드의 쓰기(저장소 밖 포함)를 거부한다 | 일부 | 저장소 안 대상만 거부하고 문구에 `.code-agent/consents/apply.lock` 삭제 안내. 잠금 나이 상한은 넣지 않았다(적용이 길게 걸리는 정상 경우와 구분할 근거가 없다) | hookPaths E26 |
| E27 | 세션 밖 열린 동의 창이 그 동의와 무관한 다른 세션 셸까지 좁힌다 | 일부 | 색인에 준비한 세션을 기록하고 `openConsent` 가 다른 세션의 창은 건너뛴다. 다른 세션에 경고 줄을 내는 것은 넣지 않았다 | consentBinding E27 |
| E28 | 다른 창의 SessionStart 가 임대를 가져가면 승인된 동의의 `consent finish` 가 막힌다 | 반영 | 동의 주인으로 확인된 `consent apply`·`finish <id>` 는 임대 거부를 받지 않는다(임대 갱신은 그대로) | fullReview E28 · lease |
| E29 | 사용자 수준 hook 설정을 Bash 는 막는데 Write·apply_patch 는 통과한다 | 반영 | `userHostConfig`(~/.claude/settings(.local).json, Codex 홈의 hooks.json·config.toml) 쓰기 거부 | hookPaths E29 |
| E30 | MCP 쓰기 동사를 부분 문자열로 맞춰 읽기 도구가 쓰기로 판정되고, 경로 키가 좁다 | 일부 | 이름을 낱말로 나눠 동사 집합으로 판정(upload 제외, overwrite·truncate·unlink·rm 추가), 경로 키 확대(`relative_path`·`pathInProject`·`project_path` 등 저장소 상대 키). 판정하지 못한 MCP 이름을 기록하는 것은 넣지 않았다 | hookPaths T-13-1 |

### 문서 (E31~E43)

| 번호 | 지적 | 상태 | 처리 |
|---|---|---|---|
| E31 | 감사 160건의 처리 현황이 없다 | 반영 | [감사 처리 현황](2026-10-08-audit-disposition.md)·[원자료](evidence/audit-disposition-2026-10-08.json), 감사 기록 끝 '처리 현황' 절, 흐름도 머리말 링크. 보류 13건에 다음 배정을 적었다 |
| E32 | usage.md 의 hook 수·init 표가 코드와 다르다 | 반영 | 9개(이벤트 6종), init 표에 consent-event·planning-event·SessionStart 행. §5.1·§5.2 등록표를 init 설치 결과와 대조하는 시험을 더했다 |
| E33 | 스테이지 번호 진술이 CLI 출력과 다르다 | 반영 | usage.md '--help 는 13단계 번호, status 는 이름', design.md 명령 표의 번호를 뺐다 |
| E34 | 영향도·설계 담당 서술이 다르다 | 반영 | design 담당 analyst, impact 의 explorer 단독 조건 |
| E35 | 동의 동작 목록·init 인자가 ActionSchema·USAGE 와 다르다 | 반영 | design.md 동의 목록에 repro-log·judgment, 두 표의 init 에 `--host`. 흐름도 §4.1 을 ActionSchema 와 대조하는 시험 |
| E36 | C4·C7 이 바꾼 절차(자리 확인·되감기 예외·배제 경로)가 설계·사용 문서에 없다 | 반영 | 자리 확인 규칙과 되감기 예외 셋(원천 ca-next), `.gitignore` 대신 `deliveryExcludes` pathspec |
| E37 | 흐름도 머리말의 줄 번호 기준이 template/·doc/ 인용을 다루지 않고 하나가 틀리다 | 반영 | 머리말에 'template/·doc/ 인용은 HEAD 기준 또는 절 이름', ca-next 인용을 절 이름으로 |
| E38 | §6.4 산문에 숫자가 있다 | 반영 | 숫자 없이 코드 이름으로 |
| E39 | §5.1 SessionStart '진행 중인 것이 없으면 출력 없음'이 코드와 다르다 | 반영 | '진행 중인 것·기다리는 동의·hook 누락이 모두 없으면' |
| E40 | 교차 안내가 `init --host` 로 호스트를 줄이라고 하는데 init 은 줄이지 않는다 | 반영 | `.code-agent/hosts.json` 에서 빼라는 문구(doc/codex.md 제거 절) — 시험 review-gate E40 |
| E41 | 검증 이력 색인이 낡았다 | 반영 | [공통 모듈 기록](2026-10-07-retry-policy-module.md) 행, '최신' 문장, README.md '당시 기록' |
| E42 | 저장소 상대 링크 두 개가 깨졌다 | 반영 | usage.md `fix` 절을 제목으로, 옛 기록의 p6 링크를 fix-flow.test.ts 로 |
| E43 | install.md 수치·예시 출력이 낡았다 | 반영 | 개수 문구를 빼고 init·update 예시를 sandbox 실제 출력으로. init 의 Codex 안내 수를 설치한 자원에서 센다(DOC-14, 시험 fullReview DOC-14) |

## 흐름도·코드 대조 시험 확장

[`docSync.test.ts`](../../src/test/docSync.test.ts)에 네 대조를 더했다(동작 변경 없음 — export 만 더함). 문서가 코드와 달랐던 곳은 문서를 고쳤다.

- §4.1 동의 동작 목록·제목 ↔ `consent.ts` `ActionSchema`·`consentState.ts` `CONSENT_TITLES`
- §5.1·§5.2 hook 등록표 ↔ 임시 저장소에 `init --host both` 해서 읽은 `.claude/settings.json`·`.codex/hooks.json`
- §3.2 스테이지 ↔ `layout.ts` `PHASES`
- §7 모델 기본값 ↔ `modelPolicy.ts` `ROLE_POLICY`·`TIER_DEFAULTS`

AGENTS.md '바꿀 때 지킨다'에 이 대조를 한 줄로 적었다. 대조가 문서 변경을 실제로 잡는지 문서를 하나씩 바꿔 보는 변이 검사 7종으로 확인했다.

## 사용자 결정

검토 때 사용자 결정이 필요하다고 남긴 셋은 2026-10-08 에 사용자가 정했다. 처리는 끝 절 '사용자 결정 반영(D1~D3)'에 있다.

1. **작업 중 역할 모델 변경(E2, C4 인계 #9) — D1** — "작업 중에는 역할 모델을 바꿀 수 없도록 막는다. 작업이 끝난 뒤(반영 deliver 또는 종료 abort 로 진행 중 작업이 없어진 뒤) 바꿀 수 있다." 동의 준비·동의 적용·터미널 `code-agent model` 변경 모두 같은 규칙이고, 값 없는 조회는 연다. 강도 변경도 같다. `update --templates-only` 자체 동작은 바꾸지 않는다.
2. **샌드박스 의심 지점의 두 번째 네트워크 오류(E16) — D2** — Codex 메인이 Claude 를 교차로 부를 때(셸에 샌드박스 표지 없음) 같은 지점의 네트워크 오류는 몇 번째든 `host-sandbox-denied`로 게이트를 막는다. 첫 번째는 권한 상승해 같은 명령, 두 번째부터는 실제 네트워크 문제일 수 있으니 확인해 다시 실행하거나 사용자 확인을 받아 `judgment cross-stop`. 판단 주체는 사람이다. 표지가 있으면 사전 거부, `CODE_AGENT_CROSS_PREFLIGHT=off`, Claude 메인→Codex 의 네트워크 오류(실행 불가 → 중지 기록 후 진행), Codex 메인→Claude 라도 네트워크가 아닌 실행 불가(미설치·인증·사용 한도·서비스 장애 → 중지 기록 후 진행)는 그대로다.
3. **실행 파일 설정 오류의 분류(E20) — D3** — "`CODE_AGENT_*_BIN` 이 없는 파일을 가리키거나 PATH 에 셸 스크립트(.cmd 등)만 있는 경우는 설정 오류로 막는다(현행 유지)." 코드 변경은 없다. doctor ✗·exit 1(F3)도 유지한다.
4. (참고) 감사 GAP-5 — CI 도입과 실행 플랫폼은 [감사 처리 현황](2026-10-08-audit-disposition.md)의 보류 표에 있다.

## 결과

`npm run build && npm test` 단일 전체 실행: **1292개 중 1288개 통과·실패 0개·생략 4개**(130초). 그 앞 실행 한 번은 기존 시험 하나(crossReview '게이트 쪽 고아 보기 — 사람이 아닌 중지 지점…')가 실패했다 — 죽은 pid 를 끝 기록 없는 시도로 쓰는 시험인데, 병렬 시험이 그 pid 를 다시 받아 살아 있는 실행으로 보였다(단독 4회·다음 전체 실행 통과, 이번 변경과 무관한 Windows pid 재사용). 시작 시점(`934e5fe`)은 1265개 중 1261개 통과·실패 0개·생략 4개였다.

## 후속 수정(최종 재검증 지적)

이 기록과 요약 기록(`16ae5ec`)을 다시 검증한 결과 남은 문제 여섯 건(R1~R6)을 처리했다. 지적마다 코드와 재현 스크립트로 먼저 확인했고, 여섯 건 모두 맞는 지적이었다. 회귀 시험은 [`finalReverify.test.ts`](../../src/test/finalReverify.test.ts)에 있다(시험 이름에 R1~R6). 수정한 곳 열 군데를 빌드 산출물에서 하나씩 되돌린 변이 검사에서 그 지적의 시험이 모두 깨졌다. R1 시험은 사용자 홈(USERPROFILE·HOME·CODEX_HOME)을 임시 폴더로 바꾼 뒤 판정 함수만 부른다. 사용자의 실제 `~/.claude`·`~/.codex` 파일은 읽거나 쓰지 않는다. 사용자 결정 대기 셋(E2·E16·E20)은 손대지 않았다.

| 번호 | 지적 | 상태 | 처리 | 시험 |
|---|---|---|---|---|
| R1 | E29 의 사용자 수준 호스트 설정 쓰기 거부를 NTFS 대체 데이터 스트림 표기(`settings.json::$DATA`, Codex `apply_patch` 의 `hooks.json::$DATA`)로 비켜 간다. Node 로 `file::$DATA` 를 쓰면 본 파일을 덮는다 | 반영 | `foldStreams`가 이름 대조 전에 스트림 표기(`::$DATA`·`:$DATA`·`:<이름>`, 폴더의 `::$INDEX_ALLOCATION`)와 이름 끝 점·공백을 본 이름으로 접는다(win32 만). `userHostConfig`는 접은 이름을 있는 조상까지 실제 경로로 풀어 견준다(8.3·junction·대소문자·슬래시·`..`·긴 경로 접두·로컬 관리 공유는 `foldWindowsAlias`와 실제 경로가 접는다). 이름으로 접지 못하는 하드 링크·UNC 는 파일이 있으면 (dev, ino)로, 없으면 부모 폴더의 (dev, ino)와 파일 이름으로 견준다. 상대 경로는 세션 작업 경로와 저장소 루트 양쪽에서 푼다. Codex `apply_patch`는 패치 경로마다 같은 판정(Edit)을 받는다. 셸 언급은 폴더 스트림 표기(`HOST_CONFIG`·`mentionsState`)와 겹친 `<이름>\..\`(`mentionsHostConfig` — 되풀이해 접은 꼴도 본다)를 본다. 키 자리 판정(`normalized`·`STORE_FILE_NAME`)도 스트림 표기를 접는다. 실제 hook 프로세스(`hook`·`codex-event`)에 임시 홈을 주고 별칭 36개를 도구 5개(Write·Edit·MultiEdit·NotebookEdit·apply_patch)에 넣었다. 셸 8꼴, 상대 경로, `Add File`·`Delete File` 패치도 넣었다. 새는 길은 0이다. 처음 확인에서는 겹친 `..` 셸 언급 2건이 새어 고쳤다. hook 은 보안 경계가 아니라는 전제는 그대로다 — 따옴표로 쪼갠 이름·변수로 조립한 이름은 여전히 잡지 못한다 | R1 foldStreams · 쓰기 도구 · 파일 번호(dev, ino) · Codex apply_patch · 셸 언급 |
| R2 | 검증 명령이 `review.json`·`planning.json`을 바꿔 되돌린 실행은 실패 기록이 남지 않는다. 그래서 test 커서의 `다음:`은 '검증 통과 — next'를 내는데, next 는 'test 결과가 2회차의 것이 아닙니다'로 거부하고 그 거부 끝에도 같은 틀린 줄이 붙는다. verify 는 Stop 예외로 끝난다 | 반영 | 되돌린 실행을 실행마다 원인 `guard`(`outcome: error`, 되돌린 파일 `guarded`)로 남긴다. `runClass`는 그 실행을 `precondition`으로 본다 — 재시도 규약 21종 안의 원인이고 새 원인은 만들지 않았다. 게이트의 stop 문제, verify(노드 없는 Stop), `다음:`, 같은 코드 재실행 거부(check·test·integrate), 재현이 같은 문장 `stateGuardText`를 쓴다. 그 문장은 되돌린 파일, 증거로 받지 않음, 같은 코드로는 다시 돌리지 않음, 계획 안에서 고친 뒤 verify(얼어 있는 테스트면 고치지 말고 보고)를 말한다. 그 출력으로 TC 를 읽거나 테스트를 얼리지 않고, 통합 검증의 준비 명령이 바꿨어도 환경 실패로 분류하지 않는다. 리뷰 기록은 실행 전 내용으로 되돌리므로 리뷰 회차 사용량은 줄지 않는다(E15 의 목적). `다음:`의 check·test 갈래는 지금 회차의 실행만 본다. 재현 중 같은 증상을 하나 더 찾았다 — 실행이 통과여도 계획 밖 변경이나 검증 뒤 계획 파일 변경이 남으면 '검증 통과'를 냈다. 이제 그 자리에서는 verify 가 할 일을 낸다(전제 Stop 사유, `verify --json`, `verify --json --retry`). verify 는 결과 JSON 을 내지 않는 쪽을 골랐다. `precondition`은 다시 돌려도 같은 사람 확인 멈춤이라, verify 가 노드 없이 Stop 하는 기존 설계(명령 미선언과 같다)를 따른다. 대신 Stop 사유가 status·next 와 같은 문장이다. `ca-check`는 JSON 없는 오류를 '사유를 보고하고 멈춘다'로 다룬다 | R2 리뷰 기록을 지운 test · 첫 test 가 기록을 만듦 · 통합 검증 준비 명령 · 게이트 문제가 남은 통과 · 이 회차 test 전 · 앞 회차 test 통과 |
| R3 | `crossNotice`(status·doctor·init)가 E20 뒤에도 설정 오류(없는 BIN 파일·셸 스크립트뿐인 PATH)를 '중지로 기록하고 진행한다'로 쓴다 | 반영 | 못 쓰는 이유를 `hostCommandConfigError`로 가른다. 설정 오류는 '중지로 기록하지 않고 그 지점의 게이트가 막힌다 — 고친 뒤 같은 명령, 못 고치면 사람이 중지(judgment cross-stop)'로 쓴다. 미설치만 '중지 기록 후 진행'이다. 둘이 겹치면 둘 다 쓴다. 원인 이름은 `POLICIES` label 이고, 갈래 문장은 재시도 규약의 `notice` 변형(`GUIDE_VARIANTS` — 안내 문구 원천 규칙, 호스트 중립)이다. `doc/design.md` 교차 결정 문단의 서술도 고쳤다 — '설정값에서 못 찾음 = 실행 불가'와 '한 호스트만 설치'가 남아 있었다 | R3 없는 실행 파일 변수 · 미설치 · status·doctor·init · review-gate E20 |
| R4 | 리뷰 없이 '통과 뒤 변경'만 되풀이해 리뷰 회차 예산을 다 쓰면 verify decision 은 '한 번 더 허용'을 낸다. `다음:`은 '회차 추가(retry-grant reviewRounds)'와 지적이 없는데도 '지적 기각(judgment waive-finding)'을 낸다. 그런데 실제 허용은 '리뷰 회차를 연 기록이 없습니다'로 거부된다 | 반영 | 허용을 받지 않는 쪽을 골랐다. C5 설계에서 사람 허용 카운터는 `GRANT_STEP` 키이고, 리뷰 회차 허용은 그 회차 기록(`review.json` `grants`)에 남는다. 리뷰를 연 기록이 없으면 허용을 남길 자리가 없다. 허용을 받게 하면 리뷰를 한 번도 열지 않은 채 통과 뒤 변경을 이어가는 길이 열린다 — 총 회차는 허용 대상이 아니므로 그 길은 결국 총 회차로만 막히고, 게이트가 약해진다. check 거부의 기록에 `kind: no-review`를 단다. verify decision(`limit-exceeded`의 `no-review` 변형), hook 쓰기 거부, `다음:`, 허용 거부(미리보기 포함)가 같은 세 선택지 `NO_REVIEW_CHOICES`를 싣는다 — 사람이 계획 파일을 통과한 트리로 되돌린 뒤 리뷰를 받거나, 재계획·재승인하거나, abort 한다. 판정은 `reviewOpened` 하나다. 리뷰를 열었지만 열린 지적이 없으면 회차 추가만 싣고 지적 기각은 싣지 않는다. 사람 허용으로 늘리지 않는 카운터(총 회차)의 check 남은 회차 줄도 허용 없이 낸다 | R4 리뷰 없이 쓴 회차 · 열린 지적 없음 |
| R5 | §1.1 의 `doc/usage.md:188` 인용이 HEAD 에서 191행으로 밀렸고, `ca-next/SKILL.md:71`(되감기 예외 셋)은 실제로 72행이다 | 반영 | 191·72 로 고쳤다. §10 앞의 `template/`·`doc/` 인용 7개를 HEAD 와 하나씩 대조했다(`ca-next` 14·25·31·72, `ca-plan/contract.md` 10·16, `usage.md` 191) — 모두 맞는다. 시험이 인용마다 그 줄의 글을 대조하고, 줄이 밀리거나 표에 없는 인용이 생기면 깨진다(흐름도 머리말에 적었다). `src/` 인용은 머리말 규칙대로 기준 커밋(`c4f3fbf`, 일부 모듈은 검토 반영 커밋) 기준이라 HEAD 줄과 대조하지 않았다. 표본으로 본 `init.ts:163-167`·`228-231`, `doctor.ts:181`, `commands.ts:708-722`, `deliver.ts:47`은 기준 커밋에서 맞았다 | R5 흐름도 인용 |
| R6 | 끝난 자식 프로세스의 pid 를 죽은 pid 로 쓰는 시험(crossReview '게이트 쪽 고아 보기…' 등)이 병렬 부하에서 간헐로 실패한다. Windows 가 그 pid 를 곧바로 다시 주기 때문이다 | 반영 | 생존 판정 `pidAlive`(`process.kill(pid, 0)` — EPERM 만 살아 있음)는 바꾸지 않았다. 시험이 넘기는 값만 `deadPid()`로 바꿨다. 이 함수는 OS 가 배정하지 않는 범위(`0x3fff0000` 위의 4의 배수 — Linux PID_MAX_LIMIT 2^22, macOS 99,999, Windows 핸들 표 위)에서 실행 시점에 살아 있지 않음을 확인한 값을 고른다. 바꾼 시험 파일은 10개이고 고정 `999999`도 포함한다. `lock.test` 의 pidAlive 시험 하나만 끝난 자식을 그 자리에서 바로 본다. 다른 시험 파일이 끝난 자식의 pid 를 다시 쓰면 R6 시험이 깨진다. crossReview 를 단독으로 6회 돌려 모두 40/40 이었다. pid 를 쓰는 시험 파일 8개(crossReview 3벌·cross·lock·integrate-deliver·hookPaths·consent)를 동시에 띄운 부하 실행 2회(16 실행)도 모두 실패 0 이다 | R6 deadPid · 끝난 자식 pid 금지 |

### 후속 수정 결과

`npm run build && npm test` 단일 전체 실행: **1311개 중 1307개 통과·실패 0개·생략 4개**(suites 189, `duration_ms` 137,876, 빌드를 합친 벽시계 140초). 시작 시점(`16ae5ec`)은 1292개 중 1288개 통과·실패 0개·생략 4개였다. 더한 19개는 모두 `finalReverify.test.ts`의 R 시험이다.

- 변이 검사 — 수정 열 군데를 하나씩 되돌리면 그 지적의 시험이 깨진다. 열 군데는 R1 스트림 접기·겹친 `..` 접기, R2 기록 변경 실행의 기록·`다음:`의 지금 회차, R3 교차 안내 갈래, R4 `다음:`·hook·verify decision 의 리뷰 없음 갈래, R5 흐름도 인용, R6 끝난 자식 pid 다. 처음 검사에서는 R2 `다음:` 지금 회차 변이를 1회차 시험이 잡지 못했다. 앞 회차가 없어서다. 그래서 2회차 시험(앞 회차 test 통과 뒤 지금 회차 test 전)을 더했다.
- 재현 스크립트 — `e15-restore.cjs`(R2)에서 status·next·verify 가 같은 기록 변경 문장을 낸다. `e13-noreview.cjs`(R4)에서 verify decision·`다음:`·hook·허용 거부가 같은 세 선택지를 낸다.
- R6 — crossReview 단독 6회 모두 40/40 이다. pid 를 쓰는 시험 파일 8개를 동시에 띄운 부하 실행 2회(16 실행)도 실패 0 이다.

### 반박 검증 지적(F1~F4)

위 수정(`5205112`)을 동작 관점으로 반박 검증한 결과 낮음 네 건이 나왔다. 지적마다 HEAD 산출물과 재현 스크립트로 먼저 확인했고, 네 건 모두 맞는 지적이었다. 게이트는 바꾸지 않았다 — 고친 것은 안내(`다음:`·게이트 줄·doctor 표시)와 시험이다. 회귀 시험은 `finalReverify.test.ts`(R2·R3·R6 이름)와 `planning.test.ts`(계획 교차 검토 줄, 이름 끝 `(R3)`)에 있다. 사용자 결정 대기 셋(E2·E16·E20)은 손대지 않았다.

| 번호 | 지적 | 상태 | 처리 | 시험 |
|---|---|---|---|---|
| F1 | R2 가 덜 고쳐졌다. test 단계에서 검증 명령이 기록을 바꾼 뒤 `verify --json --retry`·`code-agent check`를 실행하면 같은 코드 재실행으로 거부되면서 커서가 check 에 선다. 그 자리의 `다음:`은 '검증 통과 — code-agent next 로 넘긴 뒤 /ca-test'를 낸다. 같은 순간 verify·check 는 기록 변경 문장으로 거부한다. 기록 변경 판정이 커서 단계로만 걸러졌기 때문이다 | 반영 | `nextHint`의 check·test 갈래는 지금 회차의 기록 변경 실행을 단계 필터 없이 찾는다. 찾으면 그 실행 단계의 게이트 stop 문제 전부를 전제 안내(`guidance("precondition")`)로 낸다. check 커서의 verify 는 check 를 통과로 보고 test 로 넘어가 같은 사유로 멈추므로, `다음:`은 그 Stop 과 같은 문장이다. 게이트(`stageProblemEntries`)는 그대로다. check 게이트는 test 의 기록 변경을 보지 않아 next 는 test 로 넘어가지만, 거기서 test 게이트가 막는다 | R2 test 의 기록 변경 뒤 verify --retry·check 의 거부로 커서가 check 에 서도 |
| F2 | (1) 기록 변경 때문에 test 출력을 읽지 않았는데도 next 거부에 '⑦ 의 테스트 케이스가 확인되지 않았습니다 … TC id를 남기세요' 줄이 붙는다. 틀린 할 일이다. (2) 사람이 동결된 테스트를 바꾼 데다 기록 변경까지 겹친 경우, verify Stop 과 next 는 두 사유를 싣는데 `다음:`은 기록 변경 문장만 낸다 | 반영 | (1) 그 회차·그 단계에 기록 변경 실행이 있으면 `stageProblemEntries`가 ⑦ 미확인 줄을 싣지 않는다. 게이트는 stop 줄로 막혀 있고, 고친 뒤 새 회차에서 TC 대조가 다시 돈다. (2) F1 의 갈래가 그 단계의 stop 문제 전부를 싣는다 — verify 의 Stop 과 같은 목록이다(동결 뒤 바뀐 테스트 / 기록 변경) | R2 얼어 있는 테스트를 바꾼 데다 기록 변경까지 겹치면 · R2 리뷰 기록을 지운 test(next 거부에 ⑦ 줄 없음) |
| F3 | R3 의 문구 어긋남이 `crossNotice` 밖에 남았다. 리뷰·계획 교차 게이트 줄의 괄호 '(실행할 수 없으면 중지로 기록되고 진행합니다)'가 직전 실행이 설정 오류일 때도 붙는다. 그래서 같은 status 출력 안에서 교차 안내는 '게이트가 막힌다'라고 하고, `다음:`은 '중지로 기록되고 진행'이라고 한다. 그 괄호는 재시도 규약 밖의 리터럴이다. `doctor.ts` 주석의 '실패로 세지 않는다'도 이제 설정 오류에는 틀린 말이다 | 반영 | 괄호를 `hosts.ts` `crossRunNote`로 옮겼다. 직전 실패가 있으면 괄호를 달지 않는다 — 그 원인 안내(`crossHintText`)가 다음 일을 싣고, 설정 오류·샌드박스 거부의 안내는 '게이트가 막혀 있다'이다. 아직 실행 전이라도 그 호스트의 실행 파일이 설정 오류면 설정 오류 갈래(`cross-config-error`의 `notice` 변형)를 쓴다. 그 밖은 실행 불가 갈래로, `cross-unavailable`에 새로 둔 `gate` 변형이다(글은 전과 같다). 판정은 교차 안내와 같은 `hostCommandConfigError`이다(`crossHostProblems`). doctor 는 설정 오류 갈래를 막는 문제(`✗`)로 쓰고 고치는 길(실행 파일 변수)을 단다. `--cross`가 없는 옵션을 '설정 오류로 막힌다'며 `✗`로 쓰는 것과 같은 기준이다. 실행 불가는 그대로 `·`다. 그래서 교차 설정 오류가 있으면 `doctor`가 exit 1 로 끝난다. 주석도 이 기준으로 고쳤다 | R3 doctor 는 설정 오류 · R3 교차 리뷰 게이트 줄 · 계획 교차 검토 줄(R3) |
| F4 | R6 의 남은 틈이다. `lock.test`의 pidAlive 시험은 여전히 방금 끝난 자식의 pid 를 바로 본다. 재발 방지 정규식은 `spawnSync(process.execPath, ["-e", "0?"]).pid` 한 꼴과 고정 999999 만 잡는다 | 반영 | 끝난 자식 단언을 지우고 `deadPid()` 단언만 남겼다(시험 이름도 고쳤다). 재발 방지 탐지 `endedPidUses`는 동기 실행(`spawnSync`·`execFileSync`·`execSync`) 결과의 `.pid`를 인자 꼴과 상관없이 잡는다 — 바로 쓴 꼴, 변수에 담은 꼴, 구조 분해 꼴 모두다. 세 자리 이상의 고정 pid 리터럴(`pid: N`·`pidAlive(N)`)도 잡는다. 예외로 둔 파일은 없다(`deadPid.ts`만 뺀다). 탐지 자체도 표본으로 시험한다(잡을 꼴 11개·잡지 않을 꼴 6개). 살아 있는 자식(`spawn` — 시험이 kill 한다)의 pid 는 대상이 아니다 | R6 시험 파일은 … 예외 없이 · R6 끝난 프로세스 pid 탐지 |

#### 반박 검증 지적 처리 결과

`npm run build && npm test` 단일 전체 실행: **1317개 중 1313개 통과·실패 0개·생략 4개**(suites 189, `duration_ms` 139,786, 벽시계 141초). 시작 시점(`5205112`)은 1311개 중 1307개였다. 더한 6개는 `finalReverify.test.ts` 5개와 `planning.test.ts` 1개다.

- 변이 검사 — 수정 열 군데를 빌드 산출물(F4 는 시험 소스)에서 하나씩 되돌렸고, 매번 그 지적의 시험이 깨졌다. 열 군데는 F1 기록 변경의 단계 필터, F2 `다음:`의 기록 변경 문장만 내기·⑦ 미확인 줄, F3 직전 실패 뒤 괄호·실행 전 설정 오류 갈래·리뷰 게이트 리터럴·계획 게이트 리터럴·doctor `✗`, F4 `lock.test` 끝난 자식·다른 인자 꼴(변수에 담은 `spawnSync` 결과)이다.
- 재현 스크립트(HEAD 산출물에서 지적을 재현한 것을 고친 산출물로 다시 돌림):
  - `r2b.cjs` — check 커서의 `다음:`이 '검증 통과' 대신 기록 변경 사유를 낸다.
  - `r2.cjs test` — next 거부에 ⑦ 미확인 줄이 없다.
  - `e15-full.cjs` — `다음:`이 verify Stop 과 같은 두 사유를 낸다.
  - `r3.cjs` — 임시 HOME·APPDATA, PATH 는 node·git·System32 만 썼고 실제 모델은 부르지 않았다. 설정 오류에서 doctor 가 `✗`를 내고, 설정 오류 뒤의 게이트 줄에는 '실행할 수 없으면 중지' 괄호가 없다.
- 남은 점:
  - check 커서에서 같은 회차 test 의 기록 변경이 있을 때, 게이트가 단계별이라 `next`는 test 로 넘어간 뒤에 막힌다. 지적이 정한 대로 게이트는 그대로 두었다. `다음:`과 verify 는 그 자리에서 사유를 낸다.
  - 비동기 자식(`spawn`)이 끝난 뒤의 `.pid`를 죽은 pid 로 쓰는 꼴은 탐지하지 않는다.
  - 교차 설정 오류에서 doctor 가 exit 1 이 된 것은 E20(설정 오류 분류)을 따른다. 사용자가 E20 을 되돌리면 같은 `hostCommandConfigError`를 따라 함께 바뀐다.

## 사용자 결정 반영(D1~D3)

위 '사용자 결정' 절의 셋을 2026-10-08 사용자 결정대로 처리했다. 결정마다 수정 전 산출물에서 결정과 다른 동작을 재현 스크립트로 먼저 확인했다. 재현과 시험은 임시 git 저장소에서 했고 HOME·USERPROFILE·APPDATA·CODEX_HOME 을 임시 폴더로 바꿨다. 교차는 가짜 claude·codex 실행 파일로만 돌렸다. 실제 모델은 부르지 않았고 `code-agent update` 는 실행하지 않았다. 사람 확인 지점은 줄이지 않았고 게이트도 약하게 하지 않았다. 회귀 시험 이름에 D1·D2 를 붙였다.

| 결정 | 지적 | 재현(수정 전) | 처리 | 시험 |
|---|---|---|---|---|
| D1 | E2 | 작업 중 model 동의 준비가 경고만 붙이고 통과했다. 적용·직접 `setModel`(TTY)이 정의 파일을 바꿨다. 접수 세션(start 전)에는 경고도 없었다 — `modelWorkWarning`이 `active.json`만 봤다 | 진행 중인 작업은 접수 세션부터 반영(deliver)·종료(abort) 전까지다(`models.ts` `workInProgress`). 그동안 `validateModelChange`가 먼저 `requireNoWorkInProgress`로 거부한다. 문구는 재시도 규약 `precondition`의 `model-in-work` 변형으로, 작업 ID·단계와 "작업을 반영(deliver)하거나 종료(abort)한 뒤 바꾸세요"를 싣는다. 그래서 동의 준비는 질문을 내기 전에, 터미널 `code-agent model <역할> <모델>`은 TTY를 묻기 전에(exit 1) 거부된다. 강도만 바꾸거나 기본값으로 되돌려도 같다. 값 없는 조회는 연다. 작업이 없을 때 준비·승인한 동의도 적용 시점(`applyLocked`, 스냅샷 대조 앞)에 다시 본다. 그사이 작업이 시작됐으면 적용하지 않고 대상 변경(`consent-target-changed`, kind `target`)으로 폐기한다. 아무것도 적용하지 않았으므로 '일부만 반영됐을 수 있다'는 적용 실패 안내를 쓰지 않는다. 경고 `modelWorkWarning`은 지웠다. doctor '에이전트 모델' ✗ 안내는 작업 중이면 작업이 끝난 뒤 `update --templates-only` 를 실행하라고 한다. 교차 설정 오류 안내의 '모델 설정은 동의 model 로 바꾸고'는 작업 중 모델을 바꾸지 않는다는 문장으로 고쳤다. 모델이 원인이거나 고칠 수 없으면 사람 중지이고, 모델은 작업이 끝난 뒤 바꾼다. `update --templates-only` 동작은 바꾸지 않았다 | fullReview D1(E2) 7개 — 준비 거부(모델·강도·기본값·all), 접수 세션, 적용 시점 재확인, CLI 거부·표 보기, abort 뒤 허용, deliver 뒤 허용, doctor |
| D2 | E16 | Codex 메인이 부른 `--by claude`의 같은 지점 네트워크 오류가 1번째는 막힘이었다. 2·3번째는 `cross-unavailable`/network 로 중지가 기록되고 게이트가 통과했다. 모델의 재실행 한 번으로 교차가 빠졌다 | `crossSandboxSuspect`가 지점의 앞선 시도를 보지 않는다. Codex 가 부른 claude 의 네트워크 오류는 같은 지점에서 몇 번째든 `host-sandbox-denied`(`sandbox-network`)로 게이트를 막는다. 첫 번째는 지금처럼 권한 상승해 같은 명령을 안내한다. 두 번째부터는 안내 변형(`recordedVariant` — 끝난 `sandbox-network` 시도가 둘 이상)을 쓴다. 지점 시도가 남았으면 `network-repeat`다 — 실제 네트워크 문제일 수 있으니 사용자에게 알려 지시를 받는다. 사용자가 네트워크를 확인하면 같은 명령을 다시 실행하고(남은 횟수), 진행하기로 정하면 `judgment cross-stop`이다. 다 썼으면 `network-exhausted`다 — `judgment cross-stop` 또는 `retry-grant crossPoint`. 두 변형 모두 '사용자 확인 없이 중지를 기록하지 않습니다'로 끝난다. 실행 시도(review·correct)라 지점 시도 한도에 세고, `POLICIES` 카운터에 `crossPoint`를 적었다. 그래서 기록은 3개에서 멈추고 4번째는 실행 전 지점 한도로 거부된다. 리뷰·계획 게이트 줄(`crossHintText`)과 실행 결과 문구(`failureText`)가 같은 변형을 쓴다. 사람 중지(`judgment cross-stop`)는 이 막힌 지점을 받는다. 바꾸지 않은 것: 표지가 있으면 사전 거부(`crossPreflight`), `CODE_AGENT_CROSS_PREFLIGHT=off`, Claude 메인이 부른 codex 의 네트워크 오류(실행 불가 → 중지 기록 후 진행), Codex 메인이 불렀어도 네트워크가 아닌 실행 불가(미설치·인증·사용 한도·서비스 장애 → 중지 기록 후 진행). `ca-review`·`ca-plan` 4-1 은 '그 밖의 실패(…샌드박스)는 출력의 안내만 따른다'라 고치지 않았다 | crossReview D2(E16) 4개(몇 번째든 막힘·변형·한도 / judgment cross-stop 동의로 진행 / Claude 메인→Codex 네트워크 / Codex 메인→Claude 인증), planning D2(E16) 1개, cross D2 1개(분류·변형 선택), cross pointHost·crossSandboxSuspect(D2), docSync §6.4 |
| D3 | E20 | — | 현행 유지 — 코드 변경 없음. doctor ✗·exit 1(F3)도 그대로다 | 기존 review-gate E20 · finalReverify R3 |

문서: 흐름도 §4.1 model 행과 직접 CLI 문단, §6.3(실행 전 판정 문단, 실패 처리 표의 설정 오류·샌드박스 행), §6.4 생성 블록(`renderRetryPolicyTable()` 출력으로 다시 붙임), §7(교차 명령 행, 역할 모델 변경 행 추가), §8 `models.json` 행, §9 모듈 지도, §10. 그 밖에 `doc/codex.md`(교차 문단·모델 변경 문단), `doc/usage.md` model 행, `doc/design.md`(교차 결정 문단·모델 문단), `ca-answer/reference.md`(model 행·cross-stop 행), `template/codex/ca-answer.md`(모델 문단)를 고쳤다. 템플릿 예산 안이다(reference 5187/5300, Codex ca-answer 3942/4100).

### 사용자 결정 반영 결과

`npm run build && npm test` 단일 전체 실행: **1328개 중 1324개 통과·실패 0개·생략 4개**(suites 189, `duration_ms` 133,636, 벽시계 135초). 시작 시점(`014cd85`)은 1317개 중 1313개였다. 늘어난 11개의 내역: D1 7개가 옛 E2 경고 시험 1개를 대체했다. D2 는 crossReview 4개가 옛 '두 번째 네트워크 오류는 실행 불가' 시험 1개를 대체했고, planning 1개·cross 1개를 더했다.

- 변이 검사 — 수정 네 곳을 빌드 산출물에서 하나씩 되돌렸다. 매번 그 결정의 시험이 깨졌다. ① 준비·CLI 거부(`validateModelChange`의 `requireNoWorkInProgress`)를 지우면 D1 5개(준비 거부 둘·CLI 거부·abort 뒤·deliver 뒤 — 작업 중 거부를 먼저 단언한다)가 깨졌다. ② 적용 시점 재확인을 지우면 D1 적용 시점 재확인이 깨졌다. ③ 샌드박스 의심(`crossSandboxSuspect`)을 끄면 D2 crossReview 2개·planning 1개·cross 의 pointHost·crossSandboxSuspect(D2)가 깨졌다. ④ 두 번째 이후 변형(`recordedVariant`)을 끄면 D2 crossReview 1개·planning 1개·cross 1개가 깨졌다.
- 재현 스크립트(`d1-repro.cjs`·`d2-repro.cjs`, 작업 scratchpad `d1d2/`) — 고친 산출물에서 D1 의 준비·직접 변경·접수 세션이 모두 거부되고(CLI exit 1), 작업이 없으면 열린다. D2 는 1번째 기본 안내, 2번째 `network-repeat`(남은 지점 시도 1회), 3번째 `network-exhausted`, 4번째 실행 전 지점 한도 거부다. 시도 기록은 3개이고 `previewCrossStop`이 그 지점을 받는다.
- 처음 두 번의 전체 실행에서는 D1 준비 거부 시험 하나가 실패했다(단독 실행과 부하 실행 6파일은 통과). 시험이 동의 폴더의 `snapshot-cache.json`을 동의 기록으로 셌기 때문이다. 이 파일은 스냅샷 해시 캐시로, 준비 전 스냅샷 계산이 시각에 따라 쓴다. 시험이 동의 기록(UUID 이름)만 세게 고쳤다. 제품 동작은 바뀌지 않았다.
- 남은 점:
  - doctor 의 `models.json` 형식 오류 안내는 바꾸지 않았다(`update --templates-only` 안내 그대로 — 결정 범위 밖).
  - 같은 지점의 첫 샌드박스 네트워크 차단 안내는 지점 시도가 남았는지와 관계없이 '권한 상승해 같은 명령'이다. 다른 원인으로 지점 시도를 다 쓴 뒤라면 같은 명령은 지점 한도로 거부되고, 그 거부가 사람 판단을 안내한다.
  - 작업 시작 뒤에 적용한 model 동의의 폐기 안내는 대상 변경의 공통 문구('새로 준비')다. 폐기 사유에 '작업을 반영(deliver)하거나 종료(abort)한 뒤 새로 준비하세요'를 싣는다.
  - 실제 Codex 셸의 샌드박스 표지와 실제 claude 네트워크 오류 문구는 실제 호스트에서 확인하지 않았다.

### 사용자 결정 반영의 반박 검증 지적(G1~G8)

위 반영(`5e6cdcc`)을 결정 관점과 hook 공격 관점(R1 재공격)으로 반박 검증한 결과 여덟 건이 나왔다(정보 1·medium 1·low 6). 지적마다 HEAD 산출물과 재현 스크립트로 먼저 확인했고, 여덟 건 모두 맞는 지적이었다. 사용자 결정은 바꾸지 않았고 게이트는 약해지지 않았다 — G2 는 사람 판단 없이 중지가 기록되던 길을 닫아 게이트를 강하게 하고, G1 은 hook 판정을 넓힌다. 나머지는 안내(게이트 줄·doctor·모델 표·실패 문구)와 기록이다. 회귀 시험 이름에 '반박 검증'을 붙였다. 재현과 시험은 임시 git 저장소에서 했고 HOME·USERPROFILE·APPDATA·CODEX_HOME 을 임시 폴더로 바꿨다. 교차는 가짜 claude 로만 돌렸고 실제 모델은 부르지 않았다.

| 번호 | 지적 | 상태 | 처리 | 시험 |
|---|---|---|---|---|
| G1 | (정보, R1 재공격) 이름이 파일 서버(`fs`·`filesystem`·`files`·`file-system`·`local-file(s)`)가 아니고 프로젝트 상대 경로 키도 아닌 MCP 쓰기 도구가 저장소 밖 절대 경로를 주면 `mcpPaths`가 그 경로를 버려(원격 서비스 인자로 가정) 사용자 수준 호스트 설정 쓰기가 hook 을 통과한다. 기준(`16ae5ec`)과 같은 동작이라 R1 회귀는 아니다 | 반영(조임) | 원격 서비스 오탐 위험을 따져 조였다. `mcpPaths`가 그 밖의 서버의 절대 경로 중 저장소·키 저장소 안인 것에 더해 사용자 수준 호스트 설정 파일(`userHostConfig` — 쓰기 도구의 E29·R1 과 같은 판정, 다른 이름 포함)을 가리키는 것도 남긴다. 이 PC 의 그 네 파일(또는 그 별칭)일 때만 걸리므로 원격 서비스의 경로 인자(GitHub `path` 의 상대 경로, 드라이브의 `/My Drive/…`)는 그대로 판정하지 않는다. 읽기 도구는 `Read`와 같아 막지 않는다. 그 밖의 저장소 밖 파일은 이전처럼 판정하지 않는다 | R1 공격 검증 — 이름이 파일 서버가 아닌 MCP 쓰기 도구 |
| G2 | (medium) D2 가 지금 프로세스가 Codex 를 부른 쪽으로 볼 때만 지점을 지킨다. 앞선 시도를 Codex 가 불렀어도 호스트 표지가 없는 셸(권한 상승한 셸·사람의 터미널)이나 두 표지가 섞인 셸의 재실행은 네트워크 오류를 `cross-unavailable`/network 로 기록해 중지되고 게이트가 통과했다 — 결정의 '권한 상승 뒤 네트워크 오류' 경우다 | 반영 | `crossSandboxSuspect(host, caller, attempts)`가 지점 이력을 본다. `--by claude`이고 지금 부른 쪽이 codex 이거나, 그 지점의 앞선 시도의 부른 쪽이 codex 이거나 Codex 샌드박스가 막았으면(`sandbox-network`·`preflight`) 네트워크 오류를 `host-sandbox-denied`로 막는다. 이력으로 의심하면 사유의 덧붙임이 'Codex 에서 부른 claude 지점의 네트워크 오류'다. Codex 에서 부른 적이 없는 지점을 표지 없는 셸에서 실행한 네트워크 오류는 이전처럼 실행 불가다(사람의 터미널에서 시작한 지점 — 예외로 흐름도 §6.3·`doc/codex.md`에 적었다). 모델이 env 접두로 표지를 지우는 길은 hook 이 이미 막는다(검증자 G 절 — Bash·PowerShell 의 `CLAUDECODE=1 …`·`env -u …`·`$env:…`·`cmd /c set …`·`node cli.js …` 모두 거부, 수정 뒤 재실행에서도 같다) | D2(E16) 반박 검증 — 표지 없는 셸·섞인 셸 · 바꾸지 않는 갈래(Codex 에서 부른 적이 없는 지점) · 계획 교차 검토 · cross pointHost·crossSandboxSuspect(D2) |
| G3 | (low) D1 의 doctor 안내가 Claude 만 덮는다. Codex TOML 의 model 줄이 설정과 다르면 '✗ Codex 스킬·에이전트'가 작업 중에도 조건 없이 `update --templates-only --host codex`를 안내한다 | 반영 | 진행 중인 작업을 doctor 에서 한 번 읽고(`workInProgress`, 읽지 못하면 없음) 두 줄이 같은 문장(`afterWork`)을 쓴다 — '진행 중인 작업 <ID>(<단계>)이 끝난 뒤(반영 deliver 또는 종료 abort) <명령> — 작업 중에 다시 쓰면 그 작업의 계획 밖 변경이 됩니다'. 'Codex 스킬·에이전트' 줄은 TOML 모델 줄만이 아니라 Codex 자원 전부를 다시 쓰는 명령이라, 작업 중이면 어긋난 파일과 상관없이 같은 안내다. Claude '스킬·에이전트' 줄의 처방(소스 `code-agent update` — 모델이 부르면 hook 이 막는다)은 결정 범위 밖이라 두었다 | D1 doctor(Codex, 반박 검증) |
| G4 | (low) 모델 표는 작업 중에도 열리는데 끝 줄이 '변경: 현재 세션에서 … 변경을 요청하세요'라 그대로 따르면 거부된다 | 반영 | 표의 변경 줄(`models.ts` `changeLine`)이 작업 중이면 `model-in-work` 문장(재시도 규약 원천)과 '작업이 끝난 뒤: 현재 세션에서 변경을 요청하거나 수동 TTY: …'를 싣는다. 작업이 없으면 그대로다. 터미널의 `code-agent model --host claude` 출력도 같다 | D1 모델 표(반박 검증) |
| G5 | (low) 사람이 아닌 중지 지점(예: 인증 실행 불가)을 다시 실행해 네트워크 오류가 되풀이되면 `network-repeat`·`network-exhausted`(사용자 판단·`judgment cross-stop`)와 꼬리 '이전 중지 기록대로 진행(게이트는 막히지 않습니다)'가 함께 나온다. 중지 지점은 `judgment cross-stop`을 받지 않는다 | 반영 | 그 자리에는 새 변형 `stopped`(`GUIDE_VARIANTS`·`GUIDE_VARIANT_KEYS` — detail·host·left)를 쓴다 — 'Codex 샌드박스 제한으로 끝났다 · 이 지점은 이미 중지로 기록되어 다시 기록하지 않았다 · 다시 실행할지는 사용자가 정한다(권한 상승한 같은 명령, 지점 시도 한도 안 — 남은 N회)'에 꼬리가 붙는다. 사람 판단을 싣지 않는다. 기본 문구(첫 네트워크 오류)의 '권한 상승을 거절하면 judgment cross-stop'도 같은 이유로 그 자리에서 빠진다. 게이트는 그대로다(중지대로 통과) | D2(E16) 반박 검증 — 사람이 아닌 중지 지점의 재실행 |
| G6 | (low) 샌드박스 표지로 실행 전에 멈춘(사전 거부) 뒤 권한 상승한 첫 실행이 네트워크 오류면 여전히 '권한 상승을 요청해 같은 명령'이 나온다 — 사람에게 넘기는 안내가 한 번 늦고, 지점 시도 3회 중 '사용자가 네트워크를 확인한 뒤 다시 실행'에 1회만 남는다 | 반영 | 사전 거부는 기본 문구(권한 상승 안내)를 이미 냈고, 그 뒤 표지 없이 실행됐다면 권한 상승한 셸이다. 그래서 `recordedVariant`가 '권한 상승 안내 뒤'를 끝난 `sandbox-network` 시도 수 + (사전 거부가 있으면 1) ≥ 2(네트워크 시도 1 이상)로 본다(`networkAfterEscalation`). 결정의 '첫 번째 안내는 지금처럼 권한 상승'은 그 지점의 첫 안내를 말한다고 읽었다 — 사전 거부 지점의 첫 안내는 사전 거부가 냈다. 사전 거부는 몇 번이든 하나로 센다(같은 사유는 한 번만 기록된다 — E18). 게이트는 그대로다(어느 문구든 막힘) | D2(E16) 반박 검증 — 사전 판정 거부 뒤 · cross D2 classifyCrossFailure·recordedVariant |
| G7 | (low) 두 번째 네트워크 오류(`network-repeat`, 지점 시도 남음)에서도 게이트 줄·status `다음:`이 실행 명령('— code-agent review cross --by claude')을 사람에게 넘기는 안내 앞에 세운다 | 반영 | 게이트 줄의 명령 자리를 `crossRecord.ts` `crossGateHandoff`가 정한다. 한도로 거부될 지점과 `network-exhausted`는 명령을 싣지 않고(`limit`), `network-repeat`은 명령을 앞세우지 않고 안내 뒤에 ' (사용자가 네트워크를 확인한 뒤 다시 실행할 명령: …)'로 싣는다(`network` — `crossRerunAfterUser`). 리뷰(`reviewProblems`)·계획(`crossCriticProblems`) 게이트와 그 줄을 쓰는 status `다음:`·next 거부·planning advance 의 next 가 같다. 첫 번째(권한 상승 안내)는 이전처럼 명령을 앞세운다 | D2(E16) 반박 검증 — 게이트 줄과 status 다음: · 계획 교차 검토 |
| G8 | (low) `doc/reviews/README.md` 최신 행이 11단계를 적고도 '최종 `npm test` 1292개 중 1288개'를 쓴다 | 반영 | 단계별 결과로 고쳤다(`d12bd46` 1292/1288 · 9단계 1311/1307 · 10단계 1317/1313 · 11단계 1328/1324 · 12단계 이번 수치) | — |

#### 반박 검증 지적 처리 결과

`npm run build && npm test` 단일 전체 실행: **1337개 중 1333개 통과·실패 0개·생략 4개**(suites 189, `duration_ms` 160,026, 벽시계 162초). 시작 시점(`5e6cdcc`)은 1328개 중 1324개였다. 더한 9개는 crossReview 5개, planning 1개, fullReview 2개, finalReverify 1개다. cross.test 의 두 시험(`pointHost·crossSandboxSuspect(D2)`, `D2 classifyCrossFailure·recordedVariant`)은 단언을 고쳤다 — 뒤의 것은 '사전 판정 거부는 네트워크 오류 시도로 세지 않는다(기본 문구)'를 G6 대로 `network-repeat`으로 바꿨다.

- 변이 검사(`mutate2.cjs`) — 수정 일곱 곳을 빌드 산출물에서 하나씩 되돌렸고, 매번 그 지적의 시험이 깨졌다. G1 비파일 서버의 호스트 설정 판정 → R1 공격 검증 1개. G2 지점 이력 의심 → cross 1·crossReview 1·planning 1. G3 doctor Codex 줄 → D1 doctor(Codex). G4 모델 표 변경 줄 → D1 모델 표. G5 `stopped` 변형 → 중지 지점 재실행 1. G6 사전 거부 셈 → cross 1·crossReview 1. G7 명령 자리 → crossReview 1·planning 1.
- 재현 스크립트(검증자의 `verify-d1d2/d2.cjs`·`d1b.cjs`, 고친 산출물):
  - A 절 — 1번째 권한 상승, 2번째 `network-repeat`(게이트 줄은 명령을 앞세우지 않고 끝에 재실행 명령), 3번째 `network-exhausted`, 4·5번째 지점 한도 거부. 시도 3개, 중지 줄 없음.
  - B·B2 절(섞인 표지·표지 없는 셸의 재실행) — 수정 전 '교차 검증 중지 … 네트워크'와 게이트 통과였다. 이제 `host-sandbox-denied`/`sandbox-network`이고 게이트가 막힌다.
  - F 절(사전 거부 10회 뒤 표지 없는 실행) — 시도는 사전 거부 1개뿐이고, 첫 네트워크 오류가 `network-repeat`이다.
  - C·D·E 절(바꾸지 않는 갈래) — 인증·사용 한도·서비스 장애·미설치(Codex 메인→claude)와 Claude 메인→codex 네트워크는 중지 기록 후 진행 그대로다.
  - `d1b.cjs` — 작업 중(접수 W-1) doctor 의 두 줄이 모두 '작업이 끝난 뒤'를 싣고, 두 호스트의 모델 표 변경 줄이 거부 문장과 작업이 끝난 뒤의 방법이다.
- R1 공격 검증(하네스 `v2/harness.cjs`를 고친 산출물로 다시 돌림, 실제 hook 프로세스 · 임시 홈):
  - G1 의 'mcp generic *' 여섯 줄(`mcp__acme__write_note` path · `mcp__x__rename` new_path · `mcp__x__copy` destination, 저장소 둘)과 비파일 서버의 `relative_path ::$DATA`가 막힌다(CLOSED).
  - 과잉 거부 비교는 그대로다 — 호스트 설정이 아닌 홈 파일과 저장소 안 `.claude/settings.local.json`은 새로 막지 않는다.
  - 남은 'LEAK' 두 줄은 하네스 산물이다. 'Write settings.local 8.3 parent'는 하네스가 `cmd`에 `windowsVerbatimArguments` 없이 8.3 이름을 물어 `C:\"C:\…\.claude\"` 같은 잘못된 경로를 만든 것이다. 실제 8.3 부모(`…\CLAUDE~1\settings.local.json`, 없는 새 파일)는 막힌다 — `r1-g/check83.cjs`로 확인했다. 'Write %USERPROFILE%\.claude\settings.json'은 Write 도구가 `%USERPROFILE%`을 풀지 않는다. 그래서 대상이 저장소 안의 상대 경로(`<저장소>\%USERPROFILE%\.claude\settings.json`)이고 사용자 설정이 아니다. 같은 꼴의 셸 명령은 막힌다.
- 남은 점:
  - Codex 에서 부른 적이 없는 지점을 호스트 표지 없는 셸(사람의 터미널)에서 `--by claude`로 실행한 네트워크 오류는 실행 불가(중지 기록 후 진행)다. 그 셸이 실제로는 권한 상승한 Codex 셸이고 그 지점의 첫 시도라면 D2 밖으로 빠진다. 실제 Codex 셸이 표지를 내보내는지는 여전히 미확인이다(흐름도 §7).
  - 두 호스트 표지가 섞인 셸에서 처음 실행한 지점도 같다(부른 쪽 판별 불가, 이력 없음).
  - G1 은 이 PC 의 호스트 설정 네 파일만 넓혔다. 이름이 파일 서버가 아닌 로컬 쓰기 서버가 그 밖의 저장소 밖 파일을 쓰는 것은 이전처럼 판정하지 않는다(원격 서비스 오탐 방지 — E30 의 판정하지 못한 MCP 이름 기록도 그대로 남은 일이다).
  - Claude '스킬·에이전트' 줄의 처방(소스 `code-agent update`)은 작업 중 안내를 달지 않았다(G3 결정 범위 밖).
