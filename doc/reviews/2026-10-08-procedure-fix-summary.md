# 절차 보완·재시도 규약·최적화 결과 요약 (2026-10-07~08)

[이중 호스트 프로세스 감사](2026-10-07-dual-host-process-audit.md) 뒤의 구현·검토·후속 수정 전체의 결과를 한 곳에 모은 기록이다. 커밋 범위는 `2c97a43..e75e8d7`이고 묶음별 커밋은 [단계와 커밋](#단계와-커밋)에 있다. 현재 동작은 [프로세스 흐름도](../process-flow.md)가 정본이다. 원자료는 [procedure-fix-2026-10-08.json](evidence/procedure-fix-2026-10-08.json)(처리 현황 160건·커밋·시험·실측)이다.

## 사용자 결정

| 결정 | 내용 | 반영 |
|---|---|---|
| 첫 요청(2026-10-07) — 감사 | Claude·Codex 이중 호스트 프로세스를 코드 수정 없이 감사한다 — 두 호스트를 함께·각각 쓸 수 있는가, 절차에 문제가 없는가, 스스로 학습하는 구조인가, 최적화할 부분, 하네스 엔지니어링 원칙 대비, 전체 흐름 문서가 필요한가 | `0807d32` — 감사 기록(지적 160건)·[프로세스 흐름도](../process-flow.md)·개발 에이전트 진입점(`AGENTS.md`·`CLAUDE.md`) |
| 두 번째 요청 — 감사 지적 처리 | 절차 결함을 보완하고, 실패 원인별 재시도 규약을 코드가 강제하고 문서화하며, 최적화한다 | 공통 모듈과 묶음 C1~C7. 원천은 `retryPolicy.ts`, 흐름도 §6.4 표는 그 생성 블록이다 |
| Claude 역할별 모델 | 판단 역할 opus/high, 실행 역할 sonnet/medium | C6([역할별 모델](#claude-역할별-모델)). 비용·품질 A/B 실측은 사용자 승인 뒤로 미뤘다 |
| 커밋 방식 | 작업 브랜치 `fix/procedure-retry-optimization`에 묶음별 로컬 커밋 — 구현 커밋과 독립 검토 반영 커밋을 나누고, 따로 작업한 묶음(C2·C3·C6)은 병합 커밋으로 잇는다. push·PR 은 하지 않는다 | [단계와 커밋](#단계와-커밋) |
| HX-5 제외 | 작은 작업용 경량 경로는 만들지 않는다 | 범위 밖 |
| 자가 학습 보류 | 측정은 기록을 읽기만 하고 다음 작업으로 환류하지 않는다 | 자가 학습 지적 17건과 호스트 자체 기억(GAP-3)은 범위 밖 |
| 사람 확인 지점 셋 유지 | 요구 확정·계획 승인·결과 반영을 줄이지 않는다 | 연쇄 `planning advance --chain`도 계획 승인을 잇지 않는다. 한도를 넘으면 자동 재시도를 멈추고 사람 판단 동의(`judgment`)로 넘긴다 |
| 게이트 약화 금지 | 수정·후속 수정이 게이트를 약하게 하지 않는다 | 후속 수정(R·F·D·G)은 안내·기록만 고치거나 게이트를 강하게 했다. C1~C7 의 의도한 완화는 세션 중 셸의 `takeover`(작업 임대)·`doctor --cross`(C4 FLOW-10) 허용 둘이다 — hook 판정 행렬의 감사 기준 `2c97a43`→`7e80d6b`에서 약해진 판정 72가 모두 이 둘이다([재검증](#전체-검토와-후속-수정)). 알고 남긴 틈은 [남은 일](#범위-밖보류남은-일)의 단계 기록 위험에 있다 |
| 교차 실행 불가면 중지 기록 후 진행 | 다른 호스트를 실행할 수 없으면 그 지점의 교차를 중지로 기록하고 진행한다 | 실행 불가는 화이트리스트(미설치·인증·사용 한도·네트워크·장애)뿐이다. 설정 오류·형식 오류·샌드박스 거부·끊긴 실행은 게이트를 막는다 |
| 두 호스트면 교차 필수 | 두 호스트 설치에서 교차 검증을 끄는 설정은 두지 않는다 | HP-20 은 끄는 설정을 두지 않는 쪽(일부)으로 닫았다 |
| D1(2026-10-08) | 작업 중에는 역할 모델·추론 강도를 바꿀 수 없다 — 작업이 끝난 뒤(반영 deliver 또는 종료 abort) 바꾼다 | 동의 준비(질문 전)·동의 적용 시점 재확인·터미널 `code-agent model`이 같은 `model-in-work` 문구로 거부한다. 조회는 연다. `update --templates-only` 동작은 바꾸지 않았다 |
| D2(2026-10-08) | Codex 메인이 부른 claude 의 같은 지점 네트워크 오류는 몇 번째든 게이트를 막고, 두 번째부터는 사람이 정한다(네트워크를 확인해 다시 실행하거나 `judgment cross-stop`) | 실행 불가로 넘기지 않고 `host-sandbox-denied`로 막는다. 지점 시도 한도에 세므로 기록이 끝없이 늘지 않는다. 표지 있는 사전 거부·`CODE_AGENT_CROSS_PREFLIGHT=off`·Claude 메인→Codex 의 네트워크 오류·네트워크가 아닌 실행 불가는 그대로다 |
| D3(2026-10-08) | 실행 파일 변수(`CODE_AGENT_*_BIN`)가 없는 파일을 가리키거나 PATH 에 셸 스크립트만 있으면 설정 오류로 막는다(현행 유지) | 코드 변경 없음. doctor `✗`·exit 1 도 유지 |

작업 규칙([실제 호스트 확인](#실제-호스트-확인-2026-10-08) 전까지): `code-agent update`는 실행하지 않았다. 실제 Claude·Codex 모델을 부르지 않았다 — 교차 실행은 가짜 호스트 실행 파일(`CODE_AGENT_CLAUDE_BIN`·`CODE_AGENT_CODEX_BIN`)로 확인했다. 실험은 작업 scratchpad 의 sandbox 임시 저장소에서 했고, 이 저장소 루트에는 `init`을 실행하지 않았다.

## 단계와 커밋

| 단계 | 묶음 | 커밋 |
|---|---|---|
| 감사 | 이중 호스트 프로세스 감사·흐름도·개발 지침(코드 변경 없음) | `0807d32` |
| 1 | 공통 재시도 규약 모듈 | `7b698d8`·`c38f1e2` |
| 2 | C2 계획 오케스트레이션 · C3 검증 재시도 · C6 역할별 모델(따로 작업한 뒤 차례로 병합) | `99628c5`·`c38c5bf`(병합 `33e5d85`) · `2bd69e5`·`357a471`(병합 `8441786`) · `5029925`·`92f6ce1`(병합 `04fd909`) |
| 3 | C1 리뷰·교차 검증 무결성 | `7b7ca8b`·`2faedb4`·`241094e` |
| 4 | C5 동의·업무 답 관찰·hook 경계 | `b557e35`·`3485d37` |
| 5 | C4 단계 전이·CLI 안내·반영 범위·작업 임대 | `473a6aa`·`73aaa78` |
| 6 | C7 최적화 | `04af60d`·`113c9f6`·`4ca343f`·`442c8ac`·`36e99f5`·`1b0a5ec`·`b978e0c`·`5c52392`·`c700fda` |
| 7 | 전체 검토 반영(지적 43건)·흐름도 대조 시험·감사 처리 현황 | `7e80d6b` |
| 8 | 작업 요약 기록(문서만) | `952594c` |
| 9 | 최종 재검증 지적 R1~R6 반영 | `72f6b97` |
| 10 | 9단계 수정의 반박 검증 지적 F1~F4 반영 | `bf4b32e` |
| 11 | 사용자 결정 D1~D3 반영 | `c9312f6` |
| 12 | 11단계 반영의 반박 검증 지적 G1~G8 반영 | `0a77595` |
| 정리 | 문서 최신화·이력 정리(단계 기록 통합, 옛 기록 삭제, 현행 문서의 경위 문장 제거, 흐름도 §10 압축)와 그 검증 지적 7건 반영 | `eefd4e9` · `4838e1f` |
| 실제 호스트 | 실제 호스트 확인(claude 2.1.293·codex-cli 0.161.0, Windows)의 불일치 H1~H12 반영 — 교차 분류·사전 판정 · Codex hook·신뢰·담당 식별·임대 · Codex 사용량 · 담당 호출·기록([실제 호스트 확인](#실제-호스트-확인-2026-10-08)) | `e7caf31` · `e14dbf9` · `e2afdca` · `5107697` |
| 실제 호스트 검증 | 반영 뒤 실제 Codex 재확인과 검증 지적 반영([반영 뒤 재확인](#반영-뒤-실제-호스트-재확인)·[검증 지적](#검증-지적-처리)) | `1293955` |
| 실제 호스트 재검증 | 검증 지적 반영(`1293955`)의 재검증 지적 W1~W6 반영([재검증 지적](#재검증-지적-처리)) | `e75e8d7` |

묶음마다 구현 커밋 뒤에 독립 검토를 거쳤고, 지적을 코드로 확인한 반영 커밋을 따로 두었다. 7단계는 `0807d32..c700fda` 전체를 네 관점(e2e·재시도 규약·hook·문서)으로 다시 검토한 결과이고, 9~12단계는 그 뒤를 다시 검증하거나 반박 검증해 남은 문제를 고친 결과다.

## 실패 원인별 재시도 규약 요지

원칙은 여섯이다.

1. 원인 판정은 코드가 한다. 모델은 결과의 `failure.class`·안내 문구·`budget`을 읽고 따른다.
2. CLI는 스스로 다시 실행하지 않는다. 예외는 같은 호출 안의 죽은 잠금 회수와, hook이 Claude 담당에게 한 번 되돌리는 것뿐이다.
3. 같은 입력으로 같은 실패를 되풀이하지 않는다. 원인마다 다시 시도하려면 무엇(코드·환경·입력·설정·사람 판단)이 바뀌어야 하는지 정해져 있다.
4. 재실행으로 기록을 지우지 않는다. 교차 시도·리뷰어 실행은 append-only이고, 완료 지점은 다시 실행하지 않는다.
5. 상한에 닿으면 자동 재시도를 멈추고 사람에게 넘긴다. 한도는 관찰된 동의 `judgment`(`retry-grant`·`waive-finding`·`cross-stop`)로만 는다.
6. 원천은 `retryPolicy.ts` 하나다. 흐름도 §6.4 표는 `renderRetryPolicyTable()`의 생성 블록이고 `docSync.test.ts`가 바이트를 대조한다.

원인은 21종이다. 19종은 감사 과제에 나열된 원인이고, `precondition`·`hook-failure`는 분류 밖으로 새는 Stop과 hook 예외를 담는 보조 분류다. 묶음(검증·계획 배정·교차 실행·지적·상한·동의·잠금·hook)별 원인은 원자료 `retryPolicy.groups`에, 판별 규칙·카운터 위치·한도·사람 허용 범위·판정 함수·안내 문구의 원천은 [흐름도 §6.4](../process-flow.md#64-실패-원인과-재시도-규약-retrypolicyts)에 있다.

## 묶음별 주요 변경

괄호 안은 감사 지적 ID다. 상태는 [감사 160건 처리 현황](#감사-160건-처리-현황)에 있다.

- **공통 모듈** — `retryPolicy.ts`(원인 21종의 정책·카운터·한도·사람 허용 범위, 판정 함수, 호스트 중립 안내 문구), 공통 잠금 `lock.ts`, 실행 환경 표지 `crossEnv.ts`, 호스트별 표기 `hostText.ts`, §6.4 생성 블록과 바이트 대조. 독립 검토 14건으로 잠금 회수 직렬화·교차 실패 분류 범위·`crossBudgets`·안내 변형을 고쳤다.
- **C2 계획** — 질문 출처 `[Origin]`·`questionOrigins`로 출처 작업과 그 후손만 낡게 하고, 앞 단계가 낡으면 `rewind-required`로 되감는다(같은 사유는 한 번 자동, FLOW-01·FLOW-14 일부). 고아 배정 정리 `orphanState`(FLOW-04), 완료 hook 재구성과 결정적 문서 검사 `stagedChecks.ts`(PVR-5·OPT-5), 같은 입력 실패·작업 총 배정 한도(PVR-17), 공통 잠금(FLOW-M1), 질문 본문 구조 필드 검사(CON-7), 업무 규칙 KNOWLEDGE 입력(LRN-2), 후보 순위 절단 제거(GAP-1), 명령 1회 범위 메모와 입력 해시 골든 고정(PVR-18).
- **C3 검증** — 검증 회차를 원인별 카운터로 나누고 `check`·`verify`·hook·`status`가 한 판정 함수를 쓴다(PVR-3). 환경 분류는 실패 결과가 없을 때만(PVR-4), 테스트 동결 시작과 증거 대조 `testFreeze`(FLOW-05·PVR-9·PVR-15), 체크아웃별 worktree 표지(PVR-8), 파일 바이트 해시(PVR-13), 리뷰 회차 한도의 단일 원천 `reviewRoundUsageOf`(FLOW-06), 재현 시도 한도.
- **C6 역할별 모델** — `ROLE_POLICY`·`TIER_DEFAULTS`, 정의 파일 머리말 `effort`, `models.json` 예약 키 `effort`(이전 버전 호환), `model --effort`, model 동의 스냅샷의 모델 정책, doctor·update 보고, 단가표 `claude-sonnet-5-5`·`claude-fable-5`(OPT-12·HX-9·OPT-13).
- **C1 리뷰·교차** — 교차 시도·리뷰어 실행의 append-only 기록과 완료 지점 재실행 거부(PVR-1·PVR-2), `review.json` 잠금 저장 `mutateReview`(VER-M1), 오류 채널만 보는 원인별 교차 실패 분류(HP-9), 형식만 교정(HP-13), Codex 샌드박스 사전 판정(HP-8·VER-M2), 같은 호스트 `--by` 거부(PVR-11·HOST-M1), 9분 제한(HP-10), 교차 자식의 hook 통과·진행 거부(HP-12·PVR-12), 사람 판단 함수(PVR-6), ⑩·커밋 메시지의 교차 줄(PVR-16), `doctor --cross`.
- **C5 동의·hook** — 동의 실패 기록 `failure{class,kind}`와 갈래별 안내, 준비·적용 티켓과 준비 세션 결속·30분 열린 동의 창(CON-1·CON-2), Codex 확인 코드(CON-5), 사람 판단 동의 `judgment`(카운터별 허용 `retryGrant.ts`, 지적 기각·교차 중지 연결), Claude 업무 답 관찰(CON-6 일부), 문서 세션 범위 고정(CON-3)과 KNOWLEDGE `.md` 한정(CONS-M1), 승인 화면 경계 절(CON-4), 소스 update 확인(LRN-5), hook 경로 판정(Grep·Glob·Windows 별칭·MCP — CON-8·CON-9·CON-13), 링크 해시·내용 해시 캐시(CON-14·CON-15), hook 누락 감지와 시작 게이트(CON-17 일부), 동의 영수증(CON-16), `cli.ts` 지연 로드와 `hookFailureExit` 연결.
- **C4 단계·CLI·임대** — deliver 의 쓰기 거부와 되감기(FLOW-02), 재진입 안내 `reentry.ts`(FLOW-03), start 사전 검사(FLOW-07), 작업당 대상 하나(FLOW-08), 준비 동의 선택(FLOW-09), 작업 중 doctor 허용(FLOW-10), 관찰 흐름의 `다음:`(FLOW-12), `ca-next` 멈춘 자리별 재개표(FLOW-13), 작업 임대 `lease.ts`(FLOW-16·HP-11), 남는 인자 거부(FLOW-17), 호스트별 표기 배선(FLOW-11·HP-5·OPT-8), 반영 제외 `deliveryExcludes`(PVR-7), 장시간 실행 문장의 문장째 치환(VER-M3), 연결자 없는 `code-agent read` 허용(HP-2).
- **C7 최적화** — hook 경로의 명령 모듈 지연 로드(OPT-15 일부), `usage` 호출 통계·재시도 기록(읽기만)·Codex 세션 집계(OPT-6), 동의 인라인 준비·호스트별 출력 `--for`·적용 결과의 `next`(OPT-1·OPT-2 일부), 계획 advance 의 `next` 줄과 연쇄 `--chain`·계획 스킬 공통 항목(OPT-14·OPT-1), ca-answer 조건부 읽기(OPT-3 일부), Task 완료 판정(PVR-19 일부), context 렌더러 분리(OPT-16 일부), 템플릿 크기 예산(OPT-4), 시험 파일 분할(OPT-11), `CODEX_SENTENCES`와 원문 시험(HX-12, OPT-9 일부).

## 전체 검토와 후속 수정

| 단계 | 지적 | 처리 |
|---|---|---|
| 7 전체 검토(`0807d32..c700fda`, e2e·재시도 규약·hook·문서 네 관점) | E1~E43 — 43건 | 반영 36·일부 5·사용자 결정 2(E2·E16 — 11단계 D1·D2 로 반영). E20 의 엄격화는 D3 로 확정 |
| 9 최종 재검증(`7e80d6b`·`952594c`) | R1~R6 — 6건 | 모두 반영 |
| 10 9단계 수정의 반박 검증 | F1~F4 — 4건(낮음) | 모두 반영. 게이트는 그대로 |
| 11 사용자 결정 | D1~D3 — 3건 | D1·D2 반영, D3 현행 유지 |
| 12 11단계 반영의 반박 검증 | G1~G8 — 8건(정보 1·medium 1·low 6) | 모두 반영 |

- **전체 검토 주요 반영** — 진단 노드의 재개 명령(E1), 소진 안내의 사람 선택지(E10), 통과 뒤 변경 회차가 리뷰 회차 예산을 씀(E13 일부), 검증 명령이 상태 기록을 바꾸면 되돌리고 받지 않음(E15), ⑧·⑩·커밋 메시지의 사람 허용 줄(E8), 반영 확인 화면의 PR 본문 구역(E7), 계획 승인 화면의 계획 검토 절(E12), Codex 담당 배정 계약 `{path, content}`(E9 — HP-16), 실행 파일 설정 오류 분류(E20 — HP-14 일부), 하위 폴더 세션의 hook 루트(E25), 사용자 수준 hook 설정 쓰기 거부(E29), 문서 지적(E31~E43). 흐름도 §4.1·§5.1·§5.2·§3.2·§7을 코드·`init` 설치 결과와 대조하는 시험을 `docSync.test.ts`에 더했다.
- **R1~R6** — 사용자 수준 호스트 설정 쓰기 거부가 같은 파일의 다른 이름(NTFS 스트림 표기·폴더 스트림·긴 경로 접두·관리 공유·끝 점·공백·8.3·상대 경로, 하드 링크는 (dev, ino))을 접어 본다(R1). 검증 명령이 code-agent 기록을 바꿔 되돌린 실행은 전제 미충족으로 남고 게이트·verify·`다음:`이 같은 문장을 쓴다(R2). 교차 안내가 설정 오류(게이트 막힘)와 실행 불가(중지 기록 후 진행)를 나눈다(R3). 리뷰를 열지 않고 쓴 리뷰 회차는 허용을 받지 않는다(R4). 흐름도의 `template/`·`doc/` 줄 인용을 시험이 대조한다(R5, `finalReverify.test.ts` `CITED_LINES`). 시험의 죽은 pid 는 재사용될 수 없는 값이다(R6).
- **F1~F4** — `다음:`의 check·test 갈래가 지금 회차의 기록 변경 실행을 단계 필터 없이 본다(F1). 그 갈래가 그 단계 게이트의 stop 문제 전부를 싣고, 기록 변경 회차의 게이트는 ⑦ 미확인 줄을 싣지 않는다(F2). 교차 게이트 줄 괄호는 `crossRunNote`이고 doctor 는 교차 설정 오류를 `✗`로 쓴다(F3). 시험의 끝난 자식 pid 탐지를 넓혔다(F4).
- **G1~G8** — 샌드박스 의심이 지점 이력을 본다(G2). 사전 거부 뒤의 첫 네트워크 오류부터 사람에게 넘긴다(G6). 사람에게 넘긴 지점의 게이트 줄은 재실행 명령을 안내 뒤에 싣는다(G7, `crossGateHandoff`). 중지 지점 재실행의 샌드박스 제한은 사람 판단을 싣지 않는 `stopped` 변형이다(G5). doctor 'Codex 스킬·에이전트'와 모델 표의 변경 줄도 작업 중이면 작업이 끝난 뒤를 안내한다(G3·G4). 이름이 파일 서버가 아닌 MCP 쓰기 도구도 사용자 수준 호스트 설정의 절대 경로는 막는다(G1). 기록 수치(G8).
- **재검증**(`7e80d6b`, 실제 모델 호출 없음) — e2e 재실행(가짜 호스트 실행 파일, 23개 실행)의 검사 수가 이전과 같고 E1·E5·E7·E8·E10·E11·E12 반영을 출력에서 확인했다. 의도한 변경 때문에 낡은 가정으로 실패한 실행 셋(E20 의 미설치 흉내, E9 의 Codex staging, E2 경고)은 가정을 고친 사본으로 다시 돌리거나 D1 로 정리했다. 재시도 규약 탐침의 P7·P8 은 재현되지 않았다(고쳐짐). hook 판정 행렬(실제 hook 프로세스, 5,040 경우)에서 `c700fda`→`7e80d6b`에 약해진 판정은 0이다(강해진 56 — E30 의 MCP 프로젝트 상대 경로 키). 감사 기준 `2c97a43`→`7e80d6b`에서 약해진 72는 모두 의도한 허용 — 세션 중 셸의 `takeover` 36(작업 임대)·`doctor --cross` 36(C4 FLOW-10)이다. 9~12단계는 수정마다 빌드 산출물에서 하나씩 되돌린 변이 검사에서 그 지적의 시험이 모두 깨졌다.

## Claude 역할별 모델

판단 역할(analyst·critic·reviewer)은 Claude opus/high·Codex gpt-6.1-sol/high, 실행 역할(surveyor·explorer·writer·implementer·tester)은 Claude sonnet/medium·Codex gpt-6.1-sol/medium 이다. 역할별 값과 선택 이유(`modelPolicy.ts` `ROLE_POLICY`·`TIER_DEFAULTS`)는 [Codex 연동](../codex.md)의 '역할별 모델 기본값과 변경'이 정본이고, 정의 파일 머리말과 그 표를 `modelPolicy.test.ts`가 대조한다.

이 값은 제품의 시작값이고 벤치마크로 입증한 최적 조합이 아니다. 실행 역할을 sonnet/medium으로 내려서 생기는 check 실패·리뷰 지적·재배정 증가가 절감을 상쇄하는지는 측정하지 않았다([유료 A/B](#유료-ab-측정--미실행)).

## 최적화 실측

Windows, Node 24.19, sandbox, 실제 모델 호출 없음.

**hook 프로세스 시간**(spawn~종료, 기준 빌드 `73aaa78`와 C7 독립 검토 반영 빌드를 같은 반복 안에서 번갈아 돌린 31회 중앙값):

| hook | 기준 | 뒤 |
|---|---|---|
| PreToolUse Read / Bash status / Bash git diff | 104.0 / 104.0 / 104.5ms | 95.3 / 94.9 / 94.7ms |
| PreToolUse Bash `code-agent consent finish <UUID>` | 101.5ms | 102.4ms(+0.9 — 이 꼴에서만 `consent.js`를 읽는다) |
| consent-event 업무 질문 / 동의 질문 | 100.8 / 105.2ms | 101.1 / 105.5ms(바뀌지 않음) |
| Codex PreToolUse / UserPromptSubmit(일반 메시지) / Stop / SubagentStop | 112.2 / 103.9 / 110.9 / 103.8ms | 96.7 / 92.6 / 96.0 / 94.8ms |
| Codex UserPromptSubmit(동의 응답) | 105.6ms | 102.4ms |
| Stop · SessionStart startup · compact · SubagentStart | 85.0 · 92.6 · 92.3 · 87.1ms | 84.7 · 93.2 · 93.1 · 87.5ms(바뀌지 않음) |

hook 진입 모듈 그래프(dist 모듈 수, zod 79 파일 별도): `hook.js` 63→45, `codexHook.js` 69→46, `stopHook.js` 28→28, `sessionHook.js` 34→35.

**동의 준비 출력 글자 수**(새 Node 프로젝트):

| 동작 | 전체(`--for` 없음) | `--for claude` | `--for codex` |
|---|---|---|---|
| `setup` | 11,743 | 5,644(−52%) | 5,739(−51%) |
| `docs` | 6,379 | 2,962(−54%) | 3,057(−52%) |
| `docs --kind architecture` | 3,203 | 1,374(−57%) | 1,469(−54%) |

summary 가 크면 비율이 작아진다(plan 7,868→3,707·abort 4,840→2,193). 적용 결과에 `next`가 붙어 줄어드는 `code-agent status` 한 번은 작업이 없는 저장소 약 620~730자, 작업 중 약 0.6~0.9K자다. `request`·`request begin` 출력은 2,161→1,810자(−16%)다.

**템플릿 크기**(LF 글자, `scripts/template-sizes.cjs`, 기준 `73aaa78`):

| | 기준 | C7 뒤 | 차이 |
|---|---|---|---|
| 계획 스킬 4개(analyze·impact·design·plan) | 14,248 | 13,698 | −550 |
| Claude 흐름 합계(CLAUDE.block + 흐름 스킬 12) | 50,566 | 50,803 | +237 |
| Codex 흐름 합계(CODEX.block + .agents 스킬 12) | 48,127 | 48,607 | +480 |

공통 문단·자리 확인·ca-answer 인라인 문장이 늘었고 계획 스킬의 반복 문단이 줄었다. 대신 `planning advance` 출력마다 `next` 한 줄(약 70~300자)이 더해진다.

**시험 시간**(OPT-11, 같은 PC, 시험 수 1253개로 같음): `npm test` `duration_ms` 207,972 → 112,205(−46%). 가장 긴 파일은 fix-flow 73초다.

**그 밖**: 동의 스냅샷 내용 해시 캐시(C5, 파일 1만 개 sandbox)는 1회차 642ms → 2회차 313ms·3회차 307ms(2회차/1회차 48.8%, 해시 같음), 캐시를 지운 뒤 601ms였다. context 렌더러 분리(OPT-16)는 32개 골든 출력이 바이트 동일했다.

**미측정**: 실제 흐름에서 메인 요청·도구 호출·비용이 얼마나 주는지는 유료 평가를 돌리지 않아 재지 않았다. 명세 추정(메인 도구 호출 약 −11회: 연쇄 −3, 동의 JSON Write −4, 적용 뒤 status −4)은 확인되지 않았다. ca-answer 재읽기 감소(상한 3회×8.1K자 → 압축 뒤 0~1회)도 설계상 상한이다. 실제 횟수는 `usage`의 스킬 읽기 줄로 잰다.

## 템플릿 크기 예산

`src/test/templateBudget.test.ts` `BUDGET`(C7, `1b0a5ec`)은 `template/`의 모든 `.md`에 파일별 예산을, 두 흐름에 합계 예산을 둔다. 값은 `node scripts/template-sizes.cjs --suggest`로 정했다 — 파일별은 그때 크기×1.03, 합계는 ×1.02 를 100 단위로 올렸다(Claude 흐름 50,638자 → 51,700, Codex 흐름 48,442자 → 49,500). 실제 호스트 반영(H7)에서 담당 호출 문장(63자)을 더해 `ca-impact/SKILL.md`(3,007자)·`ca-design/SKILL.md`(2,812자)가 예산을 넘었다 — 문장은 담당을 부르는 그 항목에 있어야 모델이 호출할 때 보므로 보조 문서로 옮기지 않고 `--suggest` 값(3,100·2,900)으로 올렸다. 그 밖의 파일·합계 예산은 그대로이고, 합계는 Claude 51,409자·Codex 49,014자로 예산 안이다. 검증 지적 반영에서 같은 문장을 이전 버전 절차(`legacy.md`)의 담당 호출 다섯 곳에도 넣어 `ca-design/legacy.md`(723자)·`ca-impact/legacy.md`(1,067자)·`ca-plan/legacy.md`(914자)가 예산을 넘었다 — 이 문서들은 필요할 때만 읽는 보조 문서이고 문장은 그 호출 항목에 있어야 하므로 `--suggest` 값(800·1,100·1,000)으로 올렸다. `ca-analyze/legacy.md`(693자)는 예산(700) 안이고, 흐름 합계는 보조 문서를 세지 않아 그대로다. 재검증 지적 반영에서 `ca-implement/SKILL.md` 5항의 다시 맡기기(역할 이름 없이 같은 서브에이전트에게 맡기는 담당 호출)에도 같은 문장을 넣어 그 파일이 2,543자로 예산(2,500)을 넘었다 — 같은 이유로 `--suggest` 값(2,700)으로 올렸다. 흐름 합계는 Claude 51,472자·Codex 49,046자로 예산(51,700·49,500) 안이다.

## 감사 160건 처리 현황

판정은 문서 관점 독립 검토가 감사 지적마다 코드·단계 기록과 대조한 결과에 전체 검토 반영(`7e80d6b`)이 바꾼 9건과 문서 정리(`eefd4e9`)가 바꾼 DOC-12 를 더한 것이다(검토 판정 수와 바뀐 건은 원자료 `disposition.reviewerCounts`·`changedByFullReview`·`changedByCleanup`).

| 상태 | 수 | high | medium | low | info | 뜻 |
|---|---|---|---|---|---|---|
| 반영 | 86 | 3 | 39 | 42 | 2 | 지적한 결함·드리프트를 고쳤다 |
| 일부 | 28 | 1 | 9 | 15 | 3 | 핵심은 고쳤고 남은 부분을 메모에 적었다 |
| 범위 밖 | 34 | 3 | 9 | 18 | 4 | 사용자가 정한 범위 밖 — 자가 학습 보류, HX-5 경량 경로 제외, 실제 모델 호출 금지(작업 규칙), 다섯 갈래(절차 결함·재시도 규약·최적화·역할별 모델·교차) 밖의 Codex 호스트 동등성 |
| 보류 | 12 | 0 | 1 | 11 | 0 | 배정되지 않았다 — 아래 표에 다음 배정이나 결정 필요 사유 |
| 계 | 160 | 7 | 58 | 86 | 9 | |

DOC-2·DOC-11·HX-3·OPT-17·PVR-20(흐름 문서의 기계 대조)은 `7e80d6b`이 대조 시험을 §4.1·§5.1·§5.2·§3.2·§7 표로 넓힌 뒤에도 일부다 — 코드가 생성하는 블록은 §6.4 하나이고, 수치·링크·USAGE 대조는 없다. LEARN-M1 의 KNOWLEDGE 256KB 이후 항목 누락은 자가 학습과 묶어 범위 밖으로 두었지만 결함은 남아 있다.

### 보류 항목의 다음 배정

| ID | 심각도 | 지적 | 다음 |
|---|---|---|---|
| HX-7 | medium | 버전이 1.0.0에 고정돼 있어 설치본의 절차 개정 이력을 추적할 수 없다. update는 상류 템플릿 변경을 '손으로 고친 파일'로 잘못 알린다 | 배포·버전 — version 1.0.0 고정과 templateHash 의 상류 변경 오인은 릴리스 절차와 함께 정한다(C6 이 머리말 model·effort 줄만 뺐다) |
| GAP-4 | low | 품질 평가 스크립트가 출하 구성과 다른 모델로 Claude만 측정하고, 날짜 고정 파일명이라 과거 증거를 덮어쓴다 | 측정 — 평가 스크립트의 날짜 고정 파일명·모델은 유료 평가 실행(사용자 승인)과 함께 고친다 |
| GAP-5 | low | 테스트·증거가 Windows 한 대에서만 돌고 CI가 없다. POSIX 전용 경로는 기록된 어떤 회귀에서도 실행된 적이 없다 | 사용자 결정 필요 — CI 도입과 실행 플랫폼(지금 Windows 단일)은 저장소 운영 결정이다 |
| DOC-M3 | low | README의 핵심 사용 흐름 절이 Claude 전용으로 쓰여 Codex 사용자 경로와 어긋난다 | 문서 구조 — README 흐름 표의 입력할 곳 열을 호스트 중립으로 |
| HX-8 | low | 작업 시작 전 기준선 상태 확인과 Task별 증분 빌드가 없다. 첫 빌드는 모든 Task가 끝난 뒤에 돈다 | 검증 효율 — 기준선 build·Task별 증분 build 는 검증 회차 규약(C3)과 함께 설계한다 |
| HX-13 | low | 스킬 description에 언제 써야 하는지와 쓰지 말아야 하는 경계가 없고, 호출 조건 검증도 없다 | 측정 — 스킬 description 호출 경계·진입률 평가는 실제 모델 호출이 필요하다 |
| LRN-3 | low | KNOWLEDGE 같은 키 upsert 가 항목 전체를 교체 — 부분(차이만) 제안을 고르면 기존 필드가 지워진다 | KNOWLEDGE 반영 — 자가 학습 보류와 별개인 반영 결함(upsert 가 항목 전체 교체) |
| LRN-15 | low | KNOWLEDGE 'R 번호 근거'가 작업 식별이 아니고 출처(작업 ID)가 항목에 기록되지 않는다 | KNOWLEDGE 반영 — 항목 출처(작업 ID) 기록 |
| LRN-16 | low | 근거 부족으로 걸러진 KNOWLEDGE 제안 사유가 stderr 로만 나가 동의 요약·반영 결과에 없다 | KNOWLEDGE 반영 — 근거 부족 제안 사유를 확인 화면에 |
| LRN-17 | low | knowledge prune 결과는 커밋되지 않아, 다음 deliver 가 같은 파일 항목을 고르면 무관한 작업 커밋에 삭제가 섞인다 | KNOWLEDGE 반영 — knowledge prune 결과의 다음 deliver 혼입 |
| LRN-18 | low | 같은 제안 파일 안의 중복 키를 거르지 않아 두 번째가 첫 선택을 조용히 덮는다 | KNOWLEDGE 반영 — 같은 제안 파일의 중복 키 검사 |
| OPT-7 | low | 교차 검증이 critic 뒤에 순차로 돌고, 두 호스트 실측은 비용 2배·미완주였다 | 최적화 2차 — critic 과 교차 계획 검토의 병렬화는 교차 지점 정의(critic 배정)를 바꾸므로 따로 설계한다 |

### 일부 반영의 남은 부분

반영 86·범위 밖 34·보류 12건의 행별 처리와 메모는 원자료 [procedure-fix-2026-10-08.json](evidence/procedure-fix-2026-10-08.json)의 `disposition.rows`에 있다 — 반영은 [묶음별 주요 변경](#묶음별-주요-변경), 범위 밖은 [범위 밖·보류·남은 일](#범위-밖보류남은-일), 보류는 [보류 항목의 다음 배정](#보류-항목의-다음-배정)에 요약했다. 아래는 일부 28건이다. 처리 열의 커밋은 [단계와 커밋](#단계와-커밋)의 묶음이고, 지적 원문은 [감사 기록의 부록](2026-10-07-dual-host-process-audit.md#부록-전체-지적-목록)이 가리키는 감사 원자료에 있다.

| ID | 심각도 | 상태 | 처리 | 메모 |
|---|---|---|---|---|
| DOC-2 | high | 일부 | 감사 0807d32 + 공통 모듈 7b698d8 | 흐름도 process-flow.md 작성(감사 커밋). 코드 생성 블록은 §6.4 하나뿐이고 usage·design 의 중복 흐름 서술은 남음 |
| CON-6 | medium | 일부 | C5 b557e35·3485d37 | Claude 업무 답 관찰(answers.jsonl)·출처 게이트. Codex 는 관찰 없이 [Source]: 대화로 화면 노출 |
| DOC-10 | medium | 일부 | C5 b557e35·3485d37 | CLAUDE_HOOKS·CODEX_EVENTS 를 doctor 가 공유. update.ts hook 출력은 인라인 9개, 문서의 수치 반복은 그대로 |
| DOC-11 | medium | 일부 | 공통 모듈 7b698d8 + C5·C6·C7 | docSync(§6.4)·consentBinding·modelPolicy(codex.md 표)·hostText·templateText 대조. 수치·링크·USAGE 대조는 없음(usage.md:12·DOC-M1 이 그대로 통과) |
| FLOW-14 | medium | 일부 | C2 99628c5·c38c5bf | 코드가 쓴 질문만 범위 한정 — 메인이 쓴 출처 없는 질문은 여전히 겹치는 모든 작업을 낡게 한다(기록 '남은 위험') |
| FLOW-15 | medium | 일부 | C4 473a6aa + C7 442c8ac | hostNotation·templateText·planningChain·consentOutput 시험. 흐름도 생성·템플릿 명령 lint 는 없음 |
| HX-3 | medium | 일부 | 공통 모듈 7b698d8 + C5·C6·C7 | DOC-11 과 같은 범위의 기계 대조만, doc-gardening 없음 |
| OPT-2 | medium | 일부 | C7 4ca343f | --for claude\|codex 호스트별 출력(−51~57%). --for 없으면 전체, summary 첫 표시는 유지 |
| OPT-9 | medium | 일부 | C4 473a6aa + C7 442c8ac | CODEX_SENTENCES 표와 원문·잔재 시험. 호스트 조건 블록 전환은 안 함(정규식 변환 유지) |
| OPT-17 | medium | 일부 | 감사 0807d32 | 흐름도 있음, 코드 대조는 §6.4·일부 표만 |
| CON-13 | low | 일부 | C5 b557e35·3485d37 | matcher mcp__.*·MCP 경로 판정·Codex 미판정 도구 기록. Claude 쪽 프로세스 실패(PATH·timeout)는 여전히 비차단 |
| CON-15 | low | 일부 | C5 b557e35·3485d37 | 내용 해시 캐시·재대조 1회. hook timeout 명시는 하지 않음 |
| CON-17 | low | 일부 | C5 b557e35·3485d37 | 세션 밖 hook 설정 언급 거부·hook 누락 감지·시작 게이트. 폴더 단위 삭제(rm -rf .claude)는 못 막음 |
| DOC-7 | low | 일부 | C1 7b7ca8b·241094e + C4 473a6aa·73aaa78 + 전체 검토 반영 7e80d6b | design.md·usage.md init 에 --host. design.md §6 표의 verify·read·planning·consent 행 보강은 남음(다음 문서 묶음) |
| DOC-12 | low | 일부 | 문서 정리 eefd4e9 | 현행 문서(README·doc/*.md)의 변경 이력·경위 문장을 지우고 AGENTS.md 에 규칙을 적었다. README·usage 의 목차 밖 절(요구 분석·설계·계획, 검증 노드 실행, 관찰된 계획 작업)은 그대로 — 다음: 문서 구조(목차 밖 절 정리) |
| DOC-13 | low | 일부 | C5 b557e35 + C7 36e99f5 | CONSENT_ACTIONS·CONSENT_TITLES·CLAUDE_HOOKS·CODEX_EVENTS·PHASE_LABEL export. CLI 명령 상수 없음 |
| HP-14 | low | 일부 | 전체 검토 반영 7e80d6b | PATH 의 .cmd·.bat 와 실행 파일 변수의 없는 파일은 실행 불가가 아니라 설정 오류로 막는다(경로 오타로 필수 교차 검증이 빠지지 않게). .cmd 래퍼 파싱은 다음 묶음(호스트 동등성) |
| HP-15 | low | 일부 | C2 99628c5·c38c5bf + C1 7b7ca8b·241094e | Codex 담당·리뷰어 실패를 되돌림 없이 기록(subagentExit codex 0). 되돌림(block) 지원은 미확인이라 안 함 |
| HP-20 | low | 일부 | C1 7b7ca8b·241094e + C7 113c9f6 | 끄는 설정은 wontfix(두 호스트 설치 시 필수 — 사용자 결정). 시도별 비용 기록(C1)·usage 재시도 절 합산(C7) |
| OPT-3 | low | 일부 | C7 442c8ac·c700fda | ca-answer 조건부 읽기·SessionStart compact·clear 재확인 줄. 질문/동의 파일 분리는 defer |
| OPT-15 | low | 일부 | C5 b557e35 + C7 04af60d | cli.ts 지연 로드(C5)·hook 경로 명령 모듈 지연 로드(PreToolUse 104→95ms). hook 전용 번들은 defer |
| OPT-16 | low | 일부 | C7 36e99f5·1b0a5ec | context 렌더러 분리(바이트 동일)·서브에이전트 절 문장 2곳. submitPlan 등 거대 함수·템플릿 조각은 defer |
| PVR-10 | low | 일부 | C1 7b7ca8b·241094e | 9분 제한·지점 3·원인별 재실행 1·시도별 소요·비용 기록. --max-budget-usd 전달은 미룸 |
| PVR-14 | low | 일부 | C3 2bd69e5·357a471 | <?xml 선언이 있는 콘솔 JUnit 만·탐색 중단 기록. TAP 헤더 요구·보고서 경로 선언은 미룸 |
| PVR-19 | low | 일부 | C7 442c8ac | 독립 Task 병렬화는 wontfix(Codex agent_id 없음 — 이 전제는 뒤의 [실제 호스트 확인](#실제-호스트-확인-2026-10-08)에서 틀린 것으로 확인됐다. Codex hook 도 `agent_id`를 싣는다). Task 완료 판정 untouchedTaskFiles 만 fix |
| CON-18 | info | 일부 | C5 b557e35·3485d37 | hookPaths.test.ts 우회 말뭉치. 모드×호스트×도구 판정표·흐름도 생성은 없음 |
| HP-22 | info | 일부 | C4 473a6aa | 표기·문장째 치환으로 잔재 줄임. 변환 문구 품질 전수 점검은 없음 |
| PVR-20 | info | 일부 | 감사 0807d32 | 흐름도는 있으나 코드 생성은 §6.4 하나 |

## 시험

- **기준** — 감사 기준 커밋 `2c97a43`: `npm test` 802개 중 798개 통과·실패 0·생략 4(133초).
- **최종** — 재검증 지적 반영 커밋 `e75e8d7`의 트리: `npm run build && npm test` 1,357개 중 1,353개 통과·실패 0·생략 4(suites 189, `duration_ms` 140,176, 원자료 `realHost20261008.tests.reverify`). 시험 둘(W2 연결 확인 준비 실패, W4 doctor 의 옛 Codex 설치)을 더했고 W1·W5·W6 은 기존 시험에 단언을 더했다(W3 은 문서 수치). 고친 자리를 옛 동작으로 되돌린 `dist`·템플릿에서 해당 시험 다섯 개가 각각 실패하는 것을 확인했다. 실제 모델은 부르지 않았다.
- **중간 커밋** — 모두 실패 0·생략 4(suites 189)다: 문서 정리의 검증 지적 반영 `4838e1f` 1,337개 중 1,333개, 실제 호스트 반영 `5107697` 1,353개 중 1,349개, 검증 지적 반영 `1293955` 1,355개 중 1,351개 통과. `e7caf31`·`e14dbf9`·`e2afdca`의 트리도 각각 전체 시험을 통과했다(원자료 `tests`·`realHost20261008.tests`).

생략 4개는 플랫폼 조건(대소문자 구분 없는 파일 시스템 2개, POSIX chmod 2개)이다. 단계마다의 시험 수는 원자료의 `stages[].npmTest`에 있다.

## 실제 호스트 확인 (2026-10-08)

Windows 한 대에서 실제 호스트로 확인했다 — Claude Code 2.1.293, codex-cli 0.161.0(`[windows] sandbox=elevated`). 확인 대상 코드는 `0a77595`(그때 `src/`와 같은 판)이고, 실험은 작업 scratchpad 의 임시 저장소에서 했다. `~/.claude/settings*.json`·`~/.codex/config.toml`은 쓰지 않았다 — Codex 실행은 `-c projects=…`·`--dangerously-bypass-hook-trust`로 신뢰를 그 실행에만 주고, 끝난 뒤 `config.toml`이 시작과 바이트 단위로 같은지 확인했다. 반영은 실제 모델을 다시 부르지 않고 증거 원문을 고정 자료로 시험에 넣었다(본문·계정 정보 없이 키 꼴만).

**확인됨**

| 묶음 | 확인한 것 |
|---|---|
| Claude(CH1·CH2·CH3 일부·CH5) | hook 입력 — SessionStart(`startup`·`resume`·`compact`)·PreToolUse·PostToolUse·Stop·SessionEnd 의 `session_id`가 같고 `--resume`·`--continue`도 같은 id 다. 서브에이전트 hook 은 부모 `session_id`와 `agent_id`·`agent_type`을 싣는다. SubagentStop 되돌림(1차 `stop_hook_active=false` → 같은 `agent_id` 담당이 다시 답 → 2차 `true`). `run_in_background`를 주지 않은 Agent 호출이 백그라운드로 뜬 실행. 교차 `claude -p`(`--effort` 포함)의 정상 결과와 사용 한도·연결 실패 JSON 꼴(`is_error: true`·`subtype: "success"`·`api_error_status`·`api_error`) |
| Codex(CX1~CX5) | 프로젝트 hook 은 프로젝트 신뢰와 hook 신뢰가 둘 다 있어야 돈다(`codex exec`는 알리지 않고 건너뛴다). Windows hook 명령은 `powershell.exe -NoProfile -Command`로 돌고 Windows PowerShell 5.1 이 exit 2 를 1 로 바꾼다(로컬 `powershell.exe`로도 확인). 모든 이벤트가 같은 `session_id`를 싣고, 하위 에이전트 hook 은 부모 `session_id`와 `agent_id`·`agent_type`을 싣는다. 네 실행 모드의 셸 표지와 네트워크(권한 상승 셸에도 `CODEX_SANDBOX_NETWORK_DISABLED=1`), 샌드박스 셸의 연결 거부 꼴(`connect EACCES` — 그 안의 claude 는 `ECONNREFUSED`로 약 3분 재시도). 세션 기록(`rollout-*.jsonl`)의 꼴. 셸 hook 의 `tool_name: "Bash"`·`tool_input.command`(Windows 도 같다)와 하위 에이전트 조율 도구 이름 |
| 교차(XE1·XE2·XE4·XE5) | Claude 메인 → 실제 codex(`-c model_reasoning_effort` 포함)의 교차 리뷰·교차 계획 검토 completed 기록과 게이트(XE1·XE2), 잘못된 교차 옵션·모델의 설정 오류 갈래와 재실행 한도(XE4), `doctor --cross`의 옵션 점검(XE5) |

**고친 불일치** — 항목마다 증거와 코드로 다시 확인했고, 되돌리면 실패하는 시험(이름에 항목 번호)을 더했다.

| 항목 | 불일치 | 처리 |
|---|---|---|
| H1 | claude 사용 한도가 설정 오류로 분류됐다 — 실패 JSON 의 `api_error_status`·`api_error`를 보지 않았다 | `crossFailureText`가 그 둘과 `subtype`(`success` 제외)을 보고 한도 문구(`usage_limit_reached`·`session limit`)를 더했다. 교차 claude 의 캐시 생성·읽기 토큰을 따로 기록·합산한다 |
| H2 | 권한 상승한 Codex 셸에도 샌드박스 표지가 남아 사전 판정이 매번 거부했다(막다른 길) | 표지가 있으면 연결을 한 번 확인하고 `EACCES`·`EPERM`일 때만 거부한다(`crossNetProbe`). 그 뒤의 네트워크 오류는 그대로 샌드박스 거부라 게이트는 약해지지 않는다 |
| H3 | Windows Codex hook 의 종료 코드 — 동의 응답 실패가 메시지를 막지 못했고 PreToolUse 에 프로세스 실패 닫힘이 없었다. `--cli` 없는 설치는 실행 정책 Restricted 에서 `code-agent.ps1`로 막힐 수 있었다 | `commandWindows`를 이벤트별 꼴로 설치한다(`cmd /c`, PreToolUse 실패 2, UserPromptSubmit 종료 코드 전달). doctor 가 옛 꼴을 `✗`로 짚고 `update --templates-only`가 고친다 |
| H4 | Codex 하위 에이전트 hook 의 `agent_id`·`agent_type`을 넘기지 않아 계획 담당이 메인으로 보였다. 임대가 Codex 를 호스트만 비교했다 | `agent_id`·`agent_type`을 넘기고 실행 중인 Codex 계획 담당의 파일 쓰기를 거부한다. 읽기 전용 담당(critic·reviewer·surveyor)의 쓰기·진행 명령을 두 호스트에서 거부한다. 임대는 두 호스트 모두 세션까지 비교하고 Codex SessionStart 가 넘겨받는다(Codex hook 6개) |
| H5 | 프로젝트·hook 신뢰가 없으면 hook 이 돌지 않는다는 안내와 점검이 없었다 | doctor 의 `Codex 프로젝트 신뢰`·`Codex 훅 신뢰`(`config.toml` 읽기만), 설치·Codex 문서의 신뢰 절차 |
| H6 | Codex 사용량이 0.161.0 기록 꼴을 읽지 못했다(명령·스킬 읽기 0, 배열 결과 0자, 하위 에이전트가 섞임) | `CommandExecution`·`FileChange`·`token_usage_record`(없으면 `token_count`, 다시 낸 줄은 버린다)·하위 에이전트 행·부모 사본 제외·캐시 쓰기 |
| H7 | Agent 호출이 백그라운드로 떠 담당 결과 전에 메인 차례가 끝날 수 있었다 | 담당을 부르는 스킬 문장 11곳에 `run_in_background: false`를 적고 Codex 사본은 결과를 기다리는 문장으로 바꾼다. Stop hook 은 끝남을 판정하는 경로가 없어(계획 밖 변경·미응답 질문만 막는다) `background_tasks`를 보지 않는다 |
| H8 | Codex 교차 성공 기록에 토큰이 없다 | **보류** — 사람용 출력은 `tokens used` 다음 줄의 합계 하나라 입력·출력으로 나뉘지 않고 숫자의 뜻도 확인하지 못했다. `--json`으로 바꾸면 교차 실패 분류의 입력(배너·전사 규칙)이 바뀐다 |
| H9 | 셸 hook 이름 `PowerShell`은 오지 않고, 하위 에이전트 조율 도구가 미판정 도구로 잡혔다 | 주석·문서를 실측으로 고치고 조율 도구(`collaboration…`)를 미판정 집계에서 뺐다 |
| H10 | 교차 claude 자식 환경에 Claude Code 메시징 변수가 남았다 | `crossChildEnv`가 `CLAUDE_CODE_MESSAGING_SOCKET`·`CLAUDE_CODE_MESSAGING_TOKEN`을 지운다 |
| H11 | (문서) 세션 id·재개의 실측 | 흐름도·Codex 문서의 임대 설명에 실측을 적고, 같은 세션을 두 터미널에서 이어 열면 임대 보유자가 하나로 보인다는 한계를 적었다 |
| H12 | (기록) | 이 절과 원자료 `realHost20261008` |

**실제 호출 수·비용**(증거 폴더에서 집계, 원자료 `realHost20261008.calls`) — Claude: 스트림 세션 7개(결과 줄 8개) $0.615, 교차 `claude -p` 3회 중 정상 1회 $0.074(한도·연결 실패 2회는 비용 기록 없음), 합 약 $0.69. Codex: `exec` 10회(모델 차례가 끝난 6회 — 잘못된 모델 이름 4회는 차례 전에 끝났다) 입력 536,711(캐시 입력 403,584)·출력 3,590 토큰, Codex 메인 e2e 2회(세션 기록 입력 164,854 토큰) — 단가표가 없어 비용은 산정하지 않았다. 교차 e2e 시도 15회(codex 7·claude 8, 사전 거부·사람 중지 제외) 소요 합 약 644초.

### 반영 뒤 실제 호스트 재확인

반영 커밋 `5107697`의 `src/`를 같은 PC 에서 실제 Codex 로 다시 확인했다 — codex-cli 0.161.0, 임시 저장소(하네스로 리뷰·분석 배정 직전까지 만든 두 호스트 설치 저장소 포함). 신뢰는 `-c projects=…`·`--dangerously-bypass-hook-trust`로 그 실행에만 주었고, `~/.codex/config.toml`은 시작과 끝의 sha256 이 같고 바이트 단위로 같다. claude 는 띄우지 않았다.

| 항목 | 확인한 것 |
|---|---|
| H3 UserPromptSubmit | Codex 가 `powershell.exe -NoProfile -Command "cmd /c code-agent codex-event; exit $LASTEXITCODE"`로 돌렸고(부모 명령줄 실측), 동의 응답 실패(exit 2)로 프롬프트가 막혔다 — 모델에 가지 않아 `turn.completed` 사용량이 0 이다. 옛 꼴에서는 같은 프롬프트가 모델까지 갔다 |
| H3 PreToolUse | `… ; if ($LASTEXITCODE -ne 0) { exit 2 }`로 돌았다. 거부 JSON(exit 0)은 막혔고, 판정 전에 죽는 경우(stdout 없이 exit 1 을 흉내 낸 래퍼)는 exit 2 로 닫혀 막혔다. 허용 명령은 실행됐다. 모델 없이 같은 꼴을 돌린 사전 확인 — 거부 0·허용 0·판정 전 종료 2·읽기 전용 역할 거부 0(거부 JSON)·동의 실패 2·일반 메시지 0, PATH 에 code-agent 가 없으면 UserPromptSubmit 1(막지 않음)·PreToolUse 2(막음) |
| H2 샌드박스 쪽 | `-s workspace-write`에서 `review cross --by claude`가 사전 거부됐다(`연결 확인 api.anthropic.com:443 EACCES`). `preflight`·`host-sandbox-denied` 시도 한 건이 남고 지점 시도에는 세지 않았으며, `status`는 '교차 막힘(샌드박스)'·권한 상승 안내·'중지로 기록하지 않았습니다'를 냈다. claude 는 뜨지 않았다 |
| H2 권한 상승 쪽 | 실제 실행은 하지 못했다([미확인](#실제-호스트에서-확인하지-않은-것)). 샌드박스 밖 셸에 실측 표지(`CODEX_SANDBOX_NETWORK_DISABLED=1`·`CODEX_CI`·`CODEX_THREAD_ID`·`CODEX_VERSION`)를 넣고 함수만 확인했다 — 연결 확인 `ok`(87ms), 사전 판정 통과. `CODE_AGENT_CROSS_PREFLIGHT=off`면 둘 다 하지 않는다 |
| H4 읽기 전용 담당 | Codex 하위 에이전트 `ca_surveyor`의 hook 입력에 `agent_id`·`agent_type`이 있었다(`session_id`는 부모와 같고 `turn_id`는 자기 것). `apply_patch`와 `code-agent next`는 '읽기 전용 담당입니다'로 거부돼 파일이 생기지 않았고, 읽기 명령은 허용됐다 |
| H4 계획 담당 | 실제 `ca_analyst`의 SubagentStart 가 첫 도구 호출보다 먼저 와 실행 중 배정에 연결됐고, 그 담당의 `apply_patch`가 'Codex 계획 담당은 파일을 쓰지 않습니다'로 거부됐다. SubagentStop 은 결과 형식 오류로 기록됐다(exit 0 — 되돌리지 않는다) |
| H4 SessionStart 임대 | 실제 `codex exec`의 SessionStart(`startup`)가 하네스 세션이 쥔 임대를 넘겨받았고(`session-start`) 이어진 진행 명령이 임대로 거부되지 않았다 |
| H9 | 조율 도구 이름은 `collaborationspawn_agent`·`collaborationwait_agent`이고 미판정 도구로 세지 않았다. 셸 도구는 Windows 에서도 `Bash`·`tool_input.command`다 |
| H6 | `usage --json`이 실제 세션 기록에서 하위 에이전트 행(`ca-surveyor`·`ca-analyst`)·`CommandExecution` 명령(하위 에이전트 것 포함)·스킬 읽기를 셌고, 메인 행이 `turn.completed` 사용량과 같다 |
| H5 | `doctor --host codex`가 `-c` 덮어쓰기만 쓴 저장소를 '신뢰 항목이 없습니다'(·)·'훅 신뢰 확인 필요'로 알렸다 |

**호출 수·비용** — `codex exec` 4회(메인 `model_reasoning_effort=low`): 잘못된 모델 1회(토큰 0), 메인 입력 221,605(캐시 입력 152,320)·출력 2,285 토큰, 하위 에이전트 `ca_surveyor` 입력 104,227(캐시 입력 77,568)·출력 253, `ca_analyst` 입력 80,919·출력 779. claude 0회. 비용은 Claude 0달러이고 Codex 는 단가표가 없어 산정하지 않았다.

### 검증 지적 처리

반영 커밋(`e7caf31..5107697`)을 코드와 실제 호스트로 다시 본 검증 지적이다. 지적마다 코드로 확인했고, 고친 것에는 되돌리면 실패하는 시험을 더했다(검증 지적 반영 커밋 `1293955`, 부모 `5107697`).

| 지적 | 판정 | 처리 |
|---|---|---|
| doctor 가 `--cli` 설치의 Stop·Subagent 이벤트를 `commandWindows`가 없다는 이유만으로 `✗`로 셌다 | 맞음 | `commandWindows`가 없으면 Codex 가 돌리는 `command`로 비교한다. 사유는 이벤트별이다 — PreToolUse·UserPromptSubmit 은 종료 코드, `--cli` 없는 설치는 `code-agent.ps1`과 실행 정책 |
| Codex exit 2 서술이 서로 어긋났다('종료 코드 2로 막지 않는다'고 적고 바로 뒤에서 PreToolUse 프로세스 실패를 exit 2 로 막는다고 적었다) | 맞음 | 'Codex 는 exit 2 와 stderr 사유를 막음으로 받는다(PreToolUse·UserPromptSubmit 은 실제 호출로 확인), code-agent 는 PreToolUse 판정 실패를 거부 JSON 으로 막고 exit 2 는 판정 전 프로세스 실패의 닫힘으로만 쓴다'로 문서·주석을 맞췄다. Stop·SubagentStop 의 exit 2 이어가기는 바이너리 문구로만 보아 미확인에 둔다 |
| doctor 가 상위 폴더 신뢰를 `✓`로 봤다 | 맞음 | 저장소 자체 항목만 `✓`, 상위 폴더 항목만 있으면 '확인 필요'(`·`)다 |
| 단일 실행 파일에서 연결 확인(`process.execPath -e`)이 돌지 않는다 | 맞음 | 연결 확인을 같은 프로세스의 worker(`Atomics.wait`로 동기 대기)로 바꿨다. 같은 가정의 `hostCommand`도 `.js` 진입점을 PATH 의 node 로 돌리고(`scriptRunner`), 실행 파일 변수가 가리킨 `.js`를 돌릴 node 가 없으면 설정 오류(게이트 막힘)다 |
| 이전 버전 절차(`legacy.md`)의 담당 호출에 전경 실행 문장이 없었다 | 맞음 | 다섯 곳에 정본 문장을 넣고 시험이 보조 문서까지 훑는다(담당 호출 16곳) |
| Windows 시험에 깨진 설치의 UserPromptSubmit 1 단언이 없었다 | 맞음 | 단언을 더했다 |
| 교차 자식 환경에 Claude 세션 값이 남는다 | 맞음(방어) | 세션 id·자식 세션 표지·pid·추론 강도·사람 응대 표지도 지운다(`CLAUDE_SESSION_ENV`). 세션에 묶이지 않은 `CLAUDE_CODE_EXECPATH`·`AI_AGENT`는 남긴다 |
| SessionStart 가 없는 옛 Codex 설치의 임대 이행 영향이 문서에 없다 | 맞음(문서) | Codex 문서 갱신 문단에 새 세션이 `takeover`를 요구받는다는 것과 `update --templates-only --host codex`를 적었다 |
| 게이트 줄이 같은 사유를 두 번 싣는다(기존 동작) | 맞음 | 안내 문구가 사유를 싣으면 '직전 실행:' 뒤에는 라벨만 둔다(`crossLastRun`) |
| `codex exec`에서 hook 거부가 출력에 드러나지 않는다 | 맞음(문서) | Codex 문서에 적고 `consent status`로 확인하라고 했다 |
| 권한 상승 셸의 실제 claude 교차(R-H2) | 미확인 | 자동 모드 분류기가 실행 전에 막았다 — [미확인](#실제-호스트에서-확인하지-않은-것)에 사람이 돌릴 절차를 적었다 |

### 재검증 지적 처리

검증 지적 반영 커밋 `1293955`를 코드로 다시 본 지적이다(실제 모델은 부르지 않았다). 지적마다 코드로 확인했고, 고친 것에는 되돌리면 실패하는 시험·단언을 더했다(재검증 지적 반영 커밋 `e75e8d7`). 판정·게이트·사람 확인 지점은 바꾸지 않았다 — 설정 오류(막힘)와 미설치(실행 불가)의 갈래(D3)는 그대로이고, 고친 것은 그 갈래에 들어가는 입력과 안내다.

| 지적 | 판정 | 처리 |
|---|---|---|
| W1 단일 실행 파일의 `scriptRunner`가 PATH 의 첫 `node`만 봐서, 앞 디렉터리의 `node.cmd` 셰임(mise·nodist 류)이 뒤의 `node.exe`를 가렸다 — `.js`를 가리키는 실행 파일 변수가 설정 오류(`CONFIG_NODE`)로 막히고 npm 진입점을 건너뛰어 `claude.cmd`의 설정 오류(`CONFIG_SCRIPT`)가 됐다. `CONFIG_SCRIPT` 안내는 단일 실행 파일에서도 '`.exe`·`.js`를 지정'이라고 했다 | 맞음 | PATH 디렉터리마다 보고 셸 스크립트 `node`는 건너뛴다. 실행 파일 변수의 안내(`hostCommand`·doctor 의 교차 검증 줄)는 `binHint` 하나로, 단일 실행 파일이면 '`.exe` — `.js`는 PATH 에 node 실행 파일이 있을 때만'이다. 시험은 셰임 앞·실행 파일 뒤와 그 반대 순서, 두 안내 문구를 단언한다(Windows) |
| W2 연결 확인의 `SharedArrayBuffer` 할당·`Atomics.wait`가 `try` 밖이라, 공유 메모리가 없는 런타임에서 `ReferenceError`가 교차 명령 밖으로 나가 내부 오류로 끝났다(약속한 '띄우지 못하면 `worker-…`'와 다름) | 맞음(낮은 위험 — 명령줄 플래그로만 생기는 런타임) | `connect` 본문 전체를 `try`로 감싸 `worker-<code>`(없으면 `worker-error`)를 돌려주고, 띄운 worker 는 `finally`에서 정리한다. 시험은 전역 `SharedArrayBuffer`를 지운 실행과 `Atomics.wait`가 던지는 실행에서 `worker-…`와 사전 판정 통과를 본다 |
| W3 이 요약의 Codex 흐름 합계가 49,262자로 적혀 있었다(실제 49,014자) | 맞음 | 템플릿 크기 예산 절의 수치를 49,014자로 고쳤다(`5107697`·`1293955` 트리 모두 같다). 이번 커밋의 합계도 함께 적었다 |
| W4 doctor 의 빠진 Codex 이벤트 안내가 언제나 `init --host codex`였다 — Codex 문서는 SessionStart 없는 옛 설치에 `update --templates-only --host codex`를 안내했고, 작업 중의 계획 밖 변경 유보도 없었다. 설치 문서 표에 `--cli` 예외가 없었다 | 맞음 | 다른 이벤트는 있는데 일부만 빠졌으면(옛 설치) 옛 Windows 명령과 같은 `update --templates-only --host codex`(작업 중이면 작업이 끝난 뒤)를 안내하고, 우리 이벤트가 하나도 없을 때만 `init --host codex`다. 설치 문서 표에 옛 설치와 `--cli` 예외를 적었다 |
| W5 hook 신뢰 기록을 부분 문자열로 찾아 앞부분이 같은 형제 저장소(`<저장소>-old`)의 기록을 이 저장소의 것으로 알렸다 | 맞음 | 키가 저장소 경로이거나 그 아래 경로로 시작할 때만 기록으로 본다(다른 꼴은 '확인 필요' — 안전한 쪽). 형제 경로 fixture 를 H5 시험에 더했다 |
| W6 `ca-implement` 5항의 다시 맡기기('같은 서브에이전트에게 그 Task만 한 번 더 맡긴다')에 전경 실행 문장이 없고 시험 정규식에도 걸리지 않았다 | 맞음 | 그 항목에 정본 문장을 넣고(Codex 사본은 결과를 기다리는 문장), 시험 정규식에 '서브에이전트에게 … 맡긴다' 꼴을 더했다(담당 호출 17곳). 파일 예산은 2,700 으로 올렸다([템플릿 크기 예산](#템플릿-크기-예산)) |

## 실제 호스트에서 확인하지 않은 것

위 확인과 반영 뒤 재확인을 거친 뒤에도 실제 호스트로 확인하지 않은 것이다 — 판독·바이너리 문자열·fixture 로만 확인했다.

- **대화형 AskUserQuestion**(CH3 일부·CH4) — 대화형 세션의 질문 도구 입력 꼴과 긴 본문이 잘리는지. → 긴 본문의 잘림은 PTY 하네스(Claude Code 2.1.296)로 확인하고 고쳤다([2026-10-13 결과 요약의 실제 호스트 확인](2026-10-13-result-summary.md#실제-호스트-확인)). 입력 꼴은 여전히 미확인이다 — 사람이 대화형 세션에서 확인한다.
- **Codex 메인 → 실제 claude 교차의 권한 상승 쪽**(XE3·R-H2) — 샌드박스 쪽 사전 거부는 재확인했지만, 권한 상승한 셸에서 연결 확인을 지나 실제 claude 교차가 completed(비용·토큰·캐시 토큰)로 기록되는지와 claude 사용 한도(429)가 실행 불가(`cross-unavailable`·`quota` — 중지 기록 후 진행)로 분류되는지는 실제로 보지 못했다. 확인 세션은 Claude Code 자동 모드 분류기가 그 `codex exec`(`approval_policy=on-request`·`--approve-for-me`)를 실행 전에 막았고(거부 사유 `Create Unsafe Agents`), 그 전에는 claude 사용 한도에 걸렸다. 사람이 Claude Code 밖의 터미널에서 확인한다 — 두 호스트를 설치하고 리뷰 직전까지 진행한 임시 저장소에서 Codex(승인 `on-request`)에 `code-agent review cross --by claude`를 샌드박스 안에서 한 번, 권한 상승으로 한 번 실행하게 한다. 기대: 첫 번째는 같은 사전 거부(같은 사유면 시도가 늘지 않는다), 두 번째는 `.code-agent/work/<작업>/value.review.json` 마지막 회차 `crossAttempts`에 `mode: review`·`completed`(`usage`의 `costUsd`·`inputTokens`·`cacheCreationInputTokens`·`cacheReadInputTokens`), 한도면 `cross-unavailable`·`quota`. 끝나면 `~/.codex/config.toml`이 시작과 같은지 본다.
- **code-agent 의 Codex 교차 자식**(`codex exec -s read-only --ephemeral`)에서 프로젝트 hook 이 도는지 — 추론만 했다. 교차 자식의 hook 은 진행 기록을 하지 않고 PreToolUse 는 진행 명령·쓰기를 거부하므로 돌든 안 돌든 작업 기록은 바뀌지 않는다.
- **Codex hook 신뢰 기록의 키 꼴**(`config.toml`의 `hooks.state`) — 바이너리 문자열로만 보았다. → 신뢰 판정을 실제 Codex 조회(`config/read`·`hooks/list`)로 옮겨 이 꼴을 해석하지 않는다([Codex 실행 준비 판정](2026-10-22-codex-readiness.md)).
- **Codex 의 상위 폴더 신뢰** — 상위 폴더의 `trust_level`을 그 안의 저장소에 적용하는지. 실측한 신뢰 항목은 모두 저장소 경로 자체였다. → 상위 폴더만 신뢰하면 프로젝트 hook 이 로드되지 않는 것을 실제 Codex(0.163.0)로 확인했다([Codex 실행 준비 판정](2026-10-22-codex-readiness.md)).
- **Codex 대화형 TUI 의 hook 거부 표시** — `codex exec`에서는 동의 응답 거부의 사유가 출력에 없고 PreToolUse 거부는 모델 답으로만 보였다(재확인). 대화형 화면은 보지 않았다.
- 실제 오류 문구 중 인증·서비스 장애(두 호스트)와 Codex 의 사용 한도·네트워크 문구 — 교차 실패 분류 화이트리스트(C1). 처음 보는 문구는 설정 오류(막힘)로 간다.
- Codex 셸의 PTY 실행 여부 — 직접 CLI 확인(`confirmOnTerminal`)이 호스트 표지를 보지 않는 한계가 여기에 걸린다.
- Codex SubagentStop·Stop 의 exit 2 이어가기(HP-15) — 0.161.0 바이너리에는 'SubagentStop hook exited with code 2 but did not write a continuation prompt' 같은 문구가 있어 exit 2 와 stderr 를 이어가기로 받는 것으로 보이지만 실제로 확인하지 않았다. code-agent 는 Codex 담당을 되돌리지 않는다(언제나 기록 후 0).
- Claude Code 가 `xhigh`·`max`를 `high`로 낮추는지(바이너리 문자열로만 확인), 이전 설치의 하위 에이전트가 세션 강도를 물려받았는지(C6).
- `/clear` 뒤 SessionStart 의 `source` 값, Claude Code 의 PowerShell 도구 대체 버전(C5).
- Codex 를 메인으로 한 접수부터 반영까지의 전체 흐름(HP-21). → 2026-10-20 실제 완주 시도는 `start`의 `.git/index.lock` 권한 거부로 미통과했다([종료 독립 세션 복원과 실제 모델 검증](2026-10-20-session-recovery-live.md)).
- 단일 실행 파일(SEA) 빌드 — 이 기록에서는 돌리지 않고 esbuild 번들로 지연 `require`만 확인했다(C7). SEA 빌드·스모크는 뒤의 [LangGraph 전체 실행 전환](2026-10-16-langgraph.md)에서 했다. 같은 프로세스 worker 의 연결 확인과 `.js` 진입점의 PATH node 해석(셸 스크립트 셰임 건너뛰기 포함)도 단일 실행 파일로는 돌려 보지 않았다(npm 설치에서 `process.execPath`를 없는 경로로 바꾼 시험과 임시 PATH fixture 만 했다).

## 유료 A/B 측정 — 미실행

사용자 승인 뒤에 돌린다. 실제 모델을 부르는 평가는 돌리지 않았다.

- 역할별 모델(C6) — `node scripts/evaluate-full-flow.cjs run new --model opus --agents exec-opus --label c6-execopus-<n>`과 `--agents policy --label c6-policy-<n>`을 각 3회 돌린다. 두 쪽은 실행 역할의 모델 하나만 다르다.
- 최적화 효과(C7) — `scripts/evaluate-full-flow.cjs` 3회(보고서의 `usageData`·`retry`·`numTurns`)와 `scripts/summarize-evaluations.cjs`로 흐름당 메인 요청·도구 호출·비용을 잰다. 동의 왕복은 평가 드라이버가 TTY fixture 로 대신하므로 실제 세션의 `usage` 명령별 호출로 잰다.
- 기준선 — 2026-10-06 opus 기준선 보고서(`full-flow-new-2026-10-06-opus-baseline`·`-both`·`-optimized`·`-optimized-v2`·`-optimized-v3`.json)와 토큰 효율 원자료(`token-efficiency-2026-10-06.json`)는 작업 트리에서 지웠고 `2c97a43`의 `doc/reviews/evidence/`에 있다. `--agents opus`(모든 역할 opus, 강도 줄 없음)는 이 기준선과 잇는 용도로만 쓴다. `summarize-evaluations.cjs`는 작업 트리의 `doc/reviews/evidence/`만 읽으므로 기준선과 견주려면 먼저 꺼내 둔다 — 예: `git show 2c97a43:doc/reviews/evidence/full-flow-new-2026-10-06-opus-baseline.json > doc/reviews/evidence/full-flow-new-2026-10-06-opus-baseline.json`.
- `evaluate-full-flow.cjs`의 기본 `--label`은 `2026-10-01`이다. 이름을 주지 않으면 지운 옛 보고서와 같은 이름(`full-flow-<유형>-2026-10-01.json`)으로 새 보고서를 쓰므로 실행마다 `--label`을 준다. 기본값 수정은 GAP-4(날짜 고정 파일명)와 함께 한다.

## 범위 밖·보류·남은 일

**범위 밖**(사용자 결정)

- 자가 학습 — 교훈·recall·retro·환류(지적 17건, GAP-3 포함 18건). 측정은 읽기만 한다.
- HX-5 — 작은 작업용 경량 경로.
- Codex 호스트 동등성 14건 — Codex 검색 수단(`code-agent grep`·`files` 없음, HP-1), Codex SessionStart(HX-6·HP-6·CON-10 — 뒤의 실제 호스트 반영 H4 `e14dbf9`가 등록했다), 역할 TOML 쓰기 제한(HP-7·HOST-M2 — TOML 은 그대로이고 H4 가 읽기 전용 담당·Codex 계획 담당의 쓰기를 hook 으로 거부했다. Codex 계획 담당은 뒤의 `4e0c786`부터 staging 에만 쓴다), Codex Stop 반복 차단 상한(CON-11), AGENTS.md 32KiB 한도(GAP-2), `ca-answer/reference.md` 고아(DOC-M2·OPT-M1), `code-agent read` JSON 출력(HP-17), Codex 단독 doctor·update 검사(HP-18), 상시 지침 블록 대조(HP-19), Codex 메인 평가 하네스(HAR-M1).
- 실제 모델 호출(작업 규칙) — HP-21.

**사용자 결정 필요** — CI 도입과 실행 플랫폼(GAP-5). 지금은 Windows 한 대에서만 돈다. 그리고 진행 중인 작업 위에서 `update --templates-only`가 바꾼 설치 파일(`.gitignore` 블록·스킬·에이전트 사본·hook 설정)을 계획 밖 변경에서 따로 다룰지다(C4 — 지금은 알리기만 한다, `update.ts` `outsideNotice`).

**보류** — 위 [보류 항목의 다음 배정](#보류-항목의-다음-배정)의 12건(배포·버전, 측정, 문서 구조, 검증 효율, KNOWLEDGE 반영, 최적화 2차).

**남은 일**

- 일부 28건의 남은 부분([일부 반영의 남은 부분](#일부-반영의-남은-부분)의 메모).
- 전체 검토에서 일부만 반영한 것 — E13 의 (b)안(총 회차를 사람 허용 대상에), E19 의 기록하지 못한 판정 실패(2로 남김), E26 의 동의 적용 잠금 나이 상한, E27 의 다른 세션 경고 줄, E30 의 판정하지 못한 MCP 이름 기록.
- 문서화된 한계 — 두 터미널이 같은 세션을 이어 열면(재개 — 같은 `session_id`) 작업 임대는 한 주인으로 본다. `codex exec resume` 프롬프트는 가르지 못한다(CON-1). Codex 확인 코드는 사람 입력의 증명이 아니다(CON-5).
- hook 의 셸 언급 판정은 글자 그대로 쓴 경로만 본다 — 따옴표로 쪼갠 이름이나 변수로 조립한 이름은 잡지 못한다(hook 은 보안 경계가 아니다). 이름으로 모르는 UNC(FQDN 등)로 사용자 수준 호스트 설정을 가리키면 파일 시스템이 주는 (dev, ino)에 기댄다. 비파일 MCP 서버의 판정은 사용자 수준 호스트 설정 네 파일만 넓혔다 — 그 밖의 저장소 밖 쓰기는 원격 서비스 오탐을 피하려고 판정하지 않는다.
- 검증 명령이 code-agent 기록을 바꾼 실행에서 verify 는 결과 JSON 을 내지 않는다(`precondition`의 노드 없는 Stop 설계). check 커서에서 같은 회차 test 의 기록 변경이 있으면 단계별 게이트라 `next`는 test 로 넘어간 뒤에 막힌다(`다음:`·verify 는 그 자리에서 사유를 낸다). 흐름도의 `src/` 줄 인용은 머리말 규칙대로 기준 커밋 기준이라 HEAD 와 기계 대조하지 않는다.
- 비동기 자식(`spawn`)이 끝난 뒤의 `.pid`를 죽은 pid 로 쓰는 꼴은 시험이 탐지하지 않는다.
- doctor 의 `models.json` 형식 오류 안내와 Claude '스킬·에이전트' 줄(소스 `code-agent update` 처방)은 작업 중 안내를 달지 않았다. 작업이 없을 때 승인한 model 동의를 작업 시작 뒤 적용하면 대상 변경으로 폐기되고 안내는 '새로 준비'다.
- Codex 에서 부른 적이 없는 지점을 호스트 표지 없는 셸이나 두 표지가 섞인 셸에서 처음 `--by claude`로 실행한 네트워크 오류는 실행 불가(중지 기록 후 진행)다. 권한 상승한 Codex 셸에는 표지가 남아(실측 — 지금 호스트는 codex) 이 갈래에 들지 않는다.
- 단계 기록이 남긴 위험과 한계 — 지운 단계 기록(`0a77595`)의 '남은 위험'·'남는 한계' 절 가운데 정리 시점(`4838e1f`) 코드에서 아직 맞던 것이다. 뒤 커밋이 고친 것(`review.json` 잠금 없는 저장 → C1 `mutateReview`, 사람 판단 동의 부재 → C5 `judgment`, 하위 폴더 세션의 hook 루트 → E25, 권한 상승한 Codex 메인의 첫 네트워크 오류 → D2·G6)과 위 미확인 목록·감사 메모에 이미 있는 것은 뺐다.
  - **교차 — Codex 전사의 끝 `ERROR:` 줄**(C1, `retryPolicy.ts` `crossFailureText`의 Codex 세션 갈래). 읽은 파일·도구 출력의 마지막 줄이 화이트리스트 문구의 `ERROR:` 줄이고 Codex 가 자기 오류 줄 없이 신호가 아닌 종료 코드로 끝나면(Windows 강제 종료 등) 그 줄을 Codex 의 오류 줄로 읽는다. 그 문구가 실행 불가(인증·한도·네트워크·장애)에 맞으면 중지가 기록되고 게이트가 통과한다 — '두 호스트면 교차 필수'·'게이트 약화 금지' 결정에 걸리는 남은 틈이다. 도구 실행 뒤 한도에 닿아 Codex 가 스스로 낸 `ERROR:` 줄과 글로 가를 수 없어 남겼다. 실제 Codex 오류 출력 꼴(위 미확인 목록의 실제 오류 문구 항목)을 확인할 때 함께 정한다.
  - 교차 — 분류 창이 좁아 앞줄에 원인이 있는 실행 불가는 `unclassified`(설정 오류)로 막히고, Codex 가 오류 줄 뒤에 안내 줄을 더 찍는 꼴이면 실행 불가도 막힌다(안전 쪽 — 원문은 `logPath`에 남는다).
  - 리뷰어 — 사용자가 리뷰어를 중단하면 그 실행은 고아 기한(`TIMING.reviewerOrphanMs`, 15분)까지 실행 중이라 그동안 새 호출이 결과를 쓰지 않는다(게이트 문구가 시각과 남은 횟수를 알린다).
  - 계획 — 시작이 관찰된 담당의 고아 기한(`TIMING.orphanRunMs`, 60분)은 근거 없는 보수적 값이다. 큰 영역 조사가 넘기면 의심 고아(`stale`)로 보여 살아 있는 담당이 취소될 수 있다(`elapsedMin`·`observedStart`를 함께 보인다).
  - 계획 — 작업 총 배정 한도(`taskTotal`, 6)는 질문 답에 따른 정상 재배정과 취소·고아도 센다. plan·critic 은 critic 지적·교차 지적·critic 질문만으로도 닿을 수 있다(넘으면 사람 허용 `judgment retry-grant taskTotal`이나 abort).
  - 계획 — 자동 되감기의 같은 사유 키는 낡은 원인 문구로 만든다(`planning.ts` `rewindOf`). 같은 파일을 정당하게 두 번 고쳐도 두 번째 되감기는 사람에게 묻는다(보수 쪽).
  - 검증 — `worktree.lock`·`retry.started`의 pid 가 다른 살아 있는 프로세스로 재사용되면 표지 나이 한도(명령 한도×3+10분)까지 실행 중으로 본다. 보고만 하는 이전 버전 이름의 임시 worktree 는 사람이 지울 때까지 매번 보고된다.
  - 검증 — 결과 미확인 회차의 수집 수정 창에서 hook 은 쓰기 내용을 보지 않는다. 창은 실패가 없는 회차에만 한 번 열리고, 바뀐 파일은 ⑧ 수정 루프 줄과 독립 리뷰에 남는다.
  - 반영 — ⑩ `변경 요약`은 기준 커밋과의 차이 전부(반영하지 않는 handoff·staging·잠금 포함)를 보인다. 커밋 대상 목록(동의 미리보기)과 커밋은 그것을 뺀다(`deliveryExcludes`). 잠금 파일 제외의 문자 클래스 이스케이프(`[[]`)는 Windows git 2.55 에서만 확인했다.
  - 임대 — 보기만 하려고 두 번째 Claude 세션을 열어도 임대가 그쪽으로 간다(원래 세션은 다음 진행 명령이 거부되고 `takeover`로 되찾는다). 임대 30분(`LEASE_IDLE_MS`)은 사람이 응답을 30분 넘게 미루면 다른 세션이 넘겨받을 수 있다는 뜻이다. `takeover` 전의 사용자 확인은 스킬 규칙이고 코드가 강제하지 않는다.
  - 동의 — 프로세스 안의 기록 직접 조작과 `[Source]: 대화`의 자기 선언은 막지 못한다(화면에 드러낼 뿐이다). MCP 쓰기 여부는 도구 이름의 동사로 추정한다(`hook.ts` `MCP_WRITE_VERBS`).

## 지운 기록

문서 정리 `eefd4e9`에서 이 기록으로 합치고 지운 단계 기록과 evidence 다. 원문은 `0a77595`의 트리에 있다(예: `git show 0a77595:doc/reviews/2026-10-08-full-review.md`).

| 기록 | 내용 |
|---|---|
| `2026-10-07-retry-policy-module.md` | 공통 재시도 규약 모듈과 독립 검토 14건 |
| `2026-10-07-planning-retry-orchestration.md` | C2 계획 오케스트레이션과 독립 검토 |
| `2026-10-07-verify-retry.md` | C3 검증 재시도와 독립 검토 16건 |
| `2026-10-07-role-models.md` | C6 역할별 모델과 구현 검토 |
| `2026-10-07-cross-integrity.md` | C1 리뷰·교차 검증 무결성과 독립 검토 |
| `2026-10-08-consent-hook-boundary.md` | C5 동의·hook 경계와 독립 검토(원자료 `evidence/consent-hook-boundary-2026-10-08.json`) |
| `2026-10-08-stage-flow.md` | C4 단계 전이·CLI 안내·작업 임대와 독립 검토 |
| `2026-10-08-optimization.md` | C7 최적화와 독립 검토(실측은 위 [최적화 실측](#최적화-실측)) |
| `2026-10-08-full-review.md` | 전체 검토 43건·R1~R6·F1~F4·D1~D3·G1~G8 의 지적별 처리와 시험 |
| `2026-10-08-audit-disposition.md` | 감사 160건 처리 현황(원자료 `evidence/audit-disposition-2026-10-08.json` — 위 [처리 현황](#감사-160건-처리-현황)과 원자료의 `disposition`으로 옮김) |

같은 커밋이 현행 문서에서 지운 상태 표와 실측(설계 §11 의 구현 순서 P1~P8 표와 P3 실측 기준치, 제목의 P 상태 표지)은 `git show 0a77595:doc/design.md`로 본다(근거 문장은 설계 §7 에 남았다).

재검증 로그와 sandbox 는 작업 scratchpad 에 있었다. `dist/`와 함께 재생성 가능한 로컬 산출물이라 커밋하지 않았다.
