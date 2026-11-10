import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { docReader, verifySectionRef } from "../agent/knowledgeRefs";
import { agentKnowledgeAdapter, CONFIG_ENV, producerEnv } from "../agent/plugins/agentKnowledge";
import { SLOT_OUTPUT_SCHEMA } from "../agent/plugins/protocol";

/**
 * 실제 agent-knowledge CLI 와의 왕복 — 임시 git 저장소의 문서(CRLF·맨 CR 줄 끝 포함)를 임시 DB 에 형식 2로 색인하고, 어댑터가 형식 2를
 * 협의해 낸 섹션 참조를 호스트 검증(`verifySectionRef`)이 현재 파일로 받아들이는지, 실제 검색 참조로 만든 인계 참조가 get 형식 2로
 * 확인·거부되는지 본다.
 *
 * 생산자 위치는 `AGENT_KNOWLEDGE_DIST`(빌드 폴더) → `C:/IdeaProjects/agent-knowledge/dist` 순이고, `src/cli/main.js` 가 없으면 이 묶음을
 * 건너뛴다. 사용자 설정·DB·agent-knowledge 저장소는 건드리지 않는다 — 원본 설정·DB·`CODE_AGENT_HOME` 이 모두 임시 폴더다.
 */

const DIST = process.env.AGENT_KNOWLEDGE_DIST ?? "C:/IdeaProjects/agent-knowledge/dist";
const MAIN = resolve(DIST, "src", "cli", "main.js");
const AVAILABLE = existsSync(MAIN);

const RULES = "doc/knowledge/business-rules.md";
const ARCH = "doc/architecture.md";
const FLOWS = "doc/flows.md";
const DOC_PATHS = [RULES, ARCH, FLOWS];

const LONG = Array.from({ length: 8 }, (_, index) => `환불 처리 세부 단락 ${index}. ${"환불 금액 계산 규칙과 배송비 수수료를 설명하는 긴 문장입니다. ".repeat(12)}`).join("\n\n");
const FILES: Record<string, string> = {
  [RULES]: `# 업무 규칙\n\n## 주문\n\n### \`BR-001\` 주문 취소 가능 기간\n- 상태: 확정\n- 구분: 필수\n\n주문은 결제 후 7일 안에 취소할 수 있다.\n\n### \`BR-002\` 환불 금액 계산\n- 상태: 관찰\n- 코드: src/orders/refund.ts\n\n환불 금액은 결제 금액에서 배송비와 수수료를 뺀 값이다.\n\n### \`BR-003\` 긴 환불 규칙\n\n${LONG}\n`,
  // CRLF 줄 끝
  [ARCH]: "# 아키텍처\r\n\r\n## 저장소\r\n\r\n환불 데이터는 주문 저장소에 둔다.\r\n\r\n## 배송\r\n\r\n배송비는 별도 모듈이 계산한다.\r\n",
  // 맨 CR 줄 끝 — `\r?\n` 으로 나누면 생산자 해시와 달라진다
  [FLOWS]: "# 흐름\r## 환불 흐름\r\r환불 요청은 승인 뒤 처리한다.\r\r## 취소 흐름\r\r취소 요청은 즉시 처리한다.\r",
};

let root: string;
let repo: string;
let configPath: string;
let sourcesPath: string;
let dbPath: string;
let indexId: string;
let homeBefore: string | undefined;
let envBefore: string | undefined;

type Section = { path: string; heading: string; why: string; ref?: Record<string, unknown> };
interface Reply {
  ok: boolean;
  output?: {
    sections?: Section[];
    fallback?: { code: string };
    diagnostics?: Record<string, unknown>;
    pinned?: { itemId: string; segmentId?: string; ok: boolean; reason?: string; section?: Section }[];
  };
  error?: string;
}

/** 생산자를 직접 부른다 — 상속된 AGENT_KNOWLEDGE_* 를 지운 환경으로 */
function producer(args: string[]): { status: number | null; json: Record<string, unknown> } {
  const ran = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf-8", env: producerEnv(process.env), timeout: 60_000 });
  return { status: ran.status, json: JSON.parse(ran.stdout) as Record<string, unknown> };
}

function git(args: string[]): void {
  execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "commit.gpgsign=false", "-c", "user.email=test@example.invalid", "-c", "user.name=test", ...args], { cwd: repo, stdio: "ignore" });
}

function writeConfig(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    configPath,
    JSON.stringify({ schemaVersion: 1, command: [process.execPath, MAIN], sourcesConfig: sourcesPath, db: dbPath, projects: [{ root: repo, project: "orders" }], ...extra }, null, 2),
  );
}

function call(input: Record<string, unknown>): Reply {
  const request = { protocol: "code-agent.plugin", version: "1", op: "run", requestId: "req-real", repoRoot: repo.replace(/\\/g, "/"), slot: "context.docs", sendsCode: false, input };
  const text = agentKnowledgeAdapter(JSON.stringify(request), { args: ["--config", configPath], cwd: repo });
  return JSON.parse(text) as Reply;
}

function runInput(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirements: [{ key: "R1", text: "환불 금액 계산" }, { key: "R2", text: "환불 흐름" }],
    docs: DOC_PATHS.map((path) => ({ kind: "x", path, headings: [] })),
    limit: 10,
    phase: "impact",
    files: ["src/orders/refund.ts"],
    ...extra,
  };
}

/** 호스트 검증 — 현재 작업 트리 파일을 생산자 줄 규칙으로 읽어 참조의 범위·해시를 대조한다 */
function hostVerify(section: Section): ReturnType<typeof verifySectionRef> {
  return verifySectionRef(section, new Set(DOC_PATHS), docReader(repo));
}

/** 섹션 참조 → master 인계 참조(형식 2 필드) */
function handoffOf(ref: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const segment = typeof ref.segmentId === "string"
    ? { segmentId: ref.segmentId, segmentSha256: ref.segmentSha256, segmentStartLine: ref.segmentStartLine, segmentEndLine: ref.segmentEndLine }
    : {};
  return {
    itemId: ref.itemId,
    generation: ref.generation,
    commit: ref.commit,
    itemSha256: ref.itemSha256,
    required: true,
    indexId: ref.indexId,
    sourceId: ref.sourceId,
    path: ref.itemId === undefined ? undefined : String(ref.itemId).slice(String(ref.sourceId).length + 1).split("#")[0],
    startLine: ref.startLine,
    endLine: ref.endLine,
    ...segment,
    ...extra,
  };
}

describe("agent-knowledge 어댑터 — 실제 CLI(형식 2) 왕복", { skip: AVAILABLE ? false : `agent-knowledge 빌드가 없습니다: ${MAIN}` }, () => {
  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-ak-real-")));
    repo = join(root, "repo");
    mkdirSync(join(repo, "doc", "knowledge"), { recursive: true });
    for (const [path, text] of Object.entries(FILES)) writeFileSync(join(repo, path), text);
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "docs"]);
    dbPath = join(root, "db", "knowledge.sqlite");
    mkdirSync(join(root, "db"));
    sourcesPath = join(root, "sources.json");
    writeFileSync(
      sourcesPath,
      JSON.stringify({
        schemaVersion: 1,
        database: { path: dbPath.replace(/\\/g, "/") },
        index: { retainGenerations: 5, maxFileBytes: 65536 },
        sources: [
          {
            id: "orders",
            project: "orders",
            path: repo.replace(/\\/g, "/"),
            ref: "HEAD",
            include: ["doc/**/*.md"],
            exclude: [],
            defaultKind: "reference",
            rules: [
              { match: RULES, kind: "business-rule" },
              { match: ARCH, kind: "architecture" },
              { match: FLOWS, kind: "flow" },
            ],
          },
        ],
      }),
    );
    const indexed = producer(["index", "--config", sourcesPath, "--db", dbPath, "--response-version", "2", "--quiet"]);
    assert.equal(indexed.status, 0, JSON.stringify(indexed.json));
    indexId = String(indexed.json.indexId);
    assert.match(indexId, /^[0-9a-f]{32}$/);
    configPath = join(root, "adapter.json");
    homeBefore = process.env.CODE_AGENT_HOME;
    envBefore = process.env[CONFIG_ENV];
    process.env.CODE_AGENT_HOME = join(root, "home");
    delete process.env[CONFIG_ENV];
  });

  after(() => {
    if (homeBefore === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = homeBefore;
    if (envBefore === undefined) delete process.env[CONFIG_ENV];
    else process.env[CONFIG_ENV] = envBefore;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("AR1. 형식 2를 협의하고, 섹션 참조가 호스트 검증을 지난다(CRLF·맨 CR 문서 포함)", () => {
    writeConfig();
    const reply = call(runInput());
    assert.equal(reply.ok, true, reply.error);
    assert.ok(SLOT_OUTPUT_SCHEMA["context.docs"].safeParse(reply.output).success);
    const diagnostics = reply.output!.diagnostics!;
    assert.equal(diagnostics.responseVersion, 2);
    assert.equal(diagnostics.indexId, indexId);
    assert.equal(diagnostics.outcome, "matched");
    assert.equal(diagnostics.fallbackFrom, undefined);
    assert.deepEqual(diagnostics.ranker, { name: "legacy", version: "keyword-legacy-1" }, "설정하지 않으면 생산자 기본 순위");
    assert.equal(diagnostics.segments, false);
    assert.match(String(diagnostics.configHash), /^[0-9a-f]{64}$/);
    assert.match(String((diagnostics.digests as Record<string, unknown>).request), /^[0-9a-f]{64}$/);
    assert.equal(diagnostics.calls, 3, "capabilities·status·search 한 번씩");
    const sections = reply.output!.sections!;
    assert.ok(sections.length >= 3, JSON.stringify(sections.map((section) => section.path)));
    for (const path of DOC_PATHS) assert.ok(sections.some((section) => section.path === path), `${path} 의 섹션이 있다`);
    for (const section of sections) {
      assert.equal(section.ref?.indexId, indexId);
      assert.match(String(section.ref?.handle), /^ak-[0-9a-f]{20}$/);
      assert.equal(section.ref?.segmentId, undefined, "조각 점수를 켜지 않았다");
      const verified = hostVerify(section);
      assert.ok(verified.ok, `${section.path} ${JSON.stringify(verified)}`);
      assert.equal(verified.ok && verified.how, "exact");
    }
    assert.ok(!sections.some((section) => section.heading.includes("BR-001")), "필수 지정 자료는 싣지 않는다(include.mandatory false)");
  });

  test("AR2. 실제 검색 참조로 만든 인계 참조 — get 형식 2로 확인하고, 해시·DB 식별·세대·커밋이 다르면 거부한다", () => {
    writeConfig();
    const first = call(runInput());
    const ref = first.output!.sections!.find((section) => section.path === FLOWS)!.ref!;
    const refs = [
      handoffOf(ref),
      handoffOf(ref, { itemSha256: "0".repeat(64) }),
      handoffOf(ref, { indexId: "0".repeat(32), required: false }),
      { ...handoffOf(ref, { generation: 99 }), itemId: `${String(ref.itemId)}`, startLine: undefined },
      handoffOf(ref, { commit: "1".repeat(40), endLine: undefined }),
      { itemId: ref.itemId, generation: ref.generation, commit: ref.commit, itemSha256: ref.itemSha256, required: true, path: undefined, indexId: undefined, startLine: undefined, endLine: undefined, sourceId: undefined },
    ];
    // 같은 (itemId, segmentId) 는 한 번만 — 거부 사례마다 따로 부른다
    const reasons = refs.map((entry) => call(runInput({ refs: [entry] })).output!.pinned![0]);
    assert.deepEqual(reasons.map((entry) => [entry.ok, entry.reason]), [
      [true, undefined],
      [false, "hash-mismatch"],
      [false, "index-mismatch"],
      [false, "generation-expired"],
      [false, "commit-mismatch"],
      [true, undefined],
    ]);
    const section = reasons[0].section!;
    assert.equal(section.ref?.pinned, true);
    assert.equal(section.ref?.indexId, indexId);
    const verified = hostVerify(section);
    assert.ok(verified.ok, JSON.stringify(verified));
  });

  test("AR3. 순위 방식 bm25·조각 점수 — 요청에 실리고, 조각 결과의 참조는 조각 범위로 호스트 검증을 지나며 인계해도 확인된다", () => {
    writeConfig({ retrieval: { ranker: "bm25", segments: true } });
    const reply = call(runInput({ requirements: [{ key: "R1", text: "환불 금액 계산 규칙과 배송비 수수료" }] }));
    assert.equal(reply.ok, true, reply.error);
    const diagnostics = reply.output!.diagnostics!;
    assert.deepEqual(diagnostics.ranker, { name: "bm25", version: "keyword-bm25-2" });
    assert.equal(diagnostics.segments, true);
    assert.equal(diagnostics.featuresDropped, undefined);
    const segmented = reply.output!.sections!.find((section) => typeof section.ref?.segmentId === "string");
    assert.ok(segmented, JSON.stringify(reply.output!.sections!.map((section) => section.ref)));
    assert.ok(String(segmented.ref!.segmentId).startsWith(`${String(segmented.ref!.itemId)}#`));
    const verified = hostVerify(segmented);
    assert.ok(verified.ok, JSON.stringify(verified));
    assert.deepEqual(verified.ok && [verified.start, verified.end], [segmented.ref!.segmentStartLine, segmented.ref!.segmentEndLine]);

    const pinned = call(runInput({ refs: [handoffOf(segmented.ref!)] })).output!.pinned![0];
    assert.equal(pinned.ok, true, pinned.reason);
    assert.equal(pinned.segmentId, segmented.ref!.segmentId);
    assert.equal(pinned.section?.ref?.segmentSha256, segmented.ref!.segmentSha256);
    const tampered = call(runInput({ refs: [handoffOf(segmented.ref!, { segmentSha256: "0".repeat(64) })] })).output!.pinned![0];
    assert.deepEqual([tampered.ok, tampered.reason, tampered.segmentId], [false, "hash-mismatch", segmented.ref!.segmentId]);
  });

  test("AR4. responseVersion 1 — 같은 생산자를 형식 1로 부르고 참조는 호스트 검증을 지난다", () => {
    writeConfig({ responseVersion: 1, retrieval: { ranker: "bm25" } });
    const reply = call(runInput());
    assert.equal(reply.ok, true, reply.error);
    const diagnostics = reply.output!.diagnostics!;
    assert.equal(diagnostics.responseVersion, 1);
    assert.equal(diagnostics.fallbackFrom, undefined);
    assert.deepEqual(diagnostics.featuresDropped, ["ranker"]);
    assert.equal(diagnostics.calls, 2, "질의마다 search 한 번");
    const sections = reply.output!.sections!;
    assert.ok(sections.length > 0);
    for (const section of sections) {
      assert.equal(section.ref?.indexId, undefined, "형식 1 결과에는 DB 식별이 없다");
      const verified = hostVerify(section);
      assert.ok(verified.ok, `${section.path} ${JSON.stringify(verified)}`);
    }
    const v1Ref = sections[0].ref!;
    const pinned = call(runInput({ refs: [{ itemId: v1Ref.itemId, generation: v1Ref.generation, commit: v1Ref.commit, itemSha256: v1Ref.itemSha256, required: true }] })).output!.pinned![0];
    assert.equal(pinned.ok, true, pinned.reason);
    const indexed = call(runInput({ refs: [{ itemId: v1Ref.itemId, generation: v1Ref.generation, commit: v1Ref.commit, itemSha256: v1Ref.itemSha256, required: true, indexId }] })).output!.pinned![0];
    assert.deepEqual([indexed.ok, indexed.reason], [false, "identity-unverifiable"]);
  });
});
