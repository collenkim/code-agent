---
name: ca-next
description: 진행 중인 code-agent 작업을 다음으로 진행한다 — 지금 스테이지를 이어 가고, 구현 단계에서는 단계마다 서브에이전트에게 코드를 쓰게 한다.
---

너는 **메인 에이전트**다. `code-agent` 명령이 거부하면 사유를 그대로 전하고 멈춘다.

사람에게 물을 것은 **턴의 마지막 메시지에 모아서** 낸다 — 작업 보고 중간에 끼우면 묻혀 답이 오지 않는다.

1. Bash: `code-agent status` 로 스테이지를 확인한다.
2. 스테이지별로:
   - **analysis · impact · design · plan** — `.claude/skills/ca-feature/SKILL.md` 의 해당 절부터 이어 간다
     (`analysis` → 1절 `01-requirements.md`, `impact` → 2절 `02-analysis.md`, `design` → 3절 `03-design.md`·`04-functional.md`, `plan` → 4절 `plan.json`·`07-test-spec.md`).
   - **implement** — 단계가 끝날 때까지 반복한다:
     1. Bash: `code-agent context` — 이 단계의 만들 파일, 단계 규칙, 참조 표준 코드가 나온다.
     2. 테스트 단계면 `ca-tester`, 아니면 `ca-implementer` 를 부른다. context 출력을 **그대로** 넘기고,
        작업 폴더의 `03-design.md` · `04-functional.md` 경로(테스트 단계면 `07-test-spec.md` 도)를 함께 준다.
        서브에이전트는 새 컨텍스트에서 시작하므로 필요한 것은 전부 넘긴다.
     3. 서브에이전트가 hook 거부나 질문을 보고하면 사용자에게 전하고 멈춘다.
     4. Bash: `code-agent next` — 계획 파일이 빠졌다고 하면 같은 서브에이전트에게 빠진 것만 한 번 더 맡긴다. 두 번째도 안 되면 멈추고 보고한다.
   - **check** (정적 분석·컴파일) — 검증 결과는 **네가 보고하는 것이 아니라 명령이 돌아서 남은 것만** 유효하다:
     1. Bash: `code-agent check` — `build` 와 품질·보안 기준이 적은 명령을 돌려 증거(`.code-agent/work/<ID>/<대상>.verify.json`)에 적고 ⑧ `08-validation.md` 를 렌더한다.
        전체 로그는 `.code-agent/log/` 에 남고 출력에는 요약과 실패 꼬리만 나온다. 네가 직접 돌린 빌드는 게이트를 열지 못한다.
     2. 전부 통과면 Bash: `code-agent next`. 실패면 아래 **↺ 수정 루프**.
   - **test** (테스트 생성·실행 · 결과 분석):
     1. Bash: `code-agent context` — 이 스테이지에서 쓸 테스트 파일과 ⑦ 의 TC 가 나온다.
     2. ⑦ 에 아직 코드가 없는 TC 가 남아 있으면 `ca-tester` 를 부른다 (매니페스트에 `kind: test` 단계가 있어 `implement` 에서 이미 다 썼으면 이 자리는 **실행만** 한다).
        context 출력을 **그대로** 넘기고 `07-test-spec.md` · `04-functional.md` 경로를 함께 준다.
        **⑦ 의 TC 를 그대로, 그것만** 쓰게 한다 — 빼지도 더하지도 않는다. 명세가 모자라 보인다는 보고가 오면 고치지 말고 그대로 사용자에게 전한다 (⑦ 은 승인에 묶여 있다).
     3. Bash: `code-agent test` — `test` 와 테스트 전략이 적은 명령을 돌리고 ⑦ 의 TC id 를 대조한다.
        **이 순간부터 `kind: test` 단계의 파일은 언다** — 실패해도 단언을 고쳐 통과시키는 길은 hook 이 막는다.
     4. 전부 통과면 Bash: `code-agent next`. 실패면 아래 **↺ 수정 루프**.
   - **review** (코드 리뷰):
     1. Bash: `code-agent context` — 계획 파일·파일별 요구 항목·검증 증거 요약·실패 로그 **경로**·얼어 있는 파일·남은 회차가 나온다.
     2. `ca-reviewer` 를 부른다. context 출력을 **그대로** 넘기고 `02-analysis.md` · `03-design.md` · `04-functional.md`(AC) · 컨벤션 · 품질·보안 기준의 **경로**를 함께 준다.
        저장소를 다시 훑게 하지 않는다 — 준 목록 밖은 읽지 않는 것이 리뷰어의 규칙이다.
     3. 돌아온 지적 표를 `09-review.md` 의 `## 지적` 에 **그대로** 옮긴다 — 요약·완화·재분류하지 않는다.
        열은 받은 그대로 `| id | 계획 파일 | 범위 | 상태 | 지적 |` 이고 **순서가 곧 규칙이다** — 코드가 칸 위치로 읽는다.
        `계획 파일` 은 저장소 기준 경로 그대로(백틱도 `:줄번호` 도 붙이지 않는다), `상태` 는 `열림` · `해결` 둘뿐이다. 지적이 없으면 `- 없음`.
        `## 회차` 의 머리(번호·시각·기준 트리 해시)는 **코드가 적는다** — 손으로 쓰거나 고치지 않는다.
     4. **계획 안** 지적은 **↺ 수정 루프**로 고친다. 고친 뒤 `code-agent check` 부터 다시 돌아
        `code-agent review` 로 **새 회차**를 열고, 고친 줄의 상태를 `해결` 로 바꾼다.
        한 번 적은 지적 줄은 **지우지 않는다** — 얼어 있던 테스트 파일을 그 줄로 풀었으면 코드가 기억하고 있어, 지우면 게이트가 막는다.
     5. 열린 `계획 안` 지적이 0 이면 Bash: `code-agent next`.
   - **integrate** (통합 검증):
     1. Bash: `code-agent integrate` — 기준 커밋에서 뜬 깨끗한 worktree 에 계획 파일만 얹고 전체 build·test 를 돌린다.
     2. 통과면 Bash: `code-agent next`. 실패면 **↺ 수정 루프** — 여기서 나오는 것은 대개 계획 밖 의존이라 질문으로 가는 쪽이 많다.
   - **deliver** (반영) — **네가 끝낼 수 없다. 확인도 커밋도 사람의 자리다.**
     1. ⑩ `10-pr.md` 의 **모델 구역**(`요약` · `확인 방법` · `위험·되돌리기`)을 계획·분석·리뷰를 근거로 쓴다. 코드를 다시 읽지 않는다.
        `추적표` · `검증` 은 `<!-- code-agent:trace:start -->` ~ `end` 블록 안이고 `code-agent deliver` 가 렌더한다 — 손대면 바이트 대조에서 걸린다.
     2. KNOWLEDGE 에 올릴 것이 있으면 `doc/work/<ID>/knowledge.proposal.md` 에 항목으로 적는다 — 사람이 터미널에서 고른 것만 반영된다.
     3. 사용자에게 **"별도 터미널에서 `code-agent deliver`"** 라고 전하고 멈춘다. 반영은 작업 브랜치 **로컬 커밋까지**다 — push·MR/PR 생성은 하지 않는다.
3. 끝나면 무엇을 만들었는지(파일 목록)와 다음 할 일을 짧게 보고한다.

**↺ 수정 루프** — `check` · `test` · `review` · `integrate` 가 함께 쓴다. 회차는 **코드가 센다** (`code-agent.json` 의 `fixRounds`, 기본 2):

1. 실패·지적마다 어느 **계획 파일**의 문제인지 가른다. `code-agent context` 가 준 계획 파일 목록이 기준이고, 네 기억이 아니다.
2. **계획 안** — `ca-implementer` 에게 파일별로 맡긴다. 무엇이 왜 실패했는지(명령 · outcome · 로그 **경로**)와 고칠 파일만 넘긴다.
   끝나면 **`code-agent check` 부터 다시** 돈다 — 중간부터 잇지 않는다. `check` 는 `test` · `review` · `integrate` 어디서 불러도
   커서를 그 자리로 되감으므로, 스테이지를 되돌리려고 따로 할 일은 없다. 그 뒤 `next` 로 같은 게이트를 다시 전부 지난다.
3. **계획 밖** — 고치지 않는다. `questions.md` 에 질문으로 남기고 사용자에게 전하고 멈춘다. 계획 자체를 넓혀야 하면 재승인(`plan submit` → 터미널 `approve`)이 필요하다고 알린다.
4. 얼어 있는 테스트 파일(`kind: test` 단계)은 **고칠 수 없다.** 테스트가 틀렸다고 보이면 그것은 사람에게 올릴 지적이다 — 근거와 함께 보고한다.
5. 한도를 넘기면 hook 이 계획 파일 쓰기를 전부 거부한다. **덮지 않는다** — 무엇이 몇 회차에서 왜 막혔는지 사용자에게 보고하고 멈춘다.

**계획이 반려됐다면** (`code-agent status` 가 `승인 rejected` 로 나온다) — 반려는 다시 내라는 뜻이 아니라 **다시 보라**는 뜻이다:

1. `.code-agent/approvals/<ID>.jsonl` 의 마지막 줄에서 반려 사유(`comment`)를 읽는다.
2. 사유가 가리키는 문서를 다시 본다 — 요구 해석이면 `01-requirements.md`, 영향 범위면 `02-analysis.md`,
   설계·AC 면 `03-design.md`·`04-functional.md`, 테스트면 `07-test-spec.md`, 파일 구성이면 `plan.json`.
3. 사유만으로 정할 수 없는 것이 있으면 **새 질문을 `questions.md` 에 적고 사용자에게 전하고 멈춘다.**
   정할 수 있으면 문서와 계획을 고쳐 `code-agent plan submit` 으로 다시 제출하고, **무엇을 왜 바꿨는지** 함께 보고한다.
4. 사유를 읽지 않고 같은 계획을 다시 내지 않는다.
