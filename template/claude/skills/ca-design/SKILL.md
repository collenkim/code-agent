---
name: ca-design
description: 설계·정의 단계(design)를 진행한다 — ③ 03-design.md 와 ④ 04-functional.md 를 쓰고 게이트를 통과한다.
---

**질문·동의** — `.claude/skills/ca-answer/SKILL.md`를 따른다. 이 대화에서 아직 읽지 않았거나 대화가 압축·비워진 뒤라면 그 직전에 읽는다. `AskUserQuestion`을 실제 호출하며 일반 답은 승인이 아니다. 질문·대기는 `.claude/skills/ca-answer/reference.md`의 단계별 선택·차단 복구를 따른다. 적용 뒤 이어간다.

너는 **메인 에이전트**다. 소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서 · `code-agent` 출력 · 서브에이전트 결과로 일한다.
`code-agent` 가 거부하면 차단 복구를 따른다.

**자리 확인** — 방금 받은 `code-agent` 출력에 지금 스테이지가 없을 때만 Bash: `code-agent status`. 스테이지가 `design` 이 아니면 차단 복구로 현재 단계의 재개 방향을 정한다.

## 관찰된 계획 작업

`code-agent status`에 관찰 흐름이 표시된 작업의 절차다. 표시가 없는 이전 버전 작업은 `.claude/skills/ca-design/legacy.md`를 읽고 따른다.

아래 명령 전에 `.claude/skills/ca-plan/contract.md`의 **공통 진행·되감기**를 읽고 따른다. 출력 이후의 배정·대기·완료·게이트 판정은 그 절이 정본이다.

1. Bash: `code-agent planning advance --chain` — 준비·결과 재사용·선행 조건·배정을 한 번에 하고, 결과가 모두 준비됐으면 같은 호출에서 게이트(`code-agent next`)까지 지난다(다음 단계 배정은 하지 않는다). 이 단계만 요청받았으면 `--chain`을 뺀다. 이 단계 역할은 **design**다. 영역 분할을 지정할 때만 먼저 `planning prepare <작업.json>`을 쓴다(형식은 `.claude/skills/ca-plan/contract.md`).

## 끝

Bash: `code-agent next` — AC 가 없는 R 이 있거나 필수 섹션이 비면 넘어가지 않는다. 거부되면 차단 복구를 따른다.
통과하면 쓴 문서를 짧게 보고한다. 전체 작업 흐름에서는 `/ca-plan` 절차로 자동으로 이어가고, 설계 단계만 요청받았으면 여기서 마친다.
