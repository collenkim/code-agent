---
name: ca-design
description: 설계·정의 단계(design)를 진행한다 — ③ 03-design.md 와 ④ 04-functional.md 를 쓰고 게이트를 통과한다.
---

**질문·동의** — `.claude/skills/ca-answer/SKILL.md`를 따른다. 이 대화에서 아직 읽지 않았거나 대화가 압축·비워진 뒤라면 그 직전에 읽는다. `AskUserQuestion`을 실제 호출하며 일반 답은 승인이 아니다. 질문·대기는 `.claude/skills/ca-answer/reference.md`의 단계별 선택·차단 복구를 따른다. 적용 뒤 이어간다.

너는 **메인 에이전트**다. 소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서 · `code-agent` 출력 · 서브에이전트 결과로 일한다.
`code-agent` 가 거부하면 차단 복구를 따른다.

**자리 확인** — 방금 받은 `code-agent` 출력에 지금 스테이지가 없을 때만 Bash: `code-agent status`. 스테이지가 `design` 이 아니면 차단 복구로 현재 단계의 재개 방향을 정한다.
아직 이르면 status 의 `다음:` 줄이 가리키는 명령을 먼저 하라고 전하고, 이미 지났으면 `code-agent back design` 으로
되감아야 한다고 전한다 — 무엇이 무효가 되는지는 그 명령이 찍는다. **되감기는 사용자가 되돌리라고 말했을 때만** 돌린다 — 승인 무효로 status 의 `다음:` 이 되감기를 안내할 때와 `planning advance` 가 자동 되감기(`rewind-required`, `rewind.auto: true`)를 낼 때는 예외다.

## 관찰된 계획 작업

`code-agent status`에 관찰 흐름이 표시된 작업의 절차다. 표시가 없는 이전 버전 작업은 `.claude/skills/ca-design/legacy.md`를 읽고 따른다.

1. Bash: `code-agent planning advance --chain` — 준비·결과 재사용·선행 조건·배정을 한 번에 하고, 결과가 모두 준비됐으면 같은 호출에서 게이트(`code-agent next`)까지 지난다(다음 단계 배정은 하지 않는다). 이 단계만 요청받았으면 `--chain`을 뺀다. 이 단계 역할은 **design**다. 영역 분할을 지정할 때만 먼저 `planning prepare <작업.json>`을 쓴다(형식은 `.claude/skills/ca-plan/contract.md`).
2. 이후는 출력의 `next` 줄(action별 다음 행동)을 따르고 그 줄의 명령은 **글자 그대로** 쓴다. `action:dispatch`이면 `assignments`마다 `agent` 서브에이전트를 호출하고(형식만 고치는 교정 배정 `mode:correction`도 같다), 프롬프트에는 **`assignmentFile` 경로와 "이 파일을 읽고 그 계약대로 결과 JSON 하나를 반환하라"**만 쓴다 — 배정·문서 기준·뼈대·context·staging 경로는 그 파일에 있다. Agent 도구는 `run_in_background: false` 로 부른다(결과를 받아야 다음 단계로 간다). 재배정이면 직전 실패·게이트 거부 사유처럼 파일에 없는 메모만 2~3줄 덧붙인다.
3. 담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다. 식별·해시 검사·문서 기록과 한 번의 되돌림은 시작·완료 hook이 한다 — 메인은 완료 처리하거나 번호 문서·plan.json을 직접 고치지 않고, 원문이 필요할 때만 그 파일이나 `planning result <ID>`를 읽는다. 질문의 답은 ca-answer로 받은 실제 답뿐이고 보류·상태 메모는 답이 아니다. 같은 명령을 스스로 반복하지 않는다.
4. `next` 줄이 싣는 행동의 요지는 그 줄이 원천이다 — 대기·`cancel` 목록·되감기(`rewind.auto`)·재배정 한도·차단 지적(`feedback`)마다 그 줄의 행동만 하고 덧붙이지 않는다. 줄이 사용자 보고·지시를 요구하면 보고하고 기다린다.
5. `ready-for-gate`는 문서 검증이나 승인이 아니다 — `next` 줄대로 끝으로 간다. `chain.gate`가 `passed`면 게이트는 이미 지났고 지금 스테이지는 `chain.to`다(최상위 `phase`는 advance 를 돌린 단계).

## 끝

Bash: `code-agent next` — AC 가 없는 R 이 있거나 필수 섹션이 비면 넘어가지 않는다. 거부되면 차단 복구를 따른다.
통과하면 쓴 문서를 짧게 보고한다. 전체 작업 흐름에서는 `/ca-plan` 절차로 자동으로 이어가고, 설계 단계만 요청받았으면 여기서 마친다.
