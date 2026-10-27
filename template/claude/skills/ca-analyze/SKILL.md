---
name: ca-analyze
description: 요구사항 분석 단계(analysis)를 진행한다 — ① 01-requirements.md 를 쓰고 게이트를 통과한다. 확정된 요구사항이 있고 작업이 없으면 시작부터 한다.
argument-hint: "[<사람이 쓴 지시서 경로>] [--base <기준 브랜치>] [--target <대상>]"
---

**질문·동의** — `.claude/skills/ca-answer/SKILL.md`를 따른다. 이 대화에서 아직 읽지 않았거나 대화가 압축·비워진 뒤라면 그 직전에 읽는다. `AskUserQuestion`을 실제 호출하며 일반 답은 승인이 아니다. 질문·대기는 `.claude/skills/ca-answer/reference.md`의 단계별 선택·차단 복구를 따른다. 적용 뒤 이어간다.

너는 **메인 에이전트**다. 소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서 · `code-agent` 출력 · 서브에이전트 결과로 일한다.
`code-agent` 가 거부하면 차단 복구를 따른다. 우회하지 않는다.

**자리 확인** — 방금 받은 `code-agent` 출력에 지금 스테이지가 없을 때만 Bash: `code-agent status`.

- 진행 중인 작업이 없고 접수한 요구사항이 `확정됨` 이면 Bash: `code-agent start doc/work/<ID>/requirement.md $ARGUMENTS`
  — 기준 브랜치는 사용자가 말했을 때만 `--base` 로 넘긴다.
  사용자가 **손으로 쓴 지시서**의 경로를 인자로 줬으면 확정 상태부터 확인한다. 확정 전이면 `{"action":"request","id":"<ID>","spec":"<지시서 경로>"}`로 공통 동의 절차를 수행하고 승인된 동의 적용 뒤 Bash: `code-agent start $ARGUMENTS`로 시작한다.
  접수도 지시서도 없으면 `/ca-request`(또는 종류별 접수)로 연결한다. 접수된 요구사항이 아직 확정 전이면 `/ca-request`의 제출·동의 절차로 이어가며, 취소·보류·필수 응답 누락에서는 시작하지 않는다.
- 스테이지가 `analysis`가 아니면 아래 공통 진행·되감기 기준을 따른다.

## 관찰된 계획 작업

`code-agent status`에 관찰 흐름이 표시된 작업의 절차다. 표시가 없는 이전 버전 작업은 `.claude/skills/ca-analyze/legacy.md`를 읽고 따른다.

아래 명령 전에 `.claude/skills/ca-plan/contract.md`의 **공통 진행·되감기**를 읽고 따른다. 출력 이후의 배정·대기·완료·게이트 판정은 그 절이 정본이다.

1. Bash: `code-agent planning advance --chain` — 준비·결과 재사용·선행 조건·배정을 한 번에 하고, 결과가 모두 준비됐으면 같은 호출에서 게이트(`code-agent next`)까지 지난다(다음 단계 배정은 하지 않는다). 이 단계만 요청받았으면 `--chain`을 뺀다. 이 단계 역할은 **analysis**다. 영역 분할을 지정할 때만 먼저 `planning prepare <작업.json>`을 쓴다(형식은 `.claude/skills/ca-plan/contract.md`).

## 끝

Bash: `code-agent next` — 거부되면 차단 복구를 따른다.
통과하면 쓴 문서를 짧게 보고한다. 전체 작업 흐름에서는 `/ca-impact` 절차로 자동으로 이어가고, 분석 단계만 요청받았으면 여기서 마친다.
