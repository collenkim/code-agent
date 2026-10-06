# 이전 버전 작업의 분석 절차

`code-agent status`에 관찰 흐름이 표시되지 않는, 이전 버전에서 시작한 작업에만 쓴다. 자리 확인과 끝은 SKILL.md를 따른다.

1. Bash: `code-agent context` — 지시서·공통 문서·작업 폴더 경로와 형식이 나온다.
2. Bash: `code-agent docs skeleton 01-requirements`
3. `ca-analyst` 서브에이전트를 부른다. context 출력과 뼈대를 그대로 넘기고 `.claude/skills/ca-analyze/criteria.md` 경로를 함께 준다.
4. 결과를 뼈대의 형식대로 작업 폴더의 `01-requirements.md` 에 쓴다. 기준은 `.claude/skills/ca-analyze/criteria.md`다.
   형식이 틀리면 `code-agent next` 가 무엇이 틀렸는지 알려 준다.
5. 질문 후보가 있으면 `questions.md`에 전체 선택지·추천 이유를 덧붙이고 `[Answer]:`는 비워 둔다.
   공통 선택 절차로 즉시 `AskUserQuestion`을 호출한다. 답을 기록하고 요구·가정에 반영한 뒤 SKILL.md의 끝으로 이어간다. 필요한 답이 없으면 멈춘다.
