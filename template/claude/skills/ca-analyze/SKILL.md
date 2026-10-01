---
name: ca-analyze
description: 요구사항 분석 단계(analysis)만 돈다 — ① 01-requirements.md 를 쓰고 게이트를 지난 뒤 멈춘다. 확정된 요구사항이 있고 작업이 없으면 시작부터 한다.
argument-hint: [<사람이 쓴 지시서 경로>] [--base <기준 브랜치>] [--target <대상>]
---

너는 **메인 에이전트**다. 소스 코드는 서브에이전트가 읽는다 — 메인은 작업 폴더 문서 · `code-agent` 출력 · 서브에이전트 결과로 일한다.
`code-agent` 가 거부하면 **사유를 그대로 전하고 멈춘다.** 우회하지 않는다. 사람에게 물을 것은 턴의 마지막 메시지에 모아서 낸다.

**자리 확인** — Bash: `code-agent status`.

- 진행 중인 작업이 없고 접수한 요구사항이 `확정됨` 이면 Bash: `code-agent start doc/work/<ID>/requirement.md $ARGUMENTS`
  — 기준 브랜치는 사용자가 말했을 때만 `--base` 로 넘긴다.
  사용자가 **손으로 쓴 지시서**의 경로를 인자로 줬으면 Bash: `code-agent start $ARGUMENTS` — 확정됐는지는 `start` 가 본다 (안 됐으면 확정 명령을 찍고 거부한다).
  접수도 지시서도 없거나 아직 확정 전이면 **멈춘다** — 접수는 `/ca-request` (또는 `/ca-feature` · `/ca-fix` · `/ca-refactor`), 확정은 별도 터미널의 `code-agent confirm request <ID> [<지시서>]`.
- 스테이지가 `analysis` 가 아니면 **멈춘다.** 아직 이르면 status 의 `다음:` 줄이 가리키는 명령을 먼저 하라고 전하고,
  이미 지났으면 `code-agent back analysis` 로 되감아야 한다고 전한다 — 무엇이 무효가 되는지는 그 명령이 찍는다.
  **되감기는 사용자가 되돌리라고 말했을 때만** 돌린다.

## 하는 일 — ① `01-requirements.md`

1. Bash: `code-agent context` — 지시서·공통 문서·작업 폴더 경로와 형식이 나온다.
2. Bash: `code-agent docs skeleton 01-requirements`
3. `ca-analyst` 서브에이전트를 부른다. context 출력과 뼈대를 그대로 넘긴다.
4. 결과를 뼈대의 형식대로 작업 폴더의 `01-requirements.md` 에 쓴다.
   - `## R1 · <요구 한 줄>` 블록마다 `근거: "<지시서 문장 그대로>"` 한 줄 **필수**. 번호는 중복 없이 이어 붙인다.
   - `출처: REQ-1, DONE-1`처럼 context의 출처 ID를 연결한다. 인용은 해당 항목 원문 그대로 쓰며 여러 문장이면 `근거:` 줄을 여러 개 쓸 수 있다.
     모든 접수 요구·완료 조건·제약이 R에 연결돼야 한다. 누락·빈 인용·원문에 없는 인용은 다음 단계에서 거부된다.
   - `## 가정` — 질문하지 않고 기본값으로 정한 기술 세부 + 근거. 없으면 `- 없음`. **섹션 자체는 반드시 있어야 한다.**
   - `## 범위 밖` — 눈에 띄었지만 이번에 하지 않는 것과 근거 (선택).
   형식이 틀리면 `code-agent next` 가 무엇이 틀렸는지 알려 준다.
5. 질문 후보가 있으면 `questions.md` 에 덧붙인다 (선택지와 `X. 기타:` 포함, `[Answer]:` 는 비워 둔다).
   질문이 있으면 사용자에게 보여 주고 **멈춘다** — "`/ca-answer` 로 답해 주세요".

## 끝

Bash: `code-agent next` — 거부되면 사유를 그대로 전하고 멈춘다.
통과하면 쓴 문서를 짧게 보고하고 **멈춘다**: "다음: `/ca-impact` (또는 `/ca-next` 로 사이클)".
