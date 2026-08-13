# API 모드 — 보류

> ⛔ **이 문서는 지금 쓰이지 않는다.** API를 쓰지 않기로 했고, 현재 구현은 **로컬 서버 + 화면**이다
> (`code-agent serve`, README의 "서버 모드" 참조). 사람이 Console에 붙여넣는 왕복은 그대로다.
>
> 아래는 **나중에 API를 붙일 때** 꺼내 쓰는 안이다. Managed Agents는 Anthropic API이므로
> API를 쓰지 않는 동안에는 성립하지 않는다. 전제(GitHub 저장소 필요 등)도 그때 다시 확인해야 한다.

**실행 기반**: Anthropic **Managed Agents**(이하 CMA). 에이전트 루프와 세션별 샌드박스 컨테이너를 Anthropic이 호스팅한다.
code-agent는 그 위에 얹히는 **정책 계층**이 된다.

---

## 목차

- [왜 CMA인가 — 그리고 무엇을 잃는가](#왜-cma인가--그리고-무엇을-잃는가)
- [전제 조건](#전제-조건)
- [전체 구조](#전체-구조)
- [경계 강제 — code-agent의 존재 이유를 지키는 법](#경계-강제--code-agent의-존재-이유를-지키는-법)
- [단계는 Outcome이 된다](#단계는-outcome이-된다)
- [참조 표준 선주입 — 경로는 코드가, 읽기는 샌드박스가](#참조-표준-선주입--경로는-코드가-읽기는-샌드박스가)
- [질문 루프 — 비동기 대기](#질문-루프--비동기-대기)
- [프로젝트 생성과 앱 구동](#프로젝트-생성과-앱-구동)
- [git과 PR](#git과-pr)
- [서버 API](#서버-api)
- [기존 코드의 운명](#기존-코드의-운명)
- [안전장치](#안전장치)
- [마일스톤](#마일스톤)
- [리스크](#리스크)

---

## 왜 CMA인가 — 그리고 무엇을 잃는가

Phase 1에서 없던 조각이 정확히 CMA가 기성품으로 주는 것들이다.

| 없던 것 | CMA |
|---|---|
| 샌드박스 (임의 명령 실행) | 세션별 격리 컨테이너 · `bash`/`read`/`write`/`edit`/`glob`/`grep` |
| 앱 구동 | 같은 컨테이너에서 서버 띄우고 확인 |
| git | `github_repository` 리소스 — clone/push, 토큰은 컨테이너에 들어가지 않고 Anthropic 측 프록시가 주입 |
| PR | GitHub MCP 서버 (`create_pull_request`) |
| 세션 상태 · 컨텍스트 압축 · 프롬프트 캐싱 | 내장 |
| 큐 · 동시성 · 재시도 | 플랫폼 |

### 잃는 것 — 정직하게

Phase 1의 판단 기준은 *"Phase 2로 갈 때 무엇을 다시 안 써도 되는가"*였고,
그 답으로 **프롬프트 조립 · 액션 프로토콜 · 실행기 · 상태기**를 전송과 분리해 뒀다.

CMA를 택하면 그중 **상태기와 액션 프로토콜은 대체된다.**
CMA가 자체 루프·이벤트 스트림·툴 호출 규약을 갖고 있기 때문이다.

살아남는 자산은 이것이다 — 그리고 이게 code-agent의 진짜 고유 가치이기도 하다:

| 자산 | Phase 2에서의 역할 |
|---|---|
| `code-agent.json` 매니페스트 | 정책의 스키마. 계층·경로·단계·참조 표준 선언 |
| `execute.ts`의 **경로 대조** | 툴 호출 승인 콜백. **버리면 안 되는 코어** |
| `exemplar.ts`의 **경로 계산** | 무엇을 읽힐지 코드가 결정론적으로 정함 |
| 단계 템플릿 (`doc/templates/*.md`) | Skill + Outcome 루브릭 |
| 컨벤션 문서 로딩 | 세션 시스템 프롬프트 |

버려도 되는 것: `turn.ts` · `session.ts` · `state.ts` · `fence.ts` · `action.ts` · `manual*.ts` · `emit.ts` · `plan.ts`.

> **수동 모드는 지운다는 뜻이 아니다.** CLI는 오프라인 디버깅과 프롬프트 검토용으로 남긴다.
> 다만 Phase 2의 실행 경로는 아니다.

---

## 전제 조건

| # | 항목 | 비고 |
|---|---|---|
| 1 | **대상 저장소가 GitHub에 있을 것** | `github_repository` 리소스가 GitHub URL + PAT를 요구한다. 로컬 `C:\...` 저장소는 그대로는 못 쓴다 |
| 2 | GitHub PAT | clone만이면 `Contents: Read`, push까지면 `Contents: Read and write` |
| 3 | GitHub MCP OAuth 자격증명 | PR 생성용. vault에 저장 (PAT와 **다른** 자격증명) |
| 4 | `ANTHROPIC_API_KEY` | |
| 5 | 공개 HTTPS 웹훅 엔드포인트 | 질문 발생·완료 알림 수신 |
| 6 | 대상 저장소에 `code-agent.json` + 컨벤션 문서 | 없으면 bootstrap/adopt를 먼저 돌린다 |

---

## 전체 구조

```
  호출하는 서비스
        │  POST /jobs { repo, mode, spec, domain }
        ▼
  ┌─────────────────────────────────────────────┐
  │  code-agent 서버 (얇다)                      │
  │                                             │
  │  ① 매니페스트 로드 → 단계·경계·참조경로 계산   │   ← 기존 manifest/exemplar
  │  ② 세션 생성 (agent + environment + repo)    │
  │  ③ SSE 스트림 구독                           │
  │     ├ agent.tool_use(ask) → 경계 대조 →      │   ← 기존 execute의 경로검사
  │     │   allow / deny(+이유)                  │
  │     ├ agent.custom_tool_use(ask_human)       │
  │     │   → 질문 저장 + 웹훅 발송 → 보류        │
  │     └ outcome_evaluation_end(satisfied)      │
  │         → 다음 단계 Outcome 전송              │
  └─────────────────────────────────────────────┘
        │  Sessions API
        ▼
  ┌─────────────────────────────────────────────┐
  │  Anthropic 오케스트레이션 (에이전트 루프)      │
  └──────────────────┬──────────────────────────┘
                     │ 툴 호출
                     ▼
  ┌─────────────────────────────────────────────┐
  │  세션 샌드박스 컨테이너                        │
  │   /workspace/repo   ← github_repository 마운트│
  │   bash · read · write · edit · glob · grep    │
  │   → 스캐폴딩 실행 · 빌드 · 테스트 · 앱 구동    │
  │   → git branch/commit/push (프록시가 토큰 주입)│
  └─────────────────────────────────────────────┘
```

**서버가 하는 일은 네 가지뿐이다**: 정책 계산 · 세션 시작 · 툴 호출 승인 · 단계 진행.
파일을 만들지도, 명령을 돌리지도, git을 만지지도 않는다. 전부 샌드박스가 한다.

---

## 경계 강제 — code-agent의 존재 이유를 지키는 법

> "계층을 넘지 않는다"와 "실패를 덮지 않는다"는 모델의 선의가 아니라 **경로 대조**로 지킨다.
> 이 원칙은 Phase 2에서도 그대로다. 강제 지점만 옮긴다.

에이전트 툴셋의 `write`/`edit`에 **`permission_policy: always_ask`**를 건다.

```jsonc
{
  "type": "agent_toolset_20260401",
  "default_config": { "enabled": true, "permission_policy": { "type": "always_allow" } },
  "configs": [
    { "name": "write", "permission_policy": { "type": "always_ask" } },
    { "name": "edit",  "permission_policy": { "type": "always_ask" } }
  ]
}
```

흐름:

```
모델이 write 호출
  → 세션이 idle(requires_action)로 멈춤
  → 스트림에 agent.tool_use (evaluated_permission === "ask")
  → 서버: 대상 경로를 현재 단계의 outputDirs 와 대조
      ├ 통과 → user.tool_confirmation { result: "allow" }
      └ 위반 → user.tool_confirmation {
                 result: "deny",
                 deny_message: "app/features/other/hack.py 는 이번 도메인
                                디렉토리(app/features/shipment) 밖입니다.
                                필요하다면 note 로만 남기세요."
               }
  → 모델이 거부 사유를 읽고 교정
```

### Phase 1보다 나아지는 점

Phase 1은 응답 전체를 검사해 **하나라도 걸리면 전부 미반영**이었다.
절반만 반영된 `out/`이 다음 턴 입력이 되어 오염이 번지기 때문이었다.

Phase 2에서는 그 이유 자체가 사라진다 — 거부된 write는 **애초에 일어나지 않으므로** 오염될 상태가 없다.
게다가 거부 사유가 즉시 모델에 전달되어 같은 턴 안에서 교정된다.

### verify 단계의 구조적 방어도 그대로

`kind: "verify"` 단계의 `outputDirs`에 테스트 디렉토리를 넣지 않는 선언은 그대로 작동한다.
테스트를 통과시키려고 단언을 지우려는 `edit` 호출은 경로 대조에서 거부된다.

### bootstrap의 "빌드 파일은 모델이 쓰지 않는다"도 강화된다

스캐폴딩 결과물(`build.gradle`, `package.json`, 엔트리포인트)의 경로를 **do-not-touch 목록**에 넣으면,
스캐폴더가 만든 파일을 모델이 고치는 것이 구조적으로 불가능해진다.
Phase 1에서는 템플릿의 규칙 문장이었던 것이 코드의 대조가 된다.

---

## 단계는 Outcome이 된다

`code-agent.json`의 `stages` 하나가 세션 하나가 아니라, **한 세션 안의 Outcome 하나**가 된다.

```
세션 1개 = 도메인 1개

  user.define_outcome  { description: "Entity + 코드 enum", rubric: 02-entity.md 의 체크리스트 }
      → 에이전트 작업 → grader 채점 → needs_revision 이면 반복 → satisfied
  user.define_outcome  { description: "Repository", rubric: 03-repository.md ... }
      → ...
  user.define_outcome  { description: "빌드·테스트 통과시키기", rubric: 09-verify.md ... }
      → 완료
```

| Phase 1 | Phase 2 |
|---|---|
| 생성 단계 | Outcome의 `description` — 템플릿의 §3 작업 |
| 검수(gate) 단계 | Outcome의 `rubric` — 템플릿의 §4 자가검증 체크리스트 |
| `gateAttempts` 2회 상한 | `max_iterations` (기본 3, 최대 20) |
| 앞 단계 산출물을 `out/`에서 다시 읽어 주입 | **불필요** — 같은 세션이라 컨텍스트가 이어진다 |

`state.ts`의 `loadPreviousResults`가 사라지는 게 이 설계의 가장 큰 단순화다.

**한 번에 하나씩.** 앞 Outcome이 종료 상태(`satisfied` / `max_iterations_reached` / `failed`)에 도달한 뒤에만
다음 것을 보낸다. 서버가 `span.outcome_evaluation_end`를 보고 체이닝한다.

`max_iterations_reached`로 끝나면 **자동으로 넘어가지 않는다.** Phase 1의 "두 번 시도해도 남으면 사람에게 넘긴다"와 같다 —
세션을 idle로 두고 웹훅을 쏜다.

---

## 참조 표준 선주입 — 경로는 코드가, 읽기는 샌드박스가

> **참조할 파일은 모델이 아니라 코드가 결정론적으로 고른다.**

이 원칙은 유지한다. 다만 파일을 **읽어서 프롬프트에 넣는** 대신, **읽을 경로를 지시**한다.

```
① 서버: exemplar.ts 가 매니페스트의 exemplars 패턴대로 경로 계산
       ["src/main/java/com/acme/app/application/deal/domain/Deal.java",
        "src/main/java/com/acme/app/application/deal/cd/"]

② Outcome description 에 그 경로를 박아 보냄
       "먼저 아래 파일을 read 하고 그 구조를 복제한다. 탐색하지 말 것:
          - /workspace/repo/src/.../deal/domain/Deal.java
          - /workspace/repo/src/.../deal/cd/"

③ 샌드박스가 read
```

결정론이 유지되는 이유: **무엇을 읽을지는 여전히 코드가 정한다.** 모델은 고르지 않는다.
얻는 것: 프롬프트에 파일 내용을 통째로 싣지 않아 토큰이 절약되고, 대용량 참조 도메인도 감당된다.

`sourceExtensions` · `{Ref}` 치환 · 디렉토리 전개 로직은 `exemplar.ts`에서 그대로 쓴다.

---

## 질문 루프 — 비동기 대기

> **답하지 않은 질문이 남아 있는 동안에는 진행되지 않는다.** 이 원칙은 유지한다.
> 다만 파일에 쌓고 사람이 CLI를 다시 부르는 대신, 세션이 살아 있는 채로 기다린다.

`ask`를 **custom tool**로 선언한다.

```jsonc
{
  "type": "custom",
  "name": "ask_human",
  "description": "스펙만으로는 정할 수 없는 것을 사람에게 묻는다. 추측으로 채우지 말 것.",
  "input_schema": {
    "type": "object",
    "properties": {
      "question": { "type": "string" },
      "why":      { "type": "string", "description": "왜 스펙에서 읽어낼 수 없는지" }
    },
    "required": ["question", "why"]
  }
}
```

```
모델이 ask_human 호출
  → agent.custom_tool_use 이벤트, 세션 idle(requires_action)
  → 서버: 질문을 DB에 저장 + 웹훅/Slack 알림
  → 세션은 그대로 대기 (컨텍스트 유지, 비용 발생 없음)
       ⋮  사람이 답할 때까지 며칠이 걸려도 무방
  → POST /jobs/:id/answer { question_id, answer }
  → 서버: user.custom_tool_result 로 답 전달
  → 세션 재개
```

Phase 1보다 나은 점: **컨텍스트가 유지된다.** `questions.md`에 답을 적고 `next`를 다시 부르면
프롬프트가 처음부터 재조립되던 것이, 여기서는 대화가 끊기지 않고 이어진다.

---

## 프로젝트 생성과 앱 구동

### bootstrap — 스캐폴딩을 서버가 실행한다

Phase 1에서 루프가 끊기던 유일한 지점이 사라진다.

| 단계 | Phase 1 | Phase 2 |
|---|---|---|
| `decisions` | 질문지 생성 → 사람이 답 확정 | 동일. `ask_human`으로 물음 |
| `scaffold-plan` | 명령 문서 생성 → **사람이 직접 실행** | 명령을 정하고 **샌드박스에서 bash로 실행** |
| `skeleton` | 공통 모듈 생성 | 동일 |
| `declare` | `code-agent.json` + 컨벤션 문서 | 동일. 그대로 커밋 |

"모델이 빌드 파일을 기억으로 쓰면 의존성 좌표를 환각한다"는 원칙은 유지된다 —
`bash`로 공식 스캐폴더를 **실행**하는 것이지, `write`로 빌드 파일을 **쓰는** 게 아니다.
그리고 스캐폴더 산출 경로는 do-not-touch에 들어가 사후 수정도 막힌다.

### 앱 구동 + 동작 확인

`verify` 단계 뒤에 `smoke` 단계를 추가한다.

```jsonc
{
  "key": "smoke",
  "title": "앱을 띄워 동작 확인",
  "template": "10-smoke.md",
  "kind": "verify",
  "scope": "project",
  "outputDirs": [],          // 아무것도 쓰지 않는다 — 확인만 한다
  "exemplars": []
}
```

`outputDirs: []`가 아니라 **빈 배열은 "제한 없음"**이므로, 여기서는 `write`/`edit`를 전부 거부하도록
서버 콜백에 `readOnly: true`를 두는 편이 안전하다. (매니페스트 스키마에 `readOnly` 플래그 추가 필요 — 소스 수정 항목)

동작 확인은 컨테이너 내부에서 끝난다: 백그라운드로 앱을 띄우고 `curl localhost:8080/health`,
로그 확인, 종료. 외부 노출이 필요 없다.

> **범위 경계**: 여기까지가 "구동 확인"이다. 배포·IaC·관측은 여전히 범위 밖이다.

---

## git과 PR

두 자격증명이 **서로 다르다**는 점에 주의한다.

| 용도 | 자격증명 | 어디에 |
|---|---|---|
| clone · push | GitHub PAT | 세션의 `github_repository.authorization_token` |
| PR 생성 | GitHub MCP OAuth | vault → 세션의 `vault_ids` |

```
세션 시작 시   github_repository 로 저장소 마운트 (checkout: main)
작업 중        bash: git checkout -b feat/shipment
모든 Outcome 종료 후
              bash: git add -A && git commit -m "..." && git push -u origin feat/shipment
              MCP:  create_pull_request(base: main, head: feat/shipment, ...)
```

커밋 메시지와 PR 본문은 마지막 Outcome으로 만든다 — 그 세션이 무엇을 왜 했는지 아는 유일한 주체이기 때문이다.
`note`로 남긴 판단 지점들이 PR 본문의 "판단이 필요했던 곳" 섹션이 된다.

**머지는 하지 않는다.** PR까지가 에이전트의 끝이다.

---

## 서버 API

```
POST   /jobs                    작업 시작
       { repo, mode: "develop"|"bootstrap"|"adopt",
         domain?, specs: [...], reference?, budgetUsd }
       → { jobId, sessionId, consoleUrl }

GET    /jobs/:id                상태
       → { status, currentStage, completedStages,
           pendingQuestions: [...], violations: [...], prUrl? }

POST   /jobs/:id/answer         대기 중 질문에 답
       { questionId, answer }

POST   /jobs/:id/interrupt      중단

POST   /webhooks/cma            Anthropic 웹훅 수신 (HMAC 검증)
```

### 워커 루프 (세션당 하나)

```
스트림을 먼저 연 뒤 첫 Outcome 을 보낸다   ← 순서 중요. 반대면 초기 이벤트를 놓친다
for await (event of stream):
    agent.tool_use (ask)            → 경계 대조 → allow / deny
    agent.custom_tool_use           → 질문 저장 + 알림 + 보류
    span.outcome_evaluation_end     → satisfied 면 다음 Outcome, 아니면 대기
    session.status_idle             → stop_reason 이 requires_action 이면 계속
    session.status_terminated       → 종료
```

스트림이 끊기면 재연결 시 `events.list`로 히스토리를 먼저 읽고 이벤트 ID로 중복 제거한다.
**이걸 빼먹으면 승인 대기 중 연결이 끊겼을 때 세션이 영구 교착된다.**

---

## 기존 코드의 운명

| 파일 | 운명 |
|---|---|
| `manifest.ts` | **유지** — 정책 스키마. `readOnly` 플래그 추가 |
| `execute.ts` | **경로 검사만 추출** → `checkWrite(path, stage): allow \| deny(reason)` |
| `exemplar.ts` | **유지** — 경로 계산만. 파일 읽기는 제거 |
| `conventions.ts` | **유지** — 시스템 프롬프트 조립 |
| `generate.ts` · `gate.ts` | **분해** — 프롬프트/루브릭 문안만 Outcome 생성기로 |
| `types.ts` | 정리 |
| `turn.ts` · `session.ts` · `state.ts` | CMA가 대체 (CLI용으로만 잔존) |
| `fence.ts` · `action.ts` · `manual*.ts` · `emit.ts` | CLI용으로만 잔존 |
| `plan.ts` · `run.ts` · `build.ts` · `dryRun.ts` | CLI용으로만 잔존 |
| `cli/index.ts` | **유지** — 오프라인 디버깅·프롬프트 검토 |

신규:

```
src/server/     http.ts  worker.ts  webhook.ts  store.ts
src/cma/        agent.ts  session.ts  outcome.ts  approval.ts  git.ts
```

---

## 안전장치

| 장치 | 설정 |
|---|---|
| **비용 상한** | 세션 `budget` — 달러 하드캡. 도달하면 세션이 pause(`budget_reached`). 필수 |
| **네트워크** | 환경 `networking: limited` + `allow_package_managers: true` + MCP 도메인 허용 |
| **경계 위반 상한** | 같은 단계에서 N회 이상 거부되면 중단하고 사람에게 넘김 |
| **테스트 실패** | 자동 수정하지 않는다. `max_iterations` 소진 시 보고하고 멈춤 |
| **웹훅 서명** | HMAC 검증 필수 (SDK의 `webhooks.unwrap`) |
| **감사** | 모든 승인/거부 결정을 `{경로, 단계, 판정, 사유}`로 기록 — Phase 1의 `log`를 잇는 것 |

---

## 마일스톤

| # | 목표 | 완료 기준 |
|---|---|---|
| **M0** | 전제 갖추기 | 대상 저장소 GitHub 이전 · PAT · vault · 웹훅 엔드포인트 |
| **M1** | develop 한 도메인 end-to-end | 세션 1개가 계획→단계들→verify를 돌고 **PR이 올라온다**. 경계 위반이 실제로 거부되는 걸 로그로 확인 |
| **M2** | 질문 비동기 루프 | `ask_human` 호출 → 알림 → 답 → 재개가 돈다. 세션이 하루를 넘겨 대기해도 복구된다 |
| **M3** | bootstrap | 빈 저장소에서 스캐폴딩 실행 → 공통 모듈 → `code-agent.json` 커밋까지 |
| **M4** | 앱 구동 확인 | `smoke` 단계가 앱을 띄우고 헬스체크를 통과시킨다 |
| **M5** | 서버 API + 운영 | 큐 · 동시 세션 · budget · 감사 로그 |

**M1이 전부를 결정한다.** 경계 승인 콜백이 실제로 작동하는지가 이 설계의 유일한 미검증 가정이다.
M1을 작은 도메인 하나로 먼저 돌리고, 승인 로그를 보고 나머지를 판단한다.

---

## 리스크

| 리스크 | 대응 |
|---|---|
| **CMA가 베타** | API가 바뀔 수 있다. `src/cma/`로 경계를 두어 정책 계층이 흔들리지 않게 한다 |
| **GitHub 전제** | 로컬/사내 Git만 쓴다면 이 설계가 성립하지 않는다. 그때는 self-hosted 샌드박스 또는 자체 서버로 |
| **exemplar 선주입 약화** | 파일 내용을 직접 넣지 않으므로 모델이 지시를 무시하고 탐색할 수 있다. 프롬프트에 "탐색 금지" 명시 + `glob`/`grep` 호출 빈도를 로그로 감시 |
| **비용 예측 불가** | Phase 1의 턴 기록이 아직 없다. M1에서 실측하고 세션 budget을 그 값으로 잡는다 |
| **승인 콜백이 병목** | 모든 write가 왕복 한 번이다. 느리면 경계 안이 확실한 경로는 `always_allow`로 내리고 밖만 검사 |
| **실제 프로젝트 검증 부재** | Phase 1도 끝까지 돌려본 적이 없다. M1을 작은 도메인으로 잡는 이유 |
