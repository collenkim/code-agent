---
name: ca-plan
description: 구현 계획 단계(plan)를 진행한다 — ⑤ plan.json 과 ⑦ 07-test-spec.md 를 제출하고 같은 세션의 동의를 적용한 뒤 작업 흐름을 이어간다.
---

**질문·동의** — 사람에게 묻거나 승인·확정·반영을 받을 때는 `.claude/skills/ca-answer/SKILL.md`의 절차(`AskUserQuestion`·같은 세션 동의)를 따른다. 이 대화에서 아직 읽지 않았거나 대화가 압축·비워진 뒤라면 그 직전에 읽는다. 일반 답변은 승인이 아니며, 적용 뒤에는 이 흐름을 자동으로 이어간다.

너는 **메인 에이전트**다. 소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서 · `code-agent` 출력 · 서브에이전트 결과로 일한다.
`code-agent` 가 거부하면 **사유를 그대로 전하고 멈춘다.**

**자리 확인** — 방금 받은 `code-agent` 출력에 지금 스테이지가 없을 때만 Bash: `code-agent status`. 스테이지가 `plan` 이 아니면 **멈춘다.**
아직 이르면 status 의 `다음:` 줄이 가리키는 명령을 먼저 하라고 전하고, 이미 지났으면 `code-agent back plan` 으로
되감아야 한다고 전한다 — 무엇이 무효가 되는지는 그 명령이 찍는다. **되감기는 사용자가 되돌리라고 말했을 때만** 돌린다 — 승인 무효로 status 의 `다음:` 이 되감기를 안내할 때와 `planning advance` 가 자동 되감기(`rewind-required`, `rewind.auto: true`)를 낼 때는 예외다.
승인이 `rejected` 로 나오면 아래 **반려됐다면** 으로 간다.
승인이 `approved`면 계획은 이미 통과했다 — **계획을 다시 쓰지 않는다.** 커서가 `plan`에 남아 있으면 Bash: `code-agent next`로 옮긴다. 같은 작업 흐름에서는 `/ca-implement` 절차로 자동으로 이어간다. 사용자가 계획 단계만 요청했다면 게이트를 통과한 결과를 보고한다.

**`05-plan.md` 는 쓰지 않는다** — `plan submit` 이 `plan.json` 에서 렌더한다 (hook 이 모델의 쓰기를 거부한다).

## 관찰된 계획 작업

`code-agent status`에 관찰 흐름이 표시된 작업의 절차다. 표시가 없는 이전 버전 작업은 `.claude/skills/ca-plan/legacy.md`를 읽고 따른다. 영역 분할·재개·피드백 규칙은 `.claude/skills/ca-plan/contract.md`의 **계획 작업 계약**이다.

1. Bash: `code-agent planning advance` — 준비·결과 재사용·선행 조건·배정을 한 번에 한다(계획 제출과 승인은 사람 확인이라 잇지 않는다). 이 단계 역할은 **plan → critic**다. 메인이 역할을 추가하거나 독립 critic을 생략하지 않는다.
2. 이후는 출력의 `next` 줄(action별 다음 행동)을 따르고 그 줄의 명령은 **글자 그대로** 쓴다. `action:dispatch`이면 `assignments`마다 `agent` 서브에이전트를 호출하고(형식만 고치는 교정 배정 `mode:correction`도 같다), 프롬프트에는 **`assignmentFile` 경로와 "이 파일을 읽고 그 계약대로 결과 JSON 하나를 반환하라"**만 쓴다 — 배정·문서 기준·뼈대·context·staging 경로는 그 파일에 있다. 재배정이면 직전 실패·게이트 거부 사유처럼 파일에 없는 메모만 2~3줄 덧붙인다.
3. 담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다. 식별·해시 검사·문서 기록과 한 번의 되돌림은 시작·완료 hook이 한다 — 메인은 완료 처리하거나 번호 문서·plan.json을 직접 고치지 않고, 원문이 필요할 때만 그 파일이나 `planning result <ID>`를 읽는다. 질문의 답은 ca-answer로 받은 실제 답뿐이고 보류·상태 메모는 답이 아니다. 같은 명령을 스스로 반복하지 않는다.
4. `next` 줄이 싣는 행동의 요지(다르면 `next` 줄을 따른다): `wait`은 반복 조회 없이 기다리고, 담당 호출이 끝났는데도 `wait`이면 `planning cancel <ID>` 뒤 advance. `cancel` 목록(`stale`)은 이 대화에서 아직 호출하지 않은 배정이면 지금 호출, 호출했던 배정이면 `planning cancel <ID>` 뒤 advance. `rewind-required`는 `rewind.auto`가 true일 때만 사용자 지시 없이 `rewind.command`(`rewind.notice`가 있으면 먼저 알림), false면 되감지 말고 `rewind.reason`·낡은 이유를 보고해 지시를 받는다. `class`가 `same-input-repeat`·`reassign-total`이면 다시 배정하지 말고 사유·한도를 보고한다. 차단 지적(`feedback`)은 계약의 수정 피드백으로 고칠 작업을 다시 배정한다 — `feedback[].citedTask`는 근거 문서를 낸 작업일 뿐이고 고칠 곳은 지적 내용으로 정한다.
4-1. **두 호스트가 설치된 프로젝트**면 critic 완료 뒤 `blocked` 사유에 `교차 검토` 가 나온다 — Bash: `code-agent planning cross --by codex` 로 다른 호스트가 같은 critic 입력을 읽기 전용으로 교차 검토하게 한다(CLI 가 9분에 끊으므로 timeout 600000ms 또는 백그라운드). critic 결과마다 한 번만 기록된다. 차단 지적은 4처럼 고칠 작업을 지적 내용으로 정해 계약의 수정 피드백으로 다시 배정하고(앞 단계 작업이면 원인과 비용을 사용자에게 보고하고 지시를 받는다), 사용자가 지적을 기각하면 공통 동의 절차의 `judgment` `waive-finding` 으로 기록한다. 질문은 ca-answer로 실제 답을 받는다 — 답하면 critic 이 다시 배정되고 교차 검토도 새로 받는다. 출력이 `교차 검증 중지` 면 다른 호스트를 실행할 수 없었던 것이다(미설치·로그인·사용 한도·장애) — 사용자에게 사유를 한 줄 알리고 계속한다. 그 밖의 실패는 출력의 안내만 따르고 같은 명령을 스스로 반복하지 않는다.
5. `ready-for-gate`는 문서 검증이나 승인이 아니다. plan은 관찰된 critic 완료와 차단 지적 해소 후에만 제출한다 — `next` 줄이 제출을 가리키면 아래 끝으로 간다.

## 끝

Bash: `code-agent plan submit <작업 폴더>/plan.json` — 거부되면 사유를 계약의 수정 피드백으로 남겨 plan 작업을 다시 배정한다. 통과하면 코드가 `05-plan.md` 를 렌더한다.

승인 적용 전에는 `code-agent next`를 돌리지 않는다. `{"action":"plan"}`으로 공통 동의 절차를 수행하고 계획·지시서·분석·설계·테스트 명세의 링크를 포함한 `summary` 전문을 보여 준다. 실제 응답 뒤 승인됐으면 적용한다. 성공 후 `code-agent next`로 게이트를 지나 같은 흐름의 구현·검증으로 이어간다. 사용자가 계획 단계만 요청했다면 게이트 통과 결과를 보고한다.
수정 요청·취소·보류이면 적용하지 않는다. 사용자가 명시적으로 계획 반려 기록을 요청했으면 `decision: "reject"`와 실제 사유인 `comment`를 넣은 `plan` 동작도 별도 공통 동의 절차로 처리한다.

승인은 **한 묶음**이다 — 지시서 본문 · `01` · `02` · `03` · `04` · `07` 과 계획. 승인 뒤 이 중 하나라도 고치면 승인이 무효가 되고(`stale-docs`) 코드 쓰기가 멈춘다.
`code-agent back` 으로 `design` 이하로 되감아 문서를 고치는 것도 같다 — 계획을 다시 제출하고 다시 승인받아야 한다.

## 반려됐다면

`code-agent status` 가 `승인 rejected` 로 나오는 자리다. 반려는 다시 내라는 뜻이 아니라 **다시 보라**는 뜻이다:

1. `.code-agent/approvals/<ID>.jsonl` 의 마지막 줄에서 반려 사유(`comment`)를 읽는다.
2. 사유가 가리키는 문서를 다시 본다 — 요구 해석이면 `01-requirements.md`, 영향 범위면 `02-analysis.md`,
   설계·AC 면 `03-design.md`·`04-functional.md`, 테스트면 `07-test-spec.md`, 파일 구성이면 `plan.json`.
   커서를 되감아야 고칠 수 있는 문서면 `code-agent back <스테이지>` 를 쓰고, 그 스테이지의 스킬로 다시 돈다.
3. 사유만으로 정할 수 없는 것이 있으면 새 질문을 `questions.md`에 적고 공통 선택 절차로 답을 받는다. 필요한 답이 없을 때만 멈춘다.
   정할 수 있으면 문서와 계획을 고쳐 `code-agent plan submit` 으로 다시 제출하고, **무엇을 왜 바꿨는지** 함께 보고한다.
   관찰 흐름 작업은 번호 문서·`plan.json`을 메인이 직접 고치지 못한다(hook 거부) — 반려 사유를 계약의 **수정 피드백** 파일로 남기고, 고칠 작업을 사유 내용으로 정해 다시 배정한다. 이 단계 작업이면 바로 배정하고, 앞 단계 작업이면 되감기 전에 원인과 비용(다시 도는 단계·작업)을 사용자에게 보고하고 지시를 받는다. 새 결과와 critic 검토 뒤 다시 제출한다.
4. 재제출 후 새 `plan` 공통 동의 절차로 승인받는다. 사유를 읽지 않고 같은 계획을 다시 내지 않는다.
