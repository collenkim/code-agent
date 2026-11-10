/**
 * master 인계 근거 진행 게이트(knowledgeGate.ts) — 작업에 고정된 required 참조가 검증 전이거나 검증에 실패하면 단계 이동(next)·계획 배정·
 * 검증 실행·코드 쓰기·선언된 명령을 막고, 재개 판정이 knowledge-blocked 로 다음 동작(재검증·재계획)을 알린다.
 *
 * 판정의 원천은 검증 기록(`.code-agent/master/knowledge/<작업>.json`)과 지금 파일이다 — 진단 로그(context.jsonl)를 지우거나 context 를
 * 부르지 않거나 새 프로세스로 다시 시작해도 판정이 같아야 한다. 어댑터는 임시 폴더의 node 스크립트(테스트 더블)이고, 응답은 시험마다
 * 파일로 준다. `CODE_AGENT_HOME` 을 임시 폴더로 돌려 실제 사용자 등록을 건드리지 않는다.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { context, knowledgeVerify, next, requireValidatable, submitPlan } from "../agent/commands";
import { KNOWLEDGE_VERIFY_TTL_MS, knowledgeGate, knowledgeRecordFile } from "../agent/knowledgeGate";
import { KNOWLEDGE_LOG } from "../agent/knowledgeContext";
import { loadActive } from "../agent/layout";
import { stateView } from "../agent/stateView";
import { writeStore } from "../agent/plugins/store";
import { start } from "./confirmedStart";
import {
  approve, ARCH, createStageRepo, DESIGN, FUNCTIONAL, git, hook, IMPACT, manifest, ORDER, PASS, PLAN, removeStageRepo, repo, REQUIREMENTS, TEST_FILE,
  TEST_SPEC, write, writeFileHook, confirmDocs,
} from "./stageFixture";

const ARCH_PATH = "doc/architecture.md";
const NOW = "2026-11-10T00:00:00.000Z";
const ACCEPTS = ["context.docs.phase", "context.docs.files", "context.docs.refs"];

let home: string;
let tools: string;
let homeBefore: string | undefined;

const replyFile = (): string => join(tools, "reply.json");
const callsFile = (): string => join(tools, "calls.txt");
const calls = (): number => (existsSync(callsFile()) ? readFileSync(callsFile(), "utf-8").split("\n").filter(Boolean).length : 0);

/** 요청 수를 세고 reply.json 대로 답한다 */
function adapterCommand(): string[] {
  const path = join(tools, "ak.js");
  writeFileSync(path, [
    "const fs=require('fs');",
    "const chunks=[];",
    "process.stdin.on('data',(c)=>chunks.push(c));",
    "process.stdin.on('end',()=>{",
    "  const req=JSON.parse(Buffer.concat(chunks).toString('utf-8'));",
    `  fs.appendFileSync(${JSON.stringify(callsFile())}, req.op+'\\n');`,
    `  const spec=JSON.parse(fs.readFileSync(${JSON.stringify(replyFile())},'utf-8'));`,
    "  process.stdout.write(JSON.stringify({protocol:'code-agent.plugin',version:'1',requestId:req.requestId,ok:true,output:spec.output}));",
    "});",
  ].join("\n"));
  return [process.execPath, path];
}

function register(accepts: string[] | null = ACCEPTS): void {
  writeStore({ version: 1, plugins: { ak: { command: adapterCommand(), slots: ["context.docs"], sendsCode: false,
    adapter: { name: "ak", version: "t", describedAt: NOW, ...(accepts ? { accepts } : {}) }, probe: { at: NOW, ok: true } } } });
}
const reply = (output: unknown): void => writeFileSync(replyFile(), JSON.stringify({ output }));

/** 작업을 시작하기 전에 지식 검색 연결을 선언한다(바꾸면 승인이 stale-manifest 가 된다) */
function declare(plugins?: Record<string, unknown>): void {
  write("code-agent.json", manifest(plugins ? { plugins } : {}));
  confirmDocs();
  git("add", "-A");
  git("commit", "-qm", "plugins");
}

// ---- 참조 ----

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const docLines = (): string[] => readFileSync(join(repo, ARCH_PATH), "utf-8").split(/\r?\n/);
const head = (): string => git("rev-parse", "HEAD");
const lineOf = (text: string): number => docLines().indexOf(text) + 1;
/** `## 주요 결정` 절(제목·본문 두 줄) */
const range = (): [number, number] => { const start = lineOf("## 주요 결정"); return [start, start + 1]; };
const itemId = (): string => `kb:${ARCH_PATH}#a${range()[0]}`;

/** 어댑터가 되찾은 섹션 — 해시는 지금 파일의 그 줄들이다 */
function found(): Record<string, unknown> {
  const [start, end] = range();
  return {
    path: ARCH_PATH, heading: "주요 결정", why: "agent-knowledge 인계 참조",
    ref: {
      engine: "agent-knowledge", itemId: itemId(), projectId: "orders", sourceId: "kb", generation: 2, commit: head(), blobSha: "a".repeat(40),
      documentSha256: "b".repeat(64), itemSha256: sha(docLines().slice(start - 1, end).join("\n")), startLine: start, endLine: end, unit: "section",
      kind: "architecture", status: "confirmed_policy", confirmed: true, declaredStatus: "confirmed_policy", pinned: true,
    },
  };
}
/** master 가 넘긴 참조 — 기본은 지금 파일과 같은 해시 */
function handed(required = true, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const ref = found().ref as Record<string, unknown>;
  return { itemId: ref.itemId, generation: ref.generation, commit: ref.commit, itemSha256: ref.itemSha256, required, ...extra };
}
/** 작업 연결(.code-agent/master/works/<id>.json)의 인계 — master 실행이 작업을 열 때 고정하는 자리 */
function handoff(refs: Record<string, unknown>[], workId = "ORD-1"): void {
  write(".code-agent/master/.gitignore", "*\n");
  write(`.code-agent/master/works/${encodeURIComponent(workId)}.json`, JSON.stringify({
    workId, links: {}, boundAt: NOW, runId: "run-1", controller: "m", runs: ["run-1"], knowledge: { version: 1, refs },
  }));
}
const okReply = (): void => reply({ sections: [], pinned: [{ itemId: itemId(), ok: true, section: found() }] });
const failReply = (reason: string): void => reply({ sections: [], pinned: [{ itemId: itemId(), ok: false, reason }] });

/** 검증 기록의 시각을 옮긴다(만료 시험) */
function ageRecord(ms: number): void {
  const file = knowledgeRecordFile(repo, "ORD-1");
  const record = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...record, at: new Date(Date.now() - ms).toISOString() }));
}

/** 분석 단계 — 01 을 써서 next 가 넘어갈 수 있는 자리 */
function toAnalysis(): void {
  start(repo, join(repo, "doc/work/ORD-1.md"));
  write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
  assert.equal(loadActive(repo)!.phase, "analysis");
}
const phase = (): string => loadActive(repo)!.phase;
const resume = () => stateView(repo).resume;

/** 새 프로세스 — 이 빌드의 CLI 를 자식으로 부른다(같은 파일만 보고 다시 판정한다) */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const result = spawnSync(process.execPath, [join(__dirname, "..", "agent", "cli.js"), ...args], {
    cwd: repo, encoding: "utf8", windowsHide: true, env: { ...env, CODE_AGENT_HOME: home, CLAUDE_PROJECT_DIR: repo, CODE_AGENT_HOST: "claude" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  createStageRepo("ca-kgate-");
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-kgate-home-")));
  tools = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-kgate-tools-")));
  homeBefore = process.env.CODE_AGENT_HOME;
  process.env.CODE_AGENT_HOME = home;
});
afterEach(() => {
  if (homeBefore === undefined) delete process.env.CODE_AGENT_HOME; else process.env.CODE_AGENT_HOME = homeBefore;
  removeStageRepo();
  for (const dir of [home, tools]) rmSync(dir, { recursive: true, force: true });
});

describe("required 실패와 우회 경로", () => {
  test("KG1. required 참조가 hash-mismatch 면 context 가 재확인을 띄운 뒤 next 가 analysis 에 머문다 — 재개 판정은 knowledge-blocked(재계획)", () => {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    toAnalysis();
    handoff([handed(true, { itemSha256: "c".repeat(64) })]);
    failReply("hash-mismatch");
    const text = context(repo);
    assert.match(text, /## 근거 재확인 필요[^\n]*\n- kb:doc\/architecture\.md#a\d+: hash-mismatch/);
    assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다 — .*재계획/);
    assert.equal(phase(), "analysis", "required 참조가 실패한 작업은 다음 단계로 가지 않는다");
    const view = stateView(repo);
    assert.equal(view.resume.code, "knowledge-blocked");
    assert.equal(view.resume.next.by, "human");
    assert.equal(view.resume.next.action, "knowledge-replan");
    assert.deepEqual(view.resume.reasons.map((reason) => reason.code), ["knowledge-hash-mismatch"]);
    const knowledge = view.knowledge as Record<string, any>;
    assert.equal(knowledge.state, "blocked");
    assert.deepEqual(knowledge.blocked.map((entry: any) => [entry.reason, entry.cause, entry.recovery]), [["hash-mismatch", "hash-mismatch", "replan"]]);
  });

  test("KG2. context 를 부르지 않아도 같은 판정 — 검증 전이면 next 를 막고 재검증(모델)으로 안내한다", () => {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    toAnalysis();
    handoff([handed()]);
    assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다 — .*code-agent knowledge verify/);
    assert.equal(phase(), "analysis");
    assert.equal(calls(), 0, "게이트는 생산자를 부르지 않는다");
    assert.deepEqual([resume().code, resume().next.by, resume().next.action], ["knowledge-blocked", "model", "knowledge-reverify"]);
    assert.deepEqual(resume().reasons.map((reason) => reason.code), ["knowledge-unverified"]);
  });

  test("KG3. 진단 로그를 지워도, 새 프로세스로 다시 시작해도 실패 판정이 남는다", () => {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    toAnalysis();
    handoff([handed(true, { itemSha256: "c".repeat(64) })]);
    failReply("hash-mismatch");
    context(repo);
    rmSync(join(repo, KNOWLEDGE_LOG), { force: true });
    assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다/);
    const restarted = cli("next");
    assert.notEqual(restarted.status, 0, restarted.stdout);
    assert.match(restarted.stderr + restarted.stdout, /다음 단계로 넘어갈 수 없습니다/);
    assert.equal(phase(), "analysis");
    const status = cli("status", "--json");
    assert.equal(JSON.parse(status.stdout).resume.code, "knowledge-blocked", status.stderr);
  });

  test("KG4. 검증 기록이 원천이다 — 기록을 지우면 다시 막고, 같은 참조의 재검증(knowledge verify)이 푼다", () => {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    toAnalysis();
    handoff([handed()]);
    okReply();
    context(repo);
    assert.equal(knowledgeGate(repo).state, "verified");
    rmSync(join(repo, KNOWLEDGE_LOG), { force: true });
    assert.equal(knowledgeGate(repo).state, "verified", "진단 로그는 근거가 아니다");
    unlinkSync(knowledgeRecordFile(repo, "ORD-1"));
    assert.equal(knowledgeGate(repo).blocked[0]?.reason, "not-verified");
    assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다/);
    const before = calls();
    assert.match(knowledgeVerify(repo), /검증됨/);
    assert.equal(calls(), before + 1, "고정된 참조만 다시 대조한다(새 검색 없음)");
    next(repo);
    assert.equal(phase(), "impact");
  });

  test("KG5. 만료 — 24시간이 지난 검증은 다시 검증해야 한다(재검증 갈래)", () => {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    toAnalysis();
    handoff([handed()]);
    okReply();
    context(repo);
    const verified = knowledgeGate(repo);
    assert.equal(verified.state, "verified");
    assert.equal(knowledgeGate(repo, process.env, Date.parse(verified.verifiedAt!) + KNOWLEDGE_VERIFY_TTL_MS + 1000).blocked[0]?.reason, "verification-expired");
    ageRecord(KNOWLEDGE_VERIFY_TTL_MS + 60_000);
    assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다 — .*code-agent knowledge verify/);
    assert.deepEqual([resume().code, resume().next.action], ["knowledge-blocked", "knowledge-reverify"]);
    assert.deepEqual(resume().reasons.map((reason) => reason.code), ["knowledge-expired"]);
    knowledgeVerify(repo);
    next(repo);
    assert.equal(phase(), "impact");
  });

  test("KG6. 검증한 뒤 문서 범위가 바뀌거나 문서가 지워지면 재계획 — 검증 기록을 다시 쓰지 않아도 지금 파일로 판정한다", () => {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    toAnalysis();
    handoff([handed()]);
    okReply();
    context(repo);
    assert.equal(knowledgeGate(repo).state, "verified");
    write(ARCH_PATH, ARCH.replace("- 식별자: Long", "- 식별자: UUID"));
    // 공통 문서 확정 게이트를 다시 통과시켜 인계 근거 게이트만 본다 — 사람이 바뀐 문서를 다시 확정해도 인계 근거는 다시 확인해야 한다
    confirmDocs();
    let gate = knowledgeGate(repo);
    assert.deepEqual(gate.blocked.map((entry) => [entry.reason, entry.cause, entry.recovery]), [["source-changed", "source-changed", "replan"]]);
    assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다/);
    rmSync(join(repo, ARCH_PATH));
    gate = knowledgeGate(repo);
    assert.deepEqual(gate.blocked.map((entry) => [entry.reason, entry.cause]), [["source-deleted", "source-deleted"]]);
    assert.equal(resume().next.action, "knowledge-replan");
  });
});

describe("연결 상태·선택 참조·다른 작업", () => {
  test("KG7. off — 생산자를 부르지 않고 required 를 adapter-off 로 그 작업만 보류한다(재검증 갈래)", () => {
    register();
    toAnalysis();
    handoff([handed()]);
    okReply();
    const text = context(repo);
    assert.equal(calls(), 0, "off 에서는 생산자를 몰래 부르지 않는다");
    assert.match(text, /- kb:doc\/architecture\.md#a\d+: adapter-off/);
    assert.throws(() => knowledgeVerify(repo), /adapter-off/);
    assert.equal(calls(), 0);
    const gate = knowledgeGate(repo);
    assert.deepEqual(gate.blocked.map((entry) => [entry.reason, entry.cause, entry.recovery]), [["adapter-off", "adapter", "reverify"]]);
    assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다/);
  });

  test("KG8. 미등록·refs 미협의 등록은 adapter-unregistered·adapter-unsupported 로 가른다", () => {
    declare({ ak: { slots: ["context.docs"] } });
    toAnalysis();
    handoff([handed()]);
    assert.throws(() => knowledgeVerify(repo), /adapter-unregistered/);
    register(["context.docs.phase"]);
    reply({ sections: [] });
    assert.throws(() => knowledgeVerify(repo), /adapter-unsupported/);
    assert.equal(knowledgeGate(repo).blocked[0]?.cause, "adapter");
  });

  test("KG9. required 가 아닌 참조의 실패는 진행을 막지 않는다 — 진단(optional)으로만 남는다", () => {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    toAnalysis();
    handoff([handed(false, { itemSha256: "c".repeat(64) })]);
    failReply("hash-mismatch");
    context(repo);
    const gate = knowledgeGate(repo);
    assert.notEqual(gate.state, "blocked");
    assert.deepEqual(gate.optional.map((entry) => entry.reason), ["hash-mismatch"]);
    next(repo);
    assert.equal(phase(), "impact");
  });

  test("KG10. 인계 없는 작업은 그대로 진행하고, 다른 작업의 인계 실패는 이 작업을 막지 않는다", () => {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    toAnalysis();
    handoff([handed(true, { itemSha256: "c".repeat(64) })], "ORD-2");
    assert.equal(knowledgeGate(repo).state, "none");
    next(repo);
    assert.equal(phase(), "impact");
    assert.notEqual(resume().code, "knowledge-blocked");
  });
});

describe("구현·검증 중의 같은 판정", () => {
  /** 인계를 고정한 채 승인까지 — 승인 해시(docsState)에 인계 해시가 들어간다 */
  function toImplementVerified(): void {
    declare({ ak: { slots: ["context.docs"] } });
    register();
    start(repo, join(repo, "doc/work/ORD-1.md"));
    handoff([handed()]);
    okReply();
    context(repo);
    write("doc/work/ORD-1/01-requirements.md", REQUIREMENTS);
    write("doc/work/ORD-1/02-analysis.md", IMPACT);
    write("doc/work/ORD-1/03-design.md", DESIGN);
    write("doc/work/ORD-1/04-functional.md", FUNCTIONAL);
    write("doc/work/ORD-1/07-test-spec.md", TEST_SPEC);
    next(repo);
    next(repo);
    next(repo);
    write("doc/work/ORD-1/plan.json", JSON.stringify(PLAN));
    submitPlan(repo, join(repo, "doc/work/ORD-1/plan.json"));
    approve();
    next(repo);
    assert.equal(phase(), "implement");
  }

  test("KG11. 승인된 계획이어도 검증이 만료되면 코드 쓰기·선언된 명령·단계 이동을 막고, 작업 문서 쓰기와 재검증은 열어 둔다", () => {
    toImplementVerified();
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined, "검증된 동안은 쓴다");
    ageRecord(KNOWLEDGE_VERIFY_TTL_MS + 60_000);
    assert.match(writeFileHook(`${ORDER}/domain/Order.java`) ?? "", /코드를 쓸 수 없습니다 — .*code-agent knowledge verify/);
    assert.match(hook("Bash", { command: PASS.join(" ") }) ?? "", /선언된 명령을 돌릴 수 없습니다/);
    assert.equal(writeFileHook("doc/work/ORD-1/questions.md"), undefined, "작업 폴더 문서는 쓴다");
    write(`${ORDER}/domain/Order.java`, "class Order {}\n");
    assert.throws(() => next(repo), /다음 단계로 넘어갈 수 없습니다/);
    knowledgeVerify(repo);
    assert.equal(writeFileHook(`${ORDER}/domain/Order.java`), undefined);
    next(repo);
    write(`${ORDER}/repository/OrderRepository.java`, "interface OrderRepository {}\n");
    next(repo);
    write(TEST_FILE, "// TC-1 · TC-2\nclass OrderTest {}\n");
    next(repo);
    assert.equal(phase(), "check");
    ageRecord(KNOWLEDGE_VERIFY_TTL_MS + 60_000);
    assert.throws(() => requireValidatable(repo, "check"), /검증·반영을 진행할 수 없습니다/);
    knowledgeVerify(repo);
    assert.doesNotThrow(() => requireValidatable(repo, "check"));
  });
});
