# 현재 검증 상태

검증 환경은 Windows 11, Node 24.19.0, PowerShell 5.1.26100이다. [집계 자료](evidence/2026-10-29-validation.json)는 실행별 결과이며 서로 다른 시험 수를 합산하지 않는다. 재현 기준선은 [재현 기준선 자료](evidence/2026-10-29-repro-baseline.json)에 있다.

## 자동 시험

요구 개정(같은 ID 의 변경안·개정 기록·확정·반려 복구)이 닿는 시험 파일을 `node --test`로 묶음별로 실행했다. 실패는 모두 고쳤다.

| 묶음 | 파일 | 결과 | 소요 |
|---|---|---|---:|
| 요구·개정·재현 | `request`·`requestRevisions`·`reproScenarios`·`stageFlow` | 77건 모두 통과 | — |
| 접수·흐름 인접 | `answers`·`codexPermissions`·`cross`·`crossReview`·`dependencyContracts`·`master`·`nodeRuntime`·`process`·`read`·`remaining`·`selection`·`stageFlow`·`consent`·`hookLoad`·`timeline` | 296건 중 295 통과·1 실패 | 340.7초 |
| 문서·템플릿·Codex | `docSync`·`templateBudget`·`templateText`·`hostText`·`hostNotation`·`codex`·`docs`·`scripts`·`knowledgeDocs`·`retryPolicy`·`modelPolicy`·`consentBinding`·`consentOutput`·`assets-doctor-usage` | 303건 모두 통과 | 212.5초 |
| 계획·타임라인 | `planning`·`planningRecovery`·`planningRetry`·`planningCross`·`planningChain`·`timeline` | 143건 모두 통과 | 175.6초 |

- 접수·흐름 인접 묶음의 실패 1건(`stageFlow` 관찰 흐름): 머리말만 바꾼 전체 초안을 "바뀐 것이 없다"고 넘겨 계획 승인이 무효가 되지 않았다. 이제 바뀐 머리말을 알리고 변경안으로 내게 한다. 시험은 변경안 형식으로 바꿨다. 고친 뒤 첫 묶음을 다시 실행했다. 나머지 14개 파일은 이 수정 전 빌드로 실행한 결과다.
- 문서·템플릿 묶음의 첫 실행(파일 4개 동시)은 시스템 메모리 부족으로 중단됐다. 중단 전 `codex`에서 보조 문서 수 고정값 2건이 실패했다(`amend.md` 추가로 Codex 자산 41→42, 보조 문서 15→16). 고정값과 `doc/install.md`를 고친 뒤 위 묶음 두 개를 파일 2개 동시로 다시 실행했다.

이번 변경 뒤 전체 시험은 실행하지 않았다. 마지막 전체 시험은 이 변경 전 코드(`cd8a5f8`)에서 실행했으며 결과는 1807건 중 1803 통과·4 생략·0 실패다. 생략 4건은 플랫폼 조건이다.

## 재현 기준선

[재현 기준선 자료](evidence/2026-10-29-repro-baseline.json)는 개선 전 빌드에서 `scripts/repro-baseline.cjs --repeat 3`으로 남겼다(fixture `sha256:4be6f82c570ee977`, 세 번 모두 같은 사실).

| 시나리오 | 개선 전 사실 | 지금 | 소요 중앙값(전→후) |
|---|---|---|---:|
| `amendment` | 확정한 요구 2개를 같은 ID 의 추가 요구 1개가 대체한다 | 추가 요구만 든 전체 목록 초안은 거부되고 확정 요구가 남는다. 확정 개정을 부모로 한 변경안(추가 1)이 새 개정이 되며 기존 요구 2개를 보존한다. 제출 뒤 미확정, 변경안 화면, 다시 확정 | 17ms → 40ms |
| `staleIds` | 지시서의 요구 ID 는 REQ-1·REQ-2 인데 다시 준비한 분석 배정은 REQ-1 만 가진다 | 같음 — 계획 배정의 개정 연결은 아직 없다 | 18ms → 17ms |
| `completionStall` | 담당 완료 뒤 Stop 이 턴을 잇지 않아 사람 입력이 있어야 다음 행동을 실행한다. 호스트 재개 대기 1건 | 같음 | 2710ms → 2308ms |

`amendment` 시나리오는 이번 계약에 맞춰 바꿨으므로 fixture 해시가 다르다(`sha256:d52666f43939a93d`). 비교 스크립트는 이를 알린다. 이 시나리오의 지시서는 이전 형식으로 두 번 확정돼 있어 첫 변경안 제출 때 개정 2로 옮겨지고 변경안은 개정 3이 된다. 후 결과는 재생성 가능하므로 커밋하지 않는다. `node scripts/repro-baseline.cjs --repeat 3 --out <후.json>` 뒤 `--compare doc/reviews/evidence/2026-10-29-repro-baseline.json <후.json>`으로 다시 만든다. 격리 호스트의 대기 시간은 자식 프로세스 사이 간격이다. 따라서 실제 세션의 대기 시간은 재현하지 않으며, 비교 대상은 Stop 차단 여부·사람 입력 필요 여부·구간 분류다. `reproScenarios.test.ts`는 지금 동작을 고정한다.

## 상태 형식 세대

상태 형식 세대는 17이다. 요구 개정 기록(`.code-agent/approvals/<ID>/requirements.jsonl`)이 생겼고, 확정 원장 줄에 `revision`이 붙는다. 같은 ID 의 재제출은 이제 변경안 형식만 받는다. 이 판정을 모르는 이전 릴리스가 개정 기록이 있는 프로젝트에서 전체 목록 재제출로 확정 요구를 덮지 않도록 세대를 올렸다. 개정 기록이 없는 이전 형식 확정 지시서는 첫 변경안 제출 때 표시된 ID 그대로 옮긴다.

## 템플릿 예산

`node scripts/template-sizes.cjs --suggest`는 LF로 정규화한 글자 수에 파일별 1.03, 흐름 합계 1.02를 곱하고 100자 단위로 올린다. 흐름 예산은 Claude 49200자(현재 48253), Codex 45900자(현재 44958)다. 공통 계획 절차는 `ca-plan/contract.md`에 두며 예산은 4100자다. 검증 기록·비밀 값·언어 규칙을 포함한 CODEX.block 예산은 2200자다. 같은 ID 의 요구 변경안 형식은 접수 스킬 본문 대신 필요할 때만 읽는 `ca-request/amend.md`(1211자, 예산 1300)에 둔다. 접수 스킬 본문은 5514자다(예산 5700). 파일별 상한은 `src/test/templateBudget.test.ts`가 관리한다.

## 배포와 검증 한계

- 패키지 dry-run은 219개 파일이며 `dist/agent/requirementRevisions.js`·`template/claude/skills/ca-request/amend.md`를 포함하고 `dist/test`는 포함하지 않는다. 재현 시나리오와 기준선 스크립트는 이 소스 저장소에서만 실행된다.
- 요구 개정은 접수·확정·반려 복구까지다. 다음은 아직 연결하지 않았다.
  - 확정 개정이 바뀐 뒤 진행 중 흐름의 커서·계획 배정(`requirements`·`inputs`)
  - 실행 회차(완료한 같은 ID 의 새 회차)
  - 상태 출력의 개정·회차 표시
  - 타임라인 줄의 개정·회차 필드
- 실제 Claude·Codex 호스트에서의 타임라인 기록은 확인하지 않았다. 확인 범위는 격리된 가짜 호스트와 hook 입력이다. 미확인 대상은 메인 대화 기록의 완료 알림 표지와 Codex UserPromptSubmit 시각이다.
- 구현·테스트 담당(`ca-implementer`·`ca-tester`)에는 SubagentStart·Stop hook 이 등록돼 있지 않다. 그래서 담당 실행 구간 없이 인계(`agent.assigned`)와 다음 명령으로만 보인다. Codex 의 완료 알림은 관측하지 않는다.
- 실제 모델·유료 평가는 호출하지 않았다. 자동 회귀를 실제 사람 승인·전체 모델 완주·사용자 사용성의 증거로 해석하지 않는다. 실제 호스트 동작 설명에 붙은 버전은 관찰 조건이며 지원 최소 버전을 뜻하지 않는다.
