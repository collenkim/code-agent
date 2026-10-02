import { readSync } from "fs";

import type { Presence } from "../core/approval";

/** 세션 도구 응답을 검증한 실행 경로만 주입한다. CLI 플래그로 만들 수 없다. */
export interface Interaction {
  confirm(shown: string, word: string): Presence;
  ask(shown: string, prompt: string): string;
}
let interaction: Interaction | undefined;
export function withInteraction<T>(adapter: Interaction, run: () => T): T {
  if (interaction) throw new Error("확인 작업을 중첩 실행할 수 없습니다.");
  interaction = adapter;
  try { return run(); } finally { interaction = undefined; }
}

/** 의존성 없이 동기 대기. TTY 가 비어 있을 때 바쁜 회전을 막는다 */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLineSync(): string {
  const buffer = Buffer.alloc(256);
  let text = "";
  while (!text.includes("\n")) {
    let read: number;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        pause(40);
        continue;
      }
      if (code === "EOF") {
        break;
      }
      throw error;
    }
    if (read === 0) {
      break;
    }
    text += buffer.subarray(0, read).toString("utf-8");
  }
  return text.split("\n")[0].trim();
}

/**
 * 현재 Claude 세션의 선택 응답은 consent hook이 관측하고 검증한 실행 경로로 받는다.
 *
 * 직접 CLI를 쓰는 사용자는 TTY 입력으로 확인할 수도 있다. 검증된 세션 응답 없이 직접 호출하면
 * TTY를 요구한다. 이 관측은 신원 증명이 아니다 — 신원은 커밋 서명·PR·티켓에 있다.
 */
/** 검증된 세션 실행을 받거나, 수동 CLI 경로에서 TTY 여부를 확인한다. */
export function requireTerminal(what: string): void {
  if (interaction) return;
  if (!process.stdin.isTTY) {
    throw new Error(
      `${what}의 직접 CLI 변경은 터미널에서만 바꿉니다 — stdin 이 TTY 가 아닙니다.\n` +
        "  현재 Claude 세션에서 ca-answer의 동의 절차로 선택·확인하세요. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다. TTY 직접 실행은 CLI를 원하는 사용자의 수동 대체 경로입니다.",
    );
  }
}

/**
 * 반영할 KNOWLEDGE 항목의 선택을 검증된 세션 응답으로 받는다.
 * 수동 CLI 경로에서는 터미널에 한 줄 묻고 답을 받으며 확인 단어는 요구하지 않는다.
 */
export function askOnTerminal(shown: string, prompt: string): string {
  if (interaction) return interaction.ask(shown, prompt);
  requireTerminal(prompt);
  process.stdout.write(`${shown}\n${prompt}: `);
  return readLineSync();
}

export function confirmOnTerminal(shown: string, word: string): Presence {
  if (interaction) return interaction.confirm(shown, word);
  if (!process.stdin.isTTY) {
    throw new Error(
      "직접 CLI 판정은 터미널에서 받습니다 — stdin 이 TTY 가 아닙니다.\n" +
        "  현재 Claude 세션에서 ca-answer의 동의 절차를 따르세요: code-agent consent prepare <action.json> → 반환된 toolInput 전체로 AskUserQuestion → code-agent consent status <ID> (남은 questions가 있으면 반복) → approved일 때만 code-agent consent apply <ID>. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다. TTY 직접 실행은 CLI를 원하는 사용자의 수동 대체 경로입니다.",
    );
  }
  process.stdout.write(`${shown}\n\n${word} 를 그대로 입력하면 판정을 남깁니다 (다른 입력은 취소): `);
  const typed = readLineSync();
  if (typed !== word) {
    throw new Error(`판정을 남기지 않았습니다 — ${word} 가 아니라 ${JSON.stringify(typed)} 를 입력했습니다.`);
  }
  return { channel: "tty", verified: true, detail: `터미널에서 ${word} 입력` };
}
