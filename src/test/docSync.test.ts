/**
 * 문서 생성 블록 — doc/process-flow.md 의 표 가운데 코드가 원천인 것은 코드가 렌더한 출력과 바이트가 같아야 한다.
 *
 * 블록은 `<!-- generated:<이름> -->` 줄과 `<!-- /generated:<이름> -->` 줄 사이다. 줄바꿈(CRLF·LF) 차이만 무시한다.
 * 고칠 때는 문서를 손으로 고치지 말고 원천(예: retryPolicy.ts POLICIES)을 고친 뒤 렌더 결과를 다시 붙인다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderRetryPolicyTable } from "../agent/retryPolicy";

const DOC = join(__dirname, "..", "..", "doc", "process-flow.md");

function generatedBlock(text: string, name: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const open = `<!-- generated:${name} -->\n`, close = `\n<!-- /generated:${name} -->`;
  const start = normalized.indexOf(open);
  assert.ok(start >= 0, `${open.trim()} 줄이 없습니다`);
  assert.equal(normalized.indexOf(open, start + 1), -1, `${open.trim()} 블록이 둘 이상입니다`);
  const end = normalized.indexOf(close, start + open.length);
  assert.ok(end >= 0, `${close.trim()} 줄이 없습니다`);
  return normalized.slice(start + open.length, end);
}

test("process-flow.md §6.4 재시도 규약 표는 renderRetryPolicyTable() 출력과 같다", () => {
  const block = generatedBlock(readFileSync(DOC, "utf8"), "retry-policy");
  assert.equal(block, renderRetryPolicyTable(),
    "doc/process-flow.md 의 generated:retry-policy 블록을 renderRetryPolicyTable() 출력으로 다시 붙이세요 — " +
    "node -e \"process.stdout.write(require('./dist/agent/retryPolicy').renderRetryPolicyTable())\"");
});

test("생성 블록 추출은 줄바꿈 차이를 무시하고 표지가 빠지면 실패한다", () => {
  assert.equal(generatedBlock("앞\r\n<!-- generated:x -->\r\n| a |\r\n| b |\r\n<!-- /generated:x -->\r\n뒤", "x"), "| a |\n| b |");
  assert.throws(() => generatedBlock("<!-- generated:x -->\n| a |\n", "x"), /\/generated:x/);
  assert.throws(() => generatedBlock("| a |", "x"), /generated:x/);
});
