## code-agent — 이 저장소의 코드 작업 절차

모든 코드 작업은 `/ca-request [ID] <요구사항>`으로 **공통 접수**한다. 종류를 명시해 시작할 때는 신규 개발·기능 추가·기능 변경은 `/ca-feature`, 결함 수정은 `/ca-fix`, 동작 보존 구조 개선은 `/ca-refactor`를 쓸 수 있다. 세 명령도 같은 접수 절차를 사용한다. 같은 세션에서 사용자가 요구사항에 동의하고 메인이 적용하면 분석부터 반영까지 이어간다. `/ca-next`는 중단된 흐름을 재개할 때만 쓰며 승인 뒤 재입력을 요구하지 않는다. 한 단계만 요청하려면 **단계 명령**(`/ca-analyze` · `/ca-impact` · `/ca-design` · `/ca-plan` · `/ca-implement` · `/ca-check` · `/ca-test` · `/ca-review` · `/ca-integrate`)을 부른다. 절차는 단계 스킬 하나에만 있어 어느 쪽으로 가도 같다. 지금 위치는 `code-agent status`, 이전 스테이지로 되감기는 `code-agent back <스테이지>` (앞으로는 못 간다).

`code-agent init`은 이 프로젝트의 스킬·서브에이전트·hook을 설치하는 명령이다. 실제 진행은 이 프로젝트에서 실행한 Claude Code의 메인 대화가 맡고 필요한 서브에이전트를 호출한다. 별도 서버나 수동 에이전트 등록 절차는 없다.

- ID는 생략할 수 있다. CLI가 WORK 번호를 발급한다. 접수한 원문을 저장한 뒤 공통 문서·설정을 먼저 점검하고, 없으면 `/ca-adopt`·`/ca-docs`로 준비한다. 신규는 용도별 추천 구성, 기존은 설정 재사용이 기본이다. 최초 `setup` 동의는 POLICY 전체 확정(`confirm doc all`)과 기준 커밋이 없을 때의 생성(`setup baseline`)을 사용자 질문 하나로 묶는다.
- 진행 중인 작업이 있으면 **승인된 계획의 파일만** 쓴다. `sequence`가 Task와 실제 구현 순서를 정한다. 계획 밖 쓰기·Bash 우회는 hook 이 거부한다 — 거부되면 사유를 그대로 보고하고 우회하지 않는다.
- 확정 요구·완료 조건·제약을 분석 R의 출처와 원문 인용에 연결한다. 모든 R은 계획 Task의 파일과 AC·TC에 연결하고, 누락되면 다음 단계로 넘어가지 않는다.
- 애매하거나 모호한 것은 지어내지 않는다 — 업무 규칙·범위·권한·데이터의 의미처럼 사람이 정할 것은 작업 폴더의 `questions.md` 에 질문으로, 컨벤션·참조 코드로 기본값을 댈 수 있는 기술 세부는 `01-requirements.md` 의 `## 가정` 에 근거와 함께 적는다.
- `05-plan.md` · `08-validation.md` 와 `10-pr.md` 의 `code-agent:trace` 블록은 코드가 렌더한다 — 직접 고치지 않는다. 고칠 것이 있으면 `plan.json` 을 고쳐 다시 제출한다.
- 검증 결과는 보고하는 것이 아니라 `code-agent check` · `code-agent test` · `code-agent integrate` 가 기록한 것만 유효하다 — 직접 돌린 빌드·테스트는 게이트를 열지 못한다.
- 검증이 실패하면 **계획 안에서만** 고치고 `code-agent check` 부터 다시 돈다 (기본 2회). 넘으면 덮지 말고 보고한다. 동결된 테스트는 review 단계의 관찰된 독립 리뷰 지적이 해당 계획 파일을 가리킬 때만 수정한다. refactor의 기준 커밋 테스트는 계속 보호한다.
- `fix` 는 **재현이 먼저다** — 재현 테스트를 쓰고 `code-agent repro` 로 지금 코드에서 실패하는 것을 봐야 고칠 파일이 열린다. `refactor` 는 기준 커밋에 이미 있던 테스트 파일을 고치지도 지우지도 못한다.
- `09-review.md`는 독립 `ca-reviewer`의 시작·완료를 관찰한 hook이 결과를 자동 기록한다. 메인은 지적을 복사·요약·완화·재분류하거나 ‘해결’로 바꾸지 않는다. 수정 후 새 독립 리뷰로 해결 여부를 확인한다.
- 요구사항은 사람이 준 원문을 그대로 보관하고, 원문에 없는 요구를 더하지 않는다. 지시서(`requirement.md`)는 `code-agent request submit` 이 렌더한다 — 직접 쓰거나 고치지 않는다.
- 승인·확정·반영은 `.claude/skills/ca-answer/SKILL.md`의 **같은 세션 동의 절차**를 따른다. 메인만 `code-agent consent prepare <json-path>` → `AskUserQuestion` → `code-agent consent status <uuid>` → `approved`일 때 `code-agent consent apply <uuid>`를 수행한다. 준비 JSON은 작업 중 허용된 `doc/work/<ID>/`, 문서 준비 중 허용된 `doc/`에 저장한다. `prepare/status`가 반환한 `{id,status,summary,questions,toolInput}`에서 `summary` 전문과 모든 링크를 보여 주고, **`AskUserQuestion`에는 반환된 `toolInput` 객체 전체를 정확히 그대로** 전달한다. `toolInput`의 `{questions,metadata:{source:'code-agent:'+id}}`에서 CLI가 생성한 메타데이터는 내부 상관관계 식별용이며 사용자에게 표시하지 않는다. 메인이 `answers`·`annotations`·기본 응답이나 메타데이터를 만들거나 추가하지 않는다. 사용자에게 보이는 질문에는 UUID 접두사를 붙이지 않는다. PreToolUse·PostToolUse hook이 실제 응답을 기록하며 메인은 기록을 대신 만들지 않는다.
- `consent status`에 남은 질문이 있으면 같은 절차로 반복한다. 지식 항목 선택을 모두 받은 뒤 최종 승인을 받는다. 수정 요청·대상 변경·취소·보류·미응답이면 적용하지 않는다. 일반 업무 답변도 승인으로 적용하지 않는다. 적용 성공 후 같은 흐름을 자동으로 이어간다. 독립 TTY CLI는 사용자가 선택하는 수동 대체 경로이며 필수가 아니다.
- 동의 대상은 `setup` · `docs` · `baseline` · `request` · `plan` · `deliver` · `knowledge-prune` · `model` · `abort` · `plugin-add` · `plugin-remove` · `update`다. 사용자가 code-agent 업데이트를 요청하면 `update`로 Git pull·빌드·설치 적용을 확인받는다. **업데이트 적용 후에는 멈추고 갱신된 hook 로드를 위해 Claude Code 재시작을 안내한다.** 비밀값을 질문·요약·JSON·명령 인자에 넣지 않는다. 플러그인의 `secretEnv`는 이미 설정된 환경변수 이름만 참조하고 키 값은 받거나 출력하지 않는다.
- 모든 `/ca-*` 명령의 일반 업무 질의응답은 메인이 `AskUserQuestion`으로 수행하며 승인과 독립적이다. 질문 전에 `.claude/skills/ca-answer/SKILL.md`의 공통 절차를 읽는다. 추천과 이유를 제공하고 답을 기록한 뒤 호출한 명령을 이어간다. 5개 이상 후보는 전체 목록을 보여 주고 페이지를 나눠 선택받는다. 이 가공 규칙을 CLI의 동의 질문에는 적용하지 않는다. 문장형 질문 나열로 대신하거나 `/ca-answer` 재입력을 요구하지 않는다. 도구를 쓸 수 없으면 미응답 상태와 사유를 알린다.
- `.code-agent/` 는 code-agent 명령으로만 바뀐다.
- 보고·질문·요약과 생성 문서의 설명문은 **사용자가 쓰는 언어로** 한다 — 요청이 명령뿐이라 알 수 없으면 작업 지시서·questions.md가 쓰인 언어로. 서브에이전트 결과나 명령 출력이 다른 언어여도 그 언어로 옮겨 전한다. 코드 식별자·경로·도구명·보관해야 하는 원문은 그대로 두며, 관련 없는 외국어 문장이나 깨진 문자를 설명문에 섞지 않는다. 문서를 마칠 때 언어와 문장 연결도 확인한다.
- Bash 는 명령을 하나씩 실행한다 — `&&` · `;` · `|` · 리다이렉트로 잇는 명령은 hook 이 거부한다.
