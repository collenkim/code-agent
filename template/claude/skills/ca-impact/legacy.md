# 이전 버전 작업의 영향도 절차

`code-agent status`에 관찰 흐름이 표시되지 않는, 이전 버전에서 시작한 작업에만 쓴다. 자리 확인과 끝은 SKILL.md를 따른다. 문서 기준은 `.claude/skills/ca-impact/criteria.md`다.

1. Bash: `code-agent context` — 요구 항목 · **참조 도메인의 단계별 표준 파일** · **관련 후보 파일 순위** · **참고 문서 섹션**이 나온다.
   후보 파일과 문서 섹션은 **먼저 보라는 목록**이다 — 저장소를 다시 훑지 말고 그대로 explorer 에게 넘긴다.
   출처 줄이 `기본 구현` 인지 `플러그인 <이름>` 인지 함께 찍힌다. **순위는 단서일 뿐 근거가 아니다** — 근거는 explorer 가 읽은 `path:line` 이다.
2. 요구 항목을 **닿는 영역**(이번 도메인 · 공통 모듈 · 다른 도메인과의 연결)으로 묶어 영역마다 `ca-explorer` 하나를 **한 메시지에서 병렬로** 부른다 —
   요구 항목마다 하나씩 부르지 않는다 (같은 도메인만 닿는 작업이면 explorer 하나). 영역의 항목들 + context 출력 + 관련 문서 경로 + criteria.md 경로를 넘긴다.
3. Bash: `code-agent docs skeleton 02-analysis` — 뼈대 + explorer 결과 + 답한 질문을 `ca-writer` 에게 넘겨 `02-analysis.md` 에 쓰게 한다. 기준은 criteria.md다.
4. 모호한 점과 writer 가 돌려준 `확인 필요` 를 나눈다 — 업무 규칙·범위는 `questions.md`에 기록하고 공통 선택 절차로 답을 받는다(필수 답이 없으면 멈춘다),
   기본값을 댈 수 있는 기술 세부는 `01-requirements.md` 의 `## 가정` 에 근거와 함께 더한다.
