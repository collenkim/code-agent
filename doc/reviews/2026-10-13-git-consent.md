# 임시 Git 신뢰 설정과 동의 비교

Windows Codex 셸이 환경변수로 주입한 현재 저장소와 하위 경로의 `safe.directory`가 동의 스냅샷에 포함되어, 해당 환경변수가 없는 응답 훅에서 `Git 설정` 변경으로 거부됐다. 대상 프로젝트의 준비 시점 해시는 기존 설정에 이 두 항목을 더했을 때 일치했다. Git 설정 파일을 변경한 문제가 아니다.

`consent.ts`는 출처가 `command line:`이고 값이 현재 저장소 또는 `<root>/*`인 `safe.directory`만 스냅샷에서 제외한다. Windows 경로의 구분자·대소문자는 정규화한다. Git 호출 환경과 파일은 변경하지 않는다. 설정 파일의 신뢰 경로, 명령 환경의 다른 경로·`*`, 사용자·훅·서명 설정 변경은 계속 동의를 무효화한다.

임시 저장소에서 주입 유무가 준비·응답 사이에 양방향으로 달라져도 문서 확정과 준비 커밋까지 적용되는 것을 확인했다. 실제 설정 변경 거부와 기존 동의·훅·문서 검증을 함께 실행했다.

- `npm.cmd run build`: 통과.
- `node --test dist/test/consentSnapshot.test.js dist/test/consentBinding.test.js dist/test/docSync.test.js dist/test/hookLoad.test.js`: 87개 통과, 실패·생략 0개(76.3초).
- Windows 샌드박스에서 사용자 정보 조회(`uv_os_get_passwd`)가 제한되어 위 최종 검증은 샌드박스 밖에서 실행했다. 전체 테스트는 재실행하지 않았다.
- `git diff --check`: 통과. 결과 원자료 요약은 [검증 기록](evidence/2026-10-13-git-consent.json)에 남긴다.

이미 실패한 동의는 재사용하지 않는다. 수정 빌드 적용 후 동일 세션에서 확인 내용을 새로 준비하고 사용자 응답을 받아 이어간다. 대상 프로젝트의 동의 기록이나 Git 설정은 이 수정 작업에서 변경하지 않았다.
