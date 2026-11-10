import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { packageVersion } from "../agent/assets";
import { decide } from "../agent/hook";
import {
  agentKnowledgeAdapter,
  AGENT_KNOWLEDGE_ACCEPTS,
  buildQueries,
  CONFIG_ENV,
  CONFIG_FILE,
  loadAdapterConfig,
  normalizeRoot,
} from "../agent/plugins/agentKnowledge";
import type { AdapterOptions } from "../agent/plugins/agentKnowledge";
import { pluginList, registerPlugin } from "../agent/plugins/commands";
import { DESCRIBE_SCHEMA, PROBE_SCHEMA, SLOT_OUTPUT_SCHEMA } from "../agent/plugins/protocol";
import type { DescribeOutput } from "../agent/plugins/protocol";
import * as run from "../agent/plugins/run";
import * as store from "../agent/plugins/store";
import {
  ARCH_DOC,
  errorJson,
  FAKE_COMMIT,
  FAKE_PROJECT,
  fakeAgentKnowledge,
  fakeItem,
  getJson,
  mandatoryItem,
  RULES_DOC,
  searchJson,
  sha256,
  statusJson,
} from "./agentKnowledgeFixture";
import type { FakeReply } from "./agentKnowledgeFixture";
import { createRepo, removeRepo, writeFixture } from "./repoFixture";

/**
 * agent-knowledge 어댑터(`code-agent plugin agent-knowledge`) — 봉투·설정·질의·분류·합치기·인계 참조.
 *
 * 실제 agent-knowledge 대신 가짜 CLI(agentKnowledgeFixture)가 실측한 응답 모양으로 답한다. 어댑터는 함수로 직접 부르고(stdin 문자열 →
 * 봉투 문자열), CLI 갈래·종료 코드·타임라인 제외만 실제 프로세스로 본다. `CODE_AGENT_HOME` 을 임시 폴더로 돌려 사용자 홈을 건드리지 않는다.
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

function writeConfig(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify({ schemaVersion: 1, command: fake.command, projects: [{ root: repo, project: FAKE_PROJECT }], ...overrides }, null, 2),
  );
}

function setup(): void {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-ak-")));
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
  mock.restoreAll();
  if (homeBefore === undefined) delete process.env.CODE_AGENT_HOME;
  else process.env.CODE_AGENT_HOME = homeBefore;
  if (envBefore === undefined) delete process.env[CONFIG_ENV];
  else process.env[CONFIG_ENV] = envBefore;
  rmSync(root, { recursive: true, force: true });
}

interface Reply {
  protocol: string;
  version: string;
  requestId: string;
  ok: boolean;
  output?: Record<string, unknown> & {
    sections?: { path: string; heading: string; why: string; ref?: Record<string, unknown> }[];
    fallback?: { code: string; message?: string };
    diagnostics?: Record<string, unknown>;
    pinned?: { itemId: string; ok: boolean; reason?: string; section?: { path: string; heading: string; why: string; ref?: Record<string, unknown> } }[];
    ready?: boolean;
    detail?: string;
  };
  error?: string;
}

function call(request: unknown, options: Partial<AdapterOptions> = {}): { text: string; reply: Reply } {
  const text = agentKnowledgeAdapter(typeof request === "string" ? request : JSON.stringify(request), {
    args: ["--config", configPath],
    cwd: repo,
    ...options,
  });
  assert.ok(!text.includes("\n"), "봉투는 한 줄 JSON 하나입니다");
  return { text, reply: JSON.parse(text) as Reply };
}

function envelope(op: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { protocol: "code-agent.plugin", version: "1", op, requestId: `req-${op}`, ...extra };
}

function runInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirements: [{ key: "R1", text: "환불 금액을 계산한다" }],
    docs: DOCS,
    limit: 10,
    phase: "impact",
    files: ["src/orders/refund.ts"],
    ...extra,
  };
}

function runRequest(input: Record<string, unknown> = runInput(), repoRoot = repo.replace(/\\/g, "/")): Record<string, unknown> {
  return envelope("run", { repoRoot, slot: "context.docs", sendsCode: false, input });
}

function searchReplies(...replies: FakeReply[]): void {
  fake.scenario({ search: replies });
}

const searchCalls = () => fake.calls().filter((entry) => entry.command === "search");
const getCalls = () => fake.calls().filter((entry) => entry.command === "get");

// ==== 1. 봉투·설정 ====

describe("agent-knowledge 어댑터 — 봉투·설정·probe", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("AK1. describe — 이름·패키지 버전·자리·선택 입력을 알리고 requestId 를 되비친다 (agent-knowledge 를 부르지 않는다)", () => {
    const { reply } = call(envelope("describe"));
    assert.equal(reply.protocol, "code-agent.plugin");
    assert.equal(reply.version, "1");
    assert.equal(reply.requestId, "req-describe");
    assert.equal(reply.ok, true);
    const described = DESCRIBE_SCHEMA.parse(reply.output) as DescribeOutput;
    assert.equal(described.name, "agent-knowledge");
    assert.equal(described.adapterVersion, packageVersion());
    assert.deepEqual(described.slots, ["context.docs"]);
    assert.equal(described.sendsCode, false);
    assert.deepEqual(described.accepts, [...AGENT_KNOWLEDGE_ACCEPTS]);
    assert.match(described.note ?? "", /읽기 전용\(search·get·status\)/);
    assert.deepEqual(fake.calls(), []);
  });

  test("AK2. 요청 봉투가 계약과 다르면 ok:false 봉투 하나 — '<코드>: <설명>'", () => {
    const notJson = call("{ 이건 JSON 이 아님").reply;
    assert.equal(notJson.ok, false);
    assert.equal(notJson.requestId, "");
    assert.match(notJson.error ?? "", /^invalid-request: /);

    const protocol = call({ ...envelope("describe"), protocol: "other" }).reply;
    assert.equal(protocol.requestId, "req-describe", "형식이 맞는 requestId 는 되비친다");
    assert.match(protocol.error ?? "", /^invalid-request: .*protocol·version/);
    assert.match(call({ ...envelope("describe"), version: "2" }).reply.error ?? "", /^invalid-request: /);
    assert.match(call({ protocol: "code-agent.plugin", version: "1", op: "describe", requestId: 7 }).reply.error ?? "", /^invalid-request: /);
    assert.match(call(envelope("index")).reply.error ?? "", /^unsupported-op: /);
    assert.match(call(envelope("run", { repoRoot: repo, slot: "candidates.rank", input: {} })).reply.error ?? "", /^unsupported-slot: /);
    assert.match(call(envelope("describe"), { args: ["--bogus"] }).reply.error ?? "", /^usage: 사용법: code-agent plugin agent-knowledge/);
    assert.match(call(envelope("describe"), { args: ["--config"] }).reply.error ?? "", /^usage: /);
    assert.deepEqual(fake.calls(), []);
  });

  test("AK3. 설정 — 엄격 스키마·한도 범위·절대 경로, --config → 환경변수 → <storeDir>/agent-knowledge.json", () => {
    const loaded = loadAdapterConfig(configPath);
    assert.ok(loaded.ok);
    assert.deepEqual(loaded.config.limits, { timeoutMs: 8000, maxOutputBytes: 8388608, maxQueries: 4, queryChars: 400, maxPaths: 50 });
    assert.equal(loaded.config.projects[0].root, normalizeRoot(repo));

    writeConfig({ sourcesConfig: "kb/sources.yaml", retrievalConfig: "kb/retrieval.yaml", db: "kb/knowledge.sqlite", limits: { maxQueries: 2 } });
    const relative = loadAdapterConfig(configPath);
    assert.ok(relative.ok);
    assert.equal(relative.config.sourcesConfig, join(root, "kb", "sources.yaml"), "상대 경로는 설정 파일 폴더 기준");
    assert.equal(relative.config.db, join(root, "kb", "knowledge.sqlite"));
    assert.equal(relative.config.limits.maxQueries, 2);
    assert.equal(relative.config.limits.queryChars, 400);

    const invalid = (overrides: Record<string, unknown>, pattern: RegExp) => {
      writeConfig(overrides);
      const result = loadAdapterConfig(configPath);
      assert.ok(!result.ok, JSON.stringify(overrides));
      assert.equal(result.code, "adapter-config-invalid");
      assert.match(result.message, pattern);
    };
    invalid({ extra: true }, /형식이 다릅니다/);
    invalid({ limits: { timeoutMs: 20_000 } }, /limits\.timeoutMs/);
    invalid({ limits: { maxQueries: 0 } }, /limits\.maxQueries/);
    invalid({ limits: { queryChars: 49 } }, /limits\.queryChars/);
    invalid({ limits: { maxOutputBytes: 1024 } }, /limits\.maxOutputBytes/);
    // 인계 참조 수는 master 계약 상한(MAX_KNOWLEDGE_REFS)에 고정한다 — hello 가 알리는 상한과 어긋나지 않게 설정으로 줄이지 않는다
    invalid({ limits: { maxRefs: 5 } }, /형식이 다릅니다/);
    invalid({ limits: { unknown: 1 } }, /형식이 다릅니다/);
    invalid({ schemaVersion: 2 }, /schemaVersion/);
    invalid({ projects: [{ root: repo, project: "Orders" }] }, /projects\.0\.project/);
    invalid({ projects: [{ root: repo, project: "a" }, { root: `${repo}/`, project: "b" }] }, /같은 root/);
    writeConfig();

    const relativePath = loadAdapterConfig("adapter.json");
    assert.ok(!relativePath.ok);
    assert.equal(relativePath.code, "adapter-config-invalid");
    assert.match(relativePath.message, /절대 경로/);
    const missing = loadAdapterConfig(join(root, "nope.json"));
    assert.ok(!missing.ok);
    assert.equal(missing.code, "adapter-config-missing");

    // 순서 — 환경변수, 그다음 스토어 자리
    const fromStore = loadAdapterConfig(undefined, {});
    assert.ok(!fromStore.ok);
    assert.match(fromStore.message, new RegExp(CONFIG_FILE.replace(".", "\\.")));
    writeFileSync(join(home, CONFIG_FILE), JSON.stringify({ schemaVersion: 1, command: ["x"], projects: [{ root: repo, project: "from-store" }] }));
    const stored = loadAdapterConfig(undefined, {});
    assert.ok(stored.ok);
    assert.equal(stored.config.projects[0].project, "from-store");
    const fromEnv = loadAdapterConfig(undefined, { [CONFIG_ENV]: configPath });
    assert.ok(fromEnv.ok);
    assert.equal(fromEnv.config.projects[0].project, FAKE_PROJECT);
  });

  test("AK4. probe — status 로 활성 세대와 이 저장소 프로젝트의 색인을 확인한다", () => {
    writeConfig({ db: "kb/knowledge.sqlite" });
    fake.scenario({ status: { json: statusJson() } });
    const ready = call(envelope("probe")).reply;
    assert.equal(ready.ok, true);
    const output = PROBE_SCHEMA.parse(ready.output);
    assert.equal(output.ready, true);
    assert.match(output.detail ?? "", /활성 세대 2 · 이 저장소 → 프로젝트 orders \(원본 1개 색인됨\)/);
    const [status] = fake.calls();
    assert.deepEqual(status, { command: "status", args: ["--db", join(root, "kb", "knowledge.sqlite")], stdin: "" }, "status 는 요청 본문 없이");

    fake.scenario({ status: { json: statusJson(2, ["billing"]) } });
    const notIndexed = PROBE_SCHEMA.parse(call(envelope("probe")).reply.output);
    assert.equal(notIndexed.ready, false);
    assert.match(notIndexed.detail ?? "", /^project-not-indexed: 프로젝트 orders/);

    const elsewhere = PROBE_SCHEMA.parse(call(envelope("probe"), { cwd: home }).reply.output);
    assert.equal(elsewhere.ready, true, "대응되지 않은 위치에서 등록해도 막지 않는다");
    assert.match(elsewhere.detail ?? "", /설정 projects 에 없습니다/);

    fake.scenario({ status: { exit: 5, json: errorJson("status", "index-missing", "게시된 색인이 없습니다", { reason: "no-generation" }) } });
    const missingIndex = PROBE_SCHEMA.parse(call(envelope("probe")).reply.output);
    assert.equal(missingIndex.ready, false);
    assert.match(missingIndex.detail ?? "", /^index-missing: .*\(no-generation\)/);

    const noConfig = call(envelope("probe"), { args: ["--config", join(root, "nope.json")] }).reply;
    assert.equal(noConfig.ok, true);
    assert.match(String(noConfig.output?.detail), /^adapter-config-missing: /);
    assert.equal(noConfig.output?.ready, false);
  });

  test("AK5. 저장소 대응 — 실제 경로·슬래시·소문자(win32)로 맞추고, 없으면 project-not-mapped (agent-knowledge 를 부르지 않는다)", () => {
    assert.equal(normalizeRoot(`${repo}${process.platform === "win32" ? "\\" : "/"}`), normalizeRoot(repo));
    if (process.platform === "win32") {
      assert.equal(normalizeRoot("C:\\Code-Agent-No-Such\\Repo\\", "win32"), "c:/code-agent-no-such/repo");
      assert.equal(normalizeRoot(repo.toUpperCase()), normalizeRoot(repo));
    } else {
      assert.equal(normalizeRoot("/code-agent-no-such/Repo/", process.platform), "/code-agent-no-such/Repo");
    }
    searchReplies({ json: searchJson() });
    const mapped = call(runRequest(runInput(), repo)).reply;
    assert.equal(mapped.ok, true, "역슬래시 repoRoot 도 같은 저장소다");

    fake.reset();
    const other = call(runRequest(runInput(), home.replace(/\\/g, "/"))).reply;
    assert.equal(other.ok, false);
    assert.match(other.error ?? "", /^project-not-mapped: /);
    assert.deepEqual(fake.calls(), []);
    const noRoot = call(envelope("run", { slot: "context.docs", input: runInput() })).reply;
    assert.match(noRoot.error ?? "", /^invalid-request: .*repoRoot/);
    const badInput = call(runRequest({ requirements: "x", docs: DOCS, limit: 10 })).reply;
    assert.match(badInput.error ?? "", /^invalid-input: /);
  });
});

// ==== 2. 검색 ====

describe("agent-knowledge 어댑터 — 검색·분류·합치기", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("AK6. 정상 — 직접 결과만 섹션이 되고 출처 참조가 agent-knowledge 필드 이름 그대로, 본문은 넘기지 않는다", () => {
    writeConfig({ sourcesConfig: "kb/sources.yaml", retrievalConfig: "kb/retrieval.yaml", db: "kb/knowledge.sqlite" });
    const architecture = fakeItem({ path: ARCH_DOC, key: null, anchor: "저장소-1", title: "저장소", unit: "section", kind: "architecture", startLine: 9, endLine: 11, reasons: ["keyword-match"], rank: 3, declaredStatus: null, reason: "status-not-declared" });
    searchReplies({ json: searchJson({ items: [mandatoryItem(), fakeItem({ rank: 2 }), architecture], limitations: ["keyword-only", "unconfirmed-results"] }) });
    const { text, reply } = call(runRequest());
    assert.equal(reply.ok, true);
    assert.equal(reply.requestId, "req-run");
    assert.ok(SLOT_OUTPUT_SCHEMA["context.docs"].safeParse(reply.output).success, "호스트의 출력 스키마를 지난다");
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
    });
    assert.equal(sections[1].ref?.declaredStatus, null);
    assert.equal(reply.output!.fallback, undefined);
    assert.equal(reply.output!.pinned, undefined, "refs 를 받지 않았으면 pinned 도 없다");
    // 본문·발췌·연결은 넘기지 않는다
    for (const leaked of ["결제 금액에서", "excerpt", "content", "links", "applicability"]) assert.ok(!text.includes(leaked), leaked);

    const diagnostics = reply.output!.diagnostics!;
    assert.deepEqual(
      { ...diagnostics, durationMs: 0 },
      {
        engine: "agent-knowledge",
        schemaVersion: 1,
        project: "orders",
        queries: 1,
        requirements: 1,
        bundled: 0,
        queryChars: 0,
        requestLimit: 20,
        generation: 2,
        commits: { orders: FAKE_COMMIT },
        versions: { parser: "md-1", chunker: "chunk-1", tokenizer: "tok-1", resolver: "resolve-1" },
        queriesSkipped: 0,
        directCount: 2,
        returned: 2,
        dropped: { mandatory: 1, linked: 0, otherProject: 0, outOfDocs: 0, invalid: 0, deprecated: 0 },
        limitations: ["keyword-only", "unconfirmed-results"],
        calls: 1,
        durationMs: 0,
      },
    );

    const [search] = searchCalls();
    assert.deepEqual(search.args, [
      "--config", join(root, "kb", "sources.yaml"),
      "--retrieval-config", join(root, "kb", "retrieval.yaml"),
      "--db", join(root, "kb", "knowledge.sqlite"),
      "--request", "-",
    ]);
    assert.equal(
      search.stdin,
      JSON.stringify({ profile: "code", query: "환불 금액을 계산한다", scope: { projects: ["orders"] }, task: { phase: "impact", paths: ["src/orders/refund.ts"] }, limit: 20 }),
      "agent-knowledge 가 아는 필드만 — 요청 스키마가 엄격하다. 거른 뒤에도 limit 을 채우려고 두 배를 받는다",
    );
  });

  test("AK7. 질의 — 공백 정리·같은 글 제거·maxQueries 묶음·queryChars 자르기, 둘째 질의부터 세대 고정, task 는 있을 때만", () => {
    const plan = buildQueries(
      [{ text: "  환불  금액 " }, { text: "환불 금액" }, { text: "주문\n취소" }, { text: "" }, { text: "재고" }, { text: "포인트" }, { text: "배송" }],
      { maxQueries: 2, queryChars: 400 },
    );
    assert.deepEqual(plan, { queries: ["환불 금액 주문 취소", "재고 포인트 배송"], distinct: 5, bundled: 2, clipped: 0 });
    assert.deepEqual(buildQueries([{ text: "a" }, { text: "b" }], { maxQueries: 4, queryChars: 400 }).queries, ["a", "b"]);

    const spaced = buildQueries([{ text: `${"가".repeat(30)} ${"나".repeat(40)}` }], { maxQueries: 4, queryChars: 50 });
    assert.deepEqual(spaced.queries, ["가".repeat(30)], "가능하면 공백에서 자른다");
    assert.equal(spaced.clipped, 41);
    const solid = buildQueries([{ text: "가".repeat(80) }], { maxQueries: 4, queryChars: 50 });
    assert.equal(solid.queries[0], "가".repeat(50));
    assert.equal(solid.clipped, 30);
    const emoji = buildQueries([{ text: "😀".repeat(60) }], { maxQueries: 4, queryChars: 50 });
    assert.equal([...emoji.queries[0]].length, 50, "코드 포인트 기준");

    writeConfig({ limits: { maxQueries: 2, maxPaths: 2 } });
    searchReplies({ json: searchJson() });
    const requirements = ["환불", "취소", "재고", "포인트", "배송"].map((text, index) => ({ key: `R${index + 1}`, text }));
    // 저장소 기준 상대 경로가 아닌 것(URL·저장소 밖·드라이브)은 agent-knowledge 가 요청 전체를 거부하므로 빼고 수만 남긴다
    const files = ["/api/orders/refund", "a.ts", "../shared/money.ts", "./b\\c.ts", "C:/x.ts", "a.ts", "d.ts"];
    const { reply } = call(runRequest(runInput({ requirements, phase: "implement", files })));
    assert.equal(reply.ok, true);
    const bodies = searchCalls().map((entry) => JSON.parse(entry.stdin) as Record<string, unknown>);
    assert.deepEqual(bodies.map((body) => body.query), ["환불 취소", "재고 포인트 배송"]);
    assert.equal(bodies[0].version, undefined);
    assert.deepEqual(bodies[1].version, { generation: 2 });
    assert.deepEqual(bodies[0].task, { paths: ["a.ts", "b/c.ts"] }, "analysis~plan 밖의 단계는 보내지 않고, 경로는 maxPaths 까지");
    assert.equal(reply.output!.diagnostics!.bundled, 2);
    assert.equal(reply.output!.diagnostics!.pathsDropped, 3);

    fake.reset();
    call(runRequest(runInput({ phase: undefined, files: undefined })));
    assert.equal((JSON.parse(searchCalls()[0].stdin) as Record<string, unknown>).task, undefined, "빈 task 는 넣지 않는다");
  });

  test("AK8. 합치기 — 질의별 순번 역수 합(1/(10+p)), 같으면 itemId 바이트 순, 상위 limit", () => {
    const item = (key: string, rank: number) => fakeItem({ key, anchor: key, rank, reasons: ["keyword-match"] });
    searchReplies(
      { json: searchJson({ items: [item("BR-001", 1), item("BR-002", 2)] }) },
      { json: searchJson({ items: [item("BR-002", 1), item("BR-003", 2)] }) },
    );
    const ranked = call(runRequest(runInput({ requirements: [{ key: "R1", text: "첫" }, { key: "R2", text: "둘" }] }))).reply;
    assert.deepEqual(ranked.output!.sections!.map((section) => section.ref?.itemId), [
      `orders:${RULES_DOC}#BR-002`,
      `orders:${RULES_DOC}#BR-001`,
      `orders:${RULES_DOC}#BR-003`,
    ]);

    fake.reset();
    searchReplies(
      { json: searchJson({ items: [item("BR-010", 1), item("BR-002", 2)] }) },
      { json: searchJson({ items: [item("BR-002", 1), item("BR-010", 2)] }) },
    );
    const tied = call(runRequest(runInput({ limit: 1, requirements: [{ key: "R1", text: "첫" }, { key: "R2", text: "둘" }] }))).reply;
    assert.deepEqual(tied.output!.sections!.map((section) => section.ref?.itemId), [`orders:${RULES_DOC}#BR-002`]);
    assert.equal(JSON.parse(searchCalls()[0].stdin).limit, 2, "요청은 limit 의 두 배, 합친 뒤 limit 으로 자른다");
  });

  test("AK9. 결과 없음(exit 3)·필수 자료만·모두 탈락·질의 없음 — fallback 으로 기본 검색을 요청한다", () => {
    searchReplies({ exit: 3, json: searchJson({ items: [], status: "no-results", limitations: ["mandatory-filtered"] }) });
    const none = call(runRequest()).reply;
    assert.equal(none.ok, true, "exit 3 은 오류가 아니다");
    assert.deepEqual(none.output!.sections, []);
    assert.equal(none.output!.fallback?.code, "no-results");

    searchReplies({ json: searchJson({ items: [mandatoryItem(), mandatoryItem("BR-004", "비공식 상태 표기")], directCount: 0, limitations: ["no-query-matches"] }) });
    const mandatory = call(runRequest()).reply;
    assert.equal(mandatory.output!.fallback?.code, "mandatory-only");
    assert.equal((mandatory.output!.diagnostics!.dropped as Record<string, number>).mandatory, 2);

    searchReplies({
      json: searchJson({
        items: [
          fakeItem({ projectId: "billing", sourceId: "billing", key: "B-1", anchor: "B-1" }),
          fakeItem({ path: "doc/decisions/order-cancel.md", key: null, anchor: "결정", title: "결정" }),
          fakeItem({ key: "BR-010", anchor: "BR-010", generation: 1 }),
          fakeItem({ key: "BR-011", anchor: "BR-011", commit: "1111111111111111111111111111111111111111" }),
          fakeItem({ key: "BR-012", anchor: "BR-012", itemSha256: "abc" }),
          fakeItem({ key: "BR-013", anchor: "BR-013", id: "orders:doc/other.md#BR-013" }),
          fakeItem({ key: "BR-014", anchor: "BR-014", path: "../secret.md" }),
          fakeItem({ key: "BR-015", anchor: "BR-015", startLine: 9, endLine: 3 }),
          { id: "orders:doc/x.md#y", selection: { section: "rules", reasons: ["keyword-match"] } },
          fakeItem({ key: "BR-005", anchor: "BR-005", status: "deprecated" }),
          fakeItem({ key: "BR-020", anchor: "BR-020", reasons: [`linked:code:orders:${RULES_DOC}#BR-002`] }),
        ],
      }),
    });
    const unusable = call(runRequest()).reply;
    assert.equal(unusable.output!.fallback?.code, "no-usable-items");
    assert.deepEqual(unusable.output!.diagnostics!.dropped, { mandatory: 0, linked: 1, otherProject: 1, outOfDocs: 1, invalid: 7, deprecated: 1 });

    fake.reset();
    const empty = call(runRequest(runInput({ requirements: [{ key: "R1", text: "  \n " }] }))).reply;
    assert.equal(empty.output!.fallback?.code, "no-query");
    assert.deepEqual(fake.calls(), [], "질의가 없으면 부르지 않는다");

    // sources 를 적은 대응은 다른 원본의 항목을 쓰지 않는다
    writeConfig({ projects: [{ root: repo, project: FAKE_PROJECT, sources: ["orders-docs"] }] });
    searchReplies({ json: searchJson() });
    const otherSource = call(runRequest()).reply;
    assert.equal(otherSource.output!.fallback?.code, "no-usable-items");
    assert.equal((otherSource.output!.diagnostics!.dropped as Record<string, number>).otherProject, 1);
  });

  test("AK10. 실패 분류 — 오류마다 ok:false 봉투에 '<코드>: <설명>' (첫 오류에서 멈춘다)", () => {
    const cases: [string, FakeReply | undefined, string, Record<string, unknown>?][] = [
      ["invalid-json", { stdout: "Error: something broke\n" }, "invalid-json"],
      ["빈 출력", { stdout: "", exit: 1 }, "invalid-json"],
      ["schemaVersion 다름", { json: searchJson({ schemaVersion: 2 }) }, "unsupported-version"],
      ["schema 다름", { json: { ...searchJson(), schema: "agent-knowledge.get" } }, "unsupported-version"],
      ["오류 봉투 schemaVersion 다름", { exit: 5, json: { ...errorJson("search", "index-missing", "x"), schemaVersion: 3 } }, "unsupported-version"],
      ["구조 다름", { json: { ...searchJson(), items: "x" } }, "invalid-response"],
      ["index 없음", { json: { ...searchJson(), index: undefined } }, "invalid-response"],
      ["exit 3 인데 ok", { exit: 3, json: searchJson() }, "invalid-response"],
      ["오류 봉투 없는 exit 2", { exit: 2, json: searchJson() }, "invalid-response"],
      ["index-missing", { exit: 5, json: errorJson("search", "index-missing", "색인 세대를 찾을 수 없습니다: 99", { reason: "generation-not-found", generation: 99 }) }, "index-missing"],
      ["invalid-scope", { exit: 4, json: errorJson("search", "invalid-scope", "등록되지 않은 프로젝트입니다: orders", { reason: "unknown-project" }) }, "invalid-scope"],
      ["config-invalid", { exit: 7, json: errorJson("search", "config-invalid", "설정 파일이 없습니다", { reason: "not-found" }) }, "config-invalid"],
      ["모르는 오류 코드", { exit: 1, json: errorJson("search", "Weird Code!", "x") }, "agent-knowledge-error"],
      ["output-too-large", { bytes: 200_000 }, "output-too-large", { limits: { maxOutputBytes: 65_536 } }],
      ["timeout", { sleepMs: 4000, json: searchJson() }, "timeout", { limits: { timeoutMs: 1000 } }],
      // node 는 있는데 agent-knowledge 스크립트가 없다 — Node 의 끝줄(버전 표시)에 가려 응답 형식 오류로 보이지 않게
      ["스크립트 없음", undefined, "not-installed", { command: ["node", join(root, "no-such-agent-knowledge", "main.js")] }],
      ["not-installed", undefined, "not-installed", { command: ["code-agent-agent-knowledge-not-installed-xyz"] }],
    ];
    for (const [label, reply, code, config] of cases) {
      writeConfig(config ?? {});
      fake.reset();
      searchReplies(...(reply ? [reply] : []));
      const result = call(runRequest(runInput({ requirements: [{ key: "R1", text: "첫" }, { key: "R2", text: "둘" }] }))).reply;
      assert.equal(result.ok, false, label);
      assert.ok(result.error?.startsWith(`${code}: `), `${label}: ${result.error}`);
      assert.ok(searchCalls().length <= 1, `${label}: 첫 오류에서 남은 질의를 부르지 않는다`);
      assert.equal(result.requestId, "req-run", label);
    }
    assert.match(call(runRequest()).reply.error ?? "", /^not-installed: agent-knowledge 실행 파일을 찾을 수 없습니다/);
  });

  test("AK11. 전체 마감 — 남은 질의를 건너뛰고 받은 결과는 쓴다, 하나도 못 부르면 timeout", () => {
    searchReplies({ json: searchJson() });
    const requirements = ["가", "나", "다", "라"].map((text, index) => ({ key: `R${index + 1}`, text }));
    // 가짜 시계 — search 한 번에 10초가 흐른다(마감 15초)
    const now = () => 1_000_000 + searchCalls().length * 10_000;
    const partial = call(runRequest(runInput({ requirements })), { now, deadlineMs: 15_000 }).reply;
    assert.equal(partial.ok, true);
    assert.equal(searchCalls().length, 2);
    assert.equal(partial.output!.diagnostics!.queriesSkipped, 2);
    assert.equal(partial.output!.sections!.length, 1);

    fake.reset();
    const none = call(runRequest(runInput({ requirements })), { deadlineMs: 0 }).reply;
    assert.equal(none.ok, false);
    assert.match(none.error ?? "", /^timeout: 전체 마감/);
    assert.deepEqual(fake.calls(), []);

    // 진행 중인 질의가 마감 때문에 줄인 제한 시간에 끊겨도 앞 질의 결과는 쓴다(설정 timeoutMs 8초 > 남은 시간)
    fake.reset();
    searchReplies({ json: searchJson() }, { sleepMs: 6000, json: searchJson() });
    const cut = call(runRequest(runInput({ requirements })), { deadlineMs: 3000 }).reply;
    assert.equal(cut.ok, true, cut.error);
    assert.equal(searchCalls().length, 2);
    assert.equal(cut.output!.diagnostics!.queriesSkipped, 3);
    assert.equal(cut.output!.sections!.length, 1);
  });
});

// ==== 3. 인계 참조 ====

describe("agent-knowledge 어댑터 — master 인계 참조(get)", () => {
  beforeEach(setup);
  afterEach(teardown);

  const id = (key: string, path = RULES_DOC) => `orders:${path}#${key}`;
  const ref = (key: string, extra: Record<string, unknown> = {}) => ({
    itemId: id(key),
    generation: 2,
    commit: FAKE_COMMIT,
    itemSha256: sha256(`item:${RULES_DOC}#${key}`),
    required: true,
    ...extra,
  });

  test("AK12. get 으로 같은 세대에서 되찾아 항목·프로젝트·문서·커밋·해시를 대조한다", () => {
    const item = (key: string, extra: Record<string, unknown> = {}) => ({ json: getJson(fakeItem({ key, anchor: key, ...extra })) });
    fake.scenario({
      search: [{ json: searchJson() }],
      get: {
        [`${id("BR-002")}@2`]: item("BR-002"),
        [`${id("BR-001")}@2`]: item("BR-001"),
        [`${id("BR-003")}@2`]: item("BR-003"),
        [`${id("BR-004")}@99`]: { exit: 5, json: errorJson("get", "index-missing", "색인 세대를 찾을 수 없습니다: 99", { reason: "generation-not-found", generation: 99 }) },
        [`${id("결정", "doc/decisions/order-cancel.md")}@2`]: { json: getJson(fakeItem({ path: "doc/decisions/order-cancel.md", key: null, anchor: "결정", title: "결정" })) },
        [`${id("BR-006")}@2`]: item("BR-006", { projectId: "billing" }),
        [`${id("BR-007")}@2`]: { json: getJson(fakeItem({ key: "BR-007", anchor: "BR-007" }), 3) },
        [`${id("BR-008")}@2`]: item("BR-008", { status: "deprecated" }),
      },
    });
    const refs = [
      ref("BR-002"),
      ref("BR-001", { itemSha256: sha256("다른 내용") }),
      ref("BR-003", { commit: "2222222222222222222222222222222222222222" }),
      ref("BR-004", { generation: 99, required: false }),
      ref("BR-999"),
      { ...ref("결정"), itemId: id("결정", "doc/decisions/order-cancel.md") },
      ref("BR-006"),
      ref("BR-007"),
      ref("BR-008"),
      ref("BR-009", { commit: "XYZ" }),
      ref("BR-002"),
      { itemId: "not-an-item-id", generation: 2, commit: FAKE_COMMIT, itemSha256: sha256("x"), required: false },
    ];
    const { text, reply } = call(runRequest(runInput({ refs })));
    assert.equal(reply.ok, true);
    assert.ok(SLOT_OUTPUT_SCHEMA["context.docs"].safeParse(reply.output).success);
    const pinned = reply.output!.pinned!;
    assert.deepEqual(pinned.map((entry) => [entry.itemId, entry.ok, entry.reason]), [
      [id("BR-002"), true, undefined],
      [id("BR-001"), false, "hash-mismatch"],
      [id("BR-003"), false, "commit-mismatch"],
      [id("BR-004"), false, "generation-expired"],
      [id("BR-999"), false, "not-found"],
      [id("결정", "doc/decisions/order-cancel.md"), false, "not-in-docs"],
      [id("BR-006"), false, "out-of-scope"],
      [id("BR-007"), false, "generation-expired"],
      [id("BR-008"), true, undefined],
      [id("BR-009"), false, "invalid-ref"],
      [id("BR-002"), false, "invalid-ref"],
      ["not-an-item-id", false, "invalid-ref"],
    ]);
    const section = pinned[0].section!;
    assert.equal(section.path, RULES_DOC);
    assert.equal(section.heading, "`BR-002` 환불 금액 계산");
    assert.equal(section.why, "agent-knowledge 인계 참조");
    assert.equal(section.ref?.pinned, true);
    assert.equal(section.ref?.itemSha256, sha256(`item:${RULES_DOC}#BR-002`));
    assert.equal(pinned[8].section?.ref?.status, "deprecated", "폐기도 되찾은 그대로 — 표시는 호스트가 한다");
    assert.ok(!text.includes("결제 금액에서"), "get 의 content 를 넘기지 않는다");
    assert.deepEqual(reply.output!.diagnostics!.refs, {
      requested: 12,
      ok: 2,
      failed: { "hash-mismatch": 1, "commit-mismatch": 1, "generation-expired": 2, "not-found": 1, "not-in-docs": 1, "out-of-scope": 1, "invalid-ref": 3 },
    });
    assert.equal(getCalls().length, 9, "형식이 틀린 참조는 부르지 않는다");
    assert.equal(
      getCalls()[0].stdin,
      JSON.stringify({ id: id("BR-002"), profile: "code", scope: { projects: ["orders"] }, version: { generation: 2 } }),
    );
    assert.deepEqual(getCalls()[0].args, ["--request", "-"]);
    // 인계 참조를 먼저 되찾고 검색한다
    assert.equal(fake.calls()[fake.calls().length - 1].command, "search");
  });

  test("AK13. 검색이 실패해도 인계 참조 결과는 따로 낸다 — 검색 실패는 fallback 으로, master 계약 상한(20)을 넘는 참조는 too-many-refs", () => {
    fake.scenario({
      search: [{ exit: 5, json: errorJson("search", "index-missing", "색인 세대를 찾을 수 없습니다", { reason: "generation-not-found" }) }],
      get: { [`${id("BR-002")}@2`]: { json: getJson(fakeItem()) } },
    });
    // 2~20번째는 꼴이 틀린 참조(get 을 부르지 않는다), 21번째는 상한 밖
    const malformed = Array.from({ length: 19 }, (_, index) => ({ ...ref(`BR-1${String(index).padStart(2, "0")}`), generation: 0 }));
    const { reply } = call(runRequest(runInput({ refs: [ref("BR-002"), ...malformed, ref("BR-003")] })));
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.output!.sections, []);
    assert.equal(reply.output!.fallback?.code, "index-missing");
    assert.deepEqual(reply.output!.pinned!.map((entry) => [entry.ok, entry.reason]), [
      [true, undefined], ...malformed.map(() => [false, "invalid-ref"]), [false, "too-many-refs"],
    ]);
    assert.equal(reply.output!.diagnostics!.searchError, "index-missing");
    assert.equal(getCalls().length, 1);

    // sources 를 적은 대응은 다른 원본의 참조를 부르지 않고 거른다
    writeConfig({ projects: [{ root: repo, project: FAKE_PROJECT, sources: ["orders"] }] });
    fake.reset();
    searchReplies({ json: searchJson() });
    const scoped = call(runRequest(runInput({ refs: [{ ...ref("BR-002"), itemId: "billing:doc/x.md#A" }] }))).reply;
    assert.deepEqual(scoped.output!.pinned!.map((entry) => entry.reason), ["out-of-scope"]);
    assert.equal(getCalls().length, 0);
  });
});

// ==== 4. CLI · 등록 · 목록 · hook ====

describe("agent-knowledge 어댑터 — CLI 갈래·등록·plugin list·hook", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("AK14. code-agent plugin agent-knowledge — exit 0 + stdout 봉투 한 줄, 인자 오류도 봉투, 실행 타임라인을 남기지 않는다", () => {
    const cliRepo = createRepo("ca-ak-cli-");
    try {
      mkdirSync(join(cliRepo, ".code-agent", "log"), { recursive: true });
      writeConfig({ projects: [{ root: cliRepo, project: FAKE_PROJECT }] });
      searchReplies({ json: searchJson() });
      const cli = join(__dirname, "..", "agent", "cli.js");
      const spawn = (args: string[], input: string) =>
        spawnSync(process.execPath, [cli, "plugin", "agent-knowledge", ...args], {
          cwd: cliRepo,
          input,
          encoding: "utf-8",
          env: { ...process.env, CODE_AGENT_HOME: home },
          timeout: 60_000,
        });
      const ran = spawn(["--config", configPath], JSON.stringify(runRequest(runInput(), cliRepo.replace(/\\/g, "/"))));
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(ran.stdout.trim().split("\n").length, 1);
      const reply = JSON.parse(ran.stdout) as Reply;
      assert.equal(reply.ok, true, ran.stdout);
      assert.equal(reply.output!.sections!.length, 1);

      const probe = spawn(["--config", configPath], JSON.stringify(envelope("probe")));
      assert.equal(probe.status, 0);
      assert.equal((JSON.parse(probe.stdout) as Reply).requestId, "req-probe");

      const usage = spawn(["--bogus"], JSON.stringify(envelope("describe")));
      assert.equal(usage.status, 0);
      assert.match((JSON.parse(usage.stdout) as Reply).error ?? "", /^usage: /);
      const empty = spawn([], "");
      assert.equal(empty.status, 0);
      assert.match((JSON.parse(empty.stdout) as Reply).error ?? "", /^invalid-request: /);

      assert.ok(!existsSync(join(cliRepo, ".code-agent", "log", "timeline.jsonl")), "어댑터 왕복은 작업 흐름의 행동이 아니다");
    } finally {
      removeRepo(cliRepo);
    }
  });

  test("AK15. 등록 — describe 의 accepts 중 이 code-agent 가 아는 토큰·등록하는 자리의 것만 저장한다", () => {
    let state: store.Store = { version: 1, plugins: {} };
    let described: DescribeOutput = {
      name: "agent-knowledge",
      adapterVersion: "1.0.0",
      slots: ["context.docs", "candidates.rank"],
      sendsCode: false,
      accepts: ["context.docs.phase", "context.docs.refs", "context.docs.future", "candidates.rank.phase", "context.docs.phase"],
    };
    mock.method(store, "readStore", () => structuredClone(state));
    mock.method(store, "writeStore", (next: store.Store) => { state = next; });
    mock.method(run, "describeAdapter", () => ({ ok: true, output: structuredClone(described) }));
    mock.method(run, "probeAdapter", () => ({ ok: true, output: { ready: true, detail: "ready" } }));
    const prompts = { ask: () => "", confirm: () => undefined };

    const shown = registerPlugin(repo, { name: "agent-knowledge", command: "code-agent plugin agent-knowledge", sendsCode: false }, prompts);
    assert.deepEqual(state.plugins["agent-knowledge"].adapter.accepts, ["context.docs.phase", "context.docs.refs"]);
    assert.match(shown, /선택 입력 context\.docs\.phase, context\.docs\.refs/);

    registerPlugin(repo, { name: "ranker", command: "node rank.js", slots: "candidates.rank", sendsCode: false }, prompts);
    assert.equal(state.plugins.ranker.adapter.accepts, undefined, "등록하지 않는 자리의 토큰은 저장하지 않는다");

    // 다음 버전의 선택 입력(필드 이름이 camelCase 인 자리)을 적은 어댑터도 등록된다 — 모르는 토큰만 버린다
    const future = { ...described, accepts: ["context.docs.phase", "review.prefilter.planFiles", ...Array.from({ length: 40 }, (_, index) => `context.docs.f${index}`)] };
    assert.ok(DESCRIBE_SCHEMA.safeParse(future).success);
    described = future;
    registerPlugin(repo, { name: "later", command: "node later.js", slots: "context.docs", sendsCode: false }, prompts);
    assert.deepEqual(state.plugins.later.adapter.accepts, ["context.docs.phase"]);

    described = { ...described, accepts: undefined };
    registerPlugin(repo, { name: "plain", command: "node plain.js", sendsCode: false }, prompts);
    assert.ok(!("accepts" in state.plugins.plain.adapter), "accepts 가 없는 어댑터의 등록에는 adapter.accepts 키가 없다");
  });

  test("AK16. plugin list — shadow 선언을 '비교만(shadow)' 으로, 등록의 선택 입력을 보여 준다", () => {
    const manifest = (plugins: Record<string, unknown>) =>
      writeFixture(repo, "code-agent.json", JSON.stringify({
        language: "javascript",
        sourceExtensions: [".js"],
        domainBase: "src/main",
        domainRoots: ["app"],
        conventions: ["doc/conventions.md"],
        docs: { architecture: "doc/architecture.md" },
        build: ["node", "-e", "process.exit(0)"],
        test: ["node", "-e", "process.exit(0)"],
        stages: [{ key: "code", title: "코드", template: "01-code.md", scope: "project", outputDirs: ["src/main"] }],
        plugins,
      }));
    manifest({ "agent-knowledge": { shadow: ["context.docs"] } });
    const unregistered = pluginList(repo);
    assert.match(unregistered, /\| context\.docs +\| .+ \| 기본 구현 · agent-knowledge 비교만\(shadow\) — 등록 없음, 부르지 않음 \|/);
    assert.match(unregistered, /^ {2}- agent-knowledge · 비교만\(shadow\) context\.docs — 결과를 쓰지 않고 비교 기록만$/m);

    store.writeStore({
      version: 1,
      plugins: {
        "agent-knowledge": {
          command: ["code-agent", "plugin", "agent-knowledge"],
          slots: ["context.docs"],
          sendsCode: false,
          adapter: { name: "agent-knowledge", version: "1.0.0", describedAt: "2026-11-10T00:00:00.000Z", accepts: [...AGENT_KNOWLEDGE_ACCEPTS] },
          probe: { at: "2026-11-10T00:00:00.000Z", ok: true },
        },
      },
    });
    const registered = pluginList(repo);
    assert.match(registered, /\| context\.docs +\| .+ \| 기본 구현 · agent-knowledge 비교만\(shadow\) \|/);
    assert.match(registered, /- agent-knowledge · 자리 context\.docs · 코드 외부 전송 아니오 · 선택 입력 context\.docs\.phase, context\.docs\.files, context\.docs\.refs · /);

    manifest({ "agent-knowledge": { slots: ["context.docs"] } });
    const enabled = pluginList(repo);
    assert.match(enabled, /\| context\.docs +\| .+ \| 플러그인 agent-knowledge \|/);
    assert.match(enabled, /^ {2}- agent-knowledge · 자리 context\.docs$/m);
    assert.ok(!enabled.includes("비교만(shadow)"));

    // 선택 입력 협의가 없는 agent-knowledge 등록(이 협의를 모르는 릴리스가 같은 스토어를 다시 쓴 경우) — 다시 등록하라고 보인다
    const current = store.readStore();
    const { accepts: _dropped, ...adapter } = current.plugins["agent-knowledge"].adapter;
    store.writeStore({ ...current, plugins: { "agent-knowledge": { ...current.plugins["agent-knowledge"], adapter } } });
    assert.match(pluginList(repo), /- agent-knowledge · 자리 context\.docs · 코드 외부 전송 아니오 · 선택 입력 협의 없음 — plugin remove 뒤 다시 add · /);
  });

  test("AK17. hook — 모델은 code-agent plugin agent-knowledge 를 부르지 못한다 (plugin list 만 열린다)", () => {
    const hookRepo = createRepo("ca-ak-hook-");
    try {
      // 문서 세션 — hook 이 셸 명령을 허용 목록으로 좁히는 상태
      writeFixture(hookRepo, ".code-agent/docs-session.json", JSON.stringify({ version: 2, startedAt: "2026-11-10T00:00:00.000Z", writable: [] }));
      const bash = (command: string) => decide({ cwd: hookRepo, tool_name: "Bash", tool_input: { command } });
      assert.equal(bash("code-agent plugin list"), undefined);
      for (const command of ["code-agent plugin agent-knowledge", "code-agent plugin agent-knowledge --config C:/kb/agent-knowledge.json"]) {
        assert.match(bash(command) ?? "", /code-agent 명령은 .*plugin list/, command);
      }
    } finally {
      removeRepo(hookRepo);
    }

    // 작업·문서·접수 세션이 없을 때도 막는다 — 관리 실행의 허용 도구(`Bash(code-agent *)`)로 어댑터 설정의 실행 명령이 열리지 않게
    const outside = createRepo("ca-ak-hook-outside-");
    try {
      const bash = (command: string) => decide({ cwd: outside, tool_name: "Bash", tool_input: { command } });
      for (const command of [
        "code-agent plugin agent-knowledge",
        "code-agent plugin agent-knowledge --config C:/x/cfg.json < req.json",
        "cd sub && code-agent.cmd plugin agent-knowledge",
        "node C:/ca/dist/agent/cli.js plugin agent-knowledge",
      ]) {
        assert.match(bash(command) ?? "", /지식 검색 어댑터\(plugin agent-knowledge\)는 code-agent context 가 플러그인으로 부릅니다/, command);
      }
      assert.equal(bash("code-agent plugin list"), undefined);
      // 등록 인자 안의 글(따옴표 안)은 실행이 아니다
      assert.equal(bash('echo "code-agent plugin agent-knowledge"'), undefined);
    } finally {
      removeRepo(outside);
    }
  });
});
