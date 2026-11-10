/**
 * master 지식 참조 인계 — hello 의 knowledge 알림, submit `knowledge` 의 엄격 검사·수락 조건·저장, 작업 고정(bindWork)과 이어 실행의 복사,
 * context 가 읽는 인계 조회(managedKnowledge). 감독 프로세스는 띄우지 않는다(spawn 을 막는다) — 실행 자체는 masterRuns.test.ts 가 본다.
 * 플러그인 등록은 `CODE_AGENT_HOME` 을 임시 폴더로 돌린 스토어에 직접 쓴다(어댑터를 실제로 부르지 않는다). 사람의 TTY 확인(enable)은
 * withInteraction 으로 흉내낸다.
 */
import assert from "node:assert/strict";
import childProcess = require("node:child_process");
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { loadManifest, type Slot } from "../core/manifest";
import { prepareConsent } from "../agent/consent";
import { init } from "../agent/init";
import { humanSigningMessage } from "../agent/interactionHuman";
import { currentInteractions } from "../agent/interactions";
import { drainInteraction } from "../agent/interactionService";
import { knowledgeRecordFile } from "../agent/knowledgeGate";
import { saveActive } from "../agent/layout";
import { masterEnable } from "../agent/master/admin";
import { call } from "../agent/master/control";
import { observeProgress } from "../agent/master/observe";
import { knowledgeDigest, knowledgeHandoffOf, MAX_KNOWLEDGE_REFS, type RequestEnvelope } from "../agent/master/protocol";
import type { KnowledgeHandoff } from "../agent/plugins/protocol";
import { MASTER_RUN_ENV } from "../agent/master/runGuard";
import { listRuns, readBinding, readCommand, readRun, readWorkBinding, writeBinding, writeRunRecord, writeWorkBinding, type RunRecord } from "../agent/master/store";
import { managedKnowledge } from "../agent/master/workKnowledge";
import { writeStore } from "../agent/plugins/store";
import { withInteraction } from "../agent/tty";
import { gitFixture, setupConsentProject, writeFixture } from "./consentFixture";
import { setCaller } from "./reviewFixture";
import { confirmForTest } from "./confirmedStart";
import { stateView } from "../agent/stateView";

const tty = <T>(run: () => T): T => withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "모의 TTY(시험)" }), ask: () => "n" }, run);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHA = "a".repeat(64);
const ref = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ itemId: `orders:doc/architecture.md#rule-${n}`, generation: 3, commit: COMMIT, itemSha256: SHA, ...extra });
/** 두 번째 참조는 required 를 끈다 — 첫 번째는 생략(기본 true) */
const handoff = (refs: Record<string, unknown>[] = [ref(1), ref(2, { required: false })]): Record<string, unknown> => ({ version: 1, refs });
const STORED = { version: 1, refs: [{ ...ref(1), required: true }, { ...ref(2), required: false }] };
/** 형식 2 — 생산자 ItemRef 필드 그대로(+ required) */
const INDEX = "0123456789abcdef0123456789abcdef";
const refV2 = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  indexId: INDEX, indexGeneration: 3, itemId: `orders:doc/architecture.md#rule-${n}`, itemSha256: SHA, commit: COMMIT, sourceId: "orders",
  path: "doc/architecture.md", startLine: 3, endLine: 5, ...extra,
});
const handoffV2 = (refs: Record<string, unknown>[] = [refV2(1), refV2(2, { required: false })]): Record<string, unknown> => ({ version: 2, refs });
/** 실패 사유(detail.reason) — 던지지 않으면 undefined */
function reasonOf(run: () => unknown): string | undefined {
  try { run(); return undefined; } catch (error) { return ((error as { detail?: { reason?: string } }).detail ?? {}).reason; }
}
/** 진행 게이트 시험의 작업 지시서 */
const W1_SPEC = "---\nkind: feature\nid: W-1\ntitle: 주문 등록\ntarget: app\n---\n\n주문을 등록한다.\n";
/** hello.knowledge.refs — versions 는 지금 받는 인계 형식(형식 2는 색인 식별 협의가 있을 때만), supportedVersions 는 이 빌드가 읽는 형식 */
const refsCap = (accepted: boolean, versions: number[] = [1]): Record<string, unknown> =>
  ({ supported: true, accepted, max: 20, versions, supportedVersions: [1, 2], maxBytes: 32 * 1024, requiredGate: true, requiredDefault: true, scope: "registered-docs" });
/** submit 응답의 인계 접수 — 받았다(stored)와 검증됐다(verification)를 가른다 */
const receipt = (stored: unknown = STORED, verification = "pending"): Record<string, unknown> =>
  ({ refs: (stored as KnowledgeHandoff).refs.length, version: (stored as KnowledgeHandoff).version, digest: knowledgeDigest(stored as KnowledgeHandoff), receipt: "stored", verification });

let root: string;
let outside: string;
const outside_ = (): string => outside;
let token: string;
let homeBefore: string | undefined;
let restoreCaller: () => void;
let seq = 0;
const cid = (): string => `k-${++seq}-${Date.now()}`;

/** code-agent.json 의 plugins 선언(없으면 매니페스트 없이) — 커밋까지 한 저장소에 연동을 켠다 */
function project(plugins?: Record<string, unknown>, options: { enable?: boolean; manifest?: string } = {}): void {
  gitFixture(root, "init", "-q", "-b", "master");
  gitFixture(root, "config", "user.name", "t");
  gitFixture(root, "config", "user.email", "t@t");
  gitFixture(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "x\n");
  // 인계 참조의 원본은 이 저장소의 등록 문서여야 받는다(수신 범위)
  writeFixture(root, "doc/architecture.md", "# 아키텍처\n\n## 규칙\n\n주문은 승인 뒤 확정한다.\n");
  // Claude 관리 실행은 Claude 설치 기록과 hook 이 있어야 접수한다
  init(root, { host: "claude" });
  if (options.manifest !== undefined) writeFileSync(join(root, "code-agent.json"), options.manifest);
  else if (plugins) {
    writeFileSync(join(root, "code-agent.json"), JSON.stringify({
      language: "javascript", sourceExtensions: [".js"], domainBase: "src", domainRoots: ["app"],
      stages: [{ key: "code", title: "코드", template: "01-code.md", scope: "project", outputDirs: ["src"] }], plugins,
    }, null, 2));
    loadManifest(root);
  }
  gitFixture(root, "add", "-A");
  gitFixture(root, "commit", "-qm", "init");
  if (options.enable === false) return;
  const tokenFile = join(outside, `token-${++seq}`);
  tty(() => masterEnable(root, { controller: "m1", tokenOut: tokenFile }));
  token = readFileSync(tokenFile, "utf8").trim();
}
/** 이 PC 의 등록 — accepts 는 describe 가 받겠다고 한 선택 입력 */
function register(accepts?: string[], slots: Slot[] = ["context.docs"]): void {
  const at = new Date().toISOString();
  writeStore({ version: 1, plugins: { "agent-knowledge": { command: [process.execPath, "-e", "0"], slots, sendsCode: false,
    adapter: { name: "agent-knowledge", version: "test", describedAt: at, ...(accepts ? { accepts } : {}) }, probe: { at, ok: true } } } });
}
const ENABLED = { "agent-knowledge": { slots: ["context.docs"] } };
const SHADOW = { "agent-knowledge": { shadow: ["context.docs"] } };

type Res = ReturnType<typeof call> & { result?: any };
function send(type: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Res {
  return call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type, controller: "m1", generation: 1, token, payload, ...extra })) as Res;
}
const hello = (): Res => call(root, JSON.stringify({ protocol: "code-agent.master", version: 1, type: "hello" })) as Res;
const runFile = (runId: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, ".code-agent", "master", "runs", `${runId}.json`), "utf8"));

beforeEach(() => {
  restoreCaller = setCaller(undefined);
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-master-knowledge-")));
  outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-master-knowledge-out-")));
  homeBefore = process.env.CODE_AGENT_HOME;
  process.env.CODE_AGENT_HOME = join(outside, "home");
  // 감독 프로세스(와 hello 의 Codex 판정 분리 프로세스)를 띄우지 않는다 — 접수 기록까지만 본다
  mock.method(childProcess, "spawn", () => Object.assign(new EventEmitter(), { unref() {} }));
});
afterEach(() => {
  mock.restoreAll();
  restoreCaller();
  if (homeBefore === undefined) delete process.env.CODE_AGENT_HOME; else process.env.CODE_AGENT_HOME = homeBefore;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("hello — 지식 참조를 받는가", () => {
  test("선언이 없으면 off·accepted false — 연동 전 hello 도 같다", () => {
    project(undefined, { enable: false });
    const before = hello();
    assert.equal(before.ok, true);
    assert.equal(before.result.knowledge.schemaVersion, 1);
    assert.equal(before.result.knowledge.mode, "off");
    assert.deepEqual(before.result.knowledge.refs, refsCap(false));
    assert.equal(MAX_KNOWLEDGE_REFS, 20);
    assert.deepEqual(before.result.knowledge.gate, {
      resume: "knowledge-blocked", actions: ["knowledge-reverify", "knowledge-replan"],
      causes: ["unverified", "hash-mismatch", "identity-mismatch", "expired", "source-changed", "source-deleted", "scope", "adapter"],
      ttlSeconds: 86400, command: { type: "knowledge", actions: ["verify", "replace"] },
    }, "진행 게이트의 재개 코드·원인·회복 명령을 알린다");
    tty(() => masterEnable(root, { controller: "m1", tokenOut: join(outside, "late.token") }));
    assert.deepEqual(hello().result.knowledge.refs, refsCap(false));
  });

  test("context.docs 를 slots 로 선언하고 accepts 에 refs 를 적어 등록하면 enabled·accepted — 등록·협의가 빠지면 받지 않는다", () => {
    project(ENABLED);
    assert.equal(hello().result.knowledge.mode, "enabled");
    assert.deepEqual(hello().result.knowledge.refs, refsCap(false), "이 PC 에 등록이 없다");
    register();
    assert.equal(hello().result.knowledge.refs.accepted, false, "accepts 없는 등록(이전 어댑터)에는 참조를 보내지 않는다");
    register(["context.docs.phase", "context.docs.files"]);
    assert.equal(hello().result.knowledge.refs.accepted, false);
    register(["context.docs.phase", "context.docs.refs"], ["candidates.rank"]);
    assert.equal(hello().result.knowledge.refs.accepted, false, "그 자리로 등록하지 않았다");
    register(["context.docs.phase", "context.docs.files", "context.docs.refs"]);
    const knowledge = hello().result.knowledge;
    assert.equal(knowledge.mode, "enabled");
    assert.deepEqual(knowledge.refs, refsCap(true, [1]), "색인 식별 협의가 없으면 형식 1만 받는다");
    assert.ok(!JSON.stringify(knowledge).includes("agent-knowledge"), "플러그인 이름·명령은 알리지 않는다");
    register(["context.docs.phase", "context.docs.files", "context.docs.refs", "context.docs.refs.indexed"]);
    assert.deepEqual(hello().result.knowledge.refs, refsCap(true, [1, 2]), "색인 식별을 협의한 등록은 형식 2도 받는다");
    register(["context.docs.refs.indexed"]);
    assert.deepEqual(hello().result.knowledge.refs, refsCap(false), "refs 협의 없이 색인 식별만으로는 받지 않는다");
  });

  test("shadow 선언은 mode shadow 이고 참조를 받지 않는다", () => {
    project(SHADOW);
    register(["context.docs.refs"]);
    assert.equal(hello().result.knowledge.mode, "shadow");
    assert.deepEqual(hello().result.knowledge.refs, refsCap(false));
  });

  test("code-agent.json 을 읽지 못하면 off 로 알린다", () => {
    project(undefined, { manifest: "{ 형식 오류" });
    register(["context.docs.refs"]);
    const res = hello();
    assert.equal(res.ok, true);
    assert.equal(res.result.knowledge.mode, "off");
    assert.equal(res.result.knowledge.refs.accepted, false);
  });
});

describe("knowledgeHandoffOf — 엄격 검사", () => {
  test("꼴이 맞으면 required 기본값을 채워 돌려주고, 없으면 undefined", () => {
    assert.equal(knowledgeHandoffOf(undefined), undefined);
    assert.deepEqual(knowledgeHandoffOf(handoff()), STORED);
    const twenty = Array.from({ length: 20 }, (_, index) => ref(index));
    assert.equal(knowledgeHandoffOf(handoff(twenty))!.refs.length, 20);
  });

  test("모르는 키·형식·범위·중복은 invalid-request", () => {
    const bad: [string, unknown][] = [
      ["객체 아님", [handoff()]], ["null", null],
      ["모르는 최상위 키", { ...handoff(), extra: 1 }], ["version 2", { ...handoff(), version: 2 }], ["version 없음", { refs: [ref(1)] }],
      ["refs 없음", { version: 1 }], ["빈 refs", handoff([])], ["21개", handoff(Array.from({ length: 21 }, (_, index) => ref(index)))],
      ["참조가 객체 아님", handoff(["x" as never])],
      ["모르는 참조 키", handoff([ref(1, { content: "본문" })])], ["itemId 없음", handoff([{ generation: 1, commit: COMMIT, itemSha256: SHA }])],
      ["itemId 구분자 없음", handoff([ref(1, { itemId: "orders-doc" })])], ["itemId '#' 없음", handoff([ref(1, { itemId: "orders:doc/a.md" })])],
      ["itemId 제어 문자", handoff([ref(1, { itemId: "orders:doc/a.md#x\n" })])], ["itemId 공백뿐", handoff([ref(1, { itemId: "   " })])],
      ["itemId 513자", handoff([ref(1, { itemId: `o:${"d".repeat(509)}#x` })])],
      ["generation 0", handoff([ref(1, { generation: 0 })])], ["generation 소수", handoff([ref(1, { generation: 1.5 })])],
      ["generation 문자열", handoff([ref(1, { generation: "3" })])], ["generation 안전 정수 밖", handoff([ref(1, { generation: 2 ** 53 })])],
      ["commit 대문자", handoff([ref(1, { commit: COMMIT.toUpperCase() })])], ["commit 짧음", handoff([ref(1, { commit: "abc1234" })])],
      ["itemSha256 16진 아님", handoff([ref(1, { itemSha256: "g".repeat(64) })])], ["itemSha256 길이", handoff([ref(1, { itemSha256: "a".repeat(63) })])],
      ["required 문자열", handoff([ref(1, { required: "yes" })])], ["itemId 중복", handoff([ref(1), ref(1, { generation: 4 })])],
    ];
    for (const [name, value] of bad) {
      assert.throws(() => knowledgeHandoffOf(value), (error: { code?: string }) => error.code === "invalid-request", name);
    }
  });
});

describe("knowledgeHandoffOf — 형식 2와 상한", () => {
  test("생산자 ItemRef(핸들·프로젝트·문서 해시·blob·빈 분할 필드)를 그대로 받고 required 기본값을 채운다 — 분할 참조도 받는다", () => {
    const producerRef = { ...refV2(1), handle: "ak-0123456789abcdef0123", projectId: "orders", documentSha256: SHA, blobSha: COMMIT,
      segmentId: null, segmentSha256: null, segmentStartLine: null, segmentEndLine: null };
    const parsed = knowledgeHandoffOf({ version: 2, refs: [producerRef] })!;
    assert.equal(parsed.version, 2);
    assert.equal(parsed.refs[0].required, true);
    assert.equal((parsed.refs[0] as unknown as Record<string, unknown>).segmentId, undefined, "빈 분할 필드는 남기지 않는다");
    const segment = refV2(1, { segmentId: "orders:doc/architecture.md#rule-1#2", segmentSha256: "b".repeat(64), segmentStartLine: 4, segmentEndLine: 5 });
    const both = knowledgeHandoffOf(handoffV2([refV2(1), segment]))!;
    assert.equal(both.refs.length, 2, "같은 항목의 전체와 분할은 다른 참조다");
    assert.ok(knowledgeHandoffOf({ version: 2, refs: [refV2(1, { commit: "c".repeat(64), blobSha: "d".repeat(64) })] }), "SHA-256 저장소의 64자리 커밋");
  });

  test("형식·판·상한·중복 오류는 invalid-request 이고 detail.reason 으로 가른다 — 형식 1 파서는 엄격하게 남는다", () => {
    const cases: [string, unknown, string][] = [
      ["형식 3", { version: 3, refs: [refV2(1)] }, "knowledge-version"],
      ["형식 2에 형식 1 참조", { version: 2, refs: [ref(1)] }, "knowledge-format"],
      ["형식 1에 형식 2 필드", handoff([ref(1, { indexId: INDEX })]), "knowledge-format"],
      ["indexId 없음", handoffV2([refV2(1, { indexId: undefined })]), "knowledge-format"],
      ["indexId 꼴", handoffV2([refV2(1, { indexId: "X".repeat(32) })]), "knowledge-format"],
      ["itemId 가 원본·경로와 다름", handoffV2([refV2(1, { sourceId: "billing" })]), "knowledge-format"],
      ["경로가 저장소 밖", handoffV2([refV2(1, { path: "../doc/architecture.md", itemId: "orders:../doc/architecture.md#x" })]), "knowledge-format"],
      ["줄 범위 거꾸로", handoffV2([refV2(1, { startLine: 6 })]), "knowledge-format"],
      ["분할이 원본 범위 밖", handoffV2([refV2(1, { segmentId: "orders:doc/architecture.md#rule-1#1", segmentSha256: SHA, segmentStartLine: 1, segmentEndLine: 4 })]), "knowledge-format"],
      ["분할 ID 접두사", handoffV2([refV2(1, { segmentId: "orders:doc/other.md#x#1", segmentSha256: SHA, segmentStartLine: 3, segmentEndLine: 4 })]), "knowledge-format"],
      ["분할 해시 없이 분할 범위", handoffV2([refV2(1, { segmentStartLine: 3, segmentEndLine: 4 })]), "knowledge-format"],
      ["모르는 키", handoffV2([refV2(1, { excerpt: "본문" })]), "knowledge-format"],
      ["21개", handoffV2(Array.from({ length: 21 }, (_, index) => refV2(index))), "knowledge-limit"],
      ["같은 항목·분할 중복", handoffV2([refV2(1), refV2(1, { required: false })]), "knowledge-duplicate"],
    ];
    for (const [name, value, reason] of cases) assert.equal(reasonOf(() => knowledgeHandoffOf(value)), reason, name);
    // 32KiB — 개수 상한 안이라도 정본 JSON 이 크면 거부한다
    const path = `doc/${"a".repeat(480)}.md`;
    const big = Array.from({ length: 20 }, (_, index) => {
      const itemId = `orders:${path}#r${index}`;
      return refV2(index, { itemId, path, segmentId: `${itemId}#${"s".repeat(599 - itemId.length - 1)}`, segmentSha256: SHA, segmentStartLine: 3, segmentEndLine: 4 });
    });
    assert.equal(reasonOf(() => knowledgeHandoffOf(handoffV2(big))), "knowledge-too-large");
  });
});

describe("submit knowledge — 수락 조건과 저장", () => {
  test("형식 2는 색인 식별을 협의한 등록에만 받는다 — 응답은 형식·정본 해시, 같은 commandId 재전송은 replayed, 다른 참조는 conflict", () => {
    project(ENABLED);
    register(["context.docs.refs"]);
    const plain = send("submit", { prompt: "시작", knowledge: handoffV2() }, { commandId: cid() });
    assert.equal(plain.error?.code, "invalid-request", "공지하지 않은 형식은 수신 검사의 knowledge-version 이다");
    assert.equal((plain.error?.detail as { reason?: string }).reason, "knowledge-version");
    register(["context.docs.refs", "context.docs.refs.indexed"]);
    const id = cid(), payload = { prompt: "시작", knowledge: handoffV2() };
    const accepted = send("submit", payload, { commandId: id, expect: { work: null } });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    const stored = knowledgeHandoffOf(handoffV2())!;
    assert.deepEqual(accepted.result.knowledge, receipt(stored));
    assert.equal(accepted.result.knowledge.version, 2, "인계 형식(생산자 응답 형식과 별개)");
    assert.deepEqual(readRun(root, accepted.result.runId)!.knowledge, stored);
    const replay = send("submit", payload, { commandId: id, expect: { work: null } });
    assert.equal(replay.replayed, true);
    assert.equal(send("submit", { ...payload, knowledge: handoffV2([refV2(7)]) }, { commandId: id, expect: { work: null } }).error?.code, "conflict");
    assert.equal(listRuns(root).length, 1);
  });

  test("등록 문서 밖·대응 프로젝트 밖 참조는 받기 전에 사유와 함께 거부한다 — 실행을 쓰지 않는다", () => {
    project(ENABLED);
    register(["context.docs.refs", "context.docs.refs.indexed"]);
    const outside = send("submit", { prompt: "시작", knowledge: handoff([ref(1), ref(2, { itemId: "orders:doc/other.md#rule-2" })]) }, { commandId: cid() });
    assert.equal(outside.error?.code, "invalid-request");
    assert.deepEqual(outside.error?.detail, { reason: "knowledge-scope", refs: [{ itemId: "orders:doc/other.md#rule-2", reason: "not-in-docs" }] });
    // 어댑터 설정이 이 저장소를 orders 프로젝트(원본 orders)에 대응시킨다
    const config = join(outside_(), "agent-knowledge.json");
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, command: ["agent-knowledge"], projects: [{ root, project: "orders", sources: ["orders"] }] }));
    const before = process.env.CODE_AGENT_KNOWLEDGE_CONFIG;
    process.env.CODE_AGENT_KNOWLEDGE_CONFIG = config;
    try {
      const project_ = send("submit", { prompt: "시작", knowledge: handoffV2([refV2(1, { projectId: "billing" })]) }, { commandId: cid() });
      assert.deepEqual(project_.error?.detail, { reason: "knowledge-scope", refs: [{ itemId: "orders:doc/architecture.md#rule-1", reason: "out-of-scope" }] });
      const source = send("submit", { prompt: "시작", knowledge: handoff([ref(1, { itemId: "kb:doc/architecture.md#rule-1" })]) }, { commandId: cid() });
      assert.deepEqual(source.error?.detail, { reason: "knowledge-scope", refs: [{ itemId: "kb:doc/architecture.md#rule-1", reason: "out-of-scope" }] });
      assert.equal(listRuns(root).length, 0);
      const inside = send("submit", { prompt: "시작", knowledge: handoffV2([refV2(1, { projectId: "orders" })]) }, { commandId: cid() });
      assert.equal(inside.ok, true, JSON.stringify(inside.error));
    } finally {
      if (before === undefined) delete process.env.CODE_AGENT_KNOWLEDGE_CONFIG; else process.env.CODE_AGENT_KNOWLEDGE_CONFIG = before;
    }
  });

  test("받지 않는 프로젝트(off·shadow·협의 없음)에 참조를 보내면 invalid-state 이고 실행을 쓰지 않는다", () => {
    project(undefined);
    const off = send("submit", { prompt: "시작", knowledge: handoff() }, { commandId: cid() });
    assert.equal(off.error?.code, "invalid-state");
    assert.deepEqual(off.error?.detail, { reason: "knowledge-refs-not-accepted", mode: "off" });
    assert.equal(listRuns(root).length, 0, "실행 기록이 없다");
    assert.equal(readCommand(root, off.commandId!)?.status, "rejected", "명령 기록은 거부로 남는다");
  });

  test("shadow·enabled 지만 refs 를 협의하지 않은 등록도 detail.mode 와 함께 거부한다", () => {
    project(SHADOW);
    register(["context.docs.refs"]);
    assert.deepEqual(send("submit", { prompt: "시작", knowledge: handoff() }, { commandId: cid() }).error?.detail, { reason: "knowledge-refs-not-accepted", mode: "shadow" });
    rmSync(join(root, "code-agent.json"));
    writeFileSync(join(root, "code-agent.json"), JSON.stringify({ domainBase: "src", stages: [{ key: "code", title: "코드", template: "01-code.md", scope: "project", outputDirs: ["src"] }], plugins: ENABLED }));
    gitFixture(root, "commit", "-qam", "enabled");
    register(["context.docs.phase"]);
    const rejected = send("submit", { prompt: "시작", knowledge: handoff() }, { commandId: cid() });
    assert.equal(rejected.error?.code, "invalid-state");
    assert.deepEqual(rejected.error?.detail, { reason: "knowledge-refs-not-accepted", mode: "enabled" });
    assert.equal(listRuns(root).length, 0);
  });

  test("꼴이 틀린 knowledge 는 수락 여부보다 먼저 invalid-request — 실행을 쓰지 않는다", () => {
    project(ENABLED);
    register(["context.docs.refs"]);
    for (const knowledge of [{ ...handoff(), extra: true }, handoff([ref(1, { note: "x" })]), handoff([ref(1, { commit: "zz" })]), handoff([ref(1, { generation: 0 })]),
      handoff(Array.from({ length: 21 }, (_, index) => ref(index))), handoff([ref(1), ref(1)]), { ...handoff(), version: 2 }]) {
      assert.equal(send("submit", { prompt: "시작", knowledge }, { commandId: cid() }).error?.code, "invalid-request", JSON.stringify(knowledge));
    }
    assert.equal(listRuns(root).length, 0);
  });

  test("받는 프로젝트는 실행 기록에 인계를 남기고, 같은 commandId·내용의 재전송은 replayed, 다른 참조는 conflict", () => {
    project(ENABLED);
    register(["context.docs.phase", "context.docs.files", "context.docs.refs"]);
    const id = cid(), payload = { prompt: "주문 정책을 따른다", knowledge: handoff() };
    const accepted = send("submit", payload, { commandId: id, expect: { work: null } });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    assert.deepEqual(accepted.result.knowledge, receipt(), "받았다(stored)와 검증(pending)을 가른다");
    const run = readRun(root, accepted.result.runId)!;
    assert.deepEqual(run.knowledge, STORED, "required 생략은 true 로 저장한다");
    assert.doesNotMatch(readFileSync(join(root, ".code-agent", "master", "runs", `${run.runId}.prompt.md`), "utf8"), /orders:doc/, "참조는 프롬프트에 싣지 않는다");
    const replay = send("submit", payload, { commandId: id, expect: { work: null } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.runId, run.runId);
    assert.equal(send("submit", { ...payload, knowledge: handoff([ref(9)]) }, { commandId: id, expect: { work: null } }).error?.code, "conflict");
    assert.equal(listRuns(root).length, 1);
  });

  test("knowledge 없는 submit 은 예전 그대로 — 실행 기록·응답에 knowledge 키가 없다", () => {
    project(ENABLED);
    register(["context.docs.refs"]);
    const accepted = send("submit", { prompt: "시작" }, { commandId: cid() });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error));
    assert.ok(!("knowledge" in accepted.result));
    assert.ok(!("knowledge" in runFile(accepted.result.runId)));
  });

  test("continue·resume 에 knowledge 를 보내면 invalid-request, 이어 실행은 이전 실행의 인계를 잇는다", () => {
    project(ENABLED);
    register(["context.docs.refs"]);
    const first = send("submit", { prompt: "시작", knowledge: handoff() }, { commandId: cid() });
    assert.equal(first.ok, true, JSON.stringify(first.error));
    const done = readRun(root, first.result.runId)!;
    writeRunRecord(root, { ...done, state: "completed", finishedAt: new Date().toISOString() });
    const sessionId = first.result.sessionId as string;
    assert.equal(send("submit", { mode: "continue", sessionId, prompt: "잇는다", knowledge: handoff() }, { commandId: cid() }).error?.code, "invalid-request");
    assert.equal(send("resume", { runId: done.runId, knowledge: handoff() }, { commandId: cid() }).error?.code, "invalid-request");
    assert.equal(listRuns(root).length, 1);
    const next = send("submit", { mode: "continue", sessionId, prompt: "잇는다" }, { commandId: cid() });
    assert.equal(next.ok, true, JSON.stringify(next.error));
    assert.deepEqual(readRun(root, next.result.runId)!.knowledge, STORED);
    assert.deepEqual(next.result.knowledge, receipt());
  });
});

describe("작업 고정과 조회", () => {
  const at = (): string => new Date().toISOString();
  const runRecord = (runId: string, extra: Partial<RunRecord> = {}): RunRecord => ({ version: 1, runId, commandId: `c-${runId}`, controller: "m1", generation: 1, mode: "start",
    links: { missionId: "M-1" }, state: "running", acceptedAt: at(), updatedAt: at(), sessionId: `s-${runId}`, promptHash: "x", timeoutMs: 1000, workId: null, baseHead: null,
    baseStateVersion: "x", history: [], ...extra });

  test("bindWork 는 실행의 인계를 작업 연결에 고정하고, 이미 묶인 작업은 다른 실행이 바꾸지 않는다", () => {
    project(undefined);
    writeFixture(root, ".code-agent/request-session.json", JSON.stringify({ id: "TASK-1", kind: "feature", startedAt: at() }));
    const knowledge = knowledgeHandoffOf(handoff())!;
    const first = runRecord("run-first", { knowledge, execution: { mode: "claude" } });
    writeRunRecord(root, first);
    observeProgress(root, first);
    const bound = readWorkBinding(root, "TASK-1")!;
    assert.deepEqual(bound.knowledge, STORED);
    assert.deepEqual(bound.execution, { mode: "claude" }, "실행 방식과 같은 자리에 고정한다");
    const second = runRecord("run-second", { knowledge: knowledgeHandoffOf(handoff([ref(7)]))! });
    writeRunRecord(root, second);
    observeProgress(root, second);
    const after = readWorkBinding(root, "TASK-1")!;
    assert.deepEqual(after.runs, ["run-first", "run-second"]);
    assert.deepEqual(after.knowledge, STORED, "처음 고정한 참조를 바꾸지 않는다");
    const plain = runRecord("run-plain");
    writeFixture(root, ".code-agent/request-session.json", JSON.stringify({ id: "TASK-2", kind: "feature", startedAt: at() }));
    observeProgress(root, plain);
    assert.ok(!("knowledge" in JSON.parse(readFileSync(join(root, ".code-agent", "master", "works", "TASK-2.json"), "utf8"))), "인계 없는 실행은 키를 남기지 않는다");
  });

  test("이미 연 작업의 새 실행은 작업에 고정된 참조를 쓰고, 다른 참조는 conflict 로 거부한다", () => {
    project(ENABLED);
    register(["context.docs.refs"]);
    writeFixture(root, ".code-agent/request-session.json", JSON.stringify({ id: "TASK-1", kind: "feature", startedAt: at() }));
    writeWorkBinding(root, { workId: "TASK-1", links: {}, boundAt: at(), runId: "run-old", controller: "m1", runs: ["run-old"], knowledge: knowledgeHandoffOf(handoff())! });
    const other = send("submit", { prompt: "다시", knowledge: handoff([ref(5)]) }, { commandId: cid() });
    assert.equal(other.error?.code, "conflict", JSON.stringify(other));
    assert.equal(listRuns(root).length, 0);
    const reordered = send("submit", { prompt: "다시", knowledge: handoff([ref(2, { required: false }), ref(1)]) }, { commandId: cid() });
    assert.equal(reordered.ok, true, `같은 참조(순서만 다름)는 받는다: ${JSON.stringify(reordered.error)}`);
    assert.deepEqual(readRun(root, reordered.result.runId)!.knowledge, STORED, "기록은 작업에 고정된 참조다");
    writeRunRecord(root, { ...readRun(root, reordered.result.runId)!, state: "completed" });
    const without = send("submit", { prompt: "다시" }, { commandId: cid() });
    assert.equal(without.ok, true, JSON.stringify(without.error));
    assert.deepEqual(readRun(root, without.result.runId)!.knowledge, STORED, "참조 없이 시작해도 작업의 인계를 잇는다");
  });

  test("managedKnowledge — 지금 작업의 연결이 정본이고, 작업 전에는 이 세션의 master 실행 기록을 본다", () => {
    project(undefined);
    const env = { [MASTER_RUN_ENV]: "run-session" };
    assert.equal(managedKnowledge(root, {}), undefined);
    writeRunRecord(root, runRecord("run-session", { knowledge: knowledgeHandoffOf(handoff([ref(4)]))! }));
    assert.deepEqual(managedKnowledge(root, env)?.refs.map((item) => item.itemId), ["orders:doc/architecture.md#rule-4"], "작업을 열기 전 — 실행 기록");
    assert.equal(managedKnowledge(root, {}), undefined, "master 실행이 아닌 세션");
    assert.equal(managedKnowledge(root, { [MASTER_RUN_ENV]: "../escape" }), undefined, "실행 ID 꼴이 아니면 읽지 않는다");
    saveActive(root, { id: "W-1", spec: "doc/work/W-1/spec.md", target: "app", phase: "analysis" });
    assert.deepEqual(managedKnowledge(root, env)?.refs.map((item) => item.itemId), ["orders:doc/architecture.md#rule-4"], "연결 없는 작업 — 세션의 실행 기록");
    writeWorkBinding(root, { workId: "W-1", links: {}, boundAt: at(), runId: "run-session", controller: "m1", runs: ["run-session"], knowledge: knowledgeHandoffOf(handoff())! });
    assert.deepEqual(managedKnowledge(root, env), STORED, "작업 연결이 실행 기록보다 앞선다");
    assert.deepEqual(managedKnowledge(root, {}), STORED, "사람 세션도 작업의 인계를 본다");
    writeWorkBinding(root, { workId: "W-1", links: {}, boundAt: at(), runId: "run-session", controller: "m1", runs: ["run-session"] });
    assert.equal(managedKnowledge(root, env), undefined, "참조 없이 묶인 작업에는 인계가 없다");
  });
});

describe("진행 게이트 — master 재개·재검증·인계 교체", () => {
  const at = (): string => new Date().toISOString();
  /** 분석 단계의 작업 W-1 과 그 작업에 고정된 인계 — 검증 기록은 아직 없다 */
  function boundWork(knowledge: Record<string, unknown> = handoff()): void {
    writeFixture(root, "doc/work/W-1/spec.md", W1_SPEC);
    confirmForTest(root, join(root, "doc/work/W-1/spec.md"));
    saveActive(root, { id: "W-1", spec: "doc/work/W-1/spec.md", target: "app", phase: "analysis" });
    writeWorkBinding(root, { workId: "W-1", links: {}, boundAt: at(), runId: "run-old", controller: "m1", runs: ["run-old"], knowledge: knowledgeHandoffOf(knowledge)! });
  }

  test("required 인계가 검증 전이면 재개 판정이 knowledge-blocked 이고 submit 을 거부한다 — 그 사유를 응답에서 읽는다", () => {
    project(ENABLED);
    register(["context.docs.refs"]);
    boundWork();
    const view = stateView(root);
    assert.equal(view.resume.code, "knowledge-blocked", JSON.stringify(view.resume));
    assert.equal(view.resume.next.action, "knowledge-reverify");
    assert.equal((view.knowledge as Record<string, unknown>).state, "blocked");
    const refused = send("submit", { prompt: "다시" }, { commandId: cid() });
    assert.equal(refused.error?.code, "invalid-state", JSON.stringify(refused));
    assert.equal((refused.error?.detail as { resume: { code: string } }).resume.code, "knowledge-blocked");
    assert.equal(listRuns(root).length, 0, "실행을 만들지 않는다");
  });

  test("knowledge verify 는 고정된 참조만 다시 대조해 결과를 돌려주고, 실패하면 보류를 유지한다(어댑터 갈래)", () => {
    project(ENABLED);
    register(["context.docs.refs"]);
    boundWork();
    const verified = send("knowledge", { action: "verify" }, { commandId: cid() });
    assert.equal(verified.ok, true, JSON.stringify(verified.error));
    assert.equal(verified.result.workId, "W-1");
    assert.equal(verified.result.knowledge.state, "blocked", "가짜 등록(node -e 0)은 응답하지 않는다 — adapter-failed");
    assert.deepEqual(verified.result.knowledge.blocked.map((entry: any) => [entry.reason, entry.cause, entry.recovery]), [["adapter-failed", "adapter", "reverify"]]);
    assert.deepEqual(verified.result.knowledge.optional.map((entry: any) => entry.reason), ["adapter-failed"], "required:false 실패는 진단으로만");
    assert.equal(verified.result.resume.code, "knowledge-blocked");
    assert.ok(existsSync(knowledgeRecordFile(root, "W-1")), "검증 기록을 남긴다(재시작해도 같은 판정)");
    assert.equal(send("knowledge", { action: "verify", workId: "W-2" }, { commandId: cid() }).error?.code, "not-enabled");
    assert.equal(send("knowledge", { action: "other" }, { commandId: cid() }).error?.code, "invalid-request");
  });

  test("knowledge replace 는 사유와 함께 인계를 바꾸고(이력·검증 기록 삭제), 같은 인계는 바꾸지 않으며, null 은 인계를 뗀다", () => {
    project(ENABLED);
    register(["context.docs.refs"]);
    boundWork();
    send("knowledge", { action: "verify" }, { commandId: cid() });
    assert.equal(send("knowledge", { action: "replace", knowledge: handoff([ref(3)]) }, { commandId: cid() }).error?.code, "invalid-request", "reason 이 필요하다");
    const outside = send("knowledge", { action: "replace", reason: "범위 밖", knowledge: handoff([ref(3, { itemId: "orders:doc/other.md#rule-3" })]) }, { commandId: cid() });
    assert.equal((outside.error?.detail as { reason?: string } | undefined)?.reason, "knowledge-scope", "등록 문서 밖 참조는 받지 않는다");
    const same = send("knowledge", { action: "replace", reason: "같은 인계", knowledge: handoff() }, { commandId: cid() });
    assert.equal(same.result.replaced, false);
    const replaced = send("knowledge", { action: "replace", reason: "근거 문서가 바뀌어 재계획", knowledge: handoff([ref(1, { required: false })]) }, { commandId: cid() });
    assert.equal(replaced.ok, true, JSON.stringify(replaced.error));
    assert.equal(replaced.result.replaced, true);
    assert.deepEqual(replaced.result.knowledge, receipt({ version: 1, refs: [{ ...ref(1), required: false }] }));
    assert.ok("approval" in replaced.result, "다른 인계는 이전 승인을 다시 쓰지 않는다 — 승인 상태를 함께 돌려준다");
    assert.equal(existsSync(knowledgeRecordFile(root, "W-1")), false, "이전 인계의 검증 기록을 지운다");
    const binding = readWorkBinding(root, "W-1")!;
    assert.equal(binding.knowledgeHistory?.length, 1);
    assert.equal(binding.knowledgeHistory![0].reason, "근거 문서가 바뀌어 재계획");
    assert.equal(binding.knowledgeHistory![0].from, knowledgeDigest(STORED as KnowledgeHandoff));
    assert.notEqual(replaced.result.resume.code, "knowledge-blocked", "required 가 없는 인계는 진행을 막지 않는다");
    const detached = send("knowledge", { action: "replace", reason: "인계 해제", knowledge: null }, { commandId: cid() });
    assert.equal(detached.result.replaced, true);
    assert.equal(detached.result.knowledge, null);
    assert.ok(!("knowledge" in readWorkBinding(root, "W-1")!));
    assert.equal(readWorkBinding(root, "W-1")!.knowledgeHistory?.length, 2);
  });
});

describe("사람 응답으로 잇는 실행", () => {
  let key: ReturnType<typeof generateKeyPairSync>;
  let channelId: string;
  let dashboardToken: string;
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-master-knowledge-")));
    setupConsentProject(root);
    init(root, { host: "claude" });
    const raw = tty(() => masterEnable(root, { controller: "dashboard" }));
    dashboardToken = /토큰\(다시 보여 주지 않습니다\): (\w+)/.exec(raw)![1];
    key = generateKeyPairSync("ed25519"); channelId = randomUUID();
    const binding = readBinding(root)!;
    binding.humanChannel = { id: channelId, controller: "dashboard", generation: 1, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
    writeBinding(root, binding);
  });

  test("대시보드 동의 응답 뒤의 재개 실행이 이전 실행의 인계를 옮긴다", () => {
    const at = new Date().toISOString();
    const previous: RunRecord = { version: 1, runId: `run-${randomUUID()}`, commandId: randomUUID(), controller: "dashboard", generation: 1, mode: "start", links: {}, state: "blocked",
      acceptedAt: at, updatedAt: at, finishedAt: at, sessionId: "owner", promptHash: "fixture", timeoutMs: 60_000, workId: null, baseHead: null, baseStateVersion: "fixture", history: [],
      knowledge: knowledgeHandoffOf(handoff())! };
    writeRunRecord(root, previous);
    const consentId = JSON.parse(prepareConsent(root, { action: "baseline" }, { binding: { id: "owner", host: "claude" } })).id as string;
    const r = currentInteractions(root).requests.find((item) => item.origin.type === "consent" && item.origin.id === consentId)!;
    assert.equal(r.context.runId, previous.runId);
    const req: RequestEnvelope = { protocol: "code-agent.master", version: 1, type: "interaction.respond", controller: "dashboard", generation: 1, token: dashboardToken, commandId: randomUUID(),
      payload: { requestId: r.requestId, expectedRevision: r.revision, contentHash: r.contentHash, challenge: r.challenge, channelId,
        submission: { intent: "submit", explicit: true, verdict: "approve", shownHash: r.consent!.shownHash, choices: Object.fromEntries(r.consent!.choices.map((c) => [String(c.index), "유지"])) } } };
    req.payload!.signature = sign(null, Buffer.from(humanSigningMessage(readBinding(root)!.projectId, req)), key.privateKey).toString("base64");
    const response = call(root, JSON.stringify(req));
    assert.equal(response.ok, true, JSON.stringify(response.error));
    drainInteraction(root, r.requestId);
    const next = listRuns(root).find((row) => row.runId !== previous.runId);
    assert.ok(next, "재개 실행을 만들었다");
    assert.equal(next.mode, "continue");
    assert.deepEqual(next.knowledge, STORED);
  });

  test("지금 작업의 required 인계가 검증 전이면 사람 응답 뒤에도 재개 실행을 만들지 않고 대기(knowledge-blocked)로 두고, 인계를 바꾸면 다음 조회가 잇는다", () => {
    const at = new Date().toISOString();
    // 실패로 끝난 실행 — 응답은 적용하되 재개는 하지 않는다(재개 조건은 completed·blocked)
    const previous: RunRecord = { version: 1, runId: `run-${randomUUID()}`, commandId: randomUUID(), controller: "dashboard", generation: 1, mode: "start", links: {}, state: "failed",
      acceptedAt: at, updatedAt: at, finishedAt: at, sessionId: "owner", promptHash: "fixture", timeoutMs: 60_000, workId: null, baseHead: null, baseStateVersion: "fixture", history: [],
      knowledge: knowledgeHandoffOf(handoff())! };
    writeRunRecord(root, previous);
    const consentId = JSON.parse(prepareConsent(root, { action: "baseline" }, { binding: { id: "owner", host: "claude" } })).id as string;
    const r = currentInteractions(root).requests.find((item) => item.origin.type === "consent" && item.origin.id === consentId)!;
    const req: RequestEnvelope = { protocol: "code-agent.master", version: 1, type: "interaction.respond", controller: "dashboard", generation: 1, token: dashboardToken, commandId: randomUUID(),
      payload: { requestId: r.requestId, expectedRevision: r.revision, contentHash: r.contentHash, challenge: r.challenge, channelId,
        submission: { intent: "submit", explicit: true, verdict: "approve", shownHash: r.consent!.shownHash, choices: Object.fromEntries(r.consent!.choices.map((c) => [String(c.index), "유지"])) } } };
    req.payload!.signature = sign(null, Buffer.from(humanSigningMessage(readBinding(root)!.projectId, req)), key.privateKey).toString("base64");
    assert.equal(call(root, JSON.stringify(req)).ok, true);
    drainInteraction(root, r.requestId);
    assert.equal(currentInteractions(root).requests.find((item) => item.requestId === r.requestId)!.status, "applied");
    assert.equal(listRuns(root).length, 1);
    // 그 뒤 작업이 열리고 인계가 고정됐다(검증 기록 없음) — 실행은 재개할 수 있는 상태가 됐다
    writeFixture(root, "doc/work/W-1/spec.md", W1_SPEC);
    confirmForTest(root, join(root, "doc/work/W-1/spec.md"));
    saveActive(root, { id: "W-1", spec: "doc/work/W-1/spec.md", target: "app", phase: "analysis" });
    writeWorkBinding(root, { workId: "W-1", links: {}, boundAt: at, runId: previous.runId, controller: "dashboard", runs: [previous.runId], knowledge: knowledgeHandoffOf(handoff())! });
    writeRunRecord(root, { ...previous, state: "blocked" });
    drainInteraction(root, r.requestId);
    assert.equal(listRuns(root).length, 1, "재개 실행을 만들지 않는다");
    const saved = currentInteractions(root).requests.find((item) => item.requestId === r.requestId)!;
    assert.equal(saved.continuation?.state, "queued", JSON.stringify({ continuation: saved.continuation, status: saved.status, resume: stateView(root).resume }));
    assert.match(saved.continuation?.detail ?? "", /^knowledge-blocked: .*code-agent knowledge verify/);
    const revision = saved.revision;
    drainInteraction(root, r.requestId);
    assert.equal(currentInteractions(root).requests.find((item) => item.requestId === r.requestId)!.revision, revision, "같은 판정이면 기록을 다시 쓰지 않는다");
    // 재계획 — required 가 없는 인계로 바꾸면 다음 조회가 재개 실행을 만들고, 그 실행은 작업 연결의 (바뀐) 인계를 잇는다
    const replanned = knowledgeHandoffOf(handoff([ref(1, { required: false })]))!;
    writeWorkBinding(root, { ...readWorkBinding(root, "W-1")!, knowledge: replanned });
    drainInteraction(root, r.requestId);
    const resumed = listRuns(root).find((row) => row.runId !== previous.runId);
    assert.ok(resumed, "재개 실행을 만들었다");
    assert.equal(resumed.mode, "continue");
    assert.deepEqual(resumed.knowledge, replanned, "이전 실행 기록이 아니라 작업 연결의 인계를 쓴다");
  });
});
