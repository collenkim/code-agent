/**
 * 채팅 응답에서 액션을 꺼낸다.
 *
 * 여기서 가장 중요한 성질은 "무엇이 왜 안 됐는지 짚어 주는 것"이다. 사람이 클립보드로 나르는
 * 전송에서는 응답이 잘리거나 형식이 어긋나는 일이 흔한데, 통째로 실패했다고만 하면 사람이
 * 할 수 있는 게 없다. 그래서 액션 단위로 위치와 사유를 남긴다.
 */
import type { Action } from "./action";

const HEADER = /^###\s+(write|edit|read|list|run|ask|note|done)\b\s*(.*)$/;
const SUBHEADER = /^####\s+(find|replace)\s*$/;
const FENCE_OPEN = /^(`{3,})\s*[\w+-]*\s*$/;
const FENCE_CLOSE = /^(`{3,})\s*$/;

export interface ParseResult {
  actions: Action[];
  /** 하나라도 있으면 실행하지 않는다 — 절반만 반영된 상태가 가장 다루기 어렵다 */
  errors: string[];
}

/** 소스 파일은 개행으로 끝나는 것이 보통이라, 코드블록이 삼킨 마지막 개행을 되살린다. */
function withTrailingNewline(content: string): string {
  if (content === "" || content.endsWith("\n")) {
    return content;
  }
  return `${content}\n`;
}

function skipBlank(lines: string[], start: number): number {
  let i = start;
  while (i < lines.length && lines[i].trim() === "") {
    i += 1;
  }
  return i;
}

/** 코드블록 하나를 읽는다. 여는 백틱보다 짧은 줄은 닫는 것으로 보지 않는다. */
function readFence(lines: string[], start: number): { content: string; next: number } | null {
  const i = skipBlank(lines, start);
  const open = lines[i]?.match(FENCE_OPEN);
  if (!open) {
    return null;
  }

  const body: string[] = [];
  for (let cursor = i + 1; cursor < lines.length; cursor += 1) {
    const close = lines[cursor].match(FENCE_CLOSE);
    if (close && close[1].length >= open[1].length) {
      return { content: body.join("\n"), next: cursor + 1 };
    }
    body.push(lines[cursor]);
  }
  return null;
}

/** `#### find` 처럼 이름표가 붙은 코드블록 */
function readLabeled(
  lines: string[],
  start: number,
  label: "find" | "replace",
): { content: string; next: number } | null {
  const i = skipBlank(lines, start);
  const matched = lines[i]?.match(SUBHEADER);
  if (!matched || matched[1] !== label) {
    return null;
  }
  return readFence(lines, i + 1);
}

/** 다음 지시 블록 전까지의 산문. 중간에 코드블록이 있으면 통째로 건너뛴다. */
function readProse(lines: string[], start: number): { text: string; next: number } {
  const body: string[] = [];
  let i = start;

  while (i < lines.length) {
    if (HEADER.test(lines[i])) {
      break;
    }
    const fence = lines[i].match(FENCE_OPEN);
    if (fence) {
      const read = readFence(lines, i);
      if (!read) {
        body.push(...lines.slice(i));
        i = lines.length;
        break;
      }
      body.push(...lines.slice(i, read.next));
      i = read.next;
      continue;
    }
    body.push(lines[i]);
    i += 1;
  }

  return { text: body.join("\n").trim(), next: i };
}

export function parseActions(raw: string): ParseResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const actions: Action[] = [];
  const errors: string[] = [];
  let sawHeader = false;
  let i = 0;

  while (i < lines.length) {
    const header = lines[i].match(HEADER);
    if (!header) {
      i += 1;
      continue;
    }

    sawHeader = true;
    const verb = header[1];
    const argument = header[2].trim();
    const where = `${i + 1}행 '### ${verb}'`;
    i += 1;

    if (verb === "done") {
      actions.push({ type: "done" });
      continue;
    }

    if (verb === "ask" || verb === "note") {
      const prose = readProse(lines, i);
      if (!prose.text) {
        errors.push(`${where}: 내용이 비어 있습니다.`);
      } else if (verb === "ask") {
        actions.push({ type: "ask", question: prose.text });
      } else {
        actions.push({ type: "note", text: prose.text });
      }
      i = prose.next;
      continue;
    }

    if (verb === "read" || verb === "list" || verb === "run") {
      if (!argument) {
        errors.push(`${where}: ${verb === "run" ? "명령" : "경로"}이 없습니다.`);
        continue;
      }
      actions.push(
        verb === "run"
          ? { type: "run", command: argument }
          : { type: verb, path: argument },
      );
      continue;
    }

    if (!argument) {
      errors.push(`${where}: 경로가 없습니다.`);
      continue;
    }

    if (verb === "write") {
      const fence = readFence(lines, i);
      if (!fence) {
        errors.push(
          `${where} ${argument}: 코드블록이 없거나 닫히지 않았습니다 — ` +
            "응답이 중간에 잘렸을 수 있습니다. 그 파일만 다시 받아 이어 붙이세요.",
        );
        break;
      }
      actions.push({ type: "write", path: argument, content: withTrailingNewline(fence.content) });
      i = fence.next;
      continue;
    }

    // edit
    const find = readLabeled(lines, i, "find");
    if (!find) {
      errors.push(`${where} ${argument}: '#### find' 코드블록을 찾지 못했습니다.`);
      break;
    }
    const replace = readLabeled(lines, find.next, "replace");
    if (!replace) {
      errors.push(`${where} ${argument}: '#### replace' 코드블록을 찾지 못했습니다.`);
      break;
    }
    actions.push({
      type: "edit",
      path: argument,
      find: find.content,
      replace: replace.content,
    });
    i = replace.next;
  }

  if (!sawHeader) {
    errors.push(
      "지시 블록(### write / ### read / ### done …)을 하나도 찾지 못했습니다. " +
        "모델이 산문으로 답했을 수 있습니다 — 프롬프트 끝의 '출력 형식'을 함께 붙여넣었는지 확인하세요.",
    );
  }

  return { actions, errors };
}
