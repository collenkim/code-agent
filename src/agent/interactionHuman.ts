/** TTY로 신뢰한 대시보드 사람 채널. AI 제어 토큰과 다른 Ed25519 키를 사용한다. */
import { generateKeyPairSync, verify, randomUUID } from "crypto";
import { mkdirSync, writeFileSync, lstatSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { confirmOnTerminal } from "./tty";
import { canonicalJson, ControlError, sha256, type RequestEnvelope } from "./master/protocol";
import { CONTROL_LOCK, readBinding, readOwner, withLock, writeBinding, type Binding } from "./master/store";
import type { InteractionRecord } from "./interactions";

export interface HumanChannel { id: string; controller: string; generation: number; publicKey: string; createdAt: string; expiresAt: string }
export function configureHumanChannel(root: string, controller: string, enabled: boolean): string {
  const binding = readBinding(root), owner = readOwner(root);
  if (!binding || !owner || owner.controller !== controller || owner.handover) throw new ControlError("not-enabled", "현재 제어자를 먼저 master enable로 연결하고 인계를 끝내세요");
  confirmOnTerminal(`프로젝트 ${binding.projectId}의 ${controller} 대시보드 사람 응답 채널을 ${enabled ? "등록" : "폐기"}합니다.\n등록한 화면 서버는 명시적 사람 제출만 서명해야 합니다. 일반 개발 토큰·AI 위임과 별도이며 서명 키를 모델이나 브라우저에 전달하지 않습니다.`, enabled ? "human-enable" : "human-disable");
  return withLock(root, CONTROL_LOCK, () => {
    const current = readBinding(root)!, nowOwner = readOwner(root)!;
    if (!current || !nowOwner || current.projectId !== binding.projectId || nowOwner.controller !== controller || nowOwner.generation !== owner.generation || nowOwner.handover) throw new ControlError("fenced", "확인 중 소유권이 바뀌었습니다");
    if (!enabled) { delete current.humanChannel; writeBinding(root, current); return "대시보드 사람 채널을 폐기했습니다."; }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const id = randomUUID(), dir = join(homedir(), ".code-agent", "dashboard-channels");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new ControlError("policy-forbids", "사람 채널 키 폴더의 링크를 허용하지 않습니다");
    const keyPath = join(dir, `${sha256(root).slice(0, 16)}-${id}.pem`);
    if (existsSync(keyPath)) throw new ControlError("conflict", "키 파일이 이미 있습니다");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
    current.humanChannel = { id, controller, generation: owner.generation, publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
    writeBinding(root, current);
    return JSON.stringify({ channelId: id, controller, generation: owner.generation, keyPath, expiresAt: current.humanChannel.expiresAt, algorithm: "Ed25519" });
  });
}
export function humanSigningMessage(projectId: string, request: Pick<RequestEnvelope, "controller" | "generation" | "commandId" | "payload">): string {
  const { signature: _signature, ...body } = request.payload ?? {};
  return canonicalJson({ domain: "code-agent.dashboard-human.v1", projectId, controller: request.controller, generation: request.generation, commandId: request.commandId, body });
}
export function verifyHumanSubmission(root: string, binding: Binding, request: RequestEnvelope, interaction: InteractionRecord): HumanChannel {
  const channel = binding.humanChannel, owner = readOwner(root);
  if (!channel || !owner || owner.handover || channel.controller !== owner.controller || channel.generation !== owner.generation || request.controller !== channel.controller || request.generation !== channel.generation) throw new ControlError("human-required", "현재 소유권에 연결된 대시보드 사람 채널이 필요합니다");
  if (Date.parse(channel.expiresAt) <= Date.now()) throw new ControlError("human-required", "사람 채널이 만료됐습니다. TTY에서 다시 연결하세요");
  const payload = request.payload ?? {};
  if (payload.channelId !== channel.id || payload.challenge !== interaction.challenge || typeof payload.signature !== "string") throw new ControlError("unauthorized", "사람 채널·일회성 요청 확인이 맞지 않습니다");
  if (!verify(null, Buffer.from(humanSigningMessage(binding.projectId, request)), channel.publicKey, Buffer.from(payload.signature, "base64"))) throw new ControlError("unauthorized", "사람 제출 서명이 맞지 않습니다");
  return channel;
}
