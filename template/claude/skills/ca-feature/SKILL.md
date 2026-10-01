---
name: ca-feature
description: 요구사항을 받아 기능 개발을 시작한다 — 접수 → (사람 확정) → 분석 → 영향도 → 설계 → 계획까지 사이클로 돌고 사람의 승인을 기다린다.
argument-hint: <ID> <요구사항 서술 · 붙여넣은 티켓 · 파일 경로> [--base <기준 브랜치>] [--target <대상>]
---

너는 **메인 에이전트**다. `code-agent` 가 거부하면 **사유를 그대로 전하고 멈춘다.** 우회하지 않는다.

## 0. 접수

Bash: `code-agent status` 로 자리를 본다.
- 사용자가 요구사항 대신 **손으로 써 둔 지시서**를 쓰라고 하면 접수하지 않는다 — 그 경로로 `/ca-analyze <지시서>` 의 시작을 따른다 (`request submit` 은 사람이 쓴 지시서를 덮지 않는다).
- 작업도 접수도 없으면 `.claude/skills/ca-request/SKILL.md` 의 절차를 **종류 `feature`** 로 그대로 따른다 —
  인자의 ID 와 요구사항 서술을 넘긴다 (ID 가 없으면 묻고 멈춘다). 인자에 `--base` · `--target` 이 있으면 `request begin` 에 함께 넘긴다.
  제출까지 마치면 **멈춘다**: "별도 터미널에서 `code-agent confirm request <ID>` 로 확정한 뒤 `/ca-next`".
- 접수 중인데 `요구사항: 확정됨` 이면 Bash: `code-agent start doc/work/<ID>/requirement.md`
  — 접수 때 넘긴 `--base` · `--target` 은 접수 세션에 남아 있다. 이번에 새로 말한 것만 넘긴다.
- 접수 중인데 아직 확정 전이면 `/ca-request` 의 절차로 이어 간다 (반려됐으면 그 절의 **반려됐다면**).
- 이미 진행 중이면 `code-agent status` 의 스테이지에서 이어 간다.

## 1. 계획까지 사이클

`.claude/skills/ca-next/SKILL.md` 의 사이클을 **`plan` 까지** 돈다 —
`analysis`(`/ca-analyze`) → `impact`(`/ca-impact`) → `design`(`/ca-design`) → `plan`(`/ca-plan`).
스테이지마다 하는 일은 그 단계 스킬에 있다. 한 단계씩 끊어 보고 고치고 싶으면 그 명령을 직접 불러도 된다 — 읽는 절차는 같다.

계획을 제출하면 **멈춘다**: "별도 터미널에서 `code-agent approve` 로 승인한 뒤 `/ca-implement` (또는 `/ca-next` 로 사이클)".
그 앞이라도 사람의 자리(요구사항 확정 · 답 없는 질문 · 명령 거부)가 나오면 거기서 멈춘다.

승인은 **한 묶음**이다 — 지시서 본문 · `01` · `02` · `03` · `04` · `07` 과 계획.
승인 뒤 이 중 하나라도 고치면 승인이 무효가 되고(`stale-docs`) 코드 쓰기가 멈춘다.
요구사항을 고치면(초안을 고쳐 다시 제출) 사람이 다시 확정해야 하고, 이미 받은 계획 승인도 무효가 된다.
