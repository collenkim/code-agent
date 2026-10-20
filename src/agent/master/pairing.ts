/**
 * 대시보드 페어링 — 사람이 PC 마다 한 번 터미널에서 신뢰한 제어자(trust.ts)를, 프로젝트마다 대시보드에서의 사람 확인으로 연결한다.
 *
 * 1. `pair.challenge`(토큰 없음): 신뢰한 제어자에게 이 프로젝트 경로·제어자에 묶인 일회성 챌린지(5분)를 준다. 연동 전이면 master 폴더를 만든다.
 * 2. `pair`(토큰 없음, PC 신뢰 키 서명): 챌린지(있음·같은 제어자·미사용·미만료·같은 루트)·신뢰 기록·서명·프로젝트 소유를 모두 확인한 뒤에만
 *    쓴다. 연동이 없으면 터미널 enable 과 같은 적용(기본 정책·처음 켤 때의 기본 호스트 규칙)에 사람 채널 등록·토큰 발급을 더하고(enabled),
 *    같은 제어자가 소유 중이면 토큰을 바꾸고 사람 채널을 새로 등록한다(rotated). 다른 제어자 소유·인계 중이면 아무것도 쓰지 않고 거부한다.
 *
 * 정책·호스트 설정·위임 권한은 받지 않는다(터미널에서만). 토큰은 키 저장소의 `master-tokens/`에 쓰고 응답·기록·이벤트에는 경로만 담는다.
 */
import { randomBytes, randomUUID, verify } from "crypto";
import { existsSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

import { humanChannelDir, issueHumanChannel } from "../interactionHuman";
import { storeDir } from "../plugins/store";
import { applyEnable, planEnable, type EnablePlan } from "./admin";
import { canonicalJson, ControlError, PAIR_CHALLENGE_TTL_MS, pairSigningMessage, plain, sha256, type PairApproval, type RequestEnvelope } from "./protocol";
import { CONTROL_LOCK, masterPath, readBinding, readJson, readOwner, sleep, withLock, writeJson, type PairingRecord } from "./store";
import { isLink, privateDir, trustedController, validTrustId, type TrustEntry } from "./trust";

interface Challenge { version: 1; challengeId: string; nonce: string; projectRoot: string; controller: string; createdAt: string; expiresAt: string; usedAt?: string; commandId?: string }
export interface PairCheck { challengeId: string; controller: string; approval: PairApproval; signature: string }
export interface PairVerified extends PairCheck { challenge: Challenge; trust: TrustEntry; mode: "enabled" | "rotated"; plan: EnablePlan }

const MAX_OPEN_CHALLENGES = 32;
/** 사람이 확인한 시각(approval.approvedAt)과 이 PC 시계의 허용 차이 */
const CLOCK_SKEW_MS = 2 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 페어링이 정하지 않는 것 — 정책·호스트(권한 모드·허용 도구·sandbox)·위임 권한은 터미널에서만 정한다 */
const FORBIDDEN = ["policy", "patch", "host", "hostProfile", "hostProfiles", "execution", "permissionMode", "allowedTools", "disallowedTools", "sandbox", "model", "command",
  "grant", "grants", "actions", "works", "missions", "paths"];

const challengeDir = (root: string): string => masterPath(root, "pairing");
const challengeFile = (root: string, id: string): string => join(challengeDir(root), `${id}.json`);
export const tokenDir = (): string => join(storeDir(), "master-tokens");
export const tokenPath = (projectId: string, controller: string): string => resolve(tokenDir(), `${projectId}-${controller}.token`);

function payloadOf(request: RequestEnvelope, allowed: readonly string[]): Record<string, unknown> {
  const payload = request.payload ?? {};
  const forbidden = Object.keys(payload).filter((key) => FORBIDDEN.includes(key));
  if (forbidden.length) {
    throw new ControlError("policy-forbids", `페어링으로는 정책·호스트 설정·위임 권한을 정하지 않습니다(${forbidden.join(", ")}) — 사람이 터미널에서 master enable --policy·--host·master grant 로 정합니다`);
  }
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ControlError("invalid-request", `모르는 payload 필드: ${extra.join(", ")}`);
  return payload;
}
function controllerOf(request: RequestEnvelope, payload: Record<string, unknown>): string {
  if (!validTrustId(payload.controller)) throw new ControlError("invalid-request", "payload.controller 는 PC 신뢰에 등록한 제어자 ID 입니다");
  if (request.token !== undefined || request.generation !== undefined || request.expect !== undefined) {
    throw new ControlError("invalid-request", "페어링은 토큰·세대·expect 없이 PC 신뢰 키 서명으로 인증합니다");
  }
  if (request.controller !== undefined && request.controller !== payload.controller) throw new ControlError("invalid-request", "controller 가 payload.controller 와 다릅니다");
  return payload.controller;
}
function untrusted(controller: string): ControlError {
  return new ControlError("unauthorized", `이 PC 에서 신뢰하지 않은 제어자입니다(${controller}) — 사람이 터미널에서 code-agent master trust --controller ${controller} 로 한 번 등록합니다`);
}

/** 만료한 챌린지를 지우고 열린 수를 센다(제어 잠금 안) */
function pruneChallenges(root: string, now: number): number {
  const dir = challengeDir(root);
  if (!existsSync(dir)) return 0;
  let open = 0;
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".json"))) {
    let challenge: Challenge | undefined;
    try { challenge = readJson<Challenge>(join(dir, name)); } catch { challenge = undefined; }
    if (!challenge || !(Date.parse(challenge.expiresAt) > now)) rmSync(join(dir, name), { force: true });
    else if (!challenge.usedAt) open += 1;
  }
  return open;
}

/** pair.challenge — 신뢰한 제어자에게 이 프로젝트 경로에 묶인 일회성 챌린지를 준다 */
export function pairChallenge(root: string, request: RequestEnvelope): unknown {
  const payload = payloadOf(request, ["controller"]);
  const controller = controllerOf(request, payload);
  if (!trustedController(controller)) throw untrusted(controller);
  // withLock 이 master 폴더와 그 자체 .gitignore 를 만든다(연동 전이어도)
  return withLock(root, CONTROL_LOCK, () => {
    const now = Date.now();
    if (pruneChallenges(root, now) >= MAX_OPEN_CHALLENGES) throw new ControlError("busy", "열린 페어링 챌린지가 많습니다 — 만료(5분) 뒤 다시 요청합니다");
    const binding = readBinding(root), owner = binding ? readOwner(root) : undefined;
    const challenge: Challenge = { version: 1, challengeId: randomUUID(), nonce: randomBytes(32).toString("base64url"), projectRoot: root, controller,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PAIR_CHALLENGE_TTL_MS).toISOString() };
    writeJson(challengeFile(root, challenge.challengeId), challenge);
    return { challengeId: challenge.challengeId, nonce: challenge.nonce, projectRoot: challenge.projectRoot, controller, expiresAt: challenge.expiresAt,
      project: { enabled: !!binding, owner: owner?.controller ?? null, handover: !!owner?.handover } };
  });
}

function approvalOf(raw: unknown): PairApproval {
  if (!plain(raw)) throw new ControlError("invalid-request", "approval 은 { actor, approvedAt, shownHash } 객체입니다");
  const extra = Object.keys(raw).filter((key) => !["actor", "approvedAt", "shownHash"].includes(key));
  if (extra.length) throw new ControlError("invalid-request", `모르는 approval 필드: ${extra.join(", ")}`);
  const { actor, approvedAt, shownHash } = raw;
  if (typeof actor !== "string" || !actor.trim() || actor.length > 200) throw new ControlError("invalid-request", "approval.actor 는 확인한 사람(1~200자)입니다");
  if (typeof approvedAt !== "string" || !Number.isFinite(Date.parse(approvedAt))) throw new ControlError("invalid-request", "approval.approvedAt 은 ISO 시각입니다");
  if (typeof shownHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(shownHash)) throw new ControlError("invalid-request", "approval.shownHash 는 사람에게 보인 확인 화면의 sha256:<hex 64> 입니다");
  return { actor, approvedAt, shownHash };
}

/** pair 의 꼴 검사 — 파일을 읽거나 쓰지 않는다 */
export function checkPair(request: RequestEnvelope): PairCheck {
  const payload = payloadOf(request, ["challengeId", "controller", "approval", "signature"]);
  const controller = controllerOf(request, payload);
  if (typeof payload.challengeId !== "string" || !UUID.test(payload.challengeId)) throw new ControlError("invalid-request", "challengeId 는 pair.challenge 가 준 UUID 입니다");
  const approval = approvalOf(payload.approval);
  if (typeof payload.signature !== "string" || !payload.signature) throw new ControlError("unauthorized", "PC 신뢰 키의 서명(signature)이 필요합니다");
  return { challengeId: payload.challengeId, controller, approval, signature: payload.signature };
}

function realOrResolved(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}
/** 같은 프로젝트 경로인가 — 실제 경로로 접고, Windows 는 대소문자를 구분하지 않는다 */
export function sameRoot(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const [x, y] = [a, b].map((path) => resolve(realOrResolved(path)));
  return platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}
const stale = (message: string): ControlError => new ControlError("stale-state", `${message} — pair.challenge 부터 다시 받습니다`);

/** pair 의 확인 — 모두 통과해야 적용한다. 쓰지 않는다(제어 잠금 안에서 부른다) */
export function verifyPair(root: string, check: PairCheck, commandId: string): PairVerified {
  let challenge: Challenge | undefined;
  try { challenge = readJson<Challenge>(challengeFile(root, check.challengeId)); } catch { challenge = undefined; }
  if (!challenge || challenge.challengeId !== check.challengeId) throw stale("이 프로젝트에 그 챌린지가 없습니다(만료돼 정리됐거나 다른 프로젝트의 챌린지)");
  if (challenge.controller !== check.controller) throw stale("다른 제어자에게 준 챌린지입니다");
  if (challenge.usedAt) throw stale("이미 사용한 챌린지입니다(한 번만 씁니다)");
  if (!(Date.parse(challenge.expiresAt) > Date.now())) throw stale("챌린지가 만료됐습니다");
  if (!sameRoot(challenge.projectRoot, root)) throw stale("챌린지의 프로젝트 경로가 이 프로젝트와 다릅니다");
  const trust = trustedController(check.controller);
  if (!trust) throw untrusted(check.controller);
  const signature = Buffer.from(check.signature, "base64");
  const message = pairSigningMessage({ challengeId: challenge.challengeId, nonce: challenge.nonce, projectRoot: challenge.projectRoot, controller: check.controller, commandId, approval: check.approval });
  let signed = false;
  try { signed = signature.length === 64 && verify(null, Buffer.from(message), trust.publicKey, signature); } catch { signed = false; }
  if (!signed) throw new ControlError("unauthorized", "PC 신뢰 키 서명이 맞지 않습니다");
  const approvedAt = Date.parse(check.approval.approvedAt);
  if (approvedAt < Date.parse(challenge.createdAt) - CLOCK_SKEW_MS || approvedAt > Date.now() + CLOCK_SKEW_MS) {
    throw new ControlError("invalid-request", "approval.approvedAt 이 챌린지를 받은 뒤 사람이 확인한 시각이 아닙니다");
  }
  const binding = readBinding(root), owner = readOwner(root);
  if (binding) {
    if (!owner) throw new ControlError("conflict", "연동 소유 기록(owner.json)이 없습니다 — 페어링으로 고치지 않습니다. 사람이 터미널에서 확인합니다");
    if (owner.handover) throw new ControlError("conflict", `인계 ${owner.handover.id}(${owner.handover.state})가 진행 중입니다 — 페어링으로 가져오지 않습니다. 정식 인계(handover accept)를 마칩니다`);
    if (owner.controller !== check.controller) {
      throw new ControlError("fenced", `다른 제어자 ${owner.controller}(세대 ${owner.generation})가 소유한 프로젝트입니다 — 페어링으로 가져오지 않습니다. 정식 인계(handover)를 씁니다`,
        { controller: owner.controller, generation: owner.generation });
    }
  }
  let plan: EnablePlan;
  try { plan = planEnable(root, check.controller, binding, { label: binding?.controllers[check.controller]?.label }); }
  catch (error) { throw error instanceof ControlError ? error : new ControlError("invalid-state", error instanceof Error ? error.message.split("\n")[0] : String(error)); }
  for (const path of [tokenDir(), tokenPath(plan.projectId, check.controller), humanChannelDir()]) {
    if (isLink(path)) throw new ControlError("policy-forbids", `비밀 파일 자리가 링크입니다(${path}) — 링크는 따라가지 않습니다`);
  }
  return { ...check, challenge, trust, mode: binding ? "rotated" : "enabled", plan };
}

/** 토큰 파일 — 0600, 링크는 거부하고 같은 제어자의 교체는 원자적으로 바꾼다 */
function writeTokenFile(file: string, token: string): void {
  privateDir(tokenDir());
  if (isLink(file)) throw new ControlError("policy-forbids", `토큰 파일 자리가 링크입니다(${file})`);
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, `${token}\n`, { flag: "wx", mode: 0o600 });
  for (let attempt = 0; ; attempt += 1) {
    try { renameSync(temp, file); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 50 && (code === "EPERM" || code === "EACCES" || code === "EBUSY")) { sleep(20); continue; }
      rmSync(temp, { force: true });
      throw error;
    }
  }
}

/** 확인을 마친 pair 적용 — 제어 잠금 안에서 부른다 */
export function applyPair(root: string, verified: PairVerified, commandId: string): Record<string, unknown> {
  const at = new Date().toISOString();
  // 챌린지를 먼저 쓴 것으로 남긴다 — 적용 도중 끊겨도 같은 챌린지로 두 번 적용하지 않는다
  writeJson(challengeFile(root, verified.challengeId), { ...verified.challenge, usedAt: at, commandId });
  const approvalHash = `sha256:${sha256(canonicalJson(verified.approval))}`;
  const pairing: PairingRecord = { at, actor: verified.approval.actor, trustFingerprint: verified.trust.fingerprint, approvalHash, commandId };
  const token = randomBytes(32).toString("hex");
  const tokenFile = tokenPath(verified.plan.projectId, verified.controller);
  // 토큰 파일을 먼저 쓴다 — 쓰지 못하면 binding 에 모르는 토큰의 해시가 남지 않는다
  writeTokenFile(tokenFile, token);
  const binding = applyEnable(root, verified.plan, token, { channel: "dashboard-pairing", actor: verified.approval.actor, pairing });
  const generation = readOwner(root)!.generation;
  const channel = issueHumanChannel(root, binding, verified.controller, generation, "dashboard-pairing");
  return { outcome: verified.mode, projectId: binding.projectId, controller: verified.controller, generation, owner: true, tokenFile,
    humanChannel: { channelId: channel.channelId, expiresAt: channel.expiresAt, keyPath: channel.keyPath, generation: channel.generation, algorithm: channel.algorithm } };
}
