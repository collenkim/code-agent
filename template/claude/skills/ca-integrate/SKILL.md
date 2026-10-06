---
name: ca-integrate
description: 통합 검증과 반영을 진행한다 — 깨끗한 worktree 에서 전체 build·test 를 돌리고 ⑩ 10-pr.md 를 준비한 뒤 같은 세션의 동의로 로컬 커밋까지 적용한다.
---

**질문·동의** — 사람에게 묻거나 승인·확정·반영을 받기 직전에 `.claude/skills/ca-answer/SKILL.md`를 읽고 그 절차(`AskUserQuestion`·같은 세션 동의)를 따른다. 일반 답변은 승인이 아니며, 적용 뒤에는 이 흐름을 자동으로 이어간다.

너는 **메인 에이전트**다. `code-agent` 가 거부하면 **사유를 그대로 전하고 멈춘다.**
**반영은 사용자의 실제 동의가 필요하다.** 메인이 공통 동의 절차로 확인받고 승인된 `deliver` 동의만 적용한다.

**자리 확인** — Bash: `code-agent status`. 스테이지가 `integrate` 도 `deliver` 도 아니면 **멈춘다.**
아직 이르면 status 의 `다음:` 줄이 가리키는 명령을 먼저 하라고 전하고, 이미 지났으면 `code-agent back integrate` 로
되감아야 한다고 전한다 — 무엇이 무효가 되는지는 그 명령이 찍는다. **되감기는 사용자가 되돌리라고 말했을 때만** 돌린다.
스테이지가 이미 `deliver` 면 1·2 를 건너뛰고 **3. 반영 준비**부터 한다.

## 1. 통합 검증

1. Bash: `code-agent integrate` — 기준 커밋에서 뜬 깨끗한 worktree 에 계획 파일만 얹고 전체 build·test 를 돌린다.
   `code-agent.json` 에 `prepare` 가 선언돼 있으면 **그것이 build·test 앞에 한 번 먼저** 돈다 (예: `npm ci`).
   `prepare` 가 실패하면 build·test 는 **돌지 않는다** — 준비되지 않은 트리 위의 통과는 증거가 아니다.
2. 실패면 `.claude/skills/ca-check/SKILL.md` 의 **↺ 수정 루프** — 여기서 나오는 것은 대개 계획 밖 의존이라 질문으로 가는 쪽이 많다.
   `prepare: failed` 는 계획이 아니라 **매니페스트나 환경**의 문제다. 계획 파일을 고치지 말고 사유를 그대로 전하고 멈춘다.

## 2. 게이트

통과면 Bash: `code-agent next` — 거부되면 사유를 그대로 전하고 멈춘다. 커서가 `deliver` 로 간다.

## 3. 반영 준비 — ⑩ `10-pr.md`

1. ⑩ `10-pr.md` 의 **모델 구역**(`요약` · `확인 방법` · `위험·되돌리기`)을 계획·분석·리뷰를 근거로 쓴다. 코드를 다시 읽지 않는다.
   `추적표` · `검증` 은 `<!-- code-agent:trace:start -->` ~ `end` 블록 안이고 `code-agent deliver` 가 렌더한다 — 손대면 바이트 대조에서 걸린다.
2. KNOWLEDGE에 올릴 것이 있으면 `doc/work/<ID>/knowledge.proposal.md`에 항목으로 적는다. `deliver` 동의에서 사용자가 고른 항목만 최종 승인 범위에 포함된다.

## 끝

`{"action":"deliver"}`로 공통 동의 절차를 수행한다. 결과·검증·변경 파일·문서 링크가 포함된 `summary` 전문을 보여 주고 반환된 `toolInput` 전체를 그대로 호출한다. 지식 항목 선택이 남으면 매번 `consent finish`가 새로 반환한 `toolInput`으로 반복하고, **항목 선택 후 최종 승인**을 받는다. `approved`일 때만 동의가 적용된다. 적용 성공 후 로컬 커밋과 반영 결과를 보고하며 `/ca-next` 재입력을 요구하지 않는다. 수정 요청·취소·보류이면 적용하지 않는다.
반영은 작업 브랜치 **로컬 커밋까지**다 — push·MR/PR 생성은 하지 않는다.
