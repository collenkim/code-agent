import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import childProcess = require("node:child_process");
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { setupConsentProject, writeFixture } from "./consentFixture";
import { setCaller } from "./reviewFixture";
import { init } from "../agent/init";
import { masterEnable } from "../agent/master/admin";
import { call } from "../agent/master/control";
import { readBinding, writeBinding, type RunRecord } from "../agent/master/store";
import { withInteraction } from "../agent/tty";
import { humanSigningMessage } from "../agent/interactionHuman";
import { PublishInteraction, INTERACTION_STAGES } from "../agent/interactionSchema";
import { currentInteractions, interactionContext, publishInteraction, type InteractionRecord } from "../agent/interactions";
import type { Lease } from "../agent/lease";
import { drainInteraction } from "../agent/interactionService";
import { loadConsent } from "../agent/consent";
import type { RequestEnvelope } from "../agent/master/protocol";

let savedStore: string | undefined;
let root: string, token: string, key: ReturnType<typeof generateKeyPairSync>, channelId: string, restoreCaller: () => void;
beforeEach(() => {
  // 사람의 터미널로 둔다 — 시험을 어느 호스트 안에서 돌려도 같게(시작 게이트는 실행 호스트의 설치 기록을 본다)
  restoreCaller = setCaller(undefined);
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-interactions-")));
  // Codex 준비 판정 기록은 사용자 홈이 아니라 시험 폴더에 남긴다
  savedStore = process.env.CODE_AGENT_HOME; process.env.CODE_AGENT_HOME = join(root, "code-agent-home");
  setupConsentProject(root);
  // Claude 관리 실행(이어 실행)은 Claude 설치 기록과 hook 이 있어야 접수한다
  init(root, { host: "claude" });
  const raw = withInteraction({ confirm: () => ({ channel: "tty", verified: true, detail: "fixture" }), ask: () => "n" }, () => masterEnable(root, { controller: "dashboard" }));
  token = /토큰\(다시 보여 주지 않습니다\): (\w+)/.exec(raw)![1];
  key = generateKeyPairSync("ed25519"); channelId = randomUUID();
  const binding = readBinding(root)!;
  binding.humanChannel = { id: channelId, controller: "dashboard", generation: 1, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
  writeBinding(root, binding);
  mock.method(childProcess, "spawn", () => Object.assign(new EventEmitter(), { unref() {} }));
});
afterEach(() => { mock.restoreAll(); restoreCaller(); if (savedStore === undefined) delete process.env.CODE_AGENT_HOME; else process.env.CODE_AGENT_HOME = savedStore; assert.ok(resolve(root).startsWith(realpathSync.native(tmpdir()) + sep)); assert.ok(root.includes("ca-interactions-")); rmSync(root, { recursive: true, force: true }); });
const question = (id = "q1") => ({ questionId: id, title: "문서 작성 방식", mode: "single", minSelections: 1,
  options: [{ optionId: "source", label: "소스 기준 작성", description: "현재 코드를 확인합니다", consequence: "문서 초안을 작성합니다" }, { optionId: "link", label: "기존 문서 연결", description: "경로를 입력합니다", consequence: "문서 기준을 검사합니다", input: { required: true, minLength: 1, maxLength: 200, description: "기존 문서 경로" } }],
  recommendedOptionIds: ["source"], recommendationReason: "검사한 소스 구성이 있습니다", evidence: [{ path: "package.json", summary: "현재 프로젝트 구성" }] });
function publish(stage: typeof INTERACTION_STAGES[number] = "setup", extra: object = {}) {
  const input = PublishInteraction.parse({ key: `test-${stage}`, stage, title: "프로젝트 질문", questions: [question()], ...extra });
  return publishInteraction(root, input, interactionContext(root, "owner", "claude"));
}
function request(r: ReturnType<typeof publish>, submission: object, commandId: string = randomUUID()): RequestEnvelope {
  const req: RequestEnvelope = { protocol: "code-agent.master", version: 1, type: "interaction.respond", controller: "dashboard", generation: 1, token, commandId,
    payload: { requestId: r.requestId, expectedRevision: r.revision, contentHash: r.contentHash, challenge: r.challenge, channelId, submission } };
  req.payload!.signature = sign(null, Buffer.from(humanSigningMessage(readBinding(root)!.projectId, req)), key.privateKey).toString("base64"); return req;
}
const choose = (optionId = "source", optionInputs: Record<string, string> = {}) => ({ intent: "submit", explicit: true, answers: [{ questionId: "q1", optionIds: [optionId], optionInputs }] });
const send = (req: RequestEnvelope) => call(root, JSON.stringify(req)) as ReturnType<typeof call> & { result?: any };
const read = (type: "interactions" | "interaction" | "interaction.result", payload = {}) => send({ protocol: "code-agent.master", version: 1, type, controller: "dashboard", generation: 1, token, payload });
const approval = (r: InteractionRecord) => ({ intent: "submit", explicit: true, verdict: "approve", shownHash: r.consent!.shownHash,
  choices: Object.fromEntries(r.consent!.choices.map(c => [String(c.index), "유지"])) });
function approveDashboard(id: string): void {
  const r = currentInteractions(root).requests.find(r => r.origin.id === id)!;
  assert.equal(send(request(r, approval(r))).ok, true);
  drainInteraction(root, r.requestId);
  assert.equal(loadConsent(root, id).status, "applied");
}
const consentRequest = (id: string) => currentInteractions(root).requests.find(r => r.origin.type === "consent" && r.origin.id === id)!;
/** 수신 거절 — detail 은 interactionService 의 received·requestId·status 와 원래 오류의 detail */
function reject(req: RequestEnvelope): { code: string; message: string; detail: { received: boolean; requestId: string; status: string; leaseConflict?: any } } {
  const response = send(req);
  assert.equal(response.ok, false);
  return response.error as ReturnType<typeof reject>;
}
function writeLease(lease: Partial<Lease> & Pick<Lease, "id" | "target" | "session">): void {
  const at = new Date().toISOString();
  writeFixture(root, ".code-agent/lease.json", JSON.stringify({ version: 1, host: "claude", claimedAt: at, seenAt: at, ...lease }));
}
/** 끝난 작업이 남긴 임대 — 커서는 지웠고 lease.json 만 남는다 */
const orphanLease = () => writeLease({ id: "OLD-WORK", target: "gateway", session: "old-session" });

function previousRun(state: RunRecord["state"] = "blocked"): RunRecord {
  const at = new Date().toISOString();
  return { version: 1, runId: `run-${randomUUID()}`, commandId: randomUUID(), controller: "dashboard", generation: 1, mode: "start", links: {}, state, acceptedAt: at, updatedAt: at, finishedAt: at,
    sessionId: "owner", promptHash: "fixture", timeoutMs: 60000, workId: null, baseHead: null, baseStateVersion: "fixture", history: [] };
}


export { root, token, key, channelId, question, publish, request, choose, send, read, approval, approveDashboard, consentRequest, reject, writeLease, orphanLease, previousRun };
