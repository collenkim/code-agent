import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { agentKnowledgeAdapter, AGENT_KNOWLEDGE_ACCEPTS, buildQueriesV2, CONFIG_ENV, loadAdapterConfig, producerEnv } from "../agent/plugins/agentKnowledge";
import type { AdapterOptions } from "../agent/plugins/agentKnowledge";
import { INDEXED_REFS, SLOT_OUTPUT_SCHEMA } from "../agent/plugins/protocol";
import {
  ARCH_DOC,
  capabilitiesJson,
  errorJson,
  FAKE_COMMIT,
  FAKE_CONFIG_HASH,
  FAKE_INDEX_ID,
  FAKE_PROJECT,
  fakeAgentKnowledge,
  fakeItem,
  fakeItemV2,
  getJson,
  getV2Json,
  RULES_DOC,
  schemaUpgradeJson,
  searchJson,
  searchV2Json,
  sha256,
  statusV2Json,
} from "./agentKnowledgeFixture";
import type { FakeCall, FakeScenario } from "./agentKnowledgeFixture";

/**
 * agent-knowledge 어댑터의 형식 2 — 협의(capabilities·status 형식 2)·검색 요청 한 번·묶음과 예산·형식 1로 내려가는 조건·
 * 인계 참조의 get 형식 2 정확 조회·자식 환경·전체 마감. 가짜 CLI(agentKnowledgeFixture)가 실제 형식 2 출력과 같은 모양으로 답한다.
 */

let root: string;
let repo: string;
let home: string;
let configPath: string;
let fake: ReturnType<typeof fakeAgentKnowledge>;
let homeBefore: string | undefined;
let envBefore: string | undefined;

const DOCS = [
  { kind: "business-rules", path: RULES_DOC, headings: [] },
  { kind: "architecture", path: ARCH_DOC, headings: [] },
];
const C64 = "c".repeat(64);

function writeConfig(overrides: Record<string, unknown> = {}): void {
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, command: fake.command, projects: [{ root: repo, project: FAKE_PROJECT }], ...overrides }, null, 2));
}

function setup(): void {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-ak2-")));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  homeBefore = process.env.CODE_AGENT_HOME;
  envBefore = process.env[CONFIG_ENV];
  process.env.CODE_AGENT_HOME = home;
  delete process.env[CONFIG_ENV];
  fake = fakeAgentKnowledge(join(root, "fake"));
  configPath = join(root, "adapter.json");
  writeConfig();
}

function teardown(): void {
  if (homeBefore === undefined) delete process.env.CODE_AGENT_HOME;
  else process.env.CODE_AGENT_HOME = homeBefore;
  if (envBefore === undefined) delete process.env[CONFIG_ENV];
  else process.env[CONFIG_ENV] = envBefore;
  rmSync(root, { recursive: true, force: true });
}

type Section = { path: string; heading: string; why: string; ref?: Record<string, unknown> };
interface Reply {
  ok: boolean;
  requestId: string;
  output?: {
    sections?: Section[];
    fallback?: { code: string; message?: string };
    diagnostics?: Record<string, unknown>;
    pinned?: { itemId: string; segmentId?: string; ok: boolean; reason?: string; section?: Section }[];
  };
  error?: string;
}

function call(input: Record<string, unknown> = runInput(), options: Partial<AdapterOptions> = {}): { text: string; reply: Reply } {
  const request = { protocol: "code-agent.plugin", version: "1", op: "run", requestId: "req-run", repoRoot: repo.replace(/\\/g, "/"), slot: "context.docs", sendsCode: false, input };
  const text = agentKnowledgeAdapter(JSON.stringify(request), { args: ["--config", configPath], cwd: repo, ...options });
  return { text, reply: JSON.parse(text) as Reply };
}

function runInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { requirements: [{ key: "R1", text: "환불 금액을 계산한다" }], docs: DOCS, limit: 10, phase: "impact", files: ["src/orders/refund.ts"], ...extra };
}

/** 형식 2를 아는 생산자 — capabilities·status 형식 2·search 형식 2 */
function v2(extra: Partial<FakeScenario> = {}): void {
  fake.scenario({ capabilities: { json: capabilitiesJson() }, statusV2: { json: statusV2Json() }, searchV2: [{ json: searchV2Json() }], ...extra });
}

const isV2 = (entry: FakeCall) => {
  const at = entry.args.indexOf("--response-version");
  return (at >= 0 && entry.args[at + 1] === "2") || (entry.stdin !== "" && (JSON.parse(entry.stdin) as Record<string, unknown>).responseVersion === 2);
};
/** 호출 순서 — 형식 2 호출은 `@2` */
const callList = () => fake.calls().map((entry) => `${entry.command}${isV2(entry) ? "@2" : ""}`);
const bodies = (command: string) => fake.calls().filter((entry) => entry.command === command).map((entry) => JSON.parse(entry.stdin) as Record<string, unknown>);

// ==== 1. 협의 ====

describe("agent-knowledge 어댑터 형식 2 — 협의", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("AV1. auto — capabilities 가 없으면(usage)·search 가 형식 2를 알리지 않으면·DB 가 스키마 2 이전이면 형식 1로 검색한다", () => {
    fake.scenario({ search: [{ json: searchJson() }] });
    const old = call().reply;
    assert.equal(old.ok, true);
    assert.deepEqual(callList(), ["capabilities", "search"]);
    assert.equal(old.output!.diagnostics!.responseVersion, 1);
    assert.deepEqual(old.output!.diagnostics!.fallbackFrom, { responseVersion: 2, reason: "capabilities-missing" });
    assert.equal(old.output!.sections!.length, 1);

    fake.reset();
    fake.scenario({ capabilities: { json: capabilitiesJson({ search: [1] }) }, search: [{ json: searchJson() }] });
    const v1Only = call().reply;
    assert.deepEqual(callList(), ["capabilities", "search"], "status 형식 2도 부르지 않는다");
    assert.deepEqual(v1Only.output!.diagnostics!.fallbackFrom, { responseVersion: 2, reason: "response-version-2-not-offered" });

    fake.reset();
    fake.scenario({ capabilities: { json: capabilitiesJson({ get: [1] }) }, search: [{ json: searchJson() }] });
    call();
    assert.deepEqual(callList(), ["capabilities", "search"], "get 이 형식 1뿐이어도 같다");

    fake.reset();
    fake.scenario({ capabilities: { json: capabilitiesJson() }, statusV2: { exit: 5, json: schemaUpgradeJson("status") }, search: [{ json: searchJson() }] });
    const upgrade = call().reply;
    assert.equal(upgrade.ok, true);
    assert.deepEqual(callList(), ["capabilities", "status@2", "search"]);
    assert.deepEqual(upgrade.output!.diagnostics!.fallbackFrom, { responseVersion: 2, reason: "schema-upgrade-required" });
    assert.deepEqual(fake.calls()[1].args, ["--response-version", "2"], "status 는 본문 없이 --response-version 2");
  });

  test("AV2. responseVersion 1 — capabilities 를 부르지 않고, 설정한 순위 방식·조각은 싣지 못한 기능으로 남긴다", () => {
    writeConfig({ responseVersion: 1, retrieval: { ranker: "bm25", segments: true } });
    v2({ search: [{ json: searchJson() }] });
    const { reply } = call();
    assert.equal(reply.ok, true);
    assert.deepEqual(callList(), ["search"]);
    assert.equal(reply.output!.diagnostics!.responseVersion, 1);
    assert.equal(reply.output!.diagnostics!.fallbackFrom, undefined);
    assert.deepEqual(reply.output!.diagnostics!.featuresDropped, ["ranker", "segments"]);
    assert.deepEqual(Object.keys(bodies("search")[0]).sort(), ["limit", "profile", "query", "scope", "task"], "형식 1 요청에 형식 2 필드를 싣지 않는다");

    // 기본값과 같은 설정(legacy·조각 끔)은 잃은 기능이 아니다
    writeConfig({ responseVersion: 1, retrieval: { ranker: "legacy", segments: false } });
    assert.equal(call().reply.output!.diagnostics!.featuresDropped, undefined);
  });

  test("AV3. responseVersion 2 — 형식 2를 못 쓰면 형식 1로 내려가지 않고 response-version-unavailable", () => {
    writeConfig({ responseVersion: 2 });
    const cases: [string, FakeScenario, string[]][] = [
      ["capabilities 없음", { search: [{ json: searchJson() }] }, ["capabilities"]],
      ["search 형식 1뿐", { capabilities: { json: capabilitiesJson({ search: [1] }) }, search: [{ json: searchJson() }] }, ["capabilities"]],
      ["스키마 2 이전 DB", { capabilities: { json: capabilitiesJson() }, statusV2: { exit: 5, json: schemaUpgradeJson("status") } }, ["capabilities", "status@2"]],
      [
        "search 가 형식 2를 모름",
        { capabilities: { json: capabilitiesJson() }, statusV2: { json: statusV2Json() }, search: [{ json: searchJson() }] },
        ["capabilities", "status@2", "search@2"],
      ],
    ];
    for (const [label, scenario, expected] of cases) {
      fake.reset();
      fake.scenario(scenario);
      const { reply } = call();
      assert.equal(reply.ok, false, label);
      assert.match(reply.error ?? "", /^response-version-unavailable: agent-knowledge 형식 2를 쓸 수 없습니다/, label);
      assert.deepEqual(callList(), expected, label);
    }
  });

  test("AV4. capabilities·status 형식 2의 다른 실패는 형식 1로 덮지 않고 그대로 실패다", () => {
    const cases: [string, FakeScenario, string][] = [
      ["capabilities JSON 아님", { capabilities: { stdout: "boom" }, search: [{ json: searchJson() }] }, "invalid-json"],
      ["capabilities 구조 다름", { capabilities: { json: { ...capabilitiesJson(), commands: "x" } }, search: [{ json: searchJson() }] }, "invalid-response"],
      [
        "status 색인 없음",
        { capabilities: { json: capabilitiesJson() }, statusV2: { exit: 5, json: errorJson("status", "index-missing", "게시된 색인이 없습니다", { reason: "no-generation" }) } },
        "index-missing",
      ],
      ["status 형식 1로 답함", { capabilities: { json: capabilitiesJson() }, statusV2: { json: { ...statusV2Json(), schemaVersion: 1 } } }, "unsupported-version"],
    ];
    for (const [label, scenario, code] of cases) {
      fake.reset();
      fake.scenario(scenario);
      const { reply } = call();
      assert.equal(reply.ok, false, label);
      assert.ok(reply.error?.startsWith(`${code}: `), `${label}: ${reply.error}`);
      assert.ok(!callList().includes("search"), `${label}: 형식 1 검색으로 내려가지 않는다`);
      assert.equal(reply.requestId, "req-run");
    }
  });
});

// ==== 2. 형식 2 검색 요청 ====

describe("agent-knowledge 어댑터 형식 2 — 검색 요청", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("AV5. 질의 묶음 한 번 — 요구 키·문서 필터·필수 제외·예산·색인 고정, 순위 방식·조각은 설정했을 때만", () => {
    v2();
    const requirements = [
      { key: "R1", text: "환불 금액을 계산한다" },
      { key: "bad key!", text: "취소 기간" },
      { key: "R1", text: "재고" },
      { key: "q2", text: "포인트" },
    ];
    const { reply } = call(runInput({ requirements, docs: [...DOCS, { kind: "x", path: "../outside.md" }] }));
    assert.equal(reply.ok, true);
    assert.deepEqual(callList(), ["capabilities", "status@2", "search@2"]);
    assert.deepEqual(fake.calls()[0].args, []);
    assert.deepEqual(fake.calls()[2].args, ["--request", "-"], "형식은 본문으로만 — 요청과 다른 --response-version 은 usage 다");
    assert.deepEqual(bodies("search")[0], {
      responseVersion: 2,
      profile: "code",
      // 키 규칙에 맞고 처음 쓰는 요구 키만 질의 키로. 글만 보낸 질의의 자동 키(q<위치>)가 다른 키와 겹치면 직접 붙인다
      queries: [{ key: "R1", text: "환불 금액을 계산한다" }, { key: "q2-1", text: "취소 기간" }, "재고", { key: "q2", text: "포인트" }],
      overflow: "truncate",
      scope: { projects: ["orders"] },
      filters: { documents: [RULES_DOC, ARCH_DOC] },
      include: { mandatory: false },
      task: { phase: "impact", paths: ["src/orders/refund.ts"] },
      limit: 20,
      budget: { maxItems: 20, maxResponseBytes: 8_388_608 - 65_536 },
      version: { generation: 2, indexId: FAKE_INDEX_ID, exact: true },
    });

    // 순위 방식·조각 — 최상위 값 위에 프로젝트 값을 키마다 덮는다
    writeConfig({ retrieval: { ranker: "bm25", segments: true }, projects: [{ root: repo, project: FAKE_PROJECT, retrieval: { segments: false } }], limits: { maxOutputBytes: 65_536 } });
    fake.reset();
    call();
    const tuned = bodies("search")[0];
    assert.equal(tuned.ranker, "bm25");
    assert.equal(tuned.segments, false);
    assert.deepEqual(tuned.budget, { maxItems: 20, maxResponseBytes: 4096 }, "예산 하한 4096");

    writeConfig({ projects: [{ root: repo, project: FAKE_PROJECT, retrieval: { segments: true } }] });
    fake.reset();
    call();
    assert.equal(bodies("search")[0].ranker, undefined);
    assert.equal(bodies("search")[0].segments, true);
  });

  test("AV6. 생산자 상한·알린 기능 — 질의 수·길이는 설정과 capabilities 중 작은 값, 알리지 않은 기능은 싣지 않는다", () => {
    v2({ capabilities: { json: capabilitiesJson({ queryLimits: { maxQueries: 2, maxQueryChars: 50 }, rankers: false, segments: false }) } });
    writeConfig({ retrieval: { ranker: "bm25", segments: true } });
    const requirements = ["환불", "취소", "재고", "포인트", `배송 ${"가".repeat(80)}`].map((text, index) => ({ key: `R${index + 1}`, text }));
    const { reply } = call(runInput({ requirements }));
    const body = bodies("search")[0];
    assert.deepEqual(body.queries, ["환불 취소", `재고 포인트 배송 ${"가".repeat(40)}`], "묶은 질의는 키 없이(q<위치>), 질의 길이는 50자까지");
    assert.equal(body.ranker, undefined);
    assert.equal(body.segments, undefined);
    assert.deepEqual(reply.output!.diagnostics!.featuresDropped, ["ranker", "segments"]);
    assert.equal(reply.output!.diagnostics!.bundled, 2);
    assert.equal(reply.output!.diagnostics!.queryChars, 40);

    assert.deepEqual(buildQueriesV2([{ key: "q1", text: "a" }, { key: "x y", text: "b" }, { key: "q1", text: "c" }], { maxQueries: 4, queryChars: 400 }).queries, [
      { key: "q1", text: "a" },
      "b",
      "c",
    ]);
  });

  test("AV7. 활성 세대가 없는 DB 는 세대를 고정하지 않는다 · 입력 문서가 없으면 문서 필터도 없다", () => {
    v2({ statusV2: { json: statusV2Json({ activeGeneration: null }) }, searchV2: [{ exit: 5, json: errorJson("search", "index-missing", "게시된 세대가 없습니다", { reason: "no-generation" }) }] });
    const { reply } = call(runInput({ docs: [] }));
    const body = bodies("search")[0];
    assert.equal(body.version, undefined);
    assert.equal(body.filters, undefined);
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", /^index-missing: /);
    assert.deepEqual(callList(), ["capabilities", "status@2", "search@2"], "형식 1로 다시 묻지 않는다");
  });
});

// ==== 3. 결과 ====

describe("agent-knowledge 어댑터 형식 2 — 묶음·결과·대체 사유", () => {
  beforeEach(setup);
  afterEach(teardown);

  const architecture = (extra: Record<string, unknown> = {}) =>
    fakeItemV2({ path: ARCH_DOC, key: null, anchor: "저장소-1", title: "저장소", unit: "section", kind: "architecture", startLine: 9, endLine: 11, reasons: ["keyword-match"], rank: 3, declaredStatus: null, reason: "status-not-declared", ...extra });

  test("AV8. 정상 — direct 묶음만 섹션이 되고, 참조에 DB 식별·핸들, 진단에 재현 식별값을 남긴다", () => {
    const rule = fakeItemV2({ rank: 2 });
    const items = [
      fakeItemV2({ group: "mandatory", key: "BR-001", anchor: "BR-001", startLine: 7, endLine: 15, section: "mandatory", reasons: ["mandatory"], rank: 1 }),
      rule,
      fakeItemV2({ group: "linked", key: "BR-020", anchor: "BR-020", reasons: [`linked:code:orders:${RULES_DOC}#BR-002`], rank: 4 }),
      architecture(),
    ];
    v2({ searchV2: [{ json: searchV2Json({ items, limitations: ["keyword-only", "unconfirmed-results"] }) }] });
    const { text, reply } = call();
    assert.equal(reply.ok, true, reply.error);
    assert.ok(SLOT_OUTPUT_SCHEMA["context.docs"].safeParse(reply.output).success);
    const sections = reply.output!.sections!;
    assert.deepEqual(sections.map((section) => [section.path, section.heading, section.why]), [
      [RULES_DOC, "`BR-002` 환불 금액 계산", "agent-knowledge path-overlap·keyword-match"],
      [ARCH_DOC, "저장소", "agent-knowledge keyword-match"],
    ]);
    assert.deepEqual(sections[0].ref, {
      engine: "agent-knowledge",
      itemId: `orders:${RULES_DOC}#BR-002`,
      projectId: "orders",
      sourceId: "orders",
      generation: 2,
      commit: FAKE_COMMIT,
      blobSha: "4421403ced47d7719670d8f019d3032eccdad7dd",
      documentSha256: sha256(`document:${RULES_DOC}`),
      itemSha256: sha256(`item:${RULES_DOC}#BR-002`),
      startLine: 17,
      endLine: 22,
      unit: "entry",
      kind: "business-rule",
      status: "unverified",
      confirmed: false,
      declaredStatus: "confirmed_policy",
      reason: "status-basis-missing",
      indexId: FAKE_INDEX_ID,
      handle: (rule.ref as Record<string, unknown>).handle,
    });
    for (const leaked of ["결제 금액에서", "excerpt", "content", "links", "applicability", "operations"]) assert.ok(!text.includes(leaked), leaked);
    assert.deepEqual(
      { ...reply.output!.diagnostics!, durationMs: 0 },
      {
        engine: "agent-knowledge",
        schemaVersion: 1,
        project: "orders",
        indexId: FAKE_INDEX_ID,
        queries: 1,
        requirements: 1,
        bundled: 0,
        queryChars: 0,
        requestLimit: 20,
        generation: 2,
        commits: { orders: FAKE_COMMIT },
        versions: { parser: "md-2", chunker: "chunk-2", tokenizer: "tok-1", resolver: "resolve-1" },
        configHash: FAKE_CONFIG_HASH,
        ranker: { name: "legacy", version: "keyword-legacy-1" },
        queryVersion: "query-2",
        segments: false,
        outcome: "matched",
        digests: { request: sha256("digest:request"), result: sha256("digest:result") },
        budget: { truncated: false, omittedCount: 0 },
        directCount: 2,
        returned: 2,
        dropped: { mandatory: 1, linked: 1, otherProject: 0, outOfDocs: 0, invalid: 0, deprecated: 0 },
        limitations: ["keyword-only", "unconfirmed-results"],
        responseVersion: 2,
        calls: 3,
        durationMs: 0,
      },
    );
  });

  test("AV9. 참조 일관성 — DB 식별·세대·항목 ID·커밋·조각이 어긋난 항목은 버리고, 64자리 커밋은 받는다", () => {
    const item = (key: string, extra: Record<string, unknown> = {}) => fakeItemV2({ key, anchor: key, ...extra });
    const items = [
      item("BR-010", { ref: { indexId: "0".repeat(32) } }),
      item("BR-011", { ref: { indexGeneration: 1 } }),
      item("BR-012", { ref: { itemId: `orders:${RULES_DOC}#OTHER` } }),
      item("BR-013", { ref: { commit: "1".repeat(40) } }),
      item("BR-014", { segment: { startLine: 18, endLine: 20 } }),
      item("BR-015", { ref: { itemSha256: "f".repeat(64) } }),
      item("BR-016", { ref: { startLine: 1 } }),
      item("BR-002"),
      item("BR-002"),
    ];
    v2({ searchV2: [{ json: searchV2Json({ items }) }] });
    const { reply } = call();
    assert.deepEqual(reply.output!.sections!.map((section) => section.ref?.itemId), [`orders:${RULES_DOC}#BR-002`]);
    assert.equal((reply.output!.diagnostics!.dropped as Record<string, number>).invalid, 8, "조각 점수를 켜지 않은 요청의 조각 결과·같은 항목 두 번도 버린다");

    // SHA-256 저장소 — 커밋 64자리
    v2({ searchV2: [{ json: searchV2Json({ items: [item("BR-002", { commit: C64 })], commit: C64 }) }] });
    const sha256Repo = call().reply;
    assert.equal(sha256Repo.output!.sections![0].ref?.commit, C64);
  });

  test("AV10. 조각 — 조각 점수를 켜면 조각 결과의 참조에 조각 식별·해시·줄 범위를 싣는다", () => {
    writeConfig({ retrieval: { segments: true } });
    const segmented = fakeItemV2({ key: "BR-003", anchor: "BR-003", startLine: 17, endLine: 33, segment: { startLine: 25, endLine: 29 } });
    const outside = fakeItemV2({ key: "BR-004", anchor: "BR-004", startLine: 40, endLine: 44, segment: { startLine: 30, endLine: 41 } });
    v2({ searchV2: [{ json: searchV2Json({ items: [segmented, outside], segments: true }) }] });
    const { reply } = call();
    const ref = reply.output!.sections![0].ref!;
    assert.equal(ref.segmentId, `orders:${RULES_DOC}#BR-003#2`);
    assert.equal(ref.segmentSha256, sha256(`segment:orders:${RULES_DOC}#BR-003#2`));
    assert.deepEqual([ref.startLine, ref.endLine, ref.segmentStartLine, ref.segmentEndLine], [17, 33, 25, 29]);
    assert.equal(reply.output!.sections!.length, 1, "항목 범위 밖의 조각은 버린다");
    assert.equal(reply.output!.diagnostics!.segments, true);
    assert.equal(bodies("search")[0].segments, true);
  });

  test("AV11. 대체 사유 — no-results·supplementary-only·budget-truncated·no-usable-items·no-query", () => {
    v2({ searchV2: [{ exit: 3, json: searchV2Json({ items: [] }) }] });
    const none = call().reply;
    assert.equal(none.ok, true);
    assert.equal(none.output!.fallback?.code, "no-results");
    assert.equal(none.output!.diagnostics!.outcome, "no-results");

    v2({ searchV2: [{ json: searchV2Json({ items: [fakeItemV2({ group: "dependencies", key: "BR-030", anchor: "BR-030", reasons: ["dependency"] })] }) }] });
    const supplementary = call().reply;
    assert.equal(supplementary.output!.fallback?.code, "supplementary-only");
    assert.equal((supplementary.output!.diagnostics!.dropped as Record<string, number>).linked, 1);

    v2({ searchV2: [{ json: searchV2Json({ items: [], outcome: "matched", status: "ok", truncated: true, omittedCount: 3, limitations: ["budget-truncated", "direct-crowded-out"] }) }] });
    const crowded = call().reply;
    assert.equal(crowded.output!.fallback?.code, "budget-truncated");
    assert.deepEqual(crowded.output!.diagnostics!.budget, { truncated: true, omittedCount: 3 });
    assert.deepEqual(crowded.output!.diagnostics!.limitations, ["budget-truncated", "direct-crowded-out"]);

    // 일부만 빠지면 남은 것을 쓴다
    v2({ searchV2: [{ json: searchV2Json({ items: [fakeItemV2(), fakeItemV2({ key: "B-1", anchor: "B-1", projectId: "billing", sourceId: "billing" })], truncated: true, omittedCount: 2 }) }] });
    const partial = call().reply;
    assert.equal(partial.output!.fallback, undefined);
    assert.equal(partial.output!.sections!.length, 1);
    assert.equal((partial.output!.diagnostics!.dropped as Record<string, number>).otherProject, 1);

    v2({ searchV2: [{ json: searchV2Json({ items: [fakeItemV2({ path: "doc/decisions/x.md", key: null, anchor: "결정", title: "결정" }), fakeItemV2({ status: "deprecated" })] }) }] });
    const unusable = call().reply;
    assert.equal(unusable.output!.fallback?.code, "no-usable-items");
    assert.deepEqual(unusable.output!.diagnostics!.dropped, { mandatory: 0, linked: 0, otherProject: 0, outOfDocs: 1, invalid: 0, deprecated: 1 });

    fake.reset();
    const empty = call(runInput({ requirements: [{ key: "R1", text: "  " }] })).reply;
    assert.equal(empty.output!.fallback?.code, "no-query");
    assert.equal(empty.output!.diagnostics!.responseVersion, null);
    assert.deepEqual(fake.calls(), [], "참조도 질의도 없으면 아무것도 부르지 않는다");
  });

  test("AV12. 형식 2를 모른다는 답에서만 형식 1로 다시 검색한다 — 색인 식별·세대·커밋·범위 오류는 그대로 실패다", () => {
    const recover: [string, Record<string, unknown>, number][] = [
      ["unsupported-response-version", errorJson("search", "invalid-request", "지원하지 않는 응답 형식입니다", { reason: "unsupported-response-version" }), 2],
      ["response-version-2-required", errorJson("search", "invalid-request", "이 필드는 responseVersion 2 요청에서만 쓸 수 있습니다", { reason: "response-version-2-required", fields: ["budget"] }), 2],
      ["schema-upgrade-required", schemaUpgradeJson("search"), 5],
    ];
    for (const [reason, json, exit] of recover) {
      fake.reset();
      v2({ searchV2: [{ exit, json }], search: [{ json: searchJson() }] });
      const { reply } = call();
      assert.equal(reply.ok, true, reason);
      assert.deepEqual(callList(), ["capabilities", "status@2", "search@2", "search"], reason);
      assert.equal(reply.output!.diagnostics!.responseVersion, 1, reason);
      assert.deepEqual(reply.output!.diagnostics!.fallbackFrom, { responseVersion: 2, reason }, reason);
      assert.equal(reply.output!.diagnostics!.configHash, undefined, `${reason}: 형식 2 진단을 섞지 않는다`);
      assert.equal(reply.output!.sections!.length, 1);
    }
    const stop: [string, number, Record<string, unknown>][] = [
      ["index-missing", 5, { reason: "index-id-mismatch" }],
      ["index-missing", 5, { reason: "generation-not-found" }],
      ["index-missing", 5, { reason: "commit-not-in-generation" }],
      ["invalid-scope", 4, { reason: "unknown-project" }],
      ["invalid-request", 2, { reason: "invalid-document" }],
      ["invalid-request", 2, { issues: [] }],
    ];
    for (const [code, exit, detail] of stop) {
      fake.reset();
      v2({ searchV2: [{ exit, json: errorJson("search", code, "x", detail) }], search: [{ json: searchJson() }] });
      const { reply } = call();
      assert.equal(reply.ok, false, JSON.stringify(detail));
      assert.ok(reply.error?.startsWith(`${code}: `), reply.error);
      assert.deepEqual(callList(), ["capabilities", "status@2", "search@2"], `${JSON.stringify(detail)}: 형식 1로 다시 묻지 않는다`);
    }
    // 고정한 색인과 다른 응답은 쓰지 않는다
    fake.reset();
    v2({ searchV2: [{ json: searchV2Json({ indexId: "0".repeat(32) }) }] });
    assert.match(call().reply.error ?? "", /^invalid-response: .*고정한 색인/);
  });
});

// ==== 4. 인계 참조 ====

describe("agent-knowledge 어댑터 형식 2 — 인계 참조(get 형식 2)", () => {
  beforeEach(setup);
  afterEach(teardown);

  const id = (key: string) => `orders:${RULES_DOC}#${key}`;
  const v1Ref = (key: string, extra: Record<string, unknown> = {}) => ({ itemId: id(key), generation: 2, commit: FAKE_COMMIT, itemSha256: sha256(`item:${RULES_DOC}#${key}`), required: true, ...extra });
  const v2Ref = (key: string, extra: Record<string, unknown> = {}) => v1Ref(key, { indexId: FAKE_INDEX_ID, sourceId: "orders", path: RULES_DOC, startLine: 17, endLine: 22, ...extra });
  const error = (code: string, reason: string, exit: number) => ({ exit, json: errorJson("get", code, "x", { reason }) });
  const ok = (key: string, extra: Record<string, unknown> = {}) => ({ json: getV2Json(fakeItemV2({ key, anchor: key, ...extra })) });

  test("AV13. 정확 조회 — 세대·DB 식별·원본 커밋 고정과 기대 해시, 오류는 사유로, 형식 1 get 으로 다시 묻지 않는다", () => {
    const segment = fakeItemV2({ key: "BR-003", anchor: "BR-003", startLine: 17, endLine: 33, segment: { startLine: 25, endLine: 29 } });
    const segmentRef = (segment.ref as Record<string, unknown>);
    v2({
      get: { [`${id("BR-002")}@2`]: { json: getJson(fakeItem()) } },
      getV2: [
        { id: id("BR-002"), match: { version: { indexId: FAKE_INDEX_ID } }, reply: ok("BR-002") },
        { id: id("BR-001"), reply: error("invalid-request", "hash-mismatch", 2) },
        { id: id("BR-004"), reply: error("index-missing", "index-id-mismatch", 5) },
        { id: id("BR-005"), reply: error("index-missing", "generation-not-found", 5) },
        { id: id("BR-006"), reply: error("index-missing", "commit-not-in-generation", 5) },
        { id: id("BR-007"), reply: { exit: 4, json: errorJson("get", "invalid-scope", "등록되지 않은 원본입니다", { reason: "unknown-source" }) } },
        { id: `${id("BR-003")}#2`, match: { expect: { segmentSha256: segmentRef.segmentSha256 } }, reply: { json: getV2Json(segment) } },
        { id: id("BR-003"), reply: ok("BR-003", { startLine: 17, endLine: 33 }) },
        { id: id("BR-008"), reply: ok("BR-008") },
        { id: id("BR-009"), reply: { json: getV2Json(fakeItemV2({ key: "BR-009", anchor: "BR-009" }), 2, "e".repeat(32)) } },
        { id: id("BR-002"), reply: ok("BR-002") },
      ],
    });
    const segmentPinned = { itemId: id("BR-003"), generation: 2, commit: FAKE_COMMIT, itemSha256: segmentRef.itemSha256, required: true, indexId: FAKE_INDEX_ID, segmentId: segmentRef.segmentId, segmentSha256: segmentRef.segmentSha256, segmentStartLine: 25, segmentEndLine: 29 };
    const refs = [
      v2Ref("BR-002"),
      v2Ref("BR-001"),
      v2Ref("BR-004"),
      v2Ref("BR-005"),
      v2Ref("BR-006"),
      v2Ref("BR-999"),
      v2Ref("BR-007"),
      segmentPinned,
      v1Ref("BR-003", { itemSha256: segmentRef.itemSha256 }),
      { ...segmentPinned, required: false },
      v2Ref("BR-008", { startLine: 18 }),
      v2Ref("BR-009"),
      { ...segmentPinned, itemId: id("BR-010"), segmentSha256: undefined },
      v1Ref("BR-002", { generation: 2, required: false, itemId: id("BR-002") }),
    ];
    const { reply } = call(runInput({ refs }));
    assert.equal(reply.ok, true, reply.error);
    assert.ok(SLOT_OUTPUT_SCHEMA["context.docs"].safeParse(reply.output).success);
    const pinned = reply.output!.pinned!;
    assert.deepEqual(pinned.map((entry) => [entry.itemId, entry.segmentId, entry.ok, entry.reason]), [
      [id("BR-002"), undefined, true, undefined],
      [id("BR-001"), undefined, false, "hash-mismatch"],
      [id("BR-004"), undefined, false, "index-mismatch"],
      [id("BR-005"), undefined, false, "generation-expired"],
      [id("BR-006"), undefined, false, "commit-mismatch"],
      [id("BR-999"), undefined, false, "not-found"],
      [id("BR-007"), undefined, false, "out-of-scope"],
      [id("BR-003"), segmentRef.segmentId, true, undefined],
      [id("BR-003"), undefined, true, undefined],
      [id("BR-003"), segmentRef.segmentId, false, "invalid-ref"],
      [id("BR-008"), undefined, false, "range-mismatch"],
      [id("BR-009"), undefined, false, "index-mismatch"],
      [id("BR-010"), `${id("BR-003")}#2`, false, "invalid-ref"],
      [id("BR-002"), undefined, false, "invalid-ref"],
    ]);
    const getBodies = bodies("get");
    assert.deepEqual(getBodies[0], {
      responseVersion: 2,
      id: id("BR-002"),
      profile: "code",
      scope: { projects: ["orders"] },
      version: { generation: 2, indexId: FAKE_INDEX_ID, exact: true, commits: { orders: FAKE_COMMIT } },
      expect: { itemSha256: sha256(`item:${RULES_DOC}#BR-002`) },
    });
    const segmentBody = getBodies.find((body) => body.id === segmentRef.segmentId)!;
    assert.deepEqual(segmentBody.expect, { itemSha256: segmentRef.itemSha256, segmentSha256: segmentRef.segmentSha256 }, "조각 참조는 조각 식별로 묻고 조각 해시도 기대한다");
    const plain = getBodies.find((body) => body.id === id("BR-003"))!;
    assert.deepEqual(plain.version, { generation: 2, exact: true, commits: { orders: FAKE_COMMIT } }, "색인 식별이 없는 참조는 세대·커밋만 고정한다");
    assert.ok(fake.calls().filter((entry) => entry.command === "get").every(isV2), "형식 1 get 으로 다시 묻지 않는다");

    const section = pinned[0].section!;
    assert.equal(section.ref?.pinned, true);
    assert.equal(section.ref?.indexId, FAKE_INDEX_ID);
    assert.match(String(section.ref?.handle), /^ak-[0-9a-f]{20}$/);
    const segmentSection = pinned[7].section!;
    assert.deepEqual(
      [segmentSection.ref?.segmentId, segmentSection.ref?.segmentSha256, segmentSection.ref?.segmentStartLine, segmentSection.ref?.segmentEndLine],
      [segmentRef.segmentId, segmentRef.segmentSha256, 25, 29],
    );
    assert.equal(pinned[8].section?.ref?.segmentId, undefined, "같은 항목의 원본 참조는 조각 필드 없이");
    assert.deepEqual(reply.output!.diagnostics!.refs, {
      requested: 14,
      ok: 3,
      failed: { "hash-mismatch": 1, "index-mismatch": 2, "generation-expired": 1, "commit-mismatch": 1, "not-found": 1, "out-of-scope": 1, "invalid-ref": 3, "range-mismatch": 1 },
    });
    assert.deepEqual(callList().slice(0, 2), ["capabilities", "status@2"], "협의가 인계 참조보다 먼저");
    assert.equal(callList()[callList().length - 1], "search@2", "인계 참조 뒤에 검색");
  });

  test("AV14. 형식 2를 쓸 수 없으면 색인 식별·조각 참조는 identity-unverifiable — 형식 1 get 으로 확인했다고 하지 않는다", () => {
    const segmentRef = v2Ref("BR-003", { segmentId: `${id("BR-003")}#2`, segmentSha256: sha256("s"), path: undefined, startLine: undefined, endLine: undefined });
    fake.scenario({ search: [{ json: searchJson() }], get: { [`${id("BR-002")}@2`]: { json: getJson(fakeItem()) } } });
    const refs = [v2Ref("BR-005"), segmentRef, v1Ref("BR-002"), v1Ref("BR-006", { commit: C64 })];
    const { reply } = call(runInput({ refs }));
    assert.deepEqual(reply.output!.pinned!.map((entry) => [entry.segmentId, entry.ok, entry.reason]), [
      [undefined, false, "identity-unverifiable"],
      [`${id("BR-003")}#2`, false, "identity-unverifiable"],
      [undefined, true, undefined],
      [undefined, false, "not-found"],
    ]);
    assert.deepEqual(bodies("get").map((body) => body.id), [id("BR-002"), id("BR-006")], "형식 1 모양 참조만 형식 1 get 으로(64자리 커밋도 받는다)");
    assert.equal(reply.output!.pinned![2].section?.ref?.indexId, undefined);

    // get 이 형식 2를 모른다고 답하면 — auto 는 형식 1 get(형식 1 모양 참조만)과 형식 1 검색으로 내려간다
    fake.reset();
    fake.scenario({
      capabilities: { json: capabilitiesJson() },
      statusV2: { json: statusV2Json() },
      search: [{ json: searchJson() }],
      get: { [`${id("BR-002")}@2`]: { json: getJson(fakeItem()) } },
    });
    const downgraded = call(runInput({ refs: [v1Ref("BR-002"), v2Ref("BR-005")] })).reply;
    assert.deepEqual(downgraded.output!.pinned!.map((entry) => [entry.ok, entry.reason]), [[true, undefined], [false, "identity-unverifiable"]]);
    assert.deepEqual(callList(), ["capabilities", "status@2", "get@2", "get", "search"]);
    assert.deepEqual(downgraded.output!.diagnostics!.fallbackFrom, { responseVersion: 2, reason: "unsupported-response-version" });

    // responseVersion 2 — 내려가지 않는다
    writeConfig({ responseVersion: 2 });
    fake.reset();
    const strict = call(runInput({ refs: [v1Ref("BR-002")] })).reply;
    assert.equal(strict.ok, true);
    assert.deepEqual(strict.output!.pinned!.map((entry) => entry.reason), ["response-version-unavailable"]);
    assert.equal(strict.output!.fallback?.code, "response-version-unavailable");
    assert.deepEqual(callList(), ["capabilities", "status@2", "get@2", "search@2"]);
  });

  test("AV15. 협의가 실패하면 인계 참조도 같은 사유로 실패한다(형식·상한 검사는 그대로)", () => {
    fake.scenario({ capabilities: { stdout: "boom" } });
    const { reply } = call(runInput({ refs: [v1Ref("BR-002"), { itemId: "x" }] }));
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.output!.pinned!.map((entry) => entry.reason), ["invalid-json", "invalid-ref"]);
    assert.equal(reply.output!.fallback?.code, "invalid-json");
    assert.equal(reply.output!.diagnostics!.negotiationError, "invalid-json");
    assert.deepEqual(callList(), ["capabilities"]);
  });
});

// ==== 5. 자식 환경·마감·describe ====

describe("agent-knowledge 어댑터 형식 2 — 자식 환경·전체 마감·describe", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("AV16. 자식 프로세스에 AGENT_KNOWLEDGE_* 를 넘기지 않는다 (PATH 등은 그대로)", () => {
    const parent = { ...process.env, AGENT_KNOWLEDGE_DB: join(root, "other.sqlite"), agent_knowledge_config: "x.yaml", AGENT_KNOWLEDGE_RETRIEVAL_CONFIG: "y.yaml", CODE_AGENT_KNOWLEDGE_CONFIG: "z" };
    const child = producerEnv(parent);
    assert.equal(child.AGENT_KNOWLEDGE_DB, undefined);
    assert.equal(child.agent_knowledge_config, undefined);
    assert.equal(child.AGENT_KNOWLEDGE_RETRIEVAL_CONFIG, undefined);
    assert.equal(child.CODE_AGENT_KNOWLEDGE_CONFIG, "z", "어댑터 자신의 설정 변수는 생산자 변수가 아니다");
    assert.ok(Object.keys(child).some((key) => key.toUpperCase() === "PATH"));

    // 가짜는 받은 생산자 변수를 기록한다 — 직접 넘기면 보인다
    const direct = spawnSync(process.execPath, [fake.command[1], "status"], { env: parent, encoding: "utf-8" });
    assert.equal(direct.status, 2);
    assert.deepEqual(fake.calls()[0].env?.sort(), ["AGENT_KNOWLEDGE_DB", "AGENT_KNOWLEDGE_RETRIEVAL_CONFIG", "agent_knowledge_config"].sort());
    fake.reset();

    v2({ getV2: [{ id: `orders:${RULES_DOC}#BR-002`, reply: { json: getV2Json(fakeItemV2()) } }] });
    const { reply } = call(runInput({ refs: [{ itemId: `orders:${RULES_DOC}#BR-002`, generation: 2, commit: FAKE_COMMIT, itemSha256: sha256(`item:${RULES_DOC}#BR-002`), required: true }] }), { env: parent });
    assert.equal(reply.ok, true, reply.error);
    assert.deepEqual(callList(), ["capabilities", "status@2", "get@2", "search@2"]);
    assert.ok(fake.calls().every((entry) => entry.env === undefined), JSON.stringify(fake.calls().map((entry) => entry.env)));
  });

  test("AV17. 전체 마감 — 협의·인계 참조·형식 2 검색·형식 1 대체 호출이 한 마감을 나눠 쓴다", () => {
    v2({ searchV2: [{ exit: 2, json: errorJson("search", "invalid-request", "x", { reason: "unsupported-response-version" }) }], search: [{ json: searchJson() }] });
    // 가짜 시계 — 호출 한 번에 6초(마감 15초): capabilities·status·search 형식 2 뒤에는 형식 1 검색을 시작할 여유가 없다
    const now = () => 1_000_000 + fake.calls().length * 6000;
    const { reply } = call(runInput(), { now, deadlineMs: 15_000 });
    assert.equal(reply.ok, false);
    assert.match(reply.error ?? "", /^timeout: 전체 마감 15초에 닿아 agent-knowledge search 를 부르지 않았습니다/);
    assert.deepEqual(callList(), ["capabilities", "status@2", "search@2"]);

    fake.reset();
    const none = call(runInput(), { deadlineMs: 0 }).reply;
    assert.match(none.error ?? "", /^timeout: 전체 마감/);
    assert.deepEqual(fake.calls(), [], "capabilities 도 마감 안에서만");
  });

  test("AV18. describe·설정 — accepts 에 색인 식별 참조, 설정은 responseVersion·retrieval 만 더 받는다", () => {
    assert.ok((AGENT_KNOWLEDGE_ACCEPTS as readonly string[]).includes(INDEXED_REFS));
    const loaded = loadAdapterConfig(configPath);
    assert.ok(loaded.ok);
    assert.equal(loaded.config.responseVersion, "auto");
    assert.equal(loaded.config.projects[0].retrieval, undefined);
    writeConfig({ responseVersion: 2, retrieval: { ranker: "bm25" }, projects: [{ root: repo, project: FAKE_PROJECT, retrieval: { segments: true } }] });
    const tuned = loadAdapterConfig(configPath);
    assert.ok(tuned.ok);
    assert.equal(tuned.config.responseVersion, 2);
    assert.deepEqual(tuned.config.projects[0].retrieval, { ranker: "bm25", segments: true });
    for (const bad of [{ responseVersion: 3 }, { responseVersion: "2" }, { retrieval: { ranker: "vector" } }, { retrieval: { segments: "yes" } }, { retrieval: { extra: 1 } }]) {
      writeConfig(bad);
      const result = loadAdapterConfig(configPath);
      assert.ok(!result.ok, JSON.stringify(bad));
      assert.equal(result.code, "adapter-config-invalid");
    }
  });
});
