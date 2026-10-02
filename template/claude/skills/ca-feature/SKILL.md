---
name: ca-feature
description: 신규 개발·기능 추가·기능 변경을 진행한다 — feature 공통 접수와 같은 세션의 동의를 거쳐 분석부터 구현·검증·반영까지 이어간다. 종류를 정하지 않은 일반 접수는 ca-request를 사용한다.
argument-hint: [ID] <요구사항 서술 · 붙여넣은 티켓 · 파일 경로> [--base <기준 브랜치>] [--target <대상>]
---

**질의응답·동의 공통 규칙** — `.claude/skills/ca-answer/SKILL.md`를 읽는다. 일반 업무 질문은 공통 선택 절차로 받고 실제 답을 기록한다. 승인·확정·반영은 별도의 **같은 세션 동의 절차**로 메인만 `consent prepare` → `AskUserQuestion` → `consent status` → 승인된 `consent apply`를 수행한다. 일반 답변을 승인으로 적용하지 않는다. 적용 후 이 작업 흐름을 자동으로 이어가며 `/ca-next`는 중단 후 재개용이다. `update` 적용 후에는 멈추고 hook 로드를 위한 Claude Code 재시작을 안내한다.

너는 **메인 에이전트**다. `code-agent` 가 거부하면 **사유를 그대로 전하고 멈춘다.** 우회하지 않는다.

## 0. 접수

Bash: `code-agent status` 로 자리를 본다.
- 사용자가 요구사항 대신 **손으로 써 둔 지시서**를 쓰라고 하면 접수하지 않는다 — 그 경로로 `/ca-analyze <지시서>` 의 시작을 따른다 (`request submit` 은 사람이 쓴 지시서를 덮지 않는다).
- 작업도 접수도 없으면 `.claude/skills/ca-request/SKILL.md` 의 절차를 **종류 `feature`** 로 그대로 따른다 —
  인자의 ID 와 요구사항 서술을 넘긴다 (ID 가 없으면 생략하고 CLI가 발급한 ID를 쓴다). 인자에 `--base` · `--target` 이 있으면 `request begin` 에 함께 넘긴다.
  제출 후 `request` 공통 동의 절차를 수행하고 적용 성공 후 같은 흐름에서 분석으로 이어간다.
- 접수 중이고 status의 `다음:`이 `/ca-adopt`·`/ca-docs` 또는 공통 문서 확정을 가리키면 해당 준비 절차를 먼저 따른다. 접수 취소나 원문 재입력을 요구하지 않는다.
- 준비가 끝났고 접수 중인데 `요구사항: 확정됨` 이면 Bash: `code-agent start doc/work/<ID>/requirement.md`
  — 접수 때 넘긴 `--base` · `--target` 은 접수 세션에 남아 있다. 이번에 새로 말한 것만 넘긴다.
- 접수 중인데 아직 확정 전이면 `/ca-request` 의 절차로 이어 간다 (반려됐으면 그 절의 **반려됐다면**).
- 이미 진행 중이면 `code-agent status` 의 스테이지에서 이어 간다.

## 1. 분석부터 반영까지 사이클

`.claude/skills/ca-next/SKILL.md`의 단계 순서에 따라 **반영까지** 이어간다. 사용자에게 `/ca-next`를 다시 입력하게 하지 않는다 —
`analysis`(`/ca-analyze`) → `impact`(`/ca-impact`) → `design`(`/ca-design`) → `plan`(`/ca-plan`) → `implement` → `check` → `test` → `review` → `integrate` → `deliver`.
스테이지마다 하는 일은 그 단계 스킬에 있다. 한 단계씩 끊어 보고 고치고 싶으면 그 명령을 직접 불러도 된다 — 읽는 절차는 같다.

계획 제출 후에는 `plan`, 반영 시에는 `deliver` 공통 동의 절차를 수행한다. 동의를 적용하면 같은 흐름에서 다음 단계를 자동으로 이어간다.
일반 업무 질문은 공통 선택 절차로 답을 받는다. 수정 요청은 제안을 고친 뒤 새 동의로 확인받고, 취소·보류·필수 질문 미응답·명령 거부에서는 적용하지 않고 멈춘다.

승인은 **한 묶음**이다 — 지시서 본문 · `01` · `02` · `03` · `04` · `07` 과 계획.
승인 뒤 이 중 하나라도 고치면 승인이 무효가 되고(`stale-docs`) 코드 쓰기가 멈춘다.
요구사항을 고치면(초안을 고쳐 다시 제출) 사람이 다시 확정해야 하고, 이미 받은 계획 승인도 무효가 된다.
