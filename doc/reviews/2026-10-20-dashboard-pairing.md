# PC 신뢰와 대시보드 페어링

## 변경 범위

code-agent만 수정했다. master-agent는 읽기와 임시 프로젝트 상호 운용 점검에만 사용했다. [Codex 관리 실행의 Git 실행 권한](2026-10-20-codex-git-permission.md)(`1c6e403`) 위에서 작업했고 그 변경은 되돌리거나 덮어쓰지 않았다.

- 프로젝트마다 `master enable`·`master human enable`·master-agent `project control`을 따로 하던 연결을, PC당 1회 터미널 신뢰(`master trust --controller <ID>`, 확인 단어 `trust`)와 프로젝트마다 대시보드의 사람 확인으로 바꿨다. `pair.challenge`(인증 없음)가 일회성 챌린지를 주고, `pair`(PC 신뢰 키의 Ed25519 서명, 토큰 없음)가 연동 켜기·사람 채널 등록·토큰 발급을 한 번에 한다. 터미널 enable·human enable 경로는 그대로 둔다.
- 신뢰 해제(`untrust`, 확인 단어 `untrust`)는 이후 페어링만 막는다. 이미 켠 연동은 `master status`에 '신뢰 해제된 제어자'로 보인다. `trust --list`는 읽기 전용이다.
- 페어링이 바꾸지 않는 것: 정책, 호스트 설정(권한 모드·허용 도구·sandbox·모델·명령), 위임 권한. 해당 필드가 오면 `policy-forbids`로 거부한다. 다른 제어자가 소유한 프로젝트는 `fenced`, 인계 중이면 `conflict`로 거부하고 정식 인계만 허용한다.
- 키 자리: PC 신뢰 개인 키 `<storeDir>/master-trust/<ID>.pem`, 기록 `<storeDir>/master-trust.json`, 토큰 `<storeDir>/master-tokens/<projectId>-<ID>.token`. 사람 채널 개인 키는 `CODE_AGENT_HOME`을 따르지 않고 사용자 홈 `.code-agent/dashboard-channels/`에 두던 것을 키 저장소(`storeDir`) 아래로 옮겼다. `CODE_AGENT_HOME`을 쓰는 환경에서도 hook 의 키 저장소 차단이 모든 키 자리를 덮는다. 기본 환경(`CODE_AGENT_HOME` 없음)의 경로는 같다. master-agent 는 이미 `CODE_AGENT_HOME` 기준으로 사람 채널 키를 찾는다.
- 토큰 값은 응답·명령 기록·이벤트에 넣지 않고 `tokenFile` 경로만 담는다. hello 의 `pairing`·`managedHost`에도 키·토큰·키 경로를 넣지 않는다.
- hello 에 `pairing`(지원·버전·서명·도메인·신뢰한 제어자 ID)과 `managedHost`(선택될 호스트·출처·설치 호스트·실행 선택·준비·문제)를 더했다. 처음 켤 때의 기본 호스트는 `execution` mode(`both`면 main) → 설치 호스트가 하나면 그 호스트 → `claude`다(터미널 enable 도 같다).
- 관리 실행의 호스트 준비 검사(`requireManagedHost`)가 Claude 도 설치 기록·hook 을 본다. 사람의 대화형 세션에서도 실행 호스트가 `hosts.json`에 없으면 `start`·`request begin`·`docs begin`이 시작하지 않는다.
- 이벤트 `human-channel.changed`를 더했고, 연동·제어자·사람 채널 이벤트에 연결 방식(`data.channel`: `tty`·`dashboard-pairing`)을 남긴다.

## 계약 확정 사항

master-agent 요청서의 계약 초안을 [master 연동 계약](../master-control.md#pc-신뢰와-대시보드-페어링)에 확정했다. 초안과 다르거나 초안이 정하지 않았던 것:

- `pair` 결과의 `humanChannel`에 `keyPath`·`generation`·`algorithm`을 더했다. 터미널 `human enable`의 출력과 같은 값이며 대시보드 서버가 키를 찾는 데 쓴다(키 내용은 없다).
- `hello.pairing`에 `signature: "Ed25519"`·`domain`을 더했다.
- `approval.shownHash`는 `sha256:<hex 64>`, `approval.approvedAt`은 챌린지를 만든 시각 2분 전부터 지금 2분 뒤까지, `approval.actor`는 1~200자다.
- `pair.challenge`도 신뢰한 제어자에게만 준다(`unauthorized`). 챌린지는 5분, 한 번만 쓰고 프로젝트마다 열린 것 32개까지다(`busy`).
- 오류 코드: 신뢰 없음·서명 없음·불일치 `unauthorized`, 챌린지 없음·만료·사용함·다른 제어자·다른 경로 `stale-state`, 다른 제어자 소유 `fenced`, 인계 중·소유 기록 없음 `conflict`.
- 같은 `commandId` 재전송은 기록된 응답(`replayed: true`)을 돌려준다. 응답을 잃은 대시보드는 같은 서명으로 다시 보내면 된다.

`STATE_SCHEMA`는 올리지 않았다. 바뀐 것은 `binding.json`의 선택적 필드(`enabledBy.channel`·제어자의 `pairing`)와 저장소 밖 키 저장소 파일이며, 승인·증거·작업 기록의 형식이 아니다. 기능 협상은 `hello.pairing`으로 한다.

## 검증

Windows 11·Node 24.19.0 에서 `npm run build`를 통과했다.

새 집중 시험 `masterPairing.test`는 12개 모두 통과했다. 대상은 다음과 같다.

- 정상 흐름: trust → `pair.challenge` → `pair`로 연동·사람 채널·토큰이 준비된다. 토큰으로 heartbeat 를 받고, 같은 `commandId` 재전송은 기록된 응답이다. 재페어링하면 토큰·사람 채널이 바뀐다.
- untrust 뒤 유지·표시와 다시 trust.
- 아무것도 쓰지 않는 거부: 서명 없음·다른 키·변조·다른 `commandId`·다른 제어자·없는·사용한·만료한 챌린지, 정책·호스트·위임 필드, 토큰·세대·expect, `approvedAt`·`shownHash` 꼴. 각 거부 뒤 상태 스냅샷이 그대로인지 확인한다.
- 다른 프로젝트 경로, 다른 제어자 소유(`fenced`)·인계 중(`conflict`).
- trust 명령: 덮어쓰기 거부, 잘못된 ID, 저장소 밖 실행, 비TTY 거부, 접합점 링크 거부.
- `managedHost`와 처음 켤 때의 기본 호스트, Claude 관리 실행 준비 검사, 시작 게이트.
- hook 이 `master trust`·`untrust`·`call`과 키 저장소의 새 자리(`master-trust/`·`master-tokens/`·`dashboard-channels/`·`master-trust.json`)에 대한 읽기·쓰기·셸 언급을 막는다(`CODE_AGENT_HOME`·기본 홈). `hookPaths.test`에도 작업 중 세션의 `master trust`·`untrust`·`call` 거부를 더했다.

사람의 TTY 확인은 시험 전용 `withInteraction`으로 흉내냈다. 실제 사람 입력이 아니다.

첫 전체 회귀에서 4개가 실패했다. 이 세션이 물려준 호출 호스트 표지(`CLAUDECODE=1`) 아래에서 Codex 만 설치한 픽스처가 새 시작 게이트에 걸린 것이다. 같은 꼴을 찾으려고 Codex 표지(`CODEX_THREAD_ID`)를 흉내 내 전체를 돌리자 Claude 만 설치한 픽스처 12개가 같은 이유로 실패했다. 게이트는 그대로 두고, 해당 픽스처가 호출 호스트를 스스로 정하게 했다(`reviewFixture.ts` `withCaller`·`setCaller`). 이 시험들은 어느 호스트 안에서 돌려도 같은 결과가 난다. 고친 파일 11개(140개 시험)를 Claude 표지·표지 없음·Codex 표지의 세 환경에서 모두 통과시켰다.

최종 전체 회귀:

- `npm test`(Claude Code 세션 안, `CLAUDECODE=1`, 커밋한 트리 그대로): 1,686개 중 1,682개 통과, 실패 0개, 플랫폼 생략 4개, 약 496초.
- 같은 빌드를 Codex 표지 아래에서 실행한 `node --test "dist/test/**/*.test.js"`: 1,686개 중 1,682개 통과, 실패 0개, 생략 4개, 약 437초.

master-agent 상호 운용은 master-agent 작업 트리의 페어링 클라이언트(`packages/code-agent-adapter/pairing.mjs`·`control.mjs` — 커밋 전 별도 작업이며 읽기만 했다)를 이 빌드의 `dist/agent/cli.js`에 연결해 확인했다. 임시 git 프로젝트(`init --host claude`)와 임시 `CODE_AGENT_HOME`을 썼다. 결과:

- trust 전 `connectionState`는 `trust-missing`이고, trust 뒤에는 `pairing-available`이다(`managedHost` `claude`·`installed`·준비됨).
- `signPairing`으로 서명한 `pair`가 `enabled`를 돌려준다. 같은 서명의 재전송은 `replayed`이고 결과가 같다.
- master-agent `findHumanKey`가 사람 채널 키를 찾는다. 발급 토큰으로 `ControlClient` heartbeat 가 성공하고, hello 의 `enabled`·`controllers`·`ownership`이 `bindControl`의 조건을 만족한다.
- 재페어링은 `rotated`다. 같은 토큰 파일에 새 토큰을 쓰고, 옛 토큰은 `unauthorized`다. 연결 뒤 상태는 `connected`다.
- 토큰 값은 응답과 `.code-agent/master/` 파일 어디에도 없다.

master-agent DB 를 쓰는 `pairControl`·`bindControl` 저장 경로와 브라우저 확인 화면은 실행하지 않았다. 수치와 범위는 [기계 판독 근거](evidence/2026-10-20-dashboard-pairing.json)에 남긴다.

## 감수하는 위험과 남은 범위

- 같은 OS 계정을 탈취한 프로세스는 PC 신뢰 키를 읽어 페어링할 수 있다. 대시보드 사람 채널 키·토큰 파일과 같은 수준이며 계약 문서에 적었다. hook 의 차단은 AI 호스트 세션이 키를 읽거나 연동을 켜지 못하게 하는 장치다.
- Windows 에서는 파일 모드 0600·0700 이 ACL 로 적용되지 않는다(Node 가 `0o666`으로 보고한다). 기존 사람 채널 키·토큰 파일과 같다.
- 사람 채널을 다시 등록(재페어링·`human enable`)해도 이전 개인 키 파일은 지우지 않는다. 이전 서명은 받지 않는다(기존 동작과 같다).
- master-agent 의 화면·DB 연결(`pairControl`·`bindControl`)과 브라우저 확인 화면은 이 저장소의 범위 밖이다.
