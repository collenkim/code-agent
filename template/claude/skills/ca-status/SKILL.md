---
name: ca-status
description: code-agent 작업의 현재 위치(문서·스테이지·질문·승인)와 다음 할 일을 보여 준다.
---

1. Bash 로 `code-agent status` 를 실행한다.
2. 결과를 그대로 보여 주고, 마지막 "다음:" 줄을 사용자가 할 일로 한 문장 풀어 준다.
   - 공통 POLICY 문서가 ✗ 면 `/ca-docs` (레거시에 처음 들이는 것이면 `/ca-adopt`). 섹션별 상태는 `code-agent docs`
   - 확정만 남았으면 "별도 터미널에서 `code-agent confirm doc <architecture | conventions | test-strategy | quality>`" — 넷 다 확정돼야 작업이 시작된다
   - 질문이 남았으면 `/ca-answer`
   - 승인 대기면 "별도 터미널에서 `code-agent approve`"
   - 승인이 `rejected` 면 `/ca-plan` — 반려 사유를 읽고 문서부터 다시 본다 (같은 계획을 그대로 다시 내지 않는다)
   - 그 밖이면 `다음:` 줄이 가리키는 **단계 명령**(`/ca-analyze` · `/ca-impact` · `/ca-design` · `/ca-plan` · `/ca-implement` · `/ca-check` · `/ca-test` · `/ca-review` · `/ca-integrate`) 하나,
     또는 `/ca-next` 로 그 자리부터 사이클. 이전 스테이지로 돌아가야 하면 `code-agent back <스테이지>` (앞으로는 못 간다)
   - 스테이지가 `deliver` 면 "별도 터미널에서 `code-agent deliver`" — 확인 화면과 로컬 커밋은 사람의 자리다
