# 릴리스 업데이트 — 설치와 적용 분리 (2026-10-14)

커밋 `d01b4d1`의 변경 경위와 검증 결과다. 현재 동작은 [흐름도](../process-flow.md) §1.1·§3.1·§4.1·§5.1·§5.3·§5.4·§7·§8·§9, [설치 §5](../install.md#5-code-agent-update--갱신), [설계 §8](../design.md#8-배포와-대상-저장소), [README 업데이트](../../README.md#업데이트)에 있다. 원자료는 [evidence/2026-10-14-release-update.json](evidence/2026-10-14-release-update.json)이다.

## 요청

새 릴리스가 나와도 사용 중인 Claude Code·Codex 를 종료하지 않고 설치하고, 안전한 시점에 새 버전으로 이어 간다. 실행 코드·작업 지침·MCP·진행 상태 사이에 버전이 섞이지 않도록 설치와 적용을 나눈다. 재시작 안내는 실제 제약일 때만 낸다.

후속 요청(2026-10-15): code-agent 가 설치되지 않은 폴더에서는 아무것도 쓰지 않고 거절한다. 남은 제약 중 고칠 수 있는 것을 고친다. README 에 업데이트 가이드를 둔다.

## 기존 구현 확인

| 검토 지적 | 코드에서 확인한 것 |
|---|---|
| 실행 중인 설치 폴더에서 pull·npm ci·build | 맞다 — `sourceUpdate.ts`가 소스 폴더에서 `pull --ff-only`·`npm ci`·`npm run build`를 돌렸다. 그 폴더가 hook·MCP·PATH 의 실행 코드다 |
| 템플릿을 즉시 덮어써 계획 밖 변경 | 맞다 — 갱신 직후 새 CLI 가 `update`(템플릿 적용)를 돌렸다. 진행 중인 작업이 있으면 `!! 이번 갱신이 바꾼 설치 파일이 …` 경고만 냈다 |
| 재시작 일괄 안내 | 맞다 — 동의 적용·문서·스킬이 "Claude Code 를 종료하고 다시 열어야 새 hook 이 활성화된다"를 늘 적었다 |
| Codex MCP 설정이 그대로여도 재시작 안내 | 맞다 — Codex 설치 보고가 늘 다시 열라고 했다 |
| hook 은 호출마다 새 프로세스, MCP 는 장시간 | 맞다 — `.claude/settings.json`·`.codex/hooks.json`의 명령은 매 이벤트 새 프로세스다. 선택 UI MCP 는 Codex 가 세션 동안 한 프로세스로 띄운다 |

배포 방식은 셋이었다 — 로컬 Git 소스(npm link, 개발 설치), npm 패키지(`npm install -g <사내 저장소>/code-agent`), 단일 실행 파일. 기본 `update`의 받기는 Git 소스만 지원했다.

## 설계 결정

설계 판단과 현재 동작은 [설계 §8](../design.md#8-배포와-대상-저장소)과 [설치 §5](../install.md#5-code-agent-update--갱신)가 정본이다 — 릴리스 저장소 등록, 식별값, 고정 진입점의 같은 프로세스 위임, 설치 방식별 정책, 안전한 시점과 예약, 상태 형식 세대, 템플릿 보존·되돌리기, 지침 다시 읽기, 선택 UI MCP 의 연결부·처리기, 재시작 안내, `--cli` 진입점. 그 문서에 없는 판단만 남긴다.

- 지금 적용 중인 갱신 동의 자신은 진행 중인 확인으로 세지 않는다(`--consent`).

## 변경

| 단위 | 파일 |
|---|---|
| 버전 선택·위임 | `runtimeSelect.ts`(새 — 여는 셸 명령 `OPENING_COMMAND`·적용 대기 `pendingSwitch` 포함), `cli.ts` — 적용 버전이 사라졌는데 진행 중인 일이 있으면 다른 버전으로 잇지 않는다(PreToolUse 거부, Stop 은 막지 않음, 조회·복구 명령만 번들) |
| 릴리스 저장소 | `releaseStore.ts`(새) — Git 소스 설치·npm 패키지 복사·검증·설치 잠금·끊긴 임시 폴더 정리 |
| 적용·예약·템플릿 | `runtimeApply.ts`(새 — 설치 확인 `requireInstalled` 포함), `update.ts`·`init.ts`(보존 사본·다시 설치 안내·바뀐 파일만 쓰기), `core/atomic.ts` `writeIfChanged`, `choiceConfig.ts` |
| 관문·조회·갈래 | `runtimeGate.ts`(새 — hook 의 적용 `applyBeforeOpening`·적용 보고 `APPLY_NOTE` 포함), `cliMain.ts`(`opening`·`version`·update 깃발) |
| 소스 갱신 | `sourceUpdate.ts`(다시 씀 — 소스 폴더는 그대로, 실패 단계 보고, `--release`, 샌드박스 안내 `SANDBOX_BLOCKED`) |
| 선택 UI | `choiceServer.ts`(호출마다 처리기·연결부 기록), `choiceConfig.ts`(진입점) |
| 동의·hook·조회 | `consent.ts`(재시작 문장 삭제·`--consent`), `hook.ts`(버전을 고르는 깃발 거부, `version` 허용, 여는 명령 직전 적용), `commands.ts`(`status` 적용 버전 줄), `doctor.ts`(진입점·적용 버전 점검) |
| 커밋 대상 | `bootstrap.ts`·`deliver.ts`(`templates.json`), `init.ts` `.gitignore`(`runtime.json`·`runtime.lock`·`template-conflicts/`) |
| 지침·문서 | `ca-next`·`ca-status`·Claude `ca-answer` 7항, `template/codex/ca-answer.md`(재시작은 보고에 있을 때만, Codex 적용은 권한 상승), README 업데이트 절 |

## 검증

### 자동 시험

- `sourceUpdate.test.ts` 15개 — 미리보기(로컬만), 설치·적용과 소스 폴더 불변(미커밋 변경이 있어도), 같은 커밋 재빌드·재적용 없음, 의존성 설치·빌드·검증 실패 시 등록·적용 없음, 예약 보고·적용 실패 보고, 점검 실패, 동시 설치(잠금), 끊긴 설치(임시 폴더 무시·정리), 동의 뒤 소스 변경, upstream·detached, 잠금 파일 없음, 지원하지 않는 설치, 실제 npm(오프라인)·공백 경로, worktree, 지정 원격 브랜치만 받기.
- `runtimeRelease.test.ts` 20개 — 실제 릴리스 A·B 로: 작업 없을 때 적용과 다음 hook 전환, 프로젝트별 버전, 진행 중 예약 → 다음 작업에 적용, 여는 명령 직전 hook 의 적용(진행 중·여는 명령이 아님·연결자·하위 에이전트는 적용하지 않음, 적용 보고 한 번), 쓸 수 없는 설치 파일(바뀌지 않았으면 적용, 바뀌어야 하면 되돌리고 예약 유지), 적용 버전 소실, 절대 경로 설치 이행(설정 불변), 설치 중 hook·CLI, 열린 확인과 갱신 동의 자신, 상태 세대 거부, 사람이 고친 사본 보존, 템플릿 반영 도중 실패의 되돌리기, 준비 커밋 대상, 설치되지 않은 폴더 거절, npm 패키지(다음 작업에 복사·적용, 재설치 뒤 진행 중 작업은 사본, `--release` 선택 유지, `--templates-only` 예약·적용, 검증 실패·저장소 쓰기 불가, 설치되지 않은 저장소), MCP 연결부 A·처리 B.
- 전체 `npm test` — 결과는 아래 '검증 수치'.

### 실제 빌드

이 저장소의 변경을 임시 클론에 커밋해 bare upstream·Git 소스 설치본(실제 `npm ci`·build)·대상 프로젝트를 만들고 `updateFromSource`를 실제 git·npm 으로 돌렸다. v2 는 5.2초에 설치·적용(커밋·트리·내용 해시 기록, 개발 의존성 정리, 설치본 불변, 스킬 표지 반영). 공통 문서 세션 중의 v3 는 설치 후 예약되고, 세션이 끝난 뒤 `docs begin`이 v3 를 적용하고 세션을 열었다.

### 최초 이행

이 기능 전 커밋(`299d0d2`)으로 빌드한 Git 소스 설치본과 그 코드로 설치한 프로젝트에서 시작했다. 이전 갱신기가 마지막으로 설치 폴더에서 pull·build 하고 새 CLI 로 템플릿을 적용했다 — 보고는 새 방식(`호스트를 다시 열 필요가 없습니다.`, 바뀐 스킬 6개를 다시 읽으라는 줄)이고, 프로젝트는 고정 없이 진입점 번들로 돈다. 이전 갱신기는 마지막 doctor 의 ✗(빈 프로젝트의 공통 문서 4종)로 STOP 을 보고했다. 그 뒤 upstream 의 새 커밋은 이제 새 코드인 설치본의 `update`가 릴리스 저장소에 설치·적용했고(설치 폴더 HEAD 그대로), 다음 hook 이 그 릴리스로 돌았다.

### 실제 호스트

| 호스트 | 확인한 것 | 결과 |
|---|---|---|
| Claude Code 2.1.299 | 한 `claude -p` 세션의 hook·CLI 전환 | 적용 전 A, 적용 다음 hook·`version`·Stop 이 B. 세션을 다시 열지 않았다 |
| Claude Code 2.1.299 | 스킬 다시 읽기 | 2초 뒤 Skill 호출은 이전 본문, 20초 뒤는 새 본문 → 보고가 파일을 다시 읽게 했다 |
| Claude Code 2.1.299 | 예약 뒤 다음 작업(모델이 부른 `docs begin`) | 직전 PreToolUse hook 이 B 를 적용하고 `docs begin`이 처음부터 B 로 돌았다(첫 줄 `적용 버전: A → B`) |
| codex-cli 0.162.1 (danger-full-access) | 한 `codex exec` 세션의 hook·CLI 전환 | `codex-event`·`version`이 A → B |
| codex-cli 0.162.1 (danger-full-access, 프로젝트 hook 꺼짐) | 다음 작업의 적용 — 명령의 관문 | `docs begin`(A) → B 가 스스로 적용 → `docs begin` 다시 실행(B) → `version` B |
| codex-cli 0.162.1 (workspace-write, unelevated·elevated) | 다음 작업의 적용 — hook | 두 모드 모두 직전 hook 이 B 를 적용(`.agents/` 사본 포함)하고 `docs begin`이 B 로 열렸다. 호스트 밖 터미널이 필요 없다 |
| codex-cli 0.162.1 (workspace-write) | 샌드박스 셸의 제약 | unelevated 는 node 의 자식 프로세스(git·cmd 포함)가 모두 `EPERM`, elevated 는 자식은 뜨지만 `.codex/`·`.agents/` 쓰기가 `EPERM`. hook 은 샌드박스 밖에서 사용자 권한으로 돈다 |
| codex-cli 0.162.1 | 선택 UI MCP 연결부 | `version`이 `연결부 1.0.0-aaaaaaaaaaaa`를 보였다. Codex 가 MCP 에 임의 환경 변수를 넘기지 않아 처음엔 번들로 보였다 → `runtime.json`에 저장소 경로(`home`)를 기록하도록 고쳤다 |

문서·소스 근거로만 둔 것: Claude settings 의 hook 수정은 파일 감시로 반영(공식 문서), 에이전트 정의 변경은 다음 호출부터(공식 문서), Codex `hooks.json`·MCP 설정·에이전트 역할 목록은 세션 시작 때만 읽음(codex-rs 0.162.1 소스).

### 요청한 시나리오

| 시나리오 | 근거 |
|---|---|
| 작업 없을 때 업데이트·적용 | 시험(적용·다음 hook 전환), 실제 빌드 v2, 두 호스트 실측 |
| 작업 중 설치 → 다음 작업 전환 | 시험(예약 → `docs begin`, 여는 명령 직전 hook), 실제 빌드 v3, 두 호스트 실측(Codex 샌드박스 두 모드 포함) |
| 프로젝트별 다른 버전 | 시험 |
| 업데이트 도중 hook·CLI | 시험(임시 폴더·설치 잠금 중 호출은 지금 버전) |
| 설치 실패·중간 종료·동시 업데이트 | 시험(ci·build·verify 실패, 끊긴 임시 폴더, 설치 잠금) |
| 템플릿 사용자 수정·부분 실패 | 시험(보존·`template-conflicts`·되돌리기, 쓸 수 없는 설치 파일) |
| 열린 승인·질문·실행 중 서브에이전트 | 시험(열린 확인은 예약, 갱신 동의 자신은 제외, 하위 에이전트의 셸 명령은 hook 이 적용하지 않음). 실행 중 계획 배정·리뷰는 작업 진행 중이라 `active.json`으로 바쁨 판정된다 |
| 기존 절대 경로 설치·두 호스트 이행 | 시험(`--cli` hook·MCP 설정 불변, hook·`codex-event`가 적용 버전으로), 최초 이행 실측(이전 코드 설치본 → 새 코드 → 일반 갱신) |
| 장시간 MCP 의 실제 버전 | 시험(연결부 A·처리 B·결과의 `runtime`), Codex 연결부 실측 |
| 업데이트 후 검증·반영 게이트 | 시험(바뀐 설치 파일·`templates.json`이 준비 커밋 대상, 개인 기록은 무시) — 게이트 코드는 바꾸지 않았다 |

## 후속 (2026-10-15)

### 설치되지 않은 폴더의 update 거절

`update`의 대상은 실행 위치가 속한 git 저장소의 루트(저장소가 아니면 그 폴더)인데, 템플릿 반영이 `init`을 부르므로 프로젝트 밖의 빈 폴더에서 `update --templates-only`를 실행하면 오류 없이(종료 코드 0) `.claude/`·`CLAUDE.md`·`.gitignore`·`.code-agent/`를 새로 만들었다(이 변경 전 코드도 같다).

- 처리: `runUpdate`가 어느 갈래든 먼저 설치 여부를 본다(`requireInstalled` — `init`이 남기는 `.code-agent/version`·`hosts.json`, 또는 두 호스트의 code-agent hook 등록. `.code-agent/version`은 hook 기반 구조의 첫 커밋 `acd9bba`부터 쓴다). 없으면 쓰기 전에 종료 코드 1로 멈춘다. npm 패키지 진입점이 다음 작업을 열 때 패키지를 들이는 경로도 같은 판정으로 건너뛴다.
- 확인: 시험 2개(저장소 밖·그 하위 폴더·설치하지 않은 저장소의 하위 폴더에서 모든 갈래가 종료 코드 1이고 폴더·릴리스 저장소 불변, 설치된 프로젝트의 하위 폴더는 그 루트를 갱신)와 실제 CLI 의 빈 폴더 실행.

### Codex 샌드박스 안의 다음 작업 적용

처음 구현에서는 다음 작업의 적용을 그 명령(모델의 셸) 안의 관문이 했다. Codex 0.162.1 Windows workspace-write 샌드박스의 셸은 unelevated 면 자식 프로세스를, elevated 면 `.codex/`·`.agents/` 쓰기를 막아 적용이 늘 물러섰다(되돌리기·예약 유지는 맞았다). 또 적용이 내용이 같은 설치 파일도 다시 써서, 바뀌지 않은 `.codex/config.toml` 때문에도 실패했다.

- 처리 — 적용은 내용이 바뀐 설치 파일만 쓰고(`writeIfChanged` — 줄바꿈만 다른 git 체크아웃 사본도 같은 내용), 모델이 셸로 부른 다음 작업을 여는 명령은 그 직전의 PreToolUse hook 이 적용한다(`applyBeforeOpening` — 동작은 [설계 §8](../design.md#8-배포와-대상-저장소)·흐름도 §5.3). 적용 모듈은 적용할 것이 있을 때만 읽는다(`hookLoad.test.ts` 통과). 셸 안 적용이 막혔을 때의 안내(`SANDBOX_BLOCKED`)를 실제 원인(자식 프로세스·`.codex/`·`.agents/` 쓰기)과 할 일로 고쳤다.
- 확인: 시험 2개와 실제 호스트 셋(Claude Code, Codex elevated·unelevated — 위 표). Codex 첫 실측들은 신뢰 키를 슬래시 경로로 넘겨 프로젝트 hook 이 돌지 않았고(실행 기록에 `codex-event`가 없다), Windows 경로로 고친 뒤 hook 이 돌았다 — 2026-10-14 의 샌드박스 실측도 hook 이 꺼진 상태의 결과였다.

## 되돌리기의 범위

[설치 §5](../install.md#5-code-agent-update--갱신)의 '되돌리기와 고정 풀기'가 정본이다. 템플릿은 적용 중 실패만 되돌리고, 적용이 끝난 뒤의 템플릿은 다음 적용(이전 릴리스 선택 포함)이 다시 쓴다.

## 사고

실제 빌드 검증 중 `docs begin` 한 번이 작업 폴더를 지정하지 않아 이 저장소 루트에서 돌았다. `.code-agent/docs-session.json`, `doc/.survey/.gitignore`, `doc/knowledge/` 5개 파일이 생겼다. 모두 추적되지 않은 새 파일이라 그것만 지웠고, 그 뒤 `git status`는 이 작업의 변경만 보인다. 실험 중 한 번은 저장소 위치를 넘기지 않아 사용자 홈에 빈 `~/.code-agent/releases/`가 생겼다(릴리스는 없었다). 비어 있는 것을 확인하고 지웠다. 전체 시험은 이 폴더를 건드리지 않았다(수정 시각 불변).

## 확인하지 않은 것과 남은 제약

- Codex 실제 MCP 폼에서 처리기 전환 — `codex exec`는 폼을 띄우지 못한다. 프로토콜 시험으로만 확인했다.
- Claude settings 의 hook 수정 반영·에이전트 정의 변경 반영 — 문서 근거만. 보통의 적용은 hook 명령이 그대로라 이 경로를 타지 않는다.
- 다시 열어야 하는 Codex 설정, 프로젝트 hook 이 돌지 않을 때 샌드박스 셸 안 적용의 물러섬(예약은 남는다), 이행 첫 회, 진입점 선택 논리, 릴리스 저장소 정리 없음, 단일 실행 파일, 작업 중 단계 경계의 전환 없음은 [설계 §8·§11](../design.md#11-남은-일과-알고-남긴-한계)과 [설치 §5](../install.md#5-code-agent-update--갱신)가 정본이다.
- unelevated 셸은 git 도 띄우지 못해 그 안에서는 code-agent 명령 대부분이 제대로 돌지 않는다 — 업데이트만의 제약이 아니다.
- 이행 첫 회의 이전 갱신기는 마지막 doctor 판정도 이전 코드라, 공통 문서가 없는 프로젝트에서는 적용이 끝났어도 STOP 으로 보고한다.
- 다음 작업을 여는 명령(`docs begin` 등) 자체는 설치되지 않은 폴더에서도 세션 파일을 만든다 — 갱신 범위 밖이라 그대로다.

## 검증 수치

| 항목 | 값 |
|---|---|
| 전체 `npm test`(Windows 11, Node v24.19.0) | 1520개 — 통과 1516, 실패 0, 생략 4(플랫폼 조건), 약 317초 |
| `runtimeRelease.test.ts` + `sourceUpdate.test.ts` | 35개 — 모두 통과 |
| 실제 빌드 설치·적용(Git 소스, 실제 `npm ci`·build) | v2 5.2초, 이행 뒤 일반 갱신 5.3초 |
| 최초 이행(이전 갱신기의 pull·build·템플릿 적용) | 4.6초 |
| 실제 호스트 | Claude Code `claude -p` 세션 약 $0.0046(haiku, 4턴)·$0.0051(3턴). Codex `codex exec` 다음 작업 적용 elevated 14.4초·unelevated 12.4초 |
