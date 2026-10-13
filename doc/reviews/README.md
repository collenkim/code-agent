# 문서·검증 이력

현재 동작은 [프로세스 흐름도](../process-flow.md), [README](../../README.md), [사용 가이드](../usage.md), [설계](../design.md), [계획 작업](../planning.md), [요구사항](../requirement.md), [설치](../install.md), [플러그인](../plugins.md), [Codex 연동](../codex.md)을 기준으로 읽는다. 아래 기록은 변경 경위와 검증 결과이며, 기록의 시험 수를 현재 결과와 합산하지 않는다.

| 날짜 | 기록 | 범위 |
|---|---|---|
| 2026-10-13~14 | [오류 사전 판별·질문 UI·맥락·토큰 결과 요약](2026-10-13-result-summary.md) | `a4b6df8`..`cd0550b` 열한 커밋과 그 뒤 결함·토큰 중간 항목·요구 확정과 시작 합치기 커밋 — Sentry·로그 사전 판별과 중복·재발, 차단 복구·단계별 선택, Windows `.cmd`, 동의 Git 설정 오탐, Codex MCP 선택 UI, 선택 화면 크기, Codex 세션 시작 상태 주입·계획 담당 staging·계획 상세 조회 축약, 토큰 사용 측정 보완과 출력·리뷰·템플릿 축약, `init` 인자 검사·스킬 머리말 YAML·토큰 검토 중간 항목 열 가지(계획 결과 파일·재배정 문서 미리 넣기·왕복 감소 등), 요구 확정 적용의 작업 시작. 실제 호스트 확인(Codex 0.162.1 폼 조작·적용, 두 호스트 PTY 화면, Codex 세션 시작·staging), 출력·템플릿 측정, 예산 근거, 최종 `npm test` 1,431개 중 1,427개 통과·실패 0·생략 4 |
| 2026-10-08 | [절차 보완·재시도 규약·최적화 결과 요약](2026-10-08-procedure-fix-summary.md) | 감사와 그 뒤 구현·검토·후속 수정 전체(`c4f3fbf..HEAD`)의 사용자 결정, 커밋, 실패 원인 21종, 묶음별 변경, 역할별 모델, 최적화 실측, 감사 160건 처리 현황, 실제 호스트 확인(claude 2.1.293·codex-cli 0.161.0)과 그 불일치 H1~H12 반영, 반영 뒤 재확인과 검증 지적·재검증 지적 반영, 남은 일. 최종 `npm test`는 1,357개 중 1,353개 통과·실패 0·생략 4다 |
| 2026-10-07 | [Claude·Codex 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md) | 코드 수정 없는 감사 — 두 호스트 동등성·절차·동의·검증·자기학습·최적화·하네스 원칙을 대조한 지적 160건(high 7). 프로세스 흐름도와 개발 에이전트 진입점(`AGENTS.md`·`CLAUDE.md`)을 만들었다 |

원자료는 `evidence/`에 있다 — 감사는 [process-audit-2026-10-07.json](evidence/process-audit-2026-10-07.json), 결과 요약은 [procedure-fix-2026-10-08.json](evidence/procedure-fix-2026-10-08.json)(처리 현황 160건·커밋·시험·실측)이고, 2026-10-12~14 는 [2026-10-13-result-summary.json](evidence/2026-10-13-result-summary.json)(커밋별 시험·실제 호스트 화면·출력 크기와 템플릿 측정)이다.

**지운 기록은 git 이력에서 본다.** `c4f3fbf` 이전 기록(2026-10-01~06 기록 15개와 그 evidence)과 결과 요약으로 합친 2026-10-07~08 단계 기록 10개·evidence 의 마지막 판은 `68d7a00`의 트리에 있다. 결과 요약으로 합친 2026-10-12~13 기록 11개와 evidence 12개의 마지막 판은 `7ade5a6`의 트리에, 그 요약과 빈곳 보완·토큰 최적화 기록(3개)·evidence 2개의 마지막 판은 `cd0550b`의 트리에 있다. 옛 기록의 색인은 `c4f3fbf`의 것이다. 문서 정리(`4c5ca83`)가 현행 문서에서 지운 상태 표·실측(설계 §11 의 구현 순서 P1~P8 표와 P3 실측 기준치 등)도 `68d7a00`의 그 문서에 있다.

```sh
git show c4f3fbf:doc/reviews/README.md                         # c4f3fbf 이전 기록의 색인
git ls-tree --name-only c4f3fbf doc/reviews/ doc/reviews/evidence/
git show c4f3fbf:doc/reviews/2026-10-06-token-efficiency.md     # 옛 기록 하나
git show 68d7a00:doc/reviews/2026-10-08-full-review.md          # 합친 단계 기록 하나
git show 68d7a00:doc/design.md                                  # 지운 상태 표·실측이 있던 설계 문서
git ls-tree --name-only 7ade5a6 doc/reviews/ doc/reviews/evidence/  # 합친 2026-10-12~13 기록
git ls-tree --name-only cd0550b doc/reviews/ doc/reviews/evidence/  # 결과 요약으로 합친 2026-10-13 기록 3개
```

정리 원칙:

- 변경된 현재 동작은 정본 문서와 설치 템플릿에 함께 반영한다. 현행 문서에는 경위를 쓰지 않는다.
- 기록은 그 시점의 실패·생략·한계를 포함해 쓴다. 단계마다 남긴 기록은 작업이 끝나면 결과 요약으로 합치고, 지운 기록은 위처럼 그 커밋에서 찾는다.
- 최신 회귀와 모델 완주·사용성 실측은 분리해 기록한다.
- `dist/`의 빌드·실행 로그는 재생성 가능한 로컬 산출물이다. 커밋에는 소스·정본·요약 근거를 포함한다.
