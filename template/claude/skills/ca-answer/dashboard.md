# 영속 질문과 대시보드 응답

설정·문서·접수·계획·개발·검증·리뷰·반영·복구·운영에서 사람이 결정해야 할 질문은 같은 경로로 발행한다. `code-agent interaction list`로 기존 요청과 답부터 확인한다. 대시보드를 사용하는 세션이나 비대화형 실행에서는 아래 경로를 우선한다. 기존 채널에만 열린 창을 새 요청으로 추측해 복원하지 않는다.

1. 허용된 문서 경로에 질문 JSON을 작성하고 메인 세션에서 `code-agent interaction publish <파일>`을 단독 호출한다. hook이 실제 세션·작업·브랜치를 결속한다. 세션 ID·실행 명령·프로젝트 경로를 입력으로 만들지 않는다. 기본 꼴은 아래와 같다.
2. `pending`·`deferred`이면 사람 답을 기다리며 턴을 끝낸다. 같은 질문을 다시 발행하거나 기본값으로 진행하지 않는다. 비대화형 실행은 `human-input`으로 보고한다. 살아 있는 대화는 사용자의 응답 알림 뒤 같은 세션에서 `code-agent interaction consume <requestId>`를 실행한다.
3. 받은 선택 ID·직접 입력을 원래 단계에 반영한다. `source: questions`는 작업 `questions.md`의 실제 미응답 Q번호에 연결하며 CLI가 답과 `dashboard-human` 출처를 쓴다. 이 출처를 대화·호스트 관찰로 바꾸지 않는다. 그 밖의 질문은 소비자가 처리 후 `{"summary":"실제로 처리한 결과"}` 파일을 만들어 `code-agent interaction complete <requestId> <파일>`로 결과를 남긴다. 응답 수신과 처리 완료를 구분한다.
4. 답은 승인·재시도 허용이 아니다. 원래 검사·한도·재계획·재승인을 거친다. 복구 질문은 `kind: recovery-decision`, `stage: recovery`로 발행하고 관련 근거를 넣는다. 운영 질문도 기존 운영 명령으로 처리하며 새 개발 작업을 접수하지 않는다.
5. 동의는 기존 `consent prepare`가 전문과 변경 후보를 자동 발행한다. 대시보드 사용 시 별도 승인 질문을 만들거나 호스트 confirm을 동시에 열지 않는다. `interaction list`·`consume`으로 적용 결과를 확인한다. 대시보드 연결을 하지 않은 세션은 기존 호스트 확인 절차를 따른다.

```json
{
  "key": "document-method", "stage": "document", "title": "문서 준비 방식",
  "questions": [{
    "questionId": "method", "title": "문서를 어떻게 준비할까요?", "mode": "single",
    "minSelections": 1, "maxSelections": 1,
    "options": [
      {"optionId":"source","label":"소스 기준 작성","description":"조사한 코드로 초안을 만듭니다","consequence":"작성 후 문서 확정 동의를 받습니다"},
      {"optionId":"link","label":"기존 문서 연결","description":"문서 경로를 입력합니다","consequence":"해당 문서의 필수 항목을 검사합니다","input":{"required":true,"minLength":1,"maxLength":500,"description":"문서 경로"}}
    ],
    "recommendedOptionIds": ["source"], "recommendationReason": "조사한 소스에 현재 구성이 있습니다",
    "evidence": [{"path":"package.json","summary":"확인한 프로젝트 구성"}]
  }]
}
```

예제 추천·근거를 복사해 사실처럼 쓰지 않는다. 현재 자료를 조사해 후보별 결과·추천 이유·근거 경로를 채운다. 충분한 기존 문서는 연결을 추천하고 빈 저장소에는 소스 작성을 추천하지 않는다. 입력 방식·경로를 이미 지정했으면 재질문하지 않는다. 후속 질문은 앞선 실제 답을 받은 뒤 만든다. 근거가 없으면 `recommendedOptionIds: []`와 이유를 쓴다. 다중 선택은 `mode: multiple`·최소/최대 개수·`defaultOptionIds`를 명시한다. 자유 입력은 `mode: text`와 `input` 조건을 쓴다. 기본 선택·추천·시간 경과는 답이 아니다.

Codex `ask`에는 같은 JSON을 `interaction` 필드로 전달할 수도 있다(기존 `questions` 필드는 호환용으로 필요). 이 경우 폼 대기 대신 저장한 요청 ID를 돌려준다. 구조화된 다중 선택·추천·직접 입력은 이 경로나 `interaction publish`를 사용한다. 구형 단일 선택 창에서 추천을 추측하지 않는다. 키·토큰·비밀값은 질문·근거·답에 넣지 않는다.
