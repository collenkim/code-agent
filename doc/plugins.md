# 플러그인 — 명령 어댑터 계약

> 왜 이 모양인가는 [design.md §6](design.md#6-플러그인과-도구-p7), 무엇을 치는가는 [usage.md §10](usage.md#10-플러그인-선택),
> code-agent 자체의 설치·점검·지우기는 [install.md](install.md).
> 이 문서는 **어댑터를 쓰는 사람**을 위한 정본이다 — 요청·응답 형식, 등록, 키, 실패 규칙.

**원칙: 아무것도 등록하지 않아도 전 과정이 돈다.** 자리마다 기본 구현이 있고, 플러그인은 그 자리를 대신 채울 뿐이다.
등록은 사람마다(opt-in) 하고, 저장소는 "어느 자리에 어느 플러그인을 쓰는가"만 공유한다.

플러그인은 **명령 어댑터**다 — 실행 파일 하나가 **stdin 으로 JSON 한 벌을 받아 stdout 으로 JSON 한 벌을 낸다.**
PreToolUse hook과 같은 규약이라 언어를 가리지 않는다. 플러그인의 외부 서비스에 붙는 일은 어댑터 안에서 일어난다. code-agent 자체의 Git 소스 갱신은 별도의 `update` 절차다.

**플러그인은 CLI 가 부른다, 모델이 아니다.** 쓸지 말지를 모델이 정하면 그 판단에 토큰이 들고 결과가 회차마다 흔들린다.

---

## 목차

- [1. 자리(slot)](#1-자리slot)
- [2. 계약 — 요청과 응답](#2-계약--요청과-응답)
- [3. 등록](#3-등록)
- [4. 저장소 선언](#4-저장소-선언)
- [5. 자리 해결 순서와 실패](#5-자리-해결-순서와-실패)
- [6. 보안](#6-보안)
- [7. 예시 어댑터](#7-예시-어댑터)
- [8. A/B 토큰 비교 (Jev 가 붙으면)](#8-ab-토큰-비교-jev-가-붙으면)
- [9. 한계](#9-한계)

---

## 1. 자리(slot)

| 자리 | 부르는 명령 | 기본 구현 (등록 없이) |
|---|---|---|
| `survey.classify` | `code-agent survey` | 경로 규칙 + surveyor — 출력 끝에 분류 블록이 붙을 뿐 |
| `candidates.rank` | `code-agent context` (`impact` · `design`) | 내장 키워드 스캔 (결정론) |
| `context.docs` | `code-agent context` (`impact` · `design` · `plan`) | 등록된 문서의 제목 매칭 |
| `review.prefilter` | `code-agent review` | reviewer 가 전부 봄 |
| `verify.extra` | `code-agent check` | 매니페스트 `commands` 에 선언한 명령 |
| `code.index` | **예약 — 부르는 곳이 없다** | 없음 |

`code.index` 는 이름만 잡아 뒀다. `--slots code.index` 로 등록은 되지만 호출 지점이 없어 아무 일도 하지 않는다 —
`code-agent plugin list` 의 `지금 채우는 것` 칸이 등록·선언이 다 있어도 `예약 — 부르는 지점이 없습니다` 로 찍고
그 줄을 함께 낸다 (그 칸에 플러그인 이름이 뜨면 돌지 않는 것을 돈다고 말하는 것이 된다).

### 기본 구현이 하는 일

- **`candidates.rank`** — ① `01-requirements.md` 의 `## R<n> · <제목>` 제목과 `근거:` 인용문을 토큰으로 쪼개,
  소스 파일의 경로·파일명 히트를 ×3, 내용 히트를 ×1 로 세어 0..1 로 정규화한다. 상위 20개, 동점은 경로 사전순.
  **같은 트리에서는 언제나 같은 순위**가 나온다.
- **`context.docs`** — 등록된 문서(아키텍처 · 컨벤션 · KNOWLEDGE 3종)의 제목과 본문 첫 200자에 대한
  키워드 겹침으로 상위 10개 절을 고른다.
- 나머지 셋은 **이미 있던 동작 그대로**다 — 계층 후보 절 · reviewer 전량 열람 · 매니페스트 `commands`.

ripgrep 이 PATH 에 있어도 `candidates.rank` 는 **쓰지 않는다.** rg 의 ignore 규칙과 유니코드 단어 경계가
Node 스캔과 달라 같은 저장소에서 사람마다 다른 순위가 나오기 때문이다. `plugin list` 의 `감지된 무료 도구` 가
`- ripgrep: 있음 (<경로>) — candidates.rank 는 쓰지 않습니다(사람마다 순위가 갈리지 않게 내장 스캔으로 고정)` 으로 보고한다
(PATH 에 없으면 `있음 (<경로>)` 자리가 `없음` 이고 뒷말은 같다).

---

## 2. 계약 — 요청과 응답

### 2.1 봉투 — 버전 `"1"`

요청은 **stdin 으로 한 벌**, 응답은 **stdout 으로 한 벌**. stdout 에 JSON 말고 다른 것이 섞이면 호출이 실패한다 —
로그·진행 표시는 stderr 로 보낸다.

```jsonc
// → 요청
{
  "protocol": "code-agent.plugin",
  "version": "1",
  "op": "describe" | "probe" | "run",
  "requestId": "3f0c…",                  // 호출마다 새로 만든다
  "repoRoot": "C:/IdeaProjects/proj",    // op:"run" 에만 (describe·probe 에는 없다)
  "slot": "candidates.rank",             // op:"run" 에만
  "sendsCode": true,                     // op:"run" — 등록 때 합의된 사실을 매 호출 되비친다
  "secret": "…",                         // secret.delivery === "stdin" 일 때만
  "input": { … }                         // op:"run" — 자리마다 다르다 (§2.4)
}
```

```jsonc
// ← 응답
{"protocol":"code-agent.plugin","version":"1","requestId":"3f0c…","ok":true,  "output": { … }}
{"protocol":"code-agent.plugin","version":"1","requestId":"3f0c…","ok":false, "error":"키가 만료됐습니다"}
```

응답은 전부 스키마로 검사한다. **버려지는 것**: `protocol` 불일치 · `version !== "1"` · `requestId` 불일치 ·
`ok` 없음 · `output` 이 자리 스키마와 다름. 버려지면 기본 구현으로 떨어지고 한 줄 알린다 (§5).

`requestId` 를 대조하는 이유는 앞 호출의 응답을 캐시해 되돌려 주는 어댑터를 막기 위해서다.

### 2.2 `describe` — 미리보기와 등록 시 설명 확인

어댑터가 **스스로** 무엇을 채우는지·코드를 밖으로 보내는지·키가 필요한지를 밝힌다.

```jsonc
// → {"protocol":"code-agent.plugin","version":"1","op":"describe","requestId":"…"}
// ← output
{
  "name": "jev",
  "adapterVersion": "0.3.1",
  "slots": ["candidates.rank", "review.prefilter"],
  "sendsCode": true,
  "secret": { "required": true, "delivery": "stdin" },
  "note": "요구 항목 텍스트와 파일 경로를 Jev 서버로 보냅니다"
}
```

**키 전달 방식은 어댑터가 정하고 등록이 기록한다.** 같은 세션의 `plugin-add` 확인 요청에 쓰는 `secretEnv`는 키를 가져올 **기존 환경변수 이름**이다. 직접 CLI의 `--secret-env <이름>`도 같은 의미다. 어댑터가 키를 받는 방식(`secret.delivery`)이나 수신 환경변수 이름(`secret.env`)을 바꾸는 옵션이 아니다. 미리보기와 적용 시 설명을 다시 확인하므로 `describe`는 여러 번 호출될 수 있다. 요청에 키 값을 넣지는 않지만 프로세스 환경은 상속되므로, 신뢰하는 어댑터만 사용한다.

| `secret.delivery` | 키가 어떻게 가나 |
|---|---|
| `"stdin"` (**기본**) | 요청 JSON 의 `secret` 필드에 실린다 |
| `"env"` (`{"delivery":"env","env":"JEV_API_KEY"}`) | `spawn` 의 환경에 그 이름으로만 들어간다. 요청 JSON 에는 `secret` 키 자체가 없다 |

argv 는 프로세스 목록에 보이고 환경변수는 손자 프로세스까지 새기 때문에 stdin 이 기본이다.
키를 **명령줄 인자로 받는 어댑터는 쓰지 않는다.**

### 2.3 `probe` — 등록 때 한 번, 실패하면 등록하지 않는다

키를 실어 한 번 부른다. 붙지 않는 플러그인을 등록해 두고 매번 실패 한 줄을 보는 일이 없게 하는 문이다.

```jsonc
// → {"protocol":"code-agent.plugin","version":"1","op":"probe","requestId":"…","secret":"…"}
// ← output
{"ready": true, "detail": "jev.example.com 응답 42ms"}
```

### 2.4 자리별 `input` · `output`

| 자리 | input | output |
|---|---|---|
| `candidates.rank` | `{requirements:[{key,text}], keywords:[string], files:[{path,ext}], limit}` | `{ranked:[{path, score:0..1, why}]}` |
| `context.docs` | `{requirements:[{key,text}], docs:[{kind,path,headings:[{heading,line}]}], limit}` | `{sections:[{path, heading, why}]}` |
| `review.prefilter` | `{baseCommit, treeHash, files:[path], rules:[{source,rule}]}` | `{suspects:[{path, line?, rule?, note}]}` |
| `survey.classify` | `{files:[{path,ext}], layerCandidates:[{name,dirs,files}]}` | `{layers:[{name,purpose,paths}], components?:[{name,paths,note}]}` |
| `verify.extra` | `{phase:"check", baseCommit, treeHash, planFiles:[path], changed:[{status,path}]}` | `{runs:[{kind, outcome:"passed"\|"failed"\|"error"\|"not-run", summary, detail?}]}` |
| `code.index` | **예약** — `{symbols?, from:[path]}` | **예약** — `{symbols:[{name,path,line,kind}], callers:[{from,to}]}` |

`verify.extra` 의 `kind` 는 **식별자**다 — `^[A-Za-z0-9._:-]{1,64}$`. 증거 런의 `kind` 접두사가 되어 ⑧ 의 표 칸에
그대로 들어가는 값이라, 자유 문자열이면 `|` 와 줄바꿈으로 **표 행을 위조**할 수 있다. 그 문서는 같은 증거에서 다시
렌더되므로 바이트 대조 게이트가 위조를 잡지 못한다 — 사람이 읽는 보고서만 거짓이 된다. 어긋나면 호출 전체가 버려진다.
`runs` 는 50개까지 읽는다.

한 왕복 전체 (`candidates.rank`):

```jsonc
// →
{"protocol":"code-agent.plugin","version":"1","op":"run","requestId":"3f0c…",
 "repoRoot":"C:/IdeaProjects/proj","slot":"candidates.rank","sendsCode":true,"secret":"sk-…",
 "input":{"requirements":[{"key":"R1","text":"주문을 등록한다"}],
          "keywords":["주문","등록","order","register"],
          "files":[{"path":"src/main/order/OrderService.java","ext":".java"}],
          "limit":20}}
// ←
{"protocol":"code-agent.plugin","version":"1","requestId":"3f0c…","ok":true,
 "output":{"ranked":[{"path":"src/main/order/OrderService.java","score":0.92,"why":"주문 · order · register"}]}}
```

### 2.5 상한

|  | 제한 시간 | 응답 상한 |
|---|---|---|
| `describe` · `probe` | 10초 | 256 KiB |
| `survey.classify` · `candidates.rank` · `context.docs` · `review.prefilter` · `code.index`(예약 — 부르는 곳이 없어 걸릴 일이 없다) | 20초 | 1 MiB |
| `verify.extra` | 120초 | 1 MiB |

요청 쪽도 묶는다 — `files` · `docs` · `planFiles` · `changed` · `requirements` 목록은 각각 3000개에서 자르고,
하나라도 잘랐으면 `input.truncated: true` 를 실어 보낸다.

**제한 시간이 묶는 것은 어댑터 프로세스 하나다.** 어댑터가 물려받은 stdout 파이프를 손자 프로세스에 남기고 끝나면
파이프가 EOF 에 닿지 않아 호출이 타이머 뒤에도 기다린다 — 어댑터는 **그 파이프 위에 아무것도 백그라운드로 남기지 않아야 한다.**
(진짜 상한을 걸려면 비동기 실행 + 프로세스 그룹 종료가 필요하고, 그것은 이번에 만들지 않기로 한 두 번째 러너다.)

**2분 넘게 도는 검사는 플러그인으로 못 쓴다.** 긴 정적 분석은 매니페스트의 `commands` 로 선언한다 —
그 길은 이미 있고 `code-agent check` 가 돌린다.

---

## 3. 등록

```
code-agent plugin add <이름> --command "<argv>" [--slots a,b] [--sends-code] [--secret-env <기존 변수 이름>]   # 직접 실행은 TTY
code-agent plugin remove <이름>                                                 # 직접 실행은 TTY
code-agent plugin list                                                          # 누구나 (모델도)
```

등록·제거는 같은 Claude Code의 선택 화면에서 확인할 수 있다. 에이전트가 `plugin-add` 또는 `plugin-remove` action을 준비하고, 실제 사용자 응답을 hook이 관찰한 뒤 consent로 적용한다. 모델이 직접 `plugin add`·`plugin remove`를 실행해 사용자 확인을 건너뛰는 경로는 열리지 않는다. 일반 터미널에서 직접 실행할 때는 기존 TTY 검사를 유지한다. `plugin list`는 상태만 읽으므로 모델도 부를 수 있다.

같은 세션의 등록 요청 예시는 다음과 같다. `MY_PLUGIN_KEY`는 **Claude Code를 시작한 환경에 이미 설정된 변수의 이름**이며 실제 키가 아니다. 에이전트는 값 조회·출력 명령을 실행하거나 사용자에게 채팅으로 실제 키를 보내 달라고 요청하지 않는다.

```json
{
  "action": "plugin-add",
  "name": "jev",
  "command": "node C:/tools/jev-adapter.js",
  "slots": "candidates.rank,review.prefilter",
  "sendsCode": true,
  "secretEnv": "MY_PLUGIN_KEY"
}
```

`code-agent consent prepare <action.json>`이 반환한 `toolInput` 전체(`questions`와 `metadata.source`)를 그대로 `AskUserQuestion`에 전달한다. PreToolUse·PostToolUse hook이 질문과 응답을 관찰하면 `code-agent consent status <ID>`를 확인하고, 승인된 요청만 `code-agent consent apply <ID>`로 실행한다. 제거는 `{"action":"plugin-remove","name":"jev"}`로 같은 절차를 사용한다. 보류·취소·수정 요청은 등록·제거 동의로 처리하지 않는다.

추가 미리보기는 이름, 실제 argv와 인자 경계, 선택한 자리, 코드 외부 전송 여부와 자리별 입력, 환경변수 이름, 어댑터 메타데이터를 보여 준다. `describe`는 호출할 수 있지만 `probe`나 등록은 하지 않는다. 제거 미리보기는 저장된 공개 정보만 읽고 키 값을 제외한다. 적용 전 미리보기를 다시 대조하며 설명·명령·자리·키 전달 조건이 달라지면 새 확인을 받아야 한다.

이름은 `^[a-z][a-z0-9-]{0,31}$` — 로그 파일 이름과 증거 런의 `kind` 접두사가 되는 값이다.

### 등록이 도는 순서

앞이 실패하면 뒤가 돌지 않는다. **중간에 멈추면 아무것도 저장되지 않는다.**

1. 이름 검사 · 중복 검사 — 이미 등록돼 있으면 거부한다 (덮어쓰지 않는다. 바꾸려면 `plugin remove` 먼저).
2. `--command` 파싱 (공백 분리 + 따옴표 한 겹) · `--slots` 가 실제 자리 이름인지.
3. **`describe` 호출** — 키 없이, 10초. 실패하면 멈춘다.
4. 자리 확정 — `--slots` 가 없으면 describe 가 말한 전부. 있으면 describe 가 말하지 않은 자리가 섞였는지 본다.
5. `sendsCode` 확정 — `--sends-code` 와 describe 중 **하나만 켜져도 켜진 것**이다.
6. **동의** — 같은 세션에서는 미리보기에 대한 사용자 선택을 확인한다. 직접 TTY 경로에서는 `sendsCode`가 켜졌을 때 경고를 읽고 플러그인 이름을 그대로 입력한다.
7. **키 준비** — `describe.secret.required`이고 `secretEnv`가 있으면 등록 코드가 `process.env[secretEnv]`를 내부에서 읽는다. 변수 이름은 `[A-Za-z_][A-Za-z0-9_]*`이며 값이 없거나 공백뿐이면 등록하지 않는다. 같은 세션에서는 기존 변수 이름을 action에 지정해야 하며 실제 키 입력은 요청하지 않는다. `secretEnv`를 생략한 직접 TTY 경로는 기존 키 입력을 사용한다.
8. **`probe` 호출** — 키를 실어, 10초. 실패하면 **키를 저장하지 않고** 멈춘다.
9. 저장 — 사용자 스토어에 명령·자리·`sendsCode`·키·동의 기록·probe 결과.

`sendsCode` 는 **게이트 대상이 스스로 답한 값**이다. `false` 라고 답한 어댑터도 자리를 여는 순간 그 자리의 입력을
받는다 — 소스 파일 경로 목록, ① 의 요구 항목 문장, 컨벤션 규칙, 등록된 문서의 제목. 그래서 큰 경고와 이름 입력은
`sendsCode` 에만 두되(어깨에 힘이 실린 문은 하나여야 한다), **동의 기록(누가·언제·어느 자리·sendsCode)은 언제나 남긴다.**
등록 화면이 자리마다 무엇이 나가는지 한 줄로 적는다.

끝 화면이 `plugin list` 의 해당 줄과 함께 알린다:
`code-agent.json 에 "plugins": {"<이름>": {"slots": […]}} 를 넣어야 이 저장소에서 실제로 씁니다.`

### 사용자 스토어

**키와 플러그인 등록은 사용자 스토어에만 저장한다.** 같은 세션 확인 기록은 프로젝트의 `.code-agent/consents/`에 남지만 실제 키 값을 넣지 않는다. 확인 요청에는 환경변수 이름만 포함하며, 키 값은 기존 저장 방식대로 probe 성공 후 사용자 스토어에 저장한다.

| 무엇 | 자리 |
|---|---|
| 기본 | `~/.code-agent/credentials.json` (Windows 는 `C:\Users\<이름>\.code-agent\`) |
| `CODE_AGENT_HOME` 이 있으면 | `<그 값>/credentials.json` |

`CODE_AGENT_HOME` 은 **테스트가 실제 사용자 홈을 건드리지 않게** 두었다. 그 밖의 용도는 없다.
`%APPDATA%` · `XDG_CONFIG_HOME` 은 따르지 않는다 — 두 플랫폼이 같은 자리를 쓰는 편이 문서와 지원이 싸다.

```jsonc
{
  "version": 1,
  "plugins": {
    "jev": {
      "command": ["node", "C:/tools/jev-adapter.js"],
      "slots": ["candidates.rank", "review.prefilter"],
      "sendsCode": true,
      "secret": { "required": true, "delivery": "stdin", "value": "sk-…" },
      "adapter": { "name": "jev", "version": "0.3.1", "describedAt": "2026-09-30T04:11:02.913Z" },
      "consent": {
        "user": "kai", "host": "DESKTOP-K1", "at": "2026-09-30T04:11:41.220Z",
        "slots": ["candidates.rank", "review.prefilter"], "sendsCode": true, "typed": "jev"
      },
      "probe": { "at": "2026-09-30T04:11:42.006Z", "ok": true, "detail": "jev.example.com 응답 42ms" }
    }
  }
}
```

스토어는 **읽을 때마다 항목별로 모양을 본다.** 손으로 고치다 `slots` 를 지운 항목 하나가 호출 지점에서 터지면
그 플러그인 문제가 `context`·`survey`·`review`·`check` 를 통째로 세운다 — 모양이 어긋난 항목은 던지지 않고
**버린다**(= 그 이름은 등록되지 않은 것으로 본다). 파일 전체를 읽지 못할 때와 같은 취급이다.

`secret.value` 는 **한 번 쓰고 다시 출력되지 않는다.** `plugin list` 는 `키 등록됨` / `키 필요 없음` 만 찍는다 —
길이도 찍지 않는다(길이는 단서다). 로그에도 값이 들어가지 않는다.

`plugin remove <이름>` 은 그 항목을 통째로 지운다 — 키·동의·probe 기록이 함께 사라지고 그 자리는 기본 구현으로 돌아간다.
저장소의 `code-agent.json` 선언은 건드리지 않는다 (그것은 팀의 것이다).
code-agent 자체를 지울 때도 이 파일은 **따로** 지운다 — 저장소가 아니라 이 PC 의 이 사용자 것이다 ([install.md §6](install.md#6-지우기)).

---

## 4. 저장소 선언

저장소가 공유하는 것은 **어느 자리에 어느 플러그인을 쓰는가**뿐이다. 키는 여기 없다.

```jsonc
// code-agent.json — 커밋된다
"plugins": { "jev": { "slots": ["candidates.rank", "review.prefilter"] } }
```

- 한 자리를 두 플러그인이 선언하면 **형식 오류**다 — 무엇이 도는지 정해지지 않는다.
- 등록하지 않은 팀원에게는 **기본 구현**으로 돌고 알림 한 줄이 뜬다. 작업은 막히지 않는다.
- 개인이 등록해 뒀어도 저장소가 그 자리를 선언하지 않았으면 **기본 구현**이 돈다 —
  등록은 개인 것이고 선언은 팀 것이다. 개인 등록이 팀 저장소의 출력을 조용히 바꾸면 재현이 사람마다 갈린다.

### 승인은 무효가 되지 않는다

`plugins` 는 `hashManifest` 에 들어가지 않는다 — 경계도 검증 선언도 아니고, 플러그인은 런을 **더하기만** 하므로
승인이 본 경계를 넓히지 못한다. `plugins` 를 더해도 **기존 계획 승인은 한 건도 무효가 되지 않는다** (테스트로 못 박혀 있다).

---

## 5. 자리 해결 순서와 실패

호출 한 번은 이 순서로 정해진다.

1. `code-agent.json` 의 `plugins` 에서 그 자리를 선언한 이름을 찾는다. 없으면 → **기본 구현, 알림 없음.**
2. 그 이름이 이 PC 에 등록돼 있고 등록이 그 자리를 덮는가? 아니면 → **기본 구현 + 알림 한 줄**:
   `자리 candidates.rank 는 code-agent.json 이 jev 를 선언했지만 이 PC 에 등록돼 있지 않습니다 — 기본 구현으로 돕니다 (code-agent plugin add jev).`
3. 호출한다. 실패하면 → **기본 구현 + 알림 한 줄**:
   `플러그인 jev(candidates.rank) 가 실패해 기본 구현으로 돕니다: <이유>. 자세한 것은 .code-agent/log/plugins/candidates.rank.jsonl`

**플러그인 실패는 명령을 세우지 않는다.** `context` · `survey` · `review` · `check` 는 전부 정상 종료하고 알림 한 줄만 는다.

`<이유>` 는 전부 같은 취급이다 — 떨어지고 한 줄.

| 이유 | 언제 |
|---|---|
| `실행 파일을 찾을 수 없습니다: <name>` | `--command` 의 첫 낱말이 없다 |
| `제한 시간 20초를 넘겨 중단했습니다` | §2.5 의 상한 |
| `exit 1 (<stderr 마지막 줄>)` | 어댑터가 죽었다 |
| `응답이 JSON 이 아닙니다` | stdout 에 다른 것이 섞였다 |
| `응답이 상한 1024 KiB 를 넘었습니다` | §2.5 |
| `응답 형식이 계약과 다릅니다: output.ranked: Invalid input: expected array, received undefined` | 스키마 불일치 — 어긋난 자리를 `output.<경로>: <사유>` 로 적고 **최대 3개**를 ` / ` 로 잇는다 |
| `requestId 가 요청과 다릅니다` | 캐시된 응답 |
| `version "2" 는 이 code-agent 가 아는 버전이 아닙니다 ("1")` | 어댑터가 더 앞서 있다 |
| `어댑터가 실패를 알렸습니다: <error>` | `ok:false` |

### 로그

`.code-agent/log/plugins/<slot>.jsonl` — 호출마다 한 줄, **마지막 200줄만** 남는다.
`.code-agent/log/` 는 `init` 이 `.gitignore` 에 넣으므로 커밋되지 않는다.

```jsonc
{"at":"2026-09-30T04:21:11.004Z","slot":"candidates.rank","plugin":"jev",
 "command":"node (+인자 1개)",   // 첫 낱말만 — argv 에 키를 적은 어댑터도 여기로 새지 않는다
 "request":{"requestId":"3f0c…","bytes":8412,"counts":{"files":830,"requirements":3},
            "sendsCode":true,"secret":"(보내지 않음|stdin|env JEV_API_KEY)"},
 "durationMs":812,"exit":0,"ok":true,
 "response":{"ranked":[…]},   // 64 KiB 에서 자른다
 "error":null}
```

**실패한 호출에는 원문이 함께 남는다** — `rawResponse`(계약에 걸린 stdout)와 `stderr`(꼬리). 이것이 없으면 로그가
화면의 알림 한 줄을 되풀이할 뿐이라, "자세한 것은 로그를 보라"는 안내가 아무것도 더 주지 못한다
(`응답이 JSON 이 아닙니다` 를 받은 어댑터 작성자가 정작 무엇이 쓰였는지 볼 수 없다). 원문에 키가 섞여 있으면 `(키)` 로 가려진다.

`request` 에 **키 값은 없다** — 전달 방식만 남는다.

### 검사 결과는 더해지기만 한다

`verify.extra` 의 런은 `code-agent check` 의 증거에 **추가**되고, 기존 런을 지우거나 결과를 바꾸지 않는다.
증거에는 `kind: "plugin:<이름>:<런 kind>"` 로 들어가 ⑧ `08-validation.md` 에 다른 런과 나란히 렌더된다.
**플러그인은 실패한 빌드를 통과로 만들 수 없다** — 더하기만 하기 때문이다. 반대 방향은 열려 있다:
플러그인 런이 `failed` 면 `check` 가 막힌다.

**사람이 읽는 ⑧ 도 위조되지 않는다.** `kind` 는 식별자로 묶여 표 행을 갈라놓지 못하고(§2.4), `detail`·`summary` 안의
` ``` `는 ` ''' `로 바뀌어 실패 로그의 울타리를 닫고 나오지 못한다. 증거 JSON 이 옳아도 렌더된 문서가 거짓이면
그 문서를 보고 승인하는 사람에게는 같은 일이다.

---

## 6. 보안

| 무엇 | 어떻게 |
|---|---|
| **등록·제거에는 사람 확인이 필요하다** | 같은 세션에서는 준비한 질문에 대한 hook 관찰 응답을 consent로 적용한다. 모델의 직접 `plugin add`·`plugin remove`는 허용하지 않으며, 사람이 직접 실행할 때는 TTY를 사용한다 |
| **모델은 플러그인을 부르지 않는다** | CLI 가 부른다. 무엇이 도는가는 `code-agent.json` 과 이 PC 의 등록이 정한다 |
| **키는 저장소에 들어가지 않는다** | `~/.code-agent/credentials.json` 에만. 저장소에는 자리 선언만 |
| **키는 argv 로 가지 않는다** | stdin 요청의 `secret` 필드가 기본, 아니면 등록 때 정해진 이름의 환경변수 하나 |
| **키는 되출력되지 않는다** | `plugin list` 는 `키 등록됨` 만, 로그에는 전달 방식만. 로그의 `command` 도 첫 낱말뿐이고, 실패 원문에 섞인 키는 `(키)` 로 가린다 |
| **모델은 키 파일을 읽지 못한다** | hook 이 `~/.code-agent/` 아래를 `Read`·`Grep`·`Glob` 으로도, 그 경로를 가리키는 Bash 명령으로도, 쓰기로도 막는다 — **작업도 세션도 없을 때까지** 그렇다 (진행 중인 작업이 없다고 키 자리가 열리지 않는다) |
| **저장소는 어댑터를 고르지 못한다** | `--command` 의 첫 낱말은 **PATH 에서만** 찾는다. 저장소 루트의 `node.cmd` 가 등록된 어댑터를 가로채 키를 받아 가는 길이 닫혀 있다 (저장소 안 래퍼 우선 규칙은 매니페스트가 선언한 빌드 명령의 것이다) |
| **파일 권한** | 디렉토리 `0700` · 파일 `0600` (쓰고 나서 `chmod` 한 번 더 — 기존 파일을 덮어쓰면 `mode` 가 무시된다). `plugin list` 가 **파일과 디렉토리 둘 다** 보고 넓으면 한 줄 알린다 |
| **코드가 밖으로 나가는 플러그인** | 외부 전송과 자리별 입력을 확인 화면에 표시하고 사용자 동의를 받는다. 직접 TTY 경로는 플러그인 이름 입력을 유지한다. 누가·언제·어느 자리에 동의했는지 스토어에 남는다 |
| **같은 세션의 키 취급** | `secretEnv`에 기존 변수 이름만 기록한다. 실제 값은 등록 내부에서 해석하며 미리보기·확인 기록·등록 오류에 노출하지 않는다 |

**hook 이 막는 것은 사고다.** 그 자리를 **가리키는** 호출(`Read`·`Grep`·`Glob`·쓰기·`~/.code-agent` 를 적은 Bash)은 막지만,
글자를 쪼개 돌려 쓰는 셸 명령까지는 막지 못하고 개발자는 로컬 설정으로 hook 자체를 끌 수 있다 —
hook 은 사고 방지 장치이지 보안 경계가 아니다. 키를 지키는 자리는 파일 권한과 이 PC 의 계정이다.

POSIX 에서 권한이 넓으면(`mode & 0o077`) 읽기를 **막지 않고** 한 줄 경고한다 —
막으면 제 키에서 제가 잠긴다.

**Windows 에서는 `chmod` 가 읽기 전용 비트만 건드리고 ACL 을 바꾸지 않는다.** 등록 끝 화면이 사실대로 알린다:
`Windows 에서는 파일 권한 대신 사용자 프로필 폴더의 기본 ACL 이 이 파일을 지킵니다 — 다른 계정이 이 PC 를 함께 쓰면 그 사실을 확인하세요.`

**직접 TTY에서 입력하는 키는 화면에 보인다.** 같은 세션의 확인에서는 실제 키 입력을 요청하지 않고 기존 환경변수 이름을 사용한다. 키 값을 질문 답변·action JSON·명령 인자에 적지 않는다.

어댑터는 **당신이 고른 실행 파일**이다. code-agent 는 그것을 샌드박스에 넣지 않는다 —
`--command` 가 가리키는 것이 무엇인지 아는 것은 등록하는 사람의 몫이다. 다만 **고르는 자리는 저장소에 내주지 않는다**:
이름 하나(`node`)는 PATH 에서만 찾으므로, 클론한 저장소가 제 루트에 `node.cmd` 를 두는 것으로 그 선택을 가로챌 수 없다.

당신이 고른 것은 어댑터 **실행 파일**이지 그것이 중계하는 서버가 아니다. 그래서 어댑터가 준 문자열은 화면에 나갈 때
한 줄로 묶이고(200자) 목록은 개수가 잘린다 — 자리 출력은 모델이 지시로 읽는 자리라, 어댑터의 한 필드가 여러 줄이
되면 거기에 무엇이든 쓸 수 있다.

---

## 7. 예시 어댑터

`<패키지>/template/plugin-example/echo-adapter.js` — `candidates.rank` 하나를 채우고,
**경로 문자열만** 보고 점수를 매긴다(파일을 읽지 않으니 `sendsCode` 는 false, 키도 없다).
`init` 이 대상 저장소에 복사하지 않는다 — 읽고 베끼는 견본이다.

```
code-agent plugin add example --command "node <패키지>/template/plugin-example/echo-adapter.js"
```

**단일 실행 파일로 깔았으면 이 파일은 실행 파일 안에 있다** — 빌드가 `template/` 전부를 자원으로 담는다.
어댑터는 `node <경로>` 로 도는 파일이라 꺼내야 쓸 수 있고, 꺼내는 자리가 있다.

```
code-agent plugin example [--out <경로>]      기본 ./echo-adapter.js. 있는 파일은 덮지 않는다
```

`plugin list` 가 두 모드 모두 이 명령을 알려 준다 (설치 두 가지는 [install.md §1](install.md#1-두-가지-설치)).
모델은 이 명령을 부를 수 없다 — 파일을 쓰는 명령이라 `plugin list` 만 열려 있다.

그리고 저장소의 `code-agent.json` 에:

```jsonc
"plugins": { "example": { "slots": ["candidates.rank"] } }
```

손으로 확인해 보려면 (등록 없이도 된다):

```
echo {"protocol":"code-agent.plugin","version":"1","op":"describe","requestId":"x"} | node echo-adapter.js
```

어댑터가 지킬 것은 셋뿐이다.

1. 응답에 `protocol` · `version:"1"` · **요청의 `requestId` 를 그대로** 싣는다.
2. stdout 에는 JSON 한 벌만 — 로그는 stderr 로.
3. 실패는 프로세스를 죽이지 말고 `{"ok":false,"error":"<이유>"}` 로 알린다.

---

## 8. A/B 토큰 비교 (Jev 가 붙으면)

P7 의 완료 기준은 "Jev 켜고/끄고 같은 저장소 A/B 토큰 비교" 다. **실제 Jev 가 없어 아직 재지 못했다** —
붙으면 이 절차로 잰다. Jev 어댑터는 Jev CLI 나 얇은 래퍼 스크립트를 `--command` 로 가리키면 된다
(code-agent 안에는 Jev 네트워크 코드가 한 줄도 없다).

1. **같은 지시서 · 같은 기준 커밋**으로 작업 둘을 만든다 — `--target` 을 달리하거나 저장소 사본 둘.
2. A 는 `code-agent.json` 의 `plugins` 를 **비운다**.
   B 는 `{"jev":{"slots":["candidates.rank","review.prefilter","survey.classify"]}}`.
3. 둘 다 `/ca-request <동일한 요구사항>`으로 시작해 같은 화면에서 **계획 승인까지** 진행한다. 중단 후 재개할 때만 `/ca-next`를 사용한다.
   스테이지마다 Claude Code 가 찍는 비용·시간을 [design.md §11 의 "P3 실측 기준치"](design.md#11-구현-순서) 표 형식으로 적는다.
4. B 에서 플러그인이 실제로 돌았는지 `code-agent context` 출력의 **출처 줄**로 확인하고
   (`- 출처: 플러그인 jev`), `.code-agent/log/plugins/*.jsonl` 의 `durationMs` 합을 함께 적는다.
5. 비교 대상은 **토큰 비용과 계획의 파일 목록**이다 — 순위가 달라도 계획이 같으면 이득이 없다.

A 와 B 가 같은 계획을 내는데 B 가 더 비싸면 그 자리는 끄는 것이 맞다. 그것도 결과다.

---

## 9. 한계

- **`review.prefilter` 의 의심 항목은 ⑨ 에 남지 않는다** — `code-agent review` 의 stdout 에만 실린다.
  지적 표는 `ca-reviewer` 가 쓰고 회차 구역은 코드가 바이트로 대조하므로, 코드가 지적 표에 쓰면 그 대조가 흔들린다.
  나중에 "그때 뭘 짚었나" 를 보려면 `.code-agent/log/plugins/review.prefilter.jsonl` (커밋되지 않는다) 을 본다.
- **`verify.extra` 는 등록한 사람에게만 엄격해진다** — 플러그인 런이 `failed` 면 등록자는 `check` 에서 막히고,
  등록하지 않은 팀원은 막히지 않는다. 자기 PC 에 린터를 하나 더 건 것과 같은 성질이라 의도대로 둔다.
- **2분 넘는 검사는 플러그인으로 못 쓴다** — 긴 것은 매니페스트 `commands` 로 (§2.5).
- **제한 시간은 어댑터가 남긴 손자 프로세스까지 묶지 못한다** — stdout 파이프를 물려준 채 백그라운드로 남기면
  호출이 타이머 뒤에도 기다린다 (§2.5). 진짜 상한은 비동기 실행 + 프로세스 그룹 종료가 필요하다.
- **직접 TTY의 키 입력은 화면에 보인다.** 같은 세션 확인은 기존 환경변수 이름을 사용한다 (§6).
- **`code.index` 는 등록만 되고 호출 지점이 없다** (§1).
- **A/B 토큰 비교는 아직 못 했다** — 실제 Jev 가 필요하다 (§8).
