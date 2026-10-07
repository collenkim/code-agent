/**
 * 템플릿 문장의 동기 — Codex 문장째 치환의 원문(`CODEX_SENTENCES`), 계획 스킬 4개의 공통 항목, 17개 스킬의 공통 질문·동의 문단.
 * 어긋나면 오류 없이 치환이 빠지거나 스킬마다 규칙이 갈린다.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { CODEX_SENTENCES, hostAssets } from "../agent/hosts";

const TEMPLATE = join(__dirname, "../../template/claude");
function claudeTexts(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".md")) out.set(`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), "utf8").replace(/\r\n/g, "\n"));
    }
  };
  walk(TEMPLATE, "");
  return out;
}
const skill = (name: string): string => readFileSync(join(TEMPLATE, "skills", name, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");

test("codexText 고정 문장 치환의 원문은 Claude 템플릿 하나 이상에 있고 Codex 사본에는 남지 않는다", () => {
  const claude = [...claudeTexts().values()];
  const codex = [...hostAssets("codex").values()];
  for (const [from] of CODEX_SENTENCES) {
    assert.ok(claude.some((text) => text.includes(from)), `codexText 고정 문장이 템플릿에 없습니다: ${from.slice(0, 30)}`);
    assert.ok(!codex.some((text) => text.includes(from)), `Codex 사본에 치환되지 않은 문장이 남았습니다: ${from.slice(0, 30)}`);
  }
});

test("계획 스킬 4개의 공통 항목(2·3·4항)은 글자까지 같다 — action 별 행동의 원천은 planning advance 의 next 줄이다", () => {
  const items = (name: string) => {
    const lines = skill(name).split("\n");
    return ["2. 이후는 출력의 `next` 줄(action별 다음 행동)을 따르고", "3. 담당은 출력 문서를 staging에", "4. `next` 줄이 싣는 행동의 요지"].map((head) => {
      const found = lines.filter((line) => line.startsWith(head));
      assert.equal(found.length, 1, `${name}: '${head}' 항목이 하나여야 합니다`);
      return found[0];
    });
  };
  const reference = items("ca-analyze");
  for (const name of ["ca-impact", "ca-design", "ca-plan"]) assert.deepEqual(items(name), reference, `계획 스킬 공통 항목이 서로 다릅니다: ${name}`);
  // 연쇄는 program 게이트 단계만 — 계획 제출·승인(사람 확인)은 잇지 않는다
  for (const name of ["ca-analyze", "ca-impact", "ca-design"]) assert.match(skill(name), /^1\. Bash: `code-agent planning advance --chain`/m, name);
  assert.doesNotMatch(skill("ca-plan"), /--chain/);
});

test("질문·동의 공통 문단은 17개 스킬에서 같은 글자다", () => {
  const skills = readdirSync(join(TEMPLATE, "skills")).filter((name) => name !== "ca-answer");
  const lines = skills.map((name) => [name, skill(name).split("\n").filter((line) => line.startsWith("**질문·동의** —"))] as const);
  assert.equal(lines.length, 17);
  for (const [name, found] of lines) assert.equal(found.length, 1, name);
  const reference = lines[0][1][0];
  assert.match(reference, /이 대화에서 아직 읽지 않았거나 대화가 압축·비워진 뒤라면 그 직전에 읽는다/);
  for (const [name, found] of lines) assert.equal(found[0], reference, `공통 문단이 다릅니다: ${name}`);
});
