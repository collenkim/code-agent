---
name: ca-plan
description: 구현 계획 단계(plan)를 진행한다 — ⑤ plan.json 과 ⑦ 07-test-spec.md 를 제출하고 같은 세션의 동의를 적용한 뒤 작업 흐름을 이어간다.
---

**질문·동의** — `.claude/skills/ca-answer/SKILL.md`를 따른다. 이 대화에서 아직 읽지 않았거나 대화가 압축·비워진 뒤라면 그 직전에 읽는다. `AskUserQuestion`을 실제 호출하며 일반 답은 승인이 아니다. 질문·대기는 `.claude/skills/ca-answer/reference.md`의 단계별 선택·차단 복구를 따른다. 적용 뒤 이어간다.

너는 **메인 에이전트**다. 소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서 · `code-agent` 출력 · 서브에이전트 결과로 일한다.
`code-agent` 가 거부하면 차단 복구를 따른다.

**자리 확인** — 방금 받은 `code-agent` 출력에 지금 스테이지가 없을 때만 Bash: `code-agent status`. 스테이지가 `plan` 이 아니면 차단 복구로 현재 단계의 재개 방향을 정한다.

승인이 `rejected` 로 나오면 아래 **반려됐다면** 으로 간다.
승인이 `approved`면 계획은 이미 통과했다 — **계획을 다시 쓰지 않는다.** 커서가 `plan`에 남아 있으면 Bash: `code-agent next`로 옮긴다. 같은 작업 흐름에서는 `/ca-implement` 절차로 자동으로 이어간다. 사용자가 계획 단계만 요청했다면 게이트를 통과한 결과를 보고한다.

**`05-plan.md` 는 쓰지 않는다** — `plan submit` 이 `plan.json` 에서 렌더한다 (hook 이 모델의 쓰기를 거부한다).

## 관찰된 계획 작업

`code-agent status`에 관찰 흐름이 표시된 작업의 절차다. 표시가 없는 이전 버전 작업은 `.claude/skills/ca-plan/legacy.md`를 읽고 따른다. 영역 분할·재개·피드백 규칙은 `.claude/skills/ca-plan/contract.md`의 **계획 작업 계약**이다.

아래 명령 전에 `.claude/skills/ca-plan/contract.md`의 **공통 진행·되감기**를 읽고 따른다. 출력 이후의 배정·대기·완료·게이트 판정은 그 절이 정본이다.

1. Bash: `code-agent planning advance` — 준비·결과 재사용·선행 조건·배정을 한 번에 한다(계획 제출과 승인은 사람 확인이라 잇지 않는다). 이 단계 역할은 **plan → critic**다. 메인이 역할을 추가하거나 독립 critic을 생략하지 않는다.
4-1. **교차 검증을 선택한 프로젝트**면 critic 완료 뒤 `blocked` 사유에 `교차 검토` 가 나온다 — Bash: `code-agent planning cross --by codex` 로 다른 호스트가 같은 critic 입력을 읽기 전용으로 교차 검토하게 한다(CLI 가 9분에 끊으므로 timeout 600000ms 또는 백그라운드). critic 결과마다 한 번만 기록된다. 차단 지적은 공통 진행처럼 고칠 작업을 지적 내용으로 정해 계약의 수정 피드백으로 다시 배정하고(앞 단계 작업이면 원인과 비용을 사용자에게 보고하고 지시를 받는다), 사용자가 지적을 기각하면 공통 동의 절차의 `judgment` `waive-finding` 으로 기록한다. 질문은 ca-answer로 실제 답을 받는다 — 답하면 critic 이 다시 배정되고 교차 검토도 새로 받는다. 출력이 `교차 검증 중지` 면 다른 호스트를 실행할 수 없었던 것이다(미설치·로그인·사용 한도·장애) — 사용자에게 사유를 한 줄 알리고 계속한다. 그 밖의 실패는 출력의 안내만 따르고 같은 명령을 스스로 반복하지 않는다.

## 끝

Bash: `code-agent plan submit <작업 폴더>/plan.json` — 거부되면 사유를 계약의 수정 피드백으로 남겨 plan 작업을 다시 배정한다. 통과하면 코드가 `05-plan.md` 를 렌더한다.

승인 적용 전에는 `code-agent next`를 돌리지 않는다. `{"action":"plan"}`으로 공통 동의 절차를 수행하고 계획·지시서·분석·설계·테스트 명세의 링크를 포함한 `summary` 전문을 보여 준다. 실제 응답 뒤 승인됐으면 적용한다. `finish`가 게이트를 지나 커서를 구현으로 옮기고 첫 Task context를 써 둔다(결과의 `contextFile`) — 결과의 `phase`가 아직 `plan`이면 Bash: `code-agent next`. 같은 흐름의 구현·검증으로 이어간다. 사용자가 계획 단계만 요청했다면 게이트 통과 결과를 보고한다.
수정 요청·취소·보류이면 적용하지 않는다. 사용자가 명시적으로 계획 반려 기록을 요청했으면 `decision: "reject"`와 실제 사유인 `comment`를 넣은 `plan` 동작도 별도 공통 동의 절차로 처리한다.

승인은 **한 묶음**이다 — 지시서 본문 · `01` · `02` · `03` · `04` · `07` 과 계획. 승인 뒤 이 중 하나라도 고치면 승인이 무효가 되고(`stale-docs`) 코드 쓰기가 멈춘다.
`code-agent back` 으로 `design` 이하로 되감아 문서를 고치는 것도 같다 — 계획을 다시 제출하고 다시 승인받아야 한다.

## 반려됐다면

`code-agent status` 가 `승인 rejected` 로 나오는 자리다. 반려는 다시 내라는 뜻이 아니라 **다시 보라**는 뜻이다:

1. `.code-agent/approvals/<ID>.jsonl` 의 마지막 줄에서 반려 사유(`comment`)를 읽는다.
   설계·AC 면 `03-design.md`·`04-functional.md`, 테스트면 `07-test-spec.md`, 파일 구성이면 `plan.json`.
   커서를 되감아야 고칠 수 있는 문서면 `code-agent back <스테이지>` 를 쓰고, 그 스테이지의 스킬로 다시 돈다.
   정할 수 있으면 문서와 계획을 고쳐 `code-agent plan submit` 으로 다시 제출하고, **무엇을 왜 바꿨는지** 함께 보고한다.
   관찰 흐름 작업은 번호 문서·`plan.json`을 메인이 직접 고치지 못한다(hook 거부) — 반려 사유를 계약의 **수정 피드백** 파일로 남기고, 고칠 작업을 사유 내용으로 정해 다시 배정한다. 이 단계 작업이면 바로 배정하고, 앞 단계 작업이면 되감기 전에 원인과 비용(다시 도는 단계·작업)을 사용자에게 보고하고 지시를 받는다. 새 결과와 critic 검토 뒤 다시 제출한다.
