# 플러그인 — 명령 어댑터 계약

플러그인 등록·제거·키 보관 규칙은 Claude와 Codex에서 공유한다. 아래 Claude 선택 화면 대신 Codex에서는 [사용자 메시지 동의](codex.md#사용자-확인)를 관찰한다. 키 환경 변수는 사용 중인 호스트를 시작한 환경에 준비하며 실제 값을 대화에 보내지 않는다.

> 왜 이 모양인가는 [design.md §6](design.md#6-플러그인과-도구), 무엇을 치는가는 [usage.md §10](usage.md#10-플러그인-선택),
> code-agent 자체의 설치·점검·지우기는 [install.md](install.md).
> 이 문서는 **어댑터를 쓰는 사람**을 위한 정본이다 — 요청·응답 형식, 등록, 키, 실패 규칙.

검증 노드 실행기(`code-agent verify`)는 `check`를 호출하므로 `verify.extra` 플러그인 결과와 실패 정책을 그대로 적용한다. 노드의 `program | agent | human` 구분은 내부 실행 방식이며 플러그인 slot이나 모델 호출 API가 아니다.

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
- [10. agent-knowledge 연결](#10-agent-knowledge-연결)

---

## 1. 자리(slot)

| 자리 | 부르는 명령 | 기본 구현 (등록 없이) |
|---|---|---|
| `survey.classify` | `code-agent survey` | 경로 규칙 + surveyor — 출력 끝에 분류 블록이 붙을 뿐 |
| `candidates.rank` | `code-agent context` (`impact` · `design`) | 내장 키워드 스캔 (결정론) |
| `context.docs` | `code-agent context` (`analysis` · `impact` · `design` · `plan`) | 지식 항목·문서 절의 키·경로·별칭·본문 검색 |
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
- **`context.docs`** — 등록된 문서(아키텍처 · 컨벤션 · KNOWLEDGE 5종)를 요청 때 읽어 KNOWLEDGE 는 ``### `키` `` 항목,
  POLICY 는 절 단위로 나누고, 키 일치 > 근거 경로 일치 > 걸린 항목이 가리키는 키 > 제목·별칭 낱말 > 본문 낱말 순으로 상위 10개를 고른다.
  저장해 두는 인덱스는 없다. 줄 범위·최신성·잘림 표시와 반드시 적용하는 업무 정책(`구분: 필수`, `관찰` 아님)은
  플러그인이 채운 결과에도 `code-agent context` 가 붙인다 — 플러그인 요청·응답 형식은 아래 표 그대로다.
  로컬 agent-knowledge 색인을 이 자리에 잇는 내장 어댑터는 §10 이다.
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
  "note": "요구 항목 텍스트와 파일 경로를 Jev 서버로 보냅니다",
  "accepts": []                          // 선택 — 받겠다는 선택 입력(§2.6). 없으면 선택 입력을 보내지 않는다
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
| `context.docs` | `{requirements:[{key,text}], docs:[{kind,path,headings:[{heading,line}]}], limit, phase?, files?, refs?}` — `?` 는 협의한 어댑터에만(§2.6) | `{sections:[{path, heading, why, ref?}], fallback?, diagnostics?, pinned?}` — `?` 는 선택(§2.6) |
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
(진짜 상한을 걸려면 비동기 실행 + 프로세스 그룹 종료를 하는 두 번째 러너가 필요하다 — 만들지 않는다.)

**2분 넘게 도는 검사는 플러그인으로 못 쓴다.** 긴 정적 분석은 매니페스트의 `commands` 로 선언한다 —
그 길은 이미 있고 `code-agent check` 가 돌린다.

### 2.6 선택 입력과 선택 출력 — `context.docs`

**선택 입력은 어댑터가 받겠다고 한 것만 보낸다.** 자리마다 선택 입력이 정해져 있고(`plugins/protocol.ts` `OPTIONAL_INPUTS`),
어댑터는 `describe` 의 `accepts` 에 `<자리>.<필드>` 꼴로 받을 것을 적는다(스키마는 128자 이하 문자열 256개까지로 모양만 본다). 등록은
이 code-agent 가 아는 토큰(`KNOWN_ACCEPTS`) 가운데 **등록하는 자리의 것만** 골라 사용자 스토어의 `adapter.accepts` 에 저장한다 — 모르는 토큰을
저장해 두면 나중 버전이 그 이름으로 무엇을 보내기 시작할 때 이 등록이 동의한 적 없는 입력을 받게 된다. 모르는 토큰이 있다고 등록을 거부하지는
않는다. 고른 것이 있으면 등록 미리보기에 `받는 선택 입력(accepts): …` 줄, `plugin list` 의 등록 줄에 `선택 입력 …` 이 붙는다.
이 협의를 모르는 릴리스가 같은 PC 에서 `plugin add`·`remove` 를 하면 스토어를 다시 쓰면서 `adapter.accepts` 가 지워진다. agent-knowledge 등록에
협의가 없으면 `plugin list` 가 `선택 입력 협의 없음 — plugin remove 뒤 다시 add` 로 보인다.

| 토큰 | 보내는 것 |
|---|---|
| `context.docs.phase` | 이 context 의 단계 — `analysis` · `impact` · `design` · `plan` 중 하나 |
| `context.docs.files` | 이 작업이 닿는 파일 — ② `02-analysis.md` 영향 범위 표의 파일 가운데 저장소 기준 상대 경로인 것(역슬래시·앞 `./`·끝 `/` 를 맞추고, 표에서 뽑힌 엔드포인트·절대 경로·`..` 는 뺀다). ② 가 없거나 남는 것이 없으면 싣지 않는다(analysis 에는 늘 없다) |
| `context.docs.refs` | master 가 이 작업에 인계한 지식 항목 참조 `[{itemId, generation, commit, itemSha256, required}]` ([master 연동 §11](master-control.md#지식-항목-참조-인계)). 없으면 싣지 않는다 |

`accepts` 가 없는 등록(선택 입력을 모르는 어댑터)에는 선택 필드가 하나도 가지 않는다 — **요청은 그 자리의 필수 입력뿐이다**
(`context.docs` 는 `requirements`·`docs`·`limit`). 그런 어댑터의 등록 미리보기에는 `accepts` 줄이 없다. 등록 화면의 자리별 입력 줄(`SLOT_SENDS`)은
`context.docs` 에 `(어댑터가 받겠다고 한 경우만: 단계 · 작업 파일 경로 · master 인계 근거 참조)` 를 덧붙인다.

**선택 출력은 낸 어댑터에만 적용한다.** 넷 다 없어도 된다 — 기존 어댑터의 응답은 그대로 통과한다.

| 필드 | 뜻 |
|---|---|
| `sections[].ref` | 그 절의 출처 참조. 스키마는 모양을 보지 않고 통과시키고 `code-agent context` 가 **절마다** 엄격히 검사한 뒤 지금 파일과 내용 해시가 맞은 범위만 싣는다(§10.6). 하나가 깨졌다고 호출 전체를 버리지 않는다 |
| `fallback` | `{code, message?}` — 이번 결과를 쓰지 말고 기본 검색으로 돌라는 요청. `code` 는 `^[a-z0-9][a-z0-9-]{0,63}$` |
| `diagnostics` | 객체. 지식 기록(§10.7)에만 남기고 화면(모델 입력)에 싣지 않는다 |
| `pinned` | `[{itemId, ok, reason?, section?}]` — 입력 `refs` 마다 어댑터가 되찾은 결과 |

`fallback` 이 기본 검색으로 돌리는 것은 **그 필드를 낸 어댑터뿐**이다. `ref`·`fallback` 을 내지 않는 어댑터가 정상으로 돌려준
빈 `sections` 는 지금처럼 "걸리는 항목 없음"이고 기본 검색으로 돌지 않는다.

---

## 3. 등록

```
code-agent plugin add <이름> --command "<argv>" [--slots a,b] [--sends-code] [--secret-env <기존 변수 이름>]   # 직접 실행은 TTY
code-agent plugin remove <이름>                                                 # 직접 실행은 TTY
code-agent plugin list                                                          # 누구나 (모델도)
```

등록·제거는 현재 호스트의 선택 화면에서 확인할 수 있다. 에이전트가 `plugin-add` 또는 `plugin-remove` action을 준비하고, [호스트별 동의 절차](usage.md#내부-처리)에서 실제 사용자 응답을 확인한 뒤 적용한다. 모델이 직접 `plugin add`·`plugin remove`를 실행해 사용자 확인을 건너뛰는 경로는 열리지 않는다. 일반 터미널에서 직접 실행할 때는 TTY 검사를 쓴다. `plugin list`는 상태만 읽으므로 모델도 부를 수 있다.

같은 세션의 등록 요청 예시는 다음과 같다. `MY_PLUGIN_KEY`는 **호스트를 시작한 환경에 이미 설정된 변수의 이름**이며 실제 키가 아니다. 에이전트는 값 조회·출력 명령을 실행하거나 사용자에게 채팅으로 실제 키를 보내 달라고 요청하지 않는다.

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
9. 저장 — 사용자 스토어에 명령·자리·`sendsCode`·키·동의 기록·probe 결과, 협의한 선택 입력(`adapter.accepts` — 고른 것이 있을 때만, §2.6).

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
        "user": "example-user", "host": "EXAMPLE-PC", "at": "2026-09-30T04:11:41.220Z",
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

### 비교만 하는 선언 — `shadow`

```jsonc
"plugins": { "agent-knowledge": { "shadow": ["context.docs"] } }
```

`shadow` 에 적은 자리는 **채우지 않는다.** 화면은 기본 구현(또는 그 자리를 `slots` 로 채우는 다른 플러그인)의 것 그대로이고,
등록이 있으면 그 결과를 다 만든 뒤 이 플러그인을 따로 불러 비교 기록만 남긴다(§10.7). 등록이 없으면 부르지도 기록하지도 않고
알림도 없다.

- 받는 자리는 `context.docs` 하나다(`core/manifest.ts` `SHADOW_SLOTS`) — 비교 기록을 만드는 자리가 그것뿐이라 다른 자리는 형식 오류다.
- 한 플러그인이 같은 자리를 `slots` 와 `shadow` 에 함께 적으면 형식 오류다 — 쓰는지 비교만 하는지 정해지지 않는다.
- 두 플러그인이 같은 자리를 `shadow` 로 선언하면 형식 오류다.
- `mode` 필드가 아니라 따로 둔 배열인 이유: 이 키를 모르는 이전 릴리스(다른 팀원의 PC 등)는 키를 버린다. `slots` 가 비어 있으므로
  그 릴리스는 기본 구현으로 돈다 — 비교만 하라는 선언이 이전 릴리스에서 결과를 쓰는 선언으로 바뀌지 않는다.
- `plugin list` 는 그 자리의 `지금 채우는 것` 칸 끝에 `· <이름> 비교만(shadow)`(등록이 없으면 `— 등록 없음, 부르지 않음`)을,
  저장소 선언 목록에 `비교만(shadow) context.docs — 결과를 쓰지 않고 비교 기록만` 을 찍는다.

### 승인은 무효가 되지 않는다

`plugins` 는 `hashManifest` 에 들어가지 않는다 — 경계도 검증 선언도 아니고, 플러그인은 런을 **더하기만** 하므로
승인이 본 경계를 넓히지 못한다. `plugins` 를 더해도 **기존 계획 승인은 한 건도 무효가 되지 않는다** (테스트로 못 박혀 있다).
`shadow` 도 `plugins` 안이라 같다. 다만 `code-agent.json` 파일은 계획 배정의 입력(`planningState.ts`)·동의 스냅샷·준비 커밋에
들어가므로, 선언을 바꾸면 다른 선언을 바꿀 때처럼 진행 중인 계획 배정은 입력이 바뀐 것으로 보고 준비해 둔 동의는 스냅샷이
달라져 적용되지 않는다.

---

## 5. 자리 해결 순서와 실패

호출 한 번은 이 순서로 정해진다.

1. `code-agent.json` 의 `plugins` 에서 그 자리를 선언한 이름을 찾는다. 없으면 → **기본 구현, 알림 없음.**
2. 그 이름이 이 PC 에 등록돼 있고 등록이 그 자리를 덮는가? 아니면 → **기본 구현 + 알림 한 줄**:
   `자리 candidates.rank 는 code-agent.json 이 jev 를 선언했지만 이 PC 에 등록돼 있지 않습니다 — 기본 구현으로 돕니다 (code-agent plugin add jev).`
3. 호출한다. 실패하면 → **기본 구현 + 알림 한 줄**:
   `플러그인 jev(candidates.rank) 가 실패해 기본 구현으로 돕니다: <이유>. 자세한 것은 .code-agent/log/plugins/candidates.rank.jsonl`

**플러그인 실패는 명령을 세우지 않는다.** `context` · `survey` · `review` · `check` 는 전부 정상 종료하고 알림 한 줄만 는다.

비교만 하는 선언(`shadow`, §4)은 이 순서 밖이다 — 자리를 채우지 않고, 실패해도 알림 없이 기록만 남는다.

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

`.code-agent/log/plugins/<slot>.jsonl` — 호출마다 한 줄, **마지막 200줄만** 남는다. 비교만 한 호출(`shadow`)의 줄에는
`"mode":"shadow"` 가 붙는다. `request` 는 협의 뒤 실제로 보낸 입력의 요약이다.
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

플러그인의 효과는 "Jev 켜고/끄고 같은 저장소 A/B 토큰 비교" 로 잰다. **실제 Jev 가 없어 아직 재지 못했다** —
붙으면 이 절차로 잰다. Jev 어댑터는 Jev CLI 나 얇은 래퍼 스크립트를 `--command` 로 가리키면 된다
(code-agent 안에는 Jev 네트워크 코드가 한 줄도 없다).

1. **같은 지시서 · 같은 기준 커밋**으로 작업 둘을 만든다 — `--target` 을 달리하거나 저장소 사본 둘.
2. A 는 `code-agent.json` 의 `plugins` 를 **비운다**.
   B 는 `{"jev":{"slots":["candidates.rank","review.prefilter","survey.classify"]}}`.
3. 둘 다 `/ca-request <동일한 요구사항>`으로 시작해 같은 화면에서 **계획 승인까지** 진행한다. 중단 후 재개할 때만 `/ca-next`를 사용한다.
   스테이지마다 비용·시간을 구간 · 비용 · 시간 · 결과 표로 적는다(`code-agent usage --work <ID>` 가 스테이지별로 센다).
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
- **agent-knowledge 연결은 실제 호스트 세션에서 확인하지 않았다** — 한계와 의존하는 계약은 §10.8.

---

## 10. agent-knowledge 연결

`code-agent plugin agent-knowledge` 는 로컬 agent-knowledge CLI 를 `context.docs` 자리에 잇는 **내장 어댑터**다.
다른 플러그인과 같은 계약(§2)으로 등록하고 선언한다 — 코어가 agent-knowledge 를 직접 부르는 길은 없다.

### 10.1 무엇을 하고 무엇을 하지 않나

- **읽기 명령만 부른다** — `search`·`get`·`status`. `index`·`eval` 같은 쓰기 명령을 부르지 않고 원본 문서·색인 DB 를 바꾸지 않는다.
  agent-knowledge 의 요청 스키마가 엄격해(모르는 키 거부) 그 CLI 가 이미 아는 필드만 보낸다.
- **본문·발췌를 싣지 않는다.** 어댑터가 넘기는 것은 경로·제목·줄 범위·해시·상태(출처 참조 `ref`)뿐이고, `get` 의 `content`·`search` 의
  `excerpt` 는 버린다. 화면에 싣는 범위는 `code-agent context` 가 지금 작업 트리 파일을 읽어 내용 해시로 확인한 것뿐이다(§10.6).
- **검색 결과는 한 세대만 합친다.** 둘째 질의부터 첫 응답의 색인 세대(`version.generation`)에 고정한다. 인계 참조는 인계받은 세대로 되찾는다.
- **지원 단계는 `analysis`·`impact`·`design`·`plan` 뿐이다** — `context.docs` 가 불리는 곳이다. `implement` 이후 단계는 부르지 않는다.
- 반드시 적용하는 업무 정책·작업 경험·줄 범위·최신성은 지금처럼 `code-agent context` 가 붙인다. 어댑터는 순위만 바꾼다.
- **어댑터는 `code-agent context` 가 플러그인으로만 부른다.** 세션·작업 중 모델의 셸 허용 목록에서 `plugin` 하위 명령은 `plugin list`
  뿐이라(`hook.ts` `MODEL_SUBCOMMANDS`) hook 이 이 하위 명령을 막고, 세션이 없을 때도 `decideOutside` 가 막는다 — 관리 실행의 허용 도구
  `Bash(code-agent *)` 로 어댑터 설정의 실행 명령이 열리지 않게. 관리 실행의 기본 허용 도구에도 agent-knowledge 를 넣지 않는다.
  hook 은 사고 방지 장치라 글자를 쪼갠 셸 명령까지는 막지 못한다. 이 하위 명령은 상태·실행 타임라인을 쓰지 않는다.
- code-agent·어댑터는 네트워크를 쓰지 않는다. 어댑터로 가는 것은 `context.docs` 입력(요구 항목 문장·등록된 문서의 경로와 제목)과
  협의한 선택 입력이고, 어댑터는 질의·작업 파일·참조를 로컬 agent-knowledge 프로세스에 넘긴다(`describe` 의 `sendsCode: false`).

### 10.2 모드

모드는 저장소 선언(`code-agent.json`)이 정한다. 기본값은 off 다.

| 모드 | 선언 | 하는 일 | 모델 입력 |
|---|---|---|---|
| off | 없음 | agent-knowledge 를 부르지 않는다. 등록이 있어도 같다 | 기본 검색의 화면 그대로다(작업에 master 인계 참조가 있을 때만 재확인 블록이 더해진다, §10.6) |
| shadow | `"plugins": {"agent-knowledge": {"shadow": ["context.docs"]}}` | 기본 검색으로 화면을 다 만든 뒤 어댑터를 따로 불러 같은 검증을 하고 "enabled 였다면 보였을 범위"와 비교한 기록만 남긴다(§10.7) | off 와 같다 |
| enabled | `"plugins": {"agent-knowledge": {"slots": ["context.docs"]}}` | 어댑터 결과 가운데 지금 파일과 해시가 맞은 범위만 참고 문서 순위로 쓴다. 기본 검색 요청·검증 실패면 기본 검색 | 확인된 범위·부분 범위 줄·검증 제외 줄·인계 블록 |

- 선언 제약은 §4 — 한 플러그인이 같은 자리를 `slots`·`shadow` 에 함께 적거나 두 플러그인이 같은 자리를 `shadow` 로 선언하면 형식 오류다.
- 선언이 있어도 이 PC 에 등록이 없으면 shadow 는 아무것도 하지 않고, enabled 는 기본 구현 + 알림 한 줄(§5)이다.
- **연결 해제**는 선언을 지우거나 `shadow` 로 옮기면 된다. 작업·등록을 지우지 않아도 다음 context 부터 기본 검색으로 돈다.
  다만 master 가 그 작업에 인계한 참조가 있으면 enabled 어댑터가 없으므로 `required` 참조가 `adapter-unavailable` 로 재확인 블록에 남는다(§10.6).
- 이 키를 모르는 이전 릴리스는 `shadow` 를 버리고 기본 구현으로 돈다(§4). 이전 릴리스에는 이 어댑터 하위 명령도 없다.
- master `hello` 는 이 모드를 `knowledge.mode` 로 알린다. 인계 참조는 enabled·등록·`context.docs.refs` 협의가 모두 있을 때만 받는다
  ([master 연동 §3·§11](master-control.md#지식-항목-참조-인계)).

### 10.3 설정·등록·제거

**설정 파일** — 어댑터는 다음 순서로 처음 찾은 하나를 읽는다.

1. 어댑터 인자 `--config <파일>`
2. 환경변수 `CODE_AGENT_KNOWLEDGE_CONFIG`
3. `<키 저장소>/agent-knowledge.json` — 키 저장소는 `CODE_AGENT_HOME`, 없으면 `~/.code-agent`(§3 사용자 스토어와 같은 자리)

1·2 의 경로는 **절대 경로**여야 한다 — 어댑터는 저장소마다 다른 위치에서 돌아 상대 경로면 저장소가 설정(곧 실행 파일)을 고르게 된다.
설정 안의 상대 경로(`command` 의 경로·`sourcesConfig`·`retrievalConfig`·`db`·`projects[].root`)는 **이 설정 파일의 폴더** 기준이고,
agent-knowledge 도 그 폴더를 작업 위치로 돈다. 기본 위치는 키 저장소 아래라 모델의 읽기·검색을 hook 이 막는다(§6).

스키마는 엄격하다 — 모르는 키·범위 밖 값은 `adapter-config-invalid` 다. 오타 난 키가 조용히 무시되면 사람은 그 값이 적용된 줄 안다.

```jsonc
{
  "schemaVersion": 1,
  "command": ["node", "D:/tools/agent-knowledge/dist/src/cli/main.js"],   // 또는 ["agent-knowledge"]
  "sourcesConfig": "D:/kb/sources.yaml",        // 선택 → agent-knowledge --config
  "retrievalConfig": "D:/kb/retrieval.yaml",    // 선택 → --retrieval-config
  "db": "D:/kb/knowledge.sqlite",               // 선택 → --db
  "projects": [ { "root": "C:/IdeaProjects/orders", "project": "orders", "sources": ["orders"] } ],
  "limits": { "timeoutMs": 8000, "maxQueries": 4 }
}
```

| 키 | 뜻 |
|---|---|
| `schemaVersion` | `1` |
| `command` | agent-knowledge 를 실행하는 argv 접두(1개 이상). 셸 없이 실행한다(Windows `.cmd`·`.bat` 은 cmd.exe 로 한 줄). 첫 낱말이 이름뿐이면 **PATH 에서만** 찾고, 경로를 적었으면 설정 파일 폴더 기준이다 |
| `projects` | `[{root, project, sources?}]` 1개 이상. `root` 는 저장소 루트, `project`·`sources` 는 agent-knowledge 의 프로젝트·원본 ID(`^[a-z0-9][a-z0-9._-]{0,63}$`). `sources` 를 적으면 그 원본의 항목만 쓴다. 같은 `root` 를 두 번 적으면 형식 오류다 |
| `sourcesConfig` · `retrievalConfig` · `db` | 선택 — 각각 agent-knowledge 의 `--config`·`--retrieval-config`·`--db` 로 간다 |
| `limits` | 선택 — 아래 표. 적지 않은 키는 기본값 |

| `limits` 키 | 범위 | 기본 | 묶는 것 |
|---|---|---|---|
| `timeoutMs` | 1000~15000 | 8000 | agent-knowledge 호출 하나의 제한 시간(남은 전체 마감보다 길지 않다) |
| `maxOutputBytes` | 65536~16777216 | 8388608 | 호출 하나의 stdout |
| `maxQueries` | 1~8 | 4 | 검색 질의 수 |
| `queryChars` | 50~1000 | 400 | 질의 하나의 글자 수(코드 포인트) |
| `maxPaths` | 0~200 | 50 | 검색에 보내는 작업 파일 수 |

요청 하나의 전체 마감은 15초다(`context.docs` 자리 상한 20초 안, §2.5). `probe` 는 8초다(handshake 상한 10초 안 — 넘기 전에 어댑터가 사유를 담아 답한다).
남은 시간이 1초보다 짧으면 다음 호출을 시작하지 않는다. 되찾는 인계 참조 수는 master 계약 상한(`MAX_KNOWLEDGE_REFS` 20)에 고정이다 —
`hello` 가 알리는 상한과 어긋나지 않게 설정으로 줄이지 않는다.

**저장소 대응** — 요청의 `repoRoot`(probe 는 실행 위치)를 실제 경로·슬래시·끝 슬래시 없음·(Windows 는) 소문자로 맞춰 `projects[].root` 와
같을 때만 그 프로젝트를 검색한다. 대응이 없으면 `project-not-mapped` 로 실패하고 agent-knowledge 를 부르지 않는다.

**등록** — 설정 파일을 먼저 만든다. 없으면 `probe` 가 실패해 등록되지 않는다. 같은 세션에서는 다음 동작을 준비한다(§3).

```json
{ "action": "plugin-add", "name": "agent-knowledge", "command": "code-agent plugin agent-knowledge", "slots": "context.docs" }
```

직접 TTY 에서는 `code-agent plugin add agent-knowledge --command "code-agent plugin agent-knowledge" --slots context.docs` 다.
설정을 기본 위치 밖에 두면 `--command "code-agent plugin agent-knowledge --config D:/kb/agent-knowledge.json"` 처럼 인자로 준다.
`code-agent` 도 첫 낱말이라 PATH 에서만 찾는다(§6).

- `describe` — `{name: "agent-knowledge", adapterVersion: <code-agent 패키지 버전>, slots: ["context.docs"], sendsCode: false, accepts: ["context.docs.phase", "context.docs.files", "context.docs.refs"], note: "로컬 agent-knowledge CLI 읽기 전용(search·get·status) — 색인·DB 쓰기 없음"}`. 키는 없다.
- `probe` — 설정을 읽고 `status` 로 `agent-knowledge.status` v1 과 활성 세대를 확인한다. 등록하는 위치가 대응된 저장소면 그 프로젝트의 원본이
  활성 세대에 색인돼 있어야 한다(없으면 `project-not-indexed`). 대응되지 않은 위치에서 등록하면 준비됨으로 두고 그 사실을 `detail` 에 적는다.

**저장소 선언** — 먼저 비교만 하고, 기록을 본 뒤 쓰기로 바꾼다.

```jsonc
// 비교만 — 화면은 기본 검색 그대로
"plugins": { "agent-knowledge": { "shadow": ["context.docs"] } }
// 사용 — 확인된 범위를 참고 문서 순위로
"plugins": { "agent-knowledge": { "slots": ["context.docs"] } }
```

**제거** — `{"action":"plugin-remove","name":"agent-knowledge"}`(직접 TTY 는 `code-agent plugin remove agent-knowledge`)로 등록을 지우고,
설정 파일(`~/.code-agent/agent-knowledge.json` 등)은 따로 지운다. 저장소 선언은 팀 것이라 제거가 건드리지 않는다.

### 10.4 한 번의 호출

1. **인계 참조** — 입력 `refs` 가 있으면 먼저 되찾는다(20개까지). 개수가 정해져 있고 실패가 근거 재확인으로 이어지므로, 마감에 걸려
   건너뛰는 것은 뒤의 검색 질의 쪽이다. 참조마다 `get` 에 `{id, profile: "code", scope: {projects: [<대응 프로젝트>]}, version: {generation}}` 을
   보내고, 응답의 세대·항목 ID·대응 프로젝트·원본·경로(이번 `docs` 안)·커밋·`itemSha256` 을 차례로 대조한다. 폐기 항목도 되찾은 그대로 내고
   상태 표시는 호스트가 한다. 결과는 `pinned` 이고, 맞은 것의 `section.ref` 에 `pinned: true` 가 붙는다.
2. **질의** — 요구 항목 문장의 공백을 정리하고 같은 글을 지운다. `maxQueries` 이하면 항목마다 하나, 넘으면 순서를 지켜 `maxQueries` 묶음으로 이어
   붙인다(뒤 항목을 버리지 않는다). 질의마다 `queryChars` 이하로(가능하면 공백에서) 자른다. 남은 질의가 없으면 `no-query` 다.
3. **검색** — `<command…> search [--config …] [--retrieval-config …] [--db …] --request -` 에 stdin 으로
   `{profile: "code", query, scope: {projects: [<대응 프로젝트>]}, version?: {generation}, task?: {phase?, paths?}, limit}` 을 보낸다.
   `task` 는 협의한 단계·작업 파일(`maxPaths` 까지)이 있을 때만 싣는다. 작업 파일은 저장소 기준 상대 경로만 보낸다 — agent-knowledge 는 하나라도
   아니면 요청 전체를 거부하므로(`invalid-path`) 엔드포인트·절대 경로·`..` 는 빼고 그 수를 `pathsDropped` 에 남긴다. `limit` 은 요청 `limit` 의
   두 배(최대 50, `requestLimit`)다 — 거른 뒤에도 `limit` 을 채우려고 넉넉히 받고 합친 뒤 자른다. 종료 코드 3 + `status: "no-results"` 는 오류가 아니다.
4. **거르기** — 직접 결과(이유에 `explicit-key`·`path-overlap`·`keyword-match` 중 하나)만 쓴다. 필수 지정·의존·연결 항목은 세기만 한다 —
   반드시 적용하는 정책은 code-agent 가 따로 붙인다. 대응 프로젝트·`sources` 밖, 상대 경로가 아니거나 이번 `docs` 밖의 경로, 항목 ID·세대·원본 커밋·해시
   꼴·줄 범위가 응답의 색인 정보와 어긋나는 항목, 폐기 항목은 뺀다.
5. **합치기** — 질의마다 거른 직접 결과의 순번 p(0부터)로 Σ 1/(10+p) 를 매기고, 같으면 항목 ID 의 바이트 순이다. 위에서 `limit` 개.
6. **출력** — 절마다 `{path, heading, why, ref}`. `heading` 은 키가 있으면 `` `<키>` <제목> ``, 없으면 `<제목>`, `why` 는
   `agent-knowledge <이유>`(이유는 `·` 로 잇는다)다. `ref` 는 agent-knowledge 필드 이름 그대로다 — `engine: "agent-knowledge"`·`itemId`(`<원본>:<경로>#<위치>`)·`projectId`·`sourceId`·`generation`·`commit`·`blobSha`·`documentSha256`·
   `itemSha256`(원본 **문서** 줄 `startLine`..`endLine` 을 `\n` 으로 이은 글의 SHA-256)·`startLine`·`endLine`·`unit`(`document`·`section`·`entry`)·
   `kind`·`status`·`confirmed`·`declaredStatus`·`reason?`·`pinned?`.
7. **진단** — `diagnostics` 에 세대·원본 커밋·파서 등 버전·질의 수·잘라 낸 글자 수·건너뛴 질의·직접 결과 수·돌려준 수·뺀 사유별 수·제약 코드·
   호출 수·소요·인계 결과 수를 싣는다. 본문·발췌는 싣지 않는다.

응답은 언제나 종료 코드 0 과 봉투 하나다. 첫 오류에서 멈추고 `ok:false` 의 `error` 를 `<코드>: <설명>` 으로 낸다 — 호스트는 기본 구현 + 알림
한 줄로 돈다(§5). 인계 참조가 있으면 검색이 실패해도 `ok:true` 로 `pinned` 를 내고 검색 실패는 `fallback` 으로 바꿔 싣는다.
전체 마감에 닿으면 — 다음 질의를 시작할 시간이 없거나, 진행 중인 질의가 마감 때문에 줄인 제한 시간에 끊기면 — 남은 질의를 건너뛰고
(`queriesSkipped`) 앞 질의에서 받은 결과를 쓴다. 첫 질의도 마치지 못했으면 `timeout` 이다.

### 10.5 코드

**오류 코드** — `ok:false` 봉투의 `<코드>`, `probe` 실패의 `detail` 머리.

| 코드 | 언제 |
|---|---|
| `invalid-request` · `usage` · `unsupported-op` · `unsupported-slot` · `invalid-input` | 요청 봉투·인자·op·자리·`context.docs` 입력이 계약과 다르다(인자는 `--config <파일>` 하나만 받는다) |
| `adapter-config-missing` · `adapter-config-invalid` | 설정 파일이 없다 · 상대 경로·JSON 아님·스키마 위반·같은 `root` 두 번 |
| `project-not-mapped` | 요청의 저장소가 `projects` 에 없다 |
| `project-not-indexed` | (probe) 대응 프로젝트의 원본이 활성 세대에 없다 |
| `not-installed` · `spawn-failed` | agent-knowledge 실행 파일이 없다(`node <스크립트>` 의 스크립트가 없어 `Cannot find module` 로 끝난 경우 포함) · 실행하지 못했다 |
| `timeout` · `output-too-large` | 호출 제한 시간·전체 마감 · `maxOutputBytes` 를 넘었다 |
| `invalid-json` · `invalid-response` · `unsupported-version` | stdout 이 JSON 이 아니다 · 응답 구조가 다르다(오류 봉투 없는 0 아닌 종료, 고정한 세대가 아닌 응답 포함) · `schema`·`schemaVersion` 이 `agent-knowledge.<명령>` v1 이 아니다 |
| agent-knowledge 의 `error.code` | 오류 봉투(`agent-knowledge.error` v1)의 코드 그대로 — `index-missing`·`invalid-scope`·`config-invalid`·`invalid-request`·`usage`·`not-found` 등. 식별자 꼴(`^[a-z0-9][a-z0-9-]{0,63}$`)이 아니면 `agent-knowledge-error` |
| `adapter-error` | 어댑터 안의 예상하지 못한 예외 |

**기본 검색 요청(`fallback.code`)**

| 코드 | 언제 |
|---|---|
| `no-query` | 요구 항목 문장이 비어 질의를 만들지 못했다 |
| `no-results` | 모든 질의가 결과 없음(종료 코드 3)이거나, 직접 결과도 필수 지정 자료도 없다 |
| `mandatory-only` | 직접 결과 없이 필수 지정 자료만 왔다 |
| `no-usable-items` | 직접 결과가 있었지만 모두 거르기(10.4 의 4)에서 빠졌다 |
| 검색 오류 코드 | 인계 참조가 있는 요청에서 검색이 실패했다(위 오류 코드 그대로) |
| `no-verified-items` | (호스트) 참조 절만 왔는데 지금 파일과 하나도 맞지 않았다 — 어댑터가 내는 코드가 아니다 |

**인계 참조 결과(`pinned[].reason`)** — 어댑터가 낸 것과 호스트가 다시 대조한 것이 함께 재확인 블록에 나온다.

| 코드 | 낸 곳 | 언제 |
|---|---|---|
| `too-many-refs` | 어댑터 | 20개(master 계약 상한)를 넘은 참조 |
| `invalid-ref` | 어댑터·호스트 | 참조 꼴이 틀렸거나 항목 ID 가 겹친다 · 기록에서 읽은 인계의 꼴이 깨졌다(어댑터에 묻기 전에) · 되찾은 절이 없거나 그 출처 참조가 깨졌거나 항목 ID 가 다르다 |
| `out-of-scope` | 어댑터 | 대응 프로젝트·`sources` 밖의 원본 |
| `generation-expired` | 어댑터 | 그 세대가 색인에 없다(보존 범위에서 지워졌다 등) |
| `not-found` | 어댑터 | agent-knowledge 가 그 항목을 찾지 못했다 |
| `not-in-docs` | 어댑터·호스트 | 이번 요청의 등록 문서 밖 경로 |
| `commit-mismatch` · `hash-mismatch` | 어댑터·호스트 | 되찾은 항목의 커밋·`itemSha256` 이 인계와 다르다 |
| `generation-mismatch` | 호스트 | 되찾은 절의 세대가 인계와 다르다 |
| `invalid-response` · 호출 오류 코드 | 어댑터 | `get` 응답이 계약과 다르다 · 위 오류 코드 |
| `missing-file` · `content-changed` · `ambiguous` | 호스트 | 지금 파일에서 그 범위를 확인하지 못했다(§10.6) |
| `not-returned` | 호스트 | 어댑터가 그 참조의 결과를 내지 않았다 |
| `adapter-rejected` | 호스트 | 어댑터의 사유가 코드 꼴이 아니다 — 자유 글은 모델 입력에 싣지 않는다 |
| `adapter-unavailable` | 호스트 | enabled 어댑터가 없다·호출이 실패했다·등록이 `context.docs.refs` 를 협의하지 않았다 |

### 10.6 호스트 검증 — `code-agent context`

출처 참조가 있는 절은 어댑터가 무엇을 주든 `code-agent context` 가 **지금 작업 트리의 파일**과 대조한 범위만 싣는다
(`knowledgeRefs.ts` `verifySectionRef`). `ref` 가 없는 절은 지금까지처럼 인덱스로 되찾는다(§1).

1. **참조 꼴** — 모르는 키, 16진 꼴(커밋·`blobSha` 40자, 해시 64자, 소문자), 정수·`generation ≥ 1`·`startLine ≤ endLine`, 열거값을 엄격히 본다.
   항목 ID 가 `<sourceId>:<절의 path>#` 로 시작하지 않으면 다른 문서의 해시이므로 받지 않는다. 어긋나면 `invalid-ref`.
2. **경로** — 저장소 기준 상대 경로(역슬래시·절대·드라이브·`..`·`.`·빈 구성요소 없음)이고 이번 요청의 `docs` 경로 안이어야 한다. 아니면 읽지 않고 `not-in-docs`.
3. **읽기** — BOM 을 떼고 `\r?\n` 으로 나눈다(agent-knowledge 가 해시를 낸 원본 줄과 같은 단위). 파일이 없으면 `missing-file`.
4. **범위 확인** — 적힌 줄 범위의 해시가 맞으면 그대로(exact). 아니면 같은 길이의 창을 **제목 줄(`#`~`######`)에서 시작하는 자리에서만**
   찾아 정확히 한 곳이 맞으면 그 범위로 옮긴다(moved). 둘 이상이면 `ambiguous`, 없으면 `content-changed`. 문서 단위 항목(`unit: "document"`)은
   exact 만 받는다. 과거 줄 번호·같은 제목을 그대로 믿지 않는다 — 언제나 해시로 확인한 범위만 쓴다.
5. **커밋** — 참조의 커밋이 HEAD 와 다르거나 범위를 옮겨 찾았으면 거부하지 않고 `기준 커밋 <7자> — 현재 파일과 일치 확인` 을 붙인다.

확인된 범위는 이렇게 싣는다.

- 인덱스 항목과 경로·시작·끝 줄이 모두 같으면 그 항목 줄 — 줄 범위·최신성·반드시 적용하는 정책 연결이 그대로 붙는다. 인덱스 절과 같으면 그 절.
  이 줄의 구분·상태는 code-agent 문서(업무 정책의 `구분`·`상태`, 개발 지침)가 정본이라, 어댑터 상태는 **낮추는 신호(관찰·충돌·폐기)만** 이유
  끝에 덧붙이고 확정·미확인 판정은 기록(`verified[].status`)에만 남긴다 — 두 도구의 확정 기준이 달라 한 줄에 `필수 확정` 과 `확정 근거 아님` 이
  함께 보이지 않게. 커밋 메모도 이유 끝에 붙는다.
- 아니면 **부분 범위 줄** — `- <path> L<시작>-L<끝> · <제목> (부분) [<상태 표시>] (<이유>)`. 제목은 시작 줄이 제목이면 그것, 아니면 바로 위 제목이고
  없으면 `(제목 없음)`. 같은 제목의 긴 원본 절 전체로 넓히지 않는다.
- 같은 (경로, 시작, 끝)은 한 번만. 어댑터 출력은 앞 50개 절까지 보고 10개를 실으면 멈춘다.

| `status` · `confirmed` | 부분 범위 줄의 상태 표시 — 어댑터의 상태를 올리지 않는다 |
|---|---|
| `confirmed_policy` · true | 확정 정책 |
| `verified_experience` · true | 검증된 경험 |
| `observed_behavior` | 관찰 — 현재 동작, 정책 아님 |
| `unverified`, 또는 `confirmed_policy`·`verified_experience` 인데 false | 미확인 — 탐색 참고, 확정 근거 아님 |
| `conflicted` | 충돌 — 확인 필요 |
| `deprecated` | 폐기 — 쓰지 않는다 |

목록 뒤에 붙는 줄:

- 거부한 절이 있으면 `- 검증 제외 <N>개 (사유 <a·b>) — .code-agent/log/knowledge/context.jsonl`.
- 어댑터가 `fallback` 을 내면 기본 검색 결과를 쓰고 출처 줄이 기본 구현이 되며 알림
  `플러그인 <이름>(context.docs) 가 기본 검색을 요청했습니다: <코드> — 기본 구현으로 돕니다.` 가 붙는다.
- 참조 절만 왔는데 하나도 확인하지 못하면 같은 방식으로 기본 검색을 쓰고 알림은
  `플러그인 <이름>(context.docs) 의 항목을 현재 파일과 하나도 대조하지 못했습니다: no-verified-items — 기본 구현으로 돕니다.` 다.

**반드시 적용하는 업무 정책** — 확인한 범위로 목록을 갈았으면, 기본 검색이 상위 10개에 올렸을 `구분: 필수`·관찰 아닌 업무 정책 가운데 화면에
없는 것을 `## 반드시 적용하는 업무 정책` 블록에 `(기본 검색이 고름)` 으로 더한다. agent-knowledge 는 필수 지정 항목을 직접 결과에서 빼고 어댑터도
그것을 쓰지 않으므로, 순위가 바뀌었다는 이유로 off 에서 보이던 필수 정책이 사라지지 않게 한다.

**인계 블록** — master 가 이 작업에 인계한 참조가 있으면(`master/workKnowledge.ts` `managedKnowledge` — 지금 작업의 연결, 작업 전이면 이 세션의
master 실행 기록) 어댑터의 `pinned` 를 위 1~4 로 다시 대조하고, 인계와 항목 ID·`itemSha256`·세대·커밋이 같은지도 본다. 참고 문서 목록·검증 제외 줄·
최신성 안내 뒤, 반드시 적용하는 업무 정책 앞에 둔다.

- 확인된 것 — `## 인계받은 지식 근거 (master — 항목·세대·해시를 현재 파일과 대조)` 아래 같은 줄 꼴로.
- 실패한 `required` 참조 — `## 근거 재확인 필요 (인계 항목 검증 실패 — 범위를 넓혀 다시 찾지 말고 이 작업의 근거를 다시 확인하거나 재계획을 요청한다)`
  아래 `- <itemId>: <사유>`. `required` 가 아닌 실패는 기록에만 남는다.
- 인계는 있는데 enabled 어댑터 호출이 없거나(off·shadow·등록 없음) 실패했거나 등록이 `refs` 를 협의하지 않았으면 모든 참조가 `adapter-unavailable` 이다.
  off 에서도 이 블록만 더해지고 나머지 줄은 그대로다.

### 10.7 기록 — `.code-agent/log/knowledge/context.jsonl`

진단·비교 기록이다. 끝 200줄만 남고 쓰기 실패는 삼킨다. 본문은 싣지 않는다 — 항목 ID·경로·줄 범위·사유·제목뿐이다.
`.code-agent/log/` 라 Git 이 무시하고 동의 스냅샷 밖이며, 승인 해시·계획 입력·모델 입력에 들어가지 않는다.
어댑터 호출 자체는 §5 로그(`.code-agent/log/plugins/context.docs.jsonl`)에 따로 남는다.

**언제 쓰나** — 어댑터 출력이 `ref`·`fallback`·`pinned`·`diagnostics` 중 하나를 쓸 때(이 필드를 모르는 어댑터는 기록을 남기지 않는다),
인계 참조가 있을 때(모드와 관계없이), 그리고 shadow 비교마다.

| 필드 | 뜻 |
|---|---|
| `at` · `mode` · `phase` · `plugin` | 시각 · 선언 모드(`off`·`shadow`·`enabled`) · 단계 · 플러그인 이름 |
| `inputHash` · `head` | 협의된 입력 JSON·HEAD·등록 문서 내용 해시(shadow 는 등록 지문까지)를 묶은 SHA-256 · HEAD 커밋 |
| `outcome` | 어댑터 결과 적용: `verified`(참조 확인)·`fallback`·`plugin`(참조를 쓰지 않는 출력), 인계만 있을 때: `plugin-failed`(enabled 호출 실패)·`not-registered`(enabled 인데 등록 없음)·`adapter-unavailable`(off·shadow). shadow 비교: `compared`·`shadow-failed` |
| `fallback` | `{code, by: "adapter" \| "host", message?}` |
| `verified` · `rejected` | `[{itemId, path, start, end, how: exact\|moved, status}]` · `[{itemId?, path, reason}]` |
| `pinned` | `[{itemId, required, ok, reason?, path?, start?, end?, how?}]` |
| `diagnostics` | 어댑터의 진단(64 KiB 를 넘으면 잘라 문자열로) |

shadow 기록에는 더 붙는다.

| 필드 | 뜻 |
|---|---|
| `durationMs` | 비교 호출 소요 |
| `baseline` | 화면에 실린 항목 `[{path, start?, end?, label, source}]` — `source` 는 `default` 또는 `plugin <이름>` |
| `candidate` | `{ok, error?, fallback?, verified, rejected, items}` — `items` 는 enabled 였다면 보였을 항목. 호출 실패·기본 검색 요청이면 기본 검색 결과다 |
| `comparison` | `{baseline, candidate, overlap, onlyBaseline, onlyCandidate}` — 개수. `overlap` 은 같은 경로에서 줄 범위가 겹치는 쌍(범위 없는 항목은 문서 전체) |

shadow 는 화면 줄을 다 만든 뒤 같은 프로세스에서 부른다 — 화면·승인·계획 입력·동의 스냅샷에 아무것도 더하지 않지만 `context` 가 그 호출만큼
늦어진다(어댑터 전체 마감 15초까지). shadow 의 `inputHash` 에는 등록 지문(명령·어댑터 버전·`describedAt`)도 들어간다. 기록 끝 50줄에 같은
`inputHash` 의 `compared` 가 있으면 다시 부르지 않고, `shadow-failed` 는 10분 동안만 다시 부르지 않는다 — 설정·색인을 고친 뒤에는 다시 비교하되
고장 난 연결이 context 마다 마감만큼 늦추지 않게. 입력·HEAD·등록 문서·등록 가운데 하나가 바뀌면 바로 다시 부른다. 무엇이 실패해도 던지지 않는다.

### 10.8 상태와 한계

- **실제 Claude·Codex 호스트 세션에서는 확인하지 않았다.** 자동 시험은 가짜 agent-knowledge CLI(`src/test/agentKnowledgeFixture.ts`)로 돌고,
  실제 CLI 와 맞춘 결과·조건은 [검증 기록](reviews/2026-11-10-agent-knowledge-validation.md)에 있다.
- **agent-knowledge 커밋 `695de23` 에서 확인한 CLI 계약에 기댄다** — `search`·`get`·`status` 의 `--request -` 입력, `agent-knowledge.<명령>` v1 응답,
  결과 없음의 종료 코드 3, 오류 봉투 `agent-knowledge.error` v1. 이 꼴이 바뀌면 `unsupported-version`·`invalid-response` 로 기본 검색에 떨어진다.
- 색인 DB 의 식별자가 없어 세대 번호는 DB 마다의 번호다. DB 를 바꾸면 같은 세대 번호가 다른 내용을 가리킬 수 있고, 그때는 해시 대조가 거른다.
- agent-knowledge 는 긴 절을 나누지 않아 한 항목의 줄 범위가 길 수 있다. 호스트는 확인한 범위를 그대로 싣고 줄이지 않는다.
- master 인계 참조는 제안 단계 계약이다([master 연동 §14](master-control.md#14-한계)).


## 계획 작업과의 관계

`planning prepare`·`dispatch`·`planning-event`는 내부 작업 배정과 실행 관찰 계약이다. 플러그인 slot이나 외부 모델 호출 API를 추가하지 않는다. 기존 후보 순위·문서 선택 플러그인 출력은 해당 영역 조사자에게 전달할 단서이며 근거·완료·critic 관찰을 대신하지 않는다. 기본 계획 흐름은 플러그인 없이 실행된다. 입력이 같은 조사 결과의 재사용은 같은 작업 안에서만 보장한다. 상세는 [계획 작업 안내](planning.md)를 참고한다.
