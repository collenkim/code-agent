# 이전 버전 작업의 계획 작성 절차

`code-agent status`에 관찰 흐름이 표시되지 않는, 이전 버전에서 시작한 작업에만 쓴다. 자리 확인·끝·반려는 SKILL.md를 따른다. 문서 기준은 `.claude/skills/ca-plan/criteria.md`다.

1. Bash: `code-agent context` — 계획 형식과 단계 key·위치가 나온다.
2. `01`~`04` · explorer 결과로 계획 초안을 작업 폴더의 `plan.json` 에 쓴다. 기준은 criteria.md의 plan.json 절이다.
   `fix` 테스트 자리는 `code-agent context` 가 찍어 준다. refactor에서 고쳐야 할 기존 테스트가 보이면 `questions.md` 로 묻는다.
3. Bash: `code-agent docs skeleton 07-test-spec` — `07-test-spec.md` 를 **구현 전에** 쓴다. 기준은 criteria.md의 07 절이다.
4. `ca-critic` 에게 초안, `01`~`04`, `07-test-spec.md`, 아키텍처·컨벤션·테스트 전략 경로, context 의 참조 표준 파일, 원문 지시서와 원문 대조 표, criteria.md 경로를 넘겨 반박 검토를 받는다.
   타당한 지적은 반영하고, 사람이 정할 것은 `questions.md` 로.
5. Bash: `code-agent plan submit <작업 폴더>/plan.json` — 거부되면 사유대로 고쳐 다시 제출한다.
   통과하면 코드가 `05-plan.md` 를 렌더한다. **그 파일은 손대지 않는다.** 이어서 SKILL.md의 끝(승인 동의)으로 간다.
