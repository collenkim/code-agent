/**
 * 선택 화면(Claude AskUserQuestion · Codex MCP 폼)에 싣는 글의 크기. 두 호스트 모두 화면 높이를 넘는 질문 본문을 스크롤 없이 자른다
 * (Claude 는 앞뒤를 잘라 중간만, Codex 폼은 아래를 잘라 질문 줄이 보이지 않는다) — 긴 내용은 대화·파일에 두고 화면에는 이 범위만 싣는다.
 * 폭은 80칸 터미널에서 테두리·여백을 뺀 값이고, 한글·한자·전각 문자는 두 칸으로 센다.
 */
export const SCREEN_WIDTH = 76;
/** 질문 본문 하나의 최대 화면 줄 수 — 선택지 3개·안내 줄과 함께 80×24 터미널에 들어가는 크기(두 호스트 실측) */
export const QUESTION_ROWS = 10;
/** 선택지 하나(Claude 는 이름+설명, Codex 는 이름)의 최대 화면 줄 수 */
export const OPTION_ROWS = 3;

function wide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd);
}
function cells(char: string): number {
  const code = char.codePointAt(0)!;
  if (/\p{Mn}|\p{Me}|\p{Cf}/u.test(char)) return 0;
  return wide(code) ? 2 : 1;
}
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += cells(char);
  return width;
}
/** 줄바꿈과 자동 줄넘김을 합친 화면 줄 수 */
export function screenRows(text: string, width = SCREEN_WIDTH): number {
  return text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line.trimEnd()) / width)), 0);
}
/** 한 줄을 화면 폭에 맞춰 자른다(잘렸으면 끝에 …) */
export function clipLine(line: string, width = SCREEN_WIDTH): { text: string; clipped: boolean } {
  if (displayWidth(line) <= width) return { text: line, clipped: false };
  let used = 0, text = "";
  for (const char of line) {
    if (used + cells(char) > width - 1) break;
    used += cells(char); text += char;
  }
  return { text: `${text.trimEnd()}…`, clipped: true };
}
/** 빈 줄·표 구분선(내용이 없는 줄)은 앞부분 발췌의 줄 수를 쓰지 않는다 */
function filler(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed || (/^\|?[\s:|-]+\|?$/.test(trimmed) && trimmed.includes("---"));
}
/** 앞부분 발췌 — complete 는 내용 줄이 하나도 빠지거나 잘리지 않았다는 뜻이다 */
export function excerpt(text: string, lines: number, width = SCREEN_WIDTH): { text: string; omitted: number; complete: boolean } {
  const meaningful = text.split("\n").map((line) => line.trimEnd()).filter((line) => !filler(line));
  const head = meaningful.slice(0, lines).map((line) => clipLine(line, width));
  const omitted = meaningful.length - head.length;
  return { text: head.map((line) => line.text).join("\n"), omitted, complete: omitted === 0 && head.every((line) => !line.clipped) };
}
/** 선택 화면에 다 보이지 않을 질문의 사유 — 모델이 쓴 업무 질문을 표시하기 전에 거른다(Claude PreToolUse hook · Codex ask) */
export function questionScreenProblem(question: string, options: string[]): string | undefined {
  const rows = screenRows(question);
  if (rows > QUESTION_ROWS) {
    return `질문 본문이 선택 화면 ${rows}줄로 ${QUESTION_ROWS}줄을 넘어 화면에서 잘립니다. 배경·비교 같은 긴 내용은 질문 전에 대화에 먼저 쓰고, 질문 본문은 결정 하나와 후보별 결과만 ${QUESTION_ROWS}줄 이내로 다시 쓰세요.`;
  }
  const long = options.find((option) => screenRows(option) > OPTION_ROWS);
  if (long) return `선택지 "${clipLine(long.split("\n")[0], 30).text}"가 ${OPTION_ROWS}줄을 넘어 화면에서 잘립니다. 선택지는 짧은 이름과 한 문장 설명으로 줄이세요.`;
}
