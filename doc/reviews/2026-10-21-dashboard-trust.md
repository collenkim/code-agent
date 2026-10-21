# 대시보드 확인 PC 신뢰

## 변경 범위

PC 신뢰를 대시보드 확인 화면에서도 등록한다. 터미널의 `master trust`(확인 단어 `trust`)는 그대로 두고, TTY 없이 대시보드가 부르는 두 형태를 더했다.

- `master trust --controller <ID> --preview`는 아무것도 쓰지 않고 확인 화면 내용을 JSON 한 줄로 낸다(`trustPreview`). 문구는 터미널 확인과 같은 내용에 화면 등록의 한계 한 줄을 더한다. `shownHash`는 domain·제어자·개인 키 자리·문구의 해시다. 이미 신뢰하거나 키 파일이 있으면 `canTrust: false`와 사유를 낸다.
- `master trust --controller <ID> --shown-hash <해시>`는 그 해시가 지금 문구의 해시와 같을 때만 키를 만든다(`masterTrustConfirmed`). 호스트 표지가 있는 셸은 `policy-forbids`, 이미 신뢰·키 파일은 `conflict`, 해시 불일치는 `stale-state`로 거부하고 아무것도 쓰지 않는다.
- 기록의 `createdBy`에 `channel: "dashboard"`와 `shownHash`를 남겨 터미널 등록(`tty`)과 구분한다. `trust --list`는 `(대시보드 확인)`으로 보인다.
- 신뢰하지 않은 제어자의 페어링 거부 안내와 도움말에 대시보드 확인 등록을 더했다.

master-agent 쪽(별도 저장소)은 프로젝트 카드의 PC 신뢰 버튼과 확인 화면(code-agent 문구, 확인 단어 `trust`)으로 이 두 형태를 부른다. 호출 환경에서는 호스트 표지를 지운다.

## 판단과 감수한 것

- **사람이 고른 경로.** 터미널 창을 열어 TTY 확인을 유지하는 방식과 브라우저 확인 중에서 사용자가 브라우저 확인을 골랐다. code-agent 는 화면 앞에 사람이 있었는지 확인하지 못하므로, 같은 OS 계정에서 대시보드를 부를 수 있는 프로세스(모델 세션 포함)도 등록을 요청할 수 있다. 이 한계를 확인 문구에 넣고 기록을 `dashboard`로 남긴다.
- **문구의 정본은 code-agent.** 대시보드는 문구를 만들지 않고 `--preview`의 문구와 해시를 그대로 보인 뒤 돌려준다. 키 자리가 바뀌는 등 보인 내용과 다른 상태로는 등록하지 않는다.
- **호스트 셸 거부는 오용 방지다.** 모델의 직접 호출은 hook 의 `master trust` 차단이 먼저 막는다. hook 이 없는 세션도 표지(`CLAUDECODE`·Codex 표지)로 거부한다. 표지를 지우면 피할 수 있으므로 보안 경계로 보지 않는다.
- **덮어쓰지 않는다.** 기존 신뢰·키 파일이 있으면 터미널과 같이 거부한다. 교체는 터미널의 `untrust` 뒤에 한다. 화면 해제는 두지 않았다.
- **상태 형식 세대는 그대로다.** 키 저장소 기록(`master-trust.json`)에 선택 필드만 더했고 프로젝트 상태는 바꾸지 않았다. 신뢰 판정은 계속 제어자·공개 키·지문만 본다.

## 검증

Windows 11·Node 24.19.0. `npm run build` 통과.

집중 시험(`masterPairing.test`, 3개 추가, 15개 통과):

- 미리보기는 아무것도 쓰지 않는다. 문구에 개인 키 자리와 화면 등록의 한계가 있고, 같은 내용은 같은 해시다. 그 해시로 TTY 없이 등록하면 기록이 `dashboard`로 남고, 목록·hello `trustedControllers`에 보이며, 바로 페어링된다. 등록 뒤 미리보기는 `canTrust: false`다.
- 거부는 아무것도 쓰지 않는다: 호스트 표지 3종, 보지 않은 해시, 다른 제어자의 해시, 해시 꼴 4종, 장치 이름, 남은 키 파일(내용 보존), 터미널로 이미 신뢰한 제어자(기록은 `tty`).
- CLI: 저장소 밖에서 `--preview`·`--shown-hash`가 JSON 한 줄을 내고 그 폴더에 쓰지 않는다. 표지가 있는 셸은 `policy-forbids`(키 없음), 재등록은 `conflict`, 해시 없는 인자는 사용법이다.

최종 전체 회귀: `npm test`(Claude Code 세션 안, `CLAUDECODE=1`) 1,701개 중 1,697개 통과, 실패 0개, 플랫폼 생략 4개, 약 954초.

master-agent 상호 운용은 master-agent 의 화면 신뢰 변경(`packages/runner/control-trust.mjs`·대시보드 확인 화면)을 이 빌드의 `dist/agent/cli.js`에 연결해 확인했다. 키 저장소는 격리 `CODE_AGENT_HOME`이고, 서버 환경에 `CLAUDECODE=1`을 둔 채 실행했다.

- 연동 시험(`tests/code-agent-control.test.mjs`): 실제 문구·미리보기 무기록, 보지 않은 해시 `stale-state`, 확인한 해시로 등록·기록·같은 키 저장소의 키 탐색, 재등록 거부, 신뢰 직후 제어 연결.
- 실제 브라우저(`scripts/smoke-dashboard-trust.mjs`): 카드의 PC 신뢰 → code-agent 문구 → 확인 단어 → 등록 → `제어 연결 가능` → 제어 연결 → `제어 연결됨`, 1440/390/320px.
- master-agent 전체 회귀: 279개 모두 통과(이 빌드 사용).

수치와 범위는 [기계 판독 근거](evidence/2026-10-21-dashboard-trust.json)에 남긴다.

## 남은 범위

- 사용자의 실제 키 저장소에서 화면 신뢰를 등록하지 않았다. 시험은 모두 격리 `CODE_AGENT_HOME`이다.
- 화면에서 신뢰를 해제하는 경로는 없다. 해제는 터미널의 `untrust`다.
