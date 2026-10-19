# 대시보드 질문·동의 연동

code-agent는 초기 설정부터 운영까지의 질문을 `.code-agent/interactions/`에 저장하고 기존 로컬 CLI JSON API로 조회·응답·결과를 제공한다. HTTP 서버와 화면은 master-agent의 책임이다. [master 통신 계약](master-control.md)의 인증·소유권·프로세스 검사와 기존 단계별 검사·승인은 유지한다.

## 연결과 신뢰

Node 24.19.0 이상 24.x, 이 기능을 포함한 빌드와 해당 프로젝트의 hook 설치·신뢰가 필요하다. 최초 연결은 프로젝트 폴더에서 **사용자가 직접 TTY**로 실행한다. 문서 확정·작업 ID·master 목표는 없어도 된다.

```powershell
code-agent master enable --controller dashboard --token-out C:/Users/<사용자>/.code-agent/dashboard-controller.token
code-agent master human enable --controller dashboard
```

두 번째 명령은 `channelId`, `generation`, `keyPath`, `expiresAt`, `algorithm: Ed25519`를 반환한다. 토큰과 개인 키 파일은 대시보드 **서버만** 읽는다. 저장소·모델 프롬프트·브라우저·로그에 넣지 않는다. binding에는 공개 키만 저장한다. 서버는 로그인·Host/Origin·CSRF 검사와 명시적 사용자 제출을 확인한 다음 서명해야 한다. 서명은 등록한 서버의 제출을 증명한다. 서버가 사람 대신 자동 제출하면 사람이라는 사실을 독립적으로 증명할 수 없으므로 AI 실행 경로에 서명 기능을 노출하면 안 된다. OS 계정 자체를 격리하는 보안 경계는 아니다.

`code-agent master human disable --controller dashboard`는 별도 사람 채널을 폐기한다. 소유 세대 변경·인계 중·연동 해제·채널 만료(30일)는 이전 응답과 적용을 막는다. 재등록은 새 키·채널을 만든다. 이전 개인 키 파일은 자동 삭제하지 않지만 이전 서명은 받지 않는다. 네트워크 일시 단절은 답·승인·취소가 아니다. `master disable`과 UI 등록 해제는 서로 다른 동작이다.

최소 지원 여부는 패키지 버전 문자열 대신 `hello.result.codeAgent.stateSchema >= 7`과 `hello.result.interactions.schemaVersion === 1` 및 명령 목록으로 확인한다. 기존 연결 토큰·`answer actor:human`·AI grant만으로 `interaction.respond`를 호출할 수 없다.

## 전송과 실제 호출 예제

등록 프로젝트를 서버가 선택하고 그 폴더를 `cwd`로 하여 `node C:/IdeaProjects/code-agent/dist/agent/cli.js master call`을 실행한다. stdin 요청 한 건, stdout JSON 응답 한 건이다. `ok:false`도 stdout을 읽어 처리한다(프로세스 종료 코드 1). 프로젝트 경로·명령을 브라우저 입력으로 받지 않는다. 아래 Node 예제는 서버에서 사용하는 계약이며 개인 키 경로·프로젝트·실행 파일은 서버 설정으로 고정한다.

```js
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { sign, randomUUID } = require('node:crypto');
const cli = 'C:/IdeaProjects/code-agent/dist/agent/cli.js';
const project = 'C:/managed/example'; // 서버가 등록한 프로젝트
const controller = 'dashboard';
const token = readFileSync(process.env.DASHBOARD_CONTROLLER_TOKEN_FILE, 'utf8').trim();
const privateKey = readFileSync(process.env.DASHBOARD_HUMAN_KEY_FILE, 'utf8');
function call(request) {
  const child = spawnSync(process.execPath, [cli, 'master', 'call'], {
    cwd: project, windowsHide: true, encoding: 'utf8',
    input: JSON.stringify({protocol:'code-agent.master', version:1, ...request}),
    maxBuffer: 8 * 1024 * 1024
  });
  if (child.error) throw child.error;
  const envelope = JSON.parse(child.stdout);
  if (!envelope.ok) throw Object.assign(new Error(envelope.error.message), envelope.error);
  return envelope;
}
const hello = call({type:'hello'}).result;
if (hello.interactions?.schemaVersion !== 1) throw new Error('미지원 code-agent');
const generation = hello.ownership.generation;
const auth = {controller, generation, token};
const page = call({...auth, type:'interactions', payload:{after:0, limit:100}}).result;
// 브라우저가 선택한 ID만 사용하되 상세는 서버에서 다시 조회한다.
const selectedId = page.requests.find(r => r.canRespond && r.kind === 'question')?.requestId;
if (!selectedId) throw new Error('응답 가능한 일반 질문 없음');
const item = call({...auth, type:'interaction', payload:{requestId:selectedId}}).result;

// 사용자 제출 직후의 값. 추천/페이지 열람으로 이 함수를 호출하지 않는다.
function makeSubmission(submission, commandId) {
  const request = {...auth, type:'interaction.respond', commandId, payload:{
    requestId:item.requestId, expectedRevision:item.revision, contentHash:item.contentHash,
    challenge:item.challenge, channelId:item.humanChannel.channelId, submission
  }};
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : value !== null && typeof value === 'object'
      ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}'
      : JSON.stringify(value);
  const signed = canonical({domain:'code-agent.dashboard-human.v1', projectId:hello.project.projectId,
    controller, generation, commandId, body:request.payload});
  request.payload.signature = sign(null, Buffer.from(signed), privateKey).toString('base64');
  return request;
}
// 아래 ID/값은 사용자가 실제 선택한 항목으로 바꾼다.
const outgoing = makeSubmission({intent:'submit', explicit:true,
  answers:[{questionId:'method', optionIds:['link'], optionInputs:{link:'doc/architecture.md'}}]
}, randomUUID());
// outgoing을 서버의 영속 전송함에 저장한 다음 보낸다. 재전송은 같은 객체/commandId다.
const receipt = call(outgoing).result;
const result = call({...auth, type:'interaction.result', payload:{requestId:item.requestId}}).result;
// receipt.status === 'responded'는 수신이다. result.application·continuation을 따로 표시한다.
```

비동기 서버 구현에서는 `spawn`과 응답 전송함을 사용하고 동기 `spawnSync` 예제를 HTTP 요청 처리기에 그대로 넣지 않는다. 장시간 연결은 필요 없다. 추천·다중 선택·직접 입력의 JSON 형식은 [발행 지침](../template/claude/skills/ca-answer/dashboard.md), 정본 스키마는 `src/agent/interactionSchema.ts`다. `hello`의 소유자는 `ownership`에 있다.

동의 상세의 `consent.summary` 전문과 모든 변경 후보를 보여 준 뒤 일반 `answers` 대신 다음 제출을 사용한다. `choices` 키는 상세에 나온 `index`이며 **승인 시 모든 후보에** `적용` 또는 `유지`를 명시한다. 기본 승인·생략한 후보의 자동 선택은 없다.

```json
{"intent":"submit","explicit":true,"verdict":"approve","shownHash":"상세의 consent.shownHash","choices":{"1":"적용","2":"유지"}}
```

수정 요청은 `verdict: request-changes`와 같은 전문 해시다. `defer`·`cancel`은 `{"intent":"defer","explicit":true}`처럼 답 없이 보낸다. `defer`는 미해결이며 자동 재개하지 않는다. 다시 열려면 최신 revision으로 `reopen` 후 최신 상세에 응답한다. `cancel`은 해당 요청을 닫으며 작업 전체를 취소하지 않는다. 작업 취소는 기존 `cancel`·`abort` 절차다. 취소한 동의는 원래 승인 대기 색인도 닫으며 원래 호스트에서 재사용하지 않는다.

## 요청·추천·결과 계약

| API | payload | 결과 |
|---|---|---|
| `hello` | 없음, 인증 불필요 | `interactions`: 스키마·단계·소비자·지원 동의·재개 범위 |
| `interactions` | `after`(revision 커서, 기본 0), `limit`(1~200) | `sourceInstanceId`, `cursor`, `latestCursor`, 변경된 요청 전체 상세 `requests` |
| `interaction` | `requestId` | 상세·문맥·추천·응답·결과·`canRespond`·불가 사유 |
| `interaction.respond` | 버전·본문 해시·challenge·사람 채널·서명·submission. envelope에 commandId | 수신 영수증, `applied:false`; 같은 명령 재전송은 캐시 결과 |
| `interaction.result` | `requestId` | 원래 요청의 `response`, `consumed`, `application`, `continuation` |

목록은 해결된 요청도 포함하는 변경 피드다. 마지막 페이지 `cursor`를 저장하고 `cursor < latestCursor`면 다음 페이지를 읽는다. 원장이 바뀌어 `sourceInstanceId`가 달라지면 캐시를 다시 만든다. 원본 키는 프로젝트 ID·sourceInstanceId·requestId이며 업무 번호만으로 합치지 않는다. 다른 프로젝트에 같은 업무 번호가 있어도 답을 복사하지 않는다. 후속 요청은 목록의 다음 변경으로 조회한다. `interaction.result` 자체가 후속 질문을 생성하지 않는다. `status --json`은 읽기 전용 요약을 싣고 master 관찰 이벤트 `interaction.changed`는 변경 커서를 싣는다.

일반 질문은 questionId·single/multiple/text·필수 여부·선택 개수·옵션별 결과·직접 입력 길이를 검사한다. `recommendedOptionIds`, `recommendationReason`, `evidence`, `defaultOptionIds`는 발행자가 제공한다. UI는 추천을 먼저 표시할 수 있으나 순서로 추천을 추정하지 않는다. 추천 없는 질문은 미선택이고, 다중 선택 기본값은 명시된 목록만 사용한다. 필수 답 누락·모르는 옵션·중복 선택·선택하지 않은 옵션의 추가 입력·길이 초과는 거부한다.

`pending → responded → applied`는 수신 후 원래 소비자의 처리 결과까지 구분한다. `response.receiptId`는 실제 제출, `consumed`는 같은 세션의 소비, `application`은 처리 결과다. 일반 host 질문의 `complete`는 호스트가 답의 반영을 보고한 기록이며 작업 전체 완료나 승인 증거가 아니다. 기존 호스트 UI 답의 `application.result.deliveredToHost`는 살아 있는 호스트로 전달됐다는 의미다. 보류·만료 질문을 호스트에서 명시적으로 다시 열면 같은 요청 ID와 새 revision·challenge를 사용하며, 이미 받은 답과 취소는 되살리지 않는다. 업무 완료는 기존 검증·반영 결과로 확인한다. `failed`는 보존한 답과 오류를 먼저 조사하며 무조건 재전송·재적용하지 않는다.

버전·본문·브랜치·HEAD·worktree·작업·준비 세션·채널이 다르면 거부한다. 동일 key·세션·원문의 발행은 동일 요청을 반환한다. 미응답 질문 변경은 기존 요청을 superseded로 남긴다. 이미 수신한 답은 먼저 소비해야 같은 key로 질문을 바꿀 수 있다. 기본 만료는 하루, 발행 시 최대 7일이다. 응답을 수신한 뒤의 적용은 만료 때문에 재질문하지 않지만 문맥·권한을 다시 확인한다. 일반 답을 소비한 뒤 정당한 작업 진행으로 HEAD·작업이 바뀐 경우 complete는 같은 프로젝트·브랜치·소유 세션을 확인해 결과를 받는다.

## 지원 범위와 원래 처리기

| 단계 | 질문 발행·응답 처리 | 동의 |
|---|---|---|
| setup/document | 문서 방식·경로·구성·테스트·품질 기준을 조사한 메인이 구조화해 발행. 기존 docs setup/link/interview·문서 작성 절차로 반영 | setup, docs, baseline |
| request/planning | 접수 질문·업무 규칙·범위·설계 대안. questions.md 연결 또는 원래 호스트 소비 | request, plan |
| implementation/verification/review | 해당 회차의 추가 질문·환경·계획 밖 변경을 발행, 기존 Task·검증·리뷰로 복귀 | 별도 승인 필요 시 기존 plan·judgment 준비 |
| delivery | 변경·충돌 질문, 기존 반영 검사 | deliver |
| recovery | 근거·한도를 포함한 recovery-decision. 답만으로 횟수를 늘리거나 중지를 실행하지 않음 | judgment, repro-log, abort |
| maintenance | 업데이트·모델·플러그인·지식 정리의 선택, 기존 운영 처리기 | update, model, plugin-add, plugin-remove, knowledge-prune |

모든 14개 동의는 공통 서명 검증과 기존 `applyLocked` 처리기를 사용한다. `judgment`의 retry-grant/waive-finding/cross-stop 조건, 검증·권한·동의 스냅샷·Git 검사 등 기존 조건이 그대로 적용된다. 수행 중 원장이 `applying`으로 남으면 실패로 닫는 기존 규칙을 따른다. 독립 설정에 개발 작업을 만들어 붙이지 않는다.

일반 질문은 메인이 `interaction publish <질문.json>`으로 발행하며 세션 티켓이 필요하다. Claude 일반 단일 선택 Pre/Post와 Codex MCP ask도 영속화한다. 구조화된 추천·다중 선택·직접 입력은 publish 또는 MCP ask의 `interaction` 필드를 사용한다. 기존 Markdown 질문은 실제 미응답 Q번호·원문·세션을 확인할 수 있을 때 연결하되, 문구에서 추천을 추정하지 않고 텍스트 입력으로 제공한다. 같은 문서에 명시적으로 발행한 Q번호는 중복 수집하지 않는다.

살아 있는 호스트는 같은 세션에서 consume/complete한다. Codex의 열린 MCP 일반 질문은 대시보드 답을 감지하여 폼 대기를 끝낸다. Claude의 이미 열린 선택창을 외부에서 강제로 닫는 기능은 없으므로 원래 창을 종료하고 저장된 답을 소비한다. 이미 호스트 응답을 시작한 **동의**는 그 채널에서 마친다. 대시보드 동의는 prepare 후 별도 호스트 confirm을 열지 않는다.

끝난 비대화형 Claude 실행은 저장된 runId·sessionId로 한 번만 예약하고 기존 supervisor를 사용한다. master 목표나 workId는 없어도 된다. 같은 요청에 실행 기록이 있으면 새 실행을 만들지 않는다. 살아 있는 실행·orphaned·unknown·paused·cancelled·정지 요청·인계·권한 회수·남은 보류에서는 자동 재개하지 않는다. 작업 ID와 feature/fix 종류는 최초 접수 그대로다. 예약 후 감독 시작 전 중단되어 abandoned가 되면 중복 위험 때문에 자동 재시작하지 않고 실행 결과를 확인한 뒤 기존 수동 복구를 따른다.

## 제한과 인계 항목

설치는 `code-agent init` 한 번으로 두 호스트를 준비한다. 호스트 밖 터미널에서 `code-agent execution claude|codex|both`로 실행을 선택하며, both는 현재 호스트를 메인으로 상대 호스트의 계획·코드 리뷰를 추가한다. 호스트 한도 소진에 따른 자동 전환은 하지 않는다. 독립 호스트 전환은 이전 실행 중지 → 단독 실행 선택 → 같은 브랜치에서 기존 작업 재개 순서다. 이전 세션의 미응답 질문은 취소하고 새 세션에서 재발행하며, 이미 받은 답은 원래 소비자가 처리한다. 미완료 동의는 원래 세션에서 마치거나 새로 준비한다. master 감독의 Claude 실행 프로필과 Codex 자동 재개 지원 범위는 이 선택으로 바뀌지 않는다.

- 기존 메모리에만 있는 질문, 세션 기록 없는 질문·동의는 복원하지 않는다. 원래 채널에서 처리하거나 명시적으로 재발행한다. 이미 받은 답은 재질문하지 않는다.
- 독립 Claude/Codex의 **살아 있는** 세션 응답은 지원한다. 저장된 master 실행이 없는 종료 세션을 자동 실행하거나 Codex 비대화형 세션을 자동 재개하지 않는다(`codexDetached:false`).
- master-agent의 브라우저 요청함·서버 키 보관·명시적 제출 검증·전송함·프로젝트 수집·master 자체 질문은 별도 구현·계약 검증 대상이다. code-agent 파일을 직접 쓰지 말고 이 API를 사용한다.
- 실제 브라우저 클릭, 두 실제 모델의 프로젝트별 완주, 운영 환경의 Git 반영·업데이트·플러그인 실행까지 이번 변경의 모의 시험으로 검증했다고 보지 않는다. 자동 시험과 실측 범위는 [검증 기록](reviews/2026-10-19-dashboard-interactions.md)을 따른다.

빌드 진입점은 `C:/IdeaProjects/code-agent/dist/agent/cli.js`다. `npm.cmd run build`, `npm.cmd test`로 재현한다. 공개 CLI·서명·중복 응답·적용 검사는 `src/test/dashboardInteractions.test.ts`·`dashboardApproval.test.ts`·`dashboardConsent.test.ts`, MCP 통신은 `choiceProtocol.test.ts`, 기존 동의 도메인 검사와 감독·중단 검사는 `consent*.test.ts`·`masterRuns.test.ts`에 있다. 검증 결과는 위 기록에 남긴다.
