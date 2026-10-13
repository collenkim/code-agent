---
name: ca-analyze
description: 요구사항 분석 단계(analysis)를 진행한다 — ① 01-requirements.md 를 쓰고 게이트를 통과한다. 확정된 요구사항이 있고 작업이 없으면 시작부터 한다.
argument-hint: [<사람이 쓴 지시서 경로>] [--base <기준 브랜치>] [--target <대상>]
---

**질문·동의** — `.claude/skills/ca-answer/SKILL.md`를 따른다. 이 대화에서 아직 읽지 않았거나 대화가 압축·비워진 뒤라면 그 직전에 읽는다. `AskUserQuestion`을 실제 호출하며 일반 답은 승인이 아니다. 질문·대기는 `.claude/skills/ca-answer/reference.md`의 단계별 선택·차단 복구를 따른다. 적용 뒤 이어간다.

너는 **메인 에이전트**다. 소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서 · `code-agent` 출력 · 서브에이전트 결과로 일한다.
`code-agent` 가 거부하면 차단 복구를 따른다. 우회하지 않는다.

**자리 확인** — 방금 받은 `code-agent` 출력에 지금 스테이지가 없을 때만 Bash: `code-agent status`.

- 진행 중인 작업이 없고 접수한 요구사항이 `확정됨` 이면 Bash: `code-agent start doc/work/<ID>/requirement.md $ARGUMENTS`
  — 기준 브랜치는 사용자가 말했을 때만 `--base` 로 넘긴다.
  사용자가 **손으로 쓴 지시서**의 경로를 인자로 줬으면 확정 상태부터 확인한다. 확정 전이면 `{"action":"request","id":"<ID>","spec":"<지시서 경로>"}`로 공통 동의 절차를 수행하고 승인된 동의 적용 뒤 Bash: `code-agent start $ARGUMENTS`로 시작한다.
  접수도 지시서도 없으면 `/ca-request`(또는 종류별 접수)로 연결한다. 접수된 요구사항이 아직 확정 전이면 `/ca-request`의 제출·동의 절차로 이어가며, 취소·보류·필수 응답 누락에서는 시작하지 않는다.
- 스테이지가 `analysis` 가 아니면 차단 복구로 현재 단계의 재개 방향을 정한다. 아직 이르면 status 의 `다음:` 줄이 가리키는 명령을 먼저 하라고 전하고,
  이미 지났으면 `code-agent back analysis` 로 되감아야 한다고 전한다 — 무엇이 무효가 되는지는 그 명령이 찍는다.
  **되감기는 사용자가 되돌리라고 말했을 때만** 돌린다 — 승인 무효로 status 의 `다음:` 이 되감기를 안내할 때는 예외다.

## 관찰된 계획 작업

`code-agent status`에 관찰 흐름이 표시된 작업의 절차다. 표시가 없는 이전 버전 작업은 `.claude/skills/ca-analyze/legacy.md`를 읽고 따른다.

1. Bash: `code-agent planning advance --chain` — 준비·결과 재사용·선행 조건·배정을 한 번에 하고, 결과가 모두 준비됐으면 같은 호출에서 게이트(`code-agent next`)까지 지난다(다음 단계 배정은 하지 않는다). 이 단계만 요청받았으면 `--chain`을 뺀다. 이 단계 역할은 **analysis**다. 영역 분할을 지정할 때만 먼저 `planning prepare <작업.json>`을 쓴다(형식은 `.claude/skills/ca-plan/contract.md`).
2. 이후는 출력의 `next` 줄(action별 다음 행동)을 따르고 그 줄의 명령은 **글자 그대로** 쓴다. `action:dispatch`이면 `assignments`마다 `agent` 서브에이전트를 호출하고(형식만 고치는 교정 배정 `mode:correction`도 같다), 프롬프트에는 **`assignmentFile` 경로와 "이 파일을 읽고 그 계약대로 결과 JSON 하나를 반환하라"**만 쓴다 — 배정·문서 기준·뼈대·context·staging 경로는 그 파일에 있다. Agent 도구는 `run_in_background: false` 로 부른다(결과를 받아야 다음 단계로 간다). 재배정이면 직전 실패·게이트 거부 사유처럼 파일에 없는 메모만 2~3줄 덧붙인다.
3. 담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다. 식별·해시 검사·문서 기록과 한 번의 되돌림은 시작·완료 hook이 한다 — 메인은 완료 처리하거나 번호 문서·plan.json을 직접 고치지 않고, 원문이 필요할 때만 그 파일이나 `planning result <ID>`를 읽는다. 질문의 답은 ca-answer로 받은 실제 답뿐이고 보류·상태 메모는 답이 아니다. 같은 명령을 스스로 반복하지 않는다.
4. `next` 줄이 싣는 행동의 요지(다르면 `next` 줄을 따른다): `wait`은 반복 조회 없이 기다리고, 담당 호출이 끝났는데도 `wait`이면 `planning cancel <ID>` 뒤 advance. `cancel` 목록(`stale`)은 이 대화에서 아직 호출하지 않은 배정이면 지금 호출, 호출했던 배정이면 `planning cancel <ID>` 뒤 advance. `rewind-required`는 `rewind.auto`가 true일 때만 사용자 지시 없이 `rewind.command`(`rewind.notice`가 있으면 먼저 알림), false면 되감지 말고 `rewind.reason`·낡은 이유를 보고해 지시를 받는다. `class`가 `same-input-repeat`·`reassign-total`이면 다시 배정하지 말고 사유·한도를 보고한다. 차단 지적(`feedback`)은 계약의 수정 피드백으로 고칠 작업을 다시 배정한다 — `feedback[].citedTask`는 근거 문서를 낸 작업일 뿐이고 고칠 곳은 지적 내용으로 정한다.
5. `ready-for-gate`는 문서 검증이나 승인이 아니다. `next` 줄이 게이트를 가리키면 아래 끝으로 간다(답 없는 질문으로 거부될 때의 처리도 그 줄에 있다). 출력의 `chain.gate`가 `passed`면 끝의 `code-agent next`는 이미 지났고 지금 스테이지는 `chain.to`다(최상위 `phase`는 advance 를 돌린 단계) — 쓴 문서를 짧게 보고하고 `next` 줄대로 잇는다.

## 끝

Bash: `code-agent next` — 거부되면 차단 복구를 따른다.
통과하면 쓴 문서를 짧게 보고한다. 전체 작업 흐름에서는 `/ca-impact` 절차로 자동으로 이어가고, 분석 단계만 요청받았으면 여기서 마친다.
