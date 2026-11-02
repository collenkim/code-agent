import { closeSync, fstatSync, openSync, readSync } from "fs";

/** Claude가 hook에 넘긴 대화 기록만 본다. 도구 출력·thinking·다른 세션의 글은 사용자에게 표시한 전문이 아니다. */
export function hasConsentPresentation(path: string | undefined, session: string, since: string, summary: string, toolId: string): boolean {
  if (!path || !summary.trim()) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size, start = Math.max(0, size - 16 * 1024 * 1024);
    const bytes = Buffer.alloc(size - start);
    readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString("utf8").split(/\r?\n/);
    if (start) lines.shift();
    const texts: string[] = [];
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.sessionId !== session || row.type !== "assistant" || row.isSidechain ||
          !(Date.parse(row.timestamp) >= Date.parse(since)) || !Array.isArray(row.message?.content)) continue;
      for (const block of row.message.content) {
        if (block.type === "tool_use" && block.id === toolId) return contains(texts, summary);
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }
    return contains(texts, summary);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function contains(texts: string[], summary: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  return normalize(texts.join("\n")).includes(normalize(summary));
}
