# 이전 버전 작업의 설계 절차

`code-agent status`에 관찰 흐름이 표시되지 않는, 이전 버전에서 시작한 작업에만 쓴다. 자리 확인과 끝은 SKILL.md를 따른다. 문서 기준은 `.claude/skills/ca-design/criteria.md`다.

1. Bash: `code-agent context` — **관련 후보 파일 순위**와 **참고 문서 섹션**이 함께 나온다. 컨벤션·KNOWLEDGE 를 전문으로 읽지 말고 그 절부터 본다.
2. Bash: `code-agent docs skeleton 03-design` · `code-agent docs skeleton 04-functional`
3. `ca-analyst` 에게 뼈대 + `01`·`02` + 아키텍처·컨벤션 경로 + `context` 가 짚은 문서 섹션 + KNOWLEDGE 인용 + criteria.md 경로를 넘겨 설계 판단과 두 문서의 완성 본문을 요청한다. 메인이 반환된 본문을 두 파일에 기록한다.
4. 빈칸(`확인 필요`)은 업무 규칙·범위·권한이면 `questions.md`에 기록하고 공통 선택 절차로 답을 받는다(필수 답이 없으면 멈춘다). 기본값을 댈 수 있는 기술 세부면
   `01-requirements.md` 의 `## 가정` 으로 돌리고 문서에도 반영한다.
