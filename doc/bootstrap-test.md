# 신규 프로젝트 테스트 — 절차와 API

> 이 문서는 `kind: bootstrap` 을 **처음 끝까지 돌려 보는 사람**을 위한 것이다.
> 아래 절차와 API 응답은 전부 실제로 돌려 확인한 것이다. 다만 **모델 자리에는 사람이 아니라
> LLM 이 앉았다** — 프롬프트를 Console 에 붙여넣는 사람의 왕복은 여기서도 해 보지 않았다.
>
> 명령·옵션·API 목록은 [README](../README.md) 가 기준이다. 이 문서는 거기 없는 것만 담는다 —
> `bootstrap` 고유의 순서, 요청·응답 본문의 실제 모양, 상태 전이, 무엇을 보고 판단하는가.

---

## 목차

- [무엇을 테스트하나](#무엇을-테스트하나)
- [준비물](#준비물)
- [돌리는 순서](#돌리는-순서)
- [요청·응답 본문](#요청응답-본문)
- [무엇을 어떻게 보내나](#무엇을-어떻게-보내나)
- [상태기 — step 이 다음에 부를 것을 정한다](#상태기--step-이-다음에-부를-것을-정한다)
- [Swagger 를 붙인다면](#swagger-를-붙인다면)
- [테스트에서 확인할 것](#테스트에서-확인할-것)

---

## 무엇을 테스트하나

빈 저장소에서 시작해 **근거 문서**(`code-agent.json` · 컨벤션 문서)까지 만들어 내는 4단계다.

| 단계 | 키 | 산출물 | 사람이 하는 일 |
|---|---|---|---|
| 1 | `decisions` | `doc/architecture-decisions.md` | **질문지에 답을 적어 넣는다** — `out/` 의 그 파일에 직접 |
| 2 | `scaffold-plan` | `doc/scaffold.md` | **여기서 멈춘다** — 적힌 스캐폴더 명령을 직접 실행한다 |
| 3 | `skeleton` | `src/**` 공통 모듈·설정 | 스캐폴더 출력이 참조 표준이 된다 |
| 4 | `declare` | `code-agent.json` · 컨벤션 문서 | 이후 실행의 근거가 생긴다 |

2단계의 멈춤은 버그가 아니라 설계다. 빌드 파일과 의존성 좌표를 모델이 기억으로 쓰면
플러그인 버전을 환각한다 — `spring init` · `npm create` 같은 생태계 도구의 **출력**이
시점 0의 참조 표준이 되어야 한다.

1단계도 사람 몫이 있다. **아키텍처 결정서는 입력이 아니라 이 실행의 산출물이다** — 01 이
질문지를 내고, 사람이 `out/<id>/<대상>/doc/architecture-decisions.md` 에 답을 적는다.
앞 단계 산출물은 `out/` 에서 다시 읽어 다음 프롬프트에 들어가므로(파일당 앞 300줄),
손본 내용이 그대로 반영된다.

> 두 가지 "질문"이 따로 있다. 헷갈리면 어디에 답할지 못 찾는다.
>
> | | 어디에 | 답하지 않으면 |
> |---|---|---|
> | **미결 질문** | `.code-agent/questions.md` | **진행이 멈춘다.** 모델의 `ask` 나 계획의 `openQuestions` 가 쌓이는 자리 |
> | **결정 질문지** | `doc/architecture-decisions.md` | 진행은 된다. 다만 빈칸인 채로 다음 단계의 근거가 된다 |

---

## 준비물

**① 빈 저장소** — `git init` 만 되어 있으면 된다.

**② 스펙 문서** — 맨 위에 작업 지시서 머리말이 있어야 한다. 0차 게이트가 이것부터 본다
(규격: [doc/work-order.md](work-order.md)). **필요한 것은 「프로젝트 개요」 한 장뿐이다** —
언어·프레임워크·계층은 적지 않는다. 그건 01 단계가 질문지로 되물을 것들이다.

```markdown
---
kind: bootstrap
id: NEW-1
title: 주문 관리 서비스 신규 구축
target: order-service
---

# 프로젝트 개요
사내 주문 관리 백엔드를 새로 만든다. 주문 접수 · 상태 변경 · 조회를 REST 로 제공한다.

# 규모
- 도메인 3~5개 예상 (order, customer, product)
- 사용자 사내 100명 수준
```

**③ 템플릿** — `starter/bootstrap`. `bootstrap` 에는 참조 표준이 없으므로
`--reference` · `--conventions` 는 주지 않는다.

---

## 돌리는 순서

CLI 두 줄 루프와 서버 실행법은 [수동 모드](../README.md#수동-모드--api-미사용)와
[서버 모드](../README.md#서버-모드--화면으로-왕복)에 있다. `bootstrap` 이 다른 것은 인자 하나뿐이다 —
대상 저장소에 아직 `code-agent.json` 이 없으므로 **템플릿을 스타터로 가리킨다.**

```bash
COMMON="--repo /path/to/newproj --templates starter/bootstrap --out ./out"
```

그 뒤 순서는 이렇게 간다. 각 화살표가 왕복 한 번이다.

```
next(계획) → apply → 질문에 답 → next → approve
  → next(decisions) → apply → next(gate:decisions) → apply
  → scaffold-plan → [사람이 스캐폴더 실행] → skeleton → declare
```

- 질문은 `out/<id>/<대상>/.code-agent/questions.md` 의 `**답:**` 아래에 적는다.
- 프롬프트는 stdout 과 `out/<id>/<대상>/.code-agent/prompt.txt` 양쪽에 나온다.
- 붙여넣기 왕복만 할 거라면 화면(`serve`)이 제일 빠르다 — 응답을 파일로 저장하는 일과
  명령을 다시 부르는 일이 없어진다.

---

## 요청·응답 본문

경로 목록은 [README 의 HTTP API](../README.md#http-api)에 있다. 여기는 **본문의 실제 모양**만 적는다.
모두 `application/json; charset=utf-8` 이고, 오류는 대부분 `400 {"error": "..."}` 로 나온다
(경로 오타·잘못 붙여넣은 응답이 대부분이라 사용자가 고칠 수 있는 것들이다).

### POST /api/jobs

```json
{
  "label": "order-service 신규",
  "repo": "C:/path/to/newproj",
  "templates": "C:/IdeaProjects/code-agent/starter/bootstrap",
  "out": "C:/path/to/out",
  "specs": ["C:/path/to/spec.md"]
}
```

선택: `reference` · `conventions[]` · `policy` · `gate`(기본 `true`).

생성 시점에 매니페스트·컨벤션·참조 표준을 **실제로 읽어 본다.** 경로 오타는 첫 프롬프트가
아니라 여기서 400 으로 걸린다. `out` 이 겹치는 작업은 거부한다 — 계획과 세션이 그 안에
있어 섞이면 이어지지 않는다.

### 상태 응답 (`StatusView`)

```json
{
  "id": "job-1", "label": "order-service 신규",
  "repoRoot": "…/newproj", "outDir": "…/out",
  "target": "plan", "step": "plan", "lane": "order-service",
  "lanes": [{ "target": "order-service", "step": "plan", "needsApproval": false }],
  "turn": 0, "completedStages": [],
  "questions": [], "openQuestionCount": 0,
  "hasPrompt": true, "hasPlan": false, "needsApproval": false,
  "lastViolations": []
}
```

`lanes` 는 지시서의 대상 전부다 — 대상마다 따로 돌기 때문에 하나가 막혀도 나머지는 간다.

### POST /api/jobs/{id}/response

```json
{ "response": "Console 응답 전문" }
```

응답(`ApplyView`)에는 `planSaved` · `planText` · `writtenFiles` · `observations` ·
`notes` · `violations` · `parseErrors` · `questionsAdded` · `advanced` 와
**반영 직후 상태 `next`** 가 함께 온다. 화면이 한 번 더 물을 필요가 없다.

실제 계획 반영 결과:

```json
{ "planSaved": true, "questionsAdded": 2, "advanced": true,
  "message": "미결 질문 2건을 남겼습니다. 답을 채워야 다음으로 넘어갑니다.",
  "next": { "step": "blocked", "openQuestionCount": 2,
            "questions": [{ "id": 1, "target": "plan",
                            "question": "언어와 프레임워크를 무엇으로 할 것인가",
                            "answer": "" }] } }
```

> **위반이 하나라도 있으면 그 응답의 파일을 전부 반영하지 않는다.** 절반만 반영된 `out/` 이
> 다음 턴의 입력이 되어 오염이 번지기 때문이다.

### POST /api/jobs/{id}/questions

```json
{ "answers": [{ "id": 1, "answer": "Java 21 + Spring Boot 3" },
              { "id": 2, "answer": "PostgreSQL + Spring Data JPA" }] }
```

없는 `id` 를 주면 400. 답이 다 차면 `step` 이 `blocked` → `approval` 로 넘어간다.

### POST /api/jobs/{id}/approval

```json
{ "decision": "approved", "approver": "카이", "comment": "계획 확인" }
```

`decision` 은 `approved` | `rejected` 만. 대상이 둘 이상이면 `target` 이 필요하다.
판정은 **대상 저장소 안**의 `.code-agent/approvals/<id>.jsonl` 원장과 계획 스냅샷에 남는다.

```
승인을 원장에 남겼습니다 — order-service · 카이 · 계획 sha256:f13176b73345100f
```

---

## 무엇을 어떻게 보내나

### 먼저 — 스펙·템플릿 문서는 JSON 으로 안 보낸다

**경로만 보낸다. 파일은 서버가 읽는다.**

```json
{ "specs": ["C:/path/to/spec.md"], "templates": "…/starter/bootstrap" }
```

요구사항 문서·컨벤션 문서·단계 템플릿 전부 마찬가지다. 이스케이프할 일이 없다.
그래서 **작업 생성은 Postman 에서 가장 편한 요청**이다.

경로는 서버 프로세스가 보는 로컬 경로다 — 원격에서 부르면 그 머신의 경로여야 한다.
경로가 틀리면 첫 프롬프트가 아니라 `POST /api/jobs` 에서 400 으로 걸린다.

> 스펙을 나중에 바꾸려면 작업을 지우고(`DELETE`) 다시 만들어야 한다. 스펙 교체 API 는
> 열려 있지 않다 — 계획을 세운 뒤에 스펙이 바뀌면 이미 선 계획이 무엇에 근거한 것인지
> 알 수 없어진다.

### 큰 문자열이 필요한 곳은 `/response` 하나뿐

Console 응답 전문(코드블록 포함)이 JSON 문자열 하나에 들어가는 유일한 자리다.
나머지 요청은 전부 작은 JSON 이라 손으로 써도 된다.

| 하려는 일 | 쓸 것 |
|---|---|
| 붙여넣기 왕복 전체 | **웹 화면** (`GET /`) — 텍스트 영역에 그대로 붙인다 |
| 파일로 다루기 | **CLI** — `next > prompt.txt` · `apply answer.txt` |
| API 계약 확인 · 작은 요청 | **Postman / curl** — 작업 생성 · 질문 · 승인 · 상태 · 턴 기록 |
| `/response` 를 스크립트로 | **`text/plain` 한 줄** (아래) |

### `/response` 는 감싸지 않고 보낸다

`text/plain` 으로 보내면 본문 전체가 곧 응답 전문이다 — 이스케이프가 없다
([README](../README.md#http-api)에 `curl` 예가 있다). PowerShell 에서도 같다.

```powershell
$bytes = [System.IO.File]::ReadAllBytes("answer.txt")   # UTF-8 파일을 그대로 보낸다
Invoke-RestMethod -Uri "$base/response" -Method Post `
  -ContentType "text/plain; charset=utf-8" -Body $bytes
```

코드블록(백틱)이 든 단계 응답도 이대로 통과한다 — 쓰인 파일이 원본과 바이트 단위로
같은 것까지 확인했다.

**Postman 은 `/response` 에 이제 맞는다.** Body 를 `raw` → `Text` 로 두고 응답 전문을
그대로 붙이면 된다. 나머지 요청은 `JSON` 으로 두고, 한글을 보낼 때는
`Content-Type: application/json; charset=utf-8` 을 명시한다.

### JSON 으로 감쌀 때 — PowerShell 5.1 의 두 함정

`application/json` 으로 `{response: "…"}` 를 보낼 수도 있다. 다만 Windows PowerShell 5.1
에서 **두 가지가 조용히 깨진다.** 둘 다 실제로 밟았다.

```powershell
# ✗ 이렇게 하면 안 된다
$answer = Get-Content -Raw answer.txt            # ① 한글이 깨진다 (ANSI 로 읽음)
$body = @{ response = $answer } | ConvertTo-Json # ② 긴 문자열이 {"value":…,"Count":1} 로 감싸진다
```

②를 밟으면 서버가 이렇게 답한다 — 무엇을 어떻게 고칠지가 메시지에 있다.

```
response 는 문자열이어야 하는데 object 를 받았습니다.
감싸지 말고 Content-Type: text/plain 으로 응답 전문을 그대로 본문에 실으세요.
```

굳이 JSON 으로 보내려면 ①은 `[System.IO.File]::ReadAllText(…, UTF8)` 로, ②는 해시테이블에
넣지 말고 **문자열을 직접** `ConvertTo-Json` 에 흘려 리터럴을 얻은 뒤 본문을 조립해서 푼다.
작은 해시테이블은 그냥 써도 된다 — 감싸기는 긴 문자열에서만 난다.

---

## 상태기 — `step` 이 다음에 부를 것을 정한다

**어느 단계를 할 차례인지 사람이 지정하지 않는다.** 상태가 정한다.

| `step` | 뜻 | 다음에 부를 것 |
|---|---|---|
| `plan` | 계획을 세울 차례 | `GET /prompt` → `POST /response` |
| `blocked` | 미결 질문이 남았다 | `POST /questions` |
| `approval` | 2차 게이트 대기 | `POST /approval` |
| `<단계키>` | 그 단계를 생성할 차례 | `GET /prompt` → `POST /response` |
| `gate:<단계키>` | 그 단계 검수 (1차 게이트) | `GET /prompt` → `POST /response` |
| `done` | 끝 | — |

실측한 전이:

```
plan ──POST /response──> blocked ──POST /questions──> approval
     ──POST /approval──> decisions ──POST /response──> gate:decisions ──> scaffold-plan …
```

자동화 스크립트를 쓴다면 루프는 이 한 줄이다 — `step` 을 보고 셋 중 하나를 부른다.

---

## Swagger 를 붙인다면

> **아직 붙이지 않았다.** 아래는 붙일지 판단한 기록이다. 왕복의 불편은 Swagger 가 아니라
> `/response` 의 `text/plain` 으로 풀었다. 다시 꺼낼 때 처음부터 따지지 않으려고 남긴다.

### 이득이 어디에 있고 어디에 없는지

**없는 곳 — 붙여넣기 왕복.** 이미 있는 화면(`GET /`)이 프롬프트 복사·응답 붙여넣기·
질문 답·승인을 한 화면에서 한다. Swagger UI 를 그 자리에 놓을 이유가 없다.

**있는 곳 — 세 가지.**

1. **API 계약이 코드에만 있다.** 지금 경로·본문 규격은 `src/server/http.ts` 의 정규식과
   `api.ts` 의 타입에 흩어져 있다. 읽으려면 소스를 열어야 한다.
2. **자동화 스크립트를 쓸 때.** `step` 을 보고 도는 루프를 짜려면 `StatusView` 의 필드가
   문서로 있어야 한다. 위의 상태기 표가 그 자리를 임시로 메우고 있다.
3. **다른 클라이언트를 붙일 때.** 리뷰 에이전트 연동이나 CI 훅은 화면을 못 쓴다.

### 3안

| 안 | 어떻게 | 의존성 | 비용 |
|---|---|---|---|
| **A. `openapi.json` 만** | `GET /openapi.json` 으로 스펙만 내준다. 보는 것은 Postman·IntelliJ HTTP Client·`editor.swagger.io` 에 import | **0** | 스펙 작성 1회 |
| **B. Swagger UI 동봉** | A + `swagger-ui-dist` 를 `GET /docs` 에서 정적 서빙 | `swagger-ui-dist` 1개 | A + 정적 서빙 ~20줄 |
| **C. 코드에서 스펙 생성** | zod 스키마에서 OpenAPI 를 뽑아 항상 코드와 일치 | zod-to-openapi 등 | 타입 재작성이 커서 외과적이지 않다 |

**A 를 권한다.** 이 프로젝트는 런타임 의존성이 `zod` 하나뿐이고 서버가 `node:http` 직접
구현이다. Swagger UI 를 위해 정적 자산 수 MB 를 들이는 것은 이득에 비해 무겁다. 스펙 파일
하나면 Postman·IntelliJ 어느 쪽에서든 열리고, 그게 실제로 필요한 것의 전부다.

B 가 필요해지는 시점은 **이 서버를 다른 사람이 쓰기 시작할 때**다. 그때는 화면 한 켠에
`/docs` 링크가 있는 편이 낫다.

### 붙일 때 실제로 걸릴 것

- **`/response` 만 본문 형식이 둘이다.** `text/plain` 과 `application/json` 을 한
  오퍼레이션에 `content` 두 항목으로 적어야 한다. 본문이 코드 여러 파일 크기(상한 10MB)라
  `example` 은 짧게만 두고, 실제 왕복은 화면으로 하도록 안내한다.
- **`step` 값이 열린 집합이다.** `<단계키>` 와 `gate:<단계키>` 는 프로젝트의
  `code-agent.json` 이 정한다. `enum` 으로 못 박으면 거짓말이 된다 — `string` 에
  설명으로 남긴다.
- **오류가 대부분 400 이다.** "그런 작업이 없습니다" 도 404 가 아니라 400 이다
  (매치되지 않는 경로만 404). 스펙을 쓰면 이 불일치가 드러난다 — 고칠지 적을지는 그때 정한다.
- **경로 파라미터는 URL 인코딩된다.** `id` 는 `decodeURIComponent` 를 거친다.

---

## 테스트에서 확인할 것

턴·탐색·위반 수치는 `log` 가 내주고, 각 수치를 어떻게 읽는지는
[턴 기록](../README.md#턴-기록--서버를-붙일지-판단하는-근거)에 있다. `bootstrap` 에서 그 밖에
따로 볼 것은 둘이다.

| 볼 것 | 어디서 | 어긋나면 |
|---|---|---|
| 대상 저장소가 깨끗한가 | `git status` | 승인 원장(`.code-agent/approvals/`) 외에 뭔가 생겼다면 경계가 샌 것 |
| 2단계에서 멈추는가 | `status` | 안 멈추고 스캐폴딩을 지어냈다면 그게 환각이다 |
