---
name: ca-integrate
description: 통합 검증 단계(integrate)를 돌고 반영 준비까지 한다 — 깨끗한 worktree 에서 전체 build·test 를 돌리고, ⑩ 10-pr.md 의 모델 구역을 쓴 뒤 사람에게 터미널을 넘긴다.
---

너는 **메인 에이전트**다. `code-agent` 가 거부하면 **사유를 그대로 전하고 멈춘다.** 사람에게 물을 것은 턴의 마지막 메시지에 모아서 낸다.
**반영은 네가 끝낼 수 없다 — 확인도 커밋도 사람의 자리다.**

**자리 확인** — Bash: `code-agent status`. 스테이지가 `integrate` 도 `deliver` 도 아니면 **멈춘다.**
아직 이르면 status 의 `다음:` 줄이 가리키는 명령을 먼저 하라고 전하고, 이미 지났으면 `code-agent back integrate` 로
되감아야 한다고 전한다 — 무엇이 무효가 되는지는 그 명령이 찍는다. **되감기는 사용자가 되돌리라고 말했을 때만** 돌린다.
스테이지가 이미 `deliver` 면 1·2 를 건너뛰고 **3. 반영 준비**부터 한다.

## 1. 통합 검증

1. Bash: `code-agent integrate` — 기준 커밋에서 뜬 깨끗한 worktree 에 계획 파일만 얹고 전체 build·test 를 돌린다.
2. 실패면 `.claude/skills/ca-check/SKILL.md` 의 **↺ 수정 루프** — 여기서 나오는 것은 대개 계획 밖 의존이라 질문으로 가는 쪽이 많다.

## 2. 게이트

통과면 Bash: `code-agent next` — 거부되면 사유를 그대로 전하고 멈춘다. 커서가 `deliver` 로 간다.

## 3. 반영 준비 — ⑩ `10-pr.md`

1. ⑩ `10-pr.md` 의 **모델 구역**(`요약` · `확인 방법` · `위험·되돌리기`)을 계획·분석·리뷰를 근거로 쓴다. 코드를 다시 읽지 않는다.
   `추적표` · `검증` 은 `<!-- code-agent:trace:start -->` ~ `end` 블록 안이고 `code-agent deliver` 가 렌더한다 — 손대면 바이트 대조에서 걸린다.
2. KNOWLEDGE 에 올릴 것이 있으면 `doc/work/<ID>/knowledge.proposal.md` 에 항목으로 적는다 — 사람이 터미널에서 고른 것만 반영된다.

## 끝

사용자에게 전하고 **멈춘다**: "별도 터미널에서 `code-agent deliver`".
반영은 작업 브랜치 **로컬 커밋까지**다 — push·MR/PR 생성은 하지 않는다.
