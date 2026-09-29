---
name: ca-adopt
description: 레거시 저장소에 code-agent 를 처음 도입한다 — 뼈대 역공학으로 POLICY 4종·KNOWLEDGE 3종 문서와 code-agent.json 을 만든다.
---

너는 **메인 에이전트**다. 문서와 `code-agent.json` 만 쓴다. `code-agent` 명령이 거부하면 사유를 전하고 멈춘다.
뼈대 역공학은 **얕게** 한다 — 구조와 규약만. 도메인 하나하나의 깊은 분석은 작업마다 요구사항 범위로 한다.

## 1. 시작

1. Bash: `code-agent status` — `code-agent.json` 이 이미 있으면 Bash: `code-agent manifest check` 를 보고, 문서만 모자라면 `/ca-docs` 절차로 간다.
2. Bash: `code-agent docs begin`
3. Bash: `code-agent survey`

## 2. 문서

`.claude/skills/ca-docs/SKILL.md` 를 그대로 따른다 — 문서마다 **기본으로 생성 / 대화로 생성 / 기존 문서 연결** 을 추천과 함께 묻는다.

- **POLICY 4종** — 아키텍처 · 코드 컨벤션 · 테스트 전략 · 품질·보안 기준. `확인 필요` 로 남은 섹션은 **3. 대화로 생성** 으로 채운다.
  테스트 전략과 품질·보안 기준은 도구·명령을 survey 의 도구 후보와 CI 설정에서 초안으로 잡고,
  수준별 필수 여부·통과 기준·임계·차단 정책만 사용자에게 묻는다. **적은 명령 이름은 3 의 `code-agent.json` 에 같이 등록한다** — 이름이 매니페스트에 없으면 게이트가 막는다.
- **KNOWLEDGE 3종** — 데이터 사전 · API 목록은 기본으로 생성(각각 상위 30·40개), 업무 규칙·용어집은 **빈 뼈대**가 추천이다.
  비어 있어도 작업을 막지 않는다. 확정 절차도 없다.

경로는 기본값(`doc/architecture.md` · `doc/conventions.md` · `doc/test-strategy.md` · `doc/quality.md` · `doc/knowledge/*.md`)을 쓴다.
이미 비슷한 문서가 있으면(survey 의 "이미 있는 문서") 연결할지 먼저 묻는다.

## 3. code-agent.json

survey 와 아키텍처 문서로 초안을 만든다. 추측이 필요한 값은 사용자에게 확인한다.

- **referenceDomain** — 복제의 기준이 될 도메인. 후보 2~3개(계층이 다 갖춰진 것)를 보여 주고 사용자가 고른다.
- **stages** — survey 의 계층 후보를 의존 순서대로 (예: entity → repository → service → controller → test).
  `exemplars` 는 참조 도메인 디렉토리 기준 상대경로이고 `{Ref}` 는 참조 도메인의 PascalCase 다.
- **공통 단계** — 아키텍처의 공통 모듈(예외·응답 래퍼·유틸 등)이 도메인 밖에 있으면 `"scope": "project"` 단계를 하나 둔다
  (예: `{ "key": "common", "title": "공통", "scope": "project", "outputDirs": ["src/main/java/com/acme/crm/common"], "kinds": ["feature"], "exemplars": [], "template": "doc/code-agent/stages/common.md" }`).
  없으면 공통 코드를 고쳐야 하는 기능(새 오류 코드 등)의 계획이 경계 검사에서 거부된다. 순서는 도메인 단계보다 앞.
- **build · test · commands** — 빌드 파일에서 (예: `["gradlew", "compileJava", "-q"]`). 사용자에게 맞는지 확인한다.
  테스트 전략·품질·보안 기준 문서가 적은 이름(`unit` · `check.style` · `sec.deps` …)은 **여기 키로 실재해야** 문서가 게이트를 통과한다.
- **docs** — POLICY 는 `architecture` · `conventions` · `testStrategy` · `quality`, KNOWLEDGE 는 `docs.knowledge` 의 세 경로.
- **git.base** — Bash: `git branch` 로 후보를 보고 확인한다 (기본 master).

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
  "commands": { "check.style": ["gradlew", "checkstyleMain"], "sec.deps": ["gradlew", "dependencyCheckAnalyze"] },
  "stages": [
    { "key": "entity", "title": "Entity", "template": "doc/code-agent/stages/entity.md",
      "kinds": ["feature"], "exemplars": ["domain/{Ref}.java"], "outputDirs": ["domain"] },
    { "key": "test", "title": "테스트", "template": "doc/code-agent/stages/test.md",
      "kinds": ["feature"], "base": "src/test/java/com/acme/app",
      "exemplars": ["domain/{Ref}Tests.java"], "outputDirs": ["domain"] }
  ]
}
```

`code-agent.json` 을 쓰고 Bash: `code-agent manifest check` — ✗ 가 없어질 때까지 경로·`{Ref}`·referenceDomain 을 고친다.

## 4. 단계 규칙

`ca-writer` 에게 컨벤션의 계층별 규칙을 단계마다 짧게(10줄 안팎) `doc/code-agent/stages/<key>.md` 로 옮기게 한다 —
구현 단계에서 `code-agent context` 가 이 파일을 그 단계에만 싣는다.

## 5. 마무리

1. Bash: `code-agent docs` — POLICY 4종의 필수 섹션이 전부 ✓ 이고 KNOWLEDGE 3종 파일이 있는지.
2. Bash: `code-agent docs end`
3. 사용자에게 알린다: `code-agent.json` 과 POLICY 4종을 **직접 읽고 확인한 뒤, 별도 터미널에서** 네 번 —
   `code-agent confirm doc architecture` · `code-agent confirm doc conventions` ·
   `code-agent confirm doc test-strategy` · `code-agent confirm doc quality`.
   KNOWLEDGE 3종은 확정하지 않는다. 그리고 전부 커밋한다.
