---
name: ca-adopt
description: 레거시 저장소에 code-agent 를 처음 도입한다 — code-agent.json 과 필수 문서를 갖춘다.
---

> 뼈대 역공학으로 `code-agent.json` · 아키텍처 · 컨벤션 초안을 만드는 절차는 P2 에서 들어온다. 지금은 안내만 한다.

1. Bash: `code-agent status` 를 보여 준다.
2. `code-agent.json` 이 없으면 필요한 값을 알려 준다: `domainBase` · `domainRoots` · `referenceDomain` ·
   `stages`(key · title · template · exemplars · outputDirs) · `build` · `test` · `conventions` · `docs.architecture` · `git.base`.
3. 이어서 `/ca-docs` 로 필수 문서를 점검한다.
