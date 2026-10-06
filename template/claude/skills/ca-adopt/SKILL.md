---
name: ca-adopt
description: 저장소에 code-agent 를 처음 도입한다 — 뼈대 역공학(소스가 없으면 인터뷰)으로 POLICY 4종·KNOWLEDGE 3종 문서와 code-agent.json 을 만든다.
---

**질문·동의** — 사람에게 묻거나 승인·확정·반영을 받기 직전에 `.claude/skills/ca-answer/SKILL.md`를 읽고 그 절차(`AskUserQuestion`·같은 세션 동의)를 따른다. 일반 답변은 승인이 아니며, 적용 뒤에는 이 흐름을 자동으로 이어간다.

너는 **메인 에이전트**다. 문서와 `code-agent.json` 만 쓴다. `code-agent` 명령이 거부하면 사유를 전하고 멈춘다.
뼈대 역공학은 **얕게** 한다 — 구조와 규약만. 도메인 하나하나의 깊은 분석은 작업마다 요구사항 범위로 한다.

## 1. 시작

**간단한 시작이 기본이다.** 접수 중이어도 `docs begin`으로 원문을 유지한 채 준비한다. 사용자에게 내부 설정 이름을 나열하지 않는다.
기존 프로젝트는 탐지한 언어·폴더·명령을 재사용한다. 새 프로젝트에서는 `code-agent docs recommend`의 실제 구성 후보를 최소 5개 보여 주고, 요청 목적에 맞는 하나에 추천과 이유를 붙인다. 공통 선택 절차의 페이지 규칙으로 `AskUserQuestion`을 호출한다. 후보를 문장으로만 보여 주고 끝내지 않는다.
사용자가 추천 구성(node 또는 python)을 선택했으면 `code-agent docs begin` → `code-agent docs setup <선택>`으로 문서·설정을 만들고 5의 마무리로 간다. 동의 JSON을 허용된 경로에 작성한 뒤 문서 세션을 닫는다.
이 경우 아래의 세부 인터뷰를 반복하지 않고, 문서 경로와 선택 요약을 보여 준 뒤 5의 마무리에서 `setup` 공통 동의 절차를 수행한다.
선호 언어·회사 규칙이 있으면 그대로 따르고 아래 절차로 그 구성만 작성한다. `code-agent setup`으로 실행 환경·기존 명령·기준 커밋을 확인한다. 최초 커밋이 없거나 기존 저장소에 미커밋 도입 파일이 있으면 `setup` 동의에 준비 파일 목록 확인과 준비 커밋을 함께 포함한다. 문서 확정과 기준 커밋 생성을 별도 질문으로 나누지 않는다. 접수 원문과 작업 ID는 유지한다. 시작 기준 브랜치에도 도입 커밋이 있어야 한다. 없으면 `start`가 전환 전에 안내하므로, 사용자가 지정한 기준을 임의로 바꾸지 말고 도입 브랜치를 기준으로 쓸지 또는 기존 기준에 반영할지 확인한다.

**기존 테스트 도구를 유지한다.** 언어·프레임워크와 테스트 도구가 정해져 있으면 다시 선택시키지 않는다. 기존 빌드 설정·테스트 파일·CI에서 명령을 연결하고, 준비 단계에서는 테스트나 러너 적합성 검사를 실행하지 않는다. 신규 추천 구성은 테스트 도구도 포함하므로 별도 선택이 필요 없다. 실제 테스트 작성·실행은 승인된 구현 Task에서 한다. 실행 후 콘솔 결과 또는 이번 실행이 생성한 JUnit 보고서는 에이전트가 자동으로 읽는다.

1. Bash: `code-agent status` — `code-agent.json` 이 이미 있으면 Bash: `code-agent manifest check` 를 보고, 문서만 모자라면 `/ca-docs` 절차로 간다.
2. Bash: `code-agent docs begin`
3. Bash: `code-agent survey`

**`survey` 가 "소스 파일이 없습니다 — 신규(빈) 저장소입니다" 를 찍으면** — 2 의 역공학을 건너뛰고 **인터뷰**로 간다.
역공학할 코드가 없으므로 `ca-surveyor` 를 부르지 않는다.
(`지원 목록 밖 언어입니다` 로 찍혔으면 아직 갈라지지 않는다 — survey 가 아는 확장자 밖의 코드가 있을 수 있다.
**사용자에게 물어** 빈 저장소가 맞는지 확인하고, 코드가 있으면 그 언어의 파일을 직접 짚어 역공학으로 간다.)

- POLICY 4종은 `code-agent docs skeleton <종류>` + `code-agent docs interview <종류>` 로만 채운다.
- 직접 선택인 경우에도 사용자의 목적·선호 언어를 받아 소스 루트·단계·build/test/prepare·git.base는 일관된 기본값으로 제안한다.
  사용자가 바꾸겠다고 한 항목과 제품 동작에 영향을 주는 결정만 묻는다. 내부 JSON 속성을 초보자에게 결정하게 하지 않는다.
- **`referenceDomain` 은 적지 않고 `exemplars` 는 전부 `[]` 로 둔다** — 참조할 코드가 없다.
  복제할 표준이 없으므로 단계는 `"scope": "project"` + `outputDirs` 로 선언하는 쪽이 자연스럽다.
- `manifest check` 가 `- 확인: 참조 파일을 선언한 단계가 없습니다` 만 찍으면 정상이다 (경고이지 ✗ 가 아니다).
  참조 표준이 없는 자리는 `code-agent context` 가 아키텍처·컨벤션 문서를 대신 가리킨다.

## 2. 문서

`.claude/skills/ca-docs/SKILL.md`를 그대로 따른다. 레거시에서는 **소스·설정 기준으로 작성 / 사용자 선택·입력으로 작성 / 기존 문서 연결**을 선택 도구로 한 번 제시하고 선택한 경로를 따른다. 앞서 선택했으면 다시 묻지 않는다. 빈 저장소는 초기 구성 선택에 따른 문서 작성으로 간다.

- **POLICY 4종** — 아키텍처 · 코드 컨벤션 · 테스트 전략 · 품질·보안 기준. `확인 필요` 로 남은 섹션은 **3. 대화로 생성** 으로 채운다.
  테스트 전략과 품질·보안 기준은 도구·명령을 survey 의 도구 후보와 CI 설정에서 초안으로 잡고,
  수준별 필수 여부·통과 기준·임계·차단 정책은 기존 정책을 재사용하거나 기본안을 제시한다. 제품 특성에 따라 정해야 할 결정만 묻는다. **적은 명령 이름은 3 의 `code-agent.json` 에 같이 등록한다** — 이름이 매니페스트에 없으면 게이트가 막는다.
- **KNOWLEDGE 3종** — 데이터 사전 · API 목록은 기본으로 생성(각각 상위 30·40개), 업무 규칙·용어집은 **빈 뼈대**가 추천이다.
  비어 있어도 작업을 막지 않는다. 확정 절차도 없다.

경로는 기본값(`doc/architecture.md` · `doc/conventions.md` · `doc/test-strategy.md` · `doc/quality.md` · `doc/knowledge/*.md`)을 쓴다.
이미 비슷한 문서가 있으면(survey의 "이미 있는 문서") 작성 방식 선택에서 근거 경로와 함께 연결을 추천한다. 그때 결정했으면 다시 묻지 않는다.

## 3. code-agent.json

survey 와 아키텍처 문서로 초안을 만든다. 기술 기본값은 근거와 함께 묶어서 제안하고, 서로 다른 제품 동작을 만드는 선택만 따로 확인한다.

- **referenceDomain** — 복제의 기준이 될 도메인. 계층이 갖춰진 대표 후보를 근거와 함께 추천하고, 다른 표준을 원할 때만 고르게 한다.
- **stages** — survey 의 계층 후보를 의존 순서대로 (예: entity → repository → service → controller → test).
  `exemplars` 는 참조 도메인 디렉토리 기준 상대경로이고 `{Ref}` 는 참조 도메인의 PascalCase 다.
- **`kinds` 는 `["feature", "fix", "refactor"]` 를 기본으로 단다.** 비우면 모든 종류에서 돌지만,
  명시하는 쪽을 기본으로 쓰는 것은 **매니페스트만 읽고도 어떤 종류가 도는지 보이게** 하기 위해서다.
  종류 하나만 도는 단계(예: 신규 도메인 뼈대)가 있으면 거기만 좁힌다.
  한 종류로 돌 단계가 0개면 `code-agent start` 가 그 종류를 받지 않는다 — `manifest check` 가 미리 경고한다.
- **테스트 단계에는 `"kind": "test"` 를 단다.** 테스트가 한 번 돈 뒤에는 hook 이 그 단계의 파일을 얼려,
  실패한 단언을 지워 통과시키는 길을 막는다. 선언하지 않으면 그 보호가 없다 — 검증 출력이 그 사실을 크게 찍는다.
  **fix 의 재현 테스트가 이 단계에서 돈다** — `kinds` 에 `fix` 가 없으면 `plan submit` 이 재현 테스트를 넣을 자리를 찾지 못해 거부한다.
  `refactor` 에서는 이 단계의 **기준 커밋에 이미 있던 파일**이 통째로 보호된다 (고치거나 지우면 막힌다).
  이 보호는 `kinds` 를 보지 않으므로, `kinds` 에서 `refactor` 를 빼도 그대로 걸린다.
- **`kind: "test"` 단계는 제 자리를 밝혀야 한다** — `"scope": "project"` 의 `outputDirs`(예: `["src/test"]`) 또는 `base`.
  둘 다 없으면 코드가 **무엇이 테스트 파일인지 알 수 없어** refactor 의 기존 테스트 보호가 걸리지 않고 fix 의 계획도 거부된다
  (`manifest check` 가 `자리를 밝히지 않았습니다` 로 경고한다). 테스트가 소스 옆에 있는 프로젝트(`*.test.ts` · `_test.go` · pytest)면
  테스트가 실제로 놓이는 디렉토리를 `outputDirs` 로 적는다 — 소스 루트로 물러서지 않는다(그러면 소스 전체가 '기존 테스트' 가 된다).
- **공통 단계** — 아키텍처의 공통 모듈(예외·응답 래퍼·유틸 등)이 도메인 밖에 있으면 `"scope": "project"` 단계를 하나 둔다
  (예: `{ "key": "common", "title": "공통", "scope": "project", "outputDirs": ["src/main/java/com/acme/crm/common"], "kinds": ["feature", "fix", "refactor"], "exemplars": [], "template": "doc/code-agent/stages/common.md" }`).
  없으면 공통 코드를 고쳐야 하는 기능(새 오류 코드 등)의 계획이 경계 검사에서 거부된다. 순서는 도메인 단계보다 앞.
- **build · test · commands** — 빌드 파일에서 (예: `["gradlew", "compileJava", "-q"]`). 탐지 근거를 설정 요약에 포함한다.
  테스트 전략·품질·보안 기준 문서가 적은 이름(`unit` · `check.style` · `sec.deps` …)은 **여기 키로 실재해야** 문서가 게이트를 통과한다.
  `commands` 에는 `build` · `test` · `prepare` 를 키로 쓸 수 없다 — 예약된 이름이라 `loadManifest` 가 거부한다.
- **prepare** (선택) — 통합 검증의 **깨끗한 worktree 에서 `build`·`test` 앞에 한 번** 도는 준비 명령 (예: `["npm", "ci"]` · `["gradlew", "--offline", "dependencies"]`).
  기준 커밋을 뜬 트리에는 의존성처럼 커밋되지 않는 것이 없어서 두는 자리다. 실패하면 `build`·`test` 를 돌리지 않고 통합 검증 전체가 실패한다.
  `check`·`test` 스테이지에서는 돌지 않는다 (거기는 사람이 보고 있는 작업 트리다). 설치가 필요 없는 프로젝트면 **적지 않는다.**
- **docs** — POLICY 는 `architecture` · `conventions` · `testStrategy` · `quality`, KNOWLEDGE 는 `docs.knowledge` 의 세 경로.
- **git.base** — Bash: `git branch` 와 기존 설정으로 정하고 설정 요약에 포함한다. 팀의 기준 브랜치를 알 수 없을 때만 묻는다.

```json
{
  "language": "java",
  "sourceExtensions": [".java"],
  "domainBase": "src/main/java/com/acme/app",
  "domainRoots": ["application"],
  "referenceDomain": "deal",
  "conventions": ["doc/conventions.md"],
  "docs": {
    "architecture": "doc/architecture.md",
    "testStrategy": "doc/test-strategy.md",
    "quality": "doc/quality.md",
    "knowledge": {
      "dataDictionary": "doc/knowledge/data-dictionary.md",
      "apiCatalog": "doc/knowledge/api-catalog.md",
      "businessRules": "doc/knowledge/business-rules.md"
    }
  },
  "git": { "base": "master" },
  "build": ["gradlew", "compileJava", "-q"],
  "test": ["gradlew", "test"],
  "prepare": ["gradlew", "--offline", "dependencies"],
  "commands": { "check.style": ["gradlew", "checkstyleMain"], "sec.deps": ["gradlew", "dependencyCheckAnalyze"] },
  "stages": [
    { "key": "entity", "title": "Entity", "template": "doc/code-agent/stages/entity.md",
      "kinds": ["feature", "fix", "refactor"], "exemplars": ["domain/{Ref}.java"], "outputDirs": ["domain"] },
    { "key": "test", "title": "테스트", "template": "doc/code-agent/stages/test.md",
      "kind": "test", "kinds": ["feature", "fix", "refactor"], "base": "src/test/java/com/acme/app",
      "exemplars": ["domain/{Ref}Tests.java"], "outputDirs": ["domain"] }
  ]
}
```

(`prepare` 는 선택이다 — 준비 명령이 필요 없으면 이 줄을 아예 뺀다. 빈 배열로 두지 않는다.)

`code-agent.json` 을 쓰고 Bash: `code-agent manifest check` — ✗ 가 없어질 때까지 경로·`{Ref}`·referenceDomain 을 고친다.
`- 확인:` 으로 시작하는 줄은 **경고**다(종료 코드 0). 종류별로 돌 단계가 0개거나 `kind: "test"` 단계가 없으면 여기서 알려 준다 —
뜻이 있어 그렇게 둔 것이 아니면 `stages[].kinds` 를 고친다.

## 4. 단계 규칙

`ca-writer` 에게 컨벤션의 계층별 규칙을 단계마다 짧게(10줄 안팎) `doc/code-agent/stages/<key>.md` 로 옮기게 한다 —
구현 단계에서 `code-agent context` 가 이 파일을 그 단계에만 싣는다.

## 5. 마무리

1. Bash: `code-agent docs` — POLICY 4종의 필수 섹션이 전부 ✓ 이고 KNOWLEDGE 3종 파일이 있는지.
2. `{"action":"setup"}` JSON을 접수·작업 중 허용된 `doc/work/<ID>/`에, 작업 ID가 없으면 문서 준비 중 허용된 `doc/`에 작성한다. 문서 세션이 필요하면 `code-agent docs begin`으로 열고 작성한다.
3. 열린 문서 세션을 Bash: `code-agent docs end`로 닫은 뒤 공통 동의 절차의 `prepare`부터 수행한다. `code-agent.json`·POLICY 4종의 링크를 포함한 `summary` 전문을 보여 주고, 전체 문서 확정과 필요한 준비 커밋(최초 커밋 또는 기존 저장소의 도입 파일 반영)을 사용자 질문 하나로 확인받는다. KNOWLEDGE 3종은 확정 대상이 아니다.
4. 승인된 동의 적용이 성공하면 현재 상태를 확인해 원래 접수·작업으로 자동 복귀한다. `/ca-docs`에서 이미 같은 준비를 적용했으면 동의를 반복하지 않는다. 기준 커밋은 동의된 파일 범위만 포함하며 별도로 전체 파일을 커밋하지 않는다.
