import { z } from "zod";

/**
 * 수동 모드에서 프롬프트 끝에 붙이는 출력 형식 지시.
 *
 * API 경로는 `output_config`로 스키마를 강제하지만, 채팅창에는 그런 필드가 없다.
 * 그래서 같은 형식을 본문으로 적어 준다 — 이게 없으면 모델이 산문으로 답해 --ingest가 실패한다.
 */
export function withOutputFormat(userPrompt: string, shape: string): string {
  return (
    `${userPrompt}\n\n` +
    "# 출력 형식 — 반드시 지킬 것\n" +
    "설명·인사말 없이 **아래 형태의 JSON 하나만** 출력한다. 코드블록으로 감싸도 된다.\n\n" +
    "```json\n" +
    `${shape}\n` +
    "```\n\n" +
    "- 문자열 안의 줄바꿈은 `\\n`으로, 따옴표는 `\\\"`로 이스케이프한다.\n" +
    "- 파일 내용은 잘라내지 말고 전부 넣는다. `...` 같은 생략 표시를 쓰지 않는다."
  );
}

/** 생성 단계가 돌려줘야 하는 형태 */
export const FILES_SHAPE = `{
  "files": [
    {
      "path": "저장소 루트 기준 상대경로",
      "content": "파일 전체 내용",
      "note": "판단이 필요했던 지점 (없으면 이 키를 빼도 된다)"
    }
  ]
}`;

/** 계획 단계가 돌려줘야 하는 형태 */
export const PLAN_SHAPE = `{
  "domainName": "도메인 이름",
  "domainLabel": "사람이 읽는 이름",
  "domainRoot": "도메인 분류 (없으면 \\"\\")",
  "domainDirName": "실제 디렉토리 이름",
  "files": [{ "stage": "단계 키", "path": "상대경로", "purpose": "한 줄 설명" }],
  "conventions": [{ "rule": "적용할 규칙", "source": "근거 위치" }],
  "conflicts": [{ "topic": "", "docSays": "", "codeSays": "", "decision": "" }],
  "openQuestions": ["사람이 답해야 하는 것"],
  "reasoning": "판단 근거"
}`;

/** 검수 단계가 돌려줘야 하는 형태 */
export const GATE_SHAPE = `{
  "violations": [
    { "item": "위반한 체크리스트 항목", "file": "파일 경로", "detail": "무엇이 어떻게 어긋났는지" }
  ]
}`;

/**
 * 채팅 응답에서 JSON을 꺼낸다.
 *
 * 모델이 코드블록으로 감싸거나 앞뒤에 설명을 붙이는 경우가 흔해, 순서대로 세 가지를 시도한다.
 * 파싱에 성공해도 스키마 검증을 통과해야 받아들인다 — 형태가 어긋난 걸 그대로 파일로 만들면
 * 다음 단계까지 오염되기 때문이다.
 */
export function parseResponse<T>(text: string, schema: z.ZodType<T>): T {
  const candidates: string[] = [];

  const trimmed = text.trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    candidates.push(fenced[1]);
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    candidates.push(trimmed.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    // JSON은 맞는데 형태가 다르면, 그 이유를 알려 주는 편이 다시 시도하기 쉽다.
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`응답 JSON의 형태가 예상과 다릅니다:\n${issues}`);
  }

  throw new Error(
    "응답에서 JSON을 찾지 못했습니다. 모델이 산문으로 답했을 수 있습니다 — " +
      "프롬프트 끝의 '출력 형식' 지시를 함께 붙여넣었는지 확인하세요.",
  );
}
