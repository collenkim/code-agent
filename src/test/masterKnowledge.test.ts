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
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { loadManifest, type Slot } from "../core/manifest";
import { prepareConsent } from "../agent/consent";
import { init } from "../agent/init";
import { humanSigningMessage } from "../agent/interactionHuman";
import { currentInteractions } from "../agent/interactions";
import { drainInteraction } from "../agent/interactionService";
import { saveActive } from "../agent/layout";
import { masterEnable } from "../agent/master/admin";
import { call } from "../agent/master/control";
import { observeProgress } from "../agent/master/observe";
import { knowledgeHandoffOf, MAX_KNOWLEDGE_REFS, type RequestEnvelope } from "../agent/master/protocol";
import { MASTER_RUN_ENV } from "../agent/master/runGuard";
import { listRuns, readBinding, readCommand, readRun, readWorkBinding, writeBinding, writeRunRecord, writeWorkBinding, type RunRecord } from "../agent/master/store";
import { managedKnowledge } from "../agent/master/workKnowledge";
import { writeStore } from "../agent/plugins/store";
import { withInteraction } from "../agent/tty";
import { gitFixture, setupConsentProject, writeFixture } from "./consentFixture";
import { setCaller } from "./reviewFixture";

const tty = <T>(run: () => T): T => withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "모의 TTY(시험)" }), ask: () => "n" }, run);

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHA = "a".repeat(64);
const ref = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ itemId: `orders:doc/policy.md#rule-${n}`, generation: 3, commit: COMMIT, itemSha256: SHA, ...extra });
/** 두 번째 참조는 required 를 끈다 — 첫 번째는 생략(기본 true) */
const handoff = (refs: Record<string, unknown>[] = [ref(1), ref(2, { required: false })]): Record<string, unknown> => ({ version: 1, refs });
const STORED = { version: 1, refs: [{ ...ref(1), required: true }, { ...ref(2), required: false }] };

let root: string;
let outside: string;
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
    assert.deepEqual(before.result.knowledge, { schemaVersion: 1, mode: "off", refs: { supported: true, accepted: false, max: MAX_KNOWLEDGE_REFS } });
    assert.equal(MAX_KNOWLEDGE_REFS, 20);
    tty(() => masterEnable(root, { controller: "m1", tokenOut: join(outside, "late.token") }));
    assert.deepEqual(hello().result.knowledge.refs, { supported: true, accepted: false, max: 20 });
  });

  test("context.docs 를 slots 로 선언하고 accepts 에 refs 를 적어 등록하면 enabled·accepted — 등록·협의가 빠지면 받지 않는다", () => {
    project(ENABLED);
    assert.deepEqual(hello().result.knowledge, { schemaVersion: 1, mode: "enabled", refs: { supported: true, accepted: false, max: 20 } }, "이 PC 에 등록이 없다");
    register();
    assert.equal(hello().result.knowledge.refs.accepted, false, "accepts 없는 등록(이전 어댑터)에는 참조를 보내지 않는다");
    register(["context.docs.phase", "context.docs.files"]);
    assert.equal(hello().result.knowledge.refs.accepted, false);
    register(["context.docs.phase", "context.docs.refs"], ["candidates.rank"]);
    assert.equal(hello().result.knowledge.refs.accepted, false, "그 자리로 등록하지 않았다");
    register(["context.docs.phase", "context.docs.files", "context.docs.refs"]);
    const knowledge = hello().result.knowledge;
    assert.deepEqual(knowledge, { schemaVersion: 1, mode: "enabled", refs: { supported: true, accepted: true, max: 20 } });
    assert.ok(!JSON.stringify(knowledge).includes("agent-knowledge"), "플러그인 이름·명령은 알리지 않는다");
  });

  test("shadow 선언은 mode shadow 이고 참조를 받지 않는다", () => {
    project(SHADOW);
    register(["context.docs.refs"]);
    assert.deepEqual(hello().result.knowledge, { schemaVersion: 1, mode: "shadow", refs: { supported: true, accepted: false, max: 20 } });
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

describe("submit knowledge — 수락 조건과 저장", () => {
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
    assert.deepEqual(accepted.result.knowledge, { refs: 2 });
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
    assert.deepEqual(next.result.knowledge, { refs: 2 });
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
    assert.deepEqual(managedKnowledge(root, env)?.refs.map((item) => item.itemId), ["orders:doc/policy.md#rule-4"], "작업을 열기 전 — 실행 기록");
    assert.equal(managedKnowledge(root, {}), undefined, "master 실행이 아닌 세션");
    assert.equal(managedKnowledge(root, { [MASTER_RUN_ENV]: "../escape" }), undefined, "실행 ID 꼴이 아니면 읽지 않는다");
    saveActive(root, { id: "W-1", spec: "doc/work/W-1/spec.md", target: "app", phase: "analysis" });
    assert.deepEqual(managedKnowledge(root, env)?.refs.map((item) => item.itemId), ["orders:doc/policy.md#rule-4"], "연결 없는 작업 — 세션의 실행 기록");
    writeWorkBinding(root, { workId: "W-1", links: {}, boundAt: at(), runId: "run-session", controller: "m1", runs: ["run-session"], knowledge: knowledgeHandoffOf(handoff())! });
    assert.deepEqual(managedKnowledge(root, env), STORED, "작업 연결이 실행 기록보다 앞선다");
    assert.deepEqual(managedKnowledge(root, {}), STORED, "사람 세션도 작업의 인계를 본다");
    writeWorkBinding(root, { workId: "W-1", links: {}, boundAt: at(), runId: "run-session", controller: "m1", runs: ["run-session"] });
    assert.equal(managedKnowledge(root, env), undefined, "참조 없이 묶인 작업에는 인계가 없다");
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
});
