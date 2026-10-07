---
name: ca-analyze
description: 요구사항 분석 단계(analysis)를 진행한다 — ① 01-requirements.md 를 쓰고 게이트를 통과한다. 확정된 요구사항이 있고 작업이 없으면 시작부터 한다.
argument-hint: [<사람이 쓴 지시서 경로>] [--base <기준 브랜치>] [--target <대상>]
---

**질문·동의** — 사람에게 묻거나 승인·확정·반영을 받기 직전에 `.claude/skills/ca-answer/SKILL.md`를 읽고 그 절차(`AskUserQuestion`·같은 세션 동의)를 따른다. 일반 답변은 승인이 아니며, 적용 뒤에는 이 흐름을 자동으로 이어간다.

너는 **메인 에이전트**다. 소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서 · `code-agent` 출력 · 서브에이전트 결과로 일한다.
`code-agent` 가 거부하면 **사유를 그대로 전하고 멈춘다.** 우회하지 않는다.

**자리 확인** — Bash: `code-agent status`.

- 진행 중인 작업이 없고 접수한 요구사항이 `확정됨` 이면 Bash: `code-agent start doc/work/<ID>/requirement.md $ARGUMENTS`
  — 기준 브랜치는 사용자가 말했을 때만 `--base` 로 넘긴다.
  사용자가 **손으로 쓴 지시서**의 경로를 인자로 줬으면 확정 상태부터 확인한다. 확정 전이면 `{"action":"request","id":"<ID>","spec":"<지시서 경로>"}`로 공통 동의 절차를 수행하고 승인된 동의 적용 뒤 Bash: `code-agent start $ARGUMENTS`로 시작한다.
  접수도 지시서도 없으면 `/ca-request`(또는 종류별 접수)로 연결한다. 접수된 요구사항이 아직 확정 전이면 `/ca-request`의 제출·동의 절차로 이어가며, 취소·보류·필수 응답 누락에서는 시작하지 않는다.
- 스테이지가 `analysis` 가 아니면 **멈춘다.** 아직 이르면 status 의 `다음:` 줄이 가리키는 명령을 먼저 하라고 전하고,
  이미 지났으면 `code-agent back analysis` 로 되감아야 한다고 전한다 — 무엇이 무효가 되는지는 그 명령이 찍는다.
  **되감기는 사용자가 되돌리라고 말했을 때만** 돌린다.

## 관찰된 계획 작업

`code-agent status`에 관찰 흐름이 표시된 작업의 절차다. 표시가 없는 이전 버전 작업은 `.claude/skills/ca-analyze/legacy.md`를 읽고 따른다.

1. Bash: `code-agent planning advance` — 준비·결과 재사용·선행 조건·배정을 한 번에 한다. 이 단계 역할은 **analysis**다. 영역 분할을 지정할 때만 먼저 `planning prepare <작업.json>`을 쓴다(형식은 `.claude/skills/ca-plan/contract.md`).
2. `action:dispatch`이면 `assignments`마다 `agent` 서브에이전트를 호출한다. 프롬프트에는 **`assignmentFile` 경로와 "이 파일을 읽고 그 계약대로 결과 JSON 하나를 반환하라"**를 쓴다. 배정·문서 기준·뼈대·단계 context·staging 경로는 그 파일에 있으므로 옮겨 쓰지 않는다. 재배정이면 직전 실패·게이트 거부 사유처럼 파일에 없는 작업별 메모만 2~3줄 덧붙인다. 여러 배정은 한 메시지에서 함께 호출한다.
3. 담당은 출력 문서를 staging에 쓰고 결과 JSON에는 경로만 넣는다. 시작·완료 hook이 배정 식별자·입력 해시를 검사하고 지정 문서를 기록한다. 메인은 완료 처리하거나 번호 문서·plan.json을 직접 고치지 않는다. 원문이 필요할 때만 그 파일이나 `planning result <ID>`를 읽는다.
4. 완료 알림을 받으면 `planning advance`를 다시 실행한다. `wait`이면 상태를 반복 조회하지 말고 완료를 기다린다 — 그 작업의 담당 호출이 이미 끝났는데도 `wait`이면 결과가 기록되지 않은 것이니 `planning cancel <ID>` 뒤 advance 한다. 출력에 `cancel` 목록이 있으면(`stale` — 담당 시작이 관찰되지 않았거나 너무 오래 걸린 배정) 기다리지 않는다. 이 대화에서 아직 호출하지 않은 배정이면 지금 호출하고, 호출했던 배정이면 그 ID마다 `planning cancel <ID>`를 실행한 뒤 advance 한다. `rewind-required`이면 앞 단계 계획 작업이 낡은 것이다. `rewind.auto`가 true면 사용자 지시 없이 `rewind.command`를 실행하고 그 단계 스킬로 이어간다(`rewind.notice`가 있으면 그 한 줄을 먼저 사용자에게 알린다). false면 되감지 말고 `rewind.reason`과 낡은 이유를 사용자에게 보고해 지시를 받는다. `blocked`이면 사유를 해결한다 — 미결 질문은 ca-answer로 실제 답을 받고, 입력 변경·근거 오류는 원인을 고친다. 보류·상태 메모는 답이 아니다. `class`가 `same-input-repeat`·`reassign-total`이면 다시 배정하지 말고 사유와 한도를 사용자에게 보고한다.
5. hook이 형식 오류와 교정 안내를 반환하면 취소·전체 재실행 대신 `planning advance` 또는 `planning repair <ID>`가 주는 `mode:correction` 배정을 2처럼 새 담당에게 넘겨 **형식만 한 번** 교정한다. 새 판단이 필요하면 담당이 failed로 반환한다. 식별자가 확인되지 않는 결과는 자동 교정하지 않는다. 완료 hook은 형식·식별·문서 검사 실패를 같은 담당에게 한 번 돌려보낼 수 있다(호스트가 지원할 때) — 메인이 할 일은 없다. 내용 검사로 `failed`가 되면 사유를 계약의 수정 피드백으로 남겨 재배정한다.
6. `ready-for-gate`이면 아래 끝으로 간다 — 이 응답은 문서 검증이나 승인이 아니다. 같은 입력의 실패는 3회, 작업마다 배정은 총 6회, 형식 교정은 배정마다 1회까지다 — 횟수는 CLI가 센다.

## 끝

Bash: `code-agent next` — 거부되면 사유를 그대로 전하고 멈춘다.
통과하면 쓴 문서를 짧게 보고한다. 전체 작업 흐름에서는 `/ca-impact` 절차로 자동으로 이어가고, 분석 단계만 요청받았으면 여기서 마친다.
