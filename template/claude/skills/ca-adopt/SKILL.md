---
name: ca-adopt
description: 레거시 저장소에 code-agent 를 처음 도입한다 — 뼈대 역공학으로 아키텍처·컨벤션 문서와 code-agent.json 을 만든다.
---

너는 **메인 에이전트**다. 문서와 `code-agent.json` 만 쓴다. `code-agent` 명령이 거부하면 사유를 전하고 멈춘다.
뼈대 역공학은 **얕게** 한다 — 구조와 규약만. 도메인 하나하나의 깊은 분석은 작업마다 요구사항 범위로 한다.

## 1. 시작

1. Bash: `code-agent status` — `code-agent.json` 이 이미 있으면 Bash: `code-agent manifest check` 를 보고, 문서만 모자라면 `/ca-docs` 절차로 간다.
2. Bash: `code-agent docs begin`
3. Bash: `code-agent survey`

## 2. 문서

`.claude/skills/ca-docs/SKILL.md` 의 **2. 역공학** 으로 아키텍처·컨벤션을 쓰고, `확인 필요` 로 남은 섹션은 **3. 사용자 입력** 으로 채운다.
경로는 기본값(`doc/architecture.md` · `doc/conventions.md`)을 쓴다. 이미 비슷한 문서가 있으면(survey 의 "이미 있는 문서") 연결할지 먼저 묻는다.

## 3. code-agent.json

survey 와 아키텍처 문서로 초안을 만든다. 추측이 필요한 값은 사용자에게 확인한다.

- **referenceDomain** — 복제의 기준이 될 도메인. 후보 2~3개(계층이 다 갖춰진 것)를 보여 주고 사용자가 고른다.
- **stages** — survey 의 계층 후보를 의존 순서대로 (예: entity → repository → service → controller → test).
  `exemplars` 는 참조 도메인 디렉토리 기준 상대경로이고 `{Ref}` 는 참조 도메인의 PascalCase 다.
- **build · test** — 빌드 파일에서 (예: `["gradlew", "compileJava", "-q"]`). 사용자에게 맞는지 확인한다.
- **git.base** — Bash: `git branch` 로 후보를 보고 확인한다 (기본 master).

```json
{
  "language": "java",
  "sourceExtensions": [".java"],
  "domainBase": "src/main/java/com/acme/app",
  "domainRoots": ["application"],
  "referenceDomain": "deal",
  "conventions": ["doc/conventions.md"],
  "docs": { "architecture": "doc/architecture.md" },
  "git": { "base": "master" },
  "build": ["gradlew", "compileJava", "-q"],
  "test": ["gradlew", "test"],
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

1. Bash: `code-agent docs` — 필수 섹션이 전부 ✓ 인지.
2. Bash: `code-agent docs end`
3. 사용자에게 알린다: `code-agent.json` 과 두 문서를 **직접 읽고 확인한 뒤, 별도 터미널에서**
   `code-agent confirm doc architecture` · `code-agent confirm doc conventions`. 그리고 전부 커밋한다.
