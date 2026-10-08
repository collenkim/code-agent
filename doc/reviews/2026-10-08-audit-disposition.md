# 감사 160건 처리 현황 (2026-10-08)

[2026-10-07 이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md)의 지적 160건이 어디서 처리됐는지 적는다. 원자료는 [audit-disposition-2026-10-08.json](evidence/audit-disposition-2026-10-08.json)이다. 판정은 감사 뒤 구현 전체(ff13950 다음부터)를 문서 관점 독립 검토가 지적마다 코드·단계 기록과 대조한 것이고, [전체 검토 반영](2026-10-08-full-review.md)에서 처리한 항목을 더했다.

## 요약

| 상태 | 수 | 뜻 |
|---|---|---|
| 반영 | 86 | 지적한 결함·드리프트를 고쳤다 |
| 일부 | 27 | 핵심은 고쳤고 남은 부분을 메모에 적었다 |
| 범위 밖 | 34 | 사용자가 정한 이번 범위 밖이다 — 자가 학습 보류(사용자 결정), HX-5 경량 경로 제외(사용자 결정), 실제 모델 호출 금지(이번 규칙), 그리고 다섯 갈래(절차 결함·재시도 규약·최적화·역할별 모델·교차) 어디에도 들지 않는 Codex 호스트 동등성 항목 |
| 보류 | 13 | 이번 묶음에 배정되지 않았다 — 아래 표에 다음 배정이나 결정 필요 사유를 적었다 |

## 보류 항목의 다음 배정

| ID | 지적 | 다음 |
|---|---|---|
| HX-7 | 버전이 1.0.0에 고정돼 있어 설치본의 절차 개정 이력을 추적할 수 없다. update는 상류 템플릿 변경을 '손으로 고친 파일'로 잘못 알린다 | 다음 묶음(배포·버전) — version 1.0.0 고정과 templateHash 상류 변경 오인은 릴리스 절차와 함께 정한다 |
| GAP-4 | 품질 평가 스크립트가 출하 구성과 다른 모델로 Claude만 측정하고, 날짜 고정 파일명이라 과거 증거를 덮어쓴다 | 다음 묶음(측정) — 평가 스크립트의 날짜 고정 파일명·모델은 유료 평가 실행(사용자 승인)과 함께 고친다 |
| GAP-5 | 테스트·증거가 Windows 한 대에서만 돌고 CI가 없다. POSIX 전용 경로는 기록된 어떤 회귀에서도 실행된 적이 없다 | 사용자 결정 필요 — CI 도입과 실행 플랫폼(지금 Windows 단일)은 저장소 운영 결정이다 |
| DOC-12 | 현행 동작 문서에 변경 이력이 섞이고, 새 절이 목차 밖에 덧붙여지고 있다 | 다음 묶음(문서 구조) — README 변경 이력 문단·목차 밖 절 정리 |
| DOC-M3 | README의 핵심 사용 흐름 절이 Claude 전용으로 쓰여 Codex 사용자 경로와 어긋난다 | 다음 묶음(문서 구조) — README 흐름 표의 입력할 곳 열을 호스트 중립으로 |
| HX-8 | 작업 시작 전 기준선 상태 확인과 Task별 증분 빌드가 없다. 첫 빌드는 모든 Task가 끝난 뒤에 돈다 | 다음 묶음(검증 효율) — 기준선 build·Task별 증분 build 는 검증 회차 규약(C3)과 함께 설계한다 |
| HX-13 | 스킬 description에 언제 써야 하는지와 쓰지 말아야 하는 경계가 없고, 호출 조건 검증도 없다 | 다음 묶음(측정) — 스킬 description 호출 경계·진입률 평가는 실제 모델 호출이 필요하다(이번 규칙상 금지) |
| LRN-3 | KNOWLEDGE 같은 키 upsert 가 항목 전체를 교체 — 부분(차이만) 제안을 고르면 기존 필드가 지워진다 | 다음 묶음(KNOWLEDGE 반영) — 자가 학습 보류와 별개인 반영 결함(upsert 가 항목 전체 교체) |
| LRN-15 | KNOWLEDGE 'R 번호 근거'가 작업 식별이 아니고 출처(작업 ID)가 항목에 기록되지 않는다 | 다음 묶음(KNOWLEDGE 반영) — 항목 출처(작업 ID) 기록 |
| LRN-16 | 근거 부족으로 걸러진 KNOWLEDGE 제안 사유가 stderr 로만 나가 동의 요약·반영 결과에 없다 | 다음 묶음(KNOWLEDGE 반영) — 근거 부족 제안 사유를 확인 화면에 |
| LRN-17 | knowledge prune 결과는 커밋되지 않아, 다음 deliver 가 같은 파일 항목을 고르면 무관한 작업 커밋에 삭제가 섞인다 | 다음 묶음(KNOWLEDGE 반영) — knowledge prune 결과의 다음 deliver 혼입 |
| LRN-18 | 같은 제안 파일 안의 중복 키를 거르지 않아 두 번째가 첫 선택을 조용히 덮는다 | 다음 묶음(KNOWLEDGE 반영) — 같은 제안 파일의 중복 키 검사 |
| OPT-7 | 교차 검증이 critic 뒤에 순차로 돌고, 두 호스트 실측은 비용 2배·미완주였다 | 다음 묶음(최적화 2차) — critic 과 교차 계획 검토의 병렬화는 교차 지점 정의(critic 배정)를 바꾸므로 따로 설계한다 |

## 전체 표

| ID | 심각도 | 상태 | 처리 | 메모 |
|---|---|---|---|---|
| DOC-2 | high | 일부 | 감사 ff13950 + 공통 모듈 2327975 | 흐름도 process-flow.md 작성(감사 커밋). 코드 생성 블록은 §6.4 하나뿐이고 usage·design 의 중복 흐름 서술은 남음 |
| FLOW-01 | high | 반영 | C2 fa70f74·110ec6a | 질문 [Origin]·questionOrigins 로 출처 작업과 후손만 낡게, rewind-required·rewind.auto(같은 사유 한 번) |
| HX-1 | high | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| HP-1 | high | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — code-agent grep·files 없음, Codex 검색 격차 그대로 |
| LRN-1 | high | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| PVR-1 | high | 반영 | C1 a1a70d8·77407a9 | 교차 시도 append-only crossAttempts, 완료 지점 재실행 거부(crossCheck 'cross-done'), 실행 불가만 중지 |
| PVR-2 | high | 반영 | C1 a1a70d8·77407a9 | 리뷰어 실행 append-only reviewers[], 완료 회차·동시 호출 무시, 기록 전 표 규칙 |
| CON-1 | medium | 반영 | C5 248e704·6584910 | 준비 티켓·preparedSession 결속(fail-closed). codex exec resume 프롬프트는 못 가름(문서화된 한계) |
| CON-2 | medium | 반영 | C5 248e704·6584910 | 적용 티켓 또는 호스트 표지 없는 TTY(terminalCaller), 30분 열린 동의 창 |
| CON-3 | medium | 반영 | C5 248e704·6584910 | docs-session.json writable 고정·doc/ 밖은 .md 만 |
| CON-4 | medium | 반영 | C5 248e704·6584910 | 승인 화면 경계·검증 선언 절·경계 스냅샷·approvalChangeLines |
| CON-5 | medium | 반영 | C5 248e704·6584910 | Codex 6자 확인 코드(사람 입력 증명은 아님 — 문서화) |
| CON-6 | medium | 일부 | C5 248e704·6584910 | Claude 업무 답 관찰(answers.jsonl)·출처 게이트. Codex 는 관찰 없이 [Source]: 대화로 화면 노출 |
| CON-8 | medium | 반영 | C5 248e704·6584910 | Grep glob·Glob pattern 정적 접두·키 저장소 상위 폴더 거부, ~ 전개(6584910) |
| GAP-1 | medium | 반영 | C2 fa70f74·110ec6a | rankCandidatesScan — 3,000개 절단 제거·32 MiB 예산·오름차순 순회 |
| GAP-2 | medium | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — AGENTS.md 32KiB 한도 검사 없음 |
| GAP-3 | medium | 범위 밖 | — | 호스트 자체 기억 정책 — 자가 학습 보류와 같은 축, 템플릿·init 변경 없음 |
| DOC-1 | medium | 반영 | 감사 ff13950 | 루트 AGENTS.md·CLAUDE.md(감사 커밋), 이번 범위에서 규칙 갱신 |
| DOC-3 | medium | 반영 | C5 248e704·6584910 + 전체 검토 반영(이 기록의 커밋) | design.md 동의 동작 목록에 repro-log·judgment, 흐름도 §4.1 표를 docSync.test 가 ActionSchema·CONSENT_TITLES 와 대조 |
| DOC-4 | medium | 반영 | C5 248e704·6584910 + 전체 검토 반영(이 기록의 커밋) | usage.md hook 수 9개(이벤트 6종)·init 표에 consent-event·planning-event·SessionStart 행, §5.1·§5.2 등록표를 docSync.test 가 init 설치 결과와 대조 |
| DOC-6 | medium | 반영 | 전체 검토 반영(이 기록의 커밋) | usage.md design 담당 analyst, impact 의 explorer 단독 조건 |
| DOC-10 | medium | 일부 | C5 248e704·6584910 | CLAUDE_HOOKS·CODEX_EVENTS 를 doctor 가 공유. update.ts hook 출력은 인라인 9개, 문서의 수치 반복은 그대로 |
| DOC-11 | medium | 일부 | 공통 모듈 2327975 + C5·C6·C7 | docSync(§6.4)·consentBinding·modelPolicy(codex.md 표)·hostText·templateText 대조. 수치·링크·USAGE 대조는 없음(usage.md:12·DOC-M1 이 그대로 통과) |
| FLOW-02 | medium | 반영 | C4 9d3e285·4b1333b | deliver 쓰기 거부·back 허용·증거 무효면 check 되감기·STOP_PHASES deliver |
| FLOW-03 | medium | 반영 | C4 9d3e285·4b1333b | reentry.ts reentryHint — status·next·hook·검증 거부가 같은 문장 |
| FLOW-04 | medium | 반영 | C2 fa70f74·110ec6a | orphanState — 확실한 고아 자동 재배정, 의심 고아 stale·cancel, SessionStart 실행 중 배정 요약 |
| FLOW-05 | medium | 반영 | C3 e3e082d·53368a4 | 동결은 결과가 인식된 실행부터, 수집 수정 1회 창 |
| FLOW-07 | medium | 반영 | C4 9d3e285·4b1333b | start 의 startBlockers 거부, request begin·status 경고 |
| FLOW-08 | medium | 반영 | C4 9d3e285·4b1333b | request 초안 target .max(1), start 가 다중 대상 지시서 거부 |
| FLOW-11 | medium | 반영 | C4 9d3e285·4b1333b | hostText.ts 표기 함수 배선(Claude 바이트 동일) |
| FLOW-14 | medium | 일부 | C2 fa70f74·110ec6a | 코드가 쓴 질문만 범위 한정 — 메인이 쓴 출처 없는 질문은 여전히 겹치는 모든 작업을 낡게 한다(기록 '남은 위험') |
| FLOW-15 | medium | 일부 | C4 9d3e285 + C7 f230734 | hostNotation·templateText·planningChain·consentOutput 시험. 흐름도 생성·템플릿 명령 lint 는 없음 |
| HAR-M1 | medium | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — Codex 메인 평가 하네스 없음(실제 모델 호출 금지 규칙) |
| HX-2 | medium | 반영 | 감사 ff13950 | AGENTS.md·process-flow.md 지도 |
| HX-3 | medium | 일부 | 공통 모듈 2327975 + C5·C6·C7 | DOC-11 과 같은 범위의 기계 대조만, doc-gardening 없음 |
| HX-4 | medium | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 — KNOWLEDGE flows 종류 없음 |
| HX-5 | medium | 범위 밖 | — | 사용자 결정으로 경량 경로 제외(C7 명세 31행) |
| HX-6 | medium | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — Codex SessionStart 미등록(CODEX_EVENTS 5개) |
| HX-7 | medium | 보류 | C6 eaad713(일부) | version 1.0.0 그대로. templateHash 가 머리말 model·effort 줄만 빼게 됨 — 상류 템플릿 변경 오인은 그대로 |
| HP-2 | medium | 반영 | C4 4b1333b | decideUnreadable 이 연결자 없는 code-agent read 허용, 거부 문구 readVia·editVia 표기 |
| HP-5 | medium | 반영 | C4 9d3e285·4b1333b | FLOW-11 과 같은 변경 |
| HP-6 | medium | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — doc/codex.md:82 '지원 여부를 확인하지 않았다' 그대로 |
| HP-7 | medium | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — 역할 TOML sandbox_mode 없음 |
| HP-8 | medium | 반영 | C1 a1a70d8·77407a9 | crossPreflight(샌드박스 표지)·crossSandboxSuspect — 실제 Codex 셸 표지는 미확인 |
| HP-9 | medium | 반영 | C1 a1a70d8·77407a9 | classifyCrossFailure — 설정 오류·분류 안 된 종료는 막힘, status·doctor 연속 중지 경고, doctor --cross |
| HP-21 | medium | 범위 밖 | — | 실제 Codex 호스트 검증 — 이번 규칙상 실제 모델 호출 금지 |
| LRN-2 | medium | 반영 | C2 fa70f74·110ec6a | 새 analysis·design 작업 inputs 에 업무 규칙 KNOWLEDGE(businessRuleFiles) |
| LRN-5 | medium | 반영 | C5 248e704·6584910 | 직접 CLI 소스 update 미리보기+TTY 'update' 입력, 세션 밖 hook·호스트 셸 거부 |
| OPT-1 | medium | 반영 | C7 df22bdf·f230734 | 인라인 준비 --action·finish 의 next·advance --chain·자리 확인 조건화. 효과는 유료 평가 미실행으로 미측정 |
| OPT-2 | medium | 일부 | C7 df22bdf | --for claude\|codex 호스트별 출력(−51~57%). --for 없으면 전체, summary 첫 표시는 유지 |
| OPT-5 | medium | 반영 | C2 fa70f74·110ec6a | stagedChecks.ts — 완료 hook 이 게이트 함수를 staging 본문에 먼저 실행 |
| OPT-6 | medium | 반영 | C7 f3b34ff·934e5fe | usage 호출 통계·retryReport(읽기 전용)·Codex 세션 집계(형식 미확인)·--json |
| OPT-8 | medium | 반영 | C4 9d3e285·4b1333b | FLOW-11 과 같은 변경 |
| OPT-9 | medium | 일부 | C4 9d3e285 + C7 f230734 | CODEX_SENTENCES 표와 원문·잔재 시험. 호스트 조건 블록 전환은 안 함(정규식 변환 유지) |
| OPT-12 | medium | 반영 | C6 eaad713·ca36d3e | 판단 opus/high·실행 sonnet/medium, 머리말 effort. A/B 실측은 미실행(사용자 승인 뒤) |
| OPT-17 | medium | 일부 | 감사 ff13950 | 흐름도 있음, 코드 대조는 §6.4·일부 표만 |
| PVR-3 | medium | 반영 | C3 e3e082d·53368a4 | 원인별 카운터와 한 판정 함수(nextRoundDecision·verifyNode·writeBlockReason) |
| PVR-4 | medium | 반영 | C3 e3e082d·53368a4 | 환경 분류는 실패 결과가 없을 때만(environmentMatch), 같은 코드 재실행 2/회차 |
| PVR-5 | medium | 반영 | C2 fa70f74·110ec6a | 완료 hook 재구성 — 식별 불일치·출처 실패도 기록하고 orphaned |
| PVR-6 | medium | 반영 | C1 a1a70d8·77407a9 + C5 248e704·6584910 | C1 은 reviewJudgment 네 함수만, 동의 judgment waive-finding·cross-stop 배선은 C5 |
| PVR-7 | medium | 반영 | C4 9d3e285·4b1333b | deliveryExcludes — handoff·.staging·작업 상태 폴더 *.lock 을 pathspec 으로 제외 |
| PVR-8 | medium | 반영 | C3 e3e082d·53368a4 | 체크아웃별 worktree.lock·자기 키 잔여 worktree 정리·시작 표지 retry.started |
| PVR-9 | medium | 반영 | C3 e3e082d·53368a4 | FLOW-05 와 같은 변경 |
| VER-M1 | medium | 반영 | C1 a1a70d8·77407a9 | review.json 모든 쓰기 mutateReview(잠금+다시 읽기) |
| VER-M2 | medium | 반영 | C1 a1a70d8·77407a9 | HP-8 과 같은 변경 — 샌드박스 거부는 중지가 아니라 exit 1 |
| CON-7 | low | 반영 | C2 fa70f74·110ec6a | QUESTION_FIELD_LINE(m 플래그 ^\s*, [Origin]·[Source] 포함) |
| CON-9 | low | 반영 | C5 248e704·6584910 | 끝 점·공백 거부, 관리 공유 접기(foldWindowsAlias)·shareInside |
| CON-10 | low | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — HP-6 과 같음 |
| CON-11 | low | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — Codex Stop 반복 차단 상한 없음(codexHook Stop 분기 그대로) |
| CON-12 | low | 반영 | C5 248e704 + C7 df22bdf | Codex ca-answer 목록에 repro-log, 단계 스킬의 toolInput 지시 재수록 제거(Codex 사본에 toolInput 0건) |
| CON-13 | low | 일부 | C5 248e704·6584910 | matcher mcp__.*·MCP 경로 판정·Codex 미판정 도구 기록. Claude 쪽 프로세스 실패(PATH·timeout)는 여전히 비차단 |
| CON-14 | low | 반영 | C5 248e704·6584910 | 제어 경로 아래 링크는 link:<대상> 해시 |
| CON-15 | low | 일부 | C5 248e704·6584910 | 내용 해시 캐시·재대조 1회. hook timeout 명시는 하지 않음 |
| CON-16 | low | 반영 | C5 248e704·6584910 | 동의 영수증 consents.jsonl·원장 끝줄 대조 |
| CON-17 | low | 일부 | C5 248e704·6584910 | 세션 밖 hook 설정 언급 거부·hook 누락 감지·시작 게이트. 폴더 단위 삭제(rm -rf .claude)는 못 막음 |
| CONS-M1 | low | 반영 | C5 248e704·6584910 | KNOWLEDGE 예외·반영을 .md 로 한정, manifest check ✗ |
| GAP-4 | low | 보류 | — | evaluate-review.cjs·evaluate-model.cjs 변경 없음(날짜 고정 파일명·모델) — 배정 없음 |
| GAP-5 | low | 보류 | — | CI 없음, Windows 단일 — 배정 없음 |
| DOC-5 | low | 반영 | 전체 검토 반영(이 기록의 커밋) | usage.md 스테이지 번호 진술을 --help(13단계 번호)·status(이름) 로 고치고 design.md 명령 표의 번호를 뺐다 |
| DOC-7 | low | 일부 | C1 a1a70d8·77407a9 + C4 9d3e285·4b1333b + 전체 검토 반영(이 기록의 커밋) | design.md·usage.md init 에 --host. design.md §6 표의 verify·read·planning·consent 행 보강은 남음(다음 문서 묶음) |
| DOC-8 | low | 반영 | C4 9d3e285·4b1333b | --help 호스트 중립 문구 — 단 USAGE 의 단계 번호(1·8·9·11·12·13)는 남음(DOC-5) |
| DOC-9 | low | 반영 | C4 9d3e285 + 전체 검토 반영(이 기록의 커밋) | install.md 자원 수 문장 삭제, init·update 예시를 sandbox 실제 출력으로(모델 줄·hook 9개) |
| DOC-12 | low | 보류 | — | README 17~19행 변경 이력 문단, README·usage 의 목차 밖 절(요구 분석·설계·계획, 검증 노드 실행, 관찰된 계획 작업) 그대로 |
| DOC-13 | low | 일부 | C5 248e704 + C7 64d1c50 | CONSENT_ACTIONS·CONSENT_TITLES·CLAUDE_HOOKS·CODEX_EVENTS·PHASE_LABEL export. CLI 명령 상수 없음 |
| DOC-14 | low | 반영 | 전체 검토 반영(이 기록의 커밋) | init.ts Codex 안내의 스킬·에이전트·훅 수를 쓴 자원에서 센다(시험 fullReview DOC-14) |
| DOC-M1 | low | 반영 | 전체 검토 반영(이 기록의 커밋) | usage.md 의 fix 로그 근거 절을 #### 제목으로 — 앵커가 산다 |
| DOC-M2 | low | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — .agents/skills/ca-answer/reference.md 를 어떤 Codex 지침도 참조하지 않음 |
| DOC-M3 | low | 보류 | — | README '요구사항부터 완료까지' 표 입력할 곳 열이 Claude Code 고정 — C4 는 CLI 표기만 고침 |
| FLOW-06 | low | 반영 | C3 e3e082d·53368a4 | 리뷰 회차 3·총 회차, reviewRoundUsageOf 하나 |
| FLOW-09 | low | 반영 | C4 9d3e285·4b1333b | preparationHint 가 setup·docs·baseline 중 하나를 고름 |
| FLOW-10 | low | 반영 | C4 9d3e285·4b1333b | doctor [--host] [--cross] 를 isModelCommand·LEASE_FREE 에 |
| FLOW-12 | low | 반영 | C4 9d3e285·4b1333b | 관찰 흐름 다음: planning advance, check·test 는 verify --json |
| FLOW-13 | low | 반영 | C4 9d3e285·4b1333b | ca-next '멈춘 자리별 재개' 표, 작업 없는 status 의 AI-DLC·문서 세션 우선 |
| FLOW-16 | low | 반영 | C4 9d3e285·4b1333b | 작업 임대 lease.ts — Codex 는 호스트 단위 비교라 Codex 두 세션 동시 진행은 못 막음(문서화) |
| FLOW-17 | low | 반영 | C4 9d3e285·4b1333b | approve·reject·confirm 남는 인자 사용법 오류 |
| FLOW-18 | low | 반영 | C5 248e704 + C6 eaad713 | reference.md action 목록 repro-log·judgment, host·reasoning 행 |
| FLOW-M1 | low | 반영 | C2 fa70f74·110ec6a | mutatePlanning 이 공통 acquireLock(죽은 주인·오래된 빈 잠금 회수) |
| HX-8 | low | 보류 | — | 기준선 build·Task별 증분 build 없음(PVR-19 완료 판정과 별개) |
| HX-9 | low | 반영 | C6 eaad713·ca36d3e | ROLE_POLICY[역할].reason 과 doc/codex.md 역할 표(modelPolicy.test 대조) |
| HX-10 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| HX-11 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| HX-12 | low | 반영 | C7 f230734 | templateText.test — CODEX_SENTENCES(staging 세 문장 포함) 원문 존재·사본 잔재 없음 |
| HX-13 | low | 보류 | — | 스킬 description 호출 경계·진입률 평가 없음 |
| HOST-M1 | low | 반영 | C1 a1a70d8·77407a9 | PVR-11 과 같은 변경 |
| HOST-M2 | low | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — HP-7 과 같음 |
| HP-3 | low | 반영 | C6 eaad713 + C5 248e704 | reference.md 의 "agent" 표기로 과잉 치환 회피, 동작 목록 대조 시험 |
| HP-4 | low | 반영 | C4 9d3e285 + C7 f230734 | hostNotation.test(Bash·600000ms)·templateText.test(원문 1회 이상 일치) |
| HP-10 | low | 반영 | C1 a1a70d8·77407a9 | TIMING.crossTimeoutMin 9, 스킬 timeout 600000ms 또는 백그라운드, 끊긴 실행 닫기(orphanView) |
| HP-11 | low | 반영 | C4 9d3e285·4b1333b + C1 a1a70d8·77407a9 | 임대(C4)와 review.json 잠금 저장 mutateReview(C1). Codex 두 세션은 FLOW-16 과 같은 한계 |
| HP-12 | low | 반영 | C1 a1a70d8·77407a9 | CODE_AGENT_CROSS 자식에서 Stop·SessionStart·담당 hook 통과, PreToolUse crossChildGuard(77407a9) |
| HP-13 | low | 반영 | C1 a1a70d8·77407a9 | F→X 정규화(normalizeCrossBody), 형식만 교정(correct) |
| HP-14 | low | 일부 | 전체 검토 반영(이 기록의 커밋) | PATH 의 .cmd·.bat 와 실행 파일 변수의 없는 파일은 실행 불가가 아니라 설정 오류로 막는다(경로 오타로 필수 교차 검증이 빠지지 않게). .cmd 래퍼 파싱은 다음 묶음(호스트 동등성) |
| HP-15 | low | 일부 | C2 fa70f74·110ec6a + C1 a1a70d8·77407a9 | Codex 담당·리뷰어 실패를 되돌림 없이 기록(subagentExit codex 0). 되돌림(block) 지원은 미확인이라 안 함 |
| HP-17 | low | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — read.ts JSON 출력 그대로 |
| HP-18 | low | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 |
| HP-19 | low | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — CLAUDE.block·CODEX.block 변경·대조 없음 |
| HP-20 | low | 일부 | C1 a1a70d8·77407a9 + C7 f3b34ff | 끄는 설정은 wontfix(두 호스트 설치 시 필수 — 사용자 결정). 시도별 비용 기록(C1)·usage 재시도 절 합산(C7) |
| LEARN-M1 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 — KNOWLEDGE 256KB 이후 항목 누락(plugins/defaults readCapped) 결함은 남음 |
| LRN-3 | low | 보류 | — | 기존 KNOWLEDGE 반영 결함(upsert 가 항목 전체 교체) — 자가 학습과 별개인데 배정·결정 기록 없음 |
| LRN-4 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 — 국소 스킬 오버레이(LRN-11 계열) |
| LRN-6 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 — design.md:197·usage.md:278·ca-docs 의 '질문의 답으로 쌓인다' 문장은 그대로 |
| LRN-8 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| LRN-9 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| LRN-12 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| LRN-13 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 — OPT-6 retryReport 가 작업별 카운터를 읽기만(재발률·환류 없음) |
| LRN-14 | low | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| LRN-15 | low | 보류 | — | KNOWLEDGE 항목 출처(작업 ID) 미기록 — 배정·결정 기록 없음 |
| LRN-16 | low | 보류 | — | 근거 부족 제안 사유가 stderr 로만 — 배정·결정 기록 없음 |
| LRN-17 | low | 보류 | — | knowledge prune 결과 미커밋 → 다음 deliver 혼입 위험 — 배정·결정 기록 없음 |
| LRN-18 | low | 보류 | — | 같은 제안 파일 중복 키 미검사 — 배정·결정 기록 없음 |
| OPT-3 | low | 일부 | C7 f230734·934e5fe | ca-answer 조건부 읽기·SessionStart compact·clear 재확인 줄. 질문/동의 파일 분리는 defer |
| OPT-4 | low | 반영 | C7 69fbe28 | templateBudget.test.ts·scripts/template-sizes.cjs |
| OPT-7 | low | 보류 | — | 교차 검증이 critic 뒤 순차 — C7 묶음 밖, 결정 기록 없음 |
| OPT-10 | low | 반영 | C5 248e704·6584910 | Codex ca-answer 동작 목록에 repro-log(consentBinding.test 대조) |
| OPT-11 | low | 반영 | C7 337ab1f | p5·p6 주제별 8개·p7·p8 이름 변경, npm test 208→112초 |
| OPT-13 | low | 반영 | C6 eaad713·ca36d3e | prices.ts claude-sonnet-5-5·claude-fable-5, priceKey 날짜 접미사 |
| OPT-14 | low | 반영 | C7 f230734 | planningChain.ts planningNextLine, 계획 스킬 1~5항(2·3·4항 같은 글자) |
| OPT-15 | low | 일부 | C5 248e704 + C7 669aa66 | cli.ts 지연 로드(C5)·hook 경로 명령 모듈 지연 로드(PreToolUse 104→95ms). hook 전용 번들은 defer |
| OPT-16 | low | 일부 | C7 64d1c50·69fbe28 | context 렌더러 분리(바이트 동일)·서브에이전트 절 문장 2곳. submitPlan 등 거대 함수·템플릿 조각은 defer |
| OPT-M1 | low | 범위 밖 | — | 호스트 동등성(Codex) 중 이번 범위 밖 — 묶음 배정 없음 — DOC-M2 와 같음 |
| PVR-10 | low | 일부 | C1 a1a70d8·77407a9 | 9분 제한·지점 3·원인별 재실행 1·시도별 소요·비용 기록. --max-budget-usd 전달은 미룸 |
| PVR-11 | low | 반영 | C1 a1a70d8·77407a9 | runtimeHost 와 같은 --by 거부(requireCrossCaller), 지점 호스트 pointHost |
| PVR-12 | low | 반영 | C1 a1a70d8·77407a9 | HP-12 와 같은 변경 |
| PVR-13 | low | 반영 | C3 e3e082d·53368a4 | 부분 트리 해시를 파일 바이트로 |
| PVR-14 | low | 일부 | C3 e3e082d·53368a4 | <?xml 선언이 있는 콘솔 JUnit 만·탐색 중단 기록. TAP 헤더 요구·보고서 경로 선언은 미룸 |
| PVR-15 | low | 반영 | C3 e3e082d·53368a4 | testFreeze 해시를 test·integrate 게이트가 대조 |
| PVR-16 | low | 반영 | C1 a1a70d8·77407a9 | ⑩·커밋 메시지 교차·사람 판단 줄, 커밋 중 계획 파일 변경 경고, 커밋 실패 시 KNOWLEDGE 되돌림 |
| PVR-17 | low | 반영 | C2 fa70f74·110ec6a + C3 e3e082d·53368a4 | 계획 쪽 sameInput 3·taskTotal 6(C2), 검증 쪽 timedOut·같은 회차 rerun(C3) |
| PVR-18 | low | 반영 | C2 fa70f74·110ec6a | withPlanningCache 명령 1회 범위 메모(해시 골든 고정) |
| PVR-19 | low | 일부 | C7 f230734 | 독립 Task 병렬화는 wontfix(Codex agent_id 없음). Task 완료 판정 untouchedTaskFiles 만 fix |
| VER-M3 | low | 반영 | C4 9d3e285 | 장시간 실행 정본 문장 문장째 치환 — Codex 사본에 600000ms·run_in_background 0건(sandbox init 확인) |
| CON-18 | info | 일부 | C5 248e704·6584910 | hookPaths.test.ts 우회 말뭉치. 모드×호스트×도구 판정표·흐름도 생성은 없음 |
| HP-16 | info | 반영 | 전체 검토 반영(이 기록의 커밋) | Codex 담당 배정(Codex 단일 설치·두 호스트 설치의 Codex 호출)은 staging 없이 {path, content} 계약(codexContract) |
| HP-22 | info | 일부 | C4 9d3e285 | 표기·문장째 치환으로 잔재 줄임. 변환 문구 품질 전수 점검은 없음 |
| LEARN-M2 | info | 반영 | 감사 ff13950 + C5 248e704·6584910 | AGENTS.md 실험 규칙(update 금지)과 LRN-5 소스 update 확인 — 이번 범위에서 update 실행 기록 없음 |
| LRN-7 | info | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| LRN-10 | info | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| LRN-11 | info | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
| PVR-20 | info | 일부 | 감사 ff13950 | 흐름도는 있으나 코드 생성은 §6.4 하나 |
| PVR-21 | info | 범위 밖 | — | 자가 학습 보류(사용자 결정) — 어느 묶음에도 배정 안 됨 |
