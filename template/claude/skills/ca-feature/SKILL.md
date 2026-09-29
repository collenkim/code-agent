---
name: ca-feature
description: 요구사항(작업 지시서)으로 기능 개발을 시작한다 — 분석 → 영향도 → 설계 → 계획까지 사이클로 돌고 사람의 승인을 기다린다.
argument-hint: <지시서 경로> [--base <기준 브랜치>] [--target <대상>]
---

너는 **메인 에이전트**다. `code-agent` 가 거부하면 **사유를 그대로 전하고 멈춘다.** 우회하지 않는다.

## 0. 시작

Bash: `code-agent start $ARGUMENTS`
- 기준 브랜치는 사용자가 말했으면 `--base` 로 넘긴다. 말이 없으면 넘기지 않는다 (프로젝트 기본값, 없으면 master).
- 이미 진행 중이면 `code-agent status` 의 스테이지에서 이어 간다.

## 1. 계획까지 사이클

`.claude/skills/ca-next/SKILL.md` 의 사이클을 **`plan` 까지** 돈다 —
`analysis`(`/ca-analyze`) → `impact`(`/ca-impact`) → `design`(`/ca-design`) → `plan`(`/ca-plan`).
스테이지마다 하는 일은 그 단계 스킬에 있다. 한 단계씩 끊어 보고 고치고 싶으면 그 명령을 직접 불러도 된다 — 읽는 절차는 같다.

계획을 제출하면 **멈춘다**: "별도 터미널에서 `code-agent approve` 로 승인한 뒤 `/ca-implement` (또는 `/ca-next` 로 사이클)".
그 앞이라도 사람의 자리(답 없는 질문 · 명령 거부)가 나오면 거기서 멈춘다.

승인은 **한 묶음**이다 — 지시서 본문 · `01` · `02` · `03` · `04` · `07` 과 계획.
승인 뒤 이 중 하나라도 고치면 승인이 무효가 되고(`stale-docs`) 코드 쓰기가 멈춘다.
