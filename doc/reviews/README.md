# 문서·검증 이력

현재 동작은 [프로세스 흐름도](../process-flow.md), [README](../../README.md), [사용 가이드](../usage.md), [설계](../design.md), [계획 작업](../planning.md), [요구사항](../requirement.md), [설치](../install.md), [플러그인](../plugins.md), [Codex 연동](../codex.md)을 기준으로 읽는다. 아래 기록은 각 변경 시점의 근거이며 과거 테스트 수를 현재 결과와 합산하지 않는다.

| 순서 | 기록 | 범위 |
|---|---|---|
| 최신 · 2026-10-08 | [최적화 — hook 지연 로드·동의 왕복·계획 연쇄·측정·템플릿 예산·테스트 분할](2026-10-08-optimization.md) | hook 경로의 명령 모듈 지연 로드(PreToolUse 104→95ms·Codex 112→97ms, hook 그래프 63→45 모듈)와 그래프·로드 실패 시험(hookLoad). `usage` 호출 통계·명령별 호출·스킬 읽기·재시도 기록(읽기만)·Codex 세션 집계(형식 미확인)·`--json`, 평가 보고서 필드와 반복 실행 요약. 동의 인라인 준비(`--action`)·호스트별 출력(`--for` — 준비 출력 −51~57%)·적용 결과의 `next`. 계획 advance 의 `next` 줄(action별 행동의 원천)·연쇄 `--chain`(program 게이트만, 실패·거부 자동 재시도 없음)·계획 스킬 공통 항목·`CODEX_SENTENCES`·접수 출력 정리·자리 확인·ca-answer 조건부 읽기와 SessionStart 재확인·Task 완료 판정(PVR-19). context 렌더러 분리(출력 바이트 동일)와 서브에이전트용 절의 메인 절차 문장 정리, 템플릿 크기 예산 시험. 시험 파일 분할(p5·p6 을 주제별 8개로, `npm test` 208→112초, 시험 수 그대로). 독립 검토 반영 — 연쇄 거부의 질문 수는 질문 거부일 때만, 연쇄 출력의 지금 스테이지(`chain.to`), 재시도 절의 옛 기록, Codex 셸 래퍼, `usage` 의 하위 폴더 서브에이전트, 담당 hook 의 읽지 못한 stdin 도 2, 세션 밖 기다리는 동의의 SessionStart 재확인, 지연 로드 실패·실제 advance 출력·인라인 목록 시험, `template-sizes --ref-dist`, hook 시간·status 크기·템플릿 크기 기록을 한 번의 측정으로. `npm test` 1265개 중 1261개 통과·실패 0·생략 4 |
| 2026-10-08 | [단계 전이·CLI 안내·반영 범위·동시 사용](2026-10-08-stage-flow.md) | deliver 의 쓰기 거부와 되감기(사용자 지시 back·증거 무효면 check), 승인 무효의 재진입 안내(낡은 계획 작업 단계로 되감기 또는 그 자리 재승인), start 사전 검사와 접수 경고, 작업당 대상 하나, 준비 동의 선택(setup·docs·baseline), doctor 작업 중 허용, 호스트별 CLI·hook 표기(Claude 바이트 동일·예외 셋), 반영 커밋의 handoff·staging·잠금 제외, 작업 임대(다른 세션 거부·세션 시작 넘겨받기·takeover), 원인별 `다음:` 의 원천 정리, 전체 1187개 중 1183개 통과·실패 0. 독립 검토 반영 — 매니페스트 없는 문서 세션의 `다음:`(`/ca-adopt`), hook 읽기·쓰기 도구 표기와 `code-agent read` 허용(상태 읽기 실패·hook 설정), 압축(compact)은 임대를 넘겨받지 않음, `next`의 승인 무효 재진입 문장(implement 이후 전부), deliver 증거 무효의 `다음:`, 진행 중 다중 대상 재제출 안내, `update`의 설치 파일 계획 밖 변경 알림, ca-next 빈 줄·재개표, 문서 인용·오류 표. `npm test` 1197개 중 1193개 통과·실패 0·생략 4 |
| 2026-10-08 | [동의·업무 답 관찰·hook 경계](2026-10-08-consent-hook-boundary.md) | 동의 쪽 재시도 규약(실패 기록 `failure{class,kind}`·갈래별 안내·대상 변경 폐기·연속 대상 변경 경고·공통 잠금), 스냅샷 범위(`consents/`·`log/`·`lease.json*` 제외·링크 해시·내용 해시 캐시), 준비·적용 티켓과 준비 세션 결속·열린 동의 창, Codex 확인 코드, 사람 판단 동의 `judgment`(카운터별 사람 허용 `retryGrant.ts`·지적 기각·교차 중지 연결), 업무 답 관찰(`[Source]: 대화`·답 출처 게이트·화면 절), 문서 세션 범위 고정·KNOWLEDGE `.md` 한정, 승인 화면 경계 절·재승인 diff, 소스 update 확인, hook 경로 판정(Grep·Glob·Windows 별칭·MCP·hook 설정)·hook 누락 감지와 시작 게이트, 동의 영수증·원장 끝줄 대조, hook 진입 최소 구조와 실패 코드 표 연결. 독립 검토 반영 — 경로 `~` 전개·Windows 별칭(IPv6 리터럴·주소·(dev, ino), 셸의 끝 점·8.3)·소스 update 꼴과 호스트 셸 거부·같은 Q 번호의 답만 관찰·하위 폴더 적용 결속·judgment 지연 로드·문서 한계 문장. `npm test` 1134개 중 1130개 통과·실패 0·생략 4 |
| 2026-10-07 | [교차 검증 무결성](2026-10-07-cross-integrity.md) | 교차 시도·리뷰어 실행의 append-only 기록과 완료 지점 재실행 거부, `review.json` 잠금 저장(`mutateReview`), 교차 실패의 원인별 분류(오류 채널만 — 실행 불가만 중지)·지점·원인별 재실행 한도·형식만 교정·샌드박스 사전 판정·같은 호스트 거부·9분 제한·교차 자식 hook 통과·F→X 정규화, 리뷰어 동시 호출·재호출 무시와 기록 전 표 규칙 검사, 사람 판단 함수(동의 배선은 C5), ⑩·커밋 메시지 교차 줄·커밋 실패 시 KNOWLEDGE 되돌림, `doctor --cross`, 독립 검토 반영(Codex 세션 분류는 마지막 `ERROR:` 줄만·알 수 없는 spawn 오류·표지 없는 샌드박스 네트워크 의심, 지점 호스트는 실제로 띄운 첫 시도, 옛 교차 결과 형식 교정, 계획 파생 사본·수정 피드백을 게이트 보기로, 계획 게이트 안내, 교차 자식 PreToolUse 진행·쓰기 거부, 사람 허용 예산 시험) |
| 2026-10-07 | [역할별 모델·추론 강도](2026-10-07-role-models.md) | Claude 판단 opus/high·실행 sonnet/medium 정책(`ROLE_POLICY`), 머리말 `effort`, `models.json` 예약 키 `effort`와 이전 버전 호환, `model --effort`, 동의 스냅샷의 모델 정책, doctor·update 보고, 단가표 sonnet-5-5·fable-5와 모델별 usage. 구현 검토 반영(설정 파일을 쓰기 전에 검사, 강도 미지원 이전 모델 ID, doctor·동의 안내, 평가 스크립트 resume). A/B 실측은 미실행(측정 도구만) |
| 2026-10-07 | [검증 재시도 — 원인별 카운터](2026-10-07-verify-retry.md) | 검증 회차를 원인별 카운터(고쳐 쓰기·수집 수정·같은 코드 재실행·리뷰 회차·총 회차)로 나누고 한 판정 함수로 통일, 환경 분류·시간 초과·동결 시작과 증거 대조·체크아웃별 worktree 표지·바이트 해시·재현 시도 한도, 독립 검토 반영(통합 검증 재개 안내·지운 test 상태·⑧ 렌더·로그 근거 뒤 재현 갱신·표지 회수 가드) |
| 2026-10-07 | [계획 오케스트레이션 재시도 규약 연결](2026-10-07-planning-retry-orchestration.md) | 질문 출처·자동 되감기(같은 사유에 한 번)·고아 배정 정리·완료 hook 되돌림과 결정적 문서 검사·같은 입력 실패 3회·작업별 총 배정 6회·공통 잠금·질문 본문 구조 필드 검사·업무 규칙 KNOWLEDGE 연결·후보 순위 절단 제거, 입력 해시 골든 고정, 독립 검토 반영(늦은 결과·고아 표시 범위·출처 확인 반복·크기 한도·되돌린 보고·직전 실패·검증된 질문 출처·한도 문구) |
| 2026-10-07 | [Claude·Codex 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md) | 코드 수정 없는 감사. 두 호스트 동등성·절차·동의·검증·자기학습(헤르메스 대비)·최적화·하네스 원칙 대조, 지적 160건(high 7), 프로세스 흐름도와 개발 에이전트 진입점(`AGENTS.md`·`CLAUDE.md`) 작성 |
| 2026-10-06 | [AI-DLC 공존·교차 검증·결함 2단계](2026-10-06-coexistence-cross-defects.md) | 같은 브랜치 AI-DLC 차단·경고, Claude·Codex 교차 계획 검토·코드 리뷰, SubagentStop 반복·worktree 정리·손자 프로세스·절대 경로·잠금·CRLF 원장·키 경로 등 결함 수정, 두 호스트 실측 |
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

검증 원자료는 `evidence/`에 보관한다. 최신 감사 원자료는 [process-audit-2026-10-07.json](evidence/process-audit-2026-10-07.json)이다. 코드 변경이 없는 감사이며, 같은 기준 커밋 `c4f3fbf`의 `npm test` 단일 전체 실행은 **802개 중 798개 통과·실패 0개·생략 4개**(133초)로 아래 최종 결과와 같다. 최신 수정 결과는 [coexistence-cross-2026-10-06.json](evidence/coexistence-cross-2026-10-06.json)이다. `npm test` 단일 전체 실행은 **786개 중 782개 통과·실패 0개·생략 4개**였고, 후속(환경 오류 분류·로그 기반 fix·교차 검증 중지) 뒤 최종 전체는 **802개 중 798개 통과·실패 0개·생략 4개**다. 두 호스트 실측([full-flow-new-2026-10-06-opus-both.json](evidence/full-flow-new-2026-10-06-opus-both.json))은 실제 Codex 교차 계획 검토 두 번과 Claude 교차 계획 검토 한 번을 확인했고, Codex 워크스페이스 사용 한도로 계획 단계에서 멈춰 코드 리뷰 교차는 실제 호스트로 확인하지 못했다.

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
