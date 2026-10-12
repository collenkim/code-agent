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
  assert.match(reference, /reference\.md.*차단 복구/);
  assert.match(reference, /AskUserQuestion.*실제 호출/);
  for (const [name, found] of lines) assert.equal(found[0], reference, `공통 문단이 다릅니다: ${name}`);
});

test("두 호스트의 모든 진입은 복구로 연결하고 업무 선택 도구와 동의를 구분한다", () => {
  for (const host of ["claude", "codex"] as const) {
    const assets = hostAssets(host);
    const prefix = host === "claude" ? ".claude" : ".agents";
    const answer = assets.get(`${prefix}/skills/ca-answer/SKILL.md`)!;
    const recovery = assets.get(`${prefix}/skills/ca-answer/reference.md`)!;
    assert.match(answer, /reference\.md.*차단 복구/);
    assert.match(answer, /허용된 도움말·상태 조회.*재확인 없이/);
    assert.match(recovery, /planning --help.*code-agent help/);
    assert.match(recovery, /이미 선택한 방향.*계속한다/);
    assert.match(recovery, /새 결정에 의존하는 동작만/);
    for (const [path, text] of assets) {
      if (!path.endsWith("/SKILL.md") || path.endsWith("ca-answer/SKILL.md")) continue;
      assert.match(text, /reference\.md.*차단 복구/, path);
      assert.doesNotMatch(text, /거부하면 사유를 전하고 멈춘다|명령 자체가 거부되면 사유를 보고하고 멈춘다/, path);
    }
    const docs = assets.get(`${prefix}/skills/ca-docs/SKILL.md`)!;
    assert.match(docs, /사용자가 특정 방식을 이미 요청했으면 바로 그 절차를 따른다/);
    if (host === "codex") {
      assert.match(answer, /request_user_input_async/);
      assert.match(answer, /request_user_input.*현재 모드.*사용 조건/);
      assert.match(answer, /도구가 없거나 호출이 거부되면.*번호·선택지 이름·결과/);
      assert.match(answer, /승인은 이 도구의 답으로 처리하지 않고/);
      assert.match(answer, /UserPromptSubmit/);
    } else {
      assert.match(answer, /AskUserQuestion.*실제로 호출/);
      assert.match(answer, /도구가 없거나 호출이 거부되면/);
      assert.match(answer, /대화 답을 관찰된 도구 응답이나 승인으로 기록하지 않는다/);
    }
  }
});

test("H7 ca-* 담당을 부르는 Claude 스킬 문장마다 Agent 도구를 run_in_background: false 로 부르게 하고, Codex 사본은 결과를 기다리는 문장으로 바꾼다", () => {
  // claude 2.1.293 은 run_in_background 를 주지 않은 Agent 호출을 백그라운드로 띄운 일이 있다 — 결과 전에 메인 차례가 끝나지 않게 한다
  const FOREGROUND = "Agent 도구는 `run_in_background: false` 로 부른다(결과를 받아야 다음 단계로 간다).";
  const CODEX = "담당의 결과를 받을 때까지 기다린 뒤 다음 단계로 간다.";
  assert.ok(CODEX_SENTENCES.some(([from, to]) => from === FOREGROUND && to === CODEX), "codexText 치환이 없습니다");
  // 역할 이름 없이 부르는 다시 맡기기(ca-implement 5항 '같은 서브에이전트에게 그 Task만 한 번 더 맡긴다')도 담당 호출이다
  const call = /`ca-(?:analyst|explorer|writer|critic|reviewer|implementer|surveyor|tester)`[^\n]*?(?:부른다|맡긴다|쓰게 한다|옮기게 한다|요청한다|검토를 받는다)|`agent` 서브에이전트를 호출|서브에이전트에게[^\n]*?맡긴다/;
  const codex = hostAssets("codex");
  let calls = 0;
  for (const [path, text] of claudeTexts()) {
    // SKILL.md 와 필요할 때 읽는 보조 문서(legacy.md 등 — 이전 버전 작업 절차도 담당을 부른다)
    if (!path.startsWith("skills/") || !path.endsWith(".md")) continue;
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      if (!call.test(line)) return;
      calls += 1;
      assert.ok(`${line}\n${lines[index + 1] ?? ""}`.includes(FOREGROUND), `${path}:${index + 1} 담당 호출에 전경 실행 문장이 없습니다: ${line.slice(0, 60)}`);
    });
    const copy = codex.get(`.agents/${path}`);
    if (copy === undefined || path.startsWith("skills/ca-answer/")) continue;
    assert.equal(copy.split(CODEX).length, text.split(FOREGROUND).length, `${path} 의 Codex 사본에 기다림 문장 수가 다릅니다`);
    assert.doesNotMatch(copy, /run_in_background|Agent 도구/, path);
  }
  // 계획 스킬 4개·ca-review·ca-implement 둘(2항 호출·5항 다시 맡기기)·ca-test·ca-check·ca-docs 둘·ca-adopt, 이전 버전 절차(legacy.md) — 분석·설계·계획 하나씩·영향도 둘
  assert.equal(calls, 17);
});
