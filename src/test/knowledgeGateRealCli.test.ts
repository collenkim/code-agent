/**
 * 실제 agent-knowledge CLI 와 진행 게이트의 종단 — 임시 code-agent 작업 저장소의 등록 문서를 실제 생산자로 임시 DB 에 색인하고, 생산자
 * 형식 2 검색이 낸 항목 참조(ItemRef)를 그대로 master 인계(형식 2)로 작업에 고정한 뒤 `code-agent knowledge verify`(내장 어댑터 →
 * 생산자 get 형식 2 → 호스트의 현재 파일 대조 → 검증 기록 → 게이트)를 돈다. 변조한 해시·다른 DB 식별·지워진 세대는 next 를 막고
 * 원인 갈래를 가른다.
 *
 * 생산자 위치는 `AGENT_KNOWLEDGE_DIST` → `C:/IdeaProjects/agent-knowledge/dist` 순이고 `src/cli/main.js` 가 없으면 건너뛴다. 원본 설정·DB·
 * 어댑터 설정·`CODE_AGENT_HOME` 이 모두 임시 폴더다(사용자 설정·agent-knowledge 저장소를 건드리지 않는다). AI 호스트는 부르지 않는다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { context, knowledgeVerify, next } from "../agent/commands";
import { knowledgeGate } from "../agent/knowledgeGate";
import { loadActive } from "../agent/layout";
import { AGENT_KNOWLEDGE_ACCEPTS, producerEnv } from "../agent/plugins/agentKnowledge";
import { writeStore } from "../agent/plugins/store";
import { stateView } from "../agent/stateView";
import { start } from "./confirmedStart";
import { confirmDocs, createStageRepo, git, manifest, removeStageRepo, repo, REQUIREMENTS, write } from "./stageFixture";

const DIST = process.env.AGENT_KNOWLEDGE_DIST ?? "C:/IdeaProjects/agent-knowledge/dist";
const MAIN = resolve(DIST, "src", "cli", "main.js");
const AVAILABLE = existsSync(MAIN);
const ARCH_PATH = "doc/architecture.md";

let root: string;
let sources: string;
let db: string;
let homeBefore: string | undefined;

/** 생산자를 직접 부른다(색인·참조 얻기) — 상속된 AGENT_KNOWLEDGE_* 를 지운 환경으로 */
function producer(args: string[], body?: unknown): { status: number | null; json: Record<string, any> } {
  const ran = spawnSync(process.execPath, [MAIN, ...args, ...(body ? ["--request", "-"] : [])], {
    encoding: "utf-8", env: producerEnv(process.env), timeout: 60_000, input: body ? JSON.stringify(body) : "",
  });
  return { status: ran.status, json: JSON.parse(ran.stdout) as Record<string, any> };
}

/** 지금 HEAD 를 색인한다(새 세대) */
function index(): void {
  const indexed = producer(["index", "--config", sources, "--db", db, "--response-version", "2", "--quiet"]);
  assert.equal(indexed.status, 0, JSON.stringify(indexed.json));
}

/** 생산자 형식 2 검색이 낸 `## 주요 결정` 절의 항목 참조 — master 가 그대로 넘기는 것 */
function producerRef(): Record<string, unknown> {
  const found = producer(["search", "--config", sources, "--db", db], {
    responseVersion: 2, profile: "code", queries: [{ key: "R1", text: "주요 결정 식별자 Long" }], scope: { projects: ["orders"] },
    filters: { documents: [ARCH_PATH] }, include: { mandatory: false }, limit: 5,
  });
  assert.ok([0, 3].includes(found.status ?? -1), JSON.stringify(found.json));
  const item = (found.json.items as { ref: Record<string, unknown> }[]).find((entry) => String(entry.ref.itemId).includes("#") && entry.ref.path === ARCH_PATH && /결정/.test(String(entry.ref.itemId)));
  assert.ok(item, `주요 결정 항목이 없다: ${JSON.stringify(found.json.items?.map((entry: any) => entry.ref.itemId))}`);
  return item.ref;
}

/** 작업 연결의 인계(형식 2) — 생산자 ref 17개 필드 + required */
function handoff(refs: Record<string, unknown>[]): void {
  write(".code-agent/master/.gitignore", "*\n");
  write(".code-agent/master/works/ORD-1.json", JSON.stringify({
    workId: "ORD-1", links: {}, boundAt: new Date().toISOString(), runId: "run-1", controller: "m", runs: ["run-1"], knowledge: { version: 2, refs },
  }));
}

describe("진행 게이트 — 실제 agent-knowledge CLI(형식 2) 종단", { skip: AVAILABLE ? false : `agent-knowledge 빌드가 없습니다: ${MAIN}` }, () => {
  beforeEach(() => {
    createStageRepo("ca-kgate-real-");
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-kgate-real-out-")));
    homeBefore = process.env.CODE_AGENT_HOME;
    process.env.CODE_AGENT_HOME = join(root, "home");
    mkdirSync(join(root, "db"));
    db = join(root, "db", "knowledge.sqlite");
    sources = join(root, "sources.json");
    writeFileSync(sources, JSON.stringify({
      schemaVersion: 1, database: { path: db.replace(/\\/g, "/") }, index: { retainGenerations: 2, maxFileBytes: 65536 },
      sources: [{ id: "orders", project: "orders", path: repo.replace(/\\/g, "/"), ref: "HEAD", include: ["doc/**/*.md"], exclude: [], defaultKind: "reference",
        rules: [{ match: ARCH_PATH, kind: "architecture" }] }],
    }));
    const config = join(root, "adapter.json");
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, command: [process.execPath, MAIN], sourcesConfig: sources, db, projects: [{ root: repo, project: "orders" }] }));
    // 내장 어댑터를 이 빌드의 CLI 로 등록한다(code-agent plugin add 가 쓰는 것과 같은 명령 꼴)
    const at = new Date().toISOString();
    writeStore({ version: 1, plugins: { "agent-knowledge": {
      command: [process.execPath, join(__dirname, "..", "agent", "cli.js"), "plugin", "agent-knowledge", "--config", config], slots: ["context.docs"], sendsCode: false,
      adapter: { name: "agent-knowledge", version: "test", describedAt: at, accepts: [...AGENT_KNOWLEDGE_ACCEPTS] }, probe: { at, ok: true },
    } } });
    write("code-agent.json", manifest({ plugins: { "agent-knowledge": { slots: ["context.docs"] } } }));
    confirmDocs();
    git("add", "-A");
    git("commit", "-qm", "plugins");
    index();
    start(repo, join(repo, "doc/work/ORD-1.md"));
    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
  });
  afterEach(() => {
    if (homeBefore === undefined) delete process.env.CODE_AGENT_HOME; else process.env.CODE_AGENT_HOME = homeBefore;
    removeStageRepo();
    rmSync(root, { recursive: true, force: true });
  });

  test("RG1. 생산자 ItemRef 를 그대로 인계하면 knowledge verify 가 get 형식 2·현재 파일 대조로 확인하고 next 가 넘어간다", () => {
    const ref = producerRef();
    handoff([{ ...ref, required: true }]);
    assert.equal(knowledgeGate(repo).blocked[0]?.reason, "not-verified");
    assert.match(knowledgeVerify(repo), /검증됨/);
    const gate = knowledgeGate(repo);
    assert.equal(gate.state, "verified");
    assert.equal(gate.version, 2);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "impact");
    // context 도 같은 참조를 같은 결과로 대조해 기록을 갱신한다(인계 블록에 확인된 근거로 싣는다)
    assert.match(context(repo), /## 인계받은 지식 근거/);
    assert.equal(knowledgeGate(repo).state, "verified");
  });

  test("RG2. 변조한 해시·다른 DB 식별·지워진 세대는 생산자가 거부하고 원인 갈래(hash-mismatch·identity-mismatch·expired)로 next 를 막는다", () => {
    const ref = producerRef();
    const cases: [Record<string, unknown>, string, string][] = [
      [{ itemSha256: "0".repeat(64) }, "hash-mismatch", "hash-mismatch"],
      [{ indexId: "0123456789abcdef0123456789abcdef" }, "index-mismatch", "identity-mismatch"],
      [{ indexGeneration: 99 }, "generation-expired", "expired"],
    ];
    for (const [change, reason, cause] of cases) {
      handoff([{ ...ref, ...change, required: true }]);
      assert.throws(() => knowledgeVerify(repo), new RegExp(reason));
      const gate = knowledgeGate(repo);
      assert.deepEqual(gate.blocked.map((entry) => [entry.reason, entry.cause, entry.recovery]), [[reason, cause, "replan"]], JSON.stringify(change));
      assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다/);
      assert.equal(stateView(repo).resume.code, "knowledge-blocked");
      assert.equal(stateView(repo).resume.next.action, "knowledge-replan");
    }
    assert.equal(loadActive(repo)!.phase, "analysis");
  });

  test("RG3. 선택 참조(required:false)의 변조는 진단으로만 남고 진행을 막지 않는다", () => {
    const ref = producerRef();
    handoff([{ ...ref, itemSha256: "0".repeat(64), required: false }]);
    knowledgeVerify(repo);
    const gate = knowledgeGate(repo);
    assert.notEqual(gate.state, "blocked");
    assert.deepEqual(gate.optional.map((entry) => entry.reason), ["hash-mismatch"]);
    next(repo);
    assert.equal(loadActive(repo)!.phase, "impact");
  });
});
