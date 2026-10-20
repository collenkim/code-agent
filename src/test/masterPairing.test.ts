/**
 * 대시보드 페어링 — PC 신뢰(trust·untrust) → pair.challenge → pair 의 연결·교체, 거부 조건(아무것도 쓰지 않음), 처음 켤 때의 기본 호스트·관리 실행
 * 호스트 검사, hook 가드(모의 시험). 사람의 TTY 확인(trust·enable)은 withInteraction 으로 흉내낸다 — 실제 사람의 입력이 아니다. 대시보드 서버의
 * 서명은 시험이 PC 신뢰 키로 직접 만든다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { decide } from "../agent/hook";
import { configureHumanChannel } from "../agent/interactionHuman";
import { init, requireStartHooks } from "../agent/init";
import { masterEnable, masterStatus } from "../agent/master/admin";
import { call } from "../agent/master/control";
import { sameRoot } from "../agent/master/pairing";
import { DEFAULT_POLICY, pairSigningMessage, type PairApproval } from "../agent/master/protocol";
import { MASTER_RUN_ENV, masterRunGuard } from "../agent/master/runGuard";
import { listRuns, readBinding, readOwner, writeOwner, writeRunRecord, type RunRecord } from "../agent/master/store";
import { masterTrust, masterTrustList, masterUntrust, trustKeyDir, trustKeyPath } from "../agent/master/trust";
import { storeDir } from "../agent/plugins/store";
import { withInteraction } from "../agent/tty";
import { gitFixture, writeFixture } from "./consentFixture";

/** 모의 TTY — 사람이 확인 단어를 입력한 것으로 둔다(시험 전용) */
const tty = <T>(run: () => T): T => withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "모의 TTY(시험)" }), ask: () => "n" }, run);
const CLI = join(__dirname, "../agent/cli.js");
const SHOWN = `sha256:${"a".repeat(64)}`;

let root: string, home: string;
const saved: Record<string, string | undefined> = {};
const made: string[] = [];
function temp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
function project(): string {
  const dir = temp("ca-pair-");
  gitFixture(dir, "init", "-q", "-b", "master");
  gitFixture(dir, "config", "user.name", "t");
  gitFixture(dir, "config", "user.email", "t@t");
  writeFixture(dir, "README.md", "x\n");
  gitFixture(dir, "add", "-A");
  gitFixture(dir, "commit", "-qm", "init");
  return dir;
}
beforeEach(() => {
  for (const key of ["CODE_AGENT_HOME", "CODEX_HOME"]) saved[key] = process.env[key];
  home = temp("ca-pair-home-");
  process.env.CODE_AGENT_HOME = join(home, ".code-agent");
  // Codex 신뢰 확인이 사용자의 실제 설정을 읽지 않게 한다
  process.env.CODEX_HOME = temp("ca-pair-codex-");
  root = project();
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const temporary = realpathSync.native(tmpdir());
  for (const dir of made.splice(0)) {
    assert.ok(resolve(dir).startsWith(temporary + sep) && /^ca-pair/.test(resolve(dir).slice(temporary.length + 1)));
    rmSync(dir, { recursive: true, force: true });
  }
});

type Res = ReturnType<typeof call> & { result?: any };
const req = (body: Record<string, unknown>, at = root): Res => call(at, JSON.stringify({ protocol: "code-agent.master", version: 1, ...body })) as Res;
const challenge = (controller = "dashboard", at = root): Res => req({ type: "pair.challenge", payload: { controller } }, at);
interface Signing { controller?: string; commandId?: string; signedCommandId?: string; approval?: PairApproval; key?: KeyObject | string; extra?: Record<string, unknown>; envelope?: Record<string, unknown>; omitSignature?: boolean }
/** 대시보드 서버의 pair 요청 — PC 신뢰 키로 서명한다 */
function signed(ch: any, options: Signing = {}): Record<string, unknown> {
  const controller = options.controller ?? ch.controller;
  const commandId = options.commandId ?? `pair-${randomUUID()}`;
  const approval = options.approval ?? { actor: "대시보드 사용자", approvedAt: new Date().toISOString(), shownHash: SHOWN };
  const message = pairSigningMessage({ challengeId: ch.challengeId, nonce: ch.nonce, projectRoot: ch.projectRoot, controller, commandId: options.signedCommandId ?? commandId, approval });
  const signature = sign(null, Buffer.from(message), options.key ?? readFileSync(trustKeyPath(controller), "utf8")).toString("base64");
  return { type: "pair", commandId, ...options.envelope, payload: { challengeId: ch.challengeId, controller, approval, ...(options.omitSignature ? {} : { signature }), ...options.extra } };
}
const pair = (ch: any, options: Signing = {}, at = root): Res => req(signed(ch, options), at);

/** 저장소의 .code-agent 와 키 저장소의 파일·내용(잠금 파일 제외) */
function state(at = root): string {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".lock")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { rows.push(`${path}/`); walk(path); }
      else rows.push(`${path} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(join(at, ".code-agent"));
  walk(home);
  return rows.join("\n");
}
function rejectsWithoutWrites(code: string, run: () => Res, what: string, at = root): Res {
  const before = state(at);
  const res = run();
  assert.equal(res.ok, false, `${what}: 거부해야 한다`);
  assert.equal(res.error?.code, code, `${what}: ${JSON.stringify(res.error)}`);
  assert.equal(state(at), before, `${what}: 거부는 아무것도 쓰지 않는다`);
  return res;
}
const fingerprint = (controller: string): string => JSON.parse(readFileSync(join(storeDir(), "master-trust.json"), "utf8")).controllers[controller].fingerprint;
const events = (token: string, controller = "dashboard", generation = 1): { type: string; data?: any }[] =>
  req({ type: "events", controller, generation, token, payload: { after: 0 } }).result.events;

describe("PC 신뢰와 페어링 — 정상 흐름", () => {
  test("PC 신뢰 한 번 뒤 pair.challenge → pair 만으로 연동·사람 채널·토큰이 준비되고, 같은 제어자의 재페어링은 토큰·사람 채널을 바꾼다", () => {
    assert.equal(challenge().error?.code, "unauthorized", "신뢰 전에는 챌린지를 주지 않는다");
    assert.ok(!existsSync(join(root, ".code-agent")), "신뢰 없는 챌린지 요청은 아무것도 쓰지 않는다");
    assert.match(tty(() => masterTrust("dashboard")), /지문 sha256:[0-9a-f]{64}/);
    const hello = req({ type: "hello" });
    assert.deepEqual(hello.result.pairing.trustedControllers, ["dashboard"]);
    assert.equal(hello.result.pairing.supported, true);
    assert.ok(hello.result.commands.open.includes("pair"));
    assert.ok(!JSON.stringify(hello.result).includes(".pem") && !JSON.stringify(hello.result).includes(home), "hello 에 키·키 경로를 넣지 않는다");

    const ch = challenge();
    assert.equal(ch.ok, true, JSON.stringify(ch.error));
    assert.deepEqual(ch.result.project, { enabled: false, owner: null, handover: false });
    assert.equal(ch.result.projectRoot, root);
    assert.ok(Date.parse(ch.result.expiresAt) - Date.now() <= 5 * 60_000);
    assert.match(readFileSync(join(root, ".code-agent/master/.gitignore"), "utf8"), /^\*$/m, "연동 전에도 master 폴더는 자체 .gitignore 로 무시한다");

    const request = signed(ch.result);
    const first = req(request);
    assert.equal(first.ok, true, JSON.stringify(first.error));
    const result = first.result;
    assert.equal(result.outcome, "enabled");
    assert.equal(result.owner, true);
    assert.equal(result.generation, 1);
    assert.equal(result.controller, "dashboard");
    assert.ok(result.tokenFile.startsWith(join(storeDir(), "master-tokens") + sep), result.tokenFile);
    const token = readFileSync(result.tokenFile, "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(first).includes(token), "응답에 토큰 값을 넣지 않는다");
    for (const file of [join(root, ".code-agent/master/events.jsonl"), ...readdirSync(join(root, ".code-agent/master/commands")).map((name) => join(root, ".code-agent/master/commands", name))]) {
      assert.ok(!readFileSync(file, "utf8").includes(token), `${file} 에 토큰 값을 남기지 않는다`);
    }
    if (process.platform !== "win32") assert.equal(statSync(result.tokenFile).mode & 0o777, 0o600);

    const binding = readBinding(root)!;
    assert.deepEqual(binding.enabledBy, { actor: "대시보드 사용자", channel: "dashboard-pairing", trustFingerprint: fingerprint("dashboard"),
      approvalHash: binding.enabledBy.channel === "dashboard-pairing" ? binding.enabledBy.approvalHash : "" });
    assert.match(binding.enabledBy.channel === "dashboard-pairing" ? binding.enabledBy.approvalHash : "", /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(binding.policy, DEFAULT_POLICY, "정책은 기본값");
    assert.equal(binding.host.kind, "claude", "설치·실행 선택이 없으면 claude");
    assert.equal(binding.controllers.dashboard.pairing?.trustFingerprint, fingerprint("dashboard"));
    assert.equal(readOwner(root)!.history.at(-1)?.how, "pair");
    assert.equal(binding.humanChannel?.id, result.humanChannel.channelId);
    assert.ok(result.humanChannel.keyPath.startsWith(join(storeDir(), "dashboard-channels") + sep));
    const probe = Buffer.from("probe");
    assert.ok(verify(null, probe, binding.humanChannel!.publicKey, sign(null, probe, readFileSync(result.humanChannel.keyPath, "utf8"))), "사람 채널 개인 키와 공개 키가 짝이다");

    // master-agent bindControl 과 같은 순서 — hello(연동·제어자) → heartbeat(토큰)
    const bound = req({ type: "hello" });
    assert.equal(bound.result.project.enabled, true);
    assert.ok(bound.result.controllers.includes("dashboard"));
    assert.equal(bound.result.ownership.controller, "dashboard");
    assert.equal(req({ type: "heartbeat", controller: "dashboard", generation: 1, token }).ok, true);
    const rows = events(token);
    assert.equal(rows.find((row) => row.type === "binding.enabled")?.data.channel, "dashboard-pairing");
    assert.equal(rows.find((row) => row.type === "human-channel.changed")?.data.channel, "dashboard-pairing");

    const again = req(request);
    assert.equal(again.replayed, true, "같은 commandId 재전송은 기록된 응답");
    assert.deepEqual(again.result, result);
    assert.equal(readFileSync(result.tokenFile, "utf8").trim(), token, "재전송은 다시 적용하지 않는다");

    const second = pair(challenge().result);
    assert.equal(second.ok, true, JSON.stringify(second.error));
    assert.equal(second.result.outcome, "rotated");
    assert.equal(second.result.generation, 1);
    assert.equal(second.result.projectId, result.projectId);
    assert.equal(second.result.tokenFile, result.tokenFile);
    const rotated = readFileSync(result.tokenFile, "utf8").trim();
    assert.notEqual(rotated, token);
    assert.equal(req({ type: "heartbeat", controller: "dashboard", generation: 1, token }).error?.code, "unauthorized", "이전 토큰은 받지 않는다");
    assert.equal(req({ type: "heartbeat", controller: "dashboard", generation: 1, token: rotated }).ok, true);
    assert.notEqual(second.result.humanChannel.channelId, result.humanChannel.channelId, "사람 채널을 새로 등록한다");
    assert.ok(Date.parse(second.result.humanChannel.expiresAt) >= Date.parse(result.humanChannel.expiresAt), "만료를 연장한다");
    assert.equal(events(rotated).filter((row) => row.type === "controller.added" && row.data.rotated && row.data.channel === "dashboard-pairing").length, 1);

    assert.match(masterStatus(root, false), /연결 방식 대시보드 페어링/);
    assert.match(masterStatus(root, false), /dashboard\(페어링\)/);
    const view = JSON.parse(masterStatus(root, true));
    assert.equal(view.controllers[0].via, "dashboard-pairing");
    assert.equal(view.controllers[0].pairing.trusted, true);
  });

  test("untrust 는 이후의 페어링만 막고 이미 켠 연동은 유지하며 status 에 '신뢰 해제된 제어자'로 보인다 — 다시 trust 하면 새 키로 연결한다", () => {
    tty(() => masterTrust("dashboard"));
    const first = pair(challenge().result);
    assert.equal(first.ok, true, JSON.stringify(first.error));
    const token = readFileSync(first.result.tokenFile, "utf8").trim();
    const pending = challenge().result;
    const oldKey = readFileSync(trustKeyPath("dashboard"), "utf8");
    const oldFingerprint = fingerprint("dashboard");
    assert.match(tty(() => masterUntrust("dashboard")), /신뢰를 해제했습니다/);
    assert.ok(!existsSync(trustKeyPath("dashboard")), "개인 키를 지운다");
    assert.match(masterTrustList(), /해제: dashboard/);
    assert.equal(req({ type: "heartbeat", controller: "dashboard", generation: 1, token }).ok, true, "이미 켠 연동·토큰은 그대로");
    assert.match(masterStatus(root, false), /신뢰 해제된 제어자: dashboard/);
    assert.equal(JSON.parse(masterStatus(root, true)).controllers[0].pairing.trusted, false);
    rejectsWithoutWrites("unauthorized", () => pair(pending, { key: oldKey }), "해제 전에 받은 챌린지");
    rejectsWithoutWrites("unauthorized", () => challenge(), "해제 뒤 새 챌린지");
    assert.deepEqual(req({ type: "hello" }).result.pairing.trustedControllers, []);

    tty(() => masterTrust("dashboard"));
    assert.notEqual(fingerprint("dashboard"), oldFingerprint, "다시 trust 하면 새 키");
    const again = pair(challenge().result);
    assert.equal(again.ok, true, JSON.stringify(again.error));
    assert.equal(again.result.outcome, "rotated");
    assert.doesNotMatch(masterStatus(root, false), /신뢰 해제된 제어자/);
  });
});

describe("페어링 거부 — 아무것도 쓰지 않는다", () => {
  test("서명 없음·서명 불일치·다른 제어자·없는 챌린지·요청 꼴·정책·호스트·grant 필드는 거부하고, 거부는 챌린지를 쓰지 않는다 — 재사용·만료도 거부한다", () => {
    tty(() => masterTrust("dashboard"));
    tty(() => masterTrust("other"));
    const ch = challenge().result;
    rejectsWithoutWrites("unauthorized", () => pair(ch, { omitSignature: true }), "서명 없음");
    rejectsWithoutWrites("unauthorized", () => pair(ch, { key: generateKeyPairSync("ed25519").privateKey }), "다른 키의 서명");
    rejectsWithoutWrites("unauthorized", () => {
      const body = signed(ch) as { payload: { approval: PairApproval } };
      body.payload.approval = { ...body.payload.approval, actor: "다른 사람" };
      return req(body);
    }, "서명 뒤 바꾼 확인 내용");
    rejectsWithoutWrites("unauthorized", () => pair(ch, { signedCommandId: "pair-other-command" }), "다른 commandId 에 대한 서명");
    rejectsWithoutWrites("unauthorized", () => pair(ch, { extra: { signature: "not-base64!!" } }), "서명 꼴");
    rejectsWithoutWrites("stale-state", () => pair(ch, { controller: "other" }), "다른 제어자에게 준 챌린지");
    rejectsWithoutWrites("stale-state", () => pair({ ...ch, challengeId: randomUUID() }), "없는 챌린지");
    for (const field of ["policy", "host", "hostProfile", "grant", "grants", "allowedTools", "sandbox"]) {
      rejectsWithoutWrites("policy-forbids", () => pair(ch, { extra: { [field]: field === "allowedTools" ? ["Bash"] : {} } }), `pair 의 ${field}`);
    }
    rejectsWithoutWrites("policy-forbids", () => req({ type: "pair.challenge", payload: { controller: "dashboard", host: { kind: "codex" } } }), "pair.challenge 의 host");
    rejectsWithoutWrites("invalid-request", () => pair(ch, { extra: { label: "x" } }), "모르는 필드");
    rejectsWithoutWrites("invalid-request", () => pair(ch, { envelope: { token: "x" } }), "토큰 동봉");
    rejectsWithoutWrites("invalid-request", () => pair(ch, { envelope: { generation: 1 } }), "세대 동봉");
    rejectsWithoutWrites("invalid-request", () => pair(ch, { envelope: { controller: "other" } }), "envelope 제어자 불일치");
    rejectsWithoutWrites("invalid-request", () => pair(ch, { approval: { actor: "u", approvedAt: new Date(Date.now() - 3_600_000).toISOString(), shownHash: SHOWN } }), "챌린지 전 확인 시각");
    rejectsWithoutWrites("invalid-request", () => pair(ch, { approval: { actor: "u", approvedAt: new Date().toISOString(), shownHash: "sha256:x" } }), "확인 화면 해시 꼴");
    rejectsWithoutWrites("invalid-request", () => req({ type: "pair", payload: signed(ch).payload }), "commandId 없음");

    const ok = pair(ch);
    assert.equal(ok.ok, true, `거부된 요청은 챌린지를 쓰지 않는다: ${JSON.stringify(ok.error)}`);
    rejectsWithoutWrites("stale-state", () => pair(ch), "챌린지 재사용(새 commandId)");

    const late = challenge().result;
    const file = join(root, ".code-agent/master/pairing", `${late.challengeId}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), expiresAt: new Date(Date.now() - 1000).toISOString() }));
    rejectsWithoutWrites("stale-state", () => pair(late), "만료한 챌린지");
  });

  test("다른 프로젝트 경로의 챌린지와 챌린지가 없는 프로젝트는 stale-state — Windows 는 실제 경로를 대소문자 없이 견준다", () => {
    tty(() => masterTrust("dashboard"));
    const ch = challenge().result;
    const bare = project();
    rejectsWithoutWrites("stale-state", () => pair(ch, {}, bare), "연동 전·챌린지 없는 프로젝트", bare);
    assert.ok(!existsSync(join(bare, ".code-agent")), "잠금 파일도 만들지 않는다");
    const other = project();
    assert.equal(challenge("dashboard", other).ok, true);
    writeFileSync(join(other, ".code-agent/master/pairing", `${ch.challengeId}.json`), readFileSync(join(root, ".code-agent/master/pairing", `${ch.challengeId}.json`)));
    rejectsWithoutWrites("stale-state", () => pair(ch, {}, other), "다른 루트에서 받은 챌린지", other);
    assert.equal(sameRoot(root, root.toUpperCase(), "win32"), true);
    assert.equal(sameRoot(root, other, "win32"), false);
    assert.equal(sameRoot("/x/Project", "/x/project", "linux"), false);
  });

  test("다른 제어자가 소유하거나 인계 중인 프로젝트는 페어링으로 가져오지 않는다(fenced·conflict)", () => {
    const outside = temp("ca-pair-out-");
    tty(() => masterEnable(root, { controller: "m1", tokenOut: join(outside, "m1.token") }));
    tty(() => masterTrust("dashboard"));
    const ch = challenge().result;
    assert.deepEqual(ch.project, { enabled: true, owner: "m1", handover: false });
    rejectsWithoutWrites("fenced", () => pair(ch), "다른 제어자 소유");
    tty(() => masterEnable(root, { controller: "dashboard", tokenOut: join(outside, "dashboard.token") }));
    const owner = readOwner(root)!;
    writeOwner(root, { ...owner, controller: "dashboard", generation: owner.generation + 1,
      handover: { id: "ho-test", from: "m1", to: "dashboard", mode: "cooperative", by: "controller", state: "transferred", requestedAt: new Date().toISOString(), runs: [] } });
    const transferred = challenge().result;
    assert.equal(transferred.project.handover, true);
    rejectsWithoutWrites("conflict", () => pair(transferred), "인수 전 인계(transferred)");
    writeOwner(root, { ...owner, handover: { id: "ho-test", from: "m1", to: "dashboard", mode: "cooperative", by: "controller", state: "requested", requestedAt: new Date().toISOString(), runs: [] } });
    const requested = challenge().result;
    rejectsWithoutWrites("conflict", () => pair(requested), "인계 요청 중");
  });
});

describe("PC 신뢰 명령", () => {
  test("키를 덮어쓰지 않고 링크·장치 이름·스트림 글자를 받지 않으며, 저장소 밖에서도 실행하고 TTY 가 아니면 등록하지 않는다", () => {
    tty(() => masterTrust("dashboard"));
    assert.throws(() => tty(() => masterTrust("dashboard")), /이미 신뢰합니다/);
    mkdirSync(trustKeyDir(), { recursive: true });
    writeFileSync(trustKeyPath("stray"), "keep");
    assert.throws(() => tty(() => masterTrust("stray")), /덮어쓰지 않습니다/);
    assert.equal(readFileSync(trustKeyPath("stray"), "utf8"), "keep");
    for (const id of ["con", "nul.x", "a:b", "../x", "x.", ""]) assert.throws(() => tty(() => masterTrust(id)), /사용법/, id);

    const outside = temp("ca-pair-norepo-");
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, "master", ...args], { cwd: outside, encoding: "utf8", env: { ...process.env, CODE_AGENT_HOME: storeDir() } });
    const list = run("trust", "--list");
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /신뢰: dashboard · 지문 sha256:/);
    const denied = run("trust", "--controller", "cli-pipe");
    assert.notEqual(denied.status, 0, "stdin 이 TTY 가 아니면 등록하지 않는다");
    assert.ok(!existsSync(trustKeyPath("cli-pipe")));
    assert.ok(!existsSync(join(outside, ".code-agent")), "저장소 밖 실행은 그 폴더에 아무것도 쓰지 않는다");

    const linked = temp("ca-pair-link-");
    rmSync(trustKeyDir(), { recursive: true, force: true });
    try { symlinkSync(linked, trustKeyDir(), "junction"); } catch { return; /* 링크를 만들 수 없는 환경 */ }
    assert.throws(() => tty(() => masterTrust("linked")), /링크/);
    assert.deepEqual(readdirSync(linked), [], "링크를 따라가 키를 쓰지 않는다");
  });
});

describe("관리 실행 호스트", () => {
  test("hello.managedHost 는 켜기 전에도 선택될 호스트와 준비 상태를 보이고, 처음 켤 때는 execution → 설치 호스트 하나 → claude 순으로 고른다", () => {
    let view = req({ type: "hello" }).result.managedHost;
    assert.equal(view.selected, "claude");
    assert.equal(view.source, "default");
    assert.equal(view.ready, false);
    assert.ok(view.problems.some((problem: { code: string }) => problem.code === "host-not-installed"));
    init(root, { host: "claude" });
    view = req({ type: "hello" }).result.managedHost;
    assert.deepEqual([view.selected, view.source, view.ready, view.installedHosts], ["claude", "installed", true, ["claude"]], JSON.stringify(view.problems));
    writeFileSync(join(root, ".code-agent/execution.json"), JSON.stringify({ version: 1, mode: "both", main: "codex" }));
    view = req({ type: "hello" }).result.managedHost;
    assert.deepEqual([view.selected, view.source, view.ready], ["codex", "execution-main", false]);
    assert.ok(view.problems.some((problem: { code: string }) => problem.code === "host-not-installed"));
    assert.ok(view.problems.some((problem: { code: string }) => problem.code.startsWith("codex-")), "Codex 신뢰 상태를 problems 에 넣는다");
    assert.ok(!JSON.stringify(view).includes(home));

    // 터미널 enable 도 같은 규칙 — execution both·main codex
    const outside = temp("ca-pair-out-");
    tty(() => masterEnable(root, { controller: "m1", tokenOut: join(outside, "m1.token") }));
    assert.equal(readBinding(root)!.host.kind, "codex");
    assert.equal(readBinding(root)!.enabledBy.channel, "tty");

    // 페어링 — 설치 호스트가 codex 하나
    const codexOnly = project();
    init(codexOnly, { host: "codex" });
    tty(() => masterTrust("dashboard"));
    const paired = pair(challenge("dashboard", codexOnly).result, {}, codexOnly);
    assert.equal(paired.ok, true, JSON.stringify(paired.error));
    assert.equal(readBinding(codexOnly)!.host.kind, "codex");
    // 이미 켠 연동의 호스트는 페어링이 바꾸지 않는다
    writeFileSync(join(codexOnly, ".code-agent/hosts.json"), JSON.stringify(["claude"]));
    assert.equal(pair(challenge("dashboard", codexOnly).result, {}, codexOnly).result.outcome, "rotated");
    assert.equal(readBinding(codexOnly)!.host.kind, "codex");
  });

  test("Claude 관리 실행은 설치 기록·hook 이 없으면 invalid-state 로 거부하고 빠진 항목을 알린다 — 실행 기록을 만들지 않는다", () => {
    const outside = temp("ca-pair-out-");
    const tokenFile = join(outside, "m1.token");
    tty(() => masterEnable(root, { controller: "m1", tokenOut: tokenFile }));
    const token = readFileSync(tokenFile, "utf8").trim();
    const submit = () => req({ type: "submit", controller: "m1", generation: 1, token, commandId: `c-${randomUUID()}`, payload: { prompt: "MODE=complete" } });
    const denied = submit();
    assert.equal(denied.error?.code, "invalid-state");
    assert.ok((denied.error?.detail as { missing: string[] }).missing.includes("hosts.json: claude"));
    assert.ok((denied.error?.detail as { missing: string[] }).missing.includes("Claude PreToolUse(hook)"));
    assert.equal(listRuns(root).length, 0);
    init(root, { host: "codex" });
    assert.deepEqual((submit().error?.detail as { missing: string[] }).missing.slice(0, 1), ["hosts.json: claude"], "다른 호스트만 설치해도 거부");
  });

  test("시작 게이트 — 실행 중인 호스트가 설치 기록(hosts.json)에 없으면 시작하지 않는다(기록이 없으면 감지하지 않는다)", () => {
    assert.equal(requireStartHooks(root, { CLAUDECODE: "1" }), undefined, "hosts.json 이 없으면 감지하지 않는다");
    init(root, { host: "codex" });
    assert.throws(() => requireStartHooks(root, { CLAUDECODE: "1" }), /이 호스트\(Claude Code\)는 설치 기록/);
    assert.doesNotThrow(() => requireStartHooks(root, { CODEX_THREAD_ID: "t" }));
    assert.doesNotThrow(() => requireStartHooks(root, {}), "판별 불가(사람의 터미널)는 막지 않는다");
  });
});

describe("hook — 키 자리와 master 제어 명령", () => {
  const bash = (command: string) => decide({ cwd: root, session_id: "s", tool_name: "Bash", tool_input: { command } });
  test("호스트 세션은 code-agent master trust·untrust·call 을 부르지 못하고, 실행 세션 가드도 막는다", () => {
    for (const command of ["code-agent master trust --controller dashboard", "code-agent master untrust --controller dashboard", "code-agent master trust --list",
      "code-agent master call", "node dist/agent/cli.js master trust --controller x", "code-agent.cmd master untrust --controller x"]) {
      assert.match(bash(command) ?? "", /master 제어 명령/, command);
    }
    const at = new Date().toISOString();
    const run: RunRecord = { version: 1, runId: "run-pair-guard", commandId: "c", controller: "dashboard", generation: 1, mode: "start", links: {}, state: "running", acceptedAt: at, updatedAt: at,
      sessionId: "s-1", promptHash: "x", timeoutMs: 1000, workId: null, baseHead: null, baseStateVersion: "x", history: [] };
    writeRunRecord(root, run);
    for (const command of ["code-agent master trust --controller dashboard", "code-agent master untrust --controller dashboard", "code-agent master call"]) {
      assert.match(masterRunGuard({ tool_name: "Bash", session_id: "s-1", tool_input: { command } }, root, { [MASTER_RUN_ENV]: run.runId }) ?? "", /master 제어 명령/, command);
    }
  });

  test("master-trust/·master-tokens/·dashboard-channels/ 는 키 저장소 읽기·쓰기·셸 언급 거부 범위다(CODE_AGENT_HOME·기본 홈)", () => {
    const denied = /등록된 플러그인 키가 있는 자리|키가 들어 있는 상위 폴더/;
    const check = (base: string) => {
      const files = [join(base, "master-trust", "dashboard.pem"), join(base, "master-tokens", "p-dashboard.token"), join(base, "dashboard-channels", "x.pem"), join(base, "master-trust.json")];
      for (const file of files) {
        assert.match(decide({ cwd: root, session_id: "s", tool_name: "Read", tool_input: { file_path: file } }) ?? "", denied, `Read ${file}`);
        assert.match(decide({ cwd: root, session_id: "s", tool_name: "Write", tool_input: { file_path: file, content: "x" } }) ?? "", denied, `Write ${file}`);
        assert.match(bash(`cat "${file}"`) ?? "", denied, `cat ${file}`);
      }
      for (const dir of ["master-trust", "master-tokens"]) {
        assert.match(decide({ cwd: root, session_id: "s", tool_name: "Grep", tool_input: { pattern: "x", path: join(base, dir) } }) ?? "", denied, `Grep ${dir}`);
        assert.match(decide({ cwd: root, session_id: "s", tool_name: "Glob", tool_input: { pattern: `${join(base, dir).replace(/\\/g, "/")}/*` } }) ?? "", denied, `Glob ${dir}`);
      }
    };
    check(storeDir());
    for (const command of ["cat ~/.code-agent/master-trust/dashboard.pem", "type %USERPROFILE%\\.code-agent\\master-tokens\\a.token", "cat $CODE_AGENT_HOME/master-tokens/a.token"]) {
      assert.match(bash(command) ?? "", denied, command);
    }
    const previous = process.env.CODE_AGENT_HOME;
    delete process.env.CODE_AGENT_HOME;
    try { check(join(homedir(), ".code-agent")); } finally { process.env.CODE_AGENT_HOME = previous; }
  });
});

describe("터미널 경로 회귀", () => {
  test("터미널 enable·human enable 은 그대로 동작하고 연결 방식(tty)을 기록·이벤트에 남긴다 — 사람 채널 키는 키 저장소에 둔다", () => {
    const outside = temp("ca-pair-out-");
    const tokenFile = join(outside, "dashboard.token");
    assert.match(tty(() => masterEnable(root, { controller: "dashboard", tokenOut: tokenFile })), /master 연동을 켰습니다/);
    const token = readFileSync(tokenFile, "utf8").trim();
    assert.deepEqual(readBinding(root)!.enabledBy.channel, "tty");
    const issued = JSON.parse(tty(() => configureHumanChannel(root, "dashboard", true)));
    assert.ok(issued.keyPath.startsWith(join(storeDir(), "dashboard-channels") + sep), issued.keyPath);
    assert.equal(issued.algorithm, "Ed25519");
    assert.equal(readBinding(root)!.humanChannel?.id, issued.channelId);
    assert.match(tty(() => configureHumanChannel(root, "dashboard", false)), /폐기했습니다/);
    assert.equal(readBinding(root)!.humanChannel, undefined);
    const rows = events(token);
    assert.equal(rows.find((row) => row.type === "binding.enabled")?.data.channel, "tty");
    assert.deepEqual(rows.filter((row) => row.type === "human-channel.changed").map((row) => [row.data.action, row.data.channel]), [["enabled", "tty"], ["disabled", "tty"]]);
    assert.match(masterStatus(root, false), /연결 방식 터미널/);

    // 페어링한 제어자를 터미널에서 다시 발급하면 페어링 기록이 빠진다(지금 토큰은 터미널 발급)
    tty(() => masterTrust("dashboard"));
    assert.equal(pair(challenge().result).ok, true);
    assert.ok(readBinding(root)!.controllers.dashboard.pairing);
    tty(() => masterEnable(root, { controller: "dashboard", tokenOut: tokenFile }));
    assert.equal(readBinding(root)!.controllers.dashboard.pairing, undefined);
    assert.equal(readBinding(root)!.enabledBy.channel, "tty", "처음 켠 방식은 바꾸지 않는다");
  });
});
