# 문서·검증 이력

현재 동작은 [README](../../README.md), [사용 가이드](../usage.md), [설계](../design.md), [계획 작업](../planning.md), [요구사항](../requirement.md), [설치](../install.md), [플러그인](../plugins.md), [Codex 연동](../codex.md)을 기준으로 읽는다. 아래 기록은 각 변경 시점의 근거이며 과거 테스트 수를 현재 결과와 합산하지 않는다.

| 순서 | 기록 | 범위 |
|---|---|---|
| 최신 · 2026-10-06 | [AI-DLC 공존·교차 검증·결함 2단계](2026-10-06-coexistence-cross-defects.md) | 같은 브랜치 AI-DLC 차단·경고, Claude·Codex 교차 계획 검토·코드 리뷰, SubagentStop 반복·worktree 정리·손자 프로세스·절대 경로·잠금·CRLF 원장·키 경로 등 결함 수정, 두 호스트 실측 |
| 2026-10-06 | [동의 스냅샷의 외부 hook 간섭 수정](2026-10-06-consent-snapshot.md) | 무시된 외부 세션·캐시 제외, 필수 설정·문서와 준비 커밋 대상 보호, 변경 경로 진단, 접수 중 도움말 |
| 2026-10-06 | [도입·반영·도메인 경계 결함 수정](2026-10-06-workflow-boundaries.md) | 기존 저장소의 준비 커밋과 시작 전 검사, 무시된 문서 반영, fix/refactor 도메인 경계, 실제 Git·테스트 기반 전체 흐름과 문서 최신화 |
| 2026-10-06 | [메인 컨텍스트 토큰 효율](2026-10-06-token-efficiency.md) | 상시 지침 축소·전달 파일·staging·SessionStart·consent finish, 회귀 수정, Opus 전체 흐름 비교와 Codex 실제 분석·영향도, 비용 집계 정정 |
| 2026-10-02 | [Codex 훅 복구와 실제 완료](2026-10-02-codex-hook-recovery.md) | Windows 신뢰 키·부모 기록·파일 읽기·지침 충돌 수정, 두 호스트 실제 분석·영향도 내용 게이트 통과 |
| 2026-10-02 | [우선순위 2와 Codex 실제 검증](2026-10-02-priority-two-native-codex.md) | 작은 조사 통합·작업별 입력·동일 결과 재사용·당시 실제 호스트 검증 한계 |
| 2026-10-02 | [계획 실행 효율과 역할별 모델 설정](2026-10-02-planning-efficiency.md) | 결과 전달 축소·절차 통합·형식 교정·호스트별 모델 기본값·변경·검증 |
| 2026-10-02 | [Codex 지원](2026-10-02-codex-support.md) | 호스트별 설치·훅·사용자 동의·기준 커밋·회귀 |
| 2026-10-02 | [요구 분석·설계·계획 작업](2026-10-02-planning-orchestration.md) | 관찰된 배정·병렬 조사·입력 변경·독립 검토·구현 Task·회귀 |
| 2026-10-02 | [검증 노드 실행기](2026-10-02-verification-workflow.md) | program·agent·human 구분, check·test 연속 실행, 실패 인계·재개, 전체 회귀 |
| 2026-10-02 | [같은 세션 확인과 소스 업데이트](2026-10-02-session-confirmation-update.md) | consent·질문·업데이트·설치·문서 보완 |
| 2026-10-01 | [검증·리뷰 보완](2026-10-01-validation-review-improvements.md) | TC 결과·독립 리뷰·통합 검증 |
| 2026-10-01 | [선택지와 리뷰 언어](2026-10-01-selection-review-language.md) | 선택지·사용자 언어·리뷰 안내 |
| 2026-10-01 | [프로세스 개선](2026-10-01-process-improvements.md) | 접수·계획·실행 흐름 보완 |
| 2026-10-01 | [프로세스 검토](2026-10-01-process-review.md) | 문제 조사와 초기 검증 |

검증 원자료는 `evidence/`에 보관한다. 최신 결과는 [coexistence-cross-2026-10-06.json](evidence/coexistence-cross-2026-10-06.json)이다. `npm test` 단일 전체 실행은 **786개 중 782개 통과·실패 0개·생략 4개**다. 두 호스트 실측([full-flow-new-2026-10-06-opus-both.json](evidence/full-flow-new-2026-10-06-opus-both.json))은 실제 Codex 교차 계획 검토 두 번과 Claude 교차 계획 검토 한 번을 확인했고, Codex 워크스페이스 사용 한도로 계획 단계에서 멈춰 코드 리뷰 교차는 실제 호스트로 확인하지 못했다.

앞선 [consent-snapshot-2026-10-06.json](evidence/consent-snapshot-2026-10-06.json)의 동의 스냅샷 수정 후 `npm test` 단일 전체 실행은 **759개 중 755개 통과·실패 0개·생략 4개**다. 집중 검사 19개는 중복 합산하지 않는다. 외부 hook 파일 쓰기와 질문 이벤트는 자동 fixture이며, Git·파일 시스템·준비 커밋은 실제 실행이다. 실제 AI-DLC 엔진/사람 질문 화면과 대형 저장소 성능은 별도 검증 범위다.

앞선 [workflow-boundaries-2026-10-06.json](evidence/workflow-boundaries-2026-10-06.json)의 당시 최종 고유 확인 범위는 **740개 중 736개 통과·미해결 실패 0·생략 4개**다. 최초 전체 실행은 730개 통과·6개 실패·4개 생략이었고, 기존 테스트의 준비 절차를 보완한 뒤 같은 실패 사례 6개가 모두 통과했다. 단일 전체 재실행 결과로 혼동하지 않으며 겹치는 집중 검사 12개·80개를 합산하지 않는다. 기능 추가·fix·refactor의 Git·테스트·통합·로컬 반영은 실제로 실행했지만 승인·리뷰 관찰은 자동 fixture이며 실계정 모델 실행과 구분한다.

앞선 [token-efficiency-2026-10-06.json](evidence/token-efficiency-2026-10-06.json)은 전체 회귀 729개 중 725개 통과·실패 0·생략 4개를 기록한다. 2026-10-01 전체 흐름 기록의 비용 합계는 누적값을 더한 과대 집계이며 정정값은 그 보고서에 있다. 그 전 결과는 [codex-hook-recovery-2026-10-02.json](evidence/codex-hook-recovery-2026-10-02.json)이다. 전체 회귀는 720개 중 716개 통과·실패 0·생략 4개이며, 파일 읽기·Codex 집중 검사 20개와 최종 템플릿 설치 검사 2개도 통과했다. Codex는 실제 분석·통합 영향도 및 피드백 보완 뒤 내용 게이트를, Claude는 실제 분석·분할 조사·영향도 정리와 내용 게이트를 통과했다. 초기 동의는 합성 fixture이며 전체 개발·사람 승인 실측과 구분한다. 겹치는 자동 검사 수와 실계정 검사를 합산하지 않는다.

앞선 [priority-two-native-codex-2026-10-02.json](evidence/priority-two-native-codex-2026-10-02.json)은 당시 전체 회귀 716개 중 712개 통과·실패 0·생략 4개, 후속 집중 검사 56개와 39개 통과를 기록한다. 당시 실제 Codex 연동과 Claude 통합 영향도 완료는 확인하지 못했다. 이번 복구가 이전 실패 기록을 소급해 성공으로 바꾸지는 않는다.

앞선 계획 효율·모델 설정 결과는 [planning-efficiency-2026-10-02.json](evidence/planning-efficiency-2026-10-02.json)의 709개 중 705개 통과·실패 0·생략 4개다. Codex 지원 결과는 [codex-support-2026-10-02.json](evidence/codex-support-2026-10-02.json), 계획 작업 결과는 [planning-orchestration-2026-10-02.json](evidence/planning-orchestration-2026-10-02.json), 검증 노드 결과는 [verification-workflow-2026-10-02.json](evidence/verification-workflow-2026-10-02.json)에 보관한다. 이전 종합 실측 [final-validation-summary.json](evidence/final-validation-summary.json)은 2026-10-01 당시 기록이며 최신 회귀 결과로 간주하지 않는다.

Codex 추가 전 계획 작업 검증의 고유 범위는 680개 중 676개 통과·실패 0·생략 4개다. 당시 전체 회귀와 후속 검사의 구분은 해당 계획 작업 보고서에 보존했다. Codex 지원 이후의 결과는 최신 원자료와 보고서를 따른다.

앞선 Codex 지원 최종 고유 검증 범위는 695개 중 691개 통과·실패 0·생략 4개다. 당시 전체 회귀의 안내 문구 기대값 실패 1개는 수정 후 동일 사례로 재검증했고, 최종 설치 검사 68개도 통과했다. 실행별 수치는 당시 보고서에 분리했다.

정리 원칙:

- 변경된 현재 동작은 정본 문서와 설치 템플릿에 함께 반영한다.
- 과거 보고서와 evidence는 해당 시점의 실패·생략·한계를 포함해 보존한다.
- 최신 회귀와 과거 모델 완주·사용성 실측은 분리해 기록한다.
- `dist/`의 빌드·실행 로그는 재생성 가능한 로컬 산출물이다. 커밋에는 소스·정본·요약 근거를 포함한다.
