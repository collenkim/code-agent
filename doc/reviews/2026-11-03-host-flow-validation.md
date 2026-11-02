# 호스트 흐름 검증

최종 정리일: 2026-11-03.

Windows, Node 24.19.0, PowerShell에서 검증했다. 이번 실행은 자동 시험과 기존 증거의 읽기 전용 대조이며 새 유료 호스트 실행은 하지 않았다. master-agent의 임대 소유 판정은 범위 밖이다.

## 결과와 범위

| 항목 | 원인·조치 | 검증·남은 한계 |
|---|---|---|
| 동의 전문 | 전문 표시 지침은 있었지만 질문 hook은 세션·질문 결속만 확인했고, 짧은 선택 화면을 열기 전 표시 근거를 검사하지 않았다. CLI가 실제 문서·파일 링크를 summary에 넣고 Claude 첫 질문 전에 같은 메인 세션의 준비 이후 일반 응답 전문을 확인한다. 누락 시 질문과 상태 변경을 막고 원래 toolInput 재시도를 안내한다. | `consentPresentation`은 부분 요약·thinking·도구 결과·다른 세션·옛 글·질문 뒤 글을 거부하고, 전문 출력 뒤 질문·응답을 받는다. 원본 Claude 기록의 setup/request/deliver 세 호출도 새 판정에서 모두 전문 누락이다. 실제 호스트의 기록 flush 시점·재시도와 UI 렌더링은 새 코드로 확인하지 않았다. |
| Codex 전체 평가 | HEAD만 보던 준비 판정이 실행 정책 파일 변경을 놓쳤다. 제품의 pendingBaselineFiles로 준비 커밋을 맞추고 두 턴 연속 진척이 없으면 중단한다. 현재 Codex 비대화형 정책에는 작업 브랜치·통합 worktree의 Git 권한 응답 경로가 없어 유료 호출 전 명확하게 거부한다. | `evaluationDriver`에서 기존 HEAD 뒤 execution.json 반영·준비 반복 방지, 조회 로그/heartbeat 제외, 문서·작업·승인 변경 인식, 호스트 호출 전 지원 불가 종료를 검증했다. 전체 Codex 평가를 성공시킨 것이 아니다. fixture는 준비 커밋·최종 반영까지만 처리하고 사람 승인으로 기록하지 않는다. 한국어 조건을 프롬프트에 명시했지만 언어 준수는 실모델 미확인이다. |
| Claude 실행 권한 | hook 설치와 호스트 명령 허용은 별개인데 설치 안내·진단이 없었다. init 결과·설치 문서·doctor에 프로젝트/local 규칙과 실효 권한 확인 방법을 안내한다. 허용 규칙은 자동 추가하지 않는다. | `claudePermissions`는 기존 allow/deny와 local 설정 보존을 검증했다. 평가의 setting-sources와 allowedTools를 보고하고 재개 시 같은 조건을 유지한다. 관찰된 17회·9종은 project만 읽은 특정 실행의 결과이며 신규 사용자 공통 최소치가 아니다. 새 사용자 확인 횟수는 재측정하지 않았다. |
| 실행 절차 TC | writer의 완료 조건 전사 지침과 plan의 절차 TC 금지 사이에 모호함이 있었다. 설계 AC·계획 TC·배정 제출 전 점검을 맞추고 구체적 동작 TC 하나에 기능 AC·테스트 작성 AC를 함께 연결하도록 했다. | `resultContracts`는 다중 AC를 연결한 실제 입력·반환/오류 TC 및 실행기 자체의 종료 코드 TC를 통과시키고 전체 테스트 실행/통과 TC는 계속 거부한다. critic을 제거하거나 낱말 기반 검사를 넓히지 않았다. 실제 Claude의 재작성 감소는 미측정이다. |
| Codex pending finish | Codex ca-answer의 pending→confirm 계약과 ca-integrate에서 변환된 매 질문 finish 지시가 충돌했다. ca-integrate는 호스트별 동의 절차에 위임하고, MCP 결과는 pending에 confirm의 도구·인자, approved에 finish 명령을 next·guide로 반환한다. | `choiceServer`는 항목 선택 pending→최종 동의 approved 두 호출과 적용 원장 미생성을, `templateText`는 두 호스트 반영 스킬의 공통 finish 지시 제거를 검증한다. 최종 Git 반영 권한은 유지한다. 실제 모델이 중간 finish를 생략하는지는 미확인이고 통합 검증의 샌드박스 실패를 해결한 것으로 보지 않는다. |
| 호출 표식 | 두 호스트가 보존한 호출 토큰 형태가 다르고 추적기는 이를 일반 원문처럼 취급했다. 독립 첫 줄 호출은 표식으로 분리하며 한 줄 요청은 선두 토큰만 INVOCATION으로 명시한다. 원문과 뒤의 업무 문자열은 보존한다. | `intakeInvocation`·`request`에서 두 호스트 표식, 한 줄 명시 연결, 인용·업무 속 반복·유사 토큰 보존, 실제 제출/확정과 원문 렌더를 검증했다. sourceMap이 정확히 한 개 줄어든다는 주장은 하지 않는다. 새 연결 대상을 이해하지 못하는 릴리스 적용을 막도록 상태 세대는 23이다. |

`Invalid tool parameters`는 Claude `q04.txt`에서 거부와 원래 toolInput 재호출 회복을 확인했다. 성공한 호출은 대화 기록에 있지만 거부된 원시 인자는 없어 필드별 원인은 확정하지 않는다. 정확한 질문 결속 검사는 유지하며 새 테스트에서 본문을 바꾼 입력을 거부한다. 호스트 스키마 단계에서 거절된 호출은 hook에 도달하지 않을 수 있으므로 이 검사로 모든 도구 입력 오류가 없어졌다고 주장하지 않는다.

## 자동 시험

- 관련 회귀: 109건 통과, 실패·생략 없음(26.58초). 동의 표시·출력, 평가, 권한, 접수, TC, MCP 선택, 문서·템플릿 동기화와 크기 검사다.
- 최종 빌드의 전체 `npm test`: 1925건 중 통과 1905·실패 16·플랫폼 조건 생략 4, 벽시계 605.4초(시험 604.24초). `tsc` → 옛 dist 시험 산출물 정리 → 파일 단위 최대 4개 병렬이며 샌드박스 밖에서 실행했다. 실패는 상속된 Codex 샌드박스 환경 표지 때문에 가짜 app-server를 조회하지 않는 4개 파일에 한정됐다.
- 같은 빌드에서 `codex`·`codexPermissions`·`codexReadiness`·`masterCodex` 4개 파일을 `hostBaseEnv`로 호출 호스트 표지만 분리한 자식 환경에서 재실행했다. 49건 전부 통과, 실패·생략 없음, 벽시계 34.4초(시험 34.24초). 실제 모델을 호출하거나 제품의 권한 판정을 바꾸지 않았다. 중복 실행 건수를 합산하지 않은 최종 확인은 **1921건 통과·4건 생략·미해결 실패 0**이며 단일 `npm test` 전체 성공으로 표시하지 않는다.
- 샌드박스 안에서의 최초 전체 실행은 Windows 프로세스 조회·종료 제한과 위 환경 표지로 실패했다. 그 결과를 제품 회귀나 통과 근거로 혼합하지 않았다. 빌드와 문서 공백 검사도 통과했다.
- 템플릿 예산을 올리지 않았다. Claude 흐름 48777/49200자, Codex 흐름 45261/45900자(LF 기준). 변경한 전문 표시·후속 안내·접수 규칙은 기존 상한 안에 둔다. 세부 테스트 수정 절차는 `ca-test/repair.md`, 요구 변경 형식은 `ca-request/amend.md`, 공통 계획 절차는 `ca-plan/contract.md`에서 필요할 때 읽는다. 파일별 상한의 정본은 `templateBudget.test.ts`다.

## 증거와 미확인 범위

원본은 수정하지 않았다. 화면·권한·입력 기록의 루트는 `C:\Users\kai\AppData\Local\Temp\claude\C--IdeaProjects-code-agent\6ed0bbdf-96a3-477d-923b-6697446735f8\scratchpad\review2`다. Claude는 `interactive/run2`, Codex는 `interactive/codex1`, 비대화형 평가는 `codex-ca`를 대조했다. 원본 실행 저장소는 `ca-interactive-full-M905c1`, `ca-full-codex-tui-prv1Mj`, `ca-full-enhance-VQOb6X`이며 새 자동 시험은 별도 임시 저장소에서 수행했다. 원본 대화형 선택도 평가자의 선택이며 실제 업무 승인 검증과 구분한다.

실제 UI의 전문·링크 렌더링, Claude 기록의 hook 도착 시점, 모델의 지침 준수·언어·반복 권한 횟수, Codex 전체 흐름과 최종 권한 요청 횟수, Claude 깨우기 hook의 실제 개입, Codex TUI 경고 내용, macOS·Linux는 이번에 검증하지 않았다. 합성 대화/MCP fixture는 사람 승인이나 실제 UI 증거가 아니다. [보존한 호스트 측정](2026-11-01-validation.md)의 버전·조건과 이번 코드를 혼동하지 않는다.
