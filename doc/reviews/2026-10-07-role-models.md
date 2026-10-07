# 역할별 모델·추론 강도 (2026-10-07)

기준 커밋 `3b5e867`(재시도 규약 공통 모듈 검토 반영). [이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)의 OPT-12·OPT-13·HX-9와 재시도 규약 §7.6을 구현했다. 현재 동작은 [프로세스 흐름도](../process-flow.md) §4.1·§6.3·§7·§8과 [Codex 연동](../codex.md#역할별-모델-기본값과-변경)이 정본이다.

## 결정

| 지적 | 결정 | 반영 |
|---|---|---|
| OPT-12 역할 모델이 전부 opus, 강도 없음 | 사용자 결정대로 역할을 판단·실행 두 등급으로 나눈다 | 판단(analyst·critic·reviewer) Claude opus/high, 실행(surveyor·explorer·writer·implementer·tester) Claude sonnet/medium. Codex는 gpt-6.1-sol high·medium 그대로. 정책 원천은 `modelPolicy.ts` `ROLE_POLICY`·`TIER_DEFAULTS`, 템플릿 머리말에 `effort:` |
| HX-9 역할별 선택 근거 없음 | 근거를 코드와 문서 한 곳씩에 둔다 | `ROLE_POLICY[역할].reason`과 `doc/codex.md` 역할 표(테스트가 대조). `doc/design.md`의 미결 문장("P5 실측으로 정한다")을 이번 결정으로 바꿨다. 머리말 YAML 주석은 넣지 않는다(파서 동작 미확인, 원천이 둘로 갈림) |
| OPT-13 단가표에 claude-sonnet-5-5 없음 | 번들 claude-api 스킬 표에 값이 있는 모델만 더한다 | `claude-sonnet-5-5`($2/$10, 캐시 읽기 $0.20)·`claude-fable-5`($10/$50, 캐시 읽기 $1). 날짜 접미사(`-YYYYMMDD`)를 떼고 찾는다(`priceKey`). 별칭→현재 모델 표 `CLAUDE_ALIAS_TARGETS`와 "별칭이 모두 단가표에 있다" 테스트. `usage`에 모델별 표, 사용량 0인 모델(`<synthetic>`)은 미산정 목록에서 뺀다. 단가 기준일 2026-09-25 |
| 재시도 규약 §7.6 모델 설정 오류 분류·같은 출처 | 분류는 기반 단계에서 반영됨을 확인, 같은 출처 인자 함수만 둔다 | `retryPolicy.CROSS_PATTERNS.config`의 모델·강도 문구와 `crossFailureText` 범위는 기반 커밋(`2327975`·`3b5e867`)에 이미 있다(맨 `reasoning[_ ]effort` 없음, 분류는 `crossFailureText(probe)`만 본다 — 확인만 했다). `claudeModelArgs`·`codexModelArgs`·`modelLabel`을 `modelPolicy.ts`에 두었고, 교차 실행(`crossCheck.ts`)에 `--effort`를 넣는 일은 C1이 실패 분류를 연결한 뒤에 한다(옛 Claude CLI의 `unknown option`이 지금은 중지 기록으로 새기 때문) |

## 설정 파일과 하위 호환

- `.code-agent/models.json`의 역할 값은 이전처럼 **모델 문자열**이고, 강도 변경은 예약 키 `effort: {역할: 강도}`에 둔다. 역할 값에 객체를 쓰면 이전 code-agent가 `model: [object Object]`를 쓴다(설계 검토에서 재현) — 그래서 쓰지 않는다. 형식은 `z.strictObject`로 읽고, 깨진 파일은 고치는 법과 함께 `Stop`으로 멈춘다(doctor는 던지지 않고 ✗로 적는다).
- 저장(`nextClaudeOverrides`)은 대상 역할 항목만 바꾼다. 대상이 아닌 역할의 값은 새 기본값과 같아도 지우지 않는다 — 버전이 섞인 팀에서 이전 버전이 계속 그 값을 읽는다. 모델만 바꾸면 강도 항목을 유지하고, `default`는 둘 다 지운다.
- haiku(`claude-haiku-*`)·`claude-sonnet-4-5`는 추론 강도를 받지 않는다(번들 claude-api 스킬 "Thinking & Effort" 표). 정의 파일에 `effort:` 줄을 쓰지 않고, 강도 지정은 거부하고, 표·doctor에 `(지원 안 함)`으로 보인다. 남은 강도 항목은 지우지 않고 무시한다.
- 이전 버전은 `"opus"`를 저장하지 않았으므로, 키가 없는 역할만 이번 갱신으로 새 기본값이 된다. 이전에 `"sonnet"`으로 바꿔 둔 실행 역할은 새 기본값과 같아져 "(기본)"으로 보인다(값은 그대로).
- `templateHash`는 머리말의 `model:`·`effort:` 줄을 빼고 본다. 그래서 이전 설치본을 갱신해도 8개 에이전트가 "손으로 고쳐 두었던 파일"로 잘못 보고되지 않는다. 대신 update가 정의 파일의 model·effort 전후를 따로 견줘 "설정대로 다시 썼습니다"로 알리고, 이전 번들 기본값(opus·강도 없음)이던 역할만 기본값 안내를 붙인다(원인을 단정하지 않는다). doctor "에이전트 모델"은 정의 파일 머리말이 설정과 다르면 ✗다.
- `model` 동의 스냅샷에 상태 `모델 정책`(`modelPolicyFingerprint` — 등급·기본값·강도 미지원 규칙, 이유 문장 제외)을 묶었다. 적용은 준비 때의 summary를 다시 만들지 않으므로, CLI만 바뀌고 설치본이 그대로면 이전 정책 아래 승인한 변경이 새 의미로 적용될 수 있었다. 이번 변경 전에 준비한 `model` 동의는 `변경 대상: 모델 정책`으로 거부되고 다시 준비한다.

## 확인

- `npm test` 단일 전체 실행: **904개 중 900개 통과·실패 0개·생략 4개**(기준 커밋 874개 중 870개 통과·생략 4개). 새 `modelPolicy.test.ts` 16개(정책 표·읽기·저장 규칙·이전 버전 호환·머리말 재작성·인자·지문·단가·`doc/codex.md` 대조)와 agent·consent·codex·p8 추가 테스트를 포함한다.
- 동작 변경으로 기대값을 바꾼 기존 테스트: init의 "8개 모두 opus" → 역할별 model·effort, `{implementer:"sonnet"}` 오버라이드 → `{implementer:"opus"}`(sonnet이 기본값이 되어), consent의 writer 변경 fixture → `opus`+`low`, usage 기준일 → 2026-09-25.
- sandbox(모델 호출 없음): 새 저장소에 `init --host both` 뒤 doctor `✓ 에이전트 모델`·`✓ Codex 에이전트 모델`. `{"implementer":"sonnet","reviewer":"haiku"}`와 이전 꼴 설치본(8개 `model: opus`, 강도 없음)에서 `update --templates-only` → "8개를 설정대로 다시 썼습니다"(reviewer `opus → haiku`), "그중 7개는 이전 번들 기본값", "오버라이드 1개 유지: reviewer=haiku", `ca-reviewer.md`에 `effort:` 없음, `models.json` 바이트 그대로. 이전 dist(`3b5e867` 빌드)로 `{"implementer":"haiku","effort":{"reviewer":"max"}}`를 읽으면 `applyModels`·`update` 모두 `[object Object]` 없이 동작하고 예약 키를 보존했다. 이어서 새 doctor는 이전 꼴 정의 파일을 ✗로 알리고 새 update가 되돌린다.
- Codex 사본: `ca-answer/reference.md`의 동의 필드 이름을 `` `"agent"` ``로 써서 `codexText`의 `` `agent` `` 치환(계획 배정 필드용)에 걸리지 않게 했다(원래 있던 결함). 글자 수는 reference.md 3,146 → 3,615자, Codex `ca-answer.md` 2,469 → 2,623자(C7 흐름 예산 측정 전에 들어간다).

## 미측정

- **완주 작업당 비용·품질(A/B)** — 실행 역할을 sonnet/medium으로 내려 생기는 check 실패·리뷰 지적·재배정 증가가 절감을 상쇄하는지는 실제 모델 비용이 들어 사용자 승인 뒤에 잰다. 측정 도구만 준비했다: `node scripts/evaluate-full-flow.cjs run new --model opus --agents exec-opus --label c6-execopus-<n>`와 `--agents policy --label c6-policy-<n>`를 각 3회. 두 쪽은 실행 역할의 모델 하나만 다르다(판단 역할은 둘 다 opus/high, 실행 역할 강도는 둘 다 medium). 보고서의 `agents`(역할별 model/effort)를 결과 기록에 싣는다. `--agents opus`는 2026-10-06 기준선과 잇는 용도로만 쓴다. `--agents` 머리말 재작성은 sandbox에서 네 모드 모두 확인했다(모델 호출 없음).
- 판단 역할의 강도가 이전보다 낮아질 수 있음 — 강도를 비워 두던 이전 설치에서 하위 에이전트가 세션 강도를 물려받았는지(Claude Code 기본 `xhigh`) 확인하지 못했다. 필요하면 `code-agent model analyst opus --effort xhigh`로 바꾼다.
- 지원 단계가 좁은 모델(Opus 4.5의 `xhigh`·`max` 없음 등)을 Claude Code가 `high`로 낮추는 것은 바이너리 문자열로만 확인했다.
- 교차 실행 Claude 인자의 `--effort`는 C1(교차 검증 무결성, [기록](2026-10-07-cross-integrity.md))이 `crossInvocationArgs`로 연결했다 — `claudeModelArgs`·`codexModelArgs`·`modelLabel`을 쓰고, 단위 시험(`cross.test.ts`)이 `--model opus --effort high`·`models.json` 의 sonnet/max·haiku(강도 없음)·Codex `-m gpt-6.1-sol -c model_reasoning_effort="high"` 를 고정한다. 실제 호스트로 돌린 확인은 미측정이다.

## 구현 검토 반영

구현 커밋 `eaad713`의 독립 검토 지적 10건(모두 minor, 중복 2쌍)을 코드와 sandbox로 하나씩 확인했다. 모두 사실로 확인되어 반영했고, "반영하지 않음"은 없다.

| 지적 | 확인 | 반영 |
|---|---|---|
| 형식이 잘못된 `models.json`이면 init·update가 스킬·에이전트를 번들로 덮은 뒤 `applyModels`에서 멈춘다(두 건) | 검토자 sandbox(`partial.cjs`)를 이 커밋 전 빌드로 다시 돌려 재현: `{"reviewer":"Opus"}`에서 `update`가 `Stop`, 손으로 고친 `ca-check/SKILL.md`는 이미 번들로 덮였고 `version`은 그대로였다. 두 호스트 `update`는 호스트마다 `init`을 따로 불러 뒤 호스트에서 멈추면 앞 호스트만 갱신된다 | `init.ts` `requireInstallSettings` — 아무 파일도 쓰기 전에 설치 호스트 전부의 hook 설정과 `models.json`·`codex-models.json`을 읽는다. `init`과 `update`(설치 호스트 전부로 한 번)가 부른다. 같은 sandbox에서 이제 `skill restored: false`. p8 테스트 2개(대문자 별칭으로 `update`·`init` 모두 파일 하나 바꾸지 않고 멈춤, 두 호스트에서 `codex-models.json`이 깨지면 Claude 쪽도 그대로). 이전 버전이 검사하지 않던 손 입력 값이 거부된다는 것을 `doc/codex.md`에 적었다 |
| `doc/design.md` 동의 스냅샷 문단에 model 동의의 모델 정책 상태가 없다 | 807행 확인 | 상태 목록에 모델 정책 지문(이유 문장 제외)과, 갱신 전에 준비한 model 동의가 `변경 대상: 모델 정책`으로 거부되어 다시 준비한다는 문장을 더했다 |
| `evaluate-full-flow.cjs` resume 때 `--agents`가 기록을 이기고, C6 전 기록에는 `agentsMode`가 없어 이름표가 틀린다(두 건) | 코드 확인: `option('agents') ?? previous?.agentsMode ?? …`. C6 전 스크립트는 `--model opus`면 설치 그대로(전부 opus·강도 없음), `sonnet`이면 전부 sonnet이었다 | resume은 기록의 `agentsMode`를, 없으면 기록의 `model`(opus·sonnet)을 모드로 쓴다. 둘 다 없으면 거부, 기록과 다른 `--agents`도 거부한다. 결정 줄만 떼어 10개 조합을 돌려 확인했다(`agents-resume.cjs`, 모델 호출 없음) |
| 같은 스크립트의 판단 역할 목록이 하드코딩(두 건) | `JUDGMENT_AGENTS` 확인 | `ROLE_POLICY`의 `tier === "judgment"`에서 만든다. 네 모드의 머리말 재작성 결과가 이전과 같음을 다시 확인했다 |
| doctor "에이전트 모델"이 정의 파일이 없어도 ✓ | `.claude/agents`를 지우면 `✗ 스킬·에이전트: 없는 것 8개`와 `✓ 에이전트 모델`이 함께 나옴을 확인 | 대조한 파일이 없으면 `·`(대조하지 않음), 일부만 있으면 ✓에 일치한 파일 수를 붙인다. p8 테스트 2개, `doc/install.md` doctor 표 |
| `process-flow.md` 줄 번호 기준이 두 커밋으로 섞임 | C6이 `models.ts:129`·`AGENTS`(11)·`ROLE_POLICY`(20)·`TIER_DEFAULTS`(76)만 새 줄로 바꿨다. 나머지 인용은 `c4f3fbf` 기준으로 맞다(그 뒤 공통 모듈 커밋은 새 파일만 더했다). C6이 민 줄(`consent.ts`·`init.ts`·`doctor.ts`)은 머리말 규칙대로 함께 적은 함수 이름으로 찾는다 | 머리말 기준(`c4f3fbf`)을 유지하고, C6이 넣은 줄 번호 인용을 함수·상수 이름으로 바꿨다. 다른 묶음과 머리말을 다투지 않는 쪽을 골랐다. §10 행에 이 규칙을 적었다 |
| 모델 정책 지문은 그 시점 CLI가 계산해, 셸 CLI와 hook 명령이 다른 빌드면 model 동의가 매번 거부되는데 원인이 보이지 않는다 | `observeConsent`·적용 때 `inspectConsentSnapshot`을 다시 부르는 것을 확인 | `requireConsentSnapshot`이 변경 목록에 `모델 정책`이 있을 때만 "준비한 code-agent와 지금 code-agent의 모델 정책이 다르다 — 업데이트 직후면 다시 준비, 반복되면 doctor로 PATH·hook 명령이 같은 설치본인지 확인" 안내를 붙인다. consent 테스트 1개 추가(다른 변경에는 붙지 않음), 기존 테스트에 문구 대조 |
| 강도 미지원 목록이 이전 명명 haiku·Opus 4.1·Sonnet 4.0을 놓친다 | 검토자 `unit.cjs`에서 `claude-3-5-haiku-20241022`·`claude-opus-4-1`·`claude-sonnet-4-20250514`가 강도를 받는다고 나옴을 확인. 번들 claude-api 스킬: effort는 Opus 4.5부터, Sonnet 4.5·Haiku 4.5는 오류, 4 세대에서 effort는 Opus 4.5·4.6·Sonnet 4.6만(model-migration) | 막는 목록을 유지하고(앞으로 나올 ID를 미리 알 수 없다) Sonnet 4.5 이하 4 세대, Opus 4·4.1, `claude-<숫자>` 이전 명명을 더했다. 같은 sandbox에서 네 ID 모두 `false`, `claude-opus-4-5`·`claude-sonnet-4-6`은 `true`. 테스트 8.1-6에 막는 ID 14개와 받는 ID 6개를 더했다. 지문이 바뀌므로 준비해 둔 model 동의는 다시 준비 대상이 된다(의도대로). `model` 표 안내·`doc/codex.md`·`process-flow.md` §7 문구를 맞췄다 |

확인: `npm test` 단일 전체 실행 **909개 중 905개 통과·실패 0개·생략 4개**(구현 커밋 904개 중 900개 통과 — 새 테스트 5개). sandbox는 모델 호출 없이 돌렸다.
