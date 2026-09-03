# 사용 가이드 — Postman 으로 끝까지 돌리기

> 개념과 설계는 [README](../README.md), 지시서 규격은 [work-order.md](work-order.md).
> 이 문서는 **실제로 요청을 보내는 법**이다. 신규(`bootstrap`)와 레거시(`adopt`) 둘 다 다룬다.

---

## 목차

- [시작 전에 — 어느 경로인가](#시작-전에--어느-경로인가)
- [0. 스펙 정의 — 무엇을 먼저 정하나](#0-스펙-정의--무엇을-먼저-정하나)
- [1. 준비물](#1-준비물)
- [2. 서버 띄우기](#2-서버-띄우기)
- [3. Postman 준비](#3-postman-준비)
- [4. 요청 아홉 개](#4-요청-아홉-개)
- [5. 신규 프로젝트 — 전체 순서](#5-신규-프로젝트--전체-순서)
- [6. 레거시 프로젝트 — 전체 순서](#6-레거시-프로젝트--전체-순서)
- [7. 사람이 멈추는 곳에서 하는 일](#7-사람이-멈추는-곳에서-하는-일)
- [8. 막히면](#8-막히면)

---

## 시작 전에 — 어느 경로인가

가르는 기준은 하나다. **복제할 코드가 있느냐.**

| | 신규 `bootstrap` | 레거시 `adopt` |
|---|---|---|
| 대상 | **빈 디렉토리면 된다** — 구조는 스캐폴더가 만든다 | 굴러가는 저장소 |
| `target` | 프로젝트 이름 (실재 안 해도 됨) | **저장소 경로 (실재해야 함)** |
| 템플릿 | `starter/bootstrap` 그대로 | `starter/adopt` 를 **복사해 고쳐서** |
| 단계 | 4 (`decisions`→`scaffold-plan`→`skeleton`→`declare`) | 2 (`survey`→`declare`) |
| 사람이 멈추는 곳 | 2군데 | 1군데 |
| 끝나면 | **끊긴다** — 첫 도메인은 손으로 | 바로 `feature` 로 이어짐 |

둘 다 같은 것을 만든다 — `code-agent.json` 과 컨벤션 문서. 그 둘이 이후 실행의 근거다.

> **스펙 문서 자체가 아직 없다면** 그 앞에 한 바퀴가 더 있다. `kind: spec` 은 씨앗 몇 줄에서
> 시작해 **묻고 답해** 스펙 한 장을 만든다 — 손으로 쓰는 대신 왕복으로 만드는 길이다.
> 산출물이 곧 `bootstrap` 의 입력이 된다. [0절](#0-스펙-정의--무엇을-먼저-정하나) 참고.

---

## 0. 스펙 정의 — 무엇을 먼저 정하나

**스펙이 저장소보다 먼저다.** 어떤 스펙이냐에 따라 만들어질 저장소의 모양이 달라지기 때문이다.
다만 스펙에 들어갈 것들이 전부 "사람이 미리 써야 하는 입력"은 아니다 — **두 층으로 갈린다.**

| 스펙 항목 | 신규 `bootstrap` | 레거시 `adopt` |
|---|---|---|
| **목적 · 무엇을 만드는지** | 🖊 사람이 먼저 쓴다 · 🗣 `spec` 이 물어 준다 | 🖊 사람이 먼저 쓴다 (도입 범위) |
| **만들 기능 · 도메인** | 🖊 이름만이라도 개요에 · 🗣 `spec` 이 물어 준다 | 🖊 표준 삼을 도메인을 고른다 (`reference`) |
| **프로젝트 현황** | — 시점 0. 없다 | ⚙ **코드가 정본.** `survey` 가 읽어낸다 |
| **인프라** (언어·프레임워크·빌드·영속) | ⚙ **결정** — `decisions` 가 묻고 사람이 답한다 | ⚙ 코드에서 읽어낸다 |
| **계층 구조 · 공통 규약** | ⚙ **결정** — 같은 왕복 | ⚙ 코드에서 읽어낸다 |
| **코드 컨벤션** | ⚙ **산출물** — `declare` 가 결정을 규칙 문장으로 옮긴다 | ⚙ **산출물** — 코드에서 읽어낸 것 |

🖊 = 사람이 먼저 쓴다 (근거가 없으면 지어낼 수밖에 없는 것)
🗣 = 앞선 `spec` 실행이 **물어서** 받는다 (쓰는 사람이 아니라 답하는 사람이 된다)
⚙ = 이 실행이 뽑아낸다 (미리 쓰지 않는 편이 낫다)

### 왜 인프라를 미리 안 쓰나

언어·프레임워크·계층·식별자 전략은 **요구사항이 아니라 결정**이다. 스펙에 적어 넣으면 그건
*이미 내린 결정*으로 처리되어 다시 묻지 않는다. 안 적으면 `decisions` 단계가 **선택지와
트레이드오프를 함께** 내주고, 고르지는 않는다.

```markdown
### D1 · 계층 구조
- (가) domain / application / infrastructure — 경계가 뚜렷하나 파일 수가 는다
- (나) controller / service / repository — 익숙하나 도메인 로직이 service 로 몰린다
```

**이미 사내 표준으로 정해져 있는 것만 적는다.** 그건 "이미 정해짐"으로 처리되고 질문에서
빠진다. 아직 안 정했는데 적으면 근거 없는 구조 위에 프로젝트 전체가 올라간다.

### 스펙을 손으로 쓰기 어렵다면 — `kind: spec`

빈 문서를 앞에 두고 무엇부터 적어야 할지 막히는 자리다. `spec` 은 그 한 장을 **왕복으로**
만든다 — 씨앗(머리말 네 줄 + 한두 줄)만 주면, **무엇이 비었는지는 코드가 판정해서** 묻는다.

```
씨앗 한 줄  →  코드가 빈칸을 찾아 묻는다  →  사람이 답한다  →  모델이 문서로 옮겨 적는다
                (starter/spec/spec-schema.json 이 목록)      (답에 없는 것은 못 쓴다)
```

무엇을 묻는지는 `starter/spec/spec-schema.json` 이 정한다 — 목적, 사용자·규모, 주요 도메인,
이번 범위, 그리고 참고 항목인 「이미 정해진 것」. **회사마다 다른 목록이므로 에이전트가 아니라
스타터가 들고 있다.** 항목을 더하거나 빼려면 그 파일을 고친다.

씨앗에 이미 적힌 것은 묻지 않는다. 모델이 **원문을 인용해** 옮겨 오고, 인용을 붙이지 못한
값은 코드가 미충족으로 처리하므로 지어낸 값이 통과할 자리가 없다.

> **`spec` 실행에는 대상 저장소가 없다.** `repo` 로는 **스펙 문서를 둘 폴더**를 가리킨다
> (예: `C:/IdeaProjects/specs`). 승인 기록이 그 안에 남으므로 그 폴더는 실재해야 한다 —
> 만들어 주지 않고 거부한다.

### 그래서 순서는 이렇게 된다

```
⓪ 씨앗 몇 줄       (선택) kind: spec — 물어 가며 ①을 만든다
       ↓
① 스펙(개요)      무엇을·누가·주요 도메인 이름 + 이미 정해진 제약
       ↓
② 계획 · 승인      빈 디렉토리 하나만 있으면 된다 (승인 기록이 거기 남는다)
       ↓
③ 결정 왕복        ← 인프라 · 계층 · 공통 규약을 묻고, 답이 그대로 결정서가 된다
       ↓
④ scaffold.md      ← 그 결정으로 스캐폴더 명령이 정해진다
       ↓
⑤ 스캐폴더 실행     ★ 프로젝트 실체가 여기서 처음 생긴다
       ↓
⑥ skeleton · declare  →  out/ 를 저장소에 옮기고 커밋
```

**프로젝트 실체는 ⑤에서 생긴다.** ①~④ 의 산출물은 전부 `out/` 안에 쌓인다.

---

## 1. 준비물

### 공통 — 빌드

```powershell
Set-Location C:\IdeaProjects\code-agent
npm run build
```

### 신규일 때 — 저장소를 먼저 만들지 않는다

**`bootstrap` 은 대상 저장소를 읽지 않는다.** 확인한 사실이다.

| | |
|---|---|
| 계획·질문 | 저장소 디렉토리가 없어도 나온다 |
| 산출물 | 전부 `out/` 에 쌓인다. 대상 저장소에 쓰지 않는다 |
| **승인** | **저장소가 실재해야 한다.** 없으면 만들지 않고 거부한다 |
| git | 필요 없다. **빈 디렉토리면 된다** |

빈 저장소를 `git init` 해서 "프로젝트를 만들어 두는" 것은 순서가 거꾸로다 — 디렉토리
레이아웃은 스캐폴더가 정하고, 스캐폴더 명령은 결정서가 나온 **뒤에** 정해진다.

```
스펙(개요)  →  결정 질문  →  사람이 답함  →  결정서  →  scaffold.md  →  ★ 여기서 프로젝트 실체가 생긴다
                            언어·프레임워크·계층이                    spring init / npm create …
                            여기서 정해진다
```

**다만 승인 전에는 그 디렉토리가 있어야 한다.** 승인 기록은 대상 저장소 안에 남기는데,
없는 경로를 만들어 주면 오타 난 곳에 아무도 승인한 적 없는 기록이 생기기 때문이다.

```
오류: 승인 기록을 남길 대상 저장소가 없습니다: C:/IdeaProjects/my-new-servcie
없는 경로에 디렉토리를 만들지 않고 멈췄습니다 — 경로 오타면 엉뚱한 곳에 승인 기록이 남습니다.
경로가 맞는지 확인하고, 맞다면 그 디렉토리를 먼저 만드세요.
```

빈 디렉토리 하나면 충분하다. 레이아웃은 여전히 스캐폴더가 정한다.

**① 스펙 문서** — 저장소보다 이것이 먼저다. **대상 저장소 밖 아무 데나** 두고 경로로 넘긴다
(예: `C:/IdeaProjects/specs/order-service.md`). 저장소가 아직 없기 때문이다.
손으로 쓰는 대신 [`kind: spec` 으로 물어 가며 만들 수도 있다](#스펙을-손으로-쓰기-어렵다면--kind-spec) —
그 실행의 산출물이 그대로 이 자리에 온다.
맨 위 머리말 네 줄이 없으면 0차 게이트가 막는다.
본문은 **「프로젝트 개요」 한 장이면 충분하다.**

```markdown
---
kind: bootstrap
id: NEW-1
title: 주문 관리 서비스 신규 구축
target: order-service
---

# 프로젝트 개요
사내 주문 관리 백엔드를 새로 만든다. 주문 접수 · 상태 변경 · 조회를 REST 로 제공한다.
사용자는 사내 100명 수준.

# 주요 도메인
order · customer · product
```

> **언어·프레임워크·계층은 적지 않는다.** 적으면 *이미 내린 결정*이 되어 다시 묻지 않는다.
> 안 적으면 01 단계가 선택지와 트레이드오프를 질문으로 내준다 — 아키텍처 결정서는
> 입력이 아니라 이 실행의 산출물이다.

**② 저장소 경로** — 만들 곳을 정한다. **빈 디렉토리만 만들어 둔다** — 승인이 그 안에 기록을
남기기 때문이다. `git init` 도, 구조를 잡는 것도 하지 않는다. 그건 ⑤에서 스캐폴더가 한다.

```powershell
New-Item -ItemType Directory -Force C:\IdeaProjects\my-new-service | Out-Null
```

**③ 템플릿** — `starter/bootstrap` 을 그대로 가리킨다. 고칠 것 없다.

### 레거시일 때

**① 스타터를 복사해 고친다.** 저장소 안의 `starter/adopt` 를 직접 고치지 않는다.

```powershell
$REPO = "C:\IdeaProjects\legacy-app"
Copy-Item -Recurse C:\IdeaProjects\code-agent\starter\adopt "$REPO\doc\templates"
```

`$REPO\doc\templates\code-agent.json` 에서 **세 곳**을 실제 값으로 바꾼다. 예시 값 그대로 두면
경로가 어긋난 채로 돈다.

| 키 | 무엇으로 |
|---|---|
| `domainBase` | 실제 소스 루트 (예: `src/main/java/com/acme/app`) |
| `domainRoots` | 그 아래 분류. 분류가 없으면 `[]` |
| `reads` | 실제 빌드 파일·설정 이름. gradle/npm/pip 마다 다르다 |

`reads` 에 소스 루트를 넣어 두면 조사 단계가 `list` 로 저장소를 처음부터 훑지 않는다 —
목록은 전부, 내용은 상한까지 실린다.

**② `spec.md`** — `target` 이 **저장소 경로**다. 실재하지 않으면 0차 게이트가 막는다.

```markdown
---
kind: adopt
id: ADOPT-1
title: legacy-app 에 code-agent 도입
target: .
---

# 도입 범위
주문(order) 도메인을 표준으로 삼는다. 신규 도메인을 이 구조대로 만들 예정.
```

**③ 표준 도메인을 고른다.** 작업 생성 때 `reference` 로 넘긴다. "이 도메인처럼 만들겠다"는
사람의 선택이고, 그 도메인의 파일 목록이 조사 단계의 근거다.

---

## 2. 서버 띄우기

```powershell
Set-Location C:\IdeaProjects\code-agent
node dist/cli/index.js serve --port 4319 --state .\.code-agent-server\jobs.json
```

```
code-agent 서버: http://127.0.0.1:4319
```

이 창은 켜 둔다. `127.0.0.1` 바인딩은 의도다 — 이 서버는 대상 저장소를 읽고 `build`·`test`
명령을 이 머신에서 실행하므로, 외부에 열면 그게 그대로 원격 명령 실행이 된다.

---

## 3. Postman 준비

### 환경 변수 둘

| 변수 | 초기값 |
|---|---|
| `base` | `http://127.0.0.1:4319/api/jobs` |
| `job` | (비워 둠 — 작업을 만들면 채운다) |

### 헤더

| 요청 | Content-Type |
|---|---|
| `/response` | `text/plain; charset=utf-8` — Body 는 **raw → Text** |
| 그 외 POST | `application/json; charset=utf-8` — Body 는 **raw → JSON** |

한글이 들어가므로 `charset=utf-8` 을 빼지 않는다.

### 프롬프트를 읽을 수 있게 — Visualize

`GET /prompt` 의 응답은 JSON 문자열이라 Postman 의 Body 탭에서는 `\n` 이 그대로 보인다.
**그대로 복사하면 안 된다.** 요청의 **Scripts → Post-response** 에 아래를 넣으면
Visualize 탭에 붙여넣을 수 있는 형태로 나온다.

```javascript
const body = pm.response.json();
pm.visualizer.set(
  "<pre style='white-space:pre-wrap;font-family:monospace'>{{p}}</pre>",
  { p: body.prompt || body.message || "(프롬프트 없음)" }
);
```

> 이 한 단계만은 화면(`http://127.0.0.1:4319`)이 더 편하다. 프롬프트 옆에 복사 버튼이 있다.
> Postman 으로 끝까지 가려면 위 Visualize 를 쓴다.

---

## 4. 요청 아홉 개

### ① 작업 생성

```
POST {{base}}
Content-Type: application/json; charset=utf-8
```

**신규:**

```json
{
  "label": "order-service",
  "repo": "C:/IdeaProjects/my-new-service",
  "templates": "C:/IdeaProjects/code-agent/starter/bootstrap",
  "out": "C:/IdeaProjects/code-agent/out-newproj",
  "specs": ["C:/IdeaProjects/specs/order-service.md"]
}
```

**스펙부터 만들 때** (`kind: spec` — 저장소가 아직 없다. `repo` 는 **스펙을 둘 폴더**다):

```json
{
  "label": "order-service-spec",
  "repo": "C:/IdeaProjects/specs",
  "templates": "C:/IdeaProjects/code-agent/starter/spec",
  "out": "C:/IdeaProjects/code-agent/out-spec",
  "specs": ["C:/IdeaProjects/specs/seed-order.md"]
}
```

**레거시:**

```json
{
  "label": "legacy-app",
  "repo": "C:/IdeaProjects/legacy-app",
  "templates": "C:/IdeaProjects/legacy-app/doc/templates",
  "out": "C:/IdeaProjects/code-agent/out-legacy",
  "specs": ["C:/IdeaProjects/legacy-app/spec.md"],
  "reference": "order"
}
```

- **문서 내용이 아니라 경로만** 보낸다. 파일은 서버가 읽으므로 이스케이프할 일이 없다.
- 경로는 서버 프로세스가 보는 로컬 경로다. 역슬래시 대신 `/` 가 안전하다.
- `201` 과 함께 상태가 돌아온다. **`id` 를 환경 변수 `job` 에 넣는다.**

Postman Scripts → Post-response 에 넣어 두면 자동으로 채워진다:

```javascript
pm.environment.set("job", pm.response.json().id);
```

### ② 지금 할 차례 보기

```
GET {{base}}/{{job}}
```

이 하나가 다음에 무엇을 부를지 정한다. 볼 필드:

| 필드 | 뜻 |
|---|---|
| `step` | 지금 할 차례 — 아래 표대로 분기 |
| `questions` | 미결 질문 배열 (`id`·`question`·`answer`) |
| `openQuestionCount` | 답 안 한 질문 수 |
| `needsApproval` | 2차 게이트 대기 여부 |
| `turn` · `completedStages` | 진행 상황 |
| `lastViolations` | 앞 턴에 남은 위반 |

| `step` | 부를 것 |
|---|---|
| `plan` · 단계키 · `gate:단계키` | ③ → ④ |
| `blocked` | ⑤ |
| `approval` | ⑥ |
| `done` | 끝 |

### ③ 프롬프트 받기

```
GET {{base}}/{{job}}/prompt
```

**상태를 바꾸지 않는다.** 몇 번 눌러도 같은 것이 나온다.
Visualize 탭의 내용을 **통째로** LLM Console 에 붙여넣는다 — 끝의 출력 형식 안내까지 있어야
모델이 산문 대신 액션 블록으로 답한다.

### ④ 응답 반영

```
POST {{base}}/{{job}}/response
Content-Type: text/plain; charset=utf-8
Body: raw → Text
```

Console 응답 **전문을 그대로** 붙여넣는다. 감싸지 않는다. 돌아오는 것:

| 필드 | 뜻 |
|---|---|
| `writtenFiles` | `out/` 에 쓰인 파일 |
| `violations` | 경계 위반. **하나라도 있으면 그 응답의 파일을 전부 반영하지 않는다** |
| `parseErrors` | 형식 오류 |
| `questionsAdded` | 이번에 늘어난 질문 |
| `advanced` | 상태가 한 칸 갔는지 |
| `next` | 반영 직후 상태 (②를 다시 부를 필요 없음) |

### ⑤ 질문에 답하기

```
POST {{base}}/{{job}}/questions
Content-Type: application/json; charset=utf-8
```

```json
{
  "answers": [
    { "id": 1, "answer": "Java 21 + Spring Boot 3" },
    { "id": 2, "answer": "PostgreSQL + Spring Data JPA" }
  ]
}
```

`id` 는 ②의 `questions` 에서 본다. 없는 `id` 를 주면 `400`.
**답하지 않은 질문이 하나라도 남아 있는 동안에는 어느 단계도 진행되지 않는다.**

### ⑥ 판정 — 계획 승인(2차)과 단계 확정(4차)

```
POST {{base}}/{{job}}/approval
Content-Type: application/json; charset=utf-8
```

```json
{ "decision": "approved", "approver": "카이", "comment": "계획 확인" }
```

**요청은 하나뿐이고, 무엇에 대한 판정인지는 상태가 정한다.** `step` 이 `approval` 이면 계획을,
`confirm:<단계키>` 면 그 단계의 산출물을 판정한다 — 사람이 그것까지 지정하게 하면 읽던 것과
판정하는 것이 어긋날 수 있다. 상태 응답의 `pending` 이 `plan` · `stage` 로 알려 준다.

반려는 `"rejected"` 이고 **`comment` 가 필수**다 — 반려는 지울 실패가 아니라 가장 값진 기록이다.
무엇을 판정하는지는 판정 전에 ③의 `message` 로 나온다 — 계획이면 계획 전문, 단계면 **만든 파일 목록**이다.

| | 계획 승인 | 단계 확정 |
|---|---|---|
| `step` | `approval` | `confirm:<단계키>` |
| 승인하면 | 첫 단계로 넘어간다 | 다음 단계로 넘어간다 |
| 반려하면 | 계획이 그대로인 채로는 진행되지 않는다 | **그 단계를 다시 돈다** — 사유가 다음 프롬프트에 실린다 |

판정은 **대상 저장소** `.code-agent/approvals/<id>.jsonl` 원장과 스냅샷에 남는다.
`out/` 이 아니다 — 승인은 커밋되어 PR 에서 읽혀야 하는 팀의 기록이기 때문이다.
단계 확정 줄에는 `stage` 와 `filesHash` 가 붙는다. **확정한 뒤 `out/` 의 파일이 바뀌면 그 확정은
무효가 되고 다시 묻는다.**

### ⑦ 턴 기록

```
GET {{base}}/{{job}}/log
```

`text` 에 마크다운 표가 담겨 온다 — 턴 · `write` · `edit` · `read` · `ask` · 위반 · 형식오류.

### ⑧ 작업 목록

```
GET {{base}}
```

### ⑨ 작업 삭제

```
DELETE {{base}}/{{job}}
```

목록에서만 뺀다. `out/` 산출물은 그대로 남는다.
**스펙을 바꾸려면 지우고 다시 만든다** — 스펙 교체 API 는 열려 있지 않다.

---

## 5. 신규 프로젝트 — 전체 순서

| # | 요청 | `step` 이 이렇게 되면 | 다음 |
|---|---|---|---|
| 1 | ① 작업 생성 | `plan` | 2 |
| 2 | ③ 프롬프트 → Console → ④ 반영 | `blocked` | 3 |
| 3 | ② 로 `questions` 확인 → ⑤ 답하기 | `approval` | 4 |
| 4 | ⑥ 승인 | `decisions` | 5 |
| 5 | ③ → Console → ④ | `blocked` — **결정 질문이 나온다** | 6 |
| 6 | ② 로 `questions` 확인 → ⑤ 답하기 | `decisions` (그대로) | 7 |
| 7 | ③ → Console → ④ | `gate:decisions` | 8 |
| 8 | ③ → Console → ④ (검수) | `confirm:decisions` | 9 |
| 9 | ⑥ **결정서 확정** | `scaffold-plan` | 10 |
| 10 | ③ → Console → ④ | `gate:scaffold-plan` | 11 |
| 11 | ③ → Console → ④ (검수) | `confirm:scaffold-plan` | 12 |
| 12 | ⑥ 확정 | `skeleton` | **★ 멈춤** |
| — | **저장소를 만든다.** `doc/scaffold.md` 의 명령을 그 경로에서 실행 | — | 13 |
| 13 | ③ → Console → ④ | `gate:skeleton` | 14 |
| 14 | ③ → Console → ④ (검수) | `confirm:skeleton` | 15 |
| 15 | ⑥ 확정 | `declare` | 16 |
| 16 | ③ → Console → ④ | `gate:declare` | 17 |
| 17 | ③ → Console → ④ (검수) | `confirm:declare` | 18 |
| 18 | ⑥ 확정 | `done` | ⑦ 로 수치 확인 |

**`confirm:*` 은 4차 게이트다.** 검수는 모델이 했을 뿐이고, 그것을 근거로 삼을지는 사람이 정한다 —
승인과 같은 요청(⑥)으로 판정하며, **반려하면 그 단계를 다시 돈다.**

**아키텍처 결정은 5~6 에서 왕복으로 정해진다.** 모델이 선택지와 트레이드오프를 질문으로 내고,
사람이 답하면 그 답이 `doc/architecture-decisions.md` 가 된다 — 사람이 문서를 옮겨 적지 않는다.
[7절](#7-사람이-멈추는-곳에서-하는-일) 참고.

> `plan` 에서 질문이 안 나오면 2 → 4 로 바로 간다. 스펙에 이미 적혀 있으면 묻지 않는다.
> 5 에서도 마찬가지다 — 스펙에 이미 확정된 것으로 적힌 항목은 묻지 않고 인용만 남긴다.

### 스펙부터 만들 때 — 앞에 붙는 한 바퀴

`kind: spec` 은 같은 요청들로 돌지만 단계가 하나뿐이다. 산출물
`out-spec/<id>/<대상>/doc/spec.md` 를 읽어 보고 스펙 폴더로 옮기면, 그 경로가 위 표 1행의
`specs` 가 된다.

| # | 요청 | `step` 이 이렇게 되면 | 다음 |
|---|---|---|---|
| 1 | ① 작업 생성 (`templates` = `starter/spec`) | `intake` | 2 |
| 2 | ③ → Console → ④ | `blocked` — **씨앗에 없는 항목을 묻는다** | 3 |
| 3 | ② 로 `questions` 확인 → ⑤ 답하기 | `plan` | 4 |
| 4 | ③ → Console → ④ | `approval` | 5 |
| 5 | ⑥ 승인 (계획) | `spec-doc` | 6 |
| 6 | ③ → Console → ④ | `gate:spec-doc` | 7 |
| 7 | ③ → Console → ④ (검수) | `confirm:spec-doc` | 8 |
| 8 | ⑥ **스펙 문서 확정** | `done` | 문서를 읽고 스펙 폴더로 옮긴다 |

> `intake` 는 **1차 게이트**다. 씨앗에서 읽히는 것만 뽑아 오고, 인용을 붙이지 못한 항목은
> 채워지지 않은 것으로 판정된다 — 그 판정을 하는 것은 모델이 아니라 코드다.

### 끝나고 나면 — 여기서 끊긴다

`code-agent.json` 과 컨벤션 문서가 생겨도 `feature` 를 바로 못 돌린다.

```
오류: 참조 표준 도메인이 없습니다. code-agent.json 의 referenceDomain 에 선언하거나
      --reference 로 지정하세요.
```

`exemplars` 를 선언한 단계가 하나라도 있으면 참조 도메인이 필수인데, 이 시점에는 복제할
도메인이 없다. **첫 도메인을 만드는 작업 종류는 아직 없다** — 사람이 손으로 하나 만들고 그
이름을 `referenceDomain` 에 넣어야 그다음부터 `feature` 가 돈다. 여기서 만든 것이 이후 모든
도메인의 참조 표준이 되므로 검수를 생략하지 않는다.

---

## 6. 레거시 프로젝트 — 전체 순서

| # | 요청 | `step` 이 이렇게 되면 | 다음 |
|---|---|---|---|
| 1 | ① 작업 생성 (`reference` 포함) | `plan` | 2 |
| 2 | ③ 프롬프트 → Console → ④ 반영 | `approval` 또는 `blocked` | 3 |
| 3 | (`blocked` 면) ⑤ 답하기 | `approval` | 4 |
| 4 | ⑥ 승인 (계획) | `survey` | 5 |
| 5 | ③ → Console → ④ | `gate:survey` | 6 |
| 6 | ③ → Console → ④ (검수) | `confirm:survey` | 7 |
| 7 | ⑥ 확정 | `declare` | 8 |
| 8 | ③ → Console → ④ | `gate:declare` | 9 |
| 9 | ③ → Console → ④ (검수) | `confirm:declare` | 10 |
| 10 | ⑥ 확정 | `done` | **★ 멈춤** |
| — | `out-legacy/ADOPT-1/unnamed/doc/templates/code-agent.json` 의 **`exemplars` 경로 확인** | — | 대상 저장소로 옮김 |

> `target: .` 이면 갈래 이름이 `unnamed` 이 된다. 점으로만 된 대상은 디렉토리 이름으로 쓰지 않는다.

### 끝나고 나면 — 바로 이어진다

`code-agent.json` 을 대상 저장소의 `doc/templates/` 로 옮기면 그때부터
`kind: feature` 로 도메인을 추가한다. 참조 도메인이 이미 코드에 있으므로 끊기지 않는다.

```json
{
  "repo": "C:/IdeaProjects/legacy-app",
  "templates": "C:/IdeaProjects/legacy-app/doc/templates",
  "out": "C:/IdeaProjects/code-agent/out-shipment",
  "specs": ["C:/IdeaProjects/legacy-app/spec-shipment.md"]
}
```

`spec-shipment.md` 의 머리말은 `kind: feature`, `target` 은 **이제부터 만들** 도메인 이름이다.
`reference` 는 매니페스트의 `referenceDomain` 이 대신하므로 넘기지 않아도 된다.

---

## 7. 사람이 멈추는 곳에서 하는 일

**답할 곳은 한 군데다.** 스펙의 빈칸이든 아키텍처 결정이든, 전부 미결 질문으로 나온다.

| | 어디에 | 답 안 하면 |
|---|---|---|
| **미결 질문** | `out/<id>/<대상>/.code-agent/questions.md` 또는 API ⑤ | **진행이 멈춘다** (`step` = `blocked`) |

### ① 미결 질문 — API 로 답한다

모델이 `ask` 했거나, 계획이 `openQuestions` 를 남겼거나, 1차 게이트가 스펙의 빈칸을 짚은
것이다. 요청 ⑤ 로 답하면 그 답이 다음 프롬프트에 "사람이 답한 것 — 이 답을 따른다.
다시 묻지 않는다"로 실린다.

### ② 아키텍처 결정 — 같은 자리에서 답한다 (신규만)

`decisions` 단계는 **묻고, 답을 받아, 문서로 남기는** 두 국면으로 돈다.

```
모델: ask   "[2] 프레임워크? A) … B) …  트레이드오프: …"   → step = blocked
사람: ⑤     "A 로 간다. 사내 표준이 Spring 이다"
모델: write doc/architecture-decisions.md                  → 결정 · 근거 · 대안
```

**사람이 결정서를 옮겨 적지 않는다.** 답이 곧 근거로 인용되고, 그 문서가 다음 단계에
앞 단계 산출물로 실린다(파일당 앞 300줄). 다루는 항목은 최소 여섯이다 — 언어·런타임,
프레임워크, 빌드 도구와 스캐폴딩 명령, 패키지 루트와 도메인 분류, 아키텍처 계층과
트랜잭션 경계, 공통 규약(식별자·soft delete·멀티테넌시·감사 필드·예외 체계).

> 결정서를 손으로 고쳐도 된다. `out/` 의 파일을 다시 읽어 싣기 때문이다 —
> 다만 **답하지 않은 채로는 다음 단계로 넘어가지 않는다.**

### ③ 단계 산출물 확정 — 단계마다 한 번씩

검수(`gate:*`)를 통과해도 `confirm:<단계키>` 에서 한 번 더 멈춘다. **검수는 모델이 했을 뿐이고,
그것을 근거로 삼을지는 사람이 정한다.** ③의 `message` 에 그 단계가 만든 파일 목록이 나온다 —
열어서 읽고 ⑥ 으로 판정한다.

```
## 단계 산출물을 확정해야 넘어갑니다 (4차 게이트) — 대상: order-service · 단계: decisions
아키텍처 결정서

  - out-newproj/NEW-1/order-service/doc/architecture-decisions.md (48줄)

확정 전에는 다음 단계로 넘어가지 않습니다.
```

반려하면 그 단계를 다시 돈다. 사유는 다음 프롬프트에 위반으로 실리므로, **무엇이 잘못됐는지
적어야** 같은 것이 다시 나오지 않는다.

### ④ 스캐폴더 실행 — 여기서 저장소가 생긴다 (신규만)

`scaffold-plan` 이 만든 `out-newproj/NEW-1/<대상>/doc/scaffold.md` 에 적힌 명령을 실행한다.
**프로젝트 실체가 처음 생기는 지점이다** — 그 전까지 대상 저장소 경로에는 승인 원장밖에 없다.

```powershell
Set-Location C:\IdeaProjects\my-new-service   # ②에서 만들어 둔 빈 디렉토리
# scaffold.md 에 적힌 명령. 결정서에서 정해진 것이다
spring init --dependencies=web,data-jpa --build=gradle .
git init
```
 빌드 파일과 의존성 좌표를 모델이 기억으로 쓰면 플러그인 버전을
환각하므로, **생태계 도구의 출력이 시점 0의 참조 표준이 된다.**

안 멈추고 스캐폴딩을 지어냈다면 그게 바로 이 도구가 막으려던 것이다.

### ⑤ `exemplars` 확인 — 눈으로 본다 (레거시만)

`declare` 가 만든 `code-agent.json` 의 `exemplars` 경로가 실제 파일과 맞는지 본다.
**여기가 틀리면 이후 생성 품질이 통째로 무너진다.**

### 산출물은 어디에 쌓이나

```
<out>/<id>/<대상>/                 ← 그 안은 저장소 루트 기준 상대경로 그대로
  ├─ .plan.json                    계획
  ├─ .code-agent/                  세션 · 질문 · 프롬프트
  └─ doc/ · src/ …                 생성물
```

**`<대상>` 은 지시서의 `target` 이지만 그대로는 아니다.** 점으로만 된 대상(`.`·`..`)은 갈래
이름으로 쓰지 않고 `unnamed` 이 된다 — `.` 을 디렉토리 이름으로 쓰면 레인 디렉토리가
사라지고 `..` 은 한 단계 거슬러 오르기 때문이다.

```
kind: adopt · target: .     →  out-legacy/ADOPT-1/unnamed/
kind: adopt · target: src   →  out-legacy/ADOPT-1/src/
kind: bootstrap · target: order-service
                            →  out-newproj/NEW-1/order-service/
```

대상 저장소로 옮기는 것은 **확인 후 사람이** 한다. 대상 저장소에 정상적으로 생기는 것은
`.code-agent/approvals/` 승인 원장뿐이다.

---

## 8. 막히면

| 증상 | 원인과 대응 |
|---|---|
| ① 이 `400` | 경로 오타. 서버 프로세스가 보는 경로여야 하고 `/` 가 안전하다. 매니페스트·컨벤션·참조 표준을 **작업 생성 시점에 실제로 읽어 보므로** 여기서 걸린다 |
| `승인 기록을 남길 대상 저장소가 없습니다` | `repo` 경로가 실재하지 않는다. 오타면 고치고, 맞으면 그 디렉토리를 만든다. **없는 경로를 만들어 주지 않는다** — 오타 난 곳에 아무도 승인한 적 없는 기록이 남기 때문이다 |
| `작업 지시서가 규격에 맞지 않아…` | 머리말 네 줄(`kind`·`id`·`title`·`target`)을 본다. `adopt`·`fix`·`refactor` 는 `target` 이 실재하는 경로여야 한다 |
| `참조 표준 도메인이 없습니다` | `feature` 인데 참조 도메인이 없다. 매니페스트의 `referenceDomain` 이나 작업 생성의 `reference` 를 채운다 |
| `blocked` 가 안 풀림 | ②의 `questions` 에서 `id` 를 확인. 없는 `id` 를 주면 거부한다 |
| `violations` 가 나옴 | 경계 밖 파일이다. **그 응답의 파일이 전부 반영되지 않았다** — 절반만 반영된 `out/` 이 다음 턴의 입력이 되어 오염이 번지기 때문이다. 위반 목록은 다음 프롬프트에 실린다 |
| `parseErrors` 가 나옴 | 프롬프트를 잘라 붙여넣었을 때 주로 난다. 출력 형식 안내까지 통째로 넣는다 |
| `response 는 문자열이어야…` | Body 를 JSON 으로 감쌌다. `text/plain` + raw → Text 로 보낸다 |
| 한글이 깨짐 | `charset=utf-8` 을 헤더에 명시한다 |

HTTP 본문의 실제 모양과 `curl`·PowerShell 예시는 [doc/bootstrap-test.md](bootstrap-test.md) 에 있다.
