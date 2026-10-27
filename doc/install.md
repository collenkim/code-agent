# 설치 — npm 전역 · 단일 실행 파일

`init`은 진행 중인 작업을 유지하면서 호스트 파일만 설치한다. `code-agent.json`은 도입 절차에서 준비하며 설치 명령이 임의로 생성하지 않는다. 다른 브랜치에 남은 작업은 현재 브랜치의 도입을 막지 않는다. [브랜치별 재개](usage.md#브랜치를-바꾸어-작업하기)를 따른다.

`code-agent init`은 두 호스트의 지침·hook·MCP 설정을 모두 준비한다. 기본은 현재 호스트 단독이고, 호스트 밖 터미널에서 `code-agent execution claude|codex|both`로 단독·교차 검증을 선택한다. 인자 없이 조회할 수 있다. 호환 인자 `init --host`를 주어도 두 호스트를 준비한다. Codex의 설치 경로·사용자 응답·훅 신뢰·갱신·제거는 [Codex 연동](codex.md)에 정리했다. 아래 Claude 전용 경로와 훅 수는 Claude 설치 기준이다. 기준 커밋에는 설치 목록 `.code-agent/hosts.json`과 실행 정책 `.code-agent/execution.json`이 포함된다.

> 흐름과 무엇을 치는가는 [usage.md](usage.md), 설계와 근거는 [design.md](design.md).
> 이 문서는 **어디에 깔고 · 무엇이 생기고 · 어떻게 점검하고 · 어떻게 지우는가**다.

설치 후 관리 실행의 주 호스트는 `execution both --main claude|codex`로 선택할 수 있다. master 요청이 실행 방식을 고르면 그 실행과 그 실행이 연 작업에는 요청의 선택이 먼저이며 프로젝트 설정은 바뀌지 않는다([master 실행 세션의 규칙](master-control.md#11-master-실행-세션의-규칙)). 토큰 소진 등으로 기존 작업을 다른 호스트에 넘길 때는 실행을 먼저 중지하고 `execution --json` 조회 후 `execution <호스트> --handoff`를 사용한다. 열린 동의·미소비 응답은 원래 채널에서 처리해야 한다. [호스트 전환 인계](master-control.md#호스트-전환-인계)를 따른다. 대시보드(master-agent) 연결은 PC마다 한 번 호스트 밖 터미널에서 `code-agent master trust --controller dashboard`로 신뢰를 등록한 뒤, 프로젝트마다 대시보드에서 사람이 확인해 연다([페어링](master-control.md#pc-신뢰와-대시보드-페어링)).

`code-agent init`은 프로젝트에 절차 파일과 hook을 설치하고 종료한다. 실제 실행은 같은 프로젝트에서 Claude의 `/ca-request <요구사항>` 또는 Codex의 `$ca-request <요구사항>`으로 시작한다. 호스트가 프로젝트 스킬·서브에이전트를 읽으므로 별도 에이전트 등록이나 상주 서버는 필요 없다. 사용할 호스트의 설치·인증, Git, 개발할 프로젝트의 실행 환경은 별도로 준비한다.

---

`.codex/config.toml`은 이 PC의 실행 파일·프로젝트 경로와 사용자 설정을 담아 `.gitignore` 및 준비 커밋 제외 대상이다. 각 PC에서 `init --host codex` 또는 `update --templates-only --host codex`로 등록한다. 이미 추적 중이면 사람이 `git rm --cached -- .codex/config.toml`로 추적만 해제하고 그 삭제를 커밋한다. 설치는 기존 Git index와 블록 밖 사용자 설정을 바꾸지 않는다.

별도 패키지 설치나 서버 수동 실행은 필요 없다. Codex 선택 UI용 로컬 MCP 서버는 프로젝트 `.codex/config.toml`에 자동 등록되며 Codex가 stdio로 실행한다. 새 버전은 `code-agent update`(Git 소스 설치) 또는 패키지 관리자(npm 패키지)로 설치하고, 프로젝트마다 진행 중인 일이 없을 때 적용된다([5절](#5-code-agent-update--갱신)). 호스트는 종료하지 않는다 — 다시 열어야 하는 변경이 있으면 적용 보고가 그것만 알린다. `code-agent version`과 `doctor`로 적용 버전과 설치 상태를 확인한다. 이미 진행 중인 작업은 그 작업의 증거로 재개한다.

작업 임대(`.code-agent/lease.json`)·이 PC 의 적용 버전(`runtime.json`) 같은 개인 기록은 적용이 `.gitignore` 블록에 줄을 더한다 — 적용 전에는 미추적 파일로 보이지만 `.code-agent/` 아래라 게이트·동의 스냅샷에는 걸리지 않는다(그대로 둬도 무해하다). 진행 중인 작업이 있으면 적용은 설치 파일(`.gitignore` 블록·스킬·에이전트 사본·hook 설정)을 바꾸지 않고 예약한다(`update --templates-only`는 종료 코드 3) — 바뀐 설치 파일이 그 작업의 계획 밖 변경이 되어 검증·반영을 막지 않게 한다. 적용으로 바뀐 설치 파일은 다음 작업 전에 준비 커밋(setup/baseline 확인)으로 반영한다.

CLI와 템플릿(스킬·에이전트 정의)은 한 릴리스로 함께 적용된다 — Codex 사본도 같은 템플릿에서 생성된다. 호스트를 다시 열어야 하는 변경(Codex hook 등록·MCP 설정·새 에이전트 파일)은 적용 보고가 따로 알린다. 이전 입력 계약으로 시작한 작업은 그 계약을 유지하고 새 기본 작업은 contextVersion 4를 사용한다. `doctor`의 설치 점검은 실제 연동 성공을 인증하지 않는다.

## 목차

- [1. 두 가지 설치](#1-두-가지-설치)
- [2. 단일 실행 파일 만들기](#2-단일-실행-파일-만들기)
- [3. `code-agent init` — 저장소에 생기는 것](#3-code-agent-init--저장소에-생기는-것)
- [4. `code-agent doctor` — 점검](#4-code-agent-doctor--점검)
- [5. `code-agent update` — 갱신](#5-code-agent-update--갱신)
- [6. 지우기](#6-지우기)

---

## 1. 두 가지 설치

| | npm 전역 | 단일 실행 파일 |
|---|---|---|
| 치는 것 | `npm install -g <사내 저장소>/code-agent` | 파일 하나를 PATH 에 둔다 |
| 전제 | Node 24.19.0 이상 24.x (`package.json` 의 `engines` 에 적혀 있어 npm 이 미리 경고한다) | code-agent용 별도 Node 설치는 **불필요** — 실행 파일 안에 들어 있다. Claude Code·Git·프로젝트 실행 환경은 필요하다. 단, **만드는** PC 는 Node 24.19.0 이상 24.x ([2절](#2-단일-실행-파일-만들기)) |
| 구성 | CLI·템플릿·npm 의존성 | Node 런타임·번들 CLI·템플릿을 포함한 파일 하나 |
| OS | 하나로 전부 | **OS 별로 따로 만든다** ([2절](#2-단일-실행-파일-만들기)) |
| 갱신 | 로컬 Git 소스 연결은 `code-agent update`(릴리스 저장소에 설치한 뒤 적용). npm 패키지는 패키지 관리자로 설치 — 다음 작업을 열 때 그 사본을 적용한다 | 새 파일로 교체한 뒤 `update --templates-only` |

LangGraph 실행 기록은 Node 내장 SQLite를 사용하므로 별도 DB 서버나 실행용 네이티브 SQLite 모듈이 필요 없다. 공식 saver의 전이 의존성에는 `better-sqlite3`가 포함되어 npm 기본 설치 시 설치 스크립트가 실행될 수 있다. 소스에서 이를 생략하려면 `npm ci --ignore-scripts` 후 `npm run build`를 실행한다. Node 범위와 LangGraph 패키지 버전은 master-agent와 맞추며 정확한 의존성은 `package.json`·`package-lock.json`을 따른다.

어느 쪽이든 **저장소에 들어가는 것은 같다.** `init`은 스킬 18개(보조 문서 15개 포함), 서브에이전트 8개와 hook 9개를 등록한다. hook은 도구 경계를 검사하는 PreToolUse(`code-agent hook`) 1개, AskUserQuestion의 질문·응답을 관찰하는 PreToolUse·PostToolUse(`code-agent consent-event`) 2개, Stop(`code-agent stop`) 1개, ca-reviewer의 SubagentStart·SubagentStop(`code-agent review-event`) 2개, 계획 담당의 SubagentStart·SubagentStop(`code-agent planning-event`) 2개, 대화 시작·재개·압축·비우기 뒤 진행 상태를 붙이는 SessionStart(`code-agent session-event`) 1개다. PreToolUse matcher 는 쓰기·셸·읽기 도구와 MCP 도구(`mcp__.*`)를 넘긴다. Codex 는 공통 hook 6개(도구 실행 전·사용자 메시지·담당 시작·담당 종료·턴 종료·세션 시작)를 쓰고, PreToolUse 항목만 비Windows 명령을 `… codex-event || exit 2`로 감싼다. Windows 용 `commandWindows`는 `cmd /c code-agent codex-event`에 종료 코드를 넘기는 꼴이다(Windows PowerShell 5.1 이 exit 2 를 바꾸지 않게 — [Codex 연동](codex.md)). 이전 버전으로 설치한 저장소는 `code-agent update --templates-only --host codex`로 새 꼴이 된다. Codex 는 프로젝트와 hook 을 신뢰해야 hook 을 돌린다 — Codex 대화형 세션에서 이 저장소를 열어 프로젝트를 신뢰하고 'Hooks need review' 화면에서 hook 을 검토·신뢰한다(`codex exec`는 신뢰되지 않은 hook 을 알리지 않고 건너뛴다). `init`은 설치 완료와 Codex 실행 준비(준비 완료·신뢰 확인 필요·hook 검토 필요·신뢰 확인 실패 등)를 나눠 알리고, 신뢰한 뒤에는 `code-agent doctor --host codex`로 다시 확인한다. PATH에서 풀리므로 `.claude/settings.json`을 팀이 공유할 수 있다.

| 누구 | 무엇을 |
|---|---|
| 팀 대부분 | **npm 전역.** Node 가 이미 있고 갱신이 한 줄이다 |
| Node 를 깔 수 없는 PC · 고정된 CI 이미지 | **단일 실행 파일** |
| code-agent 자체를 고치는 사람 | 이 저장소에서 `npm link` 하고, 대상 저장소에 `code-agent init --cli <이 저장소>/dist/agent/cli.js` — hook 이 PATH 대신 로컬 빌드를 부른다. 고칠 때마다 `npm run build` |

`--cli` 로 깐 hook 명령에는 **그 PC 의 경로**가 박힌다. 개발용이라 그대로 커밋하지 않는다 —
`code-agent doctor` 가 `PreToolUse hook: node "…" hook` 으로 무엇이 박혀 있는지 찍는다.

---

## 2. 단일 실행 파일 만들기

```
npm run build:bin
```

**만드는 Node 는 24.19.0 이상 24.x 이어야 한다** — npm 실행과 같은 지원 범위다. `node:sea.getAssetKeys` 가 없으면
안에 든 템플릿을 읽지 못하는 바이너리가 나온다(자기가 단일 실행 파일인 줄 모르고 없는 패키지 폴더를 읽으려 한다).
빌드 스크립트가 0단계에서 막는다. *쓰는* Node 는 필요 없다 — 실행 파일 안에 들어 있다.

산출물은 `dist-bin/code-agent.exe` (Windows) · `dist-bin/code-agent` (macOS · Linux).
`dist-bin/` 은 `.gitignore` 에 있다 — 커밋하지 않는다.

`scripts/build-bin.js` 가 하는 일 (Node SEA — [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)).

| # | 무엇 | 왜 |
|---|---|---|
| 0 | Node 가 `>=24.19.0 <25` 이고 `node:sea.getAssetKeys` 가 있는가 | 지원 범위 밖이거나 자원 API 가 없으면 산출물을 지우기 전에 멈춘다 |
| 1 | `tsc` | 타입이 깨진 채로 바이너리를 내지 않는다 |
| 2 | esbuild 로 `src/agent/cli.ts` 를 CommonJS 한 파일로 (zod 포함, `--external:node:sea`) | SEA 안에서는 상대경로 `require()` 가 되지 않는다 — 빌트인만 풀린다 |
| 3 | `dist-bin/sea-config.json` — `template/` 아래 전 파일 + `package.json` 을 **자원(assets)** 으로 | 실행 파일 안에 스킬·에이전트·CLAUDE 블록이 함께 들어간다 |
| 4 | `node --experimental-sea-config dist-bin/sea-config.json` | `prep.blob` |
| 5 | **지금 도는 `node` 실행 파일을 복사** | ← 크로스 컴파일이 안 되는 이유 |
| 6 | `postject … --sentinel-fuse NODE_SEA_FUSE_…` 로 blob 주입 | 이 플래그가 없으면 `Could not find the sentinel` 로 실패한다 |

- **바이너리는 OS 별이다.** 5단계가 *그 머신의* node 를 복사하므로 Windows·macOS·Linux 각각에서 한 번씩 돌린다.
- `useSnapshot` · `useCodeCache` 는 **false** 다 — 코드 캐시는 빌드 Node 와 주입 대상 Node 를 묶고, 스냅샷은 최상위에서 쓸 수 있는 API 를 제한한다. 지금 얻을 것이 없다.
- 실행 파일 안에서 템플릿을 읽는 자리는 `src/agent/assets.ts` 하나다. npm 설치면 패키지 폴더에서, 단일 실행 파일이면 `node:sea` 의 자원에서 읽고 **키는 같다**(`template/claude/skills/ca-plan/SKILL.md`).
- 단일 실행 파일의 `process.execPath`는 code-agent 자신이라 다른 스크립트를 돌리지 못한다. 그래서 교차 검증이 띄울 다른 호스트가 `.js` 진입점(npm 설치, `.js`를 가리키는 `CODE_AGENT_*_BIN`)이면 PATH 의 `node` 실행 파일로 돌리고(`hosts.ts` `scriptRunner` — PATH 디렉터리마다 보고 앞 디렉터리의 `node.cmd` 셰임(mise·nodist 류)은 건너뛴다), 실행 파일 변수가 `.js`를 가리키는데 PATH 에 `node` 실행 파일이 없으면 설정 오류(게이트 막힘)다. 그래서 단일 실행 파일에서 실행 파일 변수에는 `.exe`를 지정한다(`.js`는 PATH 에 `node` 실행 파일이 있을 때만). Codex 샌드박스 셸에서 claude 를 띄우기 전의 연결 확인은 자식 프로세스 없이 같은 프로세스에서 한다.

### 코드 서명 — 아는 단계로 둔다

인증서가 이 저장소에 없어 자동화하지 않았다. 사내에 배포할 때 사람이 한다.

| OS | 언제 | 무엇 |
|---|---|---|
| Windows | 주입 **뒤** | 주입이 Authenticode 서명을 깨뜨린다(postject 의 `The signature seems corrupted!` 경고는 정상이다). `signtool sign /fd SHA256 /tr <타임스탬프 서버> /td SHA256 dist-bin\code-agent.exe`. 서명하지 않으면 받는 사람에게 SmartScreen 경고가 뜬다 |
| macOS | 주입 **전·뒤** | 빌드 스크립트가 주입 전 `codesign --remove-signature`, 주입 뒤 `codesign --sign -` (ad-hoc) 까지 한다. 배포하려면 실제 ID 로 다시 서명하고 notarize 한다 |
| Linux | — | 서명 단계 없음 |

### 자족적이지 **않은** 곳 — `NODE_OPTIONS`

단일 실행 파일도 Node 의 환경 변수를 그대로 따른다. `NODE_OPTIONS="--require ./x.js" code-agent status` 면
그 코드가 CLI 보다 **먼저** 돈다 (실측 확인. `-e` 같은 argv 는 무시된다 — 위험한 것은 환경이다).
npm 설치도 같지만, 이 바이너리에서 더 중요한 이유가 있다: `code-agent hook` 은 Claude Code 가 **모든 도구 호출마다**
띄우는 판정 지점이라, 그 환경 변수를 넣을 수 있는 사람은 게이트 안에서 코드를 돌릴 수 있다
(`.claude/settings.json` 의 `env` 블록도 그 길이고, PreToolUse 는 그 파일을 따로 지키지 않는다).
게이트를 믿는 환경에서는 이 변수를 통제한다.

---

## 3. `code-agent init` — 저장소에 생기는 것

첫 설치는 스킬·에이전트 사본의 기준 해시도 `.code-agent/templates.json`에 남긴다. 설치한 저장소에서 `init`을 다시 실행하면 사람이 고친 사본을 보존하고 빠진 hook을 복구한다. 기준 기록이 없는 이전 설치에서도 번들과 다른 사본은 유지한다. 보존한 파일의 새 번들은 `.code-agent/template-conflicts/` 아래 같은 경로에서 확인해 병합한다.

```
cd <프로젝트>
code-agent init
claude
```

| 무엇 | 자리 | 커밋 |
|---|---|---|
| 스킬·에이전트 (26개 — 스킬 18 · 에이전트 8) | `.claude/skills/ca-*` · `.claude/agents/ca-*` | O |
| hook | Claude 9개·Codex 6개 — [등록·matcher·출력 정본](process-flow.md#5-hook-등록표) | O |
| 절차 블록 | `CLAUDE.md` 의 `<!-- code-agent:start -->` ~ `end` 사이 | O |
| 제외 목록 | `.gitignore` 의 `# code-agent:start` ~ `end` 사이 | O |
| 버전 고정 | `.code-agent/version` | O |

표시된 **블록 안쪽만** 바꾼다. `settings.json` 의 다른 hook·설정과 `CLAUDE.md` 의 블록 밖은 건드리지 않는다.
설치한 파일은 커밋해 팀과 공유한다.

작업의 최종 반영에서는 `.code-agent/version`, `.code-agent/models.json`·`.code-agent/codex-models.json`, `.code-agent/approvals/docs.jsonl` 중 존재하는 파일을 실제 커밋 경로 목록에 표시하고 함께 커밋한다. 이 설정·확정 파일은 반영 후 별도로 수동 커밋하지 않아도 된다. 같은 화면에는 작업 파일·증거와 선택한 KNOWLEDGE 경로도 표시한다. 그 밖의 설치 설정이나 소스를 일괄 추가하는 것은 아니므로, 별도의 도입·설정 변경은 그 범위에 맞춰 검토한다.

```
code-agent 를 설치했습니다 — C:\work\shop
  - 스킬·에이전트 26개 · 보조 문서 15개: .claude/skills/ca-*, .claude/agents/ca-*
  - 모델·추론 강도: 판단(analyst·critic·reviewer) opus/high · 실행(surveyor·explorer·writer·implementer·tester) sonnet/medium — code-agent model 로 확인·변경
  - hook: .claude/settings.json → PreToolUse code-agent hook · 질문 Pre/PostToolUse code-agent consent-event · Stop code-agent stop · SubagentStart/Stop code-agent review-event · 계획 SubagentStart/Stop code-agent planning-event · SessionStart code-agent session-event
  - CLAUDE.md: code-agent 블록 생성
  - .gitignore: 개인 진행 상태·세션 확인 제외 (.code-agent/active.json, docs-session.json, request-session.json, log/, consents/, lease.json)
  - 버전 고정: .code-agent/version = 1.0.0
```

Claude Code 입력창에서 `/ca-request <요구사항>`으로 시작한다. 접수한 원문을 저장한 뒤 공통 문서·설정이 없으면 `/ca-adopt`·`/ca-docs`로 준비하고 같은 접수로 돌아온다. 최초 `setup` 확인은 POLICY 4종 확정과 필요한 준비 커밋의 파일 목록을 함께 보여 준다. 기존 저장소에서도 미커밋 도입 파일이 있으면 현재 브랜치에 준비 커밋을 추가한다. 이미 반영된 파일은 다시 커밋하지 않으며, 준비가 끝난 프로젝트는 이 확인을 작업마다 반복하지 않는다. 작업 기준 브랜치에도 도입 커밋이 있어야 하며, 없으면 `start`가 전환 전에 멈추고 기준 지정·반영 방법을 안내한다.

이후 요구사항·계획·결과 확인도 같은 Claude Code 선택 화면에서 받고 자동으로 이어간다. 별도 터미널은 필수가 아니며 `/ca-next`는 중단하거나 다시 연 세션에서 재개할 때 사용한다. 준비만 먼저 할 때는 `/ca-adopt`를 직접 사용할 수 있다.

---

## 4. `code-agent doctor` — 점검

진행 중인 작업이 있어도 점검할 수 있다. 종료 여부는 [CLI 종료 코드](usage.md#cli-종료-코드)를 따른다.

```
code-agent doctor — C:\IdeaProjects\code-agent-p8

  ✓ 런타임: Node v24.19.0
  ✓ git: git version 2.50.1.windows.1
  ✓ PATH 의 code-agent: npm 설치/링크 …\npm\code-agent.CMD → …\node_modules\code-agent\dist\agent\cli.js
  · 지금 도는 것: …\dist\agent\cli.js — PATH 의 code-agent 는 다른 설치본입니다 (…)
  ✓ git 저장소: C:\IdeaProjects\code-agent-p8
  ✗ PreToolUse hook: 없습니다
      → code-agent init
  …
✗ 7개: PreToolUse hook · Stop hook · 스킬·에이전트 · … — 위의 → 를 따라 고치세요.
```

표시는 셋이다.

| 표시 | 뜻 |
|---|---|
| `✓` | 확인됐다 |
| `✗` | **막는다** — 다음 줄의 `→` 가 고치는 법이다 |
| `·` | 알리기만 한다 |

TTY가 없는 CI에서도 알림만으로 점검 실패가 되지는 않는다.

### 검사

| 이름 | ✓ 는 | ✗ 면 |
|---|---|---|
| 런타임 | Node 24.19.0 이상 24.x (단일 실행 파일의 내장 Node 도 검사) | 지원 범위의 Node 를 설치하거나 그 버전으로 만든 단일 실행 파일을 쓴다 |
| git | `git --version` 이 답한다 | PATH 에 git 을 넣는다 — 브랜치·기준 커밋·반영이 git 을 쓴다 |
| PATH 의 code-agent | PATH 에서 찾았다. 단일 실행 파일인지 npm 설치/링크인지(그 경우 푼 `cli.js` 경로까지) 함께 찍는다 | hook 명령이 풀리지 않는다. `npm i -g <저장소>` 또는 바이너리를 PATH 에 둔다 |
| 지금 도는 것 | (`·`) PATH 의 것과 지금 도는 진입점이 다를 때만 나온다 | — 막지 않는다. 고친 코드가 왜 반영되지 않는지 볼 때 이 줄을 본다 |
| 적용 버전 | 이 프로젝트의 적용 버전(고정이 없으면 진입점 번들)과 적용 대기를 찍는다 | `runtime.json`을 읽지 못하거나 적용 버전이 릴리스 저장소에 없다 — `code-agent version`으로 확인하고 `update`로 다시 설치하거나 `update --bundled`로 고정을 푼다 |
| git 저장소 | `.git` 이 있다 | 공통 문서 준비 후 같은 세션의 `setup` 확인으로 최초 커밋 또는 기존 저장소의 도입 커밋을 만든다. 직접 TTY에서는 `code-agent setup baseline`도 가능하다. 기존 Git 이력은 유지한다 |
| hook 설정 파일 | `.claude/settings.json` 이 JSON 으로 읽힌다. 읽히면 이 줄은 나오지 않는다 | 깨진 자리를 그대로 찍는다. **고치기 전에는 `init`·`update` 도 멈춘다** — 그래서 hook 검사보다 먼저 본다 |
| hook 등록 9개 | `hook` 1개, `consent-event` 2개, `stop` 1개, `review-event` 2개, `planning-event` 2개, `session-event` 1개의 명령과 matcher를 확인한다. consent는 AskUserQuestion, review는 ca-reviewer, planning은 ca-analyst·ca-explorer·ca-writer·ca-critic에 연결된다 | 설치 방식에 맞게 `update` 또는 `update --templates-only` 후 Claude Code 재시작. 개발 CLI 경로 오류는 `code-agent init --cli <경로>`. 옛 matcher(MCP·읽기 도구 없음)는 ✗ 로 짚는다 |
| Codex 이벤트(Codex 설치 — 이벤트마다 한 줄) | `.codex/hooks.json`의 그 이벤트에 `codex-event` 명령이 있고, Windows 명령(`commandWindows`)이 이 버전의 꼴과 같다. `commandWindows`가 없어도 Codex 가 돌리는 `command`가 이 꼴과 같으면(`--cli` 설치의 Stop·Subagent·SessionStart) 맞는 것으로 본다 | 우리 이벤트가 하나도 없으면 `code-agent init`. 다른 이벤트는 있는데 일부만 없거나(이벤트가 늘기 전의 옛 설치 — SessionStart 등) Windows 명령만 다르면 `code-agent update --templates-only --host codex`(작업 중이면 작업이 끝난 뒤) |
| Codex 프로젝트 신뢰 | 관리 실행과 같은 실행 파일·`CODEX_HOME`으로 Codex app-server 에 묻는다 — `config/read`가 이 저장소 `.codex`의 프로젝트 설정을 켰다. 물은 Codex 버전·실행 파일·`CODEX_HOME`을 함께 찍는다. 상위 폴더만 신뢰한 경우도 Codex 가 켜지 않으면 신뢰 필요다 | (`·`) 신뢰 필요 → Codex 대화형 세션에서 이 저장소를 열어 프로젝트를 신뢰한 뒤 다시 doctor. 조회 실패·Codex 실행 파일 없음·Codex 갱신 필요(이 판정을 지원하지 않는 버전)도 `·`로 그 사유를 찍는다. Codex 샌드박스 안에서는 묻지 않고 터미널에서 확인하라고 알린다. 앞의 Codex 설치 줄이 막히면 '설치 복구 뒤 확인'이다 |
| Codex 훅 신뢰 | `hooks/list`에서 code-agent hook 6개가 이 저장소 `.codex/hooks.json`에서 로드돼 신뢰·켜짐 상태다 | (`·`) 검토 필요 → 알린 hook 만(검토 전·바뀜·꺼짐) Codex 대화형 세션의 `/hooks`('Hooks need review')에서 검토·신뢰한다. 프로젝트를 신뢰하기 전에는 Codex 가 hook 을 읽지 않으므로 '프로젝트 신뢰 뒤 확인'이다. 사용자 설정에서 hook 기능을 끈 경우(`[features] hooks = false`)도 `·`다. (✗) Codex 가 이 저장소의 hook 을 로드하지 못했다(빠짐·읽기 오류) → `code-agent init` |
| Codex 미판정 도구(`·`) | 작업·세션 중 Codex PreToolUse 가 판정하지 않은 도구 이름과 횟수(`.code-agent/log/codex-tools.json` — 하위 에이전트 조율 도구 `collaboration…`은 세지 않는다) | 파일을 쓰는 도구라면 hook 판정 밖이다 — code-agent 를 갱신하거나 사람에게 알린다 |
| 설치 버전 | (`·`) `.code-agent/version` 이 지금 도는 버전과 다르면 알린다 | — `code-agent update`. 막지 않는다 |
| 스킬·에이전트 | 설치된 `ca-*` 전부가 지금 버전의 번들과 같다 (줄바꿈과 머리말의 `model:`·`effort:` 줄은 빼고 본다 — 모델·강도는 '에이전트 모델' 줄이 본다) | **하나도 없으면** `설치되지 않았습니다` → `code-agent init`. 일부가 없거나 다르면 각각 최대 5개까지 → `code-agent update` |
| 에이전트 모델 | 설치된 정의 파일 머리말의 `model`·`effort`가 설정(`.code-agent/models.json`, 없으면 역할 기본값)과 같다. 판단·실행 기본값과 바꾼 역할을 함께 찍고, 일부만 설치되어 있으면 일치한 파일 수를 붙인다. 정의 파일이 하나도 없으면 대조하지 않고 `·`로 알린다(설치 여부는 `스킬·에이전트` 줄이 본다). 두 호스트 설치면 `Codex 에이전트 모델` 줄도 찍는다(TOML 어긋남은 `Codex 스킬·에이전트`가 본다) | 다르면 역할별로 최대 5개 → `code-agent update --templates-only`. `models.json`이 깨졌으면 그 사유 → 고치거나 지운 뒤 `update --templates-only`. **고치기 전에는 `init`·`update`가 파일을 하나도 쓰지 않고 멈춘다** |
| 이 버전에 없는 스킬·에이전트 | (`·`) 남아 있는 `ca-*` 가 없으면 이 줄은 나오지 않는다 | — 막지 않는다. 이름이 바뀌었거나 빠진 것이라 손으로 지운다 (사람이 만든 `ca-` 스킬과 가릴 수 없어 자동 삭제하지 않는다) |
| 번들 자원 | 번들을 읽지 못할 때만 나온다 (24.8 미만으로 만든 바이너리) | `npm run build:bin` 을 Node 24.19.0 이상 24.x에서 다시 돌린다. **이 검사가 서도 doctor 는 끝까지 찍는다** — 깨진 설치를 설명할 유일한 명령이 doctor 다 |
| 매니페스트 | `code-agent.json` 이 참조 파일을 실제로 찾는다. 파일이 없으면 `·` (도입 전) | 형식 오류면 어느 키가 왜 틀렸는지까지 그대로 (머리말만 남기지 않는다) → `code-agent manifest check` |
| 아키텍처 · 코드 컨벤션 · 테스트 전략 · 품질·보안 기준 | 넷 다 확정됐다 | `missing-file` · `missing-sections`는 문서를 보완한다. `unconfirmed` · `stale`는 같은 세션의 `setup` 또는 `docs` 확인으로 확정한다 |
| 사용자 키 파일 | POSIX: `~/.code-agent/credentials.json` 의 권한이 좁다. Windows: (`·`) 자리와 ACL 안내 | `chmod 700 ~/.code-agent && chmod 600 ~/.code-agent/credentials.json` |
| 터미널 | 직접 CLI의 `approve` · `confirm` · `deliver` · `plugin add`에 필요한 TTY 여부 | (`·`) TTY가 없어도 같은 세션의 consent 확인을 사용할 수 있다. 비대화형 파이프 응답만으로는 승인되지 않는다 |

### 같은 세션 확인과 직접 TTY 명령

기본 경로는 `code-agent consent prepare --action <동작> --for claude`(또는 `<action.json>`) → 반환된 `toolInput` 전체로 `AskUserQuestion` 호출 → PreToolUse·PostToolUse hook 관찰 → `code-agent consent finish <ID>`(승인된 요청만 그 자리에서 적용)다. `consent status <ID>` 확인 뒤 `consent apply <ID>`로 나눠도 같다. `questions`와 `metadata.source`를 함께 그대로 전달한다. 남은 질문이 있으면 status가 반환한 toolInput으로 이어서 표시한다. 사용자가 선택하면 같은 작업을 계속하며, 모델이 답을 미리 넣거나 채팅 문장을 승인으로 대신할 수 없다. 확인 대상이 바뀌면 새로 준비한다.

동의 스냅샷은 외부 hook이 Git 무시 경로에 쓰는 사용량·세션·캐시 기록을 제외한다 — 외부 hook을 삭제할 필요는 없다. 추적된 감사 파일과 명시된 제어·문서 경로는 그대로 검사한다. 스냅샷 수집 범위는 CLI가 정하므로 스킬만 갱신하는 `update --templates-only`로는 바뀌지 않는다 — 아래 설치 방식에 맞춰 CLI도 갱신한다. 거부되면 `변경 대상:`의 경로/Git 상태를 확인하고 동의를 새로 준비한다.

일반 터미널에서 직접 실행하는 `approve`·`confirm`·`reject`·`deliver`·`plugin add`도 지원한다. 이 선택 경로에는 TTY 검사가 적용된다.

| 어디서 | 되나 |
|---|---|
| PowerShell · Windows Terminal · cmd | 된다 |
| **Git Bash (mintty)** | **안 된다** — mintty 는 Windows 프로그램에 TTY 를 주지 않는다. `winpty code-agent approve` 로 감싸거나 PowerShell 을 쓴다 |
| Claude Code 안 | 직접 TTY 명령 대신 hook이 관찰한 `AskUserQuestion` 응답을 consent로 적용한다 |
| CI · 파이프 | 직접 TTY 확인이나 실제 질문 응답을 대신할 수 없다 |

---

## 5. `code-agent update` — 갱신

고정 릴리스가 없어지면 새 작업을 열지 않는다. `version`으로 확인해 해당 릴리스를 다시 설치하거나, 진행 중인 일이 없을 때 `update --bundled`로 복구한다. `abort`는 고정 릴리스가 없어도 번들로 실행할 수 있다. `update --templates-only`는 고정을 풀지 않으며 해당 릴리스의 코드가 없으면 반영을 거부한다. 고정을 푼 뒤에도 `runtime.json`의 상태 세대는 남아 낮은 세대 릴리스 적용을 막는다.

설치 완료·적용 대기는 실행 버전 전환 완료와 다르다. `version`은 예약 당시 사유와 현재 차단 사유를 따로 보인다. 답변이 확인된 낡은 질문은 `interaction list`로 정리하며, 실제 작업이 끝나면 다음 작업 시작 때 자동 적용하거나 호스트 밖 터미널에서 `code-agent update --release <ID>`로 적용한다.

```
code-agent update [--cli <경로>]
code-agent update --templates-only [--host claude|codex|both] [--cli <경로>]
code-agent update --release <ID>
code-agent update --install-only --preview --json
code-agent update --install-only --shown-hash <해시> --json
code-agent update --release <ID> --preview --json
code-agent update --release <ID> --shown-hash <해시> --json
code-agent update --bundled
code-agent version [--json]
```

**설치와 적용은 따로다.** 새 버전은 실행 중인 설치 폴더를 건드리지 않고 릴리스 저장소(`~/.code-agent/releases/<ID>/` — `CODE_AGENT_RELEASE_HOME`으로 바꿀 수 있다)의 새 폴더에 설치한다. 설치·검증(진입 파일·버전·모든 모듈 로드·`help` 실행)을 마친 폴더만 이름 바꾸기 한 번으로 등록하므로, 설치가 실패하거나 중간에 끊기거나 두 갱신이 겹쳐도(설치 잠금) 불완전한 폴더는 고를 수 없다. 프로젝트마다 적용 버전을 `.code-agent/runtime.json`에 두고, 고정 진입점(`code-agent` 명령·hook·선택 UI MCP 가 부르는 `cli.js`)이 명령·hook 마다 그 버전을 골라 넘긴다 — 한 프로젝트의 적용이 다른 프로젝트를 바꾸지 않고, 한 프로세스는 처음 고른 버전의 모듈만 읽는다.

| 설치 방식 | 새 버전 받기 | 식별값 | 적용 |
|---|---|---|---|
| 로컬 Git 소스(개발 설치) | `code-agent update` — 소스 브랜치의 upstream 만 받아(`FETCH_HEAD`만 쓴다 — 소스의 작업 트리·브랜치·원격 추적 브랜치는 그대로) 그 커밋을 새 폴더에 꺼내 `npm ci --include=dev`·빌드·개발 의존성 정리·검증 | 커밋·트리·내용 해시. ID `<버전>-<커밋 12자>` | 진행 중인 일이 없으면 바로, 있으면 예약 |
| npm 패키지 | 기존 설치에 쓴 패키지 관리자로 설치한다 — code-agent 는 받지 않는다(원본 주소·설치 범위를 추정하지 않는다) | 내용 해시(`dist`·`template`·`package.json`). ID `<버전>-<해시 12자>` | 다음 작업을 열 때(또는 `update --templates-only`) 그 패키지를 릴리스 저장소에 복사·검증해 적용 |
| 단일 실행 파일 | 새 파일로 교체 | — | 교체한 뒤 `update --templates-only`(릴리스 저장소를 쓰지 않는다) |

설정 파일은 임시 파일로 완결된 내용을 쓴 뒤 원자 교체하고 일시적 파일 잠금은 재시도한다. 템플릿과 적용 버전 기록은 같은 복원 범위다. npm 패키지의 전체 해시·복사는 PreToolUse hook에서 하지 않고 작업을 여는 명령에서 수행한다. 의존성 사본은 중첩 버전을 보존한다.

Git 소스를 고쳐 빌드한 개발본은 고정이 없는 프로젝트에 바로 쓰인다(빌드가 곧 적용 — 개발 정책). 고정된 프로젝트는 그대로이고, 개발본을 쓰려면 그 프로젝트에서 `update --bundled`로 고정을 푼다. npm 패키지는 패키지 관리자가 진입점을 통째로 바꾸므로 작업을 늘 복사본으로 돌린다 — 패키지를 다시 설치해도 진행 중인 작업은 복사해 둔 버전으로 끝까지 간다.

**진행 중인 일이 있으면 설치만 하고 적용을 예약한다.** 진행 중인 일은 작업·요구사항 접수·공통 문서 세션·사전 판별, 응답·적용을 기다리는 확인, 다른 프로세스의 동의 적용이다. 판정과 전환은 프로젝트 실행 잠금(`.code-agent/runtime.lock`) 안에서 다시 확인한다. 예약하면 이렇게 알린다.

```
새 버전 1.0.0-3d58e60bd17e 설치 완료. 현재 작업은 기존 버전(1.0.0-8845432bdd39)으로 계속 진행하며, 작업 완료 후 다음 작업부터 새 버전을 적용합니다.
  대기 사유: 진행 중인 작업 WORK-0003 (implement)
  적용 시점: 진행 중인 일이 끝난 뒤 다음 작업을 시작할 때(요구사항 접수·문서 준비·사전 판별 시작) 자동으로 — 호스트를 종료할 필요가 없습니다.
  지금 할 일: 없습니다. 바로 적용하려면 작업을 반영하거나 끝낸 뒤 code-agent update --templates-only 를 실행합니다.
```

진행 중인 작업은 끝까지 지금 버전(CLI·hook·검증·지침)으로 돈다. 다음 작업을 여는 명령(`request begin`·`docs begin`·`triage begin`·`start`)이 예약된 버전을 먼저 적용하고 같은 명령을 새 버전으로 다시 실행한다. 모델이 셸로 그 명령을 부르면 직전의 훅이 먼저 적용하고, 명령은 새 버전으로 적용 보고를 낸 뒤 연다. 적용은 내용이 바뀐 설치 파일만 쓴다. 적용에 실패하면 반영한 파일을 되돌리고 지금 버전으로 시작하며 예약은 그대로 둔다. Codex 의 Windows workspace-write 샌드박스는 셸의 자식 프로세스나 `.codex/`·`.agents/` 쓰기를 막지만, 신뢰한 프로젝트의 훅은 샌드박스 밖에서 돌아 그 안에서도 적용된다(0.162.1 실측). 훅이 돌지 않아 적용이 물러서면 출력이 그렇다고 알리고, 진행 중인 일이 없을 때 호스트 밖 터미널에서 `code-agent update --templates-only`를 실행하면 적용된다.

**호스트를 종료하지 않는다.** hook 은 호출마다 새 프로세스라 적용 다음 호출부터 새 버전으로 돈다. 적용 보고는 바뀐 것에 따라 할 일을 나눠 적는다.

| 바뀐 것 | 실행 중인 세션 | 근거 |
|---|---|---|
| CLI·hook·검증 코드 | 다음 호출부터 새 버전 | Claude Code 2.1.299·codex-cli 0.162.1 실측 |
| 스킬(`SKILL.md`) | 대화에 실린 본문은 이전 버전이다 — 보고가 그 파일을 다시 읽으라고 적는다 | Claude Code 2.1.299 실측(파일 감시가 늦게 반영한다 — 바꾼 지 2초 뒤 호출은 이전 본문, 20초 뒤는 새 본문) |
| `CLAUDE.md`·`AGENTS.md`의 code-agent 블록 | 보고가 다시 읽으라고 적는다 | 대화에 실린 지침은 파일을 바꿔도 그대로다 |
| 바뀐 에이전트 정의 | 다음 서브에이전트 호출부터 | Claude Code 공식 문서, codex-rs 0.162.1 소스 |
| `.claude/settings.json` hook 설정 | 설정 파일 감시가 반영한다(몇 초 안에 반영되지 않으면 다시 연다) | Claude Code 공식 문서 |
| `.codex/hooks.json`·`.codex/config.toml`의 MCP 설정·새 Codex 에이전트 파일 | **Codex 를 다시 열어야 한다**(hook 은 다시 열고 `/hooks`에서 검토·신뢰) | codex-rs 0.162.1 소스 — 세션을 만들 때만 읽는다 |

code-agent 의 hook 명령과 MCP 설정은 고정 진입점을 가리키므로 보통의 버전 적용에서는 바뀌지 않는다 — 이때 보고는 `호스트를 다시 열 필요가 없습니다.`다. 선택 UI MCP 는 Codex 가 세션 동안 한 프로세스로 띄운다. 그 프로세스(연결부)는 시작 때의 코드로 돌고, 도구 호출마다 프로젝트의 적용 버전 처리기를 부른다. `code-agent version`이 연결부 버전과 마지막 호출을 처리한 버전을 보인다.

**템플릿은 적용할 때만 쓴다.** 설치만으로는 프로젝트의 스킬·에이전트·hook 설정·지침 블록을 바꾸지 않는다. 적용은 바뀐 사본만 쓰고, 도중에 실패하면 반영 전 파일로 되돌리고 적용 버전을 바꾸지 않는다. 마지막으로 적용한 사본의 해시(`.code-agent/templates.json` — 준비·반영 커밋에 담긴다)와 다른 사본은 사람이 고친 것으로 보고 덮어쓰지 않는다 — 새 번들 내용은 `.code-agent/template-conflicts/` 아래 같은 경로에 두고 `!!`로 알린다(사람이 병합한 뒤 `update --templates-only`). 기록이 없는 처음 적용은 사람이 고친 사본을 가리지 못해 새 번들로 바꾸고 그 파일을 알린다.

**동의 흐름.** 같은 Claude Code·Codex 세션에서 업데이트를 요청하면 `action: "update"`를 담은 확인 요청을 준비하고, 사람의 선택을 받은 뒤 적용한다. Codex 에서는 적용이 네트워크와 사용자 홈의 릴리스 저장소를 쓰므로 샌드박스 밖(권한 상승)으로 실행한다. 적용 결과의 `호스트를 다시 열어야 하는 것`이 있으면 그것만 안내하고, 다시 읽으라는 지침·스킬 파일이 있으면 읽은 뒤 이어 간다. 일반 터미널에서 `code-agent update`를 직접 실행하면 미리보기(소스·적용·적용 대기 버전·설치된 릴리스·실행 순서)를 보인 뒤 `update`를 그대로 입력해야 진행한다(TTY 가 아니거나 Claude Code·Codex 가 띄운 셸이면 동의 절차를 안내하고 멈춘다). 모델이 셸에서 소스 `update`·`--release`·`--bundled`를 부르는 것은 작업·세션 밖에서도, `npx`·경로·`cli.js update` 같은 꼴로 불러도 hook 이 막는다(버전을 고르는 깃발 없는 `--templates-only`만 연다). 업그레이드 전에 준비한 확인 요청은 새로 준비해야 할 수 있다(확인 화면·스냅샷 범위가 바뀌면 대상 변경으로 폐기된다).

**`--templates-only`는 받지 않는다.** 적용 대기 버전이 있으면 그것을 적용하고, 없으면 지금 적용 버전의 템플릿을 다시 반영한다. npm 패키지 진입점이면 설치된 패키지를 릴리스로 들인다. 진행 중인 일이 있으면 바꾸지 않고 종료 코드 3으로 알린다.

**프로젝트 적용은 설치된 프로젝트 안에서 실행한다.** `--install-only`를 제외한 `update`의 대상은 실행 위치가 속한 git 저장소의 루트다 — 하위 폴더에서 실행해도 된다. 적용 버전은 프로젝트마다 따로라 적용할 프로젝트마다 실행한다. code-agent 가 설치되지 않은 폴더(설치 기록 `.code-agent/version`·`hosts.json`도, 두 호스트의 hook 등록도 없다 — 프로젝트 밖·설치하지 않은 저장소)에서는 프로젝트 적용을 아무것도 쓰지 않고 종료 코드 1로 멈춘다. 처음 설치는 `code-agent init`이다.

**대시보드 화면 확인.** 호스트 밖의 대시보드 실행기는 `--install-only --preview --json`으로 프로젝트 없이 소스·브랜치·upstream·릴리스 저장소의 문구(`lines`)와 `shownHash`를 읽는다. 미리보기는 네트워크·잠금·확인 기록을 쓰지 않는다. 화면에 문구를 보이고 사람이 확인하면 같은 해시를 `--install-only --shown-hash <해시> --json`으로 넘긴다. 현재 상태와 일치할 때만 설치하고 `{id, commit, created, log}` 한 줄을 돌려준다. 같은 커밋은 다시 빌드하지 않으며 `created: false`다. 프로젝트 파일이나 적용 버전은 바꾸지 않는다.

프로젝트별 적용은 `--release <ID> --preview --json`으로 현재 버전·고를 릴리스·상태 세대 문구와 해시를 확인하고 `--release <ID> --shown-hash <해시> --json`으로 실행한다. 기존 적용 실행기가 처리하며 `{code, text}` 한 줄을 돌려준다. 즉시 적용은 종료 코드 0, 작업 중 예약은 3이다. 해시가 다르면 `stale-state`, 호스트 셸 표지가 있으면 `policy-forbids`로 쓰기 전에 거부한다(종료 코드 1·stderr). 두 경로 모두 `--json`과 미리보기 또는 확인 해시 하나가 필요하다. 모델의 셸 호출은 `--templates-only`와 섞어도 hook이 막는다.

확인 기록은 PC 저장소(`CODE_AGENT_HOME` 또는 `~/.code-agent`)의 `update-confirmations.jsonl`에 남는다. PC 신뢰와 같은 `createdBy: {actor, channel, shownHash}` 형식이며 일반 터미널 확인은 `tty`, 화면 확인은 `dashboard`다. 확인이 유효한 뒤 설치·적용을 시작하기 전에 기록하므로 성공 증거와는 다르다. 확인자 이름과 해시는 같은 OS 계정에서 호출한 사실의 기록이며 별도의 신원 증명은 아니다.

**되돌리기와 고정 풀기.** `code-agent update --release <ID>`는 저장소에 설치된 릴리스 하나를 골라 적용한다(터미널 확인, 진행 중인 일이 있으면 예약). 상태 형식 세대(`stateSchema`)가 프로젝트보다 낮은 릴리스는 적용하지 않는다 — 새 버전이 승인·증거·작업 기록의 형식을 올렸으면 그 이전 버전으로는 되돌릴 수 없다. 실패했다고 적용 버전을 자동으로 되돌리지 않는다. 설치·검증·템플릿 반영이 실패하면 적용 버전은 처음부터 바뀌지 않는다. npm 패키지 진입점에서 `--release`로 고른 버전은 새 패키지를 설치할 때까지 그대로 둔다. `code-agent update --bundled`는 고정을 풀고 진입점의 번들로 돈다(진행 중인 일이 없을 때).

**조회.** `code-agent version`은 이 명령을 돌린 코드, 이 프로젝트의 적용 버전·적용 대기·진행 중인 일, 진입점 npm 패키지, 프로젝트에 기록된 저장소와 기본 저장소에 설치된 릴리스(식별값·상태 세대·저장소 경로), 실행 중인 선택 UI MCP 를 보인다(`--json`은 스키마 `code-agent.version v1`). `status`·`doctor`도 적용 버전 한 줄을 낸다. 적용 버전이 저장소에서 사라졌는데 진행 중인 일이 있으면 hook 은 다른 버전으로 잇지 않는다(PreToolUse 는 거부, Stop 은 막지 않는다) — `version`·`status`·`doctor`·`update`·도움말만 진입점 번들로 돈다. 진행 중인 일이 없으면 진입점 번들로 돈다.

실행 중인 그래프도 릴리스 적용을 막는다(`.code-agent/graph/run.lock`). 상태 형식과 잠금·재개 규약은 [LangGraph 실행 구조](langgraph.md#재개와-중단)를 따른다.

**진입점 경로.** 직접 절대 경로로 등록한 hook·MCP(`--cli`)는 그 경로의 `cli.js`가 고정 진입점이 되어 적용 버전을 고른다. 공유 설정에 릴리스 폴더 경로를 쓰지 않는다. `code-agent version`으로 적용 버전을, `doctor`로 설치·환경 점검 결과를 확인한다.

**PreToolUse matcher 가 좁은 설치본은 `update` 로 넓힌다.** matcher 에 `Read`·`Grep`·`Glob` 이 들어 있어야
hook 이 읽기 호출을 받아 `~/.code-agent/` 의 키 파일을 닫는다 — 넘어오지 않는 도구가 있으면 `doctor` 가 그 줄을 `✗` 로 짚는다([4절](#4-code-agent-doctor--점검)).
이 닫힘은 **진행 중인 작업이 없을 때까지** 걸린다(`.code-agent/` 와 작업 지시서도 같다) — 그래서 matcher 가 좁은 설치본은 작업 중이 아니어도 구멍이 난다.

보존은 `init` 이 이미 하던 그대로다.

| 무엇 | 어떻게 |
|---|---|
| `.claude/settings.json` 의 **다른** hook·설정 | code-agent의 hook 등록 9개만 갱신한다. PreToolUse에는 도구 검사와 consent 관찰이 각각 있고, PostToolUse에도 consent 관찰이 있다 |
| `CLAUDE.md` · `.gitignore` 의 **블록 밖** | 표시 블록 안쪽만 쓴다 |
| 에이전트별 모델·추론 강도(`.code-agent/models.json`·`.code-agent/codex-models.json`) | 다시 설치한 정의 파일에 그 선택을 다시 바른다. 정의 파일의 model·effort가 설정과 달랐던 역할은 전후 값을 출력에 적는다(원인은 가리지 않는다) |
| 개발용 `--cli` | 기본 소스 갱신과 `--templates-only` 모두 설치된 hook 명령의 꼴을 승계한다 — `code-agent …` 은 그대로 두고, 개발 CLI 경로(`node "<경로>" …`)는 그 경로를 잇는다. 새로 빌드한 이 PC 의 절대 경로를 공유 설정에 새로 박지 않는다. `--cli`를 명시하면 지정한 경로를 적용한다 |

```
code-agent 를 1.0.0 → 1.1.0 으로 갱신했습니다 — C:\work\shop
  - 스킬·에이전트 3개 갱신: .claude/skills/ca-plan/SKILL.md · …
  - .claude/settings.json: 그대로 (PreToolUse code-agent hook · 질문 PreToolUse code-agent consent-event · 질문 PostToolUse code-agent consent-event · Stop code-agent stop · SubagentStart code-agent review-event · SubagentStop code-agent review-event · 계획 SubagentStart code-agent planning-event · 계획 SubagentStop code-agent planning-event · SessionStart code-agent session-event)
  - CLAUDE.md: 갱신
  - .gitignore: 그대로
  - 에이전트 모델 오버라이드 1개 유지: implementer=opus/medium
  - .code-agent/version = 1.1.0

  갱신된 파일을 커밋해 팀과 공유하세요.
```

이전 code-agent로 설치한 정의 파일(모두 `model: opus`, 강도 줄 없음)을 갱신하면 역할별 기본값을 적용하고 전후 값을 따로 적는다. 예를 들어 `{"implementer":"haiku"}`를 저장해 둔 저장소는 다음과 같다(implementer 는 haiku 가 강도를 받지 않아 전후가 같으므로 다시 쓴 목록에 들지 않는다).

```
  - 에이전트 모델·추론 강도 7개를 설정대로 다시 썼습니다: surveyor opus → sonnet/medium · analyst opus → opus/high · explorer opus → sonnet/medium · writer opus → sonnet/medium · critic opus → opus/high (+2) — 기준: .code-agent/models.json(없는 역할은 역할 기본값)
  - 그중 7개는 이전 번들 기본값(opus·강도 없음)이던 정의 파일입니다 — 이번 버전의 역할별 기본값(판단 opus/high · 실행 sonnet/medium)을 적용했습니다. 이전 값이 필요하면 모델 변경을 요청하세요(수동 TTY: code-agent model <역할> <모델> --host claude --effort <강도>)
  - 에이전트 모델 오버라이드 1개 유지: implementer=haiku
```

같은 버전에서 정의 파일의 `effort:`만 손으로 바꿨다가 갱신하면 `writer sonnet/max → sonnet/medium` 한 줄만 나오고 "이전 번들 기본값" 줄은 없다.

**이 버전에 없는 `ca-*` 가 남아 있으면 `!!` 로 알린다.** 이름이 바뀌었거나 빠진 스킬은 `update` 가 쓰는 키에 없어서
영영 남고 Claude Code 는 계속 읽는다. 지우지는 않는다 — 사람이 만든 `ca-` 스킬과 가릴 수 없다. `doctor` 도 같은 줄을 `·` 로 찍는다.

**스킬·에이전트는 템플릿 사본이다.** 버전 적용은 마지막 적용 기록과 같은 사본만 바꾸고, 사람이 고친 사본은 보존한다(위 '템플릿은 적용할 때만 쓴다'). 프로젝트 규칙은 `CLAUDE.md` 의 블록 **밖**이나 `doc/` 에 둔다.

버전 적용은 진행 중인 일이 없을 때만 하므로 새 버전으로 옮겨 갈 작업 승인이 없다 — 기존 승인을 새 버전에 옮기지 않는다. 승인·증거는 `planHash`·`manifestHash`·트리 해시에 묶여 있어 템플릿을 갱신해도 무효였던 승인이 되살아나지 않는다.

### AWS AI-DLC 가 함께 설치된 저장소

AI-DLC 와 code-agent 는 번갈아 쓴다. 같은 브랜치에 진행 중인 AI-DLC 의도가 있으면 code-agent 가 시작하지 않는다. 순서는 AI-DLC 작업 완료 → `/aidlc intent archive <이름>`(2.9 이상) → 그 기록 커밋 → `git status` 가 깨끗한지 확인 → code-agent 시작이다. 2.8.2 는 archive 가 없어 끝난 의도가 하나뿐이면 계속 기록 대상이 되므로 업그레이드를 권한다. AI-DLC 를 설치·갱신(`--force`)한 뒤에는 `code-agent doctor` 로 hook 등록을 확인하고, 빠졌으면 `code-agent init` 으로 다시 넣는다.

---

## 6. 지우기

| # | 무엇 | 어떻게 |
|---|---|---|
| 1 | 스킬·에이전트 | `.claude/skills/ca-*` · `.claude/agents/ca-*` 삭제 |
| 2 | hook | `.claude/settings.json`의 `code-agent hook`(PreToolUse), `code-agent consent-event`(PreToolUse·PostToolUse), `code-agent stop`(Stop), `code-agent review-event`·`code-agent planning-event`(각 SubagentStart·SubagentStop), `code-agent session-event`(SessionStart) 등록 9개를 제거한다. **설정 파일 전체를 지우지 않는다** |
| 3 | 블록 | `CLAUDE.md` · `.gitignore` 의 `code-agent:start` ~ `end` 블록 제거 (블록 밖은 그대로) |
| 4 | 진행 상태 | `.code-agent/` 는 **남긴다** — 승인·확정 원장과 검증 증거가 git 이력에 남은 커밋의 근거다. 정말 지울 것이면 그 이력도 근거를 잃는다는 것을 알고 지운다 |
| 5 | 도구 | npm 전역이면 `npm rm -g code-agent`, 단일 실행 파일이면 그 파일 삭제 |
| 6 | 이 PC 의 개인 등록 | `~/.code-agent/credentials.json` — 플러그인 키·동의가 여기 있다. 저장소가 아니라 **이 PC 의 이 사용자** 것이라 따로 지운다 ([plugins.md §3](plugins.md#3-등록)) |

1~4 는 저장소의 변경이라 커밋해야 팀에 반영된다.
