import { existsSync, readFileSync } from "fs";
import { join } from "path";

/**
 * 작업 폴더의 `questions.md`.
 *
 * ```
 * ## Q3 · 요구사항 분석
 * 주문 취소 후 재주문이 가능한가?
 * A. 가능 — 새 주문번호
 * B. 불가
 * [Answer]: A
 * ```
 *
 * `[Answer]:` 뒤(같은 줄이나 다음 줄들)가 비어 있으면 답이 없는 것이다. 답이 없는 질문이 하나라도 있으면
 * 다음 스테이지로 넘어가지 않는다 — 모호한 것을 지어내지 않고 묻는다는 규칙의 강제 쪽이다.
 */
export interface Question {
  id: string;
  title: string;
  answer: string;
}

export function parseQuestions(text: string): Question[] {
  const questions: Question[] = [];
  const blocks = text.split(/^## /m).slice(1);
  for (const block of blocks) {
    const [heading, ...body] = block.split("\n");
    const id = heading.split(/\s/)[0];
    const marker = body.findIndex((line) => line.trim().startsWith("[Answer]:"));
    const answer =
      marker < 0
        ? ""
        : [body[marker].trim().slice("[Answer]:".length), ...body.slice(marker + 1)]
            .join("\n")
            .trim();
    questions.push({ id, title: heading.trim(), answer });
  }
  return questions;
}

export function unansweredQuestions(repoRoot: string, questionsPath: string): Question[] {
  const path = join(repoRoot, questionsPath);
  if (!existsSync(path)) {
    return [];
  }
  return parseQuestions(readFileSync(path, "utf-8")).filter((question) => question.answer === "");
}
