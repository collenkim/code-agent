# agent-knowledge 선택 연결 검증

현재 동작은 [플러그인 §10](../plugins.md#10-agent-knowledge-연결)(진행 게이트 §10.9), [흐름도 §1.1·§3.2·§5.3·§5.4·§8](../process-flow.md), [master 연동 §3·§4·§11](../master-control.md)을 따른다. 검증 대상의 상태 형식 세대는 26이다. 최신 전체 자동 시험의 결과·실행 조건도 이 기록에 있다.

## 검사 조건

- Windows 11, Node v24.19.0, Git 2.55.0.windows.5. 이 기록을 담은 커밋의 트리와 같은 작업 트리에서 검사했다.
- `package.json`·`package-lock.json` 변경이 없어 `npm ci`는 생략했다. `npm run build` 뒤 `npm test`를 실행했고 전체 시험은 파일 단위 최대 4개 병렬이다. 같은 PC 에서 다른 저장소의 시험이 함께 돌았으므로 시간 수치는 참고값이다.
- 자동 시험의 agent-knowledge 는 두 가지다. 가짜 CLI(`src/test/agentKnowledgeFixture.ts` — 형식 1·2, `capabilities`·`status --response-version 2`·`get` 의 `expect`·오류 봉투)와, 이 PC 의 agent-knowledge 체크아웃에 빌드된 실제 CLI(커밋 `71cd1c7` — 그 저장소의 미커밋 변경은 문서·시험·계약 사례뿐이고 `src`는 커밋과 같다. 빌드 산출물 `dist`는 그 체크아웃에 있던 것을 그대로 썼다)다. 실제 CLI 시험은 임시 Git 저장소·임시 원본 설정·임시 색인 DB·임시 어댑터 설정·임시 `CODE_AGENT_HOME`으로 돈다. agent-knowledge·master-agent 저장소와 사용자 홈의 등록은 바꾸지 않았다(읽기만).
- 인계 수신 계약은 agent-knowledge 체크아웃의 `docs/contract/handoff-cases.json`(수신 사례 30개·hello 송신 결정 10개 — 그 저장소에서 미커밋 상태)을 읽어 돌렸다. 사례 파일이 바뀌면 결과가 달라질 수 있다.
- 실제 AI 호스트(Claude·Codex 모델 세션)는 부르지 않았다. master 는 제어 진입점(`master/control.ts` `call`)을 시험이 직접 부르는 모사이고 감독 프로세스·실제 master-agent 는 띄우지 않았다.

## 자동 시험 범위

| 시험 | 확인하는 동작 |
|---|---|
| `knowledgeGate` (KG1~KG11) | required 참조가 `hash-mismatch` 면 context 가 재확인 블록을 띄우고 `next` 를 거부하며 재개 판정은 `knowledge-blocked`·`knowledge-replan`(사람). context 를 부르지 않아도(검증 전 → `unverified`·재검증, 생산자 호출 0), 진단 로그를 지우고 새 프로세스로 `next`·`status --json`을 불러도 같은 판정. 검증 기록이 원천(지우면 다시 막고 같은 참조의 `knowledge verify`로 풀림). 24시간 만료, 검증 뒤 문서 범위 변경·삭제(`source-changed`·`source-deleted`). off(`adapter-off`, 생산자 호출 0)·미등록(`adapter-unregistered`)·`refs` 미협의(`adapter-unsupported`). 선택 참조 실패는 막지 않음. 인계 없는 작업·다른 작업의 인계 실패는 영향 없음. implement 에서 만료되면 hook 의 코드 쓰기·선언된 명령·`next`·검증 실행 거부, 작업 문서 쓰기는 허용, 재검증으로 회복 |
| `knowledgeGateRealCli` (RG1~RG3) | 실제 CLI 로 작업 저장소의 등록 문서를 색인하고 생산자 형식 2 검색이 낸 ItemRef 를 그대로 형식 2 인계로 고정 → `code-agent knowledge verify`(내장 어댑터 → 생산자 `get` 형식 2 → 현재 파일 대조 → 검증 기록)로 `verified`·`next` 통과·context 인계 블록. 변조한 `itemSha256`·다른 `indexId`·없는 세대는 생산자가 거부해 `hash-mismatch`·`index-mismatch`·`generation-expired`(원인 `hash-mismatch`·`identity-mismatch`·`expired`, 회복 재계획)로 `next` 거부. 선택 참조 변조는 막지 않음 |
| `knowledgeHandoffContract` (HC1~HC4) | 공통 계약 사례 전부를 실제 수신 파서(`knowledgeHandoffOf`·`requireHandoffVersion`)와 정본 해시(`knowledgeDigest`)로 — 받음·거절 코드와 `detail.reason`·정규화한 참조·해시가 사례와 같고, 참조 순서와 무관한 해시, 사례의 대조 원인 갈래가 게이트 원인과 같고 required 실패만 진행을 막음. 상한 20개·32768 바이트 |
| `masterKnowledge` | hello `knowledge.refs`(`versions` — 색인 협의가 있을 때만 `[1, 2]`, `supportedVersions`·`maxBytes`·`requiredGate`·`requiredDefault`·`scope`)와 `gate`, 형식 2 엄격 검사·분할·64자리 커밋·상한, 색인 미협의 등록의 형식 2 `knowledge-version` 거부, 접수 영수증(`receipt: stored`·`verification`)·같은 명령 재전송·다른 인계 `conflict`, 수신 범위(`not-in-docs`, 대응 프로젝트·원본 밖 `out-of-scope`), `knowledge` 없는 submit 의 응답·기록, continue·resume 거부, `knowledge-blocked` 의 submit 거부, master `knowledge verify`(기록·이벤트)·`replace`(사유 필수·범위 검사·같은 해시 유지·이력·기록 삭제·`null` 로 떼기), 사람 응답 뒤 재개 실행의 보류·같은 판정 재기록 없음·교체 뒤 작업 연결의 인계로 재개 |
| `agentKnowledgeV2` (AV1~AV18) | 협의(`capabilities` 없음·형식 2 미지원·스키마 2 이전 DB 는 형식 1, `responseVersion` 1·2), 형식 2 를 모른다는 답에서만 형식 1 로 다시 묻고 해시·DB 식별·세대·커밋·범위 오류는 덮지 않음, 질의 묶음 한 번(요구 키·`filters.documents`·`include.mandatory=false`·`budget`·`version.exact`), 생산자 상한·알린 기능만 싣기, `direct` 묶음만 섹션, 참조 일관성, 분할, 대체 사유(`no-results`·`supplementary-only`·`budget-truncated`·`no-usable-items`·`no-query`), 정확 조회(`expect`·커밋 고정)와 오류 사유, 형식 1 생산자에서 색인 식별 참조는 `identity-unverifiable`, 자식 환경의 `AGENT_KNOWLEDGE_*` 제거, 한 마감 공유, describe `accepts`·설정 키 |
| `agentKnowledgeRealCli` (AR1~AR4) | 실제 CLI 와 형식 2 협의·섹션 참조의 호스트 검증(CRLF·맨 CR 문서 포함), 실제 검색 참조로 만든 인계의 `get` 형식 2 확인과 변조 거부, `bm25`·분할 점수 요청과 분할 범위 검증, `responseVersion: 1` |
| `knowledgeContext` | off(등록이 있어도 context 출력·어댑터 요청이 바이트까지 같고 호출 0)·enabled(항목·절 대응, 부분 범위, 인계·재확인 블록, 기본 검색이 고른 필수 업무 정책 유지)·shadow(화면·동의 스냅샷·Git 상태가 off 와 같음). 인계만 있을 때 off 는 `adapter-off`·미협의 등록은 `adapter-unsupported`. shadow 갱신: 어댑터 설정 내용·원본 설정 내용·DB 교체·WAL·생산자 파일이 바뀌면 새 비교(서로 다른 `inputHash` 6개), 성공 비교는 59분 재사용·61분 재비교, `CODE_AGENT_SHADOW_REFRESH=1` 강제, 실패는 10분 억제하되 설정을 고치면 바로 재비교, 다른 저장소는 다른 지문 |
| `agentKnowledgeAdapter`·`knowledgeRefs` | 형식 1 경로(describe·probe·설정·질의·검색·인계 `get`·실패 분류·마감), 참조 대조(exact·moved·ambiguous·content-changed, BOM·CRLF·맨 CR 줄 끝) |
| Codex 모의 시험 격리 | `codexProbeFixture.ts` `isolateSandboxMarkers`·`masterCodexFixture.ts`·`codexReadiness.test.ts` 가 부모 셸에서 상속된 `CODEX_SANDBOX`·`CODEX_SANDBOX_NETWORK_DISABLED`를 대역을 끼운 동안만 지우고 되돌린다. 제품의 샌드박스 판정(`crossEnv.ts`)은 그대로 쓴다 — 표지를 켜는 시험은 스스로 켠다 |

## 결과

| 실제 명령 | 결과 |
|---|---|
| `npm run build` | 통과 |
| `npm test` | 2,080건 중 2,076 통과·실패 0·플랫폼 조건 생략 4(실제 CLI·계약 시험은 생략되지 않았다). 테스트 러너 1,310.7초(다른 저장소 시험과 동시) |
| `CODEX_SANDBOX_NETWORK_DISABLED=1 node --test --test-concurrency=4 dist/test/codex.test.js dist/test/codexReadiness.test.js dist/test/masterCodex.test.js dist/test/codexPermissions.test.js dist/test/coexistence.test.js` | 58/58 통과 — 부모 셸에서 상속된 표지가 있어도 모의 Codex 시험이 `codex-sandboxed` 로 막히지 않는다. 이 PC 의 셸에는 표지가 없어 위 전체 시험은 표지 없이 돌았다 |
| 문서 시험 — `docSync`·`templateText`·`templateBudget`·`hostText`·`hostNotation`·`master`·`finalReverify`·`stateView`·`consentOutput`·`consentJudgment`·`retryPolicy`·`modelPolicy`·`planningChain`·`hookLoad`·`hookInstallation`·`planningRetry` | 244/244 통과 |
| `git diff --check` | 통과 |
| 변경 문서의 상대 경로·제목 링크 검사 | 9개 문서의 로컬 링크 151개 유효. 외부 URL 은 제외 |

템플릿 예산 — `ca-next/SKILL.md`는 '멈춘 자리별 재개' 표의 `knowledge-blocked` 행을 포함해 예산 7,200 안이다(`templateBudget.test.ts`).

### 보존 — off·미설치·인계 없는 작업

- off 기본·선언 없음·등록 없음은 context 출력·플러그인 요청이 바이트까지 같고 호출 0이다(`knowledgeContext`). 인계 없는 작업은 게이트 판정이 `none` 이라 `next`·검증·hook·재개 판정에 영향이 없다(KG10). 다른 작업의 인계 실패는 이 작업을 막지 않는다.
- 선택 검색 실패·선택 참조(`required: false`) 실패는 기본 검색 대체·진단으로만 남는다(KG9·RG3).
- shadow 는 화면·동의 스냅샷·Git 상태가 off 와 같고, 갱신 판정은 파일 지문만 읽는다 — 생산자 호출은 비교 한 번뿐이다.

## 생략·한계

- **실제 Claude·Codex 호스트 세션에서는 확인하지 않았다.** 모델이 `knowledge-blocked`·`다음:` 안내를 따라 `knowledge verify`를 부르거나 멈추는지, 참고 문서 블록으로 작업 품질이 나아지는지는 재지 않았고 주장하지 않는다.
- **master 는 모사다.** hello·submit·`knowledge` 명령·사람 응답 뒤 재개는 시험이 제어 진입점을 직접 불러 확인했고 감독 프로세스·대시보드·실제 master-agent 와 함께 돌리지 않았다. master-agent 가 형식 2 를 보내는 쪽(`evidence.mjs`·`control-host.mjs`)은 읽기만 했고 통합하지 않았다.
- **공통 계약과의 차이 하나** — 공통 계약은 고정된 인계를 바꾸지 않고 새 작업으로 재계획하는 것을 기본으로 둔다. 이 빌드는 그와 함께 master 의 명시적 `knowledge replace`(사유·이력·검증 기록 삭제·승인 무효)를 연다. 다른 인계의 submit 은 계약대로 `conflict` 다.
- **생산자 `verify` 명령은 쓰지 않는다** — 재검증은 참조마다 `get` 형식 2(`expect`·`version.exact`, 20개까지)로 한다. 공통 계약은 둘 다 허용한다.
- 검증 기록 유효 시간(24시간)·shadow 성공 재사용(60분)·실패 억제(10분)는 고정값이다. 지문은 파일 크기·수정 시각을 보므로 같은 크기·같은 시각으로 바꿔 쓴 DB 는 60분 주기에만 반영된다.
- **Codex 샌드박스 안에서 agent-knowledge 가 색인 DB 를 읽을 수 있는지는 확인하지 않았다.** 어댑터는 `code-agent context`·`knowledge verify`의 자식 프로세스로 돌므로 호스트의 셸 권한을 따른다.
- macOS·Linux 는 확인하지 않았다. 실제 CLI 대조는 agent-knowledge `71cd1c7` 한 버전이고, 생산자 빌드·계약 사례가 없는 PC 에서는 그 시험 묶음이 생략된다.
- **검색 품질은 재지 않았다.** 실제 프로젝트 문서에서 enabled 가 기본 검색보다 근거를 더 잘 고르는지(재현율·순위·정밀도), 형식 2 의 `bm25`·분할 점수가 나은지는 측정 근거가 없고 주장하지 않는다.
