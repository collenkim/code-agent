# 문서·검증 이력

현재 동작은 [프로세스 흐름도](../process-flow.md), [사용 가이드](../usage.md), [설계](../design.md)를 기준으로 읽는다. 아래 기록은 변경 당시의 근거·검증 결과·한계다. 서로 다른 시점의 시험 수를 합산하지 않는다.

| 날짜 | 변경·검증 기록 | 최종 근거 |
|---|---|---|
| 2026-10-22 | [대시보드 요청의 작업 임대 판정 통일](2026-10-22-dashboard-lease.md) — `c75f7a8` | [임대·재개·적용 뒤 동의 정리 회귀](evidence/2026-10-22-dashboard-lease.json) |
| 2026-10-21 | [대시보드 확인 설치·프로젝트별 적용](2026-10-21-dashboard-update.md) — `e193ad2` | [설치·적용·거부·확인 기록 회귀](evidence/2026-10-21-dashboard-update.json) |
| 2026-10-21 | [계획 파일 작업·담당 되돌림·낡은 질문 대기 복구](2026-10-21-workflow-recovery.md) — `d6ca2d9` | [회귀 시험](evidence/2026-10-21-workflow-recovery.json) |
| 2026-10-21 | [대시보드 확인 PC 신뢰](2026-10-21-dashboard-trust.md) — `4e81965` | [회귀·master-agent 상호 운용·브라우저](evidence/2026-10-21-dashboard-trust.json) |
| 2026-10-21 | [master 요청의 실행 방식 선택](2026-10-21-run-execution.md) — `5adbb97` | [회귀·master-agent 상호 운용](evidence/2026-10-21-run-execution.json) |
| 2026-10-20 | [PC 신뢰와 대시보드 페어링](2026-10-20-dashboard-pairing.md) — `1841a89` | [회귀·master-agent 상호 운용](evidence/2026-10-20-dashboard-pairing.json) |
| 2026-10-20 | [Codex 관리 실행의 Git 실행 권한](2026-10-20-codex-git-permission.md) — `1c6e403` | [실제 Codex 평가·회귀](evidence/2026-10-20-codex-git-permission.json) |
| 2026-10-20 | [종료 독립 세션 복원과 실제 모델 검증](2026-10-20-session-recovery-live.md) — `a78c51a` | [회귀·실제 모델 집계](evidence/2026-10-20-session-recovery-live.json) |
| 2026-10-20 | [Codex 관리 실행과 명시적 호스트 인계](2026-10-20-managed-hosts.md) — `a4986c7` | [감독·재개·인계·전체 회귀](evidence/2026-10-20-managed-hosts.json) |
| 2026-10-19 | [대시보드 사람 응답과 실행 호스트 선택](2026-10-19-dashboard-interactions.md) — `91105a1` | [전체 회귀·실제 프로세스 통합](evidence/2026-10-19-dashboard-interactions.json) |
| 2026-10-19 | [실행 구조 검토와 접수 ID·종류 보존](2026-10-19-architecture-identity.md) — `54f443c` | [회귀·장애 주입](evidence/2026-10-19-architecture-identity.json) |
| 2026-10-19 | [브랜치별 작업 커서·임대 보존과 설정 준비](2026-10-19-branch-resume.md) — `99da682` | [자동 회귀·대상 조회](evidence/2026-10-19-branch-resume.json) |
| 2026-10-16 | [외부 계약 인계·답 출처·응답 형식·요구와 테스트 연결](2026-10-16-dependency-contracts.md) — `8085647` | [정상·거부 사례](evidence/2026-10-16-dependency-contracts.json) |
| 2026-10-16 | [LangGraph 전체 실행 전환](2026-10-16-langgraph.md) — `cb0c466` | [그래프·회귀 검증](evidence/2026-10-16-langgraph.json) |
| 2026-10-16 | [Node 실행·빌드 버전 통일](2026-10-16-node-runtime.md) — `c2ccccb` | [런타임·빌드 검증](evidence/2026-10-16-node-runtime.json) |
| 2026-10-15 | [master 연동·실행 감독·위임 판단](2026-10-15-master-control.md) | [자동 시험·실제 CLI·Claude 실행](evidence/2026-10-15-master-control.json) |
| 2026-10-14 | [릴리스 설치·프로젝트별 적용·템플릿 보존](2026-10-14-release-update.md) | [실제 빌드·호스트 확인](evidence/2026-10-14-release-update.json) |
| 2026-10-12~14 | [오류 사전 판별·질문 UI·토큰·지식·외부 연결·재시도](2026-10-13-result-summary.md) | [회귀·호스트·측정 결과](evidence/2026-10-13-result-summary.json) |
| 2026-10-08 | [절차 보완·재시도 규약·최적화](2026-10-08-procedure-fix-summary.md) | [감사 처리·시험·실측 결과](evidence/procedure-fix-2026-10-08.json) |
| 2026-10-07 | [Claude·Codex 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md) | [감사 지적 원자료](evidence/process-audit-2026-10-07.json) |

작업이 끝나면 중간 기록을 최종 요약에 합치되 실패·생략·미확인 범위와 템플릿 예산 근거는 남긴다. 자동 회귀, 실제 모델 완주, 사용자 실측은 구분한다. `dist/`의 재생성 가능한 빌드·실행 로그는 커밋하지 않는다.

정리된 중간 기록은 Git 이력에서 찾는다. 삭제된 파일은 삭제 직전 커밋의 경로로 읽는다.

```sh
git log --all --oneline -- doc/reviews/
git log --all --diff-filter=D --summary -- doc/reviews/
git show <커밋>:<파일경로>
```
