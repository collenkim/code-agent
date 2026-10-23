# Claude·Codex 이중 호스트 프로세스 감사

기준일: 2026-10-07. 기준 커밋: `2c97a43`. 이 감사는 코드를 수정하지 않았다. 현재 동작 지도는 [프로세스 흐름도](../process-flow.md)를 따른다. 원자료는 [process-audit-2026-10-07.json](evidence/process-audit-2026-10-07.json)이다. 근거의 줄 인용(이 기록과 원자료)은 `2c97a43` 트리 기준이다 — 그 뒤 지운 기록·evidence(`doc/reviews/2026-10-01~06` 기록 등)는 `git show 2c97a43:<경로>`로 본다.

처리 현황(지적별 상태·보류 항목의 다음 배정)은 [결과 요약](2026-10-08-procedure-fix-summary.md#감사-160건-처리-현황)에 있고, 행별 원자료는 [procedure-fix-2026-10-08.json](evidence/procedure-fix-2026-10-08.json)의 `disposition`이다.

## 범위와 방법

다음 여섯 가지 질문에 답한다.

1. Claude·Codex를 함께 쓸 수 있고, 각각 단독으로도 쓸 수 있는가.
2. 프로세스 절차에 문제가 없는가.
3. 헤르메스 에이전트처럼 스스로 학습하는 구조인가. 학습이 절차를 지키며 쌓이는가.
4. 최적화할 부분은 무엇인가.
5. 하네스 엔지니어링(카카오 황민호의 revfactory/harness 등) 원칙에 비춰 어떤가.
6. 기능 추가·수정마다 갱신되는 전체 흐름 문서가 필요한가.

| 항목 | 내용 |
|---|---|
| 탐색 | 8개 영역(호스트 동등성, 절차·상태 전이, 동의·hook, 계획·검증·리뷰·반영, 자기학습, 문서, 최적화, 외부 하네스 원칙)을 영역마다 독립 담당이 조사했다 |
| 검증 | 영역마다 별도 검증자가 각 지적을 반박하려는 자세로 원문을 다시 읽고, 필요하면 sandbox에서 재현했다. 이어서 완결성 비평과 흐름도 작성·사실 검증을 거쳤다. 에이전트는 모두 19개다 |
| 실행 | `npm test`: **802개 중 798개 통과·실패 0·생략 4**(133초, Windows, Node 24.19). sandbox 임시 저장소에서 `init --host claude·codex·both`, `doctor`, `hook`·`codex-event`·`stop`·`session-event` 이벤트 주입, `dist` 모듈 직접 호출로 재현했다 |
| 실행하지 않은 것 | 실제 Claude Code·Codex 모델 실행, 사람의 질문 화면·TTY 승인 조작, macOS·Linux |

**결과 수치** — 지적은 160건이다. 탐색자 141건, 검증자 추가 발견 14건, 비평가 추가 5건으로 이뤄진다. 검증자는 탐색 지적 141건 중 93건을 그대로 확인했고, 48건은 범위나 심각도를 조정해 부분 인정했다. 전면 반박된 지적은 없다. 비평가 5건(`GAP-*`)은 비평가가 직접 확인했지만 별도 검증자를 거치지 않았다. GAP-1~3은 sandbox 실험으로, GAP-4·5는 스크립트·저장소 파일 대조로 확인했다.

| 등급 | high | medium | low | info |
|---|---|---|---|---|
| 건수 | 7 | 58 | 86 | 9 |

영역마다 같은 문제를 다른 각도에서 짚은 경우가 많아, 중복을 묶으면 실제 주제 수는 지적 수보다 훨씬 적다. 아래 본문은 주제 단위로 쓰고, 개별 ID는 [부록](#부록-전체-지적-목록)에 있다.

## 결론 요약

| 질문 | 판정 | 핵심 근거 |
|---|---|---|
| 1. 두 호스트·각 호스트 사용 | **구조적으로 가능하다. 다만 Codex 단독의 품질 격차가 있고, both 모드에서는 교차 검증이 조용히 꺼질 수 있다** | 같은 CLI가 단계·게이트·증거를 판정한다. 합성 이벤트 테스트가 Codex 단독으로 접수부터 deliver 직전까지 같은 게이트를 통과한다(`src/test/codex.test.ts:221`). 실제 Codex 호스트 실행은 분석·영향도까지만 확인됐다(HP-21) |
| 2. 절차 | **우회 경로는 없고 전진 경로가 하나다. 다만 게이트가 잘못 열리는 결함 3건과 자동 흐름이 멈추는 교착 여러 건이 있다** | PVR-1·PVR-2는 열린 지적이 지워져 게이트가 열린다(sandbox 재현). FLOW-01은 design·plan 단계의 질문 하나로 흐름이 멈춘다(재현) |
| 3. 자기학습 | **헤르메스식 자기학습 구조가 아니다.** 작업마다 자라는 것은 도메인 KNOWLEDGE 3종뿐이며, 이 경로는 절차를 잘 지킨다 | 교훈·함정·스킬 개선 같은 절차 기억, 실패 신호 환류, 과거 작업 검색, 상한·통합이 없다(LRN-1·HX-1). `update`는 프로젝트 국소 개선을 덮어쓴다(LRN-4) |
| 4. 최적화 | 상시 지침은 이미 작다(약 3.6K자). **왕복 수, 동의 출력 중복, 재배정, 무거운 단일 경로가 다음 대상이다** | OPT-1·2·5·6, HX-5, FLOW-14, OPT-12 |
| 5. 하네스 원칙 | 권한·도구·검증·관측 네 축은 코드로 충족한다. **진화(evolve)·문서 기계 검증·경량 경로·지도 문서가 빠져 있다** | [하네스 엔지니어링 대조](#하네스-엔지니어링-대조) |
| 6. 흐름 문서 | **필요하다. 이번에 작성했다.** 유지 장치는 아직 없다 | [`doc/process-flow.md`](../process-flow.md), 저장소 루트 `AGENTS.md`·`CLAUDE.md`. 이번 감사에서도 영역 보고서의 줄 번호 오기가 나왔고, 흐름도 검증자가 진술 24곳을 바로잡았다 |

## 1. Claude·Codex 사용 가능성

### 잘 된 점

- **템플릿 원본이 하나다.** Codex 설치물은 Claude 템플릿에서 변환해 만들고(`hosts.ts:83-105`), `doctor`가 설치본을 번들과 바이트 단위로 대조한다. sandbox의 both 설치에서 두 호스트 모두 스킬 18·에이전트 8·보조 문서 10이 일치했다.
- **판정은 공통 CLI가 한다.** 호스트별 코드는 `codexHook.ts`·`hosts.ts`·`modelPolicy.ts`에 모여 있다. Codex 동의는 `code-agent consent respond <UUID> <번호>` 형식의 사용자 메시지만 받고, 세션·작업 경로·채널(`codex-prompt`)에 묶인다(`codexHook.ts:33-52`).
- **실패 처리 의미를 맞췄다.** PreToolUse 판정이 실패하면 두 호스트 모두 막는다. Claude는 exit 2, Codex는 deny JSON을 쓴다. Stop은 두 호스트 모두 통과시킨다.

### Codex 단독의 격차

| 주제 | ID | 내용 |
|---|---|---|
| **코드 검색 수단 없음** | HP-1 (high) | 작업·세션 중 Codex 셸은 `rg`·`git grep`·`Select-String`이 모두 거부되고 `code-agent read`·`survey`만 열린다. 반면 변환된 explorer·surveyor 지침은 "Grep으로 좁힌다"를 그대로 지시한다. 영향도·호출자 탐색이 핵심인 절차라 할루시네이션 위험이 Claude보다 크다. **권고**: `read`와 같은 가드를 단 읽기 전용 `code-agent grep`·`files`를 추가한다 |
| 상태 손상 시 원인 확인 불가 | HP-2 | `active.json`·`code-agent.json`이 깨지면 Codex는 원인 파일을 읽을 수 없어, 내용을 보지 못한 채 `apply_patch`로 다시 쓰거나 사람에게 넘겨야 한다. 거부 사유도 Claude 도구(Read·Write)를 안내한다 |
| Stop·SubagentStop 규칙 차이 | CON-11, HP-15 | Codex hook의 차단 해제 규칙이 Claude와 다르다. 질문 대기마다 턴이 강제로 연장되고, `stop_hook_active`가 없으면 반복 차단될 수 있다 |
| CLI 출력·README가 Claude 문법 | HP-5, FLOW-11, OPT-8, DOC-8, DOC-M3 | `status`·`next`·`doctor`·`--help`가 호스트와 무관하게 `/ca-*`·`AskUserQuestion`을 출력한다. README의 핵심 사용 흐름 절도 Claude 전용으로 쓰여 있다 |
| 세션 시작 상태 주입 없음 | HP-6, CON-10, HX-6 | Codex에는 SessionStart를 등록하지 않는다. 그런데 2026-10-02 기록은 실제 Codex 세션에서 SessionStart 호출을 관찰했고, Codex 공식 hook 문서도 지원을 명시한다. 그런데도 `doc/codex.md`는 "확인하지 않았다"로 남아 있다. 출력이 실제 컨텍스트로 주입되는지는 미확인이었다 → 등록은 실제 호스트 반영 `e14dbf9`(H4), 주입은 [결과 요약](2026-10-13-result-summary.md)의 '맥락·상태 빈곳'에서 확인 |
| 역할 읽기 전용 미설정 | HP-7, HOST-M2 | Codex 역할 TOML에 `sandbox_mode`가 없어 reviewer·critic도 `apply_patch`로 파일을 고칠 수 있다. Codex 계획 담당은 작업 폴더 전체에 쓸 수 있다 |
| AGENTS.md 한도 | GAP-2 | 블록을 기존 `AGENTS.md` 끝에 붙인다. 40KB짜리 팀 `AGENTS.md`에서는 블록이 Codex 기본 읽기 한도(32KiB) 밖으로 밀리는데, `doctor`는 ✓로 보고한다 |
| 손으로 관리하는 Codex 동의 절차의 표류 | HP-3, DOC-3, CON-12, OPT-10, FLOW-18, DOC-M2, OPT-M1 | Codex `ca-answer`의 동작 목록에 `repro-log`가 없다. 변환된 `reference.md`는 어디서도 참조하지 않는 고아 파일이고, 과잉 치환된 필드명이 남아 있다 |
| 변환의 조용한 실패 | HP-4, OPT-9, HX-12, VER-M3 | `codexText`의 고정 문장 치환은 템플릿이 한 글자만 바뀌어도 오류 없이 무치환된다. 이를 잡는 테스트가 없다. 지금은 모두 적중하지만, Bash 도구 전용 안내(`timeout 600000`·`run_in_background`)는 변환되지 않고 남는다 |
| 측정 비대칭 | OPT-6, HAR-M1 | `usage`가 Codex를 집계하지 않는다. Codex를 메인으로 쓰는 전체 흐름의 실모델 평가 하네스도 없다 |

### both 모드(교차 검증)

| 주제 | ID | 내용 |
|---|---|---|
| **'실행 불가' 분류가 너무 넓다** | PVR-1, HP-9, HP-8, VER-M2 | 종료 코드≠0, JSON 아님, `is_error`를 모두 '중지'로 기록하고 게이트를 연다. CLI 업그레이드로 플래그가 바뀌거나 모델 ID가 틀려도, Codex 샌드박스가 자식 프로세스를 막아도 교차 검증이 영구히 조용히 꺼질 수 있다 |
| 같은 호스트도 '교차'로 기록 | HOST-M1, PVR-11 | `--by`가 현재 호스트와 같아도 받아들인다 |
| `init`으로는 호스트를 줄일 수 없다 | 흐름도 §7 | `init`은 `hosts.json`을 합집합으로만 기록한다. 줄이려면 사람이 `hosts.json`을 고쳐야 한다. 그런데 `crossNotice`는 "`init --host <호스트>`로 하나만 설치하라"고 안내해 서로 맞지 않는다 |
| 동시 사용 방지 | HP-11, FLOW-16 | "같은 작업에 두 호스트를 동시에 쓰지 않는다"는 문서 규칙뿐이다. 리뷰 기록은 잠금 없이 덮어쓴다 |
| 교차 실행 환경 | HP-10, PVR-10, HP-12, PVR-12, HP-13, HP-20 | 기본 20분 제한이 Claude Bash 최대 10분보다 길다. 자식이 프로젝트 hook을 그대로 로드한다. 교차 리뷰 프롬프트의 지적 번호(X)와 리뷰어 역할 지침(F)이 충돌하고, 형식이 틀리면 전체를 다시 실행한다. 비용 기록과 끄는 스위치가 없다 |
## 2. 프로세스 절차

### 잘 된 점

- 커서는 `next`로만 앞으로 간다. 뒤로는 `back`과 수정 루프의 `check` 되감기(test·review·integrate → check)로만 간다. 게이트를 건너뛰는 경로가 코드에 없다(`commands.ts:516-625`, `633`, `655-658`, `758-789`).
- 승인은 지시서·매니페스트·문서·계획 네 해시에 묶이고, 원장은 해시 사슬이다(`approval.ts:238-283`, `342-387`).
- 검증 증거는 실행 전에 회차를 올리고, 기준 커밋·트리·계획·매니페스트 해시에 결속된다. 모델이 "통과했다"고 보고해도 게이트가 열리지 않는다.
- fix·refactor 규칙(오류 로그 필수, 재현 우선, 테스트 동결)은 문서가 아니라 hook과 게이트가 강제한다.
- 템플릿에 나오는 `code-agent …` 193곳을 CLI와 대조한 결과, 없는 명령·플래그는 0건이었다.
- 작업 모드의 셸 허용 목록은 리다이렉트, `node -e`, PowerShell `Set-Content`, here-doc, `$( )`, `git checkout --` 등 실험한 우회를 모두 막았다.

### 게이트가 잘못 열리거나 리뷰 기록이 사라지는 결함 (P0)

| ID | 내용 | 재현 |
|---|---|---|
| **PVR-1** | 교차 검증이 차단 지적을 낸 뒤 같은 지점을 다시 실행하면, 실행이 실패하더라도 이전 지적이 '중지'로 덮여 게이트가 열린다. 기존 테스트(`p5.test.ts:1920-1932`)도 열린 지적을 재실행으로 지우는 흐름을 정상 경로로 검증한다 | 열린 X1 → exit 2로 실패하는 가짜 codex로 재실행 → `reviewProblems=[]` → `next` 후 integrate |
| **PVR-2** | 같은 리뷰 회차에서 `ca-reviewer`를 다른 `agent_id`로 다시 부르면, 이전 결과(열린 지적)가 흔적 없이 교체된다. '깨끗한 결과가 나올 때까지 다시 부르기'가 가능하다. 사람이 지적을 기각할 공식 경로(PVR-6)가 없어 실제로 일어날 가능성이 높다 | F1 열림 → r2로 Start/Stop('없음') → 열린 지적 사라짐 |
| **VER-M1** | `review cross`가 실행 시작 때 읽은 `review.json`을 몇 분 뒤 그대로 저장한다. 그 사이 기록된 독립 리뷰어 결과와 동결 해제 기록(`used`)이 지워진다. 리뷰어 기록 손실은 게이트가 막히는 쪽(재실행 비용)이지만, `used`가 지워지면 "동결을 푼 지적은 지울 수 없다" 보호가 꺼진다(코드 경로로 확인). 계획 쪽 `planning cross`는 잠금 안에서 다시 읽어 안전하다 | 교차 실행 도중 리뷰어 완료 → `reviewer=null` |

**권고** — 회차·배정별 결과를 append-only 이력으로 남긴다. 완료 기록이 있는 회차의 재실행은 거부하거나, 새 결과가 completed일 때만 교체한다. 그리고 '중지'는 실행 파일 없음·시간 초과·알려진 한도/인증 문구만으로 좁힌다.

### 자동 흐름이 멈추는 교착 (P0·P1)

| ID | 상황 | 결과 |
|---|---|---|
| **FLOW-01** (high) | design·plan 단계 담당이 업무 질문을 내고 사람이 답한다 | 질문 해시가 모든 계획 작업에 들어가(FLOW-14) explore·synthesis가 낡는다. 앞 단계 작업은 `back` 없이 재배정할 수 없고, 스킬은 되감기를 '사용자 지시 시에만' 허용한다. 결국 `blocked`에서 멈춘다 |
| FLOW-03 | 작업 도중 요구사항을 재확정해 승인이 stale이 된다 | CLI의 `다음:`과 스킬 어디에도 재진입 경로가 없다 |
| FLOW-04, PVR-5 | 배정 직후 세션이 끊기거나, 담당 결과가 배정과 맞지 않는다 | attempt가 영구히 running으로 남고 `planning advance`는 계속 `wait`를 반환한다 |
| FLOW-05, PVR-9 | 첫 test 실행이 TC id를 인식하지 못한다 | 테스트 파일이 이미 동결돼, TC 이름 수정조차 재계획 없이는 할 수 없다 |
| FLOW-02 | deliver 단계에서 계획 파일을 고친다 | 되돌아갈 길이 abort뿐이다 |
| FLOW-07 | start 전에 작업 트리에 관련 없는 변경이 있다 | 분석·계획·승인·구현이 끝난 뒤에야 '계획 밖 변경'으로 막힌다 |
| FLOW-08 | 다중 대상 지시서를 대상별로 진행한다 | 같은 브랜치·작업 폴더를 공유해 두 번째 대상이 막힐 수 있다 |
| FLOW-M1 | 계획 기록 잠금이 비정상 종료로 남는다 | 모든 planning 명령이 막히고, 모델은 잠금을 풀 수 없다 |

### 반복 상한과 사람 판단

- **PVR-3, FLOW-06** — 고쳐 쓰기 한도가 진입점마다 다르다. `verify`는 통과한 회차도 세어 막고, `check` 직접 호출은 통과 중이면 무제한이다. 그래서 리뷰→수정 루프에 상한이 없다.
- **PVR-4** — 환경 오류 분류가 전체 로그의 부분 문자열 일치다. 실제 TC 실패가 '환경 오류'로 바뀔 수 있고, 회차를 쓰지 않는 재실행은 상한 없이 반복된다.
- **PVR-6** — 리뷰 지적에 대한 사람 판단(기각·범위 밖 확인)을 기록할 경로가 없다. 안내된 탈출구("그 줄을 지우고 새 회차")도 동작하지 않는다.
- **PVR-17** — 계획 배정의 재시도 상한이 '같은 입력' 기준이라, 입력만 바꾸면 무한히 늘어난다.

### 동의 무결성 (문서상 보안 경계는 아니지만 절차 무결성의 핵심)

| ID | 내용 |
|---|---|
| CON-1 | Codex 동의 응답은 사람 입력과 프로그램 입력(`codex exec` 프롬프트 등)을 구분하지 못한다. 처음 응답한 세션이 그대로 묶인다 |
| CON-2 | 세션 밖 모드에서는 셸 한 줄로 동의를 위조·적용할 수 있다. 적용 함수 자체에는 세션 검사가 없다 |
| CON-3 | 문서 세션의 쓰기 범위를 모델이 `code-agent.json`의 문서 경로를 고쳐 스스로 넓힐 수 있다 |
| CON-4 | 승인 해시는 매니페스트 경계·명령을 묶지만, 사람이 보는 확인 화면에는 그 내용이 없다 |
| CON-5 | Codex에서는 사람이 본 요약과 승인 대상이 결속되지 않는다. 모델이 요약을 옮겨 적으므로 축약·오기가 승인 근거를 오염시킬 수 있다 |
| CON-6 | 일반 업무 질문의 답(`[Answer]`)은 관찰되지 않는다. 모델이 추정한 답으로 '답 없는 질문 금지' 게이트가 열린다 |
| CON-8 | Claude의 `Grep` glob 인자로 키 저장소(`~/.code-agent/credentials.json`) 내용을 읽을 수 있다 |
| LRN-5 | 직접 CLI `code-agent update`(소스 업데이트)가 확인 없이 fetch·pull·(의존성이 바뀌었거나 없으면) `npm ci`·build를 실행한다. 작업 밖에서는 모델의 셸 호출도 hook이 허용한다. [이번 감사 중 실제로 발생했다](#검토-중-발생한-사고) |

### 반영(deliver)

- **PVR-7** — `git add -f`가 `.gitignore`로 뺀 handoff 사본과 실패 배정의 staging 초안까지 반영 커밋에 넣는다. sandbox git 실험으로 확인했다. 주석과 `contract.md`는 "커밋되지 않는다"고 적는다.
- **PVR-8** — 통합 검증·격리 재현이 중단되면 임시 worktree가 남고 다음 실행이 정리하지 않는다.
- **GAP-1** — 영향도·설계용 후보 파일 순위가 소스 3,000개에서 조용히 잘린다. 역순 깊이 우선 순회라 `src/test`가 `src/main`보다 먼저 채워져, 큰 저장소에서는 관련 파일이 후보에서 빠진다.

## 3. 자기학습 구조 — 헤르메스 에이전트 대비

### 지금 작업 간에 쌓이는 것

| 축적물 | 다음 작업에서 다시 쓰이는가 | 절차 준수 |
|---|---|---|
| KNOWLEDGE(데이터 사전·API 목록·업무 규칙) | 배정 입력과 `context`로 들어간다. 단 analysis 배정에는 `business-rules.md`가 빠져 있다(LRN-2) | **잘 지킨다.** 이번 작업 R 번호 근거가 필수다(`knowledge.ts:69-75`). deliver 동의에서 항목별로 사람이 고르고, 코드가 키 단위로 upsert한다. 자동 삭제가 없고, 같은 키 충돌은 양쪽을 보여 준다. 결과는 같은 커밋에 들어간다 |
| POLICY 4종 | 들어간다 | 사람이 확정한다 |
| 검증 증거·리뷰 지적·계획 시도·verify 노드 이력 | **들어가지 않는다.** 모두 그 작업 ID 범위에만 쓰인다 | — |
| 사용자 수정 요청 사유 | 어디에도 구조적으로 남지 않는다(LRN-14) | — |

### 헤르메스와의 격차

| 헤르메스 기능 | code-agent | ID |
|---|---|---|
| 스킬 = 절차 기억. 다단계 성공·오류 극복·사용자 교정 때 스킬을 만들거나 patch한다 | 없다. 학습은 도메인 사실에만 있다 | LRN-1, HX-1, PVR-21 |
| `skills.write_approval` staging → 사람 diff·승인 | KNOWLEDGE에만 같은 방식(제안 파일 → deliver 동의)이 있다 | — (강점) |
| "lessons, not logs" | 템플릿에는 날짜·사건 서술이 0건이다 | — (강점) |
| 메모리 상한(2,200자)과 초과 시 오류 → 통합 | KNOWLEDGE에 상한·린트가 없다. 256KB를 넘으면 뒤 항목이 검색에서 조용히 사라진다 | HX-11, LRN-9, LEARN-M1 |
| frozen snapshot(세션 중 변경은 다음 세션부터) | 해당 장치가 없다 | LRN-10 |
| FTS5 과거 세션 검색 | 과거 작업 문서를 찾는 명령이 없다 | LRN-12, HX-10 |
| 주기적 nudge | 없다. 문서는 "업무 규칙은 질문의 답으로 쌓인다"고 하지만 그 경로가 코드에 없다 | LRN-6 |
| 학습 결과가 갱신에 살아남는다 | `update`가 설치본을 덮어쓴다. 배정은 설치본이 아닌 번들 criteria를 읽어 국소 수정이 애초에 반영되지 않는다 | LRN-4 |
| — | 두 호스트의 자체 기억(Claude auto memory, Codex memories)이 절차 밖 통로로 방치돼 있다. 작업 중에는 hook이 "저장소 밖"으로 거부하고, 세션 밖에서는 검토 없이 쌓인다 | GAP-3 |

### 절차를 지키는 학습 루프 설계안

code-agent의 원칙(코드가 판정하고, 사람이 승인하고, 원장·증거를 남긴다)에 맞춘 설계다. KNOWLEDGE 경로를 그대로 확장한다.

| 요소 | 설계 | ID |
|---|---|---|
| 무엇을 | 교훈(lesson)·함정(pitfall)·스킬 보강(skill-patch)·사용자 선호(preference). 항목 형식은 KNOWLEDGE의 ``### `키` 제목``을 재사용하고 `언제/하라/함정/확인/근거` 줄을 둔다 | LRN-7 |
| 어디에 | 프로젝트 소유 `doc/code-agent/lessons/<영역>.md`(영역은 단계·호스트·환경). 스킬 보강은 `doc/code-agent/skills/<스킬>.md` 오버레이 | LRN-7, LRN-11 |
| 언제 | **코드가 결정론적으로 후보를 만든다.** verify 회차 ≥2, repair→pass, 환경 분류, planning 재시도·형식 교정, 리뷰 회차 ≥2·교차만 낸 지적, 요구·계획 반려 사유, 동의 수정 요청이 신호다. deliver 동의 준비 때 `lessons.candidates.json`을 만들고, 모델은 후보 ID를 근거로 일반화한 제안을 쓴다 | LRN-8, LRN-14 |
| 게이트 | KNOWLEDGE와 **같은 deliver 동의**에서 항목별로 고른다. 근거 후보 ID·증거 경로가 실재하는지 코드가 확인한다. 상한(항목 600자, 영역 4,000자)을 넘으면 자동 압축하지 않고 거른 뒤 prune 동의로 정리한다. 사건 서사·날짜는 린트로 거르고, 중복 키는 양쪽을 보여 준다. 자동 삭제는 없다 | LRN-9 |
| 판정과의 분리 | 교훈은 지침이므로 승인 해시에 넣지 않는다. 판정을 바꾸는 것(`environmentErrors`·`commands`·`stages`)은 교훈이 아니라 매니페스트 변경과 재승인 경로로 보낸다(`approval.ts:206-208`의 선례) | LRN-1 |
| 주입 | 두 호스트 공통 경로(배정 파일·`context --file`)에 **색인만** 싣고, 본문은 `code-agent read`로 필요할 때 읽는다(progressive disclosure). 작업 시작 시 색인 해시를 고정해, 작업 중 바뀐 내용은 다음 작업부터 반영한다 | LRN-10 |
| `update`와 공존 | 설치본은 번들 그대로 둔다. `init`이 `.code-agent/installed.json`에 파일별 설치 해시를 기록하면, `update`가 수동 수정을 정확히 가려 오버레이로 옮길 diff를 남길 수 있다 | LRN-11, HX-7 |
| 과거 검색 | LLM 없이 `code-agent recall <질의>`로 커밋된 작업 문서·질문 답·리뷰 지적·교훈을 키워드 점수로 찾는다. 배정 파일에는 상위 경로 몇 개만 싣는다 | LRN-12 |
| 효과 측정 | `code-agent retro`로 역할별 재시도·첫 통과까지의 회차·재발률을 집계한다. 효과 없는 교훈은 prune 후보로 올린다 | LRN-13 |
| 호스트 기억 정책 | `init`이 Claude auto memory·Codex memories의 사용 정책을 명시하고, `doctor`가 상태를 보고한다 | GAP-3 |

## 4. 최적화

| 대상 | 현황 | 제안 | ID |
|---|---|---|---|
| 메인 왕복 | v3 실측에서 메인 비용 $3.25 중 캐시 읽기·쓰기가 대부분이다 | `planning advance`가 ready-for-gate면 게이트와 다음 단계 advance까지 잇는 연쇄 모드를 둔다. `consent prepare --action <동작>`으로 JSON 파일 쓰기를 없앤다 | OPT-1 |
| 동의 출력 | prepare 출력 3,639자에 summary가 4번 들어간다 | 호스트별로 필요한 필드만 출력한다(50~70% 감소) | OPT-2 |
| `ca-answer` 재읽기 | 7,128자를 질문·동의 직전마다 다시 읽는다 | "이 대화에서 아직 안 읽었거나 압축 뒤라면"으로 조건을 단다. 질문·동의 절차를 두 파일로 나눈다 | OPT-3 |
| 형식 오류 재배정 | 결정적 문서 검사가 `next`에서만 돈다 | 완료 hook에서 같은 검사를 돌려 같은 담당에게 1회 되돌린다 | OPT-5 |
| 질문 해시 범위 | 질문 하나가 모든 계획 작업을 무효화한다 | 질문에 출처 작업을 기록하고, 무효화를 그 작업과 후속 작업으로 한정한다 | FLOW-14 |
| 측정 | 토큰 합계만 남는다 | 단계·에이전트별 요청 수, 도구 호출 수, 재배정 수를 기록한다. Codex 세션 로그도 집계한다 | OPT-6 |
| 모델 정책 | Claude 역할 8개가 모두 opus이고 추론 강도가 없다(Codex는 역할별 high·medium) | implementer·tester·writer·explorer를 sonnet으로 바꾸는 A/B를 3회 이상 돌려 완주 작업당 비용으로 판단한다. 단가표에 `claude-sonnet-5-5`가 없다 | OPT-12, HX-9, OPT-13 |
| 경량 경로 | 작업 크기와 무관하게 같은 무거운 경로를 탄다 | 코드가 판정하는 `size: small` 경로를 둔다(03·04 축약, critic 단일 패스, 위험 표지가 없으면 교차 생략). 사람 확인 3지점과 증거는 유지한다 | HX-5 |
| hook 기동 | 1회 약 100ms(Node 기동 25ms + 모듈 128개 로드) | hook 전용 번들 진입점을 두고 지연 require를 쓴다(호출당 25~30ms) | OPT-15 |
| 테스트 | `p5.test.ts`가 132초로 임계 경로다 | 주제별 3~4개 파일로 나눈다(벽시계 약 50% 감소). `p5`~`p8` 이름을 도메인 이름으로 바꾼다 | OPT-11 |
| 크기 예산 | 측정 뒤 지침이 다시 늘었다 | 템플릿 크기 상한 테스트를 둔다 | OPT-4 |

## 하네스 엔지니어링 대조

출처: [revfactory/harness](https://github.com/revfactory/harness)(카카오 AI네이티브 전략팀 황민호. `skills/harness/SKILL.md`·`skills/evolve/SKILL.md`·`references/*` 원문), [Hermes Agent 스킬](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)·[메모리](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), Anthropic [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)·[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps), OpenAI [Harness engineering](https://openai.com/index/harness-engineering/)(웹 아카이브 사본). 카카오 발표 영상([YouTube](https://www.youtube.com/watch?v=klfhUVnc44U))은 제목만 확인했고 내용은 인용하지 않는다.

| 원칙 | 출처 | 판정 | 근거·ID |
|---|---|---|---|
| 누가(에이전트)·어떻게(스킬) 분리 | harness | 충족 | 역할 8 + 단계 스킬 18 |
| 순서·반복을 코드로 정할 수 있으면 워크플로로 | harness | 충족 | `planning advance`, `verify --json` |
| 생성과 평가 분리, 회의적 독립 평가자 | harness, Anthropic | 충족 | 읽기 전용 critic·reviewer, 교차 검증. 단 Codex 역할은 읽기 전용 미설정(HP-7) |
| JSON 원본, 모델은 판정 필드만 | Anthropic | 충족 | `request.json`·`plan.json` 원본, 렌더 문서 쓰기 거부 |
| 파일 전달·reset과 handoff | harness, Anthropic | Claude 충족, Codex 부분 | 배정 파일·staging·SessionStart. Codex는 SessionStart 없음(HX-6) |
| 진행적 공개, SKILL.md 500줄 미만 | harness, Hermes | 충족 | 스킬 21~132줄, `criteria`·`legacy`·`reference` 분리 |
| 재시도 상한, 한도·인증 실패는 재시도 금지 | harness | 충족(일부 불일치) | fixRounds 2, 배정 3, 교정 1. 진입점별 불일치(PVR-3), 환경 재시도 무상한(PVR-4) |
| 모델을 업무 성격으로 선택하고 이유를 기록 | harness | 부분 | Claude 전부 opus(HX-9) |
| CLAUDE.md에는 호출 조건과 **변경 이력** | harness | 부분 | 설치 블록에 이력·버전이 없다. 버전이 1.0.0 고정(HX-7) |
| 실행에서 배운 것을 반영(evolve) | harness, Hermes | **없음** | HX-1, LRN-1 |
| 메모리 상한·통합, 과거 세션 검색 | Hermes | **없음** | HX-11, HX-10 |
| 지도(약 100줄 AGENTS.md) + 기록 시스템(docs/) | OpenAI | 부분 → 이번에 보완 | 설치 블록은 짧지만 이 저장소에는 지도가 없었다(HX-2, DOC-1) |
| 문서 신선도의 기계 검증, doc-gardening | OpenAI | **없음** | HX-3, DOC-11 |
| 작은 일에는 가벼운 계획 | OpenAI | **없음** | HX-5 |
| 구성 요소를 하나씩 빼는 실험, 모델 교체 시 재검토 | Anthropic | 부분 | 평가 스크립트는 있지만 Claude만, 출하와 다른 모델로 측정(GAP-4) |
| 모듈 완성마다 QA, 시작 시 기준선 확인 | harness, Anthropic | 부분 | 첫 빌드가 모든 Task 뒤에 돈다(HX-8) |
| 스킬 description에 호출 조건과 경계 | harness | 부분 | 경계 문구와 호출 조건 검증이 없다(HX-13) |

## 흐름도 문서와 유지 장치

### 이번에 작성한 것

| 파일 | 내용 |
|---|---|
| [`doc/process-flow.md`](../process-flow.md) | 현재 동작 지도. 10개 절로 구성된다: 변경→갱신 대응표, 한 장 흐름도(Mermaid), 스테이지별 진입·담당·CLI·산출·게이트·실패 전이, 동의 13종과 호스트별 응답 관찰, hook 등록표(Claude 9·Codex 5)와 PreToolUse 판정 순서, 계획 오케스트레이션·검증 노드·교차 검증, Claude·Codex 차이표, 상태·산출물 파일 지도, 코드 모듈 지도, 변경 이력. 주요 표에 `file:line` 근거를 달았고, 별도 검증자가 코드와 대조해 24곳을 고쳤다 |
| `AGENTS.md`·`CLAUDE.md`(저장소 루트) | code-agent **자체를 개발하는** 에이전트의 진입점. 흐름도를 먼저 읽게 하고, 동작을 바꾸면 같은 커밋에서 흐름도를 갱신한다는 규칙을 둔다. `CLAUDE.md`는 `AGENTS.md`를 import한다. 대상 프로젝트에 설치되는 `template/CLAUDE.block.md`와는 별개다 |

### 왜 필요한가 — 이번 감사의 관찰

- 영역 보고서 일부가 존재하지 않는 줄 번호를 인용했다. 예를 들어 224줄짜리 파일의 `planningState.ts:405-412`, 29줄짜리 파일의 `modelPolicy.ts:140-153`이다. 지도가 없으면 에이전트도 추정으로 채운다.
- 문서 영역 지적이 이미 17건이고(DOC-*), 그중 드리프트가 10건이다. hook 수는 문서마다 다르고(DOC-4), 담당 에이전트 서술은 코드와 다르다(DOC-6). 스테이지 번호 체계는 13단계 목표 번호와 design의 7~11 둘이고, `usage.md`의 설명 한 줄은 CLI 출력과 다르다(DOC-5). 같은 사실이 현행 문서 4~8곳과 코드 5곳에 중복된다(DOC-10).
- 문서와 코드를 대조하는 테스트가 없다(DOC-11, HX-3). README 서두처럼 현행 문서에 변경 이력이 섞여 있다(DOC-12).

### 아직 없는 유지 장치 (제안)

1. **문서-코드 대조 테스트.** `PHASES`, 동의 동작(`ActionSchema`), `init`의 hook 등록, Codex 이벤트, 스킬·에이전트 수를 코드에서 읽어 흐름도의 표와 대조한다. 이를 위해 지역 상수(`ActionSchema`·`TITLES`·`PHASE_LABEL`·hook 등록 목록)를 export 상수로 올린다(DOC-13). 동작 변경이 없는 리팩터링이라 기존 테스트가 회귀를 지켜 준다.
2. **생성 블록.** hook 등록표·동의 목록·스테이지 표는 `<!-- generated:… -->` 구간을 스크립트가 렌더하고, 테스트가 바이트로 대조한다. 사람이 쓰는 절(목적·흐름 설명)과 기계가 쓰는 절을 나눈다.
3. **변경 규칙.** 루트 `AGENTS.md`에 "같은 커밋에서 흐름도 §1.1 대응표대로 갱신"을 둔다(이번에 추가함). 에이전트가 같은 실수를 반복하면 규칙 한 줄과 사건 링크를 덧붙인다(harness의 진화 원칙).
4. **현행과 이력 분리.** README 서두의 이력 문단은 `doc/reviews/`로 옮기고, 현행 문서에는 현재형만 쓴다(DOC-12).
5. **절차 버전.** 템플릿·게이트를 바꾸는 커밋마다 버전을 올리고, 설치 블록에 절차 버전과 이력 링크를 둔다(HX-7).
6. **doc-gardening.** 릴리스 전에 흐름도·README·`doc/*.md`를 코드와 대조하는 점검을 정기적으로 돌린다(OpenAI).

## 우선 조치 제안

| 순위 | 대상 | 이유 |
|---|---|---|
| P0 | PVR-1, PVR-2, VER-M1 | 독립 리뷰·교차 검증 게이트가 잘못 열리거나 리뷰 기록이 사라진다 |
| P0 | FLOW-01(+FLOW-14) | design·plan 단계의 흔한 질문 하나로 자동 흐름이 멈춘다 |
| P0 | HP-1 | Codex 단독 품질의 가장 큰 격차다(검색 불가 → 추정) |
| P1 | HP-9·HP-8·VER-M2, PVR-3·PVR-4·PVR-17, PVR-6 | 교차 검증이 조용히 꺼지는 것과 반복 상한 불일치. 사람 판단 경로가 없어 우회를 부른다 |
| P1 | FLOW-03, FLOW-04·PVR-5, FLOW-05·PVR-9, FLOW-02, FLOW-07, FLOW-M1 | 재개·교착 |
| P1 | PVR-7, PVR-8, CON-8, LRN-5, GAP-1 | 반영 범위, 잔여 worktree, 키 노출, 무확인 소스 업데이트, 큰 저장소 후보 누락 |
| P2 | HP-2, HP-5 묶음, HP-6 묶음, HP-7, GAP-2, HP-3 묶음, HP-4 묶음 | Codex 동등성 |
| P2 | CON-1~6 | 동의 결속 강화 |
| P3 | 흐름도 유지 장치, 자기학습 루프(LRN-7~14), OPT-*, HX-5, HX-7, GAP-4, GAP-5 | 구조 개선 |

## 검토 중 발생한 사고

learn 영역의 sandbox 실험이 `code-agent update`(소스 업데이트)를 실행했다(LEARN-M2). 이 명령은 확인 없이 code-agent 소스 저장소에서 `git fetch`·`pull --ff-only`·`npm ci --include=dev`(의존성이 바뀌었거나 없을 때)·`npm run build`를 수행한다(LRN-5). 그 결과 2026-10-07 10:15:36~38에 이 저장소의 `node_modules`와 `dist`가 다시 만들어졌다.

- 소스는 바뀌지 않았다. HEAD는 `2c97a43` 그대로이고 작업 트리도 깨끗했다(이미 최신이라 pull은 변화가 없었다).
- 기준 테스트는 10:10:10에 끝나 이 재빌드와 겹치지 않았다.
- 이 사고는 LRN-5의 실증이다. 실험 지침에는 "`update`는 `--templates-only`로만"을 명시해야 한다. 루트 `AGENTS.md`에 이 규칙을 넣었다.

## 한계

- 실제 Claude Code·Codex 모델은 실행하지 않았다. Codex 실호스트 증거는 이전 기록의 분석·영향도까지다. 다음 항목은 미확인이다: Codex hook 이벤트가 `agent_id`·`stop_hook_active`를 실제로 주는지, exit 2를 받은 Codex가 담당을 이어 실행하는지([흐름도 §5.2](../process-flow.md)), Codex 셸에서 교차 실행이 실제로 막히는지(HP-8).
- Codex 단독 경로는 합성 이벤트 테스트가 deliver 직전까지 확인한다. Codex 동의로 deliver를 적용하는 경로는 테스트가 없다(동의 메커니즘은 공통).
- 카카오 발표 영상의 내용은 확보하지 못했다. 카카오 쪽 원칙은 revfactory/harness 저장소 원문과 도서 소개만 인용했다.
- 사람의 질문 화면·TTY 승인은 조작하지 않았다. 대형 저장소 성능은 일부만 측정했다(CON-15, GAP-1). Windows에서만 실행했고 CI는 없다(GAP-5).
- `src/agent/plugins/*`, `core/workOrder.ts`, `schemas.ts`, `survey.ts` 일부는 정독 범위 밖이다.

## 부록: 전체 지적 목록

160건의 등급(검증 후 값 `severity`, 탐색 때 값 `reportedSeverity`)·판정·영역·호스트·종류·제목·위치·권고 전문은 원자료 [process-audit-2026-10-07.json](evidence/process-audit-2026-10-07.json)의 `findings`에 있다. 판정 `confirmed`(확인)는 검증자가 그대로 확인한 것, `partially`(부분)는 범위·심각도를 조정한 것, `verifier-found`(검증자 발견)는 검증자가 추가로 찾은 것, `critic-checked`(비평가 확인)는 완결성 비평가가 직접 확인한 것이다.
