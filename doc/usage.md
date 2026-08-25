# 사용 가이드 — Postman 으로 끝까지 돌리기

> 개념과 설계는 [README](../README.md), 지시서 규격은 [work-order.md](work-order.md).
> 이 문서는 **실제로 요청을 보내는 법**이다. 신규(`bootstrap`)와 레거시(`adopt`) 둘 다 다룬다.

---

## 목차

- [시작 전에 — 어느 경로인가](#시작-전에--어느-경로인가)
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
| 대상 | 빈 저장소 | 굴러가는 저장소 |
| `target` | 프로젝트 이름 (실재 안 해도 됨) | **저장소 경로 (실재해야 함)** |
| 템플릿 | `starter/bootstrap` 그대로 | `starter/adopt` 를 **복사해 고쳐서** |
| 단계 | 4 (`decisions`→`scaffold-plan`→`skeleton`→`declare`) | 2 (`survey`→`declare`) |
| 사람이 멈추는 곳 | 2군데 | 1군데 |
| 끝나면 | **끊긴다** — 첫 도메인은 손으로 | 바로 `feature` 로 이어짐 |

둘 다 같은 것을 만든다 — `code-agent.json` 과 컨벤션 문서. 그 둘이 이후 실행의 근거다.

---

## 1. 준비물

### 공통 — 빌드

```powershell
Set-Location C:\IdeaProjects\code-agent
npm run build
```

### 신규일 때

**① 빈 저장소**

```powershell
$REPO = "C:\IdeaProjects\my-new-service"
New-Item -ItemType Directory -Force $REPO | Out-Null
Set-Location $REPO; git init
```

**② `spec.md`** — 맨 위 머리말 네 줄이 없으면 0차 게이트가 막는다.
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
> 안 적으면 01 단계가 선택지와 트레이드오프를 질문지로 내준다 — 아키텍처 결정서는
> 입력이 아니라 이 실행의 산출물이다.

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
  "specs": ["C:/IdeaProjects/my-new-service/spec.md"]
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

### ⑥ 계획 승인

```
POST {{base}}/{{job}}/approval
Content-Type: application/json; charset=utf-8
```

```json
{ "decision": "approved", "approver": "카이", "comment": "계획 확인" }
```

반려는 `"rejected"` 이고 **`comment` 가 필수**다 — 반려는 지울 실패가 아니라 가장 값진 기록이다.
계획 전문은 승인 전에 ③의 `message` 로 나온다.

판정은 **대상 저장소** `.code-agent/approvals/<id>.jsonl` 원장과 계획 스냅샷에 남는다.
`out/` 이 아니다 — 승인은 커밋되어 PR 에서 읽혀야 하는 팀의 기록이기 때문이다.

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
| 5 | ③ → Console → ④ | `gate:decisions` | 6 |
| 6 | ③ → Console → ④ (검수) | `scaffold-plan` | 7 |
| 7 | ③ → Console → ④ | `gate:scaffold-plan` | 8 |
| 8 | ③ → Console → ④ | `skeleton` | **★ 멈춤** |
| — | `doc/scaffold.md` 를 열어 **스캐폴더를 직접 실행** | — | 9 |
| 9 | ③ → Console → ④ | `gate:skeleton` | 10 |
| 10 | ③ → Console → ④ | `declare` | 11 |
| 11 | ③ → Console → ④ | `gate:declare` | 12 |
| 12 | ③ → Console → ④ | `done` | ⑦ 로 수치 확인 |

`decisions` 단계 산출물(결정 질문지)은 5~6 사이에 채운다. [7절](#7-사람이-멈추는-곳에서-하는-일) 참고.

> `plan` 에서 질문이 안 나오면 2 → 4 로 바로 간다. 스펙에 이미 적혀 있으면 묻지 않는다.

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
| 4 | ⑥ 승인 | `survey` | 5 |
| 5 | ③ → Console → ④ | `gate:survey` | 6 |
| 6 | ③ → Console → ④ (검수) | `declare` | 7 |
| 7 | ③ → Console → ④ | `gate:declare` | 8 |
| 8 | ③ → Console → ④ | `done` | **★ 멈춤** |
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

**질문이 두 종류다.** 헷갈리면 어디에 답할지 못 찾는다.

| | 어디에 | 답 안 하면 |
|---|---|---|
| **미결 질문** | `out/<id>/<대상>/.code-agent/questions.md` 또는 API ⑤ | **진행이 멈춘다** (`step` = `blocked`) |
| **결정 질문지** | `out/<id>/<대상>/doc/architecture-decisions.md` | 진행은 된다. 빈칸인 채로 다음 단계 근거가 될 뿐 |

### ① 미결 질문 — API 로 답한다

모델이 `ask` 했거나 계획이 `openQuestions` 를 남긴 것이다. 요청 ⑤ 로 답하면 그 답이
다음 프롬프트에 "사람이 답한 것 — 이 답을 따른다. 다시 묻지 않는다"로 실린다.

### ② 결정 질문지 — 파일을 직접 연다 (신규만)

`decisions` 단계가 만든 질문지다. 아래 파일을 열어 답을 적는다.

```
out-newproj/NEW-1/<대상>/doc/architecture-decisions.md
```

앞 단계 산출물은 `out/` 에서 **다시 읽어** 다음 프롬프트에 들어가므로(파일당 앞 300줄)
손본 내용이 그대로 반영된다. 다루는 항목은 최소 여섯이다 — 언어·런타임, 프레임워크,
빌드 도구와 스캐폴딩 명령, 패키지 루트와 도메인 분류, 아키텍처 계층과 트랜잭션 경계,
공통 규약(식별자·soft delete·멀티테넌시·감사 필드·예외 체계).

### ③ 스캐폴더 실행 — 직접 돌린다 (신규만)

`scaffold-plan` 이 만든 `out-newproj/NEW-1/<대상>/doc/scaffold.md` 에 적힌 명령을 대상
저장소에서 실행한다. 빌드 파일과 의존성 좌표를 모델이 기억으로 쓰면 플러그인 버전을
환각하므로, **생태계 도구의 출력이 시점 0의 참조 표준이 된다.**

안 멈추고 스캐폴딩을 지어냈다면 그게 바로 이 도구가 막으려던 것이다.

### ④ `exemplars` 확인 — 눈으로 본다 (레거시만)

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
| `작업 지시서가 규격에 맞지 않아…` | 머리말 네 줄(`kind`·`id`·`title`·`target`)을 본다. `adopt`·`fix`·`refactor` 는 `target` 이 실재하는 경로여야 한다 |
| `참조 표준 도메인이 없습니다` | `feature` 인데 참조 도메인이 없다. 매니페스트의 `referenceDomain` 이나 작업 생성의 `reference` 를 채운다 |
| `blocked` 가 안 풀림 | ②의 `questions` 에서 `id` 를 확인. 없는 `id` 를 주면 거부한다 |
| `violations` 가 나옴 | 경계 밖 파일이다. **그 응답의 파일이 전부 반영되지 않았다** — 절반만 반영된 `out/` 이 다음 턴의 입력이 되어 오염이 번지기 때문이다. 위반 목록은 다음 프롬프트에 실린다 |
| `parseErrors` 가 나옴 | 프롬프트를 잘라 붙여넣었을 때 주로 난다. 출력 형식 안내까지 통째로 넣는다 |
| `response 는 문자열이어야…` | Body 를 JSON 으로 감쌌다. `text/plain` + raw → Text 로 보낸다 |
| 한글이 깨짐 | `charset=utf-8` 을 헤더에 명시한다 |

HTTP 본문의 실제 모양과 `curl`·PowerShell 예시는 [doc/bootstrap-test.md](bootstrap-test.md) 에 있다.
