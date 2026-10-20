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

questions.md의 원래 질문 모두에 기존 출처 검사를 통과한 답이 있고 원본 해시가 달라지면, 수신한 답이 없는 낡은 문서 연결 요청은 조회 동기화에서 superseded로 닫는다. 질문 삭제·출처 미확인 답으로 대기를 풀지 않는다. 대시보드 답·승인·적용 증거는 만들지 않는다. 이미 받은 서명 답은 보존하고, 바뀐 문서에 덮어쓰려는 적용은 기존 문맥 검사로 막는다.

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

끝난 비대화형 Claude·Codex 관리 실행은 저장된 runId·확정된 sessionId로 한 번만 예약하고 기존 supervisor를 사용한다. Codex는 app-server가 돌려준 thread ID를 확정한 기록(`sessionConfirmed`)이 있어야 하며 다른 세션으로 대체하지 않는다. master 목표나 workId는 없어도 된다. 같은 요청에 실행 기록이 있으면 새 실행을 만들지 않는다. 살아 있는 실행·orphaned·unknown·paused·cancelled·정지 요청·인계·권한 회수·남은 보류에서는 자동 재개하지 않는다. 호스트 선택·등록 권한 설정이 달라졌거나 Codex 설치·신뢰 조건을 충족하지 못해도 차단 사유를 기록한다. 작업 ID와 feature/fix 종류는 최초 접수 그대로다. 예약 후 감독 시작 전 중단되어 abandoned가 되면 중복 위험 때문에 자동 재시작하지 않고 실행 결과를 확인한 뒤 기존 수동 복구를 따른다.

## 관리 기록 없는 종료 세션 복원

원래 Claude·Codex 대화 파일과 영속 질문이 남아 있으면, 사람이 호스트 밖 터미널에서 종료를 확인하고 같은 세션을 관리 재개에 연결한다. 기능 협상은 `hello.codeAgent.stateSchema >= 9`와 `interactions.continuation.independentRecovery === "tty-native-transcript"`로 한다. HTTP/JSON API가 사람의 종료 확인을 대신하지 않는다.

```powershell
# 해당 프로젝트 디렉터리에서 원래 호스트·작업·질문·대화 파일을 먼저 조회한다.
code-agent master recover <requestId> --json
# 원래 세션의 모든 실행을 종료한 뒤 화면을 확인하고 recover를 입력한다.
code-agent master recover <requestId>
# 원본 자동 검색이 모호하면 호스트 기록 폴더 안의 파일을 지정한다.
code-agent master recover <requestId> --transcript 'C:\Users\사용자\.claude\projects\프로젝트\세션UUID.jsonl'
```

Claude는 `CLAUDE_CONFIG_DIR/projects`(기본 `~/.claude/projects`), Codex는 `CODEX_HOME/sessions`(기본 `~/.codex/sessions`)의 원본만 읽는다. UUID·프로젝트 실제 경로·주 세션·대화 존재·완전한 JSONL을 확인하며 64 MiB를 넘는 파일은 거부한다. 대화 본문은 복사하지 않고 파일 경로·해시·크기·수정 시각을 복원 실행에 남긴다. 확인 중 원본·질문·소유권·작업이 바뀌면 다시 조회한다. 원본 검사는 과거 프로세스 종료를 자동 증명하지 않으므로 사람이 모든 실행의 종료를 확인해야 한다.

복원은 `blocked` 실행 기록을 만들고 질문의 별도 `recoveredRunId`로 연결한다. 원래 `context`·본문 해시·challenge·받은 답·승인은 유지하고, API의 `blocking.runId`는 유효한 연결을 반환한다. 독립 작업이 있으면 같은 작업 ID를 현재 제어자에게 명시적으로 연결하며 새 접수나 feature/fix 변경은 없다. 복원 자체는 모델 실행·과거 작업 성공·사람 승인이 아니다.

미응답이면 실제 제출을 기다린다. 이미 답을 받았다면 기존 `interaction`/`interaction.result` 조회 또는 `code-agent interaction drain <requestId>`로 적용·재개한다. 같은 복원 명령과 응답 재전송은 실행을 중복 생성하지 않는다. 일부 기록만 저장된 중단도 동일 복원 ID로 연결을 마친다. 원래 호스트 선택·권한·Codex 신뢰·소유 세대·문맥·임대·미응답 게이트는 재개 전에 다시 검사한다. 원래 채널에서 응답을 시작한 미완료 동의는 그 채널에서 먼저 마친다.

## Codex Git 실행 권한

Codex 관리 실행은 로컬 `app-server`의 표준 입출력으로 권한 요청을 받는다. 외부 서버·HTTP 포트를 열지 않는다. `workspace-write` 샌드박스와 네트워크 차단을 유지하며, `approval_policy=on-request`·`approvals_reviewer=user`로 단건 요청을 사람 채널에 연결한다. 시작 전 `hooks/list`로 실제 로드된 code-agent PreToolUse가 활성·동기 실행·신뢰 상태인지 확인한다. 해당 프로토콜을 지원하지 않거나 hook을 로드하지 않으면 모델 턴을 시작하지 않는다. 기능 협상은 `hello.codeAgent.stateSchema >= 10`과 `interactions.hostPermissions.kind === "host-permission"`으로 한다.

지원 대상은 저장소 루트에서 실행하는 `code-agent start …`, `code-agent verify …`, `code-agent repro …`의 명령 실행 승인이다. PowerShell·bash의 단순 실행 래퍼도 받는다. 이 명령들은 원래 hook·작업 단계·승인·검증 검사를 그대로 거친다. 직접 Git 변경, 복합 셸·인라인 코드, 네트워크 승인, 파일 변경 승인, 다른 프로젝트·원격 환경, 읽기 전용 실행의 쓰기 권한은 이 경로에서 받지 않는다. 준비·반영 동의의 Git 작업은 기존 외부 동의 적용 처리기가 수행한다.

`interactions` 또는 `interaction` 응답의 `kind: "host-permission"`, `consumer: "codex-command"`를 일반 질문·업무 동의와 구분한다. `permission`에는 전체 `command`, `cwd`, 호스트가 제공한 `reason`, `threadId`, `turnId`, `itemId`, `rpcId`, `connectionId`, 소유 세대와 `scope: "once"`가 있다. 화면에는 **명령 전문·작업 디렉터리·사유·일회 실행 범위**를 보여 준다. 샌드박스 밖 실행을 승인하면 해당 명령과 자식 프로세스가 그 권한으로 실행될 수 있다는 영향도 함께 표시한다. 추천·기본 선택을 실제 승인으로 제출하지 않는다.

조회와 서명 방법은 위의 일반 API와 같고, 제출 본문만 다르다.

```json
{
  "protocol": "code-agent.master", "version": 1,
  "type": "interaction.respond", "controller": "dashboard", "generation": 1,
  "token": "<연결 토큰>", "commandId": "git-permission-submit-1",
  "payload": {
    "requestId": "<조회한 UUID>", "expectedRevision": 12,
    "contentHash": "<조회한 전문 해시>", "challenge": "<조회한 challenge>",
    "channelId": "<사람 채널 UUID>", "signature": "<사람의 명시적 제출 후 서버가 생성한 Ed25519 서명>",
    "submission": { "intent": "submit", "explicit": true, "permissionDecision": "accept" }
  }
}
```

이 요청을 기존 `node C:/IdeaProjects/code-agent/dist/agent/cli.js master call`의 표준 입력으로 전달한다(작업 디렉터리는 대상 프로젝트). 거절은 `permissionDecision: "decline"`, 보류·취소는 `permissionDecision` 없이 `intent: "defer"`·`"cancel"`로 보낸다. 보류는 같은 요청을 `reopen` 후 응답한다. 일반 `answers`나 업무 동의 `verdict: "approve"`로 실행 권한을 승인할 수 없다. 제어 토큰이나 위임 권한만으로 승인할 수도 없다.

감독은 응답 직전에 프로젝트·브랜치·HEAD·작업·세션·실행·소유 세대·사람 채널·만료를 다시 검사한다. 유효한 응답만 원래 살아 있는 RPC에 `accept` 또는 `decline`으로 한 번 전달한다. 세션 전체 허용·영구 실행 규칙·네트워크 규칙을 저장하지 않는다. 대기 중인 동일 run·thread·turn에서 이어가므로 새 작업 ID나 재개 실행을 생성하지 않는다.

응답 수신과 실행 성공은 별개다. `interaction.result`의 `application.result.forwarded: true`는 Codex에 결정을 전달했다는 뜻이다. `executionConfirmed: true`, `status`, `exitCode`는 해당 명령의 완료 알림을 받았다는 뜻이며, 프로젝트 개발 완료나 테스트 통과를 대신하지 않는다. 명령 성공 여부는 `exitCode`와 기존 검증 결과로 판단한다.

요청은 최대 15분과 원래 실행 시간 상한 중 먼저 도달하는 시각에 만료된다. 정지·취소·문맥 변경·권한 회수에는 허용을 전달하지 않는다. 원래 호스트가 종료되면 미완료 요청을 닫는다. 승인 전달 직후 통신이 끊겨 실행 여부를 확인하지 못하면 재전송하지 않는다. `unknown` 실행은 기존 재조정·상태 확인 절차로 처리하고, 같은 세션을 다시 시작해도 새 호스트 요청에 새 사람 응답이 필요하다.

master-agent의 화면은 이 종류를 표시하고 `permissionDecision`을 서명해 보내야 한다. code-agent는 이 문서의 로컬 API를 제공하며 다른 저장소의 화면을 수정하지 않는다. 공식 연결 규약은 [Codex App Server 승인](https://learn.chatgpt.com/docs/app-server#approvals), 샌드박스의 Git 보호는 [보호 경로](https://learn.chatgpt.com/docs/agent-approvals-security#protected-paths-in-writable-roots)를 따른다.

## 제한과 인계 항목

설치는 `code-agent init` 한 번으로 두 호스트를 준비한다. `execution claude|codex`는 독립·관리 실행의 호스트를 선택하고, `execution both --main claude|codex`는 관리 실행의 주 호스트와 상대 호스트 교차 검증을 선택한다. 전환은 이전 실행 중지 → `execution --json`으로 인계 상태 조회 → `execution codex --handoff`(또는 claude·both) 확인 → 같은 브랜치의 기존 작업 재개 순서다. 인계는 미응답 일반 질문을 취소 이력으로 남기고 임대를 풀며, 미소비 답·미완료 동의가 있으면 먼저 원래 채널에서 처리하도록 막는다. 작업·승인·답을 다른 세션으로 복사하지 않는다. 자세한 명령·관리 실행 계약은 [호스트 전환 인계](master-control.md#호스트-전환-인계)를 따른다.

- 영속화하지 않은 질문·동의나 원본 대화까지 없는 세션은 복원하지 않는다. 원래 채널에서 처리하거나 명시적으로 재발행하며 이미 받은 답은 재질문하지 않는다. 토큰 소진 시 자동 호스트 전환은 지원하지 않는다.
- Codex 관리 실행의 Git 쓰기 차단은 위 단건 권한 응답으로 처리한다. 사람 채널·지원 화면이 없으면 승인 없이 대기하며, 일반 터미널·IDE의 독립 Codex는 해당 호스트의 승인 화면을 사용한다. 프로젝트 전체 완주 검증은 Git 권한 연결 검증과 구분한다.
- master-agent는 브라우저 요청함·서버 키 보관·명시적 제출 검증·전송함·프로젝트 수집·master 자체 질문을 담당한다. code-agent 파일을 직접 쓰지 말고 이 API를 사용한다.

빌드 진입점은 `C:/IdeaProjects/code-agent/dist/agent/cli.js`다. `npm.cmd run build`, `npm.cmd test`로 재현한다. 공개 CLI·서명·중복 응답·적용 검사는 `src/test/dashboardInteractions.test.ts`·`dashboardApproval.test.ts`·`dashboardConsent.test.ts`, 복원은 `sessionRecovery.test.ts`, MCP 통신은 `choiceProtocol.test.ts`, 기존 동의 도메인 검사와 감독·중단 검사는 `consent*.test.ts`·`masterRuns.test.ts`에 있다. 실제 모델·회귀 결과와 남은 검증 범위는 [복원·모델 검증 기록](reviews/2026-10-20-session-recovery-live.md)에 모은다. 실제 브라우저 클릭·운영 환경 반영·업데이트·플러그인 실행은 별도 검증 대상이다.
