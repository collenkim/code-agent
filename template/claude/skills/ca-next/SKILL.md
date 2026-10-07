---
name: ca-next
description: 중단된 code-agent 작업을 현재 위치부터 재개한다 — 같은 세션의 질문·동의를 처리하고 적용 뒤 다음 단계로 자동으로 이어간다.
---

**질문·동의** — 사람에게 묻거나 승인·확정·반영을 받기 직전에 `.claude/skills/ca-answer/SKILL.md`를 읽고 그 절차(`AskUserQuestion`·같은 세션 동의)를 따른다. 일반 답변은 승인이 아니며, 적용 뒤에는 이 흐름을 자동으로 이어간다.

너는 **메인 에이전트**다. `code-agent` 가 거부하면 사유를 그대로 전하고 멈춘다.
사용자에게 진행은 **준비 → 요구 확인 → 계획 확인 → 개발·검증 → 결과 확인**의 5단계로 요약한다. 내부 스테이지 명령 목록을 매번 나열하지 않는다. 멈출 때는 이유와 지금 할 일 하나만 보여준다. 답변을 받았거나 승인이 이미 기록됐으면 현재 상태를 읽고 자동으로 이어간다.

이 명령은 **중단된 흐름의 재개용**이다. 승인 적용 뒤의 자동 진행에 사용자 재입력은 필요 없다. 스테이지마다 무엇을 하는지는 전부 **단계 스킬**에 있고 여기서는 순서만 돈다 —
한 스테이지씩 끊어 보고 고치고 싶으면 표의 명령을 직접 부른다. 어느 쪽이든 읽는 절차는 같은 파일 하나다.

| 스테이지 | 단계 명령 | 절차 |
|---|---|---|
| 접수 (작업 시작 전) | `/ca-request` | `.claude/skills/ca-request/SKILL.md` — `요구사항: 확정됨` 이면 `code-agent start doc/work/<ID>/requirement.md` 로 시작하고 `analysis` 로 잇는다 |
| `analysis` | `/ca-analyze` | `.claude/skills/ca-analyze/SKILL.md` |
| `impact` | `/ca-impact` | `.claude/skills/ca-impact/SKILL.md` |
| `design` | `/ca-design` | `.claude/skills/ca-design/SKILL.md` |
| `plan` | `/ca-plan` | `.claude/skills/ca-plan/SKILL.md` |
| `implement` | `/ca-implement` | `.claude/skills/ca-implement/SKILL.md` |
| `check` | `/ca-check` | `.claude/skills/ca-check/SKILL.md` (**↺ 수정 루프**가 여기 있다) |
| `test` | `/ca-test` | `.claude/skills/ca-test/SKILL.md` |
| `review` | `/ca-review` | `.claude/skills/ca-review/SKILL.md` |
| `integrate` · `deliver` | `/ca-integrate` | `.claude/skills/ca-integrate/SKILL.md` |

1. Bash: `code-agent status` — 지금 스테이지를 확인한다. 작업이 아직 시작 전이고 접수 중이면 표의 첫 줄이 그 자리다.
   접수 중 `다음:`이 프로젝트 준비(`/ca-adopt`·`/ca-docs`·공통 문서 확정)를 가리키면 준비부터 한다.
   해당 스킬을 읽고 원문과 접수 ID를 유지한 채 이어간다. 최초 준비는 `setup` 공통 동의 절차로 문서 전체 확정과 필요한 준비 커밋(최초 커밋 또는 기존 저장소의 도입 파일 반영)을 한 질문으로 확인받는다. 적용 성공 후 접수로 돌아온다.
   `다음:`이 `code-agent docs end`이면 그 명령으로 준비 세션을 닫고 같은 접수를 이어간다.
   계획 단계(`analysis`~`plan`)이면 `code-agent planning status`도 본다. 실행 중으로 기록된(`run`이 있는) 배정이 이 대화에서 부른 담당의 것이 아니면(대화를 새로 열었거나 재개했다) 그 결과는 이 대화로 돌아오지 않는다 — 다른 터미널에서 실행 중이 아니면 그 ID마다 `code-agent planning cancel <ID>`를 실행한 뒤 단계 스킬의 `planning advance`로 다시 배정한다.
2. 표에서 그 스테이지의 절차 파일을 읽고 **그대로 따른다.** 자리 확인은 1 에서 이미 했으니 다시 하지 않는다.
3. 그 스킬이 게이트(`code-agent next`)를 지났으면 — 접수라면 요구사항이 확정돼 `code-agent start` 로 시작했으면 —
   안내만 찍고 끝내지 말고 **다음 스테이지의 절차로 이어 간다** — 2 로 돌아간다.
   `check`·`test`의 전체 흐름은 ca-check에 정의된 `code-agent verify --json`을 사용한다. 실행기가 반환한 노드가 현재 위치다. `review`이면 `/ca-review`로 이어가고 이미 통과한 check·test·next를 반복하지 않는다. `repair`·`diagnose`·`decision`이면 해당 인계 절차를 따른다. 중단 후에도 같은 verify를 호출하면 현재 증거로 재개 위치를 계산한다.
4. 일반 업무 질문과 승인 질문을 분리한다. 승인은 `ca-answer`의 **같은 세션 동의 절차**로 처리하며, 적용 후 현재 상태부터 계속한다. 취소·보류·필수 질문 미응답·명령 거부에서는 멈추고 사유를 전한다:
   - 요구사항을 제출했다 · 확정 뒤 바뀌었다 → `request` 동의를 준비하고 승인된 동의 적용 후 분석 또는 필요한 재계획으로 이어간다
   - 요구사항이 반려됐다 → `/ca-request` 의 **반려됐다면** 으로 간다
   - 답 없는 질문이 생겼다 → 공통 선택 절차를 바로 실행한다. 답을 기록하면 현재 스킬로 복귀하고, 필요한 답이 없을 때만 멈춘다.
   - 계획을 제출했다 → `plan` 동의를 준비하고 승인된 동의를 적용한다
     (**이미 `승인 approved`** 면 멈추는 자리가 아니다 — 커서만 `plan` 에 남아 있으니 `code-agent next` 로 넘기고 `implement` 부터 잇는다)
   - 계획이 반려됐다 (`승인 rejected`) → `/ca-plan` 의 **반려됐다면** 으로 간다
   - 계획 밖 실패·지적 → 덮지 않고 보고한다. 한도 초과·고아 배정·동의 실패는 아래 표
   - `code-agent` 명령이 거부했다 → 사유를 그대로 전한다
   - 커서가 `deliver`다 → `/ca-integrate`의 반영 준비와 `deliver` 동의 절차를 따른다. 지식 선택을 마친 뒤 최종 승인된 동의만 적용한다. 사용자가 반영 전에 수정을 요청하면 아래 표의 deliver 행
   - 동의 대상이 바뀌었다 · 수정 요청이다 → 이전 UUID를 적용하지 않고 수정 후 새 동의를 준비한다
   - `update` 동의를 적용했다 → 결과를 보고하고 멈춘다. 갱신된 hook을 로드하도록 Claude Code 재시작을 안내하며 재시작 후에만 재개한다
**멈춘 자리별 재개** — status 의 `다음:` 이나 명령 출력이 아래에 해당하면 이 표가 먼저다. `다음:` 의 원인별 안내를 그대로 따르고, 같은 명령을 스스로 반복하지 않는다.

| 상태 | 처리 |
|---|---|
| 작업·접수 없음 | `/ca-request` — 공통 문서가 없거나 미확정이면 `다음:` 이 가리키는 준비(`setup`·`docs`·`baseline` 동의)부터 |
| 접수 없이 문서 세션만 열림 | `/ca-docs` 로 마저 쓰고 Bash: `code-agent docs end` — 그 뒤 `다음:` 의 `setup`·`docs`·`baseline` 동의 |
| AI-DLC 차단 줄이 있음 | 진행하지 않는다. 그 줄의 안내를 사용자에게 전하고 멈춘다 |
| 승인 무효(`승인 stale-*`·`unverified`·`none`) | `다음:` 의 재진입 순서대로 — 낡은 계획 작업이 있으면 `code-agent back <단계>` → 그 단계 스킬로 계획 작업 재실행 → `plan submit` → `plan` 동의, 없으면 지금 자리에서 `plan` 동의. `다음:` 이 두 갈래(계획을 바꿔야 하면 / 그대로면)를 보이면 바뀐 문서·지시서가 계획에 닿는지 사용자에게 한 줄로 알리고 고른다. 이 되감기는 사용자 지시 없이 한다 |
| 계획 배정 `stale`·`다음:` 의 `[배정 식별 불일치·고아 실행]`(실행 중으로 기록된 배정) | 기다리지 않는다. 이 대화에서 아직 호출하지 않은 배정이면 지금 호출하고, 호출했던 배정이면 Bash: `code-agent planning cancel <ID>` 뒤 `code-agent planning advance` |
| `다음:` 의 `[담당 출력 형식 오류]`·`[담당 결과 내용 오류]` | Bash: `code-agent planning advance` 의 `action`·`reasons` 를 따른다(형식 교정·수정 피드백 재배정·사람 판단). 같은 배정을 스스로 다시 부르지 않는다 |
| 계획 advance `rewind-required` | `rewind.auto` 가 true 면(`rewind.notice` 가 있으면 그 한 줄을 먼저 알리고) `rewind.command` 뒤 그 단계 스킬. false 면 되감지 말고 사유를 보고하고 지시를 받는다 |
| 원인 `limit-exceeded`(한도 초과)·`verify` 의 `decision` | 자동 재시도를 멈춘다. 막힌 이유·기록 경로를 보고하고, 사용자에게 `judgment` 동의(`retry-grant`)·재계획·abort 중 고르게 한다 |
| 지적 기각·막힌 교차 지점 중지를 사람이 정할 자리(출력이 `judgment` `waive-finding`·`cross-stop` 을 안내) | 그 안내대로 사용자에게 `judgment` 동의를 묻는다. 모델이 스스로 기각하거나 중지로 기록하지 않는다 |
| 동의가 `failed`(대상 변경·적용 중단 — `consent status` 의 `failure.guide`, `다음:` 의 `[동의 …]`) | 같은 ID 를 다시 묻거나 적용하지 않는다. `failure.guide` 대로 — 적용 중단이면 `code-agent status` 와 `git status` 로 반영 상태를 확인하고 새로 `prepare` 한다 |
| 다른 세션이 진행 중이라는 거부 | 같은 명령을 다시 실행하지 않는다. 사용자에게 저쪽 세션(호스트)을 끝냈거나 멈췄는지 묻고, 그렇다고 하면 Bash: `code-agent takeover` 뒤 `code-agent status` 부터. 저쪽에서 계속한다면 이 세션은 멈춘다 |
| 세션 시작 요약의 `이 세션이 작업 진행 기록을 넘겨받았습니다` | 그대로 이어간다. 이전 세션이 아직 열려 있을 수 있으면 사용자에게 한 줄로 알린다(그쪽 진행 명령은 거부된다) |
| 커서가 `deliver` 인데 사용자가 수정을 요청 | 반영 단계에서는 고치지 않는다. 되감기를 확인받고 `code-agent back check`(계획을 바꿔야 하면 `back plan`) → 수정 루프 → 리뷰 새 회차 → 통합 → 반영 |

5. 끝나면 무엇을 만들었는지(파일 목록)와 다음 할 일을 짧게 보고한다.

**되감기** — 사용자가 이전 스테이지로 돌아가자고 하면 Bash: `code-agent back <스테이지>` 를 돌리고 그 스테이지의 절차부터 다시 사이클을 돈다.
무엇이 무효가 되는지는 그 명령이 찍는다 — 그대로 전한다. 사이클이 스스로 되감지는 않는다 — 예외는 승인 무효의 재진입(위 표, 사용자 지시 없이), 계획 `planning advance` 의 자동 되감기(`rewind-required`·`rewind.auto: true`, 사용자 지시 없이), deliver 의 수정 요청(사용자 확인 뒤)이다.
(검증 실패로 `check` 로 돌아가는 것은 되감기가 아니다 — `code-agent check` 가 커서를 데려간다.)
