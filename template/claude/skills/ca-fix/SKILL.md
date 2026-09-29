---
name: ca-fix
description: 결함 지시서로 버그 수정을 시작한다 — 현행 분석과 재현 테스트를 앞세워 계획 제출까지 진행한다.
argument-hint: <지시서 경로> [--base <기준 브랜치>] [--target <대상>]
---

`.claude/skills/ca-feature/SKILL.md` 의 절차를 그대로 따른다 — 같은 단계 스킬을 같은 순서로 돈다. 다른 점만:

- **영향도 (`/ca-impact`)**: `02-analysis.md` 의 `기존 시스템 분석` 은 **결함이 나는 경로까지** 적는다 — 증상이 어느 코드 경로에서 나는지, 근거 `path:line` 과 함께.
- **테스트 명세 (`/ca-plan`)**: `07-test-spec.md` 의 첫 TC 는 **결함을 재현하는 케이스**다 — 지금 코드에서 실패하는 것을 먼저 본다.
- **계획 (`/ca-plan`)**: `sequence[]` 의 첫 자리는 그 재현 테스트다. 고칠 파일은 지시서의 scope 안에서만, 보존 조건(preserve)은 문장 그대로 옮긴다.
- 원인을 확신할 수 없으면 추정으로 계획하지 않고 `questions.md` 에 가설과 확인 방법을 질문으로 남긴다.
