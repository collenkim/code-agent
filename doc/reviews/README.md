# 문서·검증 이력

현재 동작은 [README](../../README.md), [사용 가이드](../usage.md), [설계](../design.md), [계획 작업](../planning.md), [요구사항](../requirement.md), [설치](../install.md), [플러그인](../plugins.md), [Codex 연동](../codex.md)을 기준으로 읽는다. 아래 기록은 각 변경 시점의 근거이며 과거 테스트 수를 현재 결과와 합산하지 않는다.

| 순서 | 기록 | 범위 |
|---|---|---|
| 최신 · 2026-10-02 | [계획 실행 효율과 역할별 모델 설정](2026-10-02-planning-efficiency.md) | 결과 전달 축소·절차 통합·형식 교정·호스트별 모델 기본값·변경·검증 |
| 2026-10-02 | [Codex 지원](2026-10-02-codex-support.md) | 호스트별 설치·훅·사용자 동의·기준 커밋·회귀 |
| 2026-10-02 | [요구 분석·설계·계획 작업](2026-10-02-planning-orchestration.md) | 관찰된 배정·병렬 조사·입력 변경·독립 검토·구현 Task·회귀 |
| 2026-10-02 | [검증 노드 실행기](2026-10-02-verification-workflow.md) | program·agent·human 구분, check·test 연속 실행, 실패 인계·재개, 전체 회귀 |
| 2026-10-02 | [같은 세션 확인과 소스 업데이트](2026-10-02-session-confirmation-update.md) | consent·질문·업데이트·설치·문서 보완 |
| 2026-10-01 | [검증·리뷰 보완](2026-10-01-validation-review-improvements.md) | TC 결과·독립 리뷰·통합 검증 |
| 2026-10-01 | [선택지와 리뷰 언어](2026-10-01-selection-review-language.md) | 선택지·사용자 언어·리뷰 안내 |
| 2026-10-01 | [프로세스 개선](2026-10-01-process-improvements.md) | 접수·계획·실행 흐름 보완 |
| 2026-10-01 | [프로세스 검토](2026-10-01-process-review.md) | 문제 조사와 초기 검증 |

검증 원자료는 `evidence/`에 보관한다. 최신 실행 결과는 [planning-efficiency-2026-10-02.json](evidence/planning-efficiency-2026-10-02.json)이며 전체 회귀는 709개 중 705개 통과·실패 0·생략 4개다. 앞선 Codex 지원 결과는 [codex-support-2026-10-02.json](evidence/codex-support-2026-10-02.json), 계획 작업 결과는 [planning-orchestration-2026-10-02.json](evidence/planning-orchestration-2026-10-02.json)에 보관한다. 앞선 검증 노드 결과는 [verification-workflow-2026-10-02.json](evidence/verification-workflow-2026-10-02.json), 이전 종합 실측은 [final-validation-summary.json](evidence/final-validation-summary.json)이다. 후자는 2026-10-01 당시 기록으로 보존하며 최신 회귀 결과로 간주하지 않는다.

Codex 추가 전 계획 작업 검증의 고유 범위는 680개 중 676개 통과·실패 0·생략 4개다. 당시 전체 회귀와 후속 검사의 구분은 해당 계획 작업 보고서에 보존했다. Codex 지원 이후의 결과는 최신 원자료와 보고서를 따른다.

앞선 Codex 지원 최종 고유 검증 범위는 695개 중 691개 통과·실패 0·생략 4개다. 당시 전체 회귀의 안내 문구 기대값 실패 1개는 수정 후 동일 사례로 재검증했고, 최종 설치 검사 68개도 통과했다. 실행별 수치는 당시 보고서에 분리했다.

정리 원칙:

- 변경된 현재 동작은 정본 문서와 설치 템플릿에 함께 반영한다.
- 과거 보고서와 evidence는 해당 시점의 실패·생략·한계를 포함해 보존한다.
- 최신 회귀와 과거 모델 완주·사용성 실측은 분리해 기록한다.
- `dist/`의 빌드·실행 로그는 재생성 가능한 로컬 산출물이다. 커밋에는 소스·정본·요약 근거를 포함한다.
