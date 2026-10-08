# Claude·Codex 이중 호스트 프로세스 감사

기준일: 2026-10-07. 기준 커밋: `c4f3fbf`. 이 감사는 코드를 수정하지 않았다. 현재 동작 지도는 [프로세스 흐름도](../process-flow.md)를 따른다. 원자료는 [process-audit-2026-10-07.json](evidence/process-audit-2026-10-07.json)이다.

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
| 세션 시작 상태 주입 없음 | HP-6, CON-10, HX-6 | Codex에는 SessionStart를 등록하지 않는다. 그런데 2026-10-02 기록은 실제 Codex 세션에서 SessionStart 호출을 관찰했고, Codex 공식 hook 문서도 지원을 명시한다. 그런데도 `doc/codex.md`는 "확인하지 않았다"로 남아 있다. 출력이 실제 컨텍스트로 주입되는지는 미확인이다 |
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

- 소스는 바뀌지 않았다. HEAD는 `c4f3fbf` 그대로이고 작업 트리도 깨끗했다(이미 최신이라 pull은 변화가 없었다).
- 기준 테스트는 10:10:10에 끝나 이 재빌드와 겹치지 않았다.
- 이 사고는 LRN-5의 실증이다. 실험 지침에는 "`update`는 `--templates-only`로만"을 명시해야 한다. 루트 `AGENTS.md`에 이 규칙을 넣었다.

## 한계

- 실제 Claude Code·Codex 모델은 실행하지 않았다. Codex 실호스트 증거는 이전 기록의 분석·영향도까지다. 다음 항목은 미확인이다: Codex hook 이벤트가 `agent_id`·`stop_hook_active`를 실제로 주는지, exit 2를 받은 Codex가 담당을 이어 실행하는지([흐름도 §5.2](../process-flow.md)), Codex 셸에서 교차 실행이 실제로 막히는지(HP-8).
- Codex 단독 경로는 합성 이벤트 테스트가 deliver 직전까지 확인한다. Codex 동의로 deliver를 적용하는 경로는 테스트가 없다(동의 메커니즘은 공통).
- 카카오 발표 영상의 내용은 확보하지 못했다. 카카오 쪽 원칙은 revfactory/harness 저장소 원문과 도서 소개만 인용했다.
- 사람의 질문 화면·TTY 승인은 조작하지 않았다. 대형 저장소 성능은 일부만 측정했다(CON-15, GAP-1). Windows에서만 실행했고 CI는 없다(GAP-5).
- `src/agent/plugins/*`, `core/workOrder.ts`, `schemas.ts`, `survey.ts` 일부는 정독 범위 밖이다.

## 부록: 전체 지적 목록

등급은 검증 후 값이다. 탐색 때와 다르면 괄호에 원래 등급을 적는다. 판정 '확인'은 검증자가 그대로 확인한 것, '부분'은 범위·심각도를 조정한 것이다. '검증자 발견'은 검증자가 추가로 찾은 것, '비평가 확인'은 완결성 비평가가 직접 확인한 것이다. 각 항목의 권고 전문은 증거 JSON의 `recommendation`에 있다.

| ID | 등급 | 판정 | 영역 | 호스트 | 제목 | 위치 |
|---|---|---|---|---|---|---|
| DOC-2 | high | 확인 | 문서 | both | 접수→반영 전 과정을 한 장으로 보여 주는 흐름 문서가 없고, 부분 흐름은 4곳에 따로 있다 | `README.md:51-58`<br>`README.md:136-144` 외 4 |
| FLOW-01 | high | 확인 | 절차 | both | design·plan 단계에서 나온 질문에 답하면 앞 단계 계획 작업이 낡아져 자동 흐름이 멈춤 (스킬 지시와 CLI 거부가 충돌) | `src/agent/planningState.ts:137-153`<br>`src/agent/planning.ts:58-60` 외 7 |
| HX-1 | high | 확인 | 하네스 | both | 절차(스킬·에이전트) 자체를 학습하는 루프가 없다. 학습은 도메인 KNOWLEDGE 3종에만 있다 | `src/agent/update.ts:83-85`<br>`src/agent/update.ts:120-125` 외 5 |
| HP-1 | high | 확인 | 호스트 | codex | Codex는 작업·세션 중 코드 검색 수단이 없음 (Claude는 Grep/Glob 사용 가능) | `src/agent/hook.ts:73`<br>`src/agent/hook.ts:404-408` 외 3 |
| LRN-1 | high | 확인 | 자기학습 | both | 절차 기억(스킬·교훈) 학습 루프 부재 — 헤르메스·하네스의 피드백 루프에 해당하는 장치가 없다 | `doc/reviews/2026-10-06-token-efficiency.md:7`<br>`src/agent/verificationFlow.ts:45-47` 외 7 |
| PVR-1 | high | 확인 | 검증·리뷰 | both | 교차 검증의 열린 지적이 같은 지점 재실행(또는 실행 실패)으로 지워지고, 인자 오류 같은 설정 결함도 '사용 불가'로 분류돼 게이트가 열린다 | `src/agent/crossCheck.ts:81-87`<br>`src/agent/crossCheck.ts:139-148` 외 7 |
| PVR-2 | high | 확인 | 검증·리뷰 | both | 같은 리뷰 회차에서 ca-reviewer 를 다시 호출하면 이전 결과(열린 지적)가 흔적 없이 덮여 게이트가 열린다 | `src/agent/reviewHook.ts:50-53`<br>`src/agent/reviewHook.ts:84-91` 외 2 |
| CON-1 | medium (원 high) | 부분 | 동의·hook | codex | Codex 동의 응답은 사람 입력과 프로그램 입력(codex exec 프롬프트 등)을 구분하지 못하고, 처음 응답한 세션이 그대로 바인딩된다 | `src/agent/codexHook.ts:33-52`<br>`src/agent/consent.ts:385` 외 8 |
| CON-2 | medium | 확인 | 동의·hook | both | 세션 밖 모드에서는 동의 위조 한 줄과 세션 검사 우회 적용이 hook 을 통과한다 — 적용 함수 자체에는 세션 검사가 없다 | `src/agent/consent.ts:456-509`<br>`src/agent/consent.ts:510-515` 외 5 |
| CON-3 | medium | 확인 | 동의·hook | both | 문서 세션의 쓰기 범위를 모델이 code-agent.json 의 문서 경로로 스스로 넓힐 수 있다 | `src/agent/hook.ts:352-364`<br>`src/agent/docs.ts:47-61` 외 2 |
| CON-4 | medium | 확인 | 동의·hook | both | 승인 해시는 매니페스트 경계·명령을 묶지만 사람이 보는 확인 화면에는 그 내용이 없다 (stale-manifest 재승인에도 diff 없음) | `src/agent/commands.ts:1331-1337`<br>`src/core/approval.ts:182-211` 외 4 |
| CON-5 | medium | 확인 | 동의·hook | codex | Codex 동의는 사람이 본 요약과 승인 대상이 결속되지 않는다 (요약을 모델이 옮겨 적는다) | `template/codex/ca-answer.md:19-20`<br>`src/agent/codexHook.ts:33-52` 외 2 |
| CON-6 | medium | 확인 | 동의·hook | both | 일반 업무 질문의 답([Answer])은 관찰되지 않는다 — 진행 게이트가 모델이 쓴 답으로 열린다 | `src/agent/consent.ts:365-366`<br>`src/agent/questions.ts:33-67` 외 2 |
| CON-8 | medium | 확인 | 동의·hook | claude | Grep 의 glob 인자로 키 저장소(~/.code-agent/credentials.json) 내용을 읽을 수 있다 | `src/agent/hook.ts:205-207`<br>`src/agent/hook.ts:47` 외 1 |
| GAP-1 | medium | 비평가 확인 | 비평 | both | 영향도·설계 단계의 '관련 후보 파일 순위'가 소스 파일 3,000개에서 조용히 잘리고, 역순 깊이 우선 순회 탓에 src/test가 src/main보다 먼저 채워진다 | `src/agent/plugins/defaults.ts:99`<br>`src/agent/plugins/protocol.ts:21` 외 5 |
| GAP-2 | medium | 비평가 확인 | 비평 | codex | Codex 지침 블록을 AGENTS.md 끝에 덧붙인다. 기존 AGENTS.md가 크면 블록이 Codex 기본 읽기 한도(32KiB) 밖으로 밀리는데, doctor는 ✓로 보고한다 | `src/agent/init.ts:28-41`<br>`src/agent/init.ts:190` 외 2 |
| GAP-3 | medium | 비평가 확인 | 비평 | both | 두 호스트의 자체 기억 기능(Claude 자동 메모리, Codex memories)이 code-agent 절차 밖의 학습 통로로 방치돼 있다. 세션 중에는 hook이 '저장소 밖'으로 거부하고, 세션 밖에서는 검토 없이 쌓인다 | `src/agent/hook.ts:264-272`<br>`src/agent/hook.ts:213-216` 외 5 |
| DOC-1 | medium (원 high) | 부분 | 문서 | both | code-agent 저장소 자체에는 개발 에이전트 지침(CLAUDE.md·AGENTS.md·.claude/)이 없다 | `.gitignore:1-5`<br>`README.md:265-277` 외 1 |
| DOC-3 | medium | 확인 | 문서 | both | consent action `repro-log`가 action 목록 사본 3곳에서 빠졌다. Codex ca-answer에는 아예 언급이 없다 | `src/agent/consent.ts:29`<br>`template/claude/skills/ca-answer/reference.md:18` 외 4 |
| DOC-4 | medium | 확인 | 문서 | claude | Claude hook 수·등록표가 문서마다 다르다. usage.md는 8개(이벤트 5종)로 적고, init 표에서 5개가 빠졌으며 matcher에 PowerShell이 없다 | `doc/usage.md:12`<br>`doc/usage.md:82-90` 외 3 |
| DOC-6 | medium | 확인 | 문서 | both | 영향도·설계 담당 에이전트 서술이 코드와 다르다. usage.md 안에서도 design 담당이 writer와 analyst로 엇갈리고, 소규모 통합 impact는 빠졌다 | `doc/usage.md:210-211`<br>`doc/usage.md:471` 외 6 |
| DOC-10 | medium | 확인 | 문서 | both | 같은 사실이 문서와 코드에 여러 번 기재된다. 커밋마다 현행 문서 4~8개를 손으로 고치고 있고, 코드도 hook 표를 5곳에 중복한다 | `README.md:63-68`<br>`doc/install.md:37` 외 9 |
| DOC-11 | medium | 확인 | 문서 | both | 문서-코드 대조 테스트가 없어 드리프트가 기계적으로 잡히지 않는다 | `src/test/docs.test.ts:1-20`<br>`src/test/p8.test.ts:143` 외 3 |
| FLOW-02 | medium | 확인 | 절차 | both | deliver 단계에서 계획 파일을 고치면 되돌아갈 길이 없음 (abort 외 막다른 상태) | `src/agent/hook.ts:492-540`<br>`src/agent/commands.ts:633` 외 5 |
| FLOW-03 | medium | 확인 | 절차 | both | 작업 도중 요구사항 재확정 등으로 승인이 무효(stale-*)가 되면 재진입 경로를 CLI와 스킬 어디에서도 안내하지 않음 | `src/agent/commands.ts:393-423`<br>`src/agent/commands.ts:1317` 외 5 |
| FLOW-04 | medium | 확인 | 절차 | both | 배정 직후 세션이 끊기면 planning advance가 영구히 'wait'를 반환하고, 스킬은 기다리라고만 지시함 | `src/agent/planning.ts:236`<br>`src/agent/planning.ts:250` 외 2 |
| FLOW-05 | medium | 확인 | 절차 | both | 테스트가 TC와 연결되지 않은 채 처음 돌면 테스트 파일이 동결돼 test 단계에서 고칠 길이 없음 | `src/agent/hook.ts:602-614`<br>`src/agent/review.ts:332-336` 외 4 |
| FLOW-07 | medium | 확인 | 절차 | both | start가 작업 트리의 기존 미커밋·미추적 변경을 검사하지 않아, 계획 승인 이후에야 '계획 밖 변경'으로 막힘 | `src/agent/commands.ts:316-343`<br>`src/agent/git.ts:27-40` 외 4 |
| FLOW-08 | medium | 확인 | 절차 | both | 다중 대상(target) 지시서를 대상별로 이어서 진행하면 같은 브랜치·작업 폴더를 공유해 두 번째 대상이 막힐 가능성 | `src/agent/commands.ts:318`<br>`src/agent/commands.ts:333-336` 외 3 |
| FLOW-11 | medium | 확인 | 절차 | codex | CLI 출력의 다음 단계 안내가 Claude 문법(/ca-*, AskUserQuestion, ca-tester, 'Claude 세션')으로 고정돼 Codex 안내와 어긋남 | `src/agent/commands.ts:111-127`<br>`src/agent/commands.ts:190` 외 5 |
| FLOW-14 | medium | 확인 | 절차 | both | 질문 해시가 계획 작업 전체로 퍼져 재실행 비용이 커짐 (범위 없는 질문은 모든 작업을 무효화) | `src/agent/planningState.ts:147-152`<br>`src/agent/planning.ts:68` 외 2 |
| FLOW-15 | medium | 확인 | 절차 | both | 흐름도 단일 정본과 템플릿·CLI·hook 정합 자동 검사가 없음 (변경마다 분석 비용과 drift 발생) | `doc/design.md:209-247`<br>`doc/usage.md:108-182` 외 6 |
| HAR-M1 | medium | 검증자 발견 | 하네스 | codex | Codex를 메인 호스트로 쓰는 전체 개발 흐름(설계→구현→검증→반영)을 실제 모델로 돌려 보는 평가 하네스와 비용 집계가 없다 | `scripts/evaluate-full-flow.cjs:4`<br>`scripts/evaluate-full-flow.cjs:105` 외 4 |
| HX-2 | medium (원 high) | 부분 | 하네스 | both | code-agent 저장소에 에이전트가 먼저 읽을 지도가 없다(루트 AGENTS.md/CLAUDE.md, 한 장짜리 흐름도 모두 없음) | `README.md:17-19`<br>`doc/design.md:7` 외 3 |
| HX-3 | medium | 확인 | 하네스 | none | 문서와 코드가 이미 어긋났지만 이를 잡는 기계적 검증이나 doc-gardening이 없다 | `doc/design.md:3`<br>`doc/usage.md:12` 외 5 |
| HX-4 | medium | 확인 | 하네스 | both | 대상 프로젝트의 흐름·구조 지식이 작업이 끝나도 쌓이지 않는다(KNOWLEDGE에 흐름 종류가 없고, architecture 갱신·낡은 항목 탐지가 약하다) | `src/agent/schemas.ts:10-14`<br>`doc/design.md:76` 외 4 |
| HX-5 | medium | 확인 | 하네스 | both | 작업 크기와 상관없이 항상 같은 무거운 경로를 탄다(작은 변경용 경량 경로가 없다) | `doc/usage.md:133`<br>`doc/reviews/2026-10-06-token-efficiency.md:42` 외 2 |
| HX-6 | medium | 확인 | 하네스 | codex | Codex 호스트에는 세션 시작·압축 뒤 진행 상태를 주입하는 SessionStart hook이 없다 | `src/agent/init.ts:187-189`<br>`src/agent/codexHook.ts:85-96` 외 2 |
| HX-7 | medium | 확인 | 하네스 | both | 버전이 1.0.0에 고정돼 있어 설치본의 절차 개정 이력을 추적할 수 없다. update는 상류 템플릿 변경을 '손으로 고친 파일'로 잘못 알린다 | `package.json:3`<br>`src/agent/update.ts:83-85` 외 3 |
| HP-2 | medium | 확인 | 호스트 | codex | 상태 파일을 읽지 못하면 Codex는 원인 파일을 읽을 수도 없고, 거부 사유는 Claude 도구를 안내함 | `src/agent/hook.ts:230-244`<br>`src/agent/codexHook.ts:82` |
| HP-5 | medium | 확인 | 호스트 | codex | CLI 출력이 호스트와 무관하게 Claude 문법(/ca-*, AskUserQuestion)을 씀 | `src/agent/commands.ts:126`<br>`src/agent/commands.ts:165` 외 5 |
| HP-6 | medium | 확인 | 호스트 | codex | Codex에는 SessionStart(진행 상태 앵커) 훅을 등록하지 않음 — 지원 증거가 있는데 문서는 '미확인'이라고 함 | `src/agent/init.ts:187`<br>`doc/codex.md:80` 외 2 |
| HP-7 | medium | 확인 | 호스트 | codex | Codex 역할 TOML에 읽기 전용 제한이 없고 설명은 변환되지 않음 | `src/agent/hosts.ts:94-101`<br>`template/claude/agents/ca-reviewer.md:4` 외 1 |
| HP-8 | medium | 부분 | 호스트 | both | Codex 세션에서 실행한 교차 검증(--by claude)이 Codex 샌드박스에 막혀 '실행 불가'로 조용히 건너뛰어질 위험 | `src/agent/crossCheck.ts:81-83`<br>`template/claude/skills/ca-review/SKILL.md:28` 외 1 |
| HP-9 | medium | 확인 | 호스트 | both | '실행 불가' 분류가 지나치게 넓어 설정 오류도 게이트 통과로 이어짐 | `src/agent/crossCheck.ts:82-90`<br>`src/agent/review.ts:413-416` 외 2 |
| HP-21 | medium | 확인 | 호스트 | codex | Codex 실제 호스트 검증이 분석·영향도까지만 이뤄짐 | `doc/reviews/2026-10-06-token-efficiency.md:48-50`<br>`src/test/codex.test.ts:221-226` 외 1 |
| LRN-2 | medium | 확인 | 자기학습 | both | 관찰된 계획 흐름의 analysis 배정에 business-rules.md 가 없다 — '이미 답한 업무 규칙을 다시 묻지 않는다' 재사용 경로가 끊김 | `src/agent/planning.ts:84`<br>`src/agent/planning.ts:186` 외 5 |
| LRN-5 | medium | 확인 | 자기학습 | both | 직접 CLI `code-agent update`(소스 업데이트)가 확인 없이 fetch·pull·npm ci·build 를 실행하고, 작업 밖에서는 모델 Bash 도 hook 이 허용한다 | `src/agent/cli.ts:216-218`<br>`src/agent/sourceUpdate.ts:210-246` 외 2 |
| OPT-1 | medium (원 high) | 부분 | 최적화 | both | 메인 왕복 수가 비용의 최대 요인인데, 단계 경계에 줄일 수 있는 왕복이 남아 있다 | `doc/reviews/evidence/token-efficiency-2026-10-06.json (claudeRuns.optimizedV3.main)`<br>`src/agent/commands.ts:525-528` 외 8 |
| OPT-2 | medium | 확인 | 최적화 | both | consent prepare·status 출력이 summary를 4번 싣고 두 호스트 형식을 모두 내보낸다 | `src/agent/consent.ts:324`<br>`src/agent/consent.ts:327-335` 외 2 |
| OPT-5 | medium | 확인 | 최적화 | both | 게이트의 결정적 문서 검사가 next에서만 돌아, 형식 오류가 서브에이전트 전체 재배정으로 이어진다 | `src/agent/commands.ts:524`<br>`src/agent/commands.ts:538-546` 외 3 |
| OPT-6 | medium | 확인 | 최적화 | both | 측정이 토큰 합계만 남겨 왕복·재시도 병목을 증거로 볼 수 없다 | `src/agent/usage.ts:37-50`<br>`src/agent/usage.ts:320` 외 2 |
| OPT-8 | medium | 확인 | 최적화 | codex | CLI 출력이 Claude 전용 표기(/ca-*, AskUserQuestion, Bash:)로 Codex에도 그대로 나간다 | `src/agent/commands.ts:111-128`<br>`src/agent/commands.ts:362-425` 외 5 |
| OPT-9 | medium | 부분 | 최적화 | codex | 정규식 기반 Codex 템플릿 변환이 깨지기 쉽고, 이미 잔재와 어색한 문장이 있다 | `src/agent/hosts.ts:64-82`<br>`src/test/codex.test.ts:51-54` 외 3 |
| OPT-12 | medium | 확인 | 최적화 | claude | 역할별 모델이 전부 opus로 고정되고 추론 강도가 지정되지 않는다(Codex와 비대칭) | `src/agent/models.ts:24-28`<br>`template/claude/agents/ca-implementer.md:5` 외 4 |
| OPT-17 | medium | 부분 | 최적화 | both | 코드에서 검증되는 전체 프로세스 흐름도 문서가 없다 | `doc/design.md (879줄, 140,055바이트)`<br>`doc/usage.md (1,207줄, 131,627바이트)` 외 5 |
| PVR-3 | medium | 확인 | 검증·리뷰 | both | 고쳐 쓰기 한도가 진입점마다 다르다 — verify 는 통과한 회차도 한도로 세어 막고, check 직접 호출은 통과 중이면 무제한(리뷰→수정 루프 상한 없음) | `src/agent/verificationFlow.ts:315-322`<br>`src/agent/evidence.ts:420-427` 외 5 |
| PVR-4 | medium | 확인 | 검증·리뷰 | both | 환경 오류 분류가 전체 로그의 부분 문자열 일치라 실제 TC 실패가 '환경 오류' 로 바뀌고, 같은 코드 재실행은 회차를 쓰지 않아 무제한 반복된다 | `src/agent/validate.ts:173-178`<br>`src/agent/evidence.ts:404-408` 외 3 |
| PVR-5 | medium | 부분 | 검증·리뷰 | both | 계획 담당 결과가 배정과 맞지 않으면 attempt 가 영구히 running 으로 남고 planning advance 는 계속 wait 만 반환한다 | `src/agent/planningHook.ts:136-137`<br>`src/agent/reviewHook.ts:31-33` 외 4 |
| PVR-6 | medium | 확인 | 검증·리뷰 | both | 리뷰 지적에 대한 사람 판단(기각·범위 밖 확인)을 기록할 코드 경로가 없고, 안내된 '그 줄을 지우고 새 회차' 탈출구는 동작하지 않는다 | `src/agent/review.ts:447-453`<br>`src/agent/review.ts:253-258` 외 4 |
| PVR-7 | medium | 확인 | 검증·리뷰 | both | deliver 의 `git add -f` 가 .gitignore 로 뺀 handoff 사본과 실패 배정의 staging 초안까지 반영 커밋에 넣는다 | `src/agent/deliver.ts:314-329`<br>`src/agent/deliver.ts:348` 외 3 |
| PVR-8 | medium | 확인 | 검증·리뷰 | both | 통합 검증·격리 재현이 중단되면 임시 worktree 가 등록·디렉터리째 남고, ca-integrate 스킬에는 장시간 실행 안내가 없다 | `src/agent/validate.ts:555-582`<br>`src/agent/validate.ts:588-605` 외 2 |
| PVR-9 | medium | 확인 | 검증·리뷰 | both | 첫 test 실행이 결과 미확인(TC id 미출력)이어도 테스트 파일을 얼려, TC 이름 수정조차 재계획 없이는 불가능한 교착이 생긴다 | `src/agent/hook.ts:587-615`<br>`src/agent/review.ts:332-336` 외 2 |
| VER-M1 | medium | 검증자 발견 | 검증·리뷰 | both | review cross 가 실행 시작 때 읽은 review.json 스냅샷을 몇 분 뒤 그대로 저장해, 그 사이 기록된 독립 리뷰어 결과와 동결 해제 기록(used)을 지운다 | `src/agent/crossCheck.ts:120-121`<br>`src/agent/crossCheck.ts:140` 외 5 |
| VER-M2 | medium | 검증자 발견 | 검증·리뷰 | codex | Codex 메인에서 `review/planning cross --by claude` 가 샌드박스(자식 프로세스·네트워크·홈 쓰기 제한) 때문에 실패하면 '중지' 로 분류돼, Codex 쪽 교차 검증이 조용히 꺼질 수 있다 | `src/agent/crossCheck.ts:62-63`<br>`src/agent/crossCheck.ts:82-83` 외 2 |
| CON-7 | low | 확인 | 동의·hook | both | 계획 담당 결과의 질문 본문에 전각 공백 + '[Answer]:' 를 넣으면 스키마 검사를 지나 질문이 '답변됨'으로 파싱된다 | `src/agent/planningState.ts:36`<br>`src/agent/questions.ts:39` 외 1 |
| CON-9 | low (원 medium) | 부분 | 동의·hook | both | Windows 경로 별칭(끝 점·공백, UNC 관리 공유)을 hook 이 같은 파일로 보지 못한다 | `src/agent/hook.ts:289-293`<br>`src/agent/hook.ts:324-327` 외 4 |
| CON-10 | low | 확인 | 동의·hook | codex | Codex 에 SessionStart hook 이 없다 — 지원 증거가 있는데도 '확인하지 않았다'로 남아 있다 | `src/agent/init.ts:187`<br>`doc/codex.md:80` 외 3 |
| CON-11 | low | 부분 | 동의·hook | codex | Codex Stop·SubagentStop 의 차단 해제 규칙이 Claude 와 다르다 — 질문 대기마다 강제 연장 턴, stop_hook_active 부재 시 반복 차단 가능 | `src/agent/codexHook.ts:91-93`<br>`src/agent/stopHook.ts:22-54` 외 5 |
| CON-12 | low | 확인 | 동의·hook | codex | Codex 로 변환된 스킬에 Claude 전용 동의 지시('toolInput 전체를 그대로 호출')가 남고, Codex 동작 목록에 repro-log 가 빠졌다 | `src/agent/hosts.ts:64-82`<br>`template/claude/skills/ca-integrate/SKILL.md:36` 외 3 |
| CON-13 | low | 부분 | 동의·hook | both | 판정 대상 도구가 이름 목록이라 새·다른 이름의 쓰기 도구와 hook 프로세스 실패는 통과(fail-open)된다 | `src/agent/init.ts:19`<br>`src/agent/codexHook.ts:55` 외 3 |
| CON-14 | low | 확인 | 동의·hook | both | 제어 경로(.claude·doc 등) 아래 심볼릭 링크·접합점 하나가 모든 동의 준비를 막는다 | `src/agent/consent.ts:87-100`<br>`src/agent/consent.ts:171-183` 외 1 |
| CON-15 | low | 부분 | 동의·hook | both | 동의 1건에 저장소 전체 내용 해시가 약 7회 반복된다 — 대형 저장소에서 hook 타임아웃 위험 | `src/agent/consent.ts:163-220`<br>`src/agent/consent.ts:342-344` 외 5 |
| CON-16 | low | 확인 | 동의·hook | both | 관찰된 동의 응답은 커밋되지 않고, 원장 사슬은 끝줄 삭제를 드러내지 못한다(주석보다 약함) | `src/agent/init.ts:191-192`<br>`src/core/approval.ts:109-115` 외 2 |
| CON-17 | low | 확인 | 동의·hook | both | 세션 밖 Bash 는 호스트 설정(.claude·.codex·.agents)을 보호하지 않는다 — Write 판정과 비대칭 | `src/agent/hook.ts:255-260`<br>`src/agent/hook.ts:281-283` 외 1 |
| CONS-M1 | low | 검증자 발견 | 동의·hook | both | KNOWLEDGE 문서 경로를 임의 소스 파일로 지정하면 그 파일의 변경이 계획 밖 변경 탐지(Stop·check·next)에서 빠진다 | `src/agent/evidence.ts:298-311`<br>`src/agent/knowledge.ts:174-176` 외 3 |
| GAP-4 | low | 비평가 확인 | 비평 | both | 품질 평가 스크립트가 출하 구성과 다른 모델로 Claude만 측정하고, 날짜 고정 파일명이라 과거 증거를 덮어쓴다 | `scripts/evaluate-review.cjs:7-9`<br>`scripts/evaluate-review.cjs:18` 외 5 |
| GAP-5 | low | 비평가 확인 | 비평 | both | 테스트·증거가 Windows 한 대에서만 돌고 CI가 없다. POSIX 전용 경로는 기록된 어떤 회귀에서도 실행된 적이 없다 | `package.json:16`<br>`doc/reviews/README.md:23` 외 7 |
| DOC-5 | low (원 medium) | 부분 | 문서 | both | 스테이지 번호 체계가 세 가지로 충돌한다(CLI --help 8/9/11/12/13, design 7~11, usage 1~13). usage.md는 'CLI가 7~11을 찍는다'고 잘못 쓴다 | `src/agent/cli.ts:70`<br>`src/agent/cli.ts:76` 외 8 |
| DOC-7 | low | 확인 | 문서 | both | 명령 참조표가 CLI와 어긋난다. --host와 verify/read/planning/cross 명령이 표에서 빠지고, --help에는 실제 플래그가 일부 없다 | `doc/usage.md:567-569`<br>`doc/usage.md:689-720` 외 5 |
| DOC-8 | low | 확인 | 문서 | codex | CLI --help가 Claude 전용으로 서술돼 Codex 메인에게 잘못된 확인 경로를 안내한다 | `src/agent/cli.ts:49`<br>`src/agent/cli.ts:55` 외 3 |
| DOC-9 | low | 확인 | 문서 | claude | install.md의 수치·예시 출력이 낡았다(자원 29개→실제 41개, gitignore에 consents/ 누락, update 예시에 hook 4종만 표시) | `doc/install.md:37`<br>`doc/install.md:70` 외 4 |
| DOC-12 | low | 확인 | 문서 | both | 현행 동작 문서에 변경 이력이 섞이고, 새 절이 목차 밖에 덧붙여지고 있다 | `README.md:17-19`<br>`README.md:21-31` 외 8 |
| DOC-13 | low (원 medium) | 부분 | 문서 | both | 흐름 생성의 원천이 될 상수가 export되지 않았거나 상수가 아닌 인라인 호출이다 | `src/agent/consent.ts:28-29`<br>`src/agent/commands.ts:94-121` 외 5 |
| DOC-14 | low | 확인 | 문서 | codex | Codex init 메시지에 스킬·에이전트 수가 하드코딩돼 있고 커밋 안내가 없다 | `src/agent/init.ts:196`<br>`src/agent/init.ts:218` 외 1 |
| DOC-M1 | low | 검증자 발견 | 문서 | both | usage.md 안의 '로그 근거' 링크가 존재하지 않는 제목 앵커를 가리킨다(c4f3fbf에서 추가) | `doc/usage.md:826`<br>`doc/usage.md:508` |
| DOC-M2 | low | 검증자 발견 | 문서 | codex | Codex 설치물의 ca-answer/reference.md는 설치되지만 어떤 Codex 지침도 참조하지 않는 고아 자원이다 | `src/agent/hosts.ts:89`<br>`template/codex/ca-answer.md:16` 외 1 |
| DOC-M3 | low | 검증자 발견 | 문서 | codex | README의 핵심 사용 흐름 절이 Claude 전용으로 쓰여 Codex 사용자 경로와 어긋난다 | `README.md:122`<br>`README.md:134` 외 3 |
| FLOW-06 | low (원 medium) | 부분 | 절차 | both | 고쳐 쓰기 한도는 '실패한 채 넘긴' 회차만 막아서, 통과 상태의 리뷰 수정 루프에는 상한이 없음 (문서와 불일치) | `src/agent/evidence.ts:420-427`<br>`src/agent/validate.ts:494-503` 외 4 |
| FLOW-09 | low (원 medium) | 부분 | 절차 | both | 준비 단계 '다음:' 안내가 기준 커밋 유무를 보지 않고 docs 동의를 안내해, 스킬이 정한 setup 동의(한 번에 묶기)와 어긋남 | `src/agent/request.ts:603-612`<br>`src/agent/commands.ts:173-181` 외 3 |
| FLOW-10 | low | 확인 | 절차 | both | 스킬이 시키는 code-agent doctor를 작업·접수 중에 hook이 거부함 | `src/agent/hook.ts:89-114`<br>`src/agent/hook.ts:116-129` 외 2 |
| FLOW-12 | low | 확인 | 절차 | both | 관찰 흐름 작업에서 '다음:'이 메인에게 plan.json을 직접 쓰라고 안내하지만 hook이 거부함. check·test 안내도 스킬의 verify와 다름 | `src/agent/commands.ts:376-379`<br>`src/agent/hook.ts:474` 외 2 |
| FLOW-13 | low | 부분 | 절차 | both | ca-next 재개표에 처리 주체가 없는 상태가 있음 (작업·접수 없음, 접수 없이 열린 문서 세션, AI-DLC 차단 등) | `template/claude/skills/ca-next/SKILL.md:14-31`<br>`src/agent/commands.ts:444-449` 외 1 |
| FLOW-16 | low | 확인 | 절차 | both | '한 번에 하나' 제약은 저장소 단위 커서로만 강제되고, 호스트·세션 간 동시 진행 금지는 문서에만 있음 | `src/agent/commands.ts:297-303`<br>`src/agent/request.ts:453-466` 외 2 |
| FLOW-17 | low | 확인 | 절차 | none | approve/reject가 여분 인자를 무시해 'code-agent approve request &lt;ID>'가 계획 승인으로 동작 | `src/agent/cli.ts:274-284`<br>`src/agent/cli.ts:336-348` |
| FLOW-18 | low | 부분 | 절차 | both | 동의 동작 목록 문서가 ActionSchema와 다름 (repro-log·host·reasoning 누락) | `src/agent/consent.ts:28-36`<br>`template/claude/skills/ca-answer/reference.md:18` 외 1 |
| FLOW-M1 | low | 검증자 발견 | 절차 | both | 계획 기록 잠금(.planning.json.lock)에 비정상 종료 복구가 없어, 남은 잠금 하나로 모든 planning 명령이 막히고 모델은 풀 수 없음 | `src/agent/planning.ts:38-56`<br>`src/agent/consent.ts:125-147` 외 1 |
| HX-8 | low | 확인 | 하네스 | both | 작업 시작 전 기준선 상태 확인과 Task별 증분 빌드가 없다. 첫 빌드는 모든 Task가 끝난 뒤에 돈다 | `src/agent/commands.ts:559-596`<br>`template/claude/skills/ca-implement/SKILL.md:19-28` 외 2 |
| HX-9 | low | 부분 | 하네스 | claude | Claude 역할 모델이 업무 성격과 무관하게 전부 opus이고, 선택 근거가 역할별로 기록돼 있지 않다 | `template/claude/agents/ca-surveyor.md:5`<br>`template/claude/agents/ca-writer.md:5` 외 3 |
| HX-10 | low | 확인 | 하네스 | both | 과거 작업 기록을 검색하는 기능과 작업을 넘어 쌓이는 후속 과제 목록이 없다 | `template/claude/agents/ca-explorer.md:12-17`<br>`src/agent/planning.ts:226` 외 1 |
| HX-11 | low | 부분 | 하네스 | both | KNOWLEDGE에 용량 상한과 통합 절차가 없어 계속 커지고, 그만큼 서브에이전트 입력도 커진다 | `doc/design.md:117`<br>`src/agent/knowledge.ts:10-20` 외 2 |
| HX-12 | low | 확인 | 하네스 | codex | Codex 변환이 문장 그대로 일치할 때만 치환하는데, 이를 지키는 테스트가 없다 | `src/agent/hosts.ts:78-80`<br>`src/test/codex.test.ts:51-54` 외 2 |
| HX-13 | low | 부분 | 하네스 | both | 스킬 description에 언제 써야 하는지와 쓰지 말아야 하는 경계가 없고, 호출 조건 검증도 없다 | `template/claude/skills/ca-analyze/SKILL.md:3`<br>`template/claude/skills/ca-request/SKILL.md:3` 외 1 |
| HOST-M1 | low | 검증자 발견 | 호스트 | both | 교차 검증이 '다른 호스트'인지 확인하지 않아 같은 호스트의 결과도 교차 검증으로 기록됨 | `src/agent/crossCheck.ts:30-33`<br>`src/agent/crossCheck.ts:116-118` 외 3 |
| HOST-M2 | low | 검증자 발견 | 호스트 | codex | Codex 계획 담당은 작업 폴더 전체를 쓸 수 있음 (Claude 담당은 staging 만 씀) | `src/agent/hook.ts:428-436`<br>`src/agent/hook.ts:473-476` 외 2 |
| HP-3 | low (원 medium) | 부분 | 호스트 | codex | Codex ca-answer 보조 문서의 과잉 치환과 동작 목록 표류(drift) | `src/agent/hosts.ts:66`<br>`template/claude/skills/ca-answer/reference.md:24` 외 3 |
| HP-4 | low (원 medium) | 부분 | 호스트 | codex | codexText 고정 문장 치환이 조용히 무치환으로 바뀌는 것을 막는 테스트가 없음 | `src/agent/hosts.ts:78-80`<br>`src/agent/hosts.ts:100` 외 2 |
| HP-10 | low (원 medium) | 부분 | 호스트 | both | 교차 실행 시간 제한(기본 20분)이 Claude Bash 최대 10분과 어긋남 | `src/agent/crossCheck.ts:54-57`<br>`src/agent/crossCheck.ts:81` 외 2 |
| HP-11 | low (원 medium) | 부분 | 호스트 | both | 두 호스트·두 세션의 동시 사용을 막는 장치가 없고, 리뷰 기록은 잠금 없이 덮어씀 | `doc/codex.md:55`<br>`doc/design.md:50` 외 3 |
| HP-12 | low | 확인 | 호스트 | both | 교차 실행 자식이 프로젝트 훅(Stop 등)을 그대로 실행함 | `src/agent/crossCheck.ts:70-71`<br>`src/agent/layout.ts:43` 외 1 |
| HP-13 | low | 확인 | 호스트 | both | 교차 리뷰 프롬프트(X id)와 리뷰어 역할 지침(F id)이 충돌하고, 형식이 틀리면 전체를 재실행함 | `src/agent/crossCheck.ts:133-134`<br>`src/agent/crossCheck.ts:153-158` 외 1 |
| HP-14 | low | 확인 | 호스트 | both | hostCommand의 Windows 경로 해석이 npm 기본 prefix(%APPDATA%\npm)에만 의존 | `src/agent/hosts.ts:29-45`<br>`src/agent/doctor.ts:74-93` |
| HP-15 | low | 부분 | 호스트 | codex | Codex 하위 에이전트 완료 훅의 실패 처리가 Claude 경로와 다름 | `src/agent/codexHook.ts:110-121`<br>`src/agent/reviewHook.ts:190-192` |
| HP-17 | low | 확인 | 호스트 | codex | code-agent read의 JSON 출력이 Codex 읽기 토큰을 2배 이상으로 늘림 | `src/agent/read.ts:20-22` |
| HP-18 | low | 확인 | 호스트 | codex | Codex 단독 설치의 doctor·update에는 버전 차이·잔존 ca-* 검사가 없음 | `src/agent/doctor.ts:169-243`<br>`src/agent/assets.ts:136-169` 외 2 |
| HP-19 | low | 부분 | 호스트 | codex | 상시 지침 블록(CLAUDE.block과 CODEX.block)의 내용 표류 | `template/CLAUDE.block.md:5-10`<br>`template/CODEX.block.md:1-11` |
| HP-20 | low | 확인 | 호스트 | both | 교차 검증이 '설치된 호스트 수'에 묶여 끌 수 없고, 비용은 기록되지 않음 | `src/agent/review.ts:167-169`<br>`src/agent/planningState.ts:183` 외 3 |
| LEARN-M1 | low | 검증자 발견 | 자기학습 | both | KNOWLEDGE 문서가 256KB를 넘으면 그 뒤 항목이 context.docs 검색에서 조용히 사라진다 — 새 키는 끝에 붙으므로 가장 최근 지식부터 안 보인다 | `src/agent/plugins/defaults.ts:21`<br>`src/agent/plugins/defaults.ts:74-87` 외 3 |
| LRN-3 | low (원 medium) | 부분 | 자기학습 | both | KNOWLEDGE 같은 키 upsert 가 항목 전체를 교체 — 부분(차이만) 제안을 고르면 기존 필드가 지워진다 | `src/agent/knowledge.ts:119-127`<br>`src/agent/deliver.ts:248-259` 외 4 |
| LRN-4 | low (원 medium) | 부분 | 자기학습 | both | update 가 프로젝트 국소 스킬 개선을 덮어쓰고, 배정은 설치본이 아니라 번들 criteria 를 읽어 국소 개선이 애초에 반영되지 않는다 | `src/agent/update.ts:52-60`<br>`src/agent/update.ts:83-85` 외 4 |
| LRN-6 | low (원 medium) | 부분 | 자기학습 | both | '업무 규칙은 질문의 답으로 쌓인다'는 문서 주장과 달리 답→제안 경로·nudge 가 코드에 없다 | `doc/usage.md:278`<br>`template/claude/skills/ca-docs/SKILL.md:23` 외 5 |
| LRN-8 | low (원 medium) | 부분 | 자기학습 | both | [설계] 교훈 수집 — 언제: 코드가 실패·재시도·교정 신호에서 후보를 결정론적으로 만든다 | `src/agent/verificationFlow.ts:157-177`<br>`src/agent/evidence.ts:40-56` 외 5 |
| LRN-9 | low (원 medium) | 부분 | 자기학습 | both | [설계] 교훈·지식 게이트 — 같은 동의, 증거 실존 검사, 상한·린트·중복 키 (현재 KNOWLEDGE 도 상한·린트 없음) | `src/agent/knowledge.ts:55-101`<br>`src/agent/consent.ts:270-281` 외 2 |
| LRN-12 | low (원 medium) | 부분 | 자기학습 | both | [설계] 과거 작업 검색 — LLM 없는 결정론적 recall (헤르메스 FTS5 대응) | `src/agent/planningState.ts:106-110`<br>`src/agent/survey.ts:126-128` 외 3 |
| LRN-13 | low (원 medium) | 부분 | 자기학습 | both | [설계] 효과 측정 — 커밋된 작업 기록에서 재시도·재발률을 집계 (Codex 포함) | `src/agent/usage.ts:319-338`<br>`src/agent/review.ts:97-106` 외 2 |
| LRN-14 | low | 확인 | 자기학습 | both | [설계] 사용자 교정·선호 기억 — '수정 요청' 사유가 어디에도 구조적으로 남지 않는다 | `src/agent/consent.ts:57-61`<br>`src/agent/consent.ts:404-411` 외 3 |
| LRN-15 | low | 부분 | 자기학습 | both | KNOWLEDGE 'R 번호 근거'가 작업 식별이 아니고 출처(작업 ID)가 항목에 기록되지 않는다 | `src/agent/knowledge.ts:67-74`<br>`src/agent/knowledgeCommands.ts:29-69` 외 1 |
| LRN-16 | low | 확인 | 자기학습 | both | 근거 부족으로 걸러진 KNOWLEDGE 제안 사유가 stderr 로만 나가 동의 요약·반영 결과에 없다 | `src/agent/deliver.ts:243-246`<br>`src/agent/consent.ts:276-280` 외 1 |
| LRN-17 | low | 확인 | 자기학습 | both | knowledge prune 결과는 커밋되지 않아, 다음 deliver 가 같은 파일 항목을 고르면 무관한 작업 커밋에 삭제가 섞인다 | `src/agent/knowledgeCommands.ts:240-253`<br>`src/agent/deliver.ts:262-275` 외 2 |
| LRN-18 | low | 확인 | 자기학습 | both | 같은 제안 파일 안의 중복 키를 거르지 않아 두 번째가 첫 선택을 조용히 덮는다 | `src/agent/knowledge.ts:55-101`<br>`src/agent/deliver.ts:248-259` 외 1 |
| OPT-3 | low (원 medium) | 부분 | 최적화 | claude | ca-answer(7,128자)를 질문·동의 '직전마다' 다시 읽게 하는데, 평가는 이 비용을 재지 않았다 | `template/claude/skills/ca-analyze/SKILL.md:6 (17개 스킬 공통 문단)`<br>`template/CLAUDE.block.md:6` 외 2 |
| OPT-4 | low (원 medium) | 확인 | 최적화 | both | 측정 뒤 지침이 다시 늘었지만 크기 예산을 지키는 장치가 없다 | `doc/reviews/2026-10-06-token-efficiency.md (flowTotal 38,882)`<br>`template/claude/skills/ca-request/SKILL.md` 외 4 |
| OPT-7 | low (원 medium) | 부분 | 최적화 | both | 교차 검증이 critic 뒤에 순차로 돌고, 두 호스트 실측은 비용 2배·미완주였다 | `src/agent/crossCheck.ts:56-59`<br>`src/agent/crossCheck.ts:177-185` 외 3 |
| OPT-10 | low (원 medium) | 부분 | 최적화 | codex | 손으로 따로 관리하는 Codex ca-answer가 동작 목록에서 repro-log를 빠뜨렸다 | `template/codex/ca-answer.md:16`<br>`src/agent/consent.ts:29` 외 3 |
| OPT-11 | low (원 medium) | 확인 | 최적화 | none | p5.test.ts가 전체 테스트 실행 시간의 임계 경로이고, 단계 번호식 파일 이름이 탐색을 어렵게 한다 | `src/test/p5.test.ts:304-1821`<br>`src/test/p6.test.ts` 외 3 |
| OPT-13 | low | 확인 | 최적화 | claude | 단가표에 claude-sonnet-5-5가 없어 모델 정책 최적화를 측정할 수 없다 | `src/agent/prices.ts:23-29`<br>`doc/reviews/2026-10-06-token-efficiency.md (마지막 문단)` 외 1 |
| OPT-14 | low | 확인 | 최적화 | both | 4개 계획 단계 스킬에 같은 계획 작업 루프 문단이 반복되고, CLI 출력도 스킬 규칙을 다시 싣는다 | `template/claude/skills/ca-analyze/SKILL.md:22-34`<br>`template/claude/skills/ca-impact/SKILL.md:18-30` 외 3 |
| OPT-15 | low | 확인 | 최적화 | both | hook 1회가 Node 기동과 모듈 128개 로드로 약 100ms를 쓴다 | `src/agent/init.ts:19`<br>`src/agent/init.ts:187-189` 외 3 |
| OPT-16 | low | 확인 | 최적화 | both | 거대 함수와 코드 안 프롬프트 문장이 이중 원천을 만든다 | `src/agent/commands.ts:840-1148`<br>`src/agent/commands.ts:1149-1301` 외 2 |
| OPT-M1 | low | 검증자 발견 | 최적화 | codex | Codex 설치의 ca-answer/reference.md는 어디서도 참조하지 않는 고아 파일이고, Codex 스킬이 가리키는 '페이지 규칙'을 찾아갈 경로가 없다 | `src/agent/hosts.ts:88-90`<br>`template/codex/ca-answer.md:1-28` 외 4 |
| PVR-10 | low (원 medium) | 부분 | 검증·리뷰 | both | 교차 실행의 비용·시간 상한이 없다 — 예산·턴 제한 미사용, 기본 20분 timeout 이 호스트 도구 최대 10분보다 길고, 재실행 횟수 무제한 | `src/agent/crossCheck.ts:54-57`<br>`src/agent/crossCheck.ts:68-81` 외 4 |
| PVR-11 | low | 확인 | 검증·리뷰 | both | `--by` 가 현재 호스트와 같아도 받아들여 '같은 호스트의 재검토' 가 교차 검증으로 기록된다 | `src/agent/crossCheck.ts:30-33`<br>`src/agent/crossCheck.ts:116-118` 외 1 |
| PVR-12 | low | 부분 | 검증·리뷰 | both | 교차 실행이 프로젝트 hook 을 그대로 로드한다 — Stop·SessionStart hook 이 비대화형 리뷰어의 마지막 응답을 바꿀 수 있다 | `src/agent/crossCheck.ts:70-71`<br>`src/agent/crossCheck.ts:77-78` 외 3 |
| PVR-13 | low | 부분 | 검증·리뷰 | both | 계획 파일 부분 트리 해시가 파일을 UTF-8 로 읽어 바이너리 변경을 놓친다 | `src/agent/tree.ts:109-118` |
| PVR-14 | low | 확인 | 검증·리뷰 | both | TC 결과를 출력의 아무 줄에서나 읽는다 — 앱 로그의 'ok N - TC-x' 나 로그 속 XML 조각도 통과 결과가 된다. 보고서 탐색도 2만 항목에서 끊긴다 | `src/agent/testResults.ts:5-34`<br>`src/agent/testResults.ts:62-67` 외 2 |
| PVR-15 | low | 확인 | 검증·리뷰 | both | feature 의 테스트 동결은 PreToolUse hook 에만 있고, 증거 단계에는 '첫 test 이후 테스트 트리 불변' 대조가 없다 | `src/agent/hook.ts:587-615`<br>`src/agent/evidence.ts:452-519` 외 1 |
| PVR-16 | low | 부분 | 검증·리뷰 | both | 반영 재개·부분 실패 경계 — pre-commit hook 의 내용 변경 미검증, 커밋 실패 뒤 KNOWLEDGE 잔여, 교차 중지 사실이 PR 본문에 없음 | `src/agent/deliver.ts:335-340`<br>`src/agent/deliver.ts:352-362` 외 2 |
| PVR-17 | low | 확인 | 검증·리뷰 | both | 재시도 상한이 '같은 입력' 기준이라 입력만 바꾸면 계획 배정이 무한히 늘고, 미선언 환경 문제(시간 초과)의 --retry 는 수정 회차를 소모한다 | `src/agent/planning.ts:170-171`<br>`src/agent/planning.ts:94-114` 외 2 |
| PVR-18 | low (원 medium) | 부분 | 검증·리뷰 | both | 계획 상태 판정마다 전체 범위 파일을 반복 해시한다 — taskHash·taskCurrent 에 캐시가 없다 | `src/agent/planningState.ts:329-332`<br>`src/agent/planningState.ts:388-397` 외 3 |
| PVR-19 | low | 확인 | 검증·리뷰 | both | 구현 Task 의 dependsOn·파일 소유는 검증만 되고 실행은 커서 하나로 직렬이다 — 독립 Task 병렬화 여지 | `src/core/plan.ts:227-246`<br>`src/agent/hook.ts:509` 외 2 |
| VER-M3 | low | 검증자 발견 | 검증·리뷰 | codex | Codex 설치본 스킬에 Claude Bash 도구 전용 안내(timeout 600000ms·run_in_background)가 변환되지 않고 남는다 | `src/agent/hosts.ts:64-83`<br>`template/claude/skills/ca-check/SKILL.md:25` 외 2 |
| CON-18 | info | 확인 | 동의·hook | both | hook 우회 판정 회귀 말뭉치와 '모드×호스트×도구' 판정표가 없어 흐름 문서가 코드와 어긋나기 쉽다 | `doc/design.md:481-541`<br>`src/test/codex.test.ts:189-204` 외 1 |
| HP-16 | info (원 low) | 부분 | 호스트 | codex | 배정 계약(instructions·resultShape)이 호스트를 구분하지 않고 staging 쓰기를 지시함 | `src/agent/planning.ts:186-187`<br>`src/agent/planningHook.ts:31-34` 외 1 |
| HP-22 | info | 부분 | 호스트 | codex | Codex 변환 문구 품질 — Claude 도구 잔재와 조사 오류 | `src/agent/hosts.ts:71`<br>`template/claude/skills/ca-check/SKILL.md:25` 외 1 |
| LEARN-M2 | info | 검증자 발견 | 자기학습 | none | 검토 도중 실제로 공용 소스 저장소에서 fetch·npm ci·dist 재빌드가 일어났다 — 같은 시각 기준 테스트 결과의 신뢰성 점검 필요 | `src/agent/cli.ts:216-218`<br>`src/agent/sourceUpdate.ts:223-244` |
| LRN-7 | info (원 medium) | 부분 | 자기학습 | both | [설계] 교훈 저장소 — 무엇을·어디에 (프로젝트 소유 lessons 문서와 항목 형식) | `src/agent/commands.ts:1048-1051`<br>`src/agent/consent.ts:192` 외 2 |
| LRN-10 | info (원 medium) | 부분 | 자기학습 | both | [설계] 교훈 주입 — 두 호스트 공통 경로(배정 파일·context --file)에 색인만, 본문은 필요할 때 | `src/agent/handoff.ts:30-34`<br>`src/agent/handoff.ts:60-83` 외 4 |
| LRN-11 | info (원 medium) | 부분 | 자기학습 | both | [설계] update 와의 공존 — 설치본은 번들 그대로, 프로젝트 개선은 코드가 읽는 오버레이로 | `src/agent/hosts.ts:63-105`<br>`src/agent/update.ts:63-141` 외 2 |
| PVR-20 | info | 확인 | 검증·리뷰 | both | 검증·리뷰·교차·반영의 상태 기계가 코드에만 정확히 있고 문서는 흩어져 있으며 이미 어긋난 곳이 있다 — 코드에서 흐름도를 생성할 수 있는 구조 | `src/agent/verificationFlow.ts:310-356`<br>`src/agent/planning.ts:14` 외 7 |
| PVR-21 | info | 확인 | 검증·리뷰 | both | 자기 학습 루프가 없다 — KNOWLEDGE 는 도메인 사실·R 근거·사람 선택만 받고, 실패·지적·재시도에서 나온 절차 교훈은 다음 작업으로 환류되지 않는다 | `src/agent/knowledge.ts:55-75`<br>`src/agent/deliver.ts:236-275` 외 2 |

## 처리 현황

이 감사의 지적 160건이 뒤 묶음(C1~C7)과 전체 검토에서 어떻게 처리됐는지는 [감사 160건 처리 현황](2026-10-08-audit-disposition.md)에 있다(원자료 [audit-disposition-2026-10-08.json](evidence/audit-disposition-2026-10-08.json)).
