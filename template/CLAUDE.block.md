## code-agent — 이 저장소의 코드 작업 절차

모든 코드 작업은 `/ca-request [ID] <요구사항>`으로 **공통 접수**한다(종류를 밝힐 때는 신규·기능 변경 `/ca-feature`, 결함 수정 `/ca-fix`, 동작 보존 구조 개선 `/ca-refactor`). 중단된 흐름은 `/ca-next`로 재개하고, 한 단계만 돌릴 때는 단계 명령(`/ca-analyze` · `/ca-impact` · `/ca-design` · `/ca-plan` · `/ca-implement` · `/ca-check` · `/ca-test` · `/ca-review` · `/ca-integrate`)을 부른다. 절차는 각 단계 스킬에 있다. 위치는 `code-agent status`, 되감기는 `code-agent back <스테이지>`(앞으로는 못 간다). `code-agent init`은 설치만 하고, 진행은 이 대화의 메인이 서브에이전트를 불러 맡는다.

- 진행 중인 작업이 있으면 **승인된 계획의 파일만** 쓴다. hook 이 거부하면 사유를 그대로 보고하고 우회하지 않는다. Bash 는 명령을 하나씩 실행한다 — `&&` · `;` · `|` · 리다이렉트로 잇는 명령은 거부된다.
- 코드가 렌더하는 문서(`requirement.md` · `05-plan.md` · `08-validation.md` · `10-pr.md` 의 `code-agent:trace` 블록)와 `.code-agent/`는 code-agent 명령으로만 바뀐다. 고칠 것이 있으면 원본(`request.json` · `plan.json`)을 고쳐 다시 제출한다.
- 검증 결과는 `code-agent check` · `test` · `verify` · `integrate` 가 기록한 것만 유효하다 — 직접 돌린 빌드·테스트는 게이트를 열지 못한다.
- 업무 규칙·범위·권한·데이터의 의미처럼 사람이 정할 것은 지어내지 않고 질문한다. 질문과 승인·확정·반영은 `.claude/skills/ca-answer/SKILL.md`를 따른다 — `AskUserQuestion`의 실제 응답과 hook 이 관찰한 같은 세션 동의만 유효하고, 메인이 답·승인 기록을 만들지 않는다. 사용자가 code-agent 업데이트를 요청하면 같은 절차의 `update` 동의를 쓴다. 비밀값은 질문·요약·JSON·명령 인자에 넣지 않는다.
- 대화가 압축되거나 비워져도(`/clear`) 상태는 `.code-agent/`와 작업 폴더에 남는다 — 시작 hook 이 붙이는 진행 상태를 보고 `/ca-next`로 이어간다.
- 보고·질문·요약과 생성 문서의 설명문은 **사용자가 쓰는 언어로** 한다 — 요청이 명령뿐이라 알 수 없으면 작업 지시서·questions.md가 쓰인 언어로. 서브에이전트 결과나 명령 출력이 다른 언어여도 그 언어로 옮겨 전한다. 코드 식별자·경로·도구명·보관해야 하는 원문은 그대로 두며, 관련 없는 외국어 문장이나 깨진 문자를 설명문에 섞지 않는다.
