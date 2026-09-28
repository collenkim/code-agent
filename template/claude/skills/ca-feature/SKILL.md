---
name: ca-feature
description: 요구사항(작업 지시서)으로 기능 개발을 시작한다 — 분석 → 범위 조사 → 계획 제출까지 진행하고 사람의 승인을 기다린다.
argument-hint: <지시서 경로> [--base <기준 브랜치>] [--target <대상>]
---

너는 **메인 에이전트**다. 순서를 진행하고 서브에이전트를 부르고 결과를 합친다. 코드는 쓰지 않는다.
어느 단계든 `code-agent` 명령이 거부하면 **그 사유를 사용자에게 그대로 전하고 멈춘다.** 우회하지 않는다.

## 0. 시작

Bash: `code-agent start $ARGUMENTS`
- 기준 브랜치는 사용자가 말했으면 `--base` 로 넘긴다. 말이 없으면 넘기지 않는다 (프로젝트 기본값, 없으면 master).
- 이미 진행 중이면 `code-agent status` 의 스테이지에서 이어 간다.

## 1. 요구사항 분석 (analysis)

1. Bash: `code-agent context` — 지시서·필수 문서·작업 폴더 경로가 나온다.
2. `ca-analyst` 서브에이전트를 부른다. context 출력을 그대로 넘긴다.
3. 결과를 작업 폴더의 `analysis.md` 에 쓴다: 요구 항목(R1, R2 …), 항목별 데이터·접점 여부, 필요한 작업 문서.
4. 질문 후보가 있으면 `questions.md` 에 덧붙인다 (형식은 파일 안내대로, 선택지와 `X. 기타:` 포함, `[Answer]:` 는 비워 둔다).
   질문이 있으면 사용자에게 보여 주고 **멈춘다** — "`/ca-answer` 로 답해 주세요".
5. 질문이 없으면 Bash: `code-agent next`

## 2. 범위 조사·작업 문서 (research)

1. 요구 항목마다 `ca-explorer` 를 **한 메시지에서 병렬로** 부른다. 항목 내용 + 관련 문서 경로를 넘긴다.
2. analysis.md 가 작업 문서(데이터 정의·API 정의·현행 분석)를 필요하다고 했으면 `ca-writer` 에게
   explorer 결과를 넘겨 작업 폴더에 쓰게 한다 (`data.md` · `api.md` · `current.md`) — **요구사항 범위만**.
3. 조사 중 나온 모호한 점은 `questions.md` 로. 있으면 멈춘다.
4. Bash: `code-agent next`

## 3. 개발 계획 (plan)

1. Bash: `code-agent context` — 계획 형식과 단계 key·위치가 나온다.
2. analysis.md · 작업 문서 · explorer 결과로 계획 초안을 작업 폴더의 `plan.json` 에 쓴다.
   참조 도메인의 파일 구조를 따르고, 없는 파일을 발명하지 않는다.
3. `ca-critic` 에게 초안과 근거 문서 경로를 넘겨 반박 검토를 받는다. 타당한 지적은 반영하고, 사람이 정할 것은 `questions.md` 로.
4. Bash: `code-agent plan submit <작업 폴더>/plan.json` — 거부되면 사유대로 고쳐 다시 제출한다.
5. 제출되면 계획 요약을 보여 주고 **멈춘다**:
   "별도 터미널에서 `code-agent approve` 로 승인한 뒤 `/ca-next` 로 구현을 시작하세요."
