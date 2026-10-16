# master 연동 — 통신 계약과 실행 제어

여러 프로젝트를 나눠 맡기는 상위 조정자(master-agent)가 이 프로젝트의 code-agent 절차를 시작·관찰·정지·재개·인계하는 창구다. 개발 절차(접수·분석·계획·구현·검증·리뷰·반영)와 완료 조건은 바꾸지 않는다. master 는 같은 절차를 비대화형 호스트 세션으로 돌리고, 사람이 따로 준 권한 범위에서만 동의·질문에 판단을 낸다.

코드는 `src/agent/master/`에 있다. 계약 상수(명령·오류 코드·이벤트·실행 상태·위임 동작·정책 기본값)는 `protocol.ts` 하나가 원천이다.

선행 작업의 계약 자료는 [외부 의존 계약 인계](dependency-contracts.md)의 JSON과 `planning contracts`로 담당에게 전달한다. `planning reuse-answer`의 `contract` 출처는 사람 답과 master 위임·전달 출처를 대신하지 않으며, v1의 위임 권한 검사는 그대로 적용한다.

## 1. 적용 조건과 역할

| 항목 | 동작 |
|---|---|
| 적용 대상 | 사람이 터미널에서 `code-agent master enable` 로 켠 프로젝트(`.code-agent/master/binding.json`)와, 그 안에서 master 실행이 연 작업(`works/<작업 ID>.json`)만이다. 켜지 않은 프로젝트에서는 `master call` 이 `not-enabled` 를 돌려줄 뿐 아무것도 쓰지 않고, 기존 CLI·hook·동의는 그대로다 |
| 연동하지 않은 작업 | 켠 프로젝트라도 사람이 연 작업은 master 가 이어 실행하지 않고(`not-enabled`) 위임 판단도 받지 않는다 |
| 연결과 권한 | 토큰은 요청자를 확인할 뿐 승인 권한이 아니다. 승인·답 위임은 사람이 `code-agent master grant` 로 준 권한 범위 안에서만 받는다 |
| 역할 | master — 요구 분석·프로젝트별 배분·의존성·재계획·전체 완료와 독립 검증. code-agent — 프로젝트 안의 실행과 로컬 검증·승인 조건. 실행 감독(`master supervise`) — 호스트 세션과 프로세스의 실행·정지·생존 확인 |

master 실행도 같은 스킬·hook·CLI 를 거친다. 동의는 `consent.ts`의 같은 적용 함수로, 상태는 `status --json`과 같은 `stateView`로 본다. master 전용 실행 경로나 게이트 생략은 없다.

## 2. 전송과 요청·응답

같은 PC 의 CLI 호출이다. `code-agent master call` 이 stdin 의 JSON 요청 한 건을 읽어 stdout 에 JSON 응답 한 건을 쓴다(성공 0, `ok:false` 는 1). 서버·포트·밀어넣기 연결은 없다.

```jsonc
// 요청
{ "protocol": "code-agent.master", "version": 1, "type": "submit",
  "controller": "master-a", "generation": 3, "token": "<enable 때 받은 토큰>",
  "commandId": "inv-7f2c…",                 // 상태를 바꾸는 요청에 필수
  "expect": { "stateVersion": "sha256:…", "work": null, "attempt": null },
  "payload": { … } }
// 응답
{ "protocol": "code-agent.master", "version": 1, "ok": true, "type": "submit", "commandId": "inv-7f2c…",
  "replayed": false, "result": { … },       // 실패면 "error": { "code", "message", "detail" }
  "events": { "logId": "…", "latestSeq": 42 },
  "ownership": { "controller": "master-a", "generation": 3, "handover": "ho-…:stopping" },
  "at": "2026-10-15T…" }
```

모르는 필드·프로토콜·버전·명령은 처리 전에 거부한다(`invalid-request`·`unsupported-protocol`·`unsupported`).

## 3. 기능 협상 — `hello`

`execution`은 LangGraph 프레임워크·그래프 형식 버전·SQLite 체크포인트·재개 명령·권한 원천을 알린다. 무인 호스트도 `code-agent flow advance --json`의 [인계 계약](langgraph.md#호스트의-실행-계약)을 따른다.

인증 없이 받는다. 돌려주는 것: 지원 버전, code-agent 버전과 상태 형식 세대(`stateSchema`), 프로젝트 ID 와 연동 여부, 등록 제어자, 지금 소유, 명령 목록(open·read·mutating), 호스트(`claude` 지원, `codex` 미지원), 승인 방식(사람 응답 채널과 위임 채널 `master-delegation`·위임 가능 동작·사람만 하는 동작·판단 분류, `requireVerifiedApproval` 이면 `delegationAvailable: false`), 이벤트 종류, 실행 상태, 오류 코드, 정책, 지원하지 않는 기능(`unsupported` — `host:codex`, `transport:network`, `delegate:human-only-actions`, `events:push`)과 이유.

## 4. 명령

| 종류 | 명령 | payload | 비고 |
|---|---|---|---|
| open | `hello` | — | 인증 없음 |
| read | `snapshot` | — | 소유·정책·실행(활성은 프로세스 확인 포함)·`stateView`·이벤트 위치·작업 연결. 재조정 후 낸다 |
| read | `events` | `after`, `logId`, `limit` | §6 |
| read | `heartbeat` | — | 소유·활성 실행·이벤트 위치·`stateVersion` |
| read | `command` | `commandId` | 그 명령의 처리 상태·기록된 응답·연결된 실행. 낸 제어자만 본다 |
| read | `result` | `runId` | 실행 요약과 결과 근거(§9), `final` |
| read | `questions` | `workId?` | 질문 문서와 `questionsHash`·답 출처 |
| read | `consents` | `ids?` | 열린 동의와 `shownHash`·`humanOnly`·`preparedByMasterRun` |
| read | `grants` | — | 이 제어자의 권한과 사용 수 |
| mutating | `submit` | `mode`(start·continue), `prompt`(≤20000자), `sessionId`(continue), `links`, `timeoutMs` | §5 |
| mutating | `resume` | `runId`, `prompt?`, `links?` | 끝난 실행(`paused`·`blocked`·`completed`·`failed`·`unknown`·`cancelled`)의 세션을 잇는다 |
| mutating | `pause`·`cancel` | `runId`, `reason?`, `graceMs?`, `force?`, `waitMs?` | §7 |
| mutating | `decide` | `consentId`, `verdict`, `decisionId`, `grantId`, `category`, `reason`, `evidence[]`, `shownHash`, `choices?` | §8 |
| mutating | `answer` | `actor`(ai·human), `decisionId`, `grantId`, `category`, `reason`, `evidence[]`, `questionsHash`, `answers[{q, answer}]`, `workId?` | §8 |
| mutating | `handover` | `action`(request·advance·accept·abort·status), `to`, `handoverId` | §10 |
| mutating | `reconcile` | — | 실행·인계를 프로세스 확인과 함께 대조한다 |
| mutating | `policy` | `patch` | §12 정책 일부를 바꾼다(범위 검사) |
| mutating | `revoke` | `grantId`, `reason?` | 자기 권한만 회수한다. 권한을 주는 명령은 없다 |

`links`(`missionId`·`taskId`·`attemptId`·`planVersion`·`invocationId`)는 실행 기록과 작업 연결에 남아 master 의 임무·작업·시도·계획과 code-agent 의 작업·시도·세션을 잇는다.

### 오류 코드

| 코드 | 뜻 |
|---|---|
| `invalid-request` | 꼴·값 오류 |
| `unsupported-protocol`·`unsupported` | 모르는 프로토콜·버전·명령·호스트 |
| `not-enabled` | 연동을 켜지 않은 프로젝트, master 실행이 열지 않은 작업 |
| `unauthorized` | 등록되지 않은 제어자·토큰 불일치·다른 제어자의 명령 조회 |
| `fenced` | 지금 소유자가 아니거나 세대가 다르다(이전 소유의 늦은 요청) |
| `handover-in-progress`·`handover-unaccepted` | 인계 중에 받지 않는 명령, 이전된 뒤 새 제어자가 아직 인수하지 않음 |
| `conflict` | 같은 `commandId`의 다른 내용, 다른 임무·작업에 묶인 작업, 이미 답한 질문 |
| `stale-state` | 기대한 `stateVersion`·동의 내용 해시·질문 문서 해시가 지금과 다르다 |
| `busy` | 실행 중인 실행이 있다·다른 세션의 작업 임대·동의를 준비한 실행이 끝나지 않았다 |
| `not-found`·`invalid-state` | 대상이 없다·지금 재개 판정에서는 그 동작을 하지 않는다 |
| `human-required` | 사람만 하는 동작·critical 판단·master 실행이 준비하지 않은 동의 |
| `grant-missing`·`grant-expired`·`grant-revoked`·`grant-exhausted`·`scope-exceeded` | 권한 없음·만료·회수·한도 소진·동작·작업·경로 범위 밖 |
| `duplicate-decision` | 같은 `decisionId`를 다시 썼다 |
| `policy-forbids` | `requireVerifiedApproval` 프로젝트의 위임, ambiguous 승인, 위험한 호스트 설정 |
| `host-unavailable`·`internal` | 호스트를 띄우지 못함·처리 도중 끊긴 명령 등 |

## 5. 원자적 수락과 중복 방지

상태를 바꾸는 요청은 제어 잠금(`.code-agent/master/control.lock`) 안에서 한 번에 처리한다.

1. `commandId` 기록(`commands/<ID>.json`)을 본다. 같은 내용(요청 해시 — `type`·`controller`·`expect`·`payload`)이면 기록된 응답을 `replayed: true`로 그대로 돌려주고 다시 실행하지 않는다. 다른 내용이면 `conflict`.
2. 처리 전에 `received`를 먼저 쓴다. 처리 도중 끊겨 `received`로 남은 명령의 재전송은 다시 실행하지 않는다 — 그 명령으로 접수된 실행이 있으면 그 실행을 `recovered: true`로 돌려주고, 없으면 `internal`(결과를 확인할 수 없음)로 답한다. master 는 `snapshot`으로 대조한 뒤 새 `commandId`를 쓴다.
3. 소유·세대 대조(§10) → 실행·인계 재조정 → 처리 → `accepted`(응답 포함) 또는 `rejected`로 기록하고 `command.accepted`·`command.rejected` 이벤트를 남긴다.

`submit`은 같은 잠금 안에서 다음을 함께 확인한 뒤에만 실행을 접수한다: 실행 중인 실행 없음(`busy`), `expect`(`stateVersion`·`work`·`attempt` — 다르면 `stale-state`), 작업 임대(다른 세션이면 `busy` — 끝난 master 실행의 세션이 쥔 임대만 푼다), 작업 연결(사람이 연 작업이면 `not-enabled`, 다른 임무·작업이면 `conflict`), 재개 판정(`no-work`·`ready`·`replan-required`만 시작, continue 는 자기 시도 실행 중 대기도 받는다. master 위임 판단이 수정 요청으로 닫은 확인 요청을 다시 준비할 자리 — `needs-human`·`reapproval-required`의 요구 확정·계획·반영 확인이고 같은 동작의 마지막 동의가 위임 수정 요청이다 — 는 그 동의를 준비한 세션의 continue 만 받는다. 사람이 낸 수정 요청은 사람 경로로 남는다. 그 밖의 사람 판단 대기·한도·관측 불가는 `invalid-state`). 접수하면 프롬프트·실행 기록을 `accepted`로 쓰고 감독 프로세스를 띄운다. 감독이 시작하지 못하고 끝나도 기록은 남아 재조정이 `abandoned`로 닫는다.

응답을 잃은 master 는 같은 `commandId`로 다시 보내거나 `command`로 처리 상태를 묻는다. 둘 다 실행을 두 번 만들지 않는다.

## 6. 이벤트·heartbeat·재동기화

`snapshot.state.graph`와 실행 결과의 `state.graph`는 최신 실행 ID·thread·그래프·노드·상태·이벤트 순번을 제공한다. 관찰 시 달라진 값은 `graph.changed` 이벤트에 남는다. 그래프 관찰만 바뀌면 업무 `stateVersion`은 바뀌지 않는다.

`events.jsonl`은 순번(`seq`, 1씩 증가) 기록이고 `events-meta.json`의 `logId`가 기록 하나를 가린다. 모든 응답에 `events: {logId, latestSeq}`가 붙는다.

- `events {after, logId}` → `after` 다음부터 `limit`개와 `latestSeq`·`hasMore`. 기록 ID 가 다르거나(기록이 새로 만들어짐) `after`가 최신보다 크거나 이미 지난 구간이면 `gap: true` — master 는 `snapshot`으로 다시 맞추고 그 위치부터 읽는다.
- 종류: 연동·권한·정책(`binding.*`·`controller.added`·`grant.*`·`policy.changed`), 명령(`command.*`), 실행(`run.accepted`·`starting`·`started`·`stop-requested`·`finished`·`abandoned`·`orphaned`·`unknown`), 연결(`master.disconnected`·`reconnected`), 진척(`work.bound`·`phase.changed`·`attempt.changed`·`resume.changed`·`question.*`·`consent.*`·`verification.recorded`), 판단(`decision.recorded`·`applied`·`rejected`·`answer.recorded`), 인계(`handover.*`). 진척 이벤트는 감독이 `progressMs`마다 `stateView`를 직전 관찰(`observed.json`)과 비교해 남긴다.

세 가지를 따로 낸다:

| 구분 | 근거 | 어디에 |
|---|---|---|
| 연결 | 지금 제어자의 마지막 요청 시각(`owner.lastSeenAt`) | 감독이 `masterTimeoutMs`를 넘기면 `master.disconnected`, 다시 오면 `reconnected` |
| 프로세스 생존 | 감독 heartbeat(`supervisor.heartbeatAt`)와 OS 프로세스 확인(pid + 명령줄 표지 — `alive`·`dead`·`reused`·`unknown`) | `snapshot`·`result`의 `liveness` |
| 업무 진척 | code-agent 상태의 단계·시도·재개 판정·질문·동의·검증 | 진척 이벤트, `stateVersion` |

연결 끊김은 실패·재배정 근거가 아니다. 정책 `onMasterDisconnect`가 `continue`(기본)면 실행을 그대로 두고, `pause`면 협력 정지를 건다. heartbeat 가 늦은 것만으로 실행을 끝난 것으로 보거나 다시 배정하지 않는다 — 실행 중인 실행이 있는 동안 새 `submit`은 `busy`다.

## 7. 실행 상태와 정지·취소·재개

그래프 진입과 실행 노드 시작에서 제어자·소유 세대·정지 요청을 확인한다. `pause`·`cancel`·인계 뒤 이전 실행은 다음 노드를 진행하지 못한다. 이미 실행 중인 자식 프로세스의 정지는 아래 감독 규약을 따른다.

```text
accepted → starting → running → stopping → completed | blocked | failed | cancelled | paused
accepted ─(startTimeoutMs 안에 감독 없음)→ abandoned
starting|running|stopping ─(감독 사라짐, 호스트 살아 있음·확인 불가)→ orphaned ─(강제 취소·호스트 종료 확인)→ cancelled | unknown
starting|running|stopping ─(감독·호스트 모두 사라짐)→ cancelled | paused(정지 요청이 있었으면) | unknown
```

활성 상태는 `accepted`·`starting`·`running`·`stopping`·`orphaned`이고 나머지는 끝 상태다. 끝 상태에서 다시 실행하려면 `resume`(같은 세션 `--resume`)이나 새 `submit`을 낸다. 재조정은 어떤 경우에도 실행을 다시 시작하거나 성공으로 바꾸지 않는다.

- 끝 상태 판정(감독): 시간 상한 초과 → `failed`, 정지 요청 → `cancelled`·`paused`, 호스트 실패(종료 코드·`is_error`) → `failed`, code-agent 재개 판정이 사람 판단·한도·관측 불가·소유 충돌·오래된 요청 → `blocked`, 그 밖 → `completed`. `completed`는 호스트 턴이 정상으로 끝났다는 뜻이고 작업 성공이 아니다(§9).
- `pause`·`cancel`: 접수만 된 실행은 바로 끝 상태가 된다. 실행 중이면 기록에 정지 요청을 남기고(요청 접수) hook 이 그 실행 세션의 모든 도구를 막아 모델이 턴을 끝내게 한다(협력 정지). `graceMs`(상한 `stopGraceMs`)가 지나거나 `force: true`면 감독이 확인된 호스트 프로세스 트리를 끝낸다(강제 종료). 결과의 `outcome`이 `cooperative`·`forced`를 가른다. 실제 정지 완료는 `run.finished` 이벤트나 `snapshot`의 끝 상태로 확인한다(`waitMs`로 응답 안에서 기다릴 수도 있다). `cancel`은 진행 중인 `pause`를 덮는다.
- 대상: 요청한 `runId`의 호스트만 끝낸다. 프로세스는 pid 와 명령줄 표지(`master supervise <runId>`·실행 세션 ID)가 맞을 때만 끝내고, 확인할 수 없으면 끝내지 않는다(`unknown`).
- 보존: 정지·취소는 작업 트리·작업 문서·검증 기록을 되돌리지 않는다. 결과에 변경 파일·검증·재개 지점이 남는다.
- `orphaned`(감독이 사라졌는데 호스트가 살아 있음)는 활성으로 남아 새 실행을 막는다. `cancel {force: true}`가 확인된 호스트를 끝내고 닫는다. Windows 에서는 감독이 끝나면 Node 가 호스트를 같은 작업 개체로 함께 끝내므로 보통 `unknown`(호스트 종료 확인, 결과 복구)으로 닫힌다.

## 8. 위임 판단과 질문 답

### 판단 분류와 위임 범위

| 분류 | 동의(`decide`) | 업무 질문(`answer`, actor ai) |
|---|---|---|
| `routine` | 권한 범위 안에서 `approve`·`request-changes`·`defer` | 권한 범위 안에서 답한다 |
| `ambiguous` | `request-changes`·`defer`만(재검토·추가 정보) — `approve`는 `policy-forbids` | 받지 않는다(`policy-forbids`) — 재검토 뒤 다시 분류한다 |
| `critical` | 받지 않는다(`human-required`) — 사람에게 넘긴다 | 받지 않는다(`human-required`) — 사람의 답을 actor human 으로 전달한다 |

위임할 수 있는 동작은 `request`(요구 확정)·`plan`(계획 승인)·`deliver`(반영)·`answer`(업무 질문)뿐이다. `setup`·`docs`·`baseline`·`model`·`plugin-add`·`plugin-remove`·`update`·`knowledge-prune`·`abort`·`repro-log`·`judgment`는 사람만 정한다 — 권한 문서에 넣을 수 없고 요청하면 `human-required`다. 프로젝트가 `workOrder.requireVerifiedApproval`이면 위임을 받지 않는다(`policy-forbids`).

### 위임 권한(grant)

사람이 TTY 에서 `code-agent master grant <권한.json>`으로 준다.

```json
{ "id": "grant-ord", "controller": "master-a", "works": ["ORD-1"], "missions": ["m-42"],
  "actions": ["request", "plan", "answer"], "paths": ["src/orders/**", "test/orders/**"],
  "ttlHours": 24, "maxUses": 10, "note": "주문 기능 임무" }
```

넓은 권한은 받지 않는다: 작업 또는 임무 ID 하나 이상(와일드카드 없음), 위임 가능한 동작만, `plan`·`deliver`는 `paths` 필수이고 저장소 전체(`**`·`*`·`**/*`)·절대 경로·`..`는 거부, 만료 최대 7일, 사용 한도 1~100. 회수는 사람(`master revoke`)이나 그 제어자(`revoke`)가 한다. 사용 수는 적용됐거나 결과가 남지 않은 판단으로 센다.

### 공통 검증 조건

위임 판단도 사람 응답과 같은 적용 함수(`consent.ts` `applyLocked`)를 지난다 — 동의 스냅샷 대조, 확인 화면 내용, 도메인 함수의 전제(요구 확정 해시, 계획 해시와 승인 원장, 검증 게이트, 반영 범위)가 그대로 돈다. 위임 쪽에서 더 보는 것:

1. 권한: 이 제어자의 것, 회수·만료·소진 아님, 동작 포함, 작업이 master 실행이 연 작업이고 권한의 작업·임무 범위 안.
2. 대상: master 실행 세션이 준비한 동의이고 그 실행이 끝났을 때(사람 세션의 동의는 `human-required`, 실행 중이면 `busy`). 사람의 응답이 이미 시작된 동의는 받지 않는다.
3. 최신성: master 가 본 동의 내용 해시(`shownHash` — 요약·선택지)와 `expect.stateVersion`이 지금과 같다. 질문 답은 `questionsHash`가 같다.
4. 범위: `plan`·`deliver` 승인은 계획 파일이 권한 `paths` 안이어야 하고, `deliver`는 계획 밖 변경이 없어야 하며 적용할 문서 변경도 `paths` 안이어야 한다. 문서 변경 후보(`choices`)는 `{번호: 적용|유지}`로 고르고, 빠진 번호는 유지(적용 안 함)다.
5. 중복: `decisionId`는 한 번만 쓴다.

### 기록 — 사람 응답과 구분

- 판단은 적용 **전에** `decisions.jsonl`에 남긴다(판단 ID·제어자·세대·명령 ID·권한·동작·분류·판단·이유·근거·대상과 본 해시). 적용 결과(`applied`·`rejected`·`failed`)는 다음 줄로 따로 남는다.
- 동의 기록의 응답 채널은 `master-delegation`이고 `verified: false`, `delegation` 필드에 판단 ID·권한·제어자·세대·분류가 있다. 원장 presence 문구에 "사람 응답 아님"이 들어간다. 반영 영수증(`consents.jsonl`)에도 `delegation`이 남는다. 수정 요청·보류 판단은 동의를 `changes-requested`·`deferred`로 닫고 그 실패 기록에 판단 이유 전문(2000자 이하)을 남긴다 — 이어 가는 세션이 무엇을 고칠지 읽는 자리다. 사람의 선택 기록(`observed`)·TTY 확인·승인 파일을 만들지 않는다.
- 질문 답은 `questions.md`의 `[Answer]:` 뒤에 `[Source]: master 위임 <판단 ID>` 또는 `master 전달 <판단 ID>`를 붙이고, `answers.jsonl`에 `delegated` 행(actor ai·human)을 남긴다. 답 출처는 `delegated`(master 위임 판단 — 사람 응답 아님)·`relayed`(master 경유 사람 답 — 관찰 안 됨)로 표시되고, 호스트가 관찰한 사람 답(`observed`)과 섞이지 않는다. 이미 답한 질문은 고치지 않는다(`conflict`).

위임하지 않은 동의·질문은 기존 절차대로 사람이 응답한다. master 실행 세션은 질문 도구를 쓰지 않으므로(§11) 그 세션이 준비한 동의는 master 의 `decide`나 사람의 TTY 응답(`consent apply <id>`)으로만 닫힌다.

## 9. 결과와 검증 근거

호스트가 끝나면 감독이 `runs/<runId>.json`의 `result`에 남긴다: 호스트 종료 코드·결과 종류·권한 거부 목록·최종 메시지와 해시·출력 해시, 실행 전후 `stateVersion`, 작업·시도·요구·승인·질문·열린 동의·재개 판정·발견, 검증 기록(회차·트리 묶임·단계별 통과)과 증거 파일 해시, 기준 HEAD 이후 커밋과 변경 파일(제품·작업 기록·code-agent 구분, 계획 파일 표시). 모델의 완료 발언은 성공 근거가 아니다. code-agent 의 완료 조건(검증·리뷰·반영 게이트)은 그대로이고, master 는 이 근거로 독립 검증과 전체 완료를 판정한다.

## 10. 제어권 인계와 세대

`owner.json`이 지금 제어자와 세대(`generation`)를 가진다. 상태를 바꾸는 요청은 제어자와 세대가 모두 맞아야 받는다 — 다르면 `fenced`. 세대는 연동을 끄고 다시 켜도 이어서 올라간다.

```text
request → stopping(실행 중인 실행에 협력 정지) → stopped(대상 실행이 모두 끝 상태로 확인) → transferred(세대+1, 제어자 변경) → accepted(새 제어자 인수)
request·stopping·stopped 에서만 abort(지금 제어자) — 멈춘 실행은 paused 로 남는다
```

- 정지 확인은 끝 상태로만 한다 — heartbeat 가 끊기거나 임대가 오래된 것만으로 넘기지 않는다. 각 단계는 `owner.json`에 남아 어느 단계에서 끊겨도 `advance`(또는 다음 요청의 재조정)가 같은 단계부터 잇는다.
- 이전 때 그 실행들의 세션이 쥔 작업 임대를 푼다. 이전 뒤 이전 제어자의 요청은 `fenced`, 새 제어자는 새 세대로 `accept`해야 상태를 바꾸는 명령을 받는다(그 전에는 `handover-unaccepted`).
- 인계 중에는 `pause`·`cancel`·`reconcile`·`revoke`·`handover advance·abort·status`만 받는다(`handover-in-progress`).
- 사람의 강제 인계: `code-agent master handover --to <ID> [--force-stop]`. `--force-stop`은 실행 중인 실행을 취소하고 확인된 호스트 프로세스를 끝낸 뒤 넘긴다. 남은 실행이 있으면 넘기지 않는다.

## 11. master 실행 세션의 규칙

감독은 사람이 enable 때 정한 호스트 설정으로 `claude -p --output-format stream-json --permission-mode <모드> --permission-prompts none --session-id|--resume <ID> --append-system-prompt <규칙> --allowedTools … --disallowedTools …`를 띄운다. 기본 허용 도구는 읽기·편집 도구와 `code-agent`·읽기용 git 셸 명령이고, 질문 도구(`AskUserQuestion`)는 늘 금지에 들어간다. `bypassPermissions`·`plan` 모드와 셸 전체 허용(`Bash`·`Bash(*)`)은 받지 않는다. 호스트 환경에서는 부른 쪽 Claude 세션의 표지를 지우고 `CODE_AGENT_MASTER_RUN=<runId>`를 넣는다.

hook 은 이 표지가 있는 세션에서 기존 판정보다 먼저 본다(`masterRunGuard`): 정지 요청이 있거나 끝난 실행이면 모든 도구를 막고 멈춘 자리를 보고하게 하며, 질문 도구는 동의 준비까지만 하고 끝내라고 돌려보내고, `code-agent master`·`code-agent takeover`를 막는다. 표지가 없는 세션(사람의 대화형 세션)은 이 판정을 지나지 않는다. 세션 밖 셸에서도 `code-agent master`는 막힌다(`decideOutside`) — 연동 설정은 사람이 터미널에서 직접 한다. SessionStart 는 실행 세션에 같은 규칙을 덧붙인다.

표지가 있는 세션에서 `--session` 없이 부른 `status --json`은 실행 기록의 세션으로 임대를 본다 — 실행 자신의 임대가 `self: true`로 나와 `ownership-conflict`로 읽히지 않는다. 기대 상태 대조는 접수할 때 한 번 한다(5절). 실행이 시작되면 세션 임대·hook 기록으로 상태 버전이 바뀌므로, master 는 실행 프롬프트에서 세션에 기대 상태를 다시 대조시키지 않는다.

hook 은 사고 방지 장치다. 토큰 파일은 저장소 밖에 두고(`--token-out`이 저장소 안이면 거부), 실행 세션의 허용 도구로 셸을 좁힌다.

## 12. 사람의 설정과 정책

모두 TTY 에서 확인 단어를 입력받는다(stdin 이 TTY 가 아니면 거부).

| 명령 | 동작 |
|---|---|
| `code-agent master enable --controller <ID> [--label <설명>] [--token-out <파일>] [--policy <정책.json>] [--host <호스트설정.json>]` | 처음이면 연동을 켜고 프로젝트 ID 를 만들며 그 제어자가 소유한다. 이미 켰으면 제어자를 더하거나 토큰을 바꾼다. 토큰은 한 번만 보이고 해시만 남는다 |
| `code-agent master disable` | 실행 중인 실행이 없을 때만 끈다. 기록은 남고 `binding.json`은 `binding.disabled-<시각>.json`이 된다 |
| `code-agent master grant <권한.json>` · `revoke <권한 ID> [--reason]` | §8 |
| `code-agent master handover --to <ID> [--force-stop]` | §10 |
| `code-agent master status [--json]` | 연동·제어자·소유·권한·최근 실행(읽기 전용) |

master 가 쓰는 명령은 `code-agent master call`이고, 감독은 `code-agent master supervise <runId>`(제어 명령이 띄운다)다.

정책(`--policy` 파일이나 `policy` 명령, 범위 밖 값·모르는 키는 거부):

| 키 | 기본 | 범위 | 뜻 |
|---|---|---|---|
| `heartbeatMs` | 10000 | 200~600000 | 감독 heartbeat 주기 |
| `progressMs` | 15000 | 200~3600000 | 진척 관찰 주기 |
| `masterTimeoutMs` | 120000 | 1000~86400000 | 연결 끊김으로 보는 시간 |
| `onMasterDisconnect` | `continue` | `continue`·`pause` | 끊겼을 때 실행 처리 |
| `stopGraceMs` | 120000 | 0~3600000 | 협력 정지 뒤 강제 종료까지 |
| `runTimeoutMs` | 3600000 | 1000~86400000 | 실행 한 건의 상한(`submit timeoutMs`는 이 안) |
| `startTimeoutMs` | 60000 | 1000~3600000 | 접수 뒤 감독 시작 상한 |
| `eventPageLimit` | 200 | 1~5000 | `events` 한 번의 최대 수 |

호스트 설정(`--host` 파일)은 `command`(예 `["claude"]`)·`permissionMode`(`acceptEdits`·`dontAsk`·`manual`·`auto`)·`allowedTools`·`disallowedTools`·`model`이다. 허용 도구는 권한에 닿으므로 master 가 바꾸지 못한다.

## 13. 기록 파일 — `.code-agent/master/`

폴더 안 `.gitignore`(`*`)가 전부를 무시한다. 반영 커밋·작업 트리 대조에 들지 않고 동의 스냅샷에서 뺀다(`SNAPSHOT_EXCLUDED`). 모델의 도구 쓰기는 `.code-agent/` 쓰기 거부로 막힌다.

| 경로 | 내용 |
|---|---|
| `binding.json` | 프로젝트 ID·켠 사람·제어자 토큰 해시·정책·호스트 설정 |
| `owner.json` | 제어자·세대·마지막 연락·인계 진행·이력 |
| `grants.jsonl` · `decisions.jsonl` | 권한·회수, 판단과 적용 결과(append 만) |
| `commands/<commandId>.json` | 처리 상태(`received`·`accepted`·`rejected`)와 기록된 응답 |
| `runs/<runId>.json` (+`.prompt.md`·`.out.jsonl`·`.err.log`·`.lock`·`.rec.lock`) | 실행 상태·이력·감독·호스트 프로세스·정지 요청·진척·결과 |
| `works/<작업 ID>.json` | master 실행이 연 작업과 임무·작업·시도·계획 연결, 실행 목록 |
| `events.jsonl` · `events-meta.json` · `observed.json` | 이벤트와 기록 ID, 마지막 진척 관찰 |
| `control.lock` · `observe.lock` | 제어·관찰 잠금 |

## 14. 한계

- 호스트는 Claude Code 비대화형 실행만이다. Codex 세션은 기존 독립 실행으로 쓴다.
- 통신은 같은 PC 의 CLI 호출이다. 원격 연결·밀어넣기 이벤트는 없다.
- 한 프로젝트에 실행은 한 번에 하나다. 여러 프로젝트는 master 가 프로젝트마다 따로 부른다.
- 다른 저장소의 산출물을 가져다 쓰는 작업은 통합 검증(`code-agent integrate`)이 기준 커밋을 뜬 깨끗한 worktree 에서 돌므로, 형제 저장소의 상대 경로가 풀리지 않는다. 프로젝트 사이 의존은 사람이 도입 설정에서 `code-agent.json`의 `prepare`로 깨끗한 트리에 잇는다. master 연동은 이 설정을 만들거나 바꾸지 않는다 — 매니페스트는 계획 승인이 묶는다.
- 프로세스 확인은 Windows 에서 PowerShell `Get-CimInstance`, 그 밖에서 `/proc`·`ps`로 명령줄을 본다. 확인하지 못하면 `unknown`으로 두고 끝내지 않는다.
