/**
 * 문서 안의 **코드 구역** — ⑨ 의 회차 머리와 ⑩ 의 추적표가 여기 산다.
 *
 * ⑧ 처럼 파일 전체를 코드가 쓰면 모델이 한 글자도 보탤 수 없고, ⑤ 처럼 hook 으로 경로를 막으면
 * 모델이 써야 하는 부분까지 닫힌다. 한 파일 안에서 **쓰는 쪽이 갈리는** 문서는 구역으로 나눈다:
 * 표시 안쪽은 코드가 매번 다시 렌더하고, 바깥은 모델이 쓴다.
 *
 * 경로 단위 hook 으로 안쪽만 막으려면 Edit 의 부분 치환까지 봐야 해 비싸다. 대신 **다시 렌더해
 * 바이트로 대조한다** — 손으로 고친 것이 그 자리에서 드러나고, 드러난 것은 덮어 쓴다.
 * (`init.ts` 의 CLAUDE.md 블록과 같은 방식이고, 그쪽은 파일을 직접 쓰므로 함수를 나누지 않았다.)
 *
 * **짝은 하나뿐이다.** 첫 짝만 보면 두 번째 짝이 위조본을 실어 나른다 — 대조도 재렌더도 첫 짝만
 * 건드리고, 커밋되는 파일에는 아무도 안 본 표가 남는다. 그래서 여기는 전부 **모든 짝을** 센다.
 */
function markers(name: string): { start: string; end: string } {
  return { start: `<!-- code-agent:${name}:start -->`, end: `<!-- code-agent:${name}:end -->` };
}

/** 짝지어진 구역 전부, 앞에서부터. 짝을 못 이룬 표시는 담기지 않는다 */
function pairs(text: string, name: string): { from: number; to: number }[] {
  const { start, end } = markers(name);
  const found: { from: number; to: number }[] = [];
  let at = 0;
  for (;;) {
    const from = text.indexOf(start, at);
    if (from < 0) {
      return found;
    }
    const to = text.indexOf(end, from + start.length);
    if (to < 0) {
      return found;
    }
    found.push({ from, to: to + end.length });
    at = to + end.length;
  }
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/** 이 이름의 구역이 문서에 몇 짝 있는가 — "손대지 않은 첫 렌더" 와 "고쳐진 것" 을 가르는 자리 */
export function blockCount(text: string, name: string): number {
  return pairs(text, name).length;
}

/**
 * 구역 안쪽. 표시가 없으면 undefined — "비었다"(빈 문자열)와 구분한다.
 * 표시가 하나를 넘어도 undefined 다: 어느 쪽이 코드가 쓴 것인지 알 수 없으면 어느 쪽도 믿지 않는다.
 */
export function readBlock(text: string, name: string): string | undefined {
  const { start, end } = markers(name);
  if (occurrences(text, start) !== 1 || occurrences(text, end) !== 1) {
    return undefined;
  }
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to <= from) {
    return undefined;
  }
  return text.slice(from + start.length, to).trim();
}

/** 구역을 덜어 낸 나머지 — 모델이 쓴 부분만 읽을 때 쓴다 (코드가 쓴 표와 섞이지 않게) */
export function stripBlock(text: string, name: string): string {
  let out = "";
  let at = 0;
  for (const range of pairs(text, name)) {
    out += text.slice(at, range.from);
    at = range.to;
  }
  return out + text.slice(at);
}

/**
 * 구역을 넣거나 갈아 끼운다. 표시가 없으면 끝에 붙인다 — 바깥은 한 글자도 건드리지 않는다.
 * 짝이 여럿이면 전부 걷어 내고 첫 자리에 하나만 남긴다.
 */
export function upsertBlock(text: string, name: string, body: string): string {
  const { start, end } = markers(name);
  const block = `${start}\n${body.trim()}\n${end}`;
  const found = pairs(text, name);
  if (found.length === 0) {
    return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
  }
  let out = "";
  let at = 0;
  for (const [index, range] of found.entries()) {
    out += text.slice(at, range.from) + (index === 0 ? block : "");
    at = range.to;
  }
  return out + text.slice(at);
}
