# code-agent 개발 지침

이 저장소는 Claude Code·Codex 위에서 도는 개발 절차 `code-agent` **자체의 소스**다. 대상 프로젝트에 설치되는 지침은 `template/`(`CLAUDE.block.md`·`CODEX.block.md`·`claude/skills`·`claude/agents`·`codex/`)에 있다. 이 파일과 혼동하지 않는다.

## 먼저 읽는다

1. [`doc/process-flow.md`](doc/process-flow.md) — 접수부터 반영까지의 단계·게이트·동의·hook·호스트 차이·파일 지도·모듈 지도. **전문을 읽지 않는다**(10만 자가 넘는다). §1.1 대응표와 §9 모듈 지도에서 바꾸려는 동작의 절을 찾아 그 절만 읽고 파일을 연다.
2. 해당 코드. 흐름도와 코드가 다르면 코드가 맞다. 이때는 흐름도를 고친다.
3. 필요할 때만 읽는다: [`doc/design.md`](doc/design.md)(설계 근거), [`doc/codex.md`](doc/codex.md)(Codex 차이), [`doc/planning.md`](doc/planning.md)(계획 작업), [`doc/reviews/README.md`](doc/reviews/README.md)(변경·검증 이력).

흐름도에 없는 동작은 추측하지 말고 코드를 연다. 줄 번호를 인용할 때는 실제로 연 파일의 줄만 쓴다.

## 바꿀 때 지킨다

- 동작을 바꾸면 **같은 커밋에서** `doc/process-flow.md` §1.1 대응표에 따라 해당 절을 고치고, §10 변경 이력에 변경당 한 줄(바뀐 것의 요지 한 문장과 커밋 — 함수·상수 이름을 늘어놓지 않는다. 경위·지적별 처리·검증 결과는 `doc/reviews/` 기록에)을 남긴다.
- **함께 맞출 중복 정의는 §1.1 셋째 칸이 정본이다** — 바꾸는 코드의 행을 찾아 그 칸을 모두 맞춘다. 다음 시험이 일부를 대조한다. 깨지면 사본(문서·템플릿·목록)을 코드에 맞춘다: `docSync`(흐름도 §3.2 단계·§4.1 동의·§5.1·§5.2 hook 등록표·§6.4 생성 블록·§7 모델 기본값), `consentBinding`·`consentOutput`(동의 동작·준비 인자 목록), `retryPolicy`(안내 자리표시·`UNRENDERED_GUIDES`), `modelPolicy`(에이전트 머리말·`doc/codex.md` 모델 표), `hostText`(`SKILL_NAMES`·`ROLE_NAMES` ↔ 템플릿 폴더), `hostNotation`·`templateText`(Codex 사본 치환·공통 문단·계획 스킬 2·3·4항), `planningChain`(`planningNextLine`), `hookLoad`(hook 경로의 import), `hookPaths`(읽기 전용 담당 ↔ 정의 파일 `tools`), `planningRetry`(`planningRules.ts` `RULES` ↔ 검사 문구의 `ruled("…")` 식별자), `templateBudget`.
- 시험이 없거나 일부만 보는 것 — §1.1 해당 행에 상세가 있다:
  - hook 등록(`init.ts`) → `doctor.ts` 목록, `update.ts` hook 출력, `doc/codex.md` 이벤트 표, `README.md` 동작 구조 표, `doc/install.md`·`doc/usage.md`의 흐름도 정본 링크.
  - 서브에이전트 추가·삭제 → `modelPolicy.ts` `AGENTS`, 계획·리뷰 담당이면 `init.ts`·`doctor.ts`의 SubagentStart·Stop matcher.
  - `PHASES` → `PHASE_LABEL`·`PHASE_SKILL`·`ca-next` 표. `ca-next` '멈춘 자리별 재개' 표 ↔ `nextHint` 판정 순서 ↔ `stateView.ts` 재개 판정 순서(`RESUME_CODES`)·`doc/usage.md` 5절 재개 코드 표.
  - 계획 advance action·출력 키 → `doc/planning.md` action 표. 연쇄(`--chain`)는 program 게이트만 잇는다.
  - `ca-reviewer.md` 출력 표 ↔ `reviewResultProblems`·`normalizeReviewTable`·`parseFindings`.
  - TC 인식 규칙(`testResults.ts` `TC_ID`·`tcToken`, 보고서 이름 `reportSnapshot`) ↔ `ca-tester.md` TC 표기 문장·`ca-test/tc-names.md` 러너 표. 규칙 식별자의 검사 내용 ↔ 담당 지침(`criteria.md`·`ca-writer.md`)의 같은 규칙.
  - `grantTarget` ↔ `GRANT_STEP` 키. `MODEL_SUBCOMMANDS`에 더하면 `LEASE_FREE`에도 넣을지 정한다.
  - 버전 선택·위임 계약(`runtimeSelect.ts` 머리말 — `runtime.json`·`release.json`·`RUNTIME_KEY`·`CODE_AGENT_RUNTIME_SELF`)은 이미 설치된 진입점이 새 릴리스를 부르는 규약이라 바꾸지 않는다. 승인·증거·작업 기록의 형식을 바꾸면 `STATE_SCHEMA`를 올린다(낮은 세대의 릴리스는 그 프로젝트에 적용되지 않는다). 다음 작업을 여는 명령(`cliMain.ts` `opening`)을 바꾸면 hook 이 그 직전에 적용하는 `runtimeSelect.ts` `OPENING_COMMAND`도 맞춘다.
  - Codex exec 배너·`CODEX_TURN` → `crossFailureText`. 교차 자식이 여는 명령 → `CROSS_CHILD_READONLY`·§5.3 0단계. `ca-review`·`ca-plan` 4-1 교차 문장 → `codexText` 권한 상승 정규식.
  - 재시도 규약 → §6.4 생성 블록을 `renderRetryPolicyTable()` 출력으로 다시 붙인다. 시험은 표에 렌더되는 값만 보므로 §6.4 산문에 숫자를 쓰지 않는다.
- 코드 규칙:
  - CLI·hook 의 사용자 문구는 스킬·도구 이름을 리터럴로 쓰지 않고 `hostText.ts` 표기 함수를 부른다(파일·확인 화면에 기록되는 문자열만 예외).
  - hook 경로 모듈(`hook`·`codexHook`·`stopHook`·`sessionHook`과 그 import)은 명령 모듈을 정적으로 import 하지 않는다 — 쓰는 분기 안에서 `require`하고 그 `require`를 `try`로 감싸지 않는다. 새 hook 하위 명령은 `cli.ts` `HOOKS`와 `hookFailureExit` 표에 함께 더한다.
  - 동의 제목(`CONSENT_TITLES`)·카운터 이름표(`COUNTER_LABEL`)·안내 문구(`retryPolicy.ts`)는 한 모듈이 원천이다 — 따로 정의하지 않고 import 한다. 단가표(`prices.ts`)에는 번들 claude-api 스킬 표에 값이 있는 모델만 넣는다.
- `template/claude/**` 문장을 바꾸면 Codex 사본이 `src/agent/hosts.ts`의 `codexText()`로 변환된다. 문장째 치환(`CODEX_SENTENCES`)과 장시간 실행·교차 4-1 리터럴 치환의 원문이 템플릿과 글자 그대로 같아야 한다 — 다르면 오류 없이 치환되지 않는다. 17개 스킬의 질문·동의 공통 문단도 같은 글자여야 한다. 예외가 둘 있다. `ca-answer/SKILL.md`는 변환하지 않고 `template/codex/ca-answer.md`로 대체하며, 에이전트 머리말의 `description`은 변환 없이 옮긴다. 이 둘은 따로 맞춘다.
- 템플릿 문장을 늘려 `src/test/templateBudget.test.ts` 예산을 넘기면 필요할 때만 읽는 보조 문서로 옮기거나, 예산을 올리는 근거를 `doc/reviews/`에 남기고 `BUDGET`을 고친다(`node scripts/template-sizes.cjs --suggest`).
- 현행 문서(`README.md`, `doc/*.md` — `process-flow.md` §10 제외)에는 현재 동작과 설계 근거만 쓴다. '이전에는'·'~로 바뀌었다'·결정 날짜·검토 지적 번호 같은 경위는 쓰지 않는다(실제 호스트에서 확인한 버전처럼 사실의 조건인 날짜·버전은 남긴다). 변경 경위와 검증 결과는 `doc/reviews/<날짜>-<주제>.md`와 `doc/reviews/evidence/`에 남기고 `doc/reviews/README.md` 표에 추가한다.
- 사용자에게 보이는 문서는 한국어로, 기존 문체를 따른다.

## 빌드와 테스트

```sh
npm ci
npm run build
npm test
```

Node 24.19.0 이상 24.x (`>=24.19.0 <25`)가 필요하다. 전체 테스트는 Windows에서 약 2~3분 걸리며(파일 단위 병렬 — 벽시계는 가장 긴 파일과 동시에 도는 파일들의 CPU·프로세스 경합이 함께 정한다. 한 파일이 약 90초를 넘거나 그 파일 하나가 벽시계를 정하면 주제별로 나눈다), 플랫폼 조건으로 4개가 생략된다. `npm test`는 `tsc` 뒤 `scripts/prune-dist-tests.cjs`로 지운·옮긴 시험의 옛 `dist/test` 산출물을 지운다.

## 실험할 때

- 대상 프로젝트 동작은 임시 git 저장소에서 `node <이 저장소>/dist/agent/cli.js <명령>`으로 확인한다. 이 저장소 루트에 `init`을 실행하지 않는다.
- 실험 중 `code-agent update`(소스 업데이트)를 실행하지 않는다. 이 명령은 터미널에서 미리보기를 확인하면(`update` 입력) 이 저장소의 upstream 을 fetch 하고 사용자 홈의 릴리스 저장소(`~/.code-agent/releases`)에 `npm ci`·build 해 등록한 뒤 그 프로젝트에 적용한다. 버전 적용 실험은 임시 폴더의 릴리스 저장소(`CODE_AGENT_RELEASE_HOME`)와 `update --apply-release`로 하고(`runtimeRelease.test.ts`의 방식), 템플릿 적용 확인은 `update --templates-only`로 한다.
- 다른 작업이 테스트를 돌리는 동안 `npm run build`를 다시 실행하면 `dist`가 경합한다.
- Windows 에서 `codex exec -c projects={…}`로 임시 프로젝트를 신뢰할 때 키는 Windows 경로(`C:\…`)로 쓴다. 슬래시 경로는 신뢰로 인정되지 않아 프로젝트 hook 이 알림 없이 돌지 않는다.
