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
