# agent-knowledge 선택 연결 검증

현재 동작은 [플러그인 §10](../plugins.md#10-agent-knowledge-연결), [흐름도 §1.1·§5.3·§5.4·§8](../process-flow.md), [master 연동](../master-control.md)을 따른다. 검증 대상의 상태 형식 세대는 25다. 최신 전체 자동 시험의 결과·실행 조건도 이 기록에 있다.

## 검사 조건

- Windows 11, Node v24.19.0, Git 2.55.0.windows.5. 기준 커밋 `182d49f48257d0c37bedb1907562b70f747e734c`의 작업 트리에서 검사했다 — 회차 커밋 합치기의 미커밋 변경([그 검증](2026-11-03-cycle-squash-validation.md))과 이 연결 변경이 함께 있다.
- `package.json`·`package-lock.json` 변경이 없어 `npm ci`는 생략했다. `npm run build` 뒤 `npm test`를 실행했고 전체 시험은 파일 단위 최대 4개 병렬이다.
- 자동 시험의 agent-knowledge 는 가짜 CLI(`src/test/agentKnowledgeFixture.ts`)다. 실제 CLI 대조는 agent-knowledge 커밋 `695de23`을 저장소 밖 임시 폴더로 내보내 빌드한 CLI 와 임시 Git 저장소·임시 색인 DB·임시 `CODE_AGENT_HOME`으로 했다. agent-knowledge 저장소와 사용자 홈의 등록은 바꾸지 않았다. 색인은 사람 단계라 검사 스크립트가 임시 DB 에 직접 돌렸고, 어댑터는 `search`·`get`·`status`만 불렀다(호출 기록으로 확인).
- 실제 CLI 대조와 실제 문서 비교는 같은 빌드 산출물의 사본으로 돌렸다(전체 시험의 `dist` 재생성과 겹치지 않게). 일부는 전체 시험과 같은 PC 에서 동시에 돌았으므로 시간 수치는 참고값이다.
- 검사 스크립트·원시 출력은 저장소에 포함하지 않는다. 아래 실제 CLI·실제 문서 결과는 공개 문서만으로 재현할 수 없다.

## 자동 시험 범위

| 시험 | 확인하는 동작 |
|---|---|
| `agentKnowledgeAdapter` (AK1~AK17) | describe·probe 봉투와 `accepts`, 엄격한 설정 스키마·한도 범위·절대 경로·`--config` → 환경 변수 → 기본 위치, 저장소 대응(실제 경로·대소문자), 질의 묶음·자르기, 작업 파일의 저장소 밖 경로 거르기(`pathsDropped`), 질의당 요청 수(상한의 2배), 순번 역수 합치기·같은 항목 제거, 결과 없음(exit 3)·필수 자료만·모두 탈락의 `fallback`, 실패 분류(미설치·모듈 없음·시간 초과·출력 상한·JSON 아님·형식 버전·구조·색인 없음·대응 없음)와 첫 오류, 전체 마감에서 받은 결과 유지·남은 질의 건너뛰기, probe 마감, 인계 참조 `get` 되찾기·20개 상한·꼴이 틀린 참조, CLI 갈래의 exit 0, 등록의 선택 입력 협의(모르는 토큰 버림), `plugin list` 표시, hook — 작업·세션 안팎에서 모델의 어댑터 직접 실행 거부 |
| `knowledgeRefs` | 참조 꼴 엄격 검사, 상대 경로, exact·moved(제목 줄에서 시작하는 창만)·ambiguous·content-changed, 문서 단위 항목은 exact 만, 문서 밖·`..`, BOM·CRLF, 상태 표시가 확정으로 올리지 않음, 기준 커밋 메모 |
| `knowledgeContext` | off — 등록이 있어도 context 출력·어댑터 요청이 같고 호출 0, 인계만 있으면 재확인 블록만 더함. enabled — 항목·절 대응, 긴 절 안의 부분 범위, 같은 제목 절, 미커밋 변경 거부, 지운 문서·문서 밖 경로, CRLF·BOM, 상태 표시, `fallback` 알림, 참조를 쓰지 않는 어댑터·빈 `sections`, 인계·재확인 블록, 꼴이 깨진 인계 참조, 색인 항목 줄의 주의 표시, 기본 검색이 고른 필수 업무 정책 유지, `refs` 협의 없음. shadow — 화면이 off 와 바이트까지 같고 동의 스냅샷·Git 상태 불변, 어댑터 실패, 등록 없음, 같은 입력 재호출 억제·실패 10분 뒤 재호출·등록이 바뀌면 재호출. 선택 입력의 작업 파일 거르기 |
| `masterKnowledge` | hello `knowledge` 협의(off·shadow·enabled·매니페스트 읽기 실패), `knowledgeHandoffOf` 엄격 검사, submit 수락 조건·저장·같은 명령 재전송·꼴 검사 우선, `knowledge` 없는 submit 의 응답·기록, continue·resume 거부, 작업 고정과 다른 참조 충돌, `managedKnowledge` 조회, 사람 응답 뒤 재개 실행의 인계 이어받기 |
| 기존 회귀 | 이 연결은 기존 시험 파일을 고치지 않았다 — 새 시험 4개 파일과 가짜 CLI 만 더했다. 흐름도 동기화·동의·플러그인·master·템플릿 시험이 그대로 통과한다 |

## 결과

| 실제 명령 | 결과 |
|---|---|
| `npm run build` | 통과 |
| `npm test` | 2,028건 중 2,024 통과·실패 0·플랫폼 조건 생략 4. 테스트 러너 557.99초 |
| 변경 전 같은 작업 트리의 `npm test` | 1,965건 중 1,961 통과·실패 0·플랫폼 조건 생략 4. 이 연결의 시험을 더하기 전 기준선이며, 늘어난 63건은 위 새 시험 4개 파일(17·10·20·16건)이다 |
| 문서 시험(검증 기록을 쓴 뒤) — `node --test --test-concurrency=4 dist/test/docSync.test.js dist/test/templateText.test.js dist/test/templateBudget.test.js dist/test/hostText.test.js dist/test/master.test.js` | 50/50 통과. 흐름도 표·호스트 사본·용어 목록·템플릿 예산·master 계약 목록 |
| `node --test --test-name-pattern="R5" dist/test/finalReverify.test.js` | 1/1 통과. 흐름도 줄 인용 |
| 변경 문서의 상대 경로·제목 링크 검사 | 10개 문서의 로컬 링크 236개 유효(코드 표기 안의 정규식 하나는 링크가 아니다). 외부 URL 은 검사 대상에서 제외 |
| `git diff --check` | 통과 |

이 연결은 템플릿(`template/`)을 바꾸지 않았다 — 작업 트리의 `ca-integrate/SKILL.md` 변경은 회차 커밋 합치기의 것이다.

### off 동일성 — 변경 전 빌드와 대조

같은 임시 저장소를 변경 전 빌드와 이 빌드로 각각 analysis·impact·design·plan 까지 진행하며, 단계마다 선언 없음·참조를 쓰지 않는 플러그인·빈 `sections` 플러그인 세 설정으로 `code-agent context`를 찍었다. 출력 12개와 플러그인이 받은 요청 본문 8개가 바이트까지 같았고, 두 빌드 모두 지식 기록을 만들지 않았다.

## 실제 agent-knowledge CLI 대조

임시 저장소 세 개(A·B·C)에 실제 문서를 두고 실제 CLI(`695de23`)로 색인한 임시 DB 를 썼다. 등록은 `plugin add`가 TTY 확인 뒤 부르는 등록 함수를 직접 불러 실제 describe·probe 를 거쳤다(선택 입력 3개 협의, probe `활성 세대 1`). TTY 화면 자체는 시험하지 않았다.

| 시나리오 | 관찰 |
|---|---|
| off(선언 없음, 등록은 있음) | 네 단계 모두 등록이 없는 실행과 출력이 바이트까지 같다. 어댑터 프로세스 0, 지식·플러그인 기록이 늘지 않는다 |
| shadow | 네 단계 모두 off 와 바이트까지 같다. 단계마다 어댑터 1회, 같은 입력으로 다시 찍으면 0회. Git 상태·동의 스냅샷이 호출 전후로 같고 기록에 본문 문구가 없다 |
| enabled | 네 단계 모두 출처가 `플러그인 agent-knowledge`. 렌더된 범위 40개 모두 현재 파일 줄의 SHA-256 이 agent-knowledge `itemSha256`·`get` 의 본문과 같다. 필수 업무 정책은 analysis 에서 `(기본 검색이 고름)` 으로, impact·design·plan 에서 기존 연결 이유로 유지되고 작업 경험 블록은 off 와 같다. 색인 항목 줄은 code-agent 표시만 쓰고 관찰 항목에만 `관찰 — 현재 동작, 정책 아님` 이 붙는다 |
| 연결 해제(선언만 지움) | 네 단계 모두 off 와 바이트까지 같다. 등록·단계는 그대로이고 어댑터 호출 0 |
| 실패 — 미설치(PATH 에 없음·없는 절대 경로·`node <없는 스크립트>`), 시간 초과, 출력 상한 초과, JSON 아님, 형식 버전 2, 옛 응답 구조, DB 없음·빈 DB·색인 안 함, 저장소 대응 없음, 모르는 프로젝트, 설정 없음·JSON 아님 | 각각 `not-installed`·`timeout`·`output-too-large`·`invalid-json`·`unsupported-version`·`invalid-response`·`index-missing`·`project-not-mapped`·`invalid-scope`·`adapter-config-missing`·`adapter-config-invalid` 로 구분돼 알림 한 줄과 함께 기본 검색으로 돈다. 알림 줄을 빼면 off 와 같고 Git 상태·동의 스냅샷이 바뀌지 않는다 |
| 결과 없음(exit 3)·필수 자료만 | 어댑터 `fallback`(`no-results`·`mandatory-only`)으로 기본 검색과 알림 |
| 전체 마감(질의마다 6.5초 지연) | 받은 두 질의 결과로 검증해 싣고 `queriesSkipped: 1`, 15.0초에 끝난다 |
| 색인 뒤 미커밋 수정 | 바뀐 절 하나만 `content-changed` 로 거부하고 `- 검증 제외 1개` 줄, 나머지는 exact |
| 색인 뒤 수정 커밋·줄 밀림·같은 내용 절 | 줄이 밀린 절 3개는 moved 로 새 범위에 실리고, 내용이 같아진 `## 캐시` 하나는 `ambiguous` 로 거부해 `- 검증 제외 1개` 줄이 붙는다. 실린 줄마다 `기준 커밋 <7자> — 현재 파일과 일치 확인` 이 붙는다. 바뀐 절의 `content-changed` 는 미커밋 수정에서 확인했다 |
| 이름 변경·삭제 | 옛 경로 항목은 등록 문서 밖이라 어댑터가 거르고 나머지만 싣는다 |
| 같은 제목 절 둘 | `## 캐시` 두 절을 해시로 각자 범위(L18-19, L20-21)로 확인하고 합치지 않는다. 수정 커밋 뒤에는 `## 저장소` 두 절 중 해시가 맞는 하나만 옮겨 싣는다 |
| 하위 제목을 품은 긴 절 | agent-knowledge 항목 범위(L22-L24)만 `(부분)` 으로 싣고 절 전체(L22-L48)로 넓히지 않는다 |
| master 인계(모사) — 재색인으로 세대 2 | 세대 1 참조는 `generation-expired`, 해시가 틀린 참조는 `hash-mismatch` 로 `## 근거 재확인 필요` 블록에, 맞는 참조는 `## 인계받은 지식 근거` 블록에. 같은 인계를 off·shadow 로 보면 required 참조가 `adapter-unavailable` 이고 두 출력이 같다 |
| shadow 실패·지연 | 설정이 없어 실패해도 화면은 off 와 같고 `shadow-failed` 만 기록되며, 10분 안의 같은 입력은 다시 부르지 않는다. 어댑터가 느리면(마감까지) `context` 가 그만큼 늦어진다 — off 0.19초, shadow 15.4초, 같은 입력 재실행 0.21초 |
| 보충 | 상대 경로 `--config` 거부, 다른 자리 `unsupported-slot`, 인자 초과 `usage`, CRLF 작업 트리의 해시 대조 동일(10개 exact), 인계와 검색 실패가 겹치면 알림과 인계 블록 유지 |

어댑터 프로세스는 모두 사본 빌드의 진입점으로 실행됐다(런타임 추적 기록). impact 단계 한 번의 렌더는 off 약 0.2초, enabled(실제 CLI 질의 3개) 약 1.0초였다.

## 실제 프로젝트 문서 비교 — 임시 정답

code-agent 를 쓰는 실제 저장소 세 개(platform-gateway·authorization-api·users-api)의 사본에서, 승인된 01·02 를 넣고 impact 단계 상한 10개로 같은 요구·문서·예산을 비교했다. 정답은 **사람이 확정하지 않은 임시 정답**이다 — 승인된 02 가 인용한 문서 줄 35개 가운데 본문이 템플릿 자리표시 주석뿐인 6줄을 빼고 29줄(7·18·4)을 썼다. 색인은 실제 CLI 로 만든 임시 DB(세대 1, 문서 27·항목 94, 모두 미확인 상태)다.

| 방법 | platform-gateway | authorization-api | users-api | 합계 |
|---|---|---|---|---|
| 기본 검색 상위 10 | 7/7 | 16/18 | 4/4 | 27/29 |
| agent-knowledge 직접 결과 합집합(어댑터와 같은 요청, 거르기 전) | 7/7 · 26절 | 17/18 · 25절 | 4/4 · 25절 | 28/29 · 76절 |
| 위를 거르지 않고 순번 역수로 합친 상위 10 | 6/7 | 11/18 | 3/4 | 20/29 |
| 실제 `## 참고 문서` 블록 — off | 7/7 · 987자 | 16/18 · 1,046자 | 4/4 · 1,069자 | 27/29 · 3,102자 |
| 실제 `## 참고 문서` 블록 — enabled | 6/7 · 976자 | 16/18 · 977자 | 4/4 · 959자 | 26/29 · 2,912자 |

- **이 표본에서 enabled 가 off 보다 낫다고 말할 수 없다.** enabled 는 off 가 놓친 `architecture.md` 머리 인용 줄을 `# 아키텍처 L1-L4 (부분)` 으로 잡았지만 off 가 잡은 두 줄(platform-gateway `conventions.md:50`, authorization-api `conventions.md:56`)을 놓쳤다. 본문이 자리표시 주석뿐인 `## 업무 규칙` 절의 줄은 어느 방법도 내지 않았다.
- **어댑터 거르기는 순위에 도움이 된다.** 원 결과에는 code-agent 가 보내지 않은 문서(test-strategy·quality) 항목이 섞이며, 걸러진 수는 저장소별 7·10·8개였다. 거른 뒤 합친 상위 10 이 거르지 않고 합친 상위 10 보다 높다(26 대 20).
- **질의당 요청 수(상한의 2배)** — 같은 사본에서 어댑터만 바꿔 쟀다. 요구 하나(질의 1개)로 부르면 1배는 38번 중 1번만 10개를 채우고 나머지는 1~9개였고, 2배는 30번을 채웠다. 전체 요구(질의 3~4개)의 임시 정답 재현율은 1배 27/29, 2배 26/29 다(authorization-api `conventions.md:56` 하나). 거른 뒤 목록이 비는 것을 막는 쪽을 택했다.
- **정합성** — off 블록 목록이 세 저장소 모두 기본 검색 상위 10 과 같았고 off 에서 플러그인 호출은 0이다. enabled 블록 목록은 어댑터 출력을 호스트가 대조한 결과와 같았고(모두 exact, 거부 0) 반드시 적용하는 업무 정책은 세 저장소 모두 없었다. 중계 스크립트로 확인한 어댑터의 실제 요청 본문·받은 항목 ID 가 직접 호출과 같았다. 실제 impact 경로(후보 파일을 더하는 경로)의 블록도 같은 입력의 블록과 바이트까지 같았다. 렌더는 평가용 복제의 사본에서 돌렸고 복제 세 개의 Git 상태·HEAD 는 바뀌지 않았다.
- **크기와 시간** — agent-knowledge 원 응답은 저장소당 135~195KB(발췌 2.8만~4.3만 자)이고 어댑터 출력은 약 7.5KB, 렌더 블록은 약 1천 자다. 렌더 한 번이 off 6~11ms, enabled 0.7~1.5초이며 대부분 agent-knowledge 프로세스 기동이다.

## 생략·한계

- **실제 Claude·Codex 호스트 세션에서는 확인하지 않았다.** 모델이 참고 문서 블록을 어떻게 쓰는지, 작업 품질이 나아지는지는 재지 않았고 주장하지 않는다. 자동 시험은 가짜 CLI 로 돌며 실제 CLI 와는 위 대조로만 맞췄다.
- **master 는 모사다.** hello·submit 협의와 저장은 시험이 제어 진입점(`master/control.ts` `call`)을 직접 불러 확인했고 감독 프로세스는 띄우지 않았다. 실제 master·대시보드와 함께 돌리지 않았고, 실제 CLI 대조의 세대 만료 시나리오는 작업 연결 기록에 인계를 직접 써서 흉내 냈다. master 인계 참조는 제안 단계 계약이다.
- **Codex 샌드박스 안에서 agent-knowledge 가 색인 DB 를 읽을 수 있는지는 확인하지 않았다.** 어댑터는 `code-agent context`의 자식 프로세스로 돌므로 호스트의 셸 권한을 따른다.
- macOS·Linux 는 확인하지 않았다. 실제 CLI 대조는 agent-knowledge `695de23` 한 버전이다.
- 실제 프로젝트 비교의 정답은 사람이 확정한 것이 아니라 승인된 02 가 인용한 문서 줄이다. 그 02 를 쓴 모델이 기본 검색 결과를 보고 인용했을 수 있어 기본 검색 쪽으로 기운다. 저장소 세 개·impact 단계 하나·재현율만 쟀고 순위·정밀도는 재지 않았다.
