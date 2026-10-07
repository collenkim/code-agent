# code-agent 개발 지침

이 저장소는 Claude Code·Codex 위에서 도는 개발 절차 `code-agent` **자체의 소스**다. 대상 프로젝트에 설치되는 지침은 `template/`(`CLAUDE.block.md`·`CODEX.block.md`·`claude/skills`·`claude/agents`·`codex/`)에 있다. 이 파일과 혼동하지 않는다.

## 먼저 읽는다

1. [`doc/process-flow.md`](doc/process-flow.md) — 접수부터 반영까지의 단계·게이트·동의·hook·호스트 차이·파일 지도·모듈 지도. 바꾸려는 동작이 어느 칸에 있는지 여기서 찾고, §9 모듈 지도로 파일을 연다.
2. 해당 코드. 흐름도와 코드가 다르면 코드가 맞다. 이때는 흐름도를 고친다.
3. 필요할 때만 읽는다: [`doc/design.md`](doc/design.md)(설계 근거), [`doc/codex.md`](doc/codex.md)(Codex 차이), [`doc/planning.md`](doc/planning.md)(계획 작업), [`doc/reviews/README.md`](doc/reviews/README.md)(변경·검증 이력).

흐름도에 없는 동작은 추측하지 말고 코드를 연다. 줄 번호를 인용할 때는 실제로 연 파일의 줄만 쓴다.

## 바꿀 때 지킨다

- 동작을 바꾸면 **같은 커밋에서** `doc/process-flow.md` §1.1 대응표에 따라 해당 절을 고치고, §10 변경 이력에 한 줄을 남긴다.
- 함께 맞출 중복 정의가 있다:
  - 동의 동작(`consent.ts` `ActionSchema`)을 바꾸면 `template/claude/skills/ca-answer/SKILL.md`·`reference.md`와 `template/codex/ca-answer.md`의 목록도 고친다(`consentBinding.test.ts`가 `CONSENT_ACTIONS`와 대조한다). 동의 제목은 `consentState.ts` `CONSENT_TITLES` 하나다.
  - 동의 준비 인자 형식(`consentTicket.ts` `parsePrepareArgs`·`INLINE_ACTIONS`)을 바꾸면 hook(`consentCommandOf` — 문법이 틀린 명령에는 티켓을 내지 않는다)과 CLI 가 같은 함수를 쓰는지, `PREPARE_UNOBSERVED`·`PREPARE_USAGE` 문구, `ca-answer/SKILL.md` 동작 준비 절·1항과 `template/codex/ca-answer.md` 1항의 명령 꼴을 함께 고친다(`consentOutput.test.ts`). `--for` 출력에서 빼는 필드(`consent.ts` `renderConsentOutput`)를 바꾸면 ca-answer 1·3항이 읽는 필드와 맞춘다.
  - 업무 답 관찰 규칙(`answers.ts`, `questions.ts`의 `[Source]`)을 바꾸면 `ca-answer/SKILL.md` 1·3절과 `template/codex/ca-answer.md` 업무 질문 문단도 고친다.
  - 사람 허용 카운터(`retryGrant.ts` `grantTarget`)는 `GRANT_STEP`의 키와 같아야 한다 — 키를 더하면 기록 파일·범위·잠금 안 재확인을 표에 함께 정한다.
  - hook 등록(`init.ts`)을 바꾸면 `doctor.ts` 목록, `update.ts`의 hook 출력, `doc/codex.md` 이벤트 표, `README.md` 동작 구조 표, `doc/install.md`·`doc/usage.md`의 hook 수도 고친다.
  - 서브에이전트를 추가·삭제하면 `hostText.ts`의 `ROLE_NAMES`(정본 — `hosts.ts`가 다시 내보내고 `codexText` 역할 정규식도 이 목록으로 만든다), `modelPolicy.ts`의 `AGENTS`도 고친다. 계획·리뷰 담당이면 `init.ts`·`doctor.ts`의 SubagentStart·Stop matcher도 고친다. 스킬을 추가·삭제하면 `hostText.ts`의 `SKILL_NAMES`도 고친다(`hostText.test.ts`가 템플릿 폴더와 대조한다).
  - 재시도 규약(`retryPolicy.ts`의 `POLICIES`·`LIMITS`·`GRANT_STEP`·`TIMING`)을 바꾸면 `doc/process-flow.md` §6.4 생성 블록을 `renderRetryPolicyTable()` 출력으로 다시 붙인다. `docSync.test.ts`는 표에 렌더되는 값만 대조한다 — 표에 나오지 않는 값은 잡지 못하므로 §6.4 산문에 숫자를 쓰지 않는다. 안내 문구의 자리표시를 바꾸면 `GUIDE_KEYS`·`GUIDE_VARIANT_KEYS`와 그 원인을 렌더하는 호출의 값도 고친다. 카운터 이름표는 `COUNTER_LABEL` 하나다 — 다른 모듈에 따로 정의하지 않고 import한다.
  - 역할 모델 정책(`modelPolicy.ts` `ROLE_POLICY`·`TIER_DEFAULTS`)을 바꾸면 `template/claude/agents/ca-*.md` 머리말의 `model`·`effort`와 `doc/codex.md` 역할별 모델 표를 같이 고친다(`modelPolicy.test.ts`가 대조한다). 단가표(`prices.ts`)에는 번들 claude-api 스킬 표에 값이 있는 모델만 넣는다.
  - 스테이지(`layout.ts` `PHASES`)를 바꾸면 `phaseInfo.ts`의 `PHASE_LABEL`·`reentry.ts`의 `PHASE_SKILL`과 `ca-next` 표도 고친다.
  - `ca-next`의 '멈춘 자리별 재개' 표는 `commands.ts` `nextHint`의 판정 순서(AI-DLC → 요구 → 질문 → 승인 무효 → 검증 한도 → 원인별 실패 `failureHint`)와 함께 고친다.
  - 장시간 실행 정본 문장(`ca-check`·`ca-test`·`ca-integrate`·`ca-implement`)과 교차 4-1 문장(`ca-review`·`ca-plan`)을 고치면 `hosts.ts` `codexText`의 같은 리터럴 치환도 고친다(`hostNotation.test.ts`가 Codex 사본의 `Bash`·`600000ms`를 잡는다). CLI·hook 의 사용자 문구에는 스킬·도구 이름을 리터럴로 쓰지 않고 `hostText.ts` 표기 함수(`skill`·`agentName`·`askVia`·`viaShell`·`shellLabel`·`fileToolsHint`·`readVia`·`readToolVia`·`editVia`)를 부른다 — 파일·확인 화면에 기록되는 문자열만 예외다.
  - 모델이 부를 수 있는 `code-agent` 명령(`hook.ts` `MODEL_SUBCOMMANDS`·`isModelCommand`)을 더하면, 상태를 바꾸지 않는 명령인지 보고 `LEASE_FREE`(작업 임대를 보지 않는 읽기 전용 명령)에도 넣을지 정한다.
  - 계획 advance의 action(`dispatch`·`stale`·`wait`·`rewind-required`·`blocked`·`ready-for-gate`)이나 출력 키를 바꾸면 action별 다음 행동의 원천인 `planningChain.ts` `planningNextLine` 표(`planningChain.test.ts`), `ca-analyze`·`ca-impact`·`ca-design`·`ca-plan` 4항(행동 요지 — 네 스킬이 2·3·4항을 같은 글자로 둔다, `templateText.test.ts`)과 `doc/planning.md` action 표도 고친다. 연쇄(`--chain`)는 program 게이트(analysis·impact·design)만 잇는다 — 사람 확인(계획 제출·승인)을 잇지 않고 실패·거부에서 자동으로 다시 시도하지 않는다.
  - `ca-review`·`ca-plan` 4-1의 `` Bash: `code-agent … cross --by codex` `` 문장을 바꾸면 `hosts.ts` `codexText`의 권한 상승 치환 정규식과 맞춘다.
  - `ca-reviewer.md`의 출력 표(열·상태 값·경로 규칙)를 바꾸면 `crossRecord.ts` `reviewResultProblems`·`review.ts` `parseFindings`와 맞춘다(hook·교차·게이트가 같은 표 규칙을 쓴다).
  - hook 하위 명령은 `cli.ts` `HOOKS`가 지연 로드하고 모듈 로드 실패는 `retryPolicy.ts` `hookFailureExit` 표로 끝낸다 — 새 하위 명령은 두 곳에 함께 더한다. hook 경로 모듈(`hook.ts`·`codexHook.ts`·`stopHook.ts`·`sessionHook.ts`와 그것들이 import 하는 모듈)에서 명령 모듈(`consent`·`commands`·`deliver`·`validate`·`init` 등)을 정적으로 import 하지 않는다 — 필요하면 쓰는 분기 안에서 `require`한다(`hookLoad.test.ts`가 그래프·실행 경로·로드 실패 표를 본다).
  - Codex exec 배너 라벨·전사 라벨(`CODEX_TURN`)·오류 줄 꼴이 바뀌면 `retryPolicy.ts` `crossFailureText`를 고친다. 교차 자식에서 여는 `code-agent` 명령을 바꾸면 `hook.ts` `CROSS_CHILD_READONLY`와 흐름도 §5.3 0단계를 함께 고친다. 교차 실행 인자의 doctor 점검 목록은 `crossCheck.ts` `crossFlags`가 인자에서 만들므로 따로 맞출 것이 없다.
- `template/claude/**` 문장을 바꾸면 Codex 사본이 `src/agent/hosts.ts`의 `codexText()`로 변환된다. 문장째 치환(`hosts.ts` `CODEX_SENTENCES`)의 원문이 여전히 템플릿과 글자 그대로 같은지 확인한다 — 다르면 오류 없이 치환되지 않는다(`templateText.test.ts`가 원문이 Claude 템플릿에 있고 Codex 사본에 남지 않는지 본다). 17개 스킬의 질문·동의 공통 문단도 같은 글자여야 한다(같은 테스트). 예외가 둘 있다. `ca-answer/SKILL.md`는 변환하지 않고 `template/codex/ca-answer.md`로 대체하며, 에이전트 머리말의 `description`은 변환 없이 옮긴다. 이 둘은 따로 맞춘다.
- 템플릿 문장을 늘려 `src/test/templateBudget.test.ts` 예산을 넘기면 필요할 때만 읽는 보조 문서로 옮기거나, 예산을 올리는 근거를 `doc/reviews/`에 남기고 `BUDGET`을 고친다(`node scripts/template-sizes.cjs --suggest`).
- 현행 문서(`README.md`, `doc/*.md`)에는 현재 동작만 쓴다. 변경 경위와 검증 결과는 `doc/reviews/<날짜>-<주제>.md`와 `doc/reviews/evidence/`에 남기고 `doc/reviews/README.md` 표에 추가한다.
- 사용자에게 보이는 문서는 한국어로, 기존 문체를 따른다.

## 빌드와 테스트

```sh
npm ci
npm run build
npm test
```

Node 22 이상이 필요하다. 전체 테스트는 Windows에서 약 2~3분 걸리며, 플랫폼 조건으로 4개가 생략된다.

## 실험할 때

- 대상 프로젝트 동작은 임시 git 저장소에서 `node <이 저장소>/dist/agent/cli.js <명령>`으로 확인한다. 이 저장소 루트에 `init`을 실행하지 않는다.
- 실험 중 `code-agent update`(소스 업데이트)를 실행하지 않는다. 이 명령은 터미널에서 미리보기를 확인하면(`update` 입력) 이 저장소에서 fetch·pull·(의존성이 바뀌었거나 없으면) `npm ci`·build를 실행한다. 템플릿 적용 확인은 `update --templates-only`로 한다.
- 다른 작업이 테스트를 돌리는 동안 `npm run build`를 다시 실행하면 `dist`가 경합한다.
