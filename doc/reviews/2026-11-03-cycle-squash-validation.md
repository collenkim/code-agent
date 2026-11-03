# 회차 커밋 합치기 검증

현재 동작은 [흐름도 §3.2·§3.3](../process-flow.md)와 [사용 가이드](../usage.md)를 따른다. 검증 대상의 상태 형식 세대는 24다.

## 검사 조건

- Windows, Node v24.19.0, Git 2.55.0.windows.5. 기준 커밋 `9c50f467c6dffe8c93aa436a757f2ca5e1b5037b`에 회차 커밋 합치기·병합 판정 변경을 적용한 작업 트리에서 검사했다.
- Git 변경·서명 키·bare 원격은 시험이 만든 임시 저장소 안에서 검증한다.
- 설치된 의존성을 사용했으며 `package.json`·`package-lock.json` 변경이 없어 `npm ci`는 생략했다. build와 test는 순차 실행했고 전체 시험은 파일 단위 최대 4개 병렬 설정을 사용했다.
- 전체 검사는 `hostBaseEnv(process.env)`로 실행 호스트 표지만 제거한 자식에서 `npm.cmd test`를 실행한다. 테스트의 자체 호스트 관찰 fixture는 유지한다. Windows 프로세스 조회·종료 권한이 필요한 검사 때문에 승인된 샌드박스 밖 실행을 사용했다. 재생성 가능한 로그는 Git 무시 경로 `dist/request1-test-all.log`에 둔다.

## 검증 범위

| 시험 | 확인하는 동작 |
|---|---|
| `cycleSquash` | 첫 회차 생략, 2·3회차 연속 합치기, 동일 트리·부모·메시지, 공동 작성자 보존, 이전 반영 찾기, 다른 브랜치·태그·원격 추적 ref 제외, upstream 누락, 사람·merge 커밋 제외, 보관 충돌·정리. 보관이 없으면 회차는 남기고 SHA는 `커밋 미확인`으로 표시 |
| `cycleSquashRace` | 조회 실패, 확인 뒤 참조 변경, 새 커밋 생성 뒤 참조 변경, 비교 갱신 경합, 서명 실패, 트리 검증 실패, 보관 이름 경합. 성공한 반영·다른 프로세스의 끝·index 바이트·작업 파일 보존 |
| `cycleSigning` | 임시 SSH 키로 실제 서명한 합치기 커밋을 `git verify-commit`으로 검증. 로컬 bare 원격 push 뒤 원격 추적 ref로 합치기 제외 |
| `deliverSquash` | 실제 검증·deliver 경로의 문서/커밋 메시지 일치와 현재 회차 `이번 반영`, 합친 뒤 같은 요구 거부·3회차 시작·답 이어받기·예산 구간, master 제외, 확인 도중 참조 변화, consent 준비/응답/적용 사이 ref 변경 시 합치기만 생략, 새 절 없는 코드 구역 호환 |
| `cycleBranch`·`cycleStart`·`cycleConsentStart` | 일반 merge·fast-forward·squash·원격 기준 병합 판정, SHA 기준 제외·upstream 누락 안내, 실제 start 거부·브랜치 유지, 접수·확정 안내와 finish의 startBlocked, 사람이 브랜치를 삭제한 뒤 기준에서 새 회차·보관 정리 |
| 기존 회귀 | 동의 스냅샷·화면 결속, 반영 경로 제한·검증·교차 리뷰, 흐름도 동기화, 두 호스트 사본 치환·템플릿 예산 |

Git의 `--exclude`는 바로 뒤 참조 목록 옵션에 적용하며 브랜치 패턴에는 `refs/heads/`를 붙이지 않는다. 합치기는 `commit-tree -S`로 서명을 명시하고 `update-ref`의 기존 OID 조건을 사용한다. [rev-list 계약](https://git-scm.com/docs/git-rev-list), [commit-tree 서명](https://git-scm.com/docs/git-commit-tree), [update-ref 비교 갱신](https://git-scm.com/docs/git-update-ref).

## 결과

| 실제 명령 | 결과 |
|---|---|
| `npm.cmd run build` | 통과 |
| `node dist/request1-test-all.cjs` → `npm.cmd test` | 1,965건 중 1,961 통과·실패 0·플랫폼 조건 생략 4. 테스트 러너 955.85초, 컴파일 등을 포함한 전체 956.97초 |
| `node dist/request1-cli-smoke.cjs` | 빌드된 CLI를 임시 저장소에서 실행. 병합된 브랜치의 `start`가 exit 1로 거부되고 브랜치·HEAD·index 보존 |
| `node scripts/template-sizes.cjs` | ca-integrate 3,202/3,300자, Claude 흐름 48,838/49,200자, Codex 흐름 45,318/45,900자 |
| `git diff --check` | 통과 |

회차 관련 시험 7개 파일의 27건은 전체 실행에 포함된다. `deliverSquash` 네 사례는 합계 48.62초였고 실제 SSH 서명 검사도 생략 없이 통과했다.

### 문서 정합성

2026-11-03 문서 정리는 제품 코드·템플릿 변경 없이 `npm.cmd run build`를 통과했다. 전체 시험을 다시 실행하지 않고 다음 범위를 검사했다. 위 전체 시험 집계와 합산하지 않는다.

| 검사 | 결과 |
|---|---|
| `node --test --test-concurrency=4 dist/test/docSync.test.js dist/test/templateText.test.js dist/test/templateBudget.test.js dist/test/hostText.test.js` | 25/25 통과. 흐름도 표·호스트 사본·용어 목록·템플릿 예산 |
| `node --test --test-concurrency=2 --test-name-pattern="R5\|동의 동작은 빠짐없이" dist/test/finalReverify.test.js dist/test/master.test.js` | 선택한 2/2 통과. 흐름도 인용·master 계약 목록 |
| 변경 문서의 상대 경로·제목 링크 검사 | 11개 문서의 로컬 링크 205개 유효. 외부 URL은 검사 대상에서 제외 |
| `git diff --check` | 통과 |

## 생략·한계

- 실제 Claude·Codex 모델과 UI, 유료 호스트, 실제 Git 호스트 PR·병합·push는 실행하지 않았다. 동의 응답은 자동 시험 fixture이며 사람 승인이 아니다. 코드 시험으로 모델 지침 준수·UI 표시·사용자 열람을 입증하지 않는다.
- macOS·Linux, GPG·하드웨어 키 서명은 확인하지 않았다. SSH 서명은 실제 Git 검증 결과로 확인한다.
- 공개 여부 판정은 로컬 브랜치·원격 추적 ref·태그에 한정된다. 추적 정보 없는 직접 push와 조회 이후 새로 생기는 원격 상태는 보장하지 않는다. 로컬 ref는 적용 직전 재조회하고 기존 ref·브랜치 끝을 비교 갱신한다. 자동 fetch·강제 push는 하지 않는다.
- 템플릿 크기는 위 결과의 상한 안이며 예산의 정본은 `src/test/templateBudget.test.ts`다. Claude 원문과 Codex 변환 사본을 함께 검사했다.
