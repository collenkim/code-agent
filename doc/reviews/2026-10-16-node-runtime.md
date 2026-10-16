# Node 실행·빌드 버전 통일

사용자는 LangGraph 전체 전환에 앞서 code-agent 의 Node 버전을 master-agent 와 같게 맞추도록 요청했다. master-agent 의 `package.json` 기준은 `>=24.19.0 <25`이고 작업 PC 는 Node v24.19.0 이다.

- code-agent 의 package.json·lockfile에 같은 범위를 선언하고 Node 타입을 24 계열로 맞춘다.
- doctor 는 npm 실행과 SEA 내장 Node 모두 같은 범위를 검사한다. SEA 빌드도 범위를 벗어나면 산출물을 지우기 전에 거부한다.
- 설치·사용·설계 문서, README, 개발 지침과 흐름도를 맞춘다. 대상 프로젝트 추천 스택의 Node 버전은 code-agent 런타임과 별개라 유지한다.
- LangGraph·SQLite 추가, 전역 Node 재설치, 릴리스 배포는 이번 변경에 포함하지 않는다.

검증 환경은 Windows, Node v24.19.0, `@types/node` 24.19.2다.

- `npm run build` 통과. Node 24 타입으로 컴파일한다.
- `npm test` 최종 통과: 1,551개 중 1,547개 통과·실패 0·생략 4, 약 174초.
- 첫 샌드박스 실행은 1,543개 통과·실패 3·생략 5였다. 실패는 프로세스 트리 종료와 master 호스트 생존·강제 종료 시험이다. Windows 프로세스 조회의 접근 거부를 확인했고, 승인된 샌드박스 밖 재실행에서 세 시험과 전체 시험이 통과했다.
- 추가 시험은 Node 22·24.18.9·25·24.19.0 사전 릴리스를 거부하고 24.19.0·24.20.0을 허용하는 doctor 판정과, SEA 빌드가 지원 범위 밖에서는 산출물 정리 전에 멈추는지를 확인한다. 경계 버전은 모의 값이며 다른 Node 바이너리를 설치해 실행한 것은 아니다.
- code-agent·master-agent·lockfile의 Node 지원 범위 일치와 `git diff --check` 통과. SEA 실행 파일의 실제 재생성은 수행하지 않았다.

원자료 요약은 [검증 근거](evidence/2026-10-16-node-runtime.json)에 있다. 커밋 전 작업 트리의 결과다.
