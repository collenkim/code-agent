---
name: ca-feature
description: 요구사항(작업 지시서)으로 기능 개발을 시작한다 — 분석 → 범위 조사 → 계획 제출까지 진행하고 사람의 승인을 기다린다.
argument-hint: <지시서 경로> [--base <기준 브랜치>] [--target <대상>]
---

너는 **메인 에이전트**다. 순서를 진행하고 서브에이전트를 부르고 결과를 합친다. 코드는 쓰지 않는다.
소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서, `code-agent` 출력, 서브에이전트 결과로 일한다 (메인 컨텍스트가 작아야 긴 작업이 버틴다).
보고와 질문은 **지시서·questions.md 가 쓰인 언어**로 한다.
어느 단계든 `code-agent` 명령이 거부하면 **그 사유를 사용자에게 그대로 전하고 멈춘다.** 우회하지 않는다.

## 0. 시작

Bash: `code-agent start $ARGUMENTS`
- 기준 브랜치는 사용자가 말했으면 `--base` 로 넘긴다. 말이 없으면 넘기지 않는다 (프로젝트 기본값, 없으면 master).
- 이미 진행 중이면 `code-agent status` 의 스테이지에서 이어 간다.

## 1. 요구사항 분석 (analysis)

1. Bash: `code-agent context` — 지시서·필수 문서·작업 폴더 경로와 `analysis.md` 형식이 나온다.
2. `ca-analyst` 서브에이전트를 부른다. context 출력을 그대로 넘긴다.
3. 결과를 context 의 형식대로 작업 폴더의 `analysis.md` 에 쓴다 — 요구 항목은 `## R1 · …`, 필요한 작업 문서는 `## 작업 문서` 목록
   (필요 없으면 `- 없음`). 형식이 틀리면 `code-agent next` 가 무엇이 틀렸는지 알려 준다.
4. 가정 후보는 `analysis.md` 의 `## 가정` 에 근거와 함께 쓴다 (질문으로 만들지 않는다).
   질문 후보가 있으면 `questions.md` 에 덧붙인다 (형식은 파일 안내대로, 선택지와 `X. 기타:` 포함, `[Answer]:` 는 비워 둔다).
   질문이 있으면 사용자에게 보여 주고 **멈춘다** — "`/ca-answer` 로 답해 주세요".
5. 질문이 없으면 Bash: `code-agent next`

## 2. 범위 조사·작업 문서 (research)

1. Bash: `code-agent context` — 요구 항목과 **참조 도메인의 단계별 표준 파일**이 나온다.
   요구 항목을 **닿는 영역**(이번 도메인 · 공통 모듈 · 다른 도메인과의 연결)으로 묶어 영역마다 `ca-explorer` 하나를 **한 메시지에서 병렬로** 부른다 —
   요구 항목마다 하나씩 부르지 않는다 (같은 도메인만 닿는 작업이면 explorer 하나). 영역의 항목들 + context 출력 + 관련 문서 경로를 넘긴다.
2. analysis.md 가 작업 문서(데이터 정의·API 정의·현행 분석)를 필요하다고 했으면 문서마다
   Bash: `code-agent docs skeleton <data | api | current>` 로 뼈대를 받아, `ca-writer` 에게 뼈대 + explorer 결과 + 답한 질문을 넘겨
   작업 폴더에 쓰게 한다 (`data.md` · `api.md` · `current.md`) — **요구사항 범위만**. 필수 섹션이 비면 `code-agent next` 가 막는다.
3. 조사 중 나온 모호한 점과 writer 가 돌려준 `확인 필요` 목록을 `code-agent context` 의 기준으로 나눈다 —
   업무 규칙·범위는 `questions.md` 로(있으면 멈춘다), 기본값을 댈 수 있는 기술 세부는 `analysis.md` 의 `## 가정` 에 근거와 함께 더하고 문서에도 반영한다.
4. Bash: `code-agent next` — `## 작업 문서` 에 적은 문서가 없거나 비어 있으면 넘어가지 않는다.

## 3. 개발 계획 (plan)

1. Bash: `code-agent context` — 계획 형식과 단계 key·위치가 나온다.
2. analysis.md · 작업 문서 · explorer 결과로 계획 초안을 작업 폴더의 `plan.json` 에 쓴다.
   참조 도메인의 파일 구조를 따르고, 없는 파일을 발명하지 않는다.
   파일마다 `requirements` 에 담당하는 요구 항목 번호를 적는다 — 어느 파일에도 닿지 않는 항목이 있으면 제출이 거부된다.
3. `ca-critic` 에게 초안, analysis.md, 작업 문서, 아키텍처·컨벤션 경로, context 의 참조 표준 파일을 넘겨 반박 검토를 받는다. 타당한 지적은 반영하고, 사람이 정할 것은 `questions.md` 로.
4. Bash: `code-agent plan submit <작업 폴더>/plan.json` — 거부되면 사유대로 고쳐 다시 제출한다.
5. 제출되면 계획 요약을 보여 주고 **멈춘다**:
   "별도 터미널에서 `code-agent approve` 로 승인한 뒤 `/ca-next` 로 구현을 시작하세요."
