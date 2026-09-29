---
name: ca-feature
description: 요구사항(작업 지시서)으로 기능 개발을 시작한다 — 분석 → 영향도 → 설계 → 계획까지 진행하고 사람의 승인을 기다린다.
argument-hint: <지시서 경로> [--base <기준 브랜치>] [--target <대상>]
---

너는 **메인 에이전트**다. 순서를 진행하고 서브에이전트를 부르고 결과를 합친다. 코드는 쓰지 않는다.
소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서, `code-agent` 출력, 서브에이전트 결과로 일한다 (메인 컨텍스트가 작아야 긴 작업이 버틴다).
보고와 질문은 **지시서·questions.md 가 쓰인 언어**로 한다.
어느 단계든 `code-agent` 명령이 거부하면 **그 사유를 사용자에게 그대로 전하고 멈춘다.** 우회하지 않는다.

작업 문서는 번호가 곧 순서다. 문서마다 Bash: `code-agent docs skeleton <종류>` 로 뼈대를 받아 쓴다 —
`01-requirements` · `02-analysis` · `03-design` · `04-functional` · `07-test-spec`.
**`05-plan.md` 는 쓰지 않는다** — `plan submit` 이 `plan.json` 에서 렌더한다 (hook 이 모델의 쓰기를 거부한다).

**공통 KNOWLEDGE 를 먼저 본다.** `doc/knowledge/` 의 데이터 사전 · API 목록 · 업무 규칙·용어집에
이번 요구가 닿는 키가 이미 있으면 **다시 역공학하지 않고 인용한다** — 키와 그것에 기대는 사실 한 줄을 옮겨 적고 차이만 쓴다.
**작업 중에는 KNOWLEDGE 파일을 쓰지 않는다** (hook 이 작업 폴더 밖 쓰기를 막는다). 갱신은 반영(deliver)에서 사람이 고른다.

## 0. 시작

Bash: `code-agent start $ARGUMENTS`
- 기준 브랜치는 사용자가 말했으면 `--base` 로 넘긴다. 말이 없으면 넘기지 않는다 (프로젝트 기본값, 없으면 master).
- 이미 진행 중이면 `code-agent status` 의 스테이지에서 이어 간다.

## 1. 요구사항 분석 (analysis) → `01-requirements.md`

1. Bash: `code-agent context` — 지시서·공통 문서·작업 폴더 경로와 형식이 나온다.
2. Bash: `code-agent docs skeleton 01-requirements`
3. `ca-analyst` 서브에이전트를 부른다. context 출력과 뼈대를 그대로 넘긴다.
4. 결과를 뼈대의 형식대로 작업 폴더의 `01-requirements.md` 에 쓴다.
   - `## R1 · <요구 한 줄>` 블록마다 `근거: "<지시서 문장 그대로>"` 한 줄 **필수**. 번호는 중복 없이 이어 붙인다.
   - `## 가정` — 질문하지 않고 기본값으로 정한 기술 세부 + 근거. 없으면 `- 없음`. **섹션 자체는 반드시 있어야 한다.**
   - `## 범위 밖` — 눈에 띄었지만 이번에 하지 않는 것과 근거 (선택).
   형식이 틀리면 `code-agent next` 가 무엇이 틀렸는지 알려 준다.
5. 질문 후보가 있으면 `questions.md` 에 덧붙인다 (선택지와 `X. 기타:` 포함, `[Answer]:` 는 비워 둔다).
   질문이 있으면 사용자에게 보여 주고 **멈춘다** — "`/ca-answer` 로 답해 주세요".
6. 질문이 없으면 Bash: `code-agent next`

## 2. 영향도 분석 (impact) → `02-analysis.md`

1. Bash: `code-agent context` — 요구 항목과 **참조 도메인의 단계별 표준 파일**이 나온다.
2. 요구 항목을 **닿는 영역**(이번 도메인 · 공통 모듈 · 다른 도메인과의 연결)으로 묶어 영역마다 `ca-explorer` 하나를 **한 메시지에서 병렬로** 부른다 —
   요구 항목마다 하나씩 부르지 않는다 (같은 도메인만 닿는 작업이면 explorer 하나). 영역의 항목들 + context 출력 + 관련 문서 경로를 넘긴다.
   **데이터 사전·API 목록에 그 키가 이미 있으면 그 영역에는 explorer 를 붙이지 않는다** — 인용으로 끝낸다.
3. Bash: `code-agent docs skeleton 02-analysis` — 뼈대 + explorer 결과 + 답한 질문을 `ca-writer` 에게 넘겨 `02-analysis.md` 에 쓰게 한다.
   - `기존 시스템 분석` — 닿는 파일·모듈이 지금 하는 일, 근거는 `path:line`
   - `영향 범위` — 표: `R 번호 | 닿는 파일/모듈 | 부르는 곳 | 파급`. **01 의 모든 R 이 한 줄 이상.** 영향이 없으면 근거와 함께 `없음`
   - `Risk` — 깨뜨릴 수 있는 것 · 왜 · 완화. 없으면 근거와 함께 `없음`
4. 모호한 점과 writer 가 돌려준 `확인 필요` 를 나눈다 — 업무 규칙·범위는 `questions.md` 로(있으면 멈춘다),
   기본값을 댈 수 있는 기술 세부는 `01-requirements.md` 의 `## 가정` 에 근거와 함께 더한다.
5. Bash: `code-agent next` — 영향 표에 빠진 R 이 있으면 넘어가지 않는다.

## 3. 설계·정의 (design) → `03-design.md` · `04-functional.md`

1. Bash: `code-agent context`
2. Bash: `code-agent docs skeleton 03-design` · `code-agent docs skeleton 04-functional`
3. `ca-writer` 에게 뼈대 + `01`·`02` + 아키텍처·컨벤션 경로 + KNOWLEDGE 인용을 넘겨 둘을 쓰게 한다. 같은 스테이지에서 함께 쓴다.
   - **`03-design.md`** — `구성 요소` · `처리 흐름` · `API` · `데이터` · `설계 결정`.
     API·데이터는 조건부다: 접점이나 데이터를 안 건드리면 `해당 없음 — <근거>` 라고 쓴다. **근거 없는 `해당 없음` 은 미충족이다.**
     KNOWLEDGE 에 있는 것은 키와 기대는 사실 한 줄을 옮겨 적고 **차이만** 쓴다.
   - **`04-functional.md`** — `기능 정의` · `업무 규칙` · `예외` · `수락 기준`.
     수락 기준은 `AC-R<n>-<m>` 한 줄씩, **R 마다 최소 하나.** 오류 코드는 03 의 `API` 와 글자까지 같아야 한다.
     업무 규칙은 작업 안에서만 `BR-<n>` 이고 근거(사용자 답 Qn · `path:line` · business-rules.md 의 키)가 없으면 지어낸 것이다.
4. 빈칸(`확인 필요`)은 업무 규칙·범위·권한이면 `questions.md` 로(있으면 멈춘다), 기본값을 댈 수 있는 기술 세부면 `01-requirements.md` 의 `## 가정` 으로 돌리고 문서에도 반영한다.
5. Bash: `code-agent next` — AC 가 없는 R 이 있거나 필수 섹션이 비면 넘어가지 않는다.

## 4. 구현 계획 (plan) → `plan.json` · `07-test-spec.md`

1. Bash: `code-agent context` — 계획 형식과 단계 key·위치가 나온다.
2. `01`~`04` · explorer 결과로 계획 초안을 작업 폴더의 `plan.json` 에 쓴다.
   참조 도메인의 파일 구조를 따르고, 없는 파일을 발명하지 않는다.
   - `files[]` — 파일마다 `requirements` 에 담당 R 번호. 어느 파일에도 닿지 않는 항목이 있으면 제출이 거부된다.
   - `sequence[]` — 어떤 단계·파일을 어떤 차례로, 왜 그 차례인지 한 줄. **02 의 Risk 가 큰 것부터.**
   - `approach` — 구현 방법 한 문단: 03 의 설계를 어떤 방식으로 옮기는가(기존 것을 확장 / 새로 만들고 갈아끼움).
3. Bash: `code-agent docs skeleton 07-test-spec` — `07-test-spec.md` 를 **구현 전에** 쓴다. 구현을 보고 쓰면 구현을 베낀 테스트가 된다.
   - `테스트 케이스` 표: `TC-<n>` | 수준(Unit/Integration/E2E) | 대상 AC | 케이스 | 기대 결과
   - **04 의 모든 AC 가 최소 한 TC 에 걸린다.** TC id 는 중복 없이. 수준은 테스트 전략 문서를 따르고, 올리거나 내리면 `안 하는 것` 에 근거를 단다.
   - AC 하나당 정상 1 + 04 의 `예외` 에서 온 실패 경로 n 으로 기계적으로 출발한다.
4. `ca-critic` 에게 초안, `01`~`04`, `07-test-spec.md`, 아키텍처·컨벤션·테스트 전략 경로, context 의 참조 표준 파일을 넘겨 반박 검토를 받는다.
   타당한 지적은 반영하고, 사람이 정할 것은 `questions.md` 로.
5. Bash: `code-agent plan submit <작업 폴더>/plan.json` — 거부되면 사유대로 고쳐 다시 제출한다.
   통과하면 코드가 `05-plan.md` 를 렌더한다. **그 파일은 손대지 않는다.**
6. 제출되면 계획 요약을 보여 주고 **멈춘다**:
   "별도 터미널에서 `code-agent approve` 로 승인한 뒤 `/ca-next` 로 구현을 시작하세요."

승인은 **한 묶음**이다 — 지시서 본문 · `01` · `02` · `03` · `04` · `07` 과 계획. 승인 뒤 이 중 하나라도 고치면 승인이 무효가 되고(`stale-docs`) 코드 쓰기가 멈춘다.
