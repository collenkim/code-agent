import { readSync } from "fs";

import type { Presence } from "../core/approval";

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
 * 사람이 그 자리에 있는지 **관측한다.** 판정의 위조 방지가 실제로 서는 자리다.
 *
 * 모델이 셸로 명령을 돌릴 때 stdin 은 TTY 가 아니므로 이 문이 닫힌다. 증명되는 것은 존재와 시점이고
 * 신원이 아니다 — 신원은 커밋 서명·PR·티켓에 있다.
 */
/** 사람만 바꿀 수 있는 설정 — 판정처럼 입력 단어를 받지는 않고, 터미널인지만 본다 */
export function requireTerminal(what: string): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${what}은(는) 터미널에서만 바꿉니다 — stdin 이 TTY 가 아닙니다.\n` +
        "  Claude Code 밖의 별도 터미널에서 실행하세요.",
    );
  }
}

/**
 * 터미널에 한 줄 묻고 답을 받는다. 반영에서 KNOWLEDGE 항목을 하나씩 고르는 자리에 쓴다 —
 * 그 선택은 판정이 아니라서 확인 문구를 요구하지 않지만, 사람이 없으면 물을 수도 없다.
 */
export function askOnTerminal(shown: string, prompt: string): string {
  requireTerminal(prompt);
  process.stdout.write(`${shown}\n${prompt}: `);
  return readLineSync();
}

export function confirmOnTerminal(shown: string, word: string): Presence {
  if (!process.stdin.isTTY) {
    throw new Error(
      "판정은 터미널에서 받습니다 — stdin 이 TTY 가 아닙니다.\n" +
        "  Claude Code 밖의 별도 터미널에서 실행하세요. 모델 세션 안의 판정은 모델이 한 것과 구분되지 않습니다.",
    );
  }
  process.stdout.write(`${shown}\n\n${word} 를 그대로 입력하면 판정을 남깁니다 (다른 입력은 취소): `);
  const typed = readLineSync();
  if (typed !== word) {
    throw new Error(`판정을 남기지 않았습니다 — ${word} 가 아니라 ${JSON.stringify(typed)} 를 입력했습니다.`);
  }
  return { channel: "tty", verified: true, detail: `터미널에서 ${word} 입력` };
}
