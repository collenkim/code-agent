# master 연동(선택) — 통신·실행 제어와 위임 판단 (2026-10-15)

커밋 `e5f136a`의 변경 경위와 검증 결과다. 현재 동작은 [master 연동 계약](../master-control.md)과 [흐름도](../process-flow.md) §1.1·§3.2·§4.2·§4.3·§5.1·§5.3·§5.4·§8·§9에 있다. 원자료는 [evidence/2026-10-15-master-control.json](evidence/2026-10-15-master-control.json)이다. master-agent 쪽 연동은 그 저장소의 `docs/code-agent-control.md`에 있다.

## 요청

master-agent 가 여러 프로젝트의 code-agent 를 시작·관찰·정지·재개·인계할 수 있도록 code-agent 에 통신 창구와 제어 지점을 더한다. 기존 접수·계획·구현·검증·반영 흐름과 완료 조건, 독립 실행·CLI·사람 승인·hook 은 그대로 둔다. 연동은 사람이 켠 프로젝트에만 적용하고, 연결만으로 승인 권한이 생기지 않으며, 위임 판단은 사람이 따로 준 범위에서만 받고 사람의 응답과 구분해 남긴다. 모의 시험과 실제 AI 연동 결과를 나눠 보고하고, 실제 전체 사이클이 막히면 그 지점과 조치를 남긴다.

## 기존 구현 확인

| 요청이 든 문제 | 코드에서 확인한 것 |
|---|---|
| 상태 조회와 예약·실행이 원자적이지 않다 | 맞다 — master-agent 는 `status --json`을 읽은 뒤 `claude -p`를 직접 띄웠다. code-agent 에는 접수 창구가 없었다 |
| 임대만으로 프로세스 생존을 알 수 없다 | 맞다 — `lease.ts` 임대는 호스트·세션·시각만 둔다. pid·자식 프로세스 확인이 없다 |
| 지속 이벤트·재연결 복구가 없다 | 맞다 — 상태는 스냅샷(`status --json`)뿐이고 순번 있는 이벤트 기록이 없었다 |
| 위임 판단을 받는 정식 계약이 없다 | 맞다 — 동의 적용(`applyLocked`)은 관찰된 사람 응답(`observed`) 또는 TTY 만 받았다 |
| 실제 Claude 비대화형 실행이 질문 도구·권한·승인에서 막혔다 | master-agent 의 실측 기록대로다 — 질문 도구가 없는 print 세션에서 동의를 물을 수 없었다 |
| 실행 중 취소·미반환 프로세스 정리·제어권 인계가 없다 | 맞다 |

## 구분

기존 상태 조회(`stateView`)·임대 판정(`lease.ts`)·동의 적용 함수(`consent.ts` `applyLocked`)·질문 문서 형식(`answers.ts`)·커밋 내 영수증(`consentReceipts.ts`)·hook 판정·SessionStart 주입·검증 기록과 git 은 그대로 재사용하고, 연동은 `src/agent/master/`의 새 모듈(계약·기록·요청 처리·실행 감독·진척 관찰·결과 근거·위임 판단·인계·실행 세션 가드·사람의 TTY 명령)로 더했다. 모듈별 역할은 [흐름도](../process-flow.md) §9 모듈 지도에 있다.

### 수정한 기존 공통 로직 — 이유·범위·영향

| 파일 | 변경 | 이유 | 적용 범위 | 기존 동작 영향 |
|---|---|---|---|---|
| `consent.ts` | 통로 `master-delegation`, 기록의 `delegation`, `decideDelegatedConsent`·`delegationView`, `applyLocked`의 위임 갈래 | 위임 판단도 사람 응답과 같은 적용 함수(스냅샷 대조·폐기·적용)로 검증하고, 사람 응답과 구분해 남기기 위해 | master `decide` 요청만 부른다 | 사람 경로의 조건(관찰된 응답·준비 세션 일치·TTY)은 그대로다. 위임 갈래는 그 판단을 남긴 호출만 적용하고 사람 응답이 섞인 기록은 받지 않는다 |
| `consent.ts` `SNAPSHOT_EXCLUDED` | `.code-agent/master` 추가 | 동의 준비 뒤 쌓이는 연동 기록(이벤트·실행)이 확인 대상 변경으로 잡혀 동의를 폐기하지 않게 | 연동 기록 폴더 | 연동하지 않은 프로젝트에는 그 폴더가 없다 |
| `core/approval.ts` | `PresenceChannel`에 `master-delegation` | 원장에 위임 통로를 남기려고 | 위임 적용 | 사람 통로 값은 그대로, 위임은 `verified false` |
| `consentReceipts.ts` | 영수증의 `delegation` | 반영 커밋 영수증에서 위임과 사람 응답을 가르려고 | 위임 반영 | 필드가 없으면 기존 형식 그대로 |
| `answers.ts` | 위임 답(delegated)·전달된 사람 답(relayed) 출처 행 | 질문 문서에서 관찰된 사람 답과 구분하려고 | master `answer` 요청 | 기존 답·검증 판정 그대로 |
| `hook.ts` | `decideTool` 맨 앞 `masterRunGuard`, 세션 밖 셸의 `code-agent master` 거부 | 사람이 없는 실행에서 질문 도구·임대 탈취·제어 명령을 막고 정지 요청을 따르게 | 가드는 `CODE_AGENT_MASTER_RUN` 환경과 그 실행 기록이 있을 때만 | 표지가 없는 세션은 가드가 아무것도 하지 않는다(시험으로 확인). 거부되는 셸 명령은 `code-agent master`뿐 |
| `sessionHook.ts` | master 실행 세션에 규칙 줄 | 실행 세션이 처음부터 규칙을 알게 | master 실행 세션만 | 그 밖의 세션은 그대로 |
| `cliMain.ts` | `master` 명령 | 사람의 TTY 명령과 러너의 `master call` | 새 명령 | 기존 명령 그대로 |
| `cliMain.ts` `status` | `--session` 이 없으면 master 실행 기록의 세션을 쓴다 | 실제 AI 시험에서 실행 세션이 자기 임대를 다른 세션의 것(`ownership-conflict`)으로 읽고 멈췄다 | `CODE_AGENT_MASTER_RUN` 표지와 그 실행 기록이 있을 때 `--session` 없이 부른 `status --json` | 표지가 없으면 출력이 그대로다(`self` 없음 — 시험으로 확인). 명시한 `--session`이 앞선다 |
| `stateView.ts` | `hideGitWindowInThisProcess()` — 부른 프로세스만 상태 조회의 git 을 창 없이(`windowsHide`) 띄운다. 감독(`supervise`)이 시작할 때 부른다 | Windows 에서 콘솔 없이(detached) 띄운 감독은 git 을 띄울 때마다 콘솔을 새로 할당해 상태 조회 한 번이 약 4초 걸렸다. 그동안 이벤트 루프가 막혀 호스트에 프롬프트를 넘기지 못하고(가짜 호스트 실행 한 건 20초) heartbeat 도 멈췄다 | 감독 프로세스 | CLI·hook 의 `status`는 그대로다 — 콘솔이 있는 프로세스에서는 창 없이 띄우는 쪽이 git 한 번에 약 10ms 느려 켜지 않는다 |
| `runtimeSelect.ts` `STATE_SCHEMA` | 1 → 2 | 승인·답 기록 형식(위임 필드·통로)이 늘었다 — 개발 지침의 규칙 | 릴리스 선택 | 이 릴리스를 적용한 프로젝트에는 세대 1 릴리스를 다시 적용하지 않는다(되돌리기 불가). 연동을 켜지 않은 프로젝트도 이 릴리스를 적용하면 같다 |

### 기존 독립 실행에 영향이 없게 하는 적용 조건

연동은 사람이 TTY 에서 켠 프로젝트에만(켜기 전에는 `hello`만 답하고 나머지는 `not-enabled`), hook 가드는 감독이 넣은 실행 표지와 그 실행 기록이 함께 있을 때만, 위임은 사람이 준 권한 안에서 master 실행이 준비한 확인 요청에만 적용한다. 세부 조건은 [master 연동](../master-control.md) §1·§8·§11에 있다.

## 설계 결정

- **전송은 같은 PC 의 CLI 한 번이 요청 한 건이다**(`code-agent master call`, stdin JSON → stdout JSON). 서버·데몬·원격 인프라는 두지 않는다.
- **원자적 접수.** 프로젝트 잠금 안에서 소유·세대·인계 상태·기대 상태 버전·작업 연결·임대·실행 중인 실행을 대조하고 실행 기록과 명령 기록을 함께 남긴 뒤 감독 프로세스를 띄운다. commandId 재전송은 기록된 응답을 돌려주고, 같은 ID 다른 내용은 `conflict`, 처리 도중 끊긴 명령(`received`)은 다시 실행하지 않는다.
- **생존과 정지.** 감독 프로세스는 분리해 띄우고(Windows 는 부모 종료와 함께 끝나지 않게) 호스트 pid·표지를 남긴다. 정지는 hook 을 통한 협력 정지가 먼저이고, 유예가 지나거나 강제 요청이면 같은 표지로 확인된 프로세스만 끝낸다. 재조정은 실제 프로세스를 대조해 확인되지 않으면 `unknown`·`orphaned`·`abandoned`로 남기고 다시 실행하거나 성공으로 처리하지 않는다.
- **이벤트.** 기록 ID 안에서 1씩 오르는 순번. 기록 ID 가 다르거나 구간이 비면 gap 을 알려 스냅샷으로 다시 맞추게 한다. 연결(heartbeat)·프로세스 생존·업무 진척을 따로 보고하고, 연결 끊김은 정책(`onMasterDisconnect`)으로만 다룬다.
- **위임 판단.** master 가 판단 ID·분류·이유·근거를 먼저 남기고 보낸다. code-agent 는 권한·준비 세션·보여 준 내용의 해시·상태 버전·중복을 확인하고 같은 적용 함수로 적용하며, 원장·동의·영수증·질문 문서에 `master-delegation`(사람 응답 아님)으로 남긴다. 사람 승인 파일이나 사람 응답 기록을 만들지 않는다.
- **제어권 인계.** requested → stopping → stopped → transferred → accepted. 정지가 확인돼야 세대를 올려 넘기고, 이전 세대의 요청은 `fenced`, 인수 전 새 제어자의 실행·판단은 `handover-unaccepted`다. heartbeat 만료만으로 넘기지 않는다. 사람의 강제 인계는 확인된 프로세스를 끝낸 뒤에만 넘긴다.
- **결과 근거.** 모델의 완료 발언은 결과로 쓰지 않는다 — 종료 코드·결과 줄·권한 거부·상태 전후·변경 파일·커밋·검증 기록을 낸다. master 의 독립 검증과 전체 완료 판정은 master 가 한다.

## 검증

### 모의 시험(code-agent)

- `master.test.ts` 21개 — 연동 조건(꺼진 프로젝트의 hello·not-enabled·`status --json` 불변), 프로토콜·미지원 명시, 동의 동작 분류와 계약 문서 대조, 토큰·제어자·세대, 연결만으로는 권한 없음, 넓은 권한 거부, 멱등·충돌·끊긴 명령, 이벤트 순번·gap, 위임 승인(같은 적용 함수·`master-delegation` 기록)·거부(범위 밖·critical·ambiguous 승인·중복·해시 불일치·회수·사람만 동작)·사람 세션 동의 제외·`requireVerifiedApproval`·수정 요청(지시 전문 보존)과 그 뒤 동의를 준비한 세션만의 이어 실행 접수(다른 세션·사람의 수정 요청은 거부), 업무 질문의 delegated·relayed, 인계 전이와 도중 끊김, hook 가드(표지 없는 세션 불변), 실행 세션의 `status --json` 세션 기본값.
- `masterRuns.test.ts` 8개 — 가짜 호스트(`masterFakeHost.ts`, 실제 모델 아님)로 접수 → 감독 → 결과, 재전송, 실패 판정, busy·재조정·협력 정지·재개, 강제 종료, 감독 사망·orphaned·abandoned 재조정, 연결 끊김 정책.
- 전체 `npm test` — 1,549개 중 1,545개 통과, 실패 0, 생략 4(플랫폼 조건). 작업 트리 사본에서 돌렸다(실제 AI 시험이 빌드 산출물을 쓰는 동안 시작했다). 감독 수정(`hideGitWindowInThisProcess`) 전에는 실제 AI 시험이 끝난 뒤에도 감독을 실제로 띄우는 시험 7개(`masterRuns` 6·`master` 1)가 30초 기다림을 넘겨 실패했다 — 감독 안의 상태 조회가 git 마다 콘솔을 할당해 한 번에 약 4초 걸렸고, 가짜 호스트 실행 한 건이 20초였다. 고친 뒤 한 건 0.8초, `masterRuns` 8개 9.6초(이전 약 3분)이고 전체가 통과했다. `runtimeRelease.test.ts`의 가짜 릴리스는 세대를 `STATE_SCHEMA`에서 읽게 고쳤다(세대를 올린 데 따른 시험 갱신).

### master-agent 연동 시험

- `tests/control.test.mjs` 20개 — 통신 계약을 흉내 낸 전송과 가짜 판단기(모의): 두 프로젝트 위임 → 독립 검증 → 위임 반영 → 인계 → 통합 완료, 판단 기록 선행, 사람 이관 조건, 검증 전 반영 판단 금지, 위임 영수증 결합, 재부착 중복 없음, commandId 충돌·이벤트 재동기화, 정지 대상 제한, 독립 프로젝트 진행과 의존 작업 대기. 실제 AI 시험에서 찾은 결함의 회귀(아래 run2~run6 표의 master 조치)도 본다. 그중 일곱(원자료 `tests.masterAgent.regressionCheck`)은 수정을 되돌리면 실패하는 것을 확인했다. `tests/engine.test.mjs`에 다른 CLI 가 쓰는 동안의 DB 잠금 대기 시험을 더했다.
- `tests/code-agent-control.test.mjs` 1개 — 실제 code-agent CLI(빌드 산출물)와 가짜 호스트: 연결, 원자적 접수, 재전송·충돌, 이벤트 커서, 결과, 재부착, 협력 정지, 제어권 인계·이전 소유자 거부·인수.
- master-agent 전체 155개 통과(기존 126개와 같은 시기 다른 작업의 LangGraph 전환 시험 7개 포함), 구문 60개·문서 19개 검사 통과. LangGraph 전환 기록에 남은 `code-agent-control.test.mjs` 실패(협력 정지 대기 초과)는 위의 감독 지연이 원인이었고, 감독 수정 뒤 약 9초에 통과한다. `code-agent-control.test.mjs`는 끝 상태 뒤 이벤트를 한 번 더 받게 고치기 전 전체 실행 4회 중 2회 실패했고(마지막 `run.finished` 누락), 고친 뒤 3회 연속 통과했다.

### 실제 AI 전체 사이클

조건: Windows, Node 24.19.0, Claude CLI 2.1.300(`claude -p`, 모델은 CLI 기본값). 임시 git 프로젝트 둘(price-core·invoice-app)에 code-agent 를 설치하고 master-agent 의 `mission drive --control --provider claude`로 돌렸다 — 개발 세션과 master 의 위임 판단기 모두 실제 Claude 다. 작업은 할인 함수(price-core)·합계 함수(invoice-app)를 독립으로 구현하고 결제 합계(invoice-app)로 통합하는 셋이며, 완료 판정은 프로젝트 밖 독립 검사 스크립트와 프로젝트 테스트로 한다.

사람의 TTY 단계 셋(공통 문서 확정·`master enable`·`master grant`)은 시험 하네스가 흉내 냈다(`withInteraction` — 기록에 '사람 TTY 흉내(실제 사람 확인 아님)'). 작업별 확인 요청(요구 확정·계획 승인·반영)과 업무 질문은 흉내 내지 않았다 — master 의 위임 판단이나 사람 이관으로만 처리된다. 사람 이관을 사람 역할로 답한 경우는 따로 적는다.

**요약.** run6 에서 두 프로젝트의 구현 → 검증 → 인계 → 통합 → 임무 완료까지 실제 AI 로 끝났다. 모델의 완료 발언이 아니라 master 의 독립 검사(종료 코드)와 code-agent 의 검증·통합 기록, 반영 커밋으로 완료를 판정했다. 앞선 시험은 결함이나 시험 시나리오 문제로 멈췄고(완료 아님), 찾은 것을 고친 뒤 처음부터 다시 돌렸다.

| 시험 | 결과 | 드러난 것 → 조치 |
|---|---|---|
| run2 | 완료 아님 — 두 작업이 사람 이관에서 멈춤 | 결함 다섯(실행 프롬프트의 기대 상태 재대조·끝 상태 뒤 이벤트·DB 잠금 대기·반영 판단의 문서 후보·독립 검사가 수락 기준으로 옮겨짐) → 수정, 예방 하나(선행 반영 커밋 기준) |
| 정지 시험 | 실제 Claude 실행의 협력 정지·같은 세션 재개·실행 중 인계·강제 취소 확인 | — |
| run3 | 완료 아님 — 합계 시도 unknown | 결함 셋(리뷰 단계 독립 검증·위임 수정 요청 뒤 이어 가기와 지시 300자 잘림·이어 실행 거부 기록) → 수정 |
| run4 | 완료 아님 — 독립 작업 둘 완료, 통합 작업 접수 거부 | 결함 둘(검증된 시도의 반영 확인 수정 요청·선행 증거 전체를 실은 프롬프트) → 수정 |
| run5 | 완료 아님 — 통합 작업이 critical 사람 이관 | 시험 시나리오(형제 저장소 상대 경로가 깨끗한 worktree 에서 풀리지 않음) → 도입 설정 `prepare`로 바로잡음 |
| run6 | **임무 완료** — 위임 판단 10건 routine, 사람 이관 2건(ambiguous)은 이 대화의 사용자가 고른 답을 전달 | 판단 자료에 같은 작업의 앞선 답이 빠짐 → 수정(모의 시험으로 확인) |

#### run2 — 결함 찾기

| 지점 | 관찰 | 원인 | 조치 |
|---|---|---|---|
| 첫 계속 실행 | 위임 승인 뒤 이어 간 세션이 아무것도 하지 않고 "상태가 다르다"고 보고하고 끝났다(두 프로젝트 모두) | master 실행 프롬프트가 세션에 기대 상태 재대조를 시켰다 — 실행이 시작되면 세션 임대·hook 기록으로 상태 버전이 바뀐다. 세션의 `status --json`은 `--session`이 없어 자기 임대를 다른 세션의 것(`ownership-conflict`)으로 읽었다 | code-agent: 실행 세션의 `status --json` 세션 기본값. master: 통신 계약 실행 프롬프트에서 재대조 제거 |
| 시험 | `code-agent-control.test.mjs` 간헐 실패 | 끝 상태는 실행 기록에 먼저 남고 `run.finished` 이벤트가 뒤따르는데, master 가 끝 상태를 보고 바로 반환했다 | master: 끝 상태 뒤 한 번 더 이벤트를 받는다 |
| 운영 | drive 가 실행을 따라가는 동안 `mission relay`를 부르면 같은 DB 쓰기가 `database is locked`로 바로 실패할 수 있었다 | SQLite 잠금 대기 시간이 0 | master: 잠금 대기 5초 |
| price-core 반영 판단 | 판단기가 반영을 critical 로 사람에게 넘겼다 — "지식 문서(`features.md`·`business-rules.md`)까지 커밋된다" | master 는 문서 변경 후보를 늘 '유지'로 보내는데 판단기 입력에 그 사실이 없었다 | master: 판단 입력·프롬프트에 '후보는 적용하지 않는다' 명시 |
| 업무 질문 3건 | price-core Q1·invoice-app Q2 가 critical 로 사람에게 넘어갔다(Q1 은 운영자가 사람 역할로 답했다) | master 의 독립 검사·변경 범위 제약이 code-agent 요구·수락 기준·TC 로 옮겨져, 실행할 수 없는 TC 때문에 계획·검증 게이트가 막혔다 | master: 배정 프롬프트에 "독립 검사·범위 제약은 master 가 반영 뒤 확인 — 수락 기준·TC 로 옮기지 않는다" |
| 통합 준비(예방) | — | 같은 프로젝트의 선행 작업(total)은 작업 브랜치에 반영되므로, 통합 작업이 기본 기준 브랜치에서 시작하면 선행 산출물이 빠진다 | master: 선행 반영 커밋을 `codeAgentBase`로 알려 접수의 `--base`로 쓴다 |

run2 에서 실제로 확인된 것: 확인 요청 위임 승인·업무 질문 위임 답(routine, 근거 목록과 이유를 먼저 기록), critical 이관(사람에게 넘긴 뒤 다시 판단하지 않음), master 재시작 뒤 재부착 1회(새 실행 없이 끝난 실행의 결과를 기록), price-core 의 위임 계획 승인부터 master 독립 검증 통과까지. 운영자 개입은 결함 1 때문의 `mission continue` 2회와 사람 역할의 `mission relay` 1회다. run2 는 두 작업이 사람 이관에서 멈춘 채로 끝냈다(완료 아님).

#### 실제 Claude 실행의 정지·재개·인계·강제 취소

별도 임시 프로젝트(stop-demo)에서 master-agent 의 `ControlHost`·`requestControlHandover`·`acceptControl`로 실제 Claude 실행을 제어했다(연동 켜기·제어자 둘 등록은 사람 TTY 흉내). 실행은 문서 여섯 개를 읽어 요약하는 읽기 작업이다.

| 단계 | 결과 |
|---|---|
| 협력 정지(pause) | 요청 응답은 `requested: true`·`stopped: false`(접수와 정지를 가른다). 12초 뒤 `paused` — `cooperative: true`·`forced: false`, hook 이 도구 1회를 막았고 호스트 종료 코드 0, 호스트·감독 프로세스 종료 확인, 변경 파일 없음 |
| 같은 세션 재개(continue) | 정지된 세션 ID 로 새 실행 접수·시작(`sameSession: true`) |
| 실행 중 제어권 인계 m1 → m2 | 인계 요청이 실행을 협력 정지로 멈추고(`paused`, 사유 '제어권 인계') 끝난 것을 확인한 뒤 이전(`transferred`). 이전 소유자 m1 의 접수와 인수 전 m2 의 접수는 둘 다 `control-fenced`로 거부, m2 인수 뒤 세대 2 |
| 강제 취소(cancel --force) | 새 소유자 m2 의 실행을 강제 취소 — `cancelled`·`forced: true`·`cooperative: false`, 호스트·감독 프로세스 종료 확인, 작업 트리·HEAD 그대로 |
| 끝 | 실행 중인 실행 0, 최근 실행 `paused`·`paused`·`cancelled` |

#### run3 — 수정 뒤 처음부터

price-core 할인 작업은 사람 개입 없이 요구 확정·계획 위임 승인(routine) → 구현·code-agent 검증 → 반영 단계 master 독립 검증 → 반영 위임 승인 → 반영 커밋 → 인계까지 갔다. 승인 원장의 presence 문구는 "master 위임 판단 … · 분류 routine · 사람 응답 아님"이다.

invoice-app 합계 작업에서 결함 셋이 차례로 드러났다(운영자는 고친 뒤 drive 를 다시 시작만 했다 — 사람 판단·답 대행 없음).

| 지점 | 관찰 | 원인 | 조치 |
|---|---|---|---|
| 리뷰 2회차 질문 | code-agent 리뷰가 "희소 배열 검사를 단언하는 TC 가 없다"는 지적과 질문(재계획으로 TC 추가 / 지적 기각 / 보류)을 냈다. master 판단기는 routine 으로 "재계획으로 TC 추가"를 답했다(기각은 완료 조건을 약하게 하고 사용자 사유가 필요하므로 위임 범위 밖이라는 이유). 그 직후 master 가 리뷰 단계에서 독립 검증을 해 시도가 `verified`가 됐고, 이어 갈 길이 없어 인계 대기(`handoff-pending`)로 drive 가 멈췄다 | master 는 code-agent check·test 통과만 보고 독립 검증했다 — 리뷰·통합이 남아 있어도 | master: 통신 계약에서는 반영 단계에서만 독립 검증, 반영 단계를 떠난 검증된 시도는 같은 세션을 이어 간다 |
| 다시 낸 계획 | 세션이 계획으로 되감아 TC 를 더한 계획을 다시 냈다. 판단기는 ambiguous 로 수정 요청을 보냈다 — "설계 문서의 가정('TC 는 두지 않는다')이 새 TC 와 어긋나고 새 TC 의 수락 기준 연결이 없다"(정상 동작). drive 는 `reapproval-required`에서 멈췄다 | code-agent 는 다시 받을 계획 확인을 사람 몫으로 보이는데 master 는 `ready`일 때만 이어 갔다. 수정 지시도 code-agent 실패 기록·master 메모 모두 앞 300자로 잘려 세션이 무엇을 고칠지 알 수 없었다 | master: 위임 수정 요청 회차는 같은 세션을 이어 가고 지시 전문을 프롬프트에 넣는다. code-agent: 위임 수정 요청의 이유 전문(2000자 이하)을 실패 기록에 남긴다 |
| 이어 실행 접수 | master 의 이어 실행을 code-agent 가 `invalid-state`(재개 판정 `reapproval-required: plan-consent`)로 거부했고, master 는 시도를 unknown 으로 남겼다(자동 재실행 없음) | code-agent 접수 검사는 사람 몫 재개 판정에서 시작하지 않는다. master 는 응답으로 확인된 거부도 미확인으로 기록했다 | code-agent: 같은 동작의 마지막 동의가 위임 수정 요청이면 그 동의를 준비한 세션의 이어 실행만 받는다(사람의 수정 요청·다른 세션은 그대로 거부). master: 이어 실행의 응답 거부는 실행되지 않은 것이 확인된 막힘으로 남긴다 |

run3 은 invoice-app 합계 시도가 unknown 인 채로 멈췄다(완료 아님, 결제 합계 통합 작업은 배정되지 않았다). 미확인 기록을 손으로 고쳐 잇지 않고 run4 를 처음부터 돌렸다.

#### run4 — 세 결함 수정 뒤 처음부터

독립 작업 둘이 끝났다. invoice-app 합계는 사람 개입 없이 요구 확정·계획·반영 위임 승인(모두 routine) → 반영 단계 독립 검증 → 반영 커밋 → 인계까지 약 13분에 갔다. price-core 할인에서는 판단기가 반영 확인을 ambiguous 로 보고 수정 요청을 보냈다 — 반영 요약의 목록(27개)이 master 가 검증한 변경 경로(25개)와 다르고(요약이 이미 커밋된 도입 설정 파일 둘을 목록에 넣었다), 영향 표의 지식 문서 문구가 실제 변경과 맞지 않는다는 이유다. 결함 둘이 더 드러났다.

| 지점 | 관찰 | 원인 | 조치 |
|---|---|---|---|
| 반영 확인 수정 요청 | 검증된 시도의 반영 확인이 위임 수정 요청을 받자 master 가 인계 대기(`handoff-pending`)로만 보고, 독립 작업(합계)을 끝낸 뒤 drive 가 멈췄다 | 위임 수정 요청 뒤 이어 가기가 `verified` 시도에는 없었다 | master: 반영 확인이 위임 수정 요청을 받으면 검증된 시도도 같은 세션을 이어 가고, 다시 준비한 반영 확인을 판단하기 전에 다시 검증한다. drive 재시작 뒤 세션이 반영 확인을 고쳐 다시 준비했고(커밋 대상 26개) → 재검증 → 위임 반영 승인 → 반영 커밋 → 인계 |
| 통합 작업 접수 | 결제 합계(checkout) 접수를 code-agent 가 `invalid-request`(프롬프트는 1~20000자)로 거부했다. 세션이 없는 첫 실행이라 master 는 시도를 unknown 으로 남겼다(자동 재실행 없음) | master 프롬프트가 선행 증거 둘을 통째로(파일 트리 스냅샷 각 약 14KB·원격 상태·검사 출력) 실었다 | master: 통신 계약 프롬프트는 선행 증거 요약(작업·프로젝트·검사 결과·산출물 해시·반영 커밋)만 싣는다(직접 실행 호스트는 그대로) |

독립 검증 셋은 모두 반영 단계에서 돌았다. 운영자 개입은 결함 수정 뒤 drive 재시작 1회다. 통합 작업은 시작하지 못했다(완료 아님).

#### run5 — run4 의 결함 둘 수정 뒤 처음부터

운영자 개입 없이 독립 작업 둘이 끝나고 통합 작업이 시작됐다.

- 독립 작업 둘(price-core 할인·invoice-app 합계)은 위임 승인(모두 routine)과 반영 단계 독립 검증을 거쳐 반영 커밋·인계까지 갔다. invoice-app 합계에서는 계획 단계 critic 의 차단 지적(합계에서 한 번만 반올림하는 규칙을 가려내는 수락 기준·TC 가 없다)으로 세션이 연 되감기 질문에 판단기가 routine 으로 추천안을 답했다(답 출처 `master 위임 <판단 ID>`).
- 결제 합계(checkout): 선행 증거 요약 프롬프트로 접수됐다(run4 의 접수 거부가 사라졌다). 요구 확정·계획 위임 승인 뒤 구현·code-agent 검증(TC 9/9)·리뷰(지적 0)까지 통과했다. 그런데 `code-agent integrate` 1회차가 `Cannot find module '../../price-core/src/discount.js'`로 실패했다. 세션은 통합 검증 처리 질문을 열었다 — 선택지는 code-agent.json 에 prepare 추가(배정 제외 파일·계획 재승인 필요) / 요구 변경 / 보류였다. 판단기는 이를 critical 로 분류해 사람에게 넘겼다. 이유는 "어느 선택지도 위임 범위(제외 파일·요구·완료 조건)를 넘는다"였고, drive 는 `checkout:human-question:Q1` 막힘으로 끝났다.

원인은 시험 시나리오에 있었다. 통합 요구가 형제 저장소를 상대 경로(`../../price-core`)로 가져오게 고정했는데, code-agent 통합 검증은 기준 커밋을 뜬 깨끗한 worktree(`%TEMP%` 아래)에서 돌아 그 경로가 풀리지 않는다. 프로젝트 사이 의존을 깨끗한 트리에 잇는 자리는 매니페스트의 `prepare`(사람이 정하는 도입 설정)다. 작업 중에 배정 제외 파일을 바꿀 일이 아니라는 판단기의 결론이 맞다. code-agent·master 코드의 결함은 아니다. 사람 이관 질문에는 답하지 않고 시나리오를 고쳐 run6 을 돌렸다.

#### run6 — 통합 의존을 도입 설정으로 바로잡은 시나리오

시나리오 변경(시험 하네스 `setup.mjs`, 사람이 미리 정하는 도입 설정): invoice-app 에 `scripts/link-price-core.cjs`·`.gitignore`의 `node_modules/`·code-agent.json `prepare: ["node", "scripts/link-price-core.cjs"]`를 도입 커밋에 넣었다. 작업 트리에서는 `node_modules/price-core`를 형제 저장소에 junction 으로 잇는다. 통합 검증 worktree 에서는 prepare 가 price-core 의 `src`를 복사한다 — worktree 안의 junction 은 `git worktree remove --force` 뒤 빈 디렉터리를 남겨 쓰지 않았다(대상은 지워지지 않는 것을 확인했다). 통합 요구는 `require("price-core/src/discount.js")`로 가져오고, 배정 제외에 연결 스크립트와 `.gitignore`를 더했다. 독립 검사 스크립트는 그대로다.

**결과: 임무 완료(`succeeded`, "현재 계획의 모든 작업이 독립 검증과 로컬 산출물 인계를 마쳤습니다").** 두 프로젝트의 구현 → 검증 → 인계 → 통합까지 실제 AI 로 끝났다(약 75분). master drive 는 같은 시기 다른 작업이 LangGraph 로 옮긴 판이었다(통신 계약 분기는 그대로 옮겨져 있다).

- price-core 할인(약 51분): 요구 확정은 위임 승인(routine)으로 처리됐다.
  - 계획 검토(critic)가 "숫자가 아닌 입력도 범위 밖인가"를 물었다(Q1). 판단기는 목표에 정해지지 않은 해석이라며 ambiguous 로 사람에게 넘겼다.
  - 사람(이 대화의 사용자)이 "RangeError + TC 추가"를 골랐고, 운영자가 `mission relay`(actor human)로 전달했다.
  - 세션이 그 답에 맞추려면 analysis 로 되감아야 한다는 질문(Q2)과 ±Infinity 처리 질문(Q3)을 열었다. Q3 은 판단기가 routine 으로 "유한한 숫자만 허용"을 답했다.
  - Q2 는 판단기가 "Q1 답의 실제 내용을 판단 자료에서 볼 수 없다"며 ambiguous 로 넘겼다. 사람이 "analysis 로 되감아 진행"을 골라 전달했다.
  - 세션이 되감아 문서·계획을 다시 쓰고 계획 위임 승인 → 구현·검증·리뷰·통합 → 반영 단계 독립 검증 → 반영 위임 승인 → 반영 커밋 `3237eb2` → 인계로 갔다.
- invoice-app 합계: 할인이 사람 답을 기다리는 동안 먼저 진행됐다(독립 프로젝트 진행). 요구 확정·계획·반영 위임 승인 → 반영 단계 독립 검증 → 반영 커밋 `57c161d` → 인계.
- 결제 합계(checkout, 두 작업에 의존): 둘이 끝난 뒤에야 배정됐다. 요구 확정·계획 위임 승인 → 구현·code-agent 검증·리뷰 → `code-agent integrate` 1회차가 깨끗한 worktree 에서 prepare·build·test 모두 통과 → 반영 단계 독립 검사 넷(`checkout-independent`·`discount-recheck`·`total-recheck`·`checkout-project-tests`, 모두 종료 코드 0) → 반영 위임 승인 → 반영 커밋 `67e968a`(제품 파일 `src/checkout.js`·`tests/checkout.test.js` — `require("price-core/src/discount.js")`) → 인계 → 임무 완료.
- 기록: 반영 커밋 셋의 동의 영수증(요구·계획·반영)은 모두 `master-delegation`·`observed: []`·판단 ID 있음이다. 질문 문서에서 Q1·Q2 는 `[Source]: master 전달 <판단 ID>`(사람 답), Q3 은 `[Source]: master 위임 <판단 ID>`(위임 판단)로 갈렸다. code-agent 판단 원장에도 actor human·ai 가 갈려 있다. 통합 검증 임시 worktree 는 남지 않았다.
- 위임 판단 10건(요구 확정 3·계획 3·반영 3·업무 질문 1, 모두 routine), 사람 이관 2건(모두 ambiguous, 사람 답 전달로 해소), critical 0건. 운영자 개입은 사용자 답 전달 2회(`operator.log`)이고 drive 재시작은 없다.

결함 하나가 더 드러났다. 업무 질문 판단 자료에 그 질문만 실리고, 같은 작업에서 이미 답한 질문이 빠졌다. 앞 답을 전제로 묻는 Q2 를 판단기가 자료 부족으로 사람에게 넘긴 원인이다. master 가 판단 자료에 같은 작업의 이미 답한 질문(답과 출처)을 싣도록 고쳤다 — 모의 시험으로 확인했고(수정을 되돌리면 실패), 실제 AI 로는 다시 돌리지 않았다. code-agent 의 질문 조회(`questions`)는 이미 답과 출처를 내고 있어 code-agent 변경은 없다.

## 남은 범위

- 실제 Codex(개발 호스트·위임 판단기)와 다중 사용자·원격 운영은 검증하지 않았다. 호스트는 Claude Code 비대화형 실행만이다 → 이후 더한 Codex 관리 실행의 실제 모델 확인은 [Git 실행 권한](2026-10-20-codex-git-permission.md)·[실행 준비](2026-10-22-codex-readiness.md)·[셸 꼴 보완](2026-10-23-codex-git-wrapper.md) 기록에서 감독의 턴 시작과 단건 권한 뒤 `code-agent start`(작업 시작) 실행까지만 했다.
- 사람이 code-agent 대화형 세션에서 직접 답하는 경로는 실제 AI 시험에서 쓰지 않았다. 사람 답은 master 의 전달(`mission relay`)로만 넣었다.
- run6 에서 찾은 master 결함(판단 자료에 같은 작업의 앞선 답이 빠짐)의 수정은 모의 시험으로만 확인했다.
- 통신 계약의 첫 실행(start) 접수가 거부되면 master 는 시도를 unknown 으로 남긴다. 자동 재실행하지 않고 운영자가 원인을 본다.
- 프로젝트 사이 의존은 각 프로젝트의 `prepare`로 사람이 미리 잇는다([master 연동](../master-control.md) §14).
- 실제 AI 시험은 작은 임시 프로젝트 둘의 작업 셋이다. 판단기의 판단 품질을 다양한 업무에서 본 것은 아니다.
