import { askVia } from "./hostText";

/** 마지막 응답의 명시적인 문구 입력 요구만 검사한다. 질문 의도를 추측하거나 UI 호출을 증명하지 않는다. */
export function questionPresentationProblem(message: string | undefined): string | undefined {
  if (!message) return undefined;
  // 예시 코드·인용 로그는 모델이 사용자에게 하는 요청이 아니다.
  const prose = message.replace(/```[^]*?```/g, "").split(/\r?\n/).filter(line => !/^\s*>/.test(line)).join("\n");
  // 동의 응답은 별도의 확인 코드·관찰 규약을 따른다. 업무 질문 형식으로 고치지 않는다.
  const business = prose.split(/\r?\n/).filter(line => !line.includes("code-agent consent respond")).join("\n");
  const literalReply = /[“「"‘'][^\n“”「」"‘’']{1,120}[”」"’'](?:\*\*)?\s*(?:이?라고|으로|로)\s*(?:답(?:변)?|응답|입력)\s*(?:해\s*주세요|해\s*주십시오|해주세요|하세요)/.test(business);
  if (!literalReply) return undefined;
  const choices = business.split(/\r?\n/).filter(line => /^\s*(?:\d+[.)]|[A-Z][.)]|[-*])\s+\S/.test(line));
  if (choices.length >= 2) return undefined;
  return [
    "선택지 없이 특정 문구로 답하라는 요청이 마지막 응답에 있습니다.",
    `새 업무 결정이면 제안 내용·근거와 선택지별 결과를 보여 주고 ${askVia()} 질문하세요.`,
    "테스트·품질 기준은 각각 제안 기준 사용 / 항목 수정 / 보류를 제시합니다. 도구가 없거나 거부되면 그 이유와 번호 선택지를 씁니다.",
    "이미 제시한 질문은 다시 호출하지 말고 기존 선택지를 안내하세요. 이미 받은 답은 재질문하지 않습니다. 동의는 기존 동의 절차로 처리합니다.",
  ].join("\n");
}
