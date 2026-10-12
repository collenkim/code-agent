# 설치 — npm 전역 · 단일 실행 파일

Claude와 Codex를 선택하거나 함께 설치할 수 있다. `init --host claude|codex|both`를 사용한다. Codex의 설치 경로·사용자 응답·훅 신뢰·갱신·제거는 [Codex 연동](codex.md)에 정리했다. 아래 Claude 전용 경로와 훅 수는 Claude 설치 기준이다. 두 호스트의 기준 커밋에는 `.code-agent/hosts.json`도 포함된다.

> 흐름과 무엇을 치는가는 [usage.md](usage.md), 설계와 근거는 [design.md](design.md).
> 이 문서는 **어디에 깔고 · 무엇이 생기고 · 어떻게 점검하고 · 어떻게 지우는가**다.

`code-agent init`은 프로젝트에 절차 파일과 hook을 설치하고 종료한다. 실제 실행은 같은 프로젝트에서 Claude의 `/ca-request <요구사항>` 또는 Codex의 `$ca-request <요구사항>`으로 시작한다. 호스트가 프로젝트 스킬·서브에이전트를 읽으므로 별도 에이전트 등록이나 상주 서버는 필요 없다. 사용할 호스트의 설치·인증, Git, 개발할 프로젝트의 실행 환경은 별도로 준비한다.

---

code-agent는 새 패키지·서버·필수 설정 없이 동작한다. CLI를 빌드·갱신한 뒤 대상 프로젝트에서 `code-agent update --templates-only`로 스킬·에이전트 정의·CLAUDE 블록·hook을 함께 갱신한다. 호스트를 다시 열고 `code-agent --help`와 `doctor`로 설치 상태를 확인한다. 이미 진행 중인 작업은 그 작업의 증거로 재개한다.

작업 임대(`.code-agent/lease.json`)는 `update --templates-only` 가 `.gitignore` 블록에 `lease.json*` 줄을 더한다 — 갱신 전에는 미추적 파일로 보이지만 `.code-agent/` 아래라 게이트·동의 스냅샷에는 걸리지 않는다(그대로 둬도 무해하다). 다만 진행 중인 작업이 있으면 `update --templates-only` 는 그 작업을 반영하거나 끝낸 뒤 실행한다 — 갱신이 바꾼 설치 파일(`.gitignore` 블록·스킬·에이전트 사본·hook 설정)이 그 작업의 계획 밖 변경이 되어 검증·반영을 막고, 게이트가 작업의 기준 커밋과 견주므로 커밋해도 풀리지 않는다. 이미 갱신했으면 `update` 출력의 `!! 이번 갱신이 바꾼 설치 파일이 …` 줄이 그 파일을 알려 준다 — 사람이 그 파일들을 갱신 전으로 되돌리고 작업을 마친 뒤 다시 갱신한다.

CLI와 템플릿(스킬·에이전트 정의)은 함께 갱신한다 — Codex 사본도 같은 템플릿에서 생성되므로 사용 중인 호스트를 재시작한다. 이전 입력 계약으로 시작한 작업은 그 계약을 유지하고 새 기본 작업은 contextVersion 2를 사용한다. `doctor`의 설치 점검은 실제 연동 성공을 인증하지 않는다.

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
| 전제 | Node 22 이상 (`package.json` 의 `engines` 에 적혀 있어 npm 이 미리 경고한다) | code-agent용 별도 Node 설치는 **불필요** — 실행 파일 안에 들어 있다. Claude Code·Git·프로젝트 실행 환경은 필요하다. 단, **만드는** PC 는 Node 24.8 이상 ([2절](#2-단일-실행-파일-만들기)) |
| 크기 | 수 MB | **~90 MB** (Node 실행 파일 그대로 + 자원 1 MB) |
| OS | 하나로 전부 | **OS 별로 따로 만든다** ([2절](#2-단일-실행-파일-만들기)) |
| 갱신 | 로컬 Git 소스 연결은 `code-agent update`. 비Git 패키지는 재설치 후 `update --templates-only` | 새 파일로 교체한 뒤 `update --templates-only` |

어느 쪽이든 **저장소에 들어가는 것은 같다.** `init`은 스킬 18개(보조 문서 11개 포함), 서브에이전트 8개와 hook 9개를 등록한다. hook은 도구 경계를 검사하는 PreToolUse(`code-agent hook`) 1개, AskUserQuestion의 질문·응답을 관찰하는 PreToolUse·PostToolUse(`code-agent consent-event`) 2개, Stop(`code-agent stop`) 1개, ca-reviewer의 SubagentStart·SubagentStop(`code-agent review-event`) 2개, 계획 담당의 SubagentStart·SubagentStop(`code-agent planning-event`) 2개, 대화 시작·재개·압축·비우기 뒤 진행 상태를 붙이는 SessionStart(`code-agent session-event`) 1개다. PreToolUse matcher 는 쓰기·셸·읽기 도구와 MCP 도구(`mcp__.*`)를 넘긴다. Codex 는 공통 hook 6개(도구 실행 전·사용자 메시지·담당 시작·담당 종료·턴 종료·세션 시작)를 쓰고, PreToolUse 항목만 비Windows 명령을 `… codex-event || exit 2`로 감싼다. Windows 용 `commandWindows`는 `cmd /c code-agent codex-event`에 종료 코드를 넘기는 꼴이다(Windows PowerShell 5.1 이 exit 2 를 바꾸지 않게 — [Codex 연동](codex.md)). 이전 버전으로 설치한 저장소는 `code-agent update --templates-only --host codex`로 새 꼴이 된다. Codex 는 프로젝트와 hook 을 신뢰해야 hook 을 돌린다 — Codex 대화형 세션에서 이 저장소를 열어 프로젝트를 신뢰하고 'Hooks need review' 화면에서 hook 을 검토·신뢰한다(`codex exec`는 신뢰되지 않은 hook 을 알리지 않고 건너뛴다). PATH에서 풀리므로 `.claude/settings.json`을 팀이 공유할 수 있다.

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

**만드는 Node 는 24.8 이상이어야 한다** — `node:sea.getAssetKeys` 가 그 버전에 들어왔고, 그것이 없으면
안에 든 템플릿을 읽지 못하는 바이너리가 나온다(자기가 단일 실행 파일인 줄 모르고 없는 패키지 폴더를 읽으려 한다).
빌드 스크립트가 0단계에서 막는다. *쓰는* Node 는 필요 없다 — 실행 파일 안에 들어 있다.

산출물은 `dist-bin/code-agent.exe` (Windows) · `dist-bin/code-agent` (macOS · Linux).
`dist-bin/` 은 `.gitignore` 에 있다 — 커밋하지 않는다.

`scripts/build-bin.js` 가 하는 일 (Node SEA — [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)).

| # | 무엇 | 왜 |
|---|---|---|
| 0 | `node:sea.getAssetKeys` 가 있는가 | 없으면 **선다**. 24.8 미만으로 묶으면 빌드는 조용히 끝나고 바이너리가 실행 시점에 맨 ENOENT 로 죽는다 |
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

```
cd <프로젝트>
code-agent init
claude
```

| 무엇 | 자리 | 커밋 |
|---|---|---|
| 스킬·에이전트 (26개 — 스킬 18 · 에이전트 8) | `.claude/skills/ca-*` · `.claude/agents/ca-*` | O |
| hook 등록 9개 | `.claude/settings.json` — PreToolUse `hook`, PreToolUse·PostToolUse `consent-event`, Stop `stop`, SubagentStart·SubagentStop `review-event`·`planning-event`, SessionStart `session-event` | O |
| 절차 블록 | `CLAUDE.md` 의 `<!-- code-agent:start -->` ~ `end` 사이 | O |
| 제외 목록 | `.gitignore` 의 `# code-agent:start` ~ `end` 사이 | O |
| 버전 고정 | `.code-agent/version` | O |

표시된 **블록 안쪽만** 바꾼다. `settings.json` 의 다른 hook·설정과 `CLAUDE.md` 의 블록 밖은 건드리지 않는다.
설치한 파일은 커밋해 팀과 공유한다.

작업의 최종 반영에서는 `.code-agent/version`, `.code-agent/models.json`·`.code-agent/codex-models.json`, `.code-agent/approvals/docs.jsonl` 중 존재하는 파일을 실제 커밋 경로 목록에 표시하고 함께 커밋한다. 이 설정·확정 파일은 반영 후 별도로 수동 커밋하지 않아도 된다. 같은 화면에는 작업 파일·증거와 선택한 KNOWLEDGE 경로도 표시한다. 그 밖의 설치 설정이나 소스를 일괄 추가하는 것은 아니므로, 별도의 도입·설정 변경은 그 범위에 맞춰 검토한다.

```
code-agent 를 설치했습니다 — C:\work\shop
  - 스킬·에이전트 26개 · 보조 문서 11개: .claude/skills/ca-*, .claude/agents/ca-*
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

**막는 것이 하나도 없으면 종료 코드 0**, 하나라도 있으면 1 이다. 진행 중인 작업이 있어도 돈다.

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

| 표시 | 뜻 | 종료 코드 |
|---|---|---|
| `✓` | 확인됐다 | 0 |
| `✗` | **막는다** — 이대로면 어딘가에서 거부당한다. 다음 줄의 `→` 가 고치는 법이다 | 1 |
| `·` | 알리기만 한다 | 들어가지 않는다 |

`·` 를 종료 코드에 넣지 않는 이유: TTY 가 없는 CI 에서 doctor 가 늘 빨개지면 아무도 쓰지 않는다.

### 검사

| 이름 | ✓ 는 | ✗ 면 |
|---|---|---|
| 런타임 | 단일 실행 파일이거나 Node 22 이상 | Node 를 올리거나 단일 실행 파일을 쓴다 |
| git | `git --version` 이 답한다 | PATH 에 git 을 넣는다 — 브랜치·기준 커밋·반영이 git 을 쓴다 |
| PATH 의 code-agent | PATH 에서 찾았다. 단일 실행 파일인지 npm 설치/링크인지(그 경우 푼 `cli.js` 경로까지) 함께 찍는다 | hook 명령이 풀리지 않는다. `npm i -g <저장소>` 또는 바이너리를 PATH 에 둔다 |
| 지금 도는 것 | (`·`) PATH 의 것과 지금 도는 것이 다를 때만 나온다 | — 막지 않는다. 고친 코드가 왜 반영되지 않는지 볼 때 이 줄을 본다 |
| git 저장소 | `.git` 이 있다 | 공통 문서 준비 후 같은 세션의 `setup` 확인으로 최초 커밋 또는 기존 저장소의 도입 커밋을 만든다. 직접 TTY에서는 `code-agent setup baseline`도 가능하다. 기존 Git 이력은 유지한다 |
| hook 설정 파일 | `.claude/settings.json` 이 JSON 으로 읽힌다. 읽히면 이 줄은 나오지 않는다 | 깨진 자리를 그대로 찍는다. **고치기 전에는 `init`·`update` 도 멈춘다** — 그래서 hook 검사보다 먼저 본다 |
| hook 등록 9개 | `hook` 1개, `consent-event` 2개, `stop` 1개, `review-event` 2개, `planning-event` 2개, `session-event` 1개의 명령과 matcher를 확인한다. consent는 AskUserQuestion, review는 ca-reviewer, planning은 ca-analyst·ca-explorer·ca-writer·ca-critic에 연결된다 | 설치 방식에 맞게 `update` 또는 `update --templates-only` 후 Claude Code 재시작. 개발 CLI 경로 오류는 `code-agent init --cli <경로>`. 옛 matcher(MCP·읽기 도구 없음)는 ✗ 로 짚는다 |
| Codex 이벤트(Codex 설치 — 이벤트마다 한 줄) | `.codex/hooks.json`의 그 이벤트에 `codex-event` 명령이 있고, Windows 명령(`commandWindows`)이 이 버전의 꼴과 같다. `commandWindows`가 없어도 Codex 가 돌리는 `command`가 이 꼴과 같으면(`--cli` 설치의 Stop·Subagent·SessionStart) 맞는 것으로 본다 | 우리 이벤트가 하나도 없으면 `code-agent init --host codex`. 다른 이벤트는 있는데 일부만 없거나(이벤트가 늘기 전의 옛 설치 — SessionStart 등) Windows 명령만 다르면 `code-agent update --templates-only --host codex`(작업 중이면 작업이 끝난 뒤) |
| Codex 프로젝트 신뢰 | `CODEX_HOME/config.toml`(없으면 `~/.codex/config.toml`)에 이 저장소의 `trust_level = "trusted"`가 있다 — 읽기만 한다. 상위 폴더 항목만 있으면 `·` 확인 필요다(Codex 가 상위 폴더 신뢰를 이 저장소에 적용하는지 확인하지 않았다) | (`·`) Codex 대화형 세션에서 이 저장소를 열어 프로젝트를 신뢰한다 — 신뢰 전에는 프로젝트 설정·hook 이 꺼진다 |
| Codex 훅 신뢰(`·`) | `config.toml`에 이 저장소의 hook 신뢰 기록(`hooks.state` — 키가 저장소 경로이거나 그 아래 경로로 시작하는 것. 앞부분이 같은 형제 저장소의 기록은 아니다)이 있으면 알린다. 기록의 키 꼴을 확인하지 못해, 찾지 못하면 '확인 필요'다(없다고 단정하지 않는다) | Codex 대화형 세션의 'Hooks need review' 화면에서 검토·신뢰한다. `.codex/hooks.json`이 바뀌면 다시 검토한다 |
| Codex 미판정 도구(`·`) | 작업·세션 중 Codex PreToolUse 가 판정하지 않은 도구 이름과 횟수(`.code-agent/log/codex-tools.json` — 하위 에이전트 조율 도구 `collaboration…`은 세지 않는다) | 파일을 쓰는 도구라면 hook 판정 밖이다 — code-agent 를 갱신하거나 사람에게 알린다 |
| 설치 버전 | (`·`) `.code-agent/version` 이 지금 도는 버전과 다르면 알린다 | — `code-agent update`. 막지 않는다 |
| 스킬·에이전트 | 설치된 `ca-*` 전부가 지금 버전의 번들과 같다 (줄바꿈과 머리말의 `model:`·`effort:` 줄은 빼고 본다 — 모델·강도는 '에이전트 모델' 줄이 본다) | **하나도 없으면** `설치되지 않았습니다` → `code-agent init`. 일부가 없거나 다르면 각각 최대 5개까지 → `code-agent update` |
| 에이전트 모델 | 설치된 정의 파일 머리말의 `model`·`effort`가 설정(`.code-agent/models.json`, 없으면 역할 기본값)과 같다. 판단·실행 기본값과 바꾼 역할을 함께 찍고, 일부만 설치되어 있으면 일치한 파일 수를 붙인다. 정의 파일이 하나도 없으면 대조하지 않고 `·`로 알린다(설치 여부는 `스킬·에이전트` 줄이 본다). 두 호스트 설치면 `Codex 에이전트 모델` 줄도 찍는다(TOML 어긋남은 `Codex 스킬·에이전트`가 본다) | 다르면 역할별로 최대 5개 → `code-agent update --templates-only`. `models.json`이 깨졌으면 그 사유 → 고치거나 지운 뒤 `update --templates-only`. **고치기 전에는 `init`·`update`가 파일을 하나도 쓰지 않고 멈춘다** |
| 이 버전에 없는 스킬·에이전트 | (`·`) 남아 있는 `ca-*` 가 없으면 이 줄은 나오지 않는다 | — 막지 않는다. 이름이 바뀌었거나 빠진 것이라 손으로 지운다 (사람이 만든 `ca-` 스킬과 가릴 수 없어 자동 삭제하지 않는다) |
| 번들 자원 | 번들을 읽지 못할 때만 나온다 (24.8 미만으로 만든 바이너리) | `npm run build:bin` 을 Node 24.8 이상에서 다시 돌린다. **이 검사가 서도 doctor 는 끝까지 찍는다** — 깨진 설치를 설명할 유일한 명령이 doctor 다 |
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

```
code-agent update [--cli <경로>]
code-agent update --templates-only [--cli <경로>]
```

기본 `update`는 **로컬 Git 소스에 연결된 code-agent 설치본**을 자동 갱신한다. 개발 대상 프로젝트에서 실행하면 code-agent 소스의 upstream을 `git pull --ff-only`로 받고, 의존성이 바뀌었거나 설치가 필요하면 `npm ci --include=dev`로 잠금 파일에 맞춰 설치한 뒤 빌드한다. 새로 빌드한 CLI가 대상 프로젝트의 스킬·에이전트·hook·CLAUDE 블록과 버전 파일을 적용하고 `doctor`를 실행한다. 개발 대상 프로젝트의 애플리케이션 소스를 pull하는 명령이 아니다.

code-agent 소스에 미커밋 변경이 있거나 upstream과 이력이 분기되어 fast-forward할 수 없으면 중단한다. 변경을 버리거나 임의로 병합하지 않는다. upstream이 없거나 갱신·의존성 설치·빌드에 실패하면 사유를 확인하고 해결해야 한다. 이 명령은 변경을 자동 커밋하거나 원격에 push하지 않는다.

**`--templates-only`는 현재 번들만 적용한다.** fetch·pull·의존성 설치·빌드를 수행하지 않는다. Git 소스가 없는 npm 패키지와 단일 실행 파일은 기본 Git 자동 갱신을 지원하지 않는다고 안내하며, 새 패키지 설치·실행 파일 교체 후 이 옵션으로 프로젝트마다 적용한다. 직접 수정 중인 개발본에도 필요한 빌드를 마친 뒤 이 옵션을 사용할 수 있다.

같은 Claude Code에서 업데이트를 요청하면 `action: "update"`를 담은 확인 요청을 준비하고, 반환된 질문을 그대로 표시해 사용자 선택을 받은 뒤 적용한다. **갱신 후에는 Claude Code를 종료하고 같은 프로젝트에서 다시 실행해야 새 hook이 활성화된다.** 재시작 후 `/ca-status`로 상태를 확인하고 `/ca-next`로 기존 작업을 재개한다 — 갱신이 진행 중인 작업의 계획 밖 변경을 만들었으면 출력의 `!! 이번 갱신이 바꾼 설치 파일이 …` 줄대로 사람이 먼저 되돌린다(맨 위 안내). 일반 터미널에서 `code-agent update`를 직접 실행하는 경로도 사용할 수 있다 — 이때는 미리보기(소스·브랜치·upstream·실행 순서)를 보인 뒤 `update` 를 그대로 입력해야 진행한다(TTY 가 아니거나 Claude Code·Codex 가 띄운 셸이면 동의 절차를 안내하고 멈춘다). 모델이 셸에서 소스 `update` 를 부르는 것은 작업·세션 밖에서도, `npx`·경로·`cli.js update` 같은 꼴로 불러도 hook 이 막는다(`--templates-only` 는 연다). 업그레이드 전에 준비한 확인 요청은 새로 준비해야 할 수 있다(확인 화면·스냅샷 범위가 바뀌면 대상 변경으로 폐기된다).

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

**스킬·에이전트는 템플릿 사본이다 — 갱신이 덮어쓴다.** 손으로 고쳐 두었던 것이 있으면 `!!` 로 알린다
(판정은 "같은 버전인데 내용이 달랐던 파일". 이전 버전의 번들 해시가 남아 있지 않아 이보다 정확히는 가리지 못한다).
프로젝트 규칙은 `CLAUDE.md` 의 블록 **밖**이나 `doc/` 에 둔다.

작업 진행 상태만으로 템플릿 적용을 막지는 않는다. 기본 소스 갱신의 미커밋 변경·분기 검사와 같은 세션 확인은 별도로 적용된다. 승인·증거는 `planHash`·`manifestHash`·트리 해시에 묶여 있어 템플릿을 갱신해도 무효였던 승인이 되살아나지 않는다. 재시작 후 현재 스테이지와 필요한 확인을 다시 점검한다.

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
