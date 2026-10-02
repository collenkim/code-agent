# 검증 노드 실행기 도입

변경일: 2026-10-02. [전체 문서·검증 이력](README.md).

기능 커밋: `7bf8b38` — `feat: add verification workflow nodes and reasoning handoffs`.

## 요청과 적용 범위

단계별로 추론이 필요한 작업과 코드로 실행할 작업을 나누는 노드 구조를 도입했다. 초기 적용 범위는 정적 검증·테스트·결과 판정·수정 요청·재검증이다. `verify`가 program 노드를 연속 실행하고 agent·human 노드에서 메인 에이전트에 작업 요청을 반환한다.

## 변경 결과

| 항목 | 결과 | 구현 근거 |
|---|---|---|
| 노드 실행 주체 | program·agent·human 판별 공용 실행기, 선언된 전이만 허용 | `src/core/workflow.ts` |
| 연속 검증 | check → 게이트 → test → TC 판정 → review를 한 CLI 호출로 처리 | `src/agent/verificationFlow.ts`, `cli.ts` |
| 실패 인계 | 실제 실패는 repair, 실행·결과 수집 문제는 diagnose, 한도 초과는 decision | `verificationFlow.ts` |
| 재개 | 현재 입력·회차·승인·증거를 재검사. 같은 실패는 자동 반복하지 않음 | `verificationFlow.ts` |
| 재검증 | 코드 변경 또는 명시적 --retry 시 check부터 회차 증가 | `verificationFlow.ts`, 기존 `validate.ts` |
| 수정 한도 | 명령 exit 0이어도 필수 TC 미확인이면 한도와 쓰기 제한 적용 | `src/agent/evidence.ts` |
| 실행 이력 | 호출별 입력 해시·노드 실행·대기·오류·인계 결과 기록 | `<대상>.verification-flow.json` |
| 기존 흐름 | check·test·next 단일 명령과 승인·범위·동결·독립 리뷰 게이트 재사용 | 기존 commands·evidence·hook |
| 스킬 연결 | 전체 흐름에서 verify 사용, 리뷰 이동 후 next 중복 호출 방지 | ca-check·ca-test·ca-next·CLAUDE 블록 |

program은 모델 호출 없이 코드를 실행한다. agent 작업의 추론 강도나 모델 선택은 이번 변경에 포함하지 않았다. human 노드는 질문·재계획 절차로의 인계이며 승인을 자동 생성하지 않는다.

## 검증

전체 `npm test`는 **658개 중 654개 통과·실패 0개·생략 4개**로 완료했다(121개 suite, 약 477초). 전체 회귀 로그는 `dist/verification-flow-full.log`에 보관한다. 생략 4개는 기존 Windows 파일명 대소문자 구분·Unix 권한 검사다.

초기 표적 검사는 13개 중 11개 통과·2개 실패였다. 두 실패는 테스트 fixture에서 스키마가 허용하지 않는 `fixRounds: 0`을 사용한 것이며, 최소 허용값 1과 두 회차 검증으로 수정했다. 위 전체 회귀에서 모두 통과했다. 당시 로그는 `dist/verification-flow-targeted.log`다.

전체 회귀 후 CLI JSON·종료 코드, 실행 도중 중단된 회차 복구, 명령 미선언 검사 3개와 decision의 `/ca-answer` 안내를 추가했다. 후속 검사에서 미선언 명령을 참조하던 테스트 준비 문서를 수정한 뒤 **노드 통합 검사 15개 + 공용 실행기 검사 3개, 총 18개 모두 통과**했다(약 58초, `dist/verification-flow-final2.log`). 수정 전 후속 로그는 `dist/verification-flow-final.log`에 보존한다.

최종 검증 범위는 **총 661개 중 657개 통과·실패 0개·생략 4개**다. 단일 전체 재실행 수치가 아니라 전체 658개와 신규 3개를 합친 범위이며, 후속 검사 중 중복 15개는 더하지 않았다. 구조화된 근거는 [verification-workflow-2026-10-02.json](evidence/verification-workflow-2026-10-02.json)에 있다.

최종 빌드, TypeScript 타입 검사, `git diff --check`도 통과했다. README와 doc 아래 Markdown 13개의 상대 파일 링크를 검사하여 누락 0개를 확인했다.

검증 항목은 정상 연속 실행, 실패 후 수정·재검증, check 실패 시 test 미실행, 실행 오류, TC 미확인과 한도, 변경 없는 실패의 재개, check 후 중단 복구, 이전 회차 test 재사용 차단, 명시적 retry, 승인·범위·질문 게이트, 이력 손상, 선언되지 않은 전이 차단이다.

## 문서 정리

README와 사용·설계·요구사항·설치·플러그인 문서에 현재 동작을 반영했다. 설치 템플릿의 전체 흐름과 단일 단계 실행을 구분했다. `doc/reviews/README.md`를 문서·검증 이력의 진입점으로 만들고 과거 보고서·실측 근거는 원래 시점의 기록으로 보존했다.

## 한계와 후속 범위

실제 Claude Code 대화의 토큰·시간 절감량과 사용자 조작은 이번 자동 테스트로 측정하지 않는다. CLI와 임시 Git 저장소의 실제 명령·게이트·상태를 검증한다. 분석·설계·구현·통합 검증 전체를 노드화하거나 모델 API를 직접 호출하는 기능은 추가하지 않았다. 한 작업의 여러 세션 동시 실행은 지원 범위로 검증하지 않았다.
