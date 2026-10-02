# 같은 세션 확인과 소스 업데이트 보완

검토일: 2026-10-02. 기존 구현을 기준으로 별도 터미널 확인을 요구하던 경로와 업데이트 절차를 보완했다. 과거 검증 기록은 해당 시점의 결과로 유지한다.

## 변경 결과

| 문제 | 변경한 동작 | 구현 근거 |
|---|---|---|
| 문서·기준 커밋 확인을 위해 다른 터미널로 이동 | 현재 Claude Code 질문에서 POLICY 4종과 필요한 최초 기준 커밋을 함께 확인 | `src/agent/consent.ts`, `bootstrap.ts`, `docsCommands.ts` |
| 요구·계획·결과 확인 후 다음 명령을 기억해야 함 | 같은 세션에서 선택을 관찰하고 적용한 뒤 원래 흐름으로 복귀. `/ca-next`는 중단 후 재개 | `template/claude/skills/ca-answer/SKILL.md`, 나머지 17개 스킬, `template/CLAUDE.block.md` |
| 지식 문서·모델·플러그인·작업 종료에 별도 CLI 필요 | 동일 확인 경로 제공. 지식 항목 선택을 먼저 받고 최종 확인 후 반영 | `consent.ts`, `deliver.ts`, `plugins/commands.ts`, `tty.ts` |
| 전송 중 질문·답을 가공하면 승인 근거가 달라짐 | CLI의 `toolInput` 전체를 전달. 질문·메타데이터·세션·호출·작업 경로 일치 검사 | `consent.ts`, `init.ts`, `hook.ts` |
| Windows PowerShell 도구에서 세션 검사가 누락 | Bash와 PowerShell에 동일한 명령 검사 적용 | `init.ts`, `hook.ts`, `src/test/consent.test.ts` |
| 사용자 지정 메인 에이전트를 서브에이전트로 오인 | `agent_type`만으로 거부하지 않고 `agent_id`로 서브에이전트 판별 | `consent.ts`, `src/test/consent.test.ts` |
| 지식 제안 건너뜀 안내가 JSON 출력에 혼입 | 안내는 stderr로 출력하고 준비 결과의 stdout은 JSON 유지 | `deliver.ts` |
| 반영 후 일부 도입 설정을 별도 커밋해야 함 | 존재하는 version·models.json·docs.jsonl도 최종 표시와 명시적 커밋 경로에 포함 | `deliver.ts`, `src/test/consent.test.ts` |
| 업데이트에 pull·설치·빌드·적용을 따로 실행 | 로컬 Git 소스 설치에서 `update` 한 번으로 fetch·fast-forward pull·필요 의존성 설치·빌드·새 CLI 적용·doctor | `sourceUpdate.ts`, `cli.ts`, `src/test/sourceUpdate.test.ts` |

별도 서버나 MCP 연결은 추가하지 않았다. 사용자 질문은 Claude의 내장 `AskUserQuestion`, 상태 관찰은 로컬 hook, 테스트는 기존 프로젝트 명령을 사용한다. 직접 TTY 명령은 원하는 사용자를 위한 보조 경로로 유지한다.

## 진행 순서

1. 문서·계획·결과를 작성한 뒤 실행할 action JSON을 허용된 문서 경로에 만든다.
2. `consent prepare`로 대상과 질문을 고정하고 사용자에게 요약과 파일 링크를 보여 준다.
3. 반환된 `toolInput` 전체로 질문한다. 메인이 응답을 미리 채우거나 hook을 직접 호출하지 않는다.
4. hook이 관찰한 응답을 `consent status`로 확인한다. 남은 질문이 있으면 다음 묶음을 표시한다.
5. `approved`일 때만 `consent apply`로 기존 동작을 실행하고 다음 단계로 이어간다.

초기 준비, 요구사항 확정, 계획 승인, 최종 반영을 한 번에 묶어 승인하지 않는다. 각 시점에 완성된 대상을 검토한다. 업데이트 적용 후에는 새 hook을 읽도록 Claude Code를 다시 열어야 한다.

## 확인 조건과 실패 처리

- 미응답·취소·보류·수정 요청·시간 초과·추가 질문·조건부 메모를 승인으로 간주하지 않는다.
- 질문이 시작된 세션과 작업 경로, 실제 호출 ID, 질문·선택지·응답을 대조한다. 답을 미리 채운 호출은 거부한다.
- 준비 전후와 질문·적용 시점의 파일·설정·Git 상태를 비교한다. 변경되면 새 확인을 받는다.
- 동시 적용을 잠금으로 직렬화하고, 적용 완료 요청은 기록된 결과를 반환한다. 실패한 요청은 자동 재실행하지 않는다.
- 플러그인 키는 기존 환경변수의 이름으로 참조하며 질문·작업 JSON·확인 기록에 값을 넣지 않는다. 설명이 바뀌면 다시 확인한다.
- 최종 반영은 기존 요구사항·계획·테스트·리뷰·통합 검증을 다시 검사하고 명시한 파일만 커밋한다. 관련 없는 스테이징 파일은 보존한다.
- 업데이트는 upstream이 없거나 소스에 미커밋 변경·진행 중 Git 작업·분기 이력이 있으면 중단한다. reset·임의 병합·자동 stash를 하지 않는다.
- 빌드 또는 doctor 실패는 실패 단계와 이미 완료된 단계를 구분해 보고한다. 자동 롤백을 했다고 표시하지 않는다.
- Git 소스가 없는 npm 패키지·단일 실행 파일은 원격 주소를 추정하지 않는다. 해당 배포 방식으로 교체한 뒤 `update --templates-only`를 사용한다.

## 검증 결과

`npm run build`와 전체 `npm test`를 실행한 뒤 영향받은 파일을 재검증했다. 최종 범위는 **총 643개 중 639개 통과 · 실패 0개 · 생략 4개**다. 첫 전체 실행에서는 630개 통과·9개 실패·4개 생략이었다. 실패 9개는 이전 터미널 안내·hook 개수·도입 설정 커밋 범위를 기대하던 검사였다. 기대값을 현재 동작에 맞춘 뒤 p5·p6·p7 파일 전체를 다시 실행하여 230개 통과·실패 0개·생략 2개를 확인했다. 단일 전체 재실행 결과로 혼동하지 않도록 두 로그를 보존한다: `dist/session-full-regression.log`, `dist/session-affected-regression.log`.

생략한 전체 4개는 Windows에서 수행하지 않는 파일명 대소문자 구분 2개와 Unix 권한 2개이며 통과 수에 포함하지 않았다.

별도 소스 업데이트 테스트 15개도 통과했다(`dist/source-update-test.log`). 전체 회귀 실행에 동일 테스트가 포함되므로 통과 수를 중복 합산하지 않는다. HTML은 PC·모바일의 가로 넘침, 이미지·목차, SVG 글자 경계 검사와 화면 육안 검토를 수행했다. 최종 구조·언어 검사 결과는 `dist/blog-final-audit.json`에 기록한다.

테스트 근거 파일:

- `src/test/consent.test.ts`, `consentFixture.ts`: 정상 확인, 잘못된 전송, 응답 누락, 재생·중복 적용, 파일 변경, 문서·초기 기준·요구·계획·반영, 다른 스테이징 파일 보존.
- `src/test/plugin-confirmation.test.ts`: 미리보기, 인증 변수, 키 노출 방지, 등록 실패, 설명 변경.
- `src/test/sourceUpdate.test.ts`: 로컬 bare Git 원격으로 fast-forward·실패 경로, 새 CLI 실행, 공백 경로, offline npm ci·prepare·build, Git worktree 설치.
- 기존 설치·진단·접수·단계·검증·반영 테스트와 18개 스킬 설치 검사.

## 문서와 HTML

README, 사용 가이드, 설치·설계·요구사항·플러그인 문서를 같은 사용 흐름으로 맞췄다. 블로그와 Downloads의 작업 흐름 HTML도 갱신하고, 흐름도 두 장에 같은 세션 확인을 반영했다. PC 1440px·모바일 390px에서 가로 넘침·이미지 누락·내부 링크를 검사한다.

## 검증의 한계와 후속 확인

질문 전송 테스트는 실제 코드에 합성 hook 이벤트를 전달한 자동 검사다. 이번 작업에서 실제 사람이 Claude 질문 화면을 조작해 처음부터 끝까지 수행한 결과는 아니다. 설치된 Claude Code 2.1.287의 도구 응답 형식과 기존 기록, [공식 hook 문서](https://code.claude.com/docs/en/hooks)를 확인했다. 관찰 기록은 신뢰하는 로컬 도구의 실행 근거이며 사용자 신원 인증이나 OS 보안 경계는 아니다.

실제 초보자 사용성, 중단 후 재개, 여러 프로젝트 크기에서의 스냅샷 비용과 질문 표시량, 토큰·시간 측정은 후속 실측이 필요하다. 자동 업데이트는 격리된 로컬 Git 원격과 offline 의존성 예제로 검증했으며 사용자의 실제 원격 저장소를 pull하거나 다른 프로젝트에 적용하지 않았다.
