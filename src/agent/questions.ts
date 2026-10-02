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
  status?: "pending" | "answered" | "deferred";
  requirements?: string[];
}

/** 상태 설명과 보류는 업무 결정이 아니다. 기존 문서도 같은 규칙으로 읽는다. */
export function usableAnswer(answer: string): boolean {
  const value = answer.trim().replace(/^(?:[A-Z0-9]+[.)]|[-*])\s+/, "");
  return !!value && !/^(?:(?:보류|취소)(?:합니다|하겠습니다)?|건너뛰기|모르겠(?:다|어요)|미응답|응답\s*대기|pending|deferred|cancelled|skip)(?:[.!。]?(?:$|\r?\n)|\s*[—–-]\s*|\s*[:(])/i.test(value) &&
    !/^\(?\s*(?:상태|해석|참고)\s*:/.test(value);
}

export function parseQuestions(text: string): Question[] {
  const questions: Question[] = [];
  const blocks = text.split(/^## /m).slice(1);
  for (const block of blocks) {
    const [heading, ...body] = block.split("\n");
    const id = heading.split(/\s/)[0];
    const marker = body.findIndex((line) => line.trim().startsWith("[Answer]:"));
    let answer =
      marker < 0
        ? ""
        : [body[marker].trim().slice("[Answer]:".length), ...body.slice(marker + 1).filter(line => !/^\s*\[(?:Status|Requirements)\]:/.test(line))]
            .join("\n")
            .replace(/<!--[\s\S]*?-->/g, "")
            .split("\n").filter((line) => !/^\s*(?:([-*_])\s*){3,}$/.test(line))
            .join("\n").trim();
    const state = /^\s*\[Status\]:\s*(\S+)/m.exec(body.join("\n"))?.[1];
    const requirements = /^[ \t]*\[Requirements\]:[ \t]*(.*)/m.exec(body.join("\n"))?.[1].match(/\b(?:R\d+|REQ-\d+|DONE-\d+|CON-\d+)\b/g);
    if (!usableAnswer(answer) || (state && state !== "answered")) answer = "";
    questions.push({ id, title: heading.trim(), answer,
      ...(state ? { status: state === "answered" && answer ? "answered" as const : state === "deferred" ? "deferred" as const : "pending" as const } : {}),
      ...(requirements ? { requirements: [...new Set(requirements)] } : {}),
    });
  }
  // 서로 다른 질문이 같은 ID를 쓰면 어느 답인지 확정할 수 없다.
  for (const question of questions) if (questions.filter(item => item.id === question.id).length > 1) question.answer = "";
  return questions;
}

export function unansweredQuestions(repoRoot: string, questionsPath: string): Question[] {
  const path = join(repoRoot, questionsPath);
  if (!existsSync(path)) {
    return [];
  }
  return parseQuestions(readFileSync(path, "utf-8")).filter((question) => question.answer === "");
}
