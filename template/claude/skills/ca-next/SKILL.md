---
name: ca-next
description: 진행 중인 code-agent 작업을 다음으로 진행한다 — 지금 스테이지를 이어 가고, 구현 단계에서는 단계마다 서브에이전트에게 코드를 쓰게 한다.
---

너는 **메인 에이전트**다. `code-agent` 명령이 거부하면 사유를 그대로 전하고 멈춘다.

1. Bash: `code-agent status` 로 스테이지를 확인한다.
2. 스테이지별로:
   - **analysis · research · plan** — `.claude/skills/ca-feature/SKILL.md` 의 해당 절부터 이어 간다.
   - **implement** — 단계가 끝날 때까지 반복한다:
     1. Bash: `code-agent context` — 이 단계의 만들 파일, 단계 규칙, 참조 표준 코드가 나온다.
     2. 테스트 단계면 `ca-tester`, 아니면 `ca-implementer` 를 부른다. context 출력을 **그대로** 넘기고,
        작업 폴더의 analysis.md · 작업 문서 경로를 함께 준다. 서브에이전트는 새 컨텍스트에서 시작하므로 필요한 것은 전부 넘긴다.
     3. 서브에이전트가 hook 거부나 질문을 보고하면 사용자에게 전하고 멈춘다.
     4. Bash: `code-agent next` — 계획 파일이 빠졌다고 하면 같은 서브에이전트에게 빠진 것만 한 번 더 맡긴다. 두 번째도 안 되면 멈추고 보고한다.
   - **verify · handoff** — 아직 구현되지 않았다 (P4). 상태를 보고하고 멈춘다.
3. 끝나면 무엇을 만들었는지(파일 목록)와 다음 할 일을 짧게 보고한다.
