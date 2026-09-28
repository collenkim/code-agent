---
name: ca-status
description: code-agent 작업의 현재 위치(문서·스테이지·질문·승인)와 다음 할 일을 보여 준다.
---

1. Bash 로 `code-agent status` 를 실행한다.
2. 결과를 그대로 보여 주고, 마지막 "다음:" 줄을 사용자가 할 일로 한 문장 풀어 준다.
   - 프로젝트 문서가 ✗ 면 `/ca-docs` (P2 전에는 문서를 직접 쓰고 `code-agent.json` 에 등록)
   - 질문이 남았으면 `/ca-answer`
   - 승인 대기면 "별도 터미널에서 `code-agent approve`"
