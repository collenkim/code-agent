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
  /** 이 질문을 낸 계획 작업 — 담당·교차 검토 질문에 코드가 `[Origin]:` 줄로 기록한다 */
  origin?: string;
  /** `[Answer]:` 앞 본문의 선택지 줄(`A. 문장`) — 답이 선택지 글자일 때 관찰된 응답과 대조한다 */
  options?: Record<string, string>;
  /** 답의 출처 — `[Answer]:` 뒤의 마지막 `[Source]:` 줄(관찰 안 된 대화 답은 `대화`). 답이 비면 두지 않는다 */
  source?: string;
}

/**
 * 질문 블록의 구조 필드 줄. 파서가 m 플래그 정규식(`split(/^## /m)`, [Status]·[Requirements])으로 읽으므로
 * 줄 경계도 그와 같게 본다 — JS 의 m 플래그 `^` 는 \n·\r·U+2028·U+2029 뒤에서 모두 맞는다.
 * `\s` 는 `trim()` 이 지우는 문자 집합(U+3000·NBSP·BOM 포함)과 같다. 담당·교차 결과의 질문 본문에는 둘 수 없다
 */
export const QUESTION_FIELD_LINE = /^\s*(?:##|\[(?:Answer|Status|Requirements|Origin|Source)\]:)/m;
export function structuralLine(text: string): boolean { return QUESTION_FIELD_LINE.test(text); }
/** `[Origin]:` 값 — 계획 작업 ID 형식(TaskSchema.id)과 같다 */
export const ORIGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;

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
        : [body[marker].trim().slice("[Answer]:".length), ...body.slice(marker + 1).filter(line => !/^\s*\[(?:Status|Requirements|Origin|Source)\]:/.test(line))]
            .join("\n")
            .replace(/<!--[\s\S]*?-->/g, "")
            .split("\n").filter((line) => !/^\s*(?:([-*_])\s*){3,}$/.test(line))
            .join("\n").trim();
    const state = /^\s*\[Status\]:\s*(\S+)/m.exec(body.join("\n"))?.[1];
    const requirements = /^[ \t]*\[Requirements\]:[ \t]*(.*)/m.exec(body.join("\n"))?.[1].match(/\b(?:R\d+|REQ-\d+|DONE-\d+|CON-\d+)\b/g);
    // 출처는 `[Answer]:` 앞의 \n 줄 중 마지막 `[Origin]:` 줄이다 — 코드가 쓰는 블록은 그 줄을 `[Answer]:` 바로 앞에 둔다.
    // m 플래그 정규식을 쓰지 않으므로 한 줄 안의 \r·U+2028 뒤 글자는 줄 머리로 읽히지 않는다(본문 검사와 이중 방어)
    const head = marker < 0 ? body : body.slice(0, marker);
    const raw = head.map((line) => line.trim()).filter((line) => line.startsWith("[Origin]:")).at(-1)?.slice("[Origin]:".length).trim();
    const origin = raw && ORIGIN_ID.test(raw) ? raw : undefined;
    if (!usableAnswer(answer) || (state && state !== "answered")) answer = "";
    // 선택지는 표시자 앞, 출처는 표시자 뒤에서만 읽는다 — 질문 본문에 둔 `[Source]: 대화` 가 출처를 바꾸지 못한다(origin 과 대칭)
    const options: Record<string, string> = {};
    for (const line of head) {
      const option = /^\s*([A-Z])[.)]\s+(.+?)\s*$/.exec(line);
      if (option && !(option[1] in options)) options[option[1]] = option[2];
    }
    const source = marker < 0 || !answer ? undefined
      : body.slice(marker + 1).map((line) => line.trim()).filter((line) => line.startsWith("[Source]:")).at(-1)?.slice("[Source]:".length).trim();
    questions.push({ id, title: heading.trim(), answer,
      ...(state ? { status: state === "answered" && answer ? "answered" as const : state === "deferred" ? "deferred" as const : "pending" as const } : {}),
      ...(requirements ? { requirements: [...new Set(requirements)] } : {}),
      ...(origin ? { origin } : {}),
      ...(Object.keys(options).length ? { options } : {}),
      ...(source ? { source } : {}),
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
