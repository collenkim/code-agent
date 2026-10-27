import { readFileSync } from "fs";

/** 선택 문서는 읽지 못하면 없는 것으로 둔다. 필수 상태 JSON에는 쓰지 않는다. */
export function readOptionalText(path: string, normalizeLines = false): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return normalizeLines ? text.replace(/\r\n/g, "\n") : text;
  } catch { return undefined; }
}
export const readTrimmedText = (path: string): string => readOptionalText(path)?.trim() ?? "";
export const localClock = (at: string): string => new Date(at).toTimeString().slice(0, 5);
