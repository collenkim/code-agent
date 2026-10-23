# master 요청의 실행 방식 선택

## 변경 범위

master-agent 요청이 host(Claude·Codex 단독 또는 둘 다)를 고르면 그 선택이 개발 호스트와 master 계획·판단을 함께 정하도록, code-agent 가 요청별 실행 방식을 받는다. `init`은 두 호스트를 모두 설치하므로 호스트는 설치가 아니라 실행 방식이 정한다. 요청의 선택은 그 실행에만 적용하고 프로젝트 설정(`execution.json`)은 바꾸지 않는다.

code-agent 쪽 변경은 다음과 같다.

- `submit mode:start`가 `execution: { mode, main? }`을 받는다(`runExecutionOf`). 고른 방식의 주 호스트에 사람이 등록한 설정(`profileFor`, 없으면 제한된 기본값)으로 돈다.
- 선택을 실행 기록(`RunRecord.execution`)에 남기고, 실행이 연 작업의 연결(`WorkBinding.execution`, `bindWork`)에 고정한다. `crossEnabled`와 hook 의 단독 호스트 가드는 지금 작업의 연결 → 작업을 열기 전이면 이 세션의 master 실행 기록 → `execution.json` 순(`master/workExecution.ts` `managedExecution`)으로 판정한다.
- 이미 연 작업·`continue`·사람 응답 재개는 고정된 방식을 이어 쓰고(`requireResumeProfile`도 그 방식으로 대조), 작업의 선택은 사람의 `execution <방식> --handoff`만 바꾼다.
- hello `managedHost`에 `runSelection`·`hosts`, 접수 결과·실행 요약에 `execution`(접수 결과에 `hostKind`)을 더했다. 꼴·설치 검사의 오류 코드와 계약 세부는 [master 연동](../master-control.md) §3·§11에 있다.

master-agent 쪽(별도 저장소)은 요청의 host 를 받아 새 실행 접수에만 `execution`으로 보내고, 같은 선택으로 계획·판단 AI를 정한다(단독은 그 CLI, both 는 주 host 생성·다른 host 승인). code-agent 가 `runSelection`을 알리지 않으면 프로젝트 방식으로 대신 실행하지 않고 준비 점검에서 막는다.

## 판단과 감수한 것

- **작업 단위 고정.** 실행 단위로만 적용하면 같은 작업을 이어 가는 사람 세션·감독 밖 명령이 프로젝트 방식으로 판정돼 교차 의무와 단독 가드가 실행 사이에 바뀐다. 작업 연결 기록에 고정하면 작업이 끝날 때까지 한 가지 판정을 본다.
- **hook 경로.** `managedExecution`은 `hosts.ts`·`hook.ts`가 부르므로 명령 모듈을 import 하지 않는다(`layout`·`runGuard`·`protocol` 타입). 기록을 읽지 못하면 선택이 없는 것으로 보고 프로젝트 방식으로 둔다.
- **상태 형식 세대 10 → 11.** 실행·작업 기록에 판정에 쓰는 필드가 생겼다. 낮은 세대 릴리스는 이 필드를 몰라 진행 중인 작업을 프로젝트 방식으로 판정하므로 그 프로젝트에 적용하지 않는다(관리 호스트 변경 때 실행 기록 확장으로 세대를 올린 것과 같은 기준).
- **실행 방식만 고른다.** master 의 토큰으로 호스트 권한 설정을 바꾸지 못한다. 이미 사람이 등록한 설정 안에서 어느 호스트로 실행할지만 고른다. 두 호스트 설치는 `init` 기본이고, 설치되지 않은 호스트는 거부한다. 이 설치 검사는 작업에 고정된 방식으로 바뀔 요청에도 한다. 꼴과 설치는 요청 자체의 오류이기 때문이다. 호스트의 실행 준비(hook·신뢰)는 실제로 쓸 호스트만 본다.

## 검증

Windows 11·Node 24.19.0. `npm run build` 통과.

집중 시험(합성 TTY·모의 호스트, 실제 모델 없음):

- `executionMode.test`(1개 추가): 실행 기록의 선택이 작업을 열기 전 교차 의무(`crossEnabled`·`crossRequired`)와 단독 가드를 정한다. 작업이 열리면 실행 표지 없는 세션도 작업 기록의 선택을 본다. 작업 기록에서 선택을 지우면 프로젝트 방식으로 돌아간다. `execution.json`은 `auto` 그대로다.
- `masterCodex.test`(1개 추가): Codex 로 켠 연동에 Claude 설정을 시험용 가짜 호스트로 등록하고 `execution.json`은 `auto`로 둔다. hello 의 `runSelection`·`hosts`, `execution {mode: claude}` 접수가 Claude 프로필로 돌고 결과·요약·실행 기록에 선택이 남는 것, 프로젝트 방식이 그대로인 것을 본다. continue 는 이전 선택을 잇고 continue 의 `execution`은 거부한다. 꼴이 틀린 선택 4종을 거부하고 `both`·main codex 는 Codex 로 돈다. 설치 기록에 없는 호스트가 필요한 방식은 `invalid-state`(`host-not-installed`)다.
- `executionHandoff.test`(2개 추가): master 가 고른 작업에서 사람의 인계가 작업의 선택과 교차 의무를 바꾼다. 이미 연 작업(Claude 고정)에 Codex 를 고른 새 실행이 오면 Claude 로 돌고, 쓰지 않을 Codex 의 준비(신뢰 기록 없는 빈 `CODEX_HOME`)는 보지 않는다.

마지막 시험은 처음 구현에서 실패했다. 요청한 호스트의 준비를 작업 확인 전에 검사해, 실제로는 Claude 로 돌 실행을 `codex-project-untrusted`로 막았다. 준비 검사를 작업에 고정된 방식을 반영한 뒤로 옮겼다. 옛 순서를 빌드에 되돌려 같은 시험이 그 오류로 실패하는 것을 확인했다.

최종 전체 회귀: `npm test`(Claude Code 세션 안, `CLAUDECODE=1`) 1,690개 중 1,686개 통과, 실패 0개, 플랫폼 생략 4개, 약 885초.

master-agent 상호 운용은 master-agent 요청 host 변경(`db39d97`)의 `ControlHost`·페어링 어댑터를 이 빌드의 `dist/agent/cli.js`에 연결해 확인했다. 실제 감독과 모의 Codex 모델을 쓰고, 프로젝트 실행 방식은 Claude 단독으로 두었다. 결과는 다음과 같다.

- hello 의 `runSelection`은 `claude`·`codex`·`both`였다.
- 요청의 Codex 로 실행했고(`hostKind: codex`), `execution.json`은 그대로였다.
- 이어 실행은 `execution` 없이 같은 thread 를 Codex 로 이었다.

master-agent 의 code-agent 연동 시험 5개 파일(30개)도 이 빌드에서 통과했다. 수치와 범위는 [기계 판독 근거](evidence/2026-10-21-run-execution.json)에 남긴다.

## 남은 범위

- 실제 Claude·Codex 모델로 `both`의 교차 리뷰를 master 요청 경로에서 끝까지 돌린 시험은 없다. 교차 리뷰 자체는 기존 시험 범위다.
- 이미 연 작업에 다른 방식을 요청하면 요청의 방식을 쓰지 않고 접수 결과의 `execution`으로만 알린다. 거부하지 않는 이유는 같은 요청의 재시도·이어 실행이 같은 작업에 새 실행을 여는 정상 경로이기 때문이다.
