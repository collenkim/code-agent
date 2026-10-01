---
name: ca-next
description: 진행 중인 code-agent 작업을 사이클로 돈다 — 지금 스테이지의 단계 스킬을 그대로 따르고, 사람이 멈춰야 할 자리가 나올 때까지 다음 스테이지로 이어 간다.
---

너는 **메인 에이전트**다. `code-agent` 가 거부하면 사유를 그대로 전하고 멈춘다.
사용자에게 진행은 **준비 → 요구 확인 → 계획 확인 → 개발·검증 → 결과 확인**의 5단계로 요약한다. 내부 스테이지 명령 목록을 매번 나열하지 않는다. 멈출 때는 이유와 지금 할 일 하나만 보여준다. 답변을 받았거나 승인이 이미 기록됐으면 현재 상태를 읽고 자동으로 이어간다.
사람에게 물을 것은 **턴의 마지막 메시지에 모아서** 낸다 — 작업 보고 중간에 끼우면 묻혀 답이 오지 않는다.

이 스킬은 **사이클**이다. 스테이지마다 무엇을 하는지는 전부 **단계 스킬**에 있고 여기서는 순서만 돈다 —
한 스테이지씩 끊어 보고 고치고 싶으면 표의 명령을 직접 부른다. 어느 쪽이든 읽는 절차는 같은 파일 하나다.

| 스테이지 | 단계 명령 | 절차 |
|---|---|---|
| 접수 (작업 시작 전) | `/ca-request` | `.claude/skills/ca-request/SKILL.md` — `요구사항: 확정됨` 이면 `code-agent start doc/work/<ID>/requirement.md` 로 시작하고 `analysis` 로 잇는다 |
| `analysis` | `/ca-analyze` | `.claude/skills/ca-analyze/SKILL.md` |
| `impact` | `/ca-impact` | `.claude/skills/ca-impact/SKILL.md` |
| `design` | `/ca-design` | `.claude/skills/ca-design/SKILL.md` |
| `plan` | `/ca-plan` | `.claude/skills/ca-plan/SKILL.md` |
| `implement` | `/ca-implement` | `.claude/skills/ca-implement/SKILL.md` |
| `check` | `/ca-check` | `.claude/skills/ca-check/SKILL.md` (**↺ 수정 루프**가 여기 있다) |
| `test` | `/ca-test` | `.claude/skills/ca-test/SKILL.md` |
| `review` | `/ca-review` | `.claude/skills/ca-review/SKILL.md` |
| `integrate` · `deliver` | `/ca-integrate` | `.claude/skills/ca-integrate/SKILL.md` |

1. Bash: `code-agent status` — 지금 스테이지를 확인한다. 작업이 아직 시작 전이고 접수 중이면 표의 첫 줄이 그 자리다.
   접수 중 `다음:`이 프로젝트 준비(`/ca-adopt`·`/ca-docs`·공통 문서 확정)를 가리키면 준비부터 한다.
   해당 스킬을 읽고 원문과 접수 ID를 유지한 채 이어간다. 준비를 마치면 접수로 돌아온다. 문서 확인은 `code-agent confirm doc all` 한 번으로 안내한다.
   `다음:`이 `code-agent docs end`이면 그 명령으로 준비 세션을 닫고 같은 접수를 이어간다.
2. 표에서 그 스테이지의 절차 파일을 읽고 **그대로 따른다.** 자리 확인은 1 에서 이미 했으니 다시 하지 않는다.
3. 그 스킬이 게이트(`code-agent next`)를 지났으면 — 접수라면 요구사항이 확정돼 `code-agent start` 로 시작했으면 —
   안내만 찍고 끝내지 말고 **다음 스테이지의 절차로 이어 간다** — 2 로 돌아간다.
4. **사람의 자리가 나오면 멈춘다.** 무엇 때문에 멈췄는지와 사용자가 할 일을 마지막 메시지에 모아서 낸다:
   - 요구사항을 제출했다 · 확정 뒤 바뀌었다 → 별도 터미널에서 `code-agent confirm request <ID>`
   - 요구사항이 반려됐다 → `/ca-request` 의 **반려됐다면** 으로 간다
   - 답 없는 질문이 생겼다 → `/ca-answer`
   - 계획을 제출했다 → 별도 터미널에서 `code-agent approve`
     (**이미 `승인 approved`** 면 멈추는 자리가 아니다 — 커서만 `plan` 에 남아 있으니 `code-agent next` 로 넘기고 `implement` 부터 잇는다)
   - 계획이 반려됐다 (`승인 rejected`) → `/ca-plan` 의 **반려됐다면** 으로 간다
   - 계획 밖 실패·지적, 또는 고쳐 쓰기 한도 초과 → 덮지 않고 보고한다
   - `code-agent` 명령이 거부했다 → 사유를 그대로 전한다
   - 커서가 `deliver` 다 → 별도 터미널에서 `code-agent deliver`
5. 끝나면 무엇을 만들었는지(파일 목록)와 다음 할 일을 짧게 보고한다.

**되감기** — 사용자가 이전 스테이지로 돌아가자고 하면 Bash: `code-agent back <스테이지>` 를 돌리고 그 스테이지의 절차부터 다시 사이클을 돈다.
무엇이 무효가 되는지는 그 명령이 찍는다 — 그대로 전한다. 사이클이 스스로 되감지는 않는다.
(검증 실패로 `check` 로 돌아가는 것은 되감기가 아니다 — `code-agent check` 가 커서를 데려간다.)
