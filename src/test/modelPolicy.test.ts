/**
 * 역할별 모델·추론 강도 정책(modelPolicy.ts) — 정책 표·설정 읽기·저장 규칙·머리말 재작성·실행 인자를 파일 하나짜리
 * 임시 폴더로 본다. 이전 버전과의 호환(역할 값은 언제나 문자열)과 템플릿·문서가 정책 표와 같은지도 대조한다.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  AGENTS, CLAUDE_MODEL_ALIASES, CLAUDE_NO_EFFORT, claudeFrontmatter, claudeModelArgs, claudeModelOf, ClaudeModelIdSchema, ClaudeOverridesSchema, claudeSupportsEffort,
  CodexModelSchema, codexModelArgs, defaultClaudeModel, defaultCodexModel, frontmatterModel, isClaudeOverride, modelDisplay, modelLabel,
  modelPolicyFingerprint, nextClaudeOverrides, ROLE_POLICY, TIER_DEFAULTS, TIER_LABEL, type AgentName, type ClaudeEffort, type ClaudeOverrides,
} from "../agent/modelPolicy";
import { assetText } from "../agent/assets";
import { CLAUDE_ALIAS_TARGETS, PRICES, priceKey, priceOf } from "../agent/prices";
import { Stop } from "../agent/stop";

let root: string;
beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-model-policy-"))); });
afterEach(() => {
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-model-policy-"));
  rmSync(target, { recursive: true, force: true });
});
function models(value: unknown): void {
  mkdirSync(join(root, ".code-agent"), { recursive: true });
  writeFileSync(join(root, ".code-agent/models.json"), typeof value === "string" ? value : JSON.stringify(value));
}

describe("역할 정책 표", () => {
  test("1 · 8개 역할이 모두 등급과 이유를 가진다 — 판단 역할은 analyst·critic·reviewer 뿐이다", () => {
    assert.deepEqual(Object.keys(ROLE_POLICY).sort(), [...AGENTS].sort());
    assert.deepEqual(AGENTS.filter((agent) => ROLE_POLICY[agent].tier === "judgment"), ["analyst", "critic", "reviewer"]);
    for (const agent of AGENTS) assert.ok(ROLE_POLICY[agent].reason.trim().length > 0, agent);
  });

  test("2 · 템플릿 머리말의 model·effort 는 역할 기본값과 같다", () => {
    for (const agent of AGENTS) {
      assert.deepEqual(frontmatterModel(assetText(`template/claude/agents/ca-${agent}.md`)), defaultClaudeModel(agent), agent);
    }
    assert.deepEqual(frontmatterModel(assetText("template/claude/agents/ca-analyst.md")), { model: "opus", effort: "high" });
    assert.deepEqual(frontmatterModel(assetText("template/claude/agents/ca-writer.md")), { model: "sonnet", effort: "medium" });
  });

  test("3 · Codex 기본값은 그대로다 — 판단 gpt-6.1-sol/high, 실행 gpt-6.1-sol/medium", () => {
    for (const agent of AGENTS) {
      const judgment = ROLE_POLICY[agent].tier === "judgment";
      assert.deepEqual(defaultCodexModel(agent), { model: "gpt-6.1-sol", reasoning: judgment ? "high" : "medium" }, agent);
      assert.deepEqual(defaultClaudeModel(agent), judgment ? { model: "opus", effort: "high" } : { model: "sonnet", effort: "medium" }, agent);
    }
  });
});

describe("models.json 읽기", () => {
  test("4 · 이전 형식(역할 키만)은 그대로 읽는다 — 바꿈은 해석값이 기본값과 다른지로 본다", () => {
    models({ implementer: "opus" });
    assert.deepEqual(claudeModelOf(root, "implementer"), { model: "opus", effort: "medium" });
    assert.equal(isClaudeOverride(root, "implementer"), true);
    models({ writer: "sonnet" });
    assert.deepEqual(claudeModelOf(root, "writer"), { model: "sonnet", effort: "medium" });
    assert.equal(isClaudeOverride(root, "writer"), false);
    assert.deepEqual(claudeModelOf(undefined, "reviewer"), { model: "opus", effort: "high" });
  });

  test("5 · 강도는 예약 키 effort 에서 읽는다", () => {
    models({ effort: { reviewer: "max" } });
    assert.deepEqual(claudeModelOf(root, "reviewer"), { model: "opus", effort: "max" });
    assert.equal(isClaudeOverride(root, "reviewer"), true);
    assert.deepEqual(claudeModelOf(root, "analyst"), { model: "opus", effort: "high" });
    models({ writer: "opus", effort: { writer: "low" } });
    assert.deepEqual(claudeModelOf(root, "writer"), { model: "opus", effort: "low" });
  });

  test("6 · 강도를 받지 않는 모델은 effort 가 없다 — 남은 강도 항목은 무시한다", () => {
    models({ reviewer: "haiku" });
    assert.deepEqual(claudeModelOf(root, "reviewer"), { model: "haiku" });
    assert.equal("effort" in claudeModelOf(root, "reviewer"), false);
    assert.equal(isClaudeOverride(root, "reviewer"), true);
    models({ reviewer: "haiku", effort: { reviewer: "max" } });
    assert.deepEqual(claudeModelOf(root, "reviewer"), { model: "haiku" });
    for (const model of [
      "haiku", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929",
      // 4 세대의 effort 이전 모델과 이전 명명 체계(haiku 포함) — 전체 ID 를 사람이 직접 고른 경우
      "claude-sonnet-4", "claude-sonnet-4-0", "claude-sonnet-4-20250514", "claude-opus-4", "claude-opus-4-0", "claude-opus-4-1",
      "claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307",
      "claude-3-5-haiku-latest", "claude-3-7-sonnet-20250219", "claude-3-opus-20240229", "claude-2.1",
    ]) {
      assert.equal(claudeSupportsEffort(model), false, model);
    }
    for (const model of [
      "opus", "sonnet", "fable", "claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1",
      "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-8", "claude-sonnet-4-6",
    ]) {
      assert.equal(claudeSupportsEffort(model), true, model);
    }
    assert.ok(CLAUDE_NO_EFFORT.length > 0);
  });

  test("7 · 잘못된 파일은 고치는 법과 함께 Stop 으로 멈춘다", () => {
    for (const bad of [
      { writer: "inherit" }, { nobody: "opus" }, { writer: { model: "opus", effort: "max" } },
      { effort: { writer: "ultra" } }, { effort: { nobody: "high" } }, "{",
    ]) {
      models(bad);
      assert.throws(() => claudeModelOf(root, "writer"), (error: unknown) => {
        assert.ok(error instanceof Stop, JSON.stringify(bad));
        assert.match(error.message, /models\.json/);
        assert.match(error.message, /"effort": \{"<역할>": "<강도>"\}/);
        return true;
      });
    }
  });
});

describe("저장 규칙", () => {
  const steps: [AgentName, string, ClaudeEffort | undefined, string][] = [
    ["implementer", "haiku", undefined, "haiku/(지원 안 함)"],
    ["reviewer", "opus", "max", "opus/max"],
    ["writer", "opus", undefined, "opus/medium"],
    ["reviewer", "haiku", undefined, "haiku/(지원 안 함)"],
    ["reviewer", "opus", undefined, "opus/max"],
    ["implementer", "default", undefined, "sonnet/medium"],
    ["reviewer", "default", undefined, "opus/high"],
  ];
  function run(): ClaudeOverrides[] {
    const results: ClaudeOverrides[] = [];
    let current: ClaudeOverrides = { writer: "sonnet" };
    for (const [agent, model, effort, shown] of steps) {
      const before = JSON.stringify(current);
      const next = nextClaudeOverrides(current, agent, model, effort);
      assert.equal(JSON.stringify(current), before, "입력 객체를 바꾸지 않는다");
      ClaudeOverridesSchema.parse(next);
      models(next);
      assert.equal(modelDisplay(claudeModelOf(root, agent)), shown, `${agent} ${model} ${effort ?? ""}`);
      results.push(next);
      current = next;
    }
    return results;
  }

  test("8 · 대상 역할만 바꾸고, 모델만 바꾸면 강도를 유지하며, default 는 둘 다 지운다", () => {
    const results = run();
    assert.equal(results[0].writer, "sonnet", "대상이 아닌 역할의 값은 기본값과 같아도 남는다");
    assert.equal(results[1].writer, "sonnet");
    assert.deepEqual(results[1], { writer: "sonnet", implementer: "haiku", effort: { reviewer: "max" } });
    assert.deepEqual(results[3], { writer: "opus", implementer: "haiku", reviewer: "haiku", effort: { reviewer: "max" } });
    assert.deepEqual(results.at(-1), { writer: "opus" });
    assert.deepEqual(nextClaudeOverrides({ effort: { writer: "low" } }, "writer", "sonnet", "medium"), {}, "기본값과 같은 강도는 지운다");
  });

  test("9 · 이전 버전 호환 — 모든 단계에서 역할 값은 문자열이고 이전 읽기로 [object Object] 가 나오지 않는다", () => {
    for (const result of run()) {
      assert.ok(AGENTS.every((agent) => result[agent] === undefined || typeof result[agent] === "string"), JSON.stringify(result));
      const old = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
      for (const agent of AGENTS) assert.doesNotMatch(`model: ${old[agent] ?? "opus"}`, /\[object Object\]/);
    }
  });
});

describe("머리말 재작성", () => {
  const CRLF = "---\r\nname: ca-reviewer\r\ndescription: 리뷰\r\ntools: Read\r\nmodel: opus\r\n---\r\n\r\n본문\r\nmodel: x\r\neffort: x\r\n";

  test("10 · effort 는 model 다음 줄에 넣고, 받지 않는 모델이면 지우며, 줄바꿈과 본문을 그대로 둔다", () => {
    const high = claudeFrontmatter(CRLF, { model: "opus", effort: "high" });
    assert.equal(high, CRLF.replace("model: opus\r\n", "model: opus\r\neffort: high\r\n"));
    const haiku = claudeFrontmatter(high, { model: "haiku" });
    assert.equal(haiku, CRLF.replace("model: opus", "model: haiku"));
    assert.match(haiku, /\r\nmodel: x\r\neffort: x\r\n$/, "본문의 model·effort 줄은 그대로");
    assert.equal(claudeFrontmatter(haiku, { model: "opus", effort: "high" }), high, "왕복이 처음 바이트와 같다");
    assert.equal(claudeFrontmatter(high, { model: "opus", effort: "high" }), high, "같은 값이면 같은 바이트");
    assert.equal(claudeFrontmatter(high, { model: "sonnet", effort: "max" }), high.replace("model: opus\r\neffort: high", "model: sonnet\r\neffort: max"));
    const noModel = "---\nname: x\n---\nbody\n";
    assert.equal(claudeFrontmatter(noModel, { model: "sonnet", effort: "medium" }), "---\nname: x\nmodel: sonnet\neffort: medium\n---\nbody\n");
    assert.equal(claudeFrontmatter("머리말 없음\nmodel: opus\n", { model: "haiku" }), "머리말 없음\nmodel: opus\n");
    assert.deepEqual(frontmatterModel(high), { model: "opus", effort: "high" });
    assert.deepEqual(frontmatterModel(haiku), { model: "haiku" });
    assert.deepEqual(frontmatterModel("본문만"), {});
  });
});

describe("실행 인자와 표시", () => {
  test("11 · 강도를 받지 않는 모델에는 --effort 를 넘기지 않는다", () => {
    assert.deepEqual(claudeModelArgs({ model: "opus", effort: "high" }), ["--model", "opus", "--effort", "high"]);
    assert.deepEqual(claudeModelArgs({ model: "haiku" }), ["--model", "haiku"]);
    assert.deepEqual(codexModelArgs({ model: "gpt-6.1-sol", reasoning: "high" }), ["-m", "gpt-6.1-sol", "-c", 'model_reasoning_effort="high"']);
    assert.equal(modelLabel({ model: "haiku" }), "haiku");
    assert.equal(modelLabel({ model: "opus", effort: "high" }), "opus/high");
    assert.equal(modelLabel({ model: "gpt-6.1-sol", reasoning: "high" }), "gpt-6.1-sol/high");
    assert.equal(modelDisplay({ model: "haiku" }), "haiku/(지원 안 함)");
    assert.equal(modelDisplay({ model: "sonnet", effort: "medium" }), "sonnet/medium");
  });

  test("12 · 호스트 간 모델 이름을 섞지 않는다", () => {
    for (const model of ["fable", "claude-sonnet-5-5", "inherit", "opus", "default"]) {
      assert.equal(CodexModelSchema.safeParse({ model, reasoning: "high" }).success, false, model);
    }
    assert.equal(CodexModelSchema.safeParse({ model: "gpt-6.1-sol", reasoning: "high" }).success, true);
    for (const model of ["gpt-6.1-sol", "Opus", "inherit", "claude-", "claude-Sonnet", `claude-${"a".repeat(64)}`]) {
      assert.equal(ClaudeModelIdSchema.safeParse(model).success, false, model);
    }
    for (const model of ["claude-sonnet-5-5", "fable", "opus", "claude-haiku-4-5-20251001", "claude-opus-4.6"]) {
      assert.equal(ClaudeModelIdSchema.safeParse(model).success, true, model);
    }
  });

  test("13 · 정책 지문은 등급·기본값·강도 미지원 규칙만 담고 이유 문장은 담지 않는다", () => {
    assert.equal(modelPolicyFingerprint(), modelPolicyFingerprint());
    const parsed = JSON.parse(modelPolicyFingerprint()) as { tiers: [string, string][]; defaults: unknown; noEffort: string[] };
    assert.deepEqual(Object.keys(parsed).sort(), ["defaults", "noEffort", "tiers"]);
    assert.deepEqual(parsed.defaults, TIER_DEFAULTS);
    assert.deepEqual(parsed.tiers, AGENTS.map((agent) => [agent, ROLE_POLICY[agent].tier]));
    assert.deepEqual(parsed.noEffort, CLAUDE_NO_EFFORT.map((pattern) => pattern.source));
    for (const agent of AGENTS) assert.equal(modelPolicyFingerprint().includes(ROLE_POLICY[agent].reason), false);
  });
});

describe("문서 대조", () => {
  test("16 · doc/codex.md 역할별 모델 표의 판단·실행 행은 정책 표와 같다", () => {
    const text = readFileSync(join(__dirname, "..", "..", "doc", "codex.md"), "utf8").replace(/\r\n?/g, "\n");
    const start = text.indexOf("## 역할별 모델 기본값과 변경\n");
    assert.ok(start >= 0, "역할별 모델 기본값과 변경 절이 없습니다(README 앵커)");
    const end = text.indexOf("\n## ", start + 1);
    const section = text.slice(start, end < 0 ? undefined : end);
    const rows = new Map<string, string[]>();
    for (const line of section.split("\n")) {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length === 4 && (cells[1] === "판단" || cells[1] === "실행")) rows.set(cells[1], cells);
    }
    for (const tier of ["judgment", "execution"] as const) {
      const row = rows.get(TIER_LABEL[tier]);
      assert.ok(row, `${TIER_LABEL[tier]} 행이 없습니다`);
      const [roles, , claude, codex] = row;
      assert.deepEqual(roles.split("·").map((role) => role.trim()), AGENTS.filter((agent) => ROLE_POLICY[agent].tier === tier));
      assert.equal(claude, `${TIER_DEFAULTS[tier].claude.model} / ${TIER_DEFAULTS[tier].claude.effort}`);
      assert.equal(codex, `${TIER_DEFAULTS[tier].codex.model} / ${TIER_DEFAULTS[tier].codex.reasoning}`);
    }
    for (const agent of AGENTS) assert.ok(section.includes(`- ${agent} — ${ROLE_POLICY[agent].reason}`), `${agent} 이유 문장`);
  });
});

describe("단가표", () => {
  test("14 · 역할에 지정할 수 있는 별칭과 두 등급의 기본 모델이 모두 단가를 가진다", () => {
    assert.deepEqual(Object.keys(CLAUDE_ALIAS_TARGETS).sort(), [...CLAUDE_MODEL_ALIASES].sort());
    for (const target of Object.values(CLAUDE_ALIAS_TARGETS)) assert.ok(priceOf(target), target);
    for (const tier of ["judgment", "execution"] as const) {
      const alias = TIER_DEFAULTS[tier].claude.model;
      assert.ok(priceOf(CLAUDE_ALIAS_TARGETS[alias]), alias);
    }
  });

  test("15 · 날짜 스냅숏 접미사만 떼고 단가를 찾는다 — 다른 플랫폼 형식 ID 는 매핑하지 않는다", () => {
    assert.equal(priceOf("claude-haiku-4-5-20251001"), PRICES["claude-haiku-4-5"]);
    assert.deepEqual(priceOf("claude-sonnet-5-5"), { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 });
    assert.deepEqual(priceOf("claude-fable-5"), { input: 10, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 });
    assert.equal(priceOf("anthropic.claude-opus-5-5"), undefined);
    assert.equal(priceOf("claude-opus-4-5@20251101"), undefined);
    assert.equal(priceKey("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
    assert.equal(priceKey("claude-opus-5-5"), "claude-opus-5-5");
  });
});
