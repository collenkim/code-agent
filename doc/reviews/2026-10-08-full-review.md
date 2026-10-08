# 전체 검토 반영과 흐름도·코드 대조 시험 (2026-10-08)

감사([2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)) 뒤 구현 전체(`ff13950..934e5fe` — 공통 재시도 규약 모듈, C2 계획, C3 검증, C6 역할별 모델, C1 리뷰·교차, C5 동의, C4 단계·CLI·임대, C7 최적화)를 네 관점(e2e·재시도 규약·hook·문서)으로 독립 검토한 지적 43건을 처리했다. 지적마다 코드로 확인하고, 맞으면 고친 뒤 회귀 시험을 더했다. 시험은 수정을 되돌리면 실패하는 것까지 확인했다. 틀린 지적은 근거를 적고 반영하지 않았다. 사용자 결정을 바꾸는 수정은 하지 않고 아래 '사용자 결정 필요'에 남겼다.

## 방법

- 기준은 `934e5fe`다. 실험은 작업 scratchpad 의 `sandbox-stage7-final/` 임시 저장소에서 했다. 이 저장소 루트에는 init 하지 않았다.
- 실제 Claude·Codex 모델은 부르지 않았다. 교차 실행은 가짜 호스트 실행 파일(`CODE_AGENT_CLAUDE_BIN`·`CODE_AGENT_CODEX_BIN`)로 확인했다. `code-agent update` 는 쓰지 않았다.
- 회귀 시험은 주로 [`fullReview.test.ts`](../../src/test/fullReview.test.ts)에 있다(임시 git 저장소 `stageFixture` 에 실제 함수를 부른다). 나머지는 기존 주제 파일에 더했다. 시험 이름에 지적 번호(E1~E43)를 붙였다.
- 사용자 결정(절차 결함 보완, 실패 원인별 재시도 규약, 최적화 — HX-5 제외, Claude 역할별 모델, 자가 학습 보류, 사람 확인 지점 셋 유지, 교차 실행 불가 시 중지 기록 후 진행, 두 호스트 설치 시 교차 필수)은 그대로 두었다.

## 지적과 처리

상태: **반영**(지적대로 고침) · **일부**(핵심을 고치고 남은 부분을 적음) · **결정**(사용자 결정 필요 — 코드는 바꾸지 않거나 최소안만).

### e2e (E1~E12)

| 번호 | 지적 | 상태 | 처리 | 시험 |
|---|---|---|---|---|
| E1 | 환경 오류로 진단 노드일 때 `다음:`·허용 적용 뒤 next 가 `verify --json`(재실행 없음)을 안내한다 | 반영 | `nextHint` check·test 갈래가 진단(전제 조건 제외)이면 `code-agent verify --json --retry` | fullReview E1 |
| E2 | 작업 중 `model` 동의가 커밋된 설치 파일을 바꿔 계획 밖 변경이 되고, 빠져나갈 길이 없다 | 일부·결정 | 진행 중 작업이 있으면 동의 요약과 적용 뒤 next 에 '계획 밖 변경이 된다' 경고(`modelWorkWarning`). 근본 처리는 사용자 결정(아래) | fullReview E2 |
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
| E16 | 샌드박스 의심 지점의 두 번째 네트워크 오류가 실행 불가(중지 기록 후 진행)가 되어 사람 판단 없이 교차가 빠진다 | 결정 | 코드는 그대로 두었다. §6.4 표 host-sandbox-denied 판별 칸에 '같은 지점 두 번째 네트워크 오류는 실행 불가로 기록 후 진행'을 렌더해 문서화했다 | docSync §6.4 |
| E17 | 끊긴 test 의 재실행 한도 거부(`RetryRefused`)를 test.execute 가 잡지 않아 verify 가 예외로 끝난다 | 반영 | test.execute 도 `limit-exceeded` 면 blocked → decision(§6.2 TE→DC) | fullReview E17 |
| E18 | 샌드박스 표지 사전 거부가 부를 때마다 시도를 하나씩 쌓는다 | 반영 | 같은 사유 사전 거부가 마지막 시도면 다시 쌓지 않는다(리뷰·계획 양쪽) | crossReview E18 |
| E19 | SubagentStop 판정 실패가 원인과 무관하게 exit 2 이고 기록이 없어 실행이 고아 기한까지 '실행 중' | 일부 | 리뷰어 실행에 `hook-failure` 를 기록하고 0(새 호출을 받는다), 형식 되돌림(`ReturnToReviewer`)만 2. 기록하지 못한 판정 실패는 2로 남긴다 — 계획 쪽 일시 잠금 실패 재시도에 쓰이는 §5.1 문서화 동작이다. §6.4 산문·표를 이 규칙으로 맞췄다 | crossReview E19 |
| E20 | 실행 파일 변수가 없는 파일을 가리키거나 PATH 에 셸 스크립트만 있어도 실행 불가로 진행한다 | 반영 | `hostCommandConfigError` → `cross-config-error`(kind config)로 막는다. 미설치만 실행 불가. '두 호스트 설치 시 교차 필수'에 맞춘 엄격화다 | review-gate E20 · retryPolicy fixture |
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

## 사용자 결정 필요

1. **작업 중 역할 모델 변경(E2, C4 인계 #9)** — 설치 파일(`.claude/agents/ca-*.md`·`.codex/agents/ca-*.toml`)을 계획 밖 변경 대조에서 뺄지, 작업 중에는 `model` 동의와 `update --templates-only` 를 막을지 정해야 한다. 지금은 경고만 낸다.
2. **샌드박스 의심 지점의 두 번째 네트워크 오류(E16)** — 지금은 실행 불가로 중지 기록 후 진행한다(§6.4 에 문서화). 사람 `judgment cross-stop` 으로만 중지하게 바꾸면 '교차 실행 불가 시 중지 기록 후 진행'과 부딪히고, 두면 모델의 재실행 한 번으로 교차가 빠질 수 있다.
3. **실행 파일 설정 오류의 분류(E20)** — 설정 오류로 막는 엄격화로 반영했다. '두 호스트 설치 시 교차 필수'와 맞는다고 판단했지만, 명세 §2.3(실행 불가)과 다르므로 확인을 권한다.
4. (참고) 감사 GAP-5 — CI 도입과 실행 플랫폼은 [감사 처리 현황](2026-10-08-audit-disposition.md)의 보류 표에 있다.

## 결과

`npm run build && npm test` 단일 전체 실행: **1292개 중 1288개 통과·실패 0개·생략 4개**(130초). 그 앞 실행 한 번은 기존 시험 하나(crossReview '게이트 쪽 고아 보기 — 사람이 아닌 중지 지점…')가 실패했다 — 죽은 pid 를 끝 기록 없는 시도로 쓰는 시험인데, 병렬 시험이 그 pid 를 다시 받아 살아 있는 실행으로 보였다(단독 4회·다음 전체 실행 통과, 이번 변경과 무관한 Windows pid 재사용). 시작 시점(`934e5fe`)은 1265개 중 1261개 통과·실패 0개·생략 4개였다.
