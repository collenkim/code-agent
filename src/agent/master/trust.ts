/**
 * PC 신뢰 — 사람이 이 PC 에서 한 번 등록하는 대시보드 제어자의 Ed25519 키. 프로젝트마다의 연결(`pair`)은 이 키의 서명이 있어야 받는다.
 * 등록은 터미널의 확인 단어(`trust`) 또는 대시보드 확인 화면(`--preview` 문구의 해시를 `--shown-hash` 로 돌려받는다)으로 한다.
 *
 * - 개인 키: `<storeDir>/master-trust/<제어자>.pem`(pkcs8, 0600) — 대시보드 서버만 읽는다. 링크는 거부하고 덮어쓰지 않는다(교체는 untrust 뒤 trust).
 * - 공개 키·지문·생성 시각·등록 경로(tty·dashboard): `<storeDir>/master-trust.json`. 신뢰 해제는 기록을 revoked 로 옮기고 개인 키를 지운다 — 이미 켠 연동은 그대로다.
 *
 * storeDir(CODE_AGENT_HOME 또는 ~/.code-agent)는 hook 이 모델의 읽기·쓰기·셸 언급을 막는 키 자리다. 같은 OS 계정의 다른 프로세스가
 * 이 키를 읽는 것은 막지 못한다(대시보드 사람 채널 키와 같은 수준). 대시보드 확인 등록도 같은 계정에서 대시보드를 부를 수 있는 프로세스는 요청할 수 있다.
 */
import { createHash, createPublicKey, generateKeyPairSync } from "crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { actorName } from "../actor";
import { hostMarked } from "../crossEnv";
import { storeDir } from "../plugins/store";
import { Stop } from "../stop";
import { confirmOnTerminal } from "../tty";
import { ControlError } from "./protocol";

/** 제어자 ID — 파일 이름이 되므로 Windows 에서 다른 뜻이 되는 글자(`:` 스트림)·장치 이름·끝 점은 받지 않는다 */
const TRUST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
export function validTrustId(value: unknown): value is string {
  return typeof value === "string" && TRUST_ID.test(value) && !DEVICE_NAME.test(value) && !value.endsWith(".");
}
export const TRUST_USAGE = "사용법: code-agent master trust --controller <ID> [--preview | --shown-hash sha256:<hex 64>] | trust --list | untrust --controller <ID>";
const USAGE = `${TRUST_USAGE} — 제어자 ID 는 영문·숫자·._- 64자 이하(장치 이름 제외)`;
const TRUST_DOMAIN = "code-agent.master-trust.v1";
const SHOWN_HASH = /^sha256:[0-9a-f]{64}$/;

export type TrustChannel = "tty" | "dashboard";
export interface TrustEntry { controller: string; publicKey: string; fingerprint: string; createdAt: string; createdBy: { actor: string; channel: TrustChannel; shownHash?: string } }
interface RevokedEntry extends TrustEntry { revokedAt: string; revokedBy: { actor: string; channel: "tty" } }
interface TrustFile { version: 1; controllers: Record<string, TrustEntry>; revoked: RevokedEntry[] }

export const trustFile = (): string => join(storeDir(), "master-trust.json");
export const trustKeyDir = (): string => join(storeDir(), "master-trust");
export const trustKeyPath = (controller: string): string => join(trustKeyDir(), `${controller}.pem`);

export function fingerprintOf(publicKey: string): string {
  return `sha256:${createHash("sha256").update(createPublicKey(publicKey).export({ type: "spki", format: "der" })).digest("hex")}`;
}
function lexists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}
/** 비밀 파일 폴더 — 없으면 0700 으로 만들고, 링크(접합점 포함)면 거부한다 */
export function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isLink(dir)) throw new ControlError("policy-forbids", `비밀 파일 폴더가 링크입니다(${dir}) — 링크는 따라가지 않습니다`);
  return dir;
}

function readTrustFile(): TrustFile {
  const file = trustFile();
  if (!existsSync(file)) return { version: 1, controllers: {}, revoked: [] };
  let value: Partial<TrustFile>;
  try { value = JSON.parse(readFileSync(file, "utf8")) as Partial<TrustFile>; }
  catch (error) { throw new ControlError("internal", `PC 신뢰 기록을 읽지 못했습니다(${file}): ${error instanceof Error ? error.message : error}`); }
  if (!value || value.version !== 1 || !value.controllers || typeof value.controllers !== "object" || Array.isArray(value.controllers)) {
    throw new ControlError("internal", `PC 신뢰 기록의 형식이 올바르지 않습니다(${file})`);
  }
  return { version: 1, controllers: value.controllers, revoked: Array.isArray(value.revoked) ? value.revoked : [] };
}
function writeTrustFile(value: TrustFile): void {
  mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
  const file = trustFile(), temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}
/** 기록이 스스로 맞는가 — 지문이 공개 키와 다르면(손으로 고친 기록) 신뢰하지 않는다 */
function sound(id: string, entry: TrustEntry | undefined): entry is TrustEntry {
  if (!entry || entry.controller !== id || typeof entry.publicKey !== "string") return false;
  try { return fingerprintOf(entry.publicKey) === entry.fingerprint; } catch { return false; }
}

/** 지금 신뢰하는 제어자의 기록 — 없거나 손상됐으면 undefined */
export function trustedController(controller: string): TrustEntry | undefined {
  const entry = readTrustFile().controllers[controller];
  return sound(controller, entry) ? entry : undefined;
}
/** 지금 신뢰하는 제어자 ID 목록(키·경로 없이) — 기록을 읽지 못하면 빈 목록 */
export function trustedControllerIds(): string[] {
  try {
    const { controllers } = readTrustFile();
    return Object.keys(controllers).filter((id) => sound(id, controllers[id]));
  } catch { return []; }
}

function stop<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof ControlError) throw new Stop(`${error.code}: ${error.message}`);
    throw error;
  }
}

/** 신뢰 등록 확인 문구 — 터미널과 대시보드 확인 화면이 같은 내용을 보이고, 대시보드는 그 경로의 한계를 한 줄 더 보인다 */
function trustLines(controller: string, keyPath: string, channel: TrustChannel): string[] {
  return [
    `이 PC 에서 대시보드 제어자 ${controller} 를 신뢰합니다.`,
    `- 새 Ed25519 키를 만들고 개인 키를 ${keyPath} 에 둡니다(대시보드 서버만 읽습니다).`,
    "- 이후 대시보드에서 사람이 확인하면, 그 서버가 이 키로 서명한 연결 요청(pair)만으로 프로젝트마다 연동 켜기·사람 채널 등록·토큰 발급을 합니다.",
    "- 연결은 승인 권한이 아닙니다. 정책·호스트 설정·위임 권한은 계속 터미널에서 정하고, 다른 제어자가 소유하거나 인계 중인 프로젝트는 가져오지 않습니다.",
    "- 같은 OS 계정의 다른 프로세스는 이 키를 읽어 연결할 수 있습니다(대시보드 사람 채널 키와 같은 수준).",
    ...(channel === "dashboard" ? ["- 터미널 대신 대시보드 확인으로 등록합니다. 같은 OS 계정에서 대시보드를 부를 수 있는 프로세스도 이 등록을 요청할 수 있으며, 기록에는 대시보드 확인으로 남습니다."] : []),
  ];
}

/** 새로 신뢰할 수 없는 사유 — 이미 신뢰하거나 키 파일이 있으면 덮어쓰지 않는다 */
function trustBlocker(file: TrustFile, controller: string, keyPath: string): string | undefined {
  const existing = file.controllers[controller];
  if (existing) return `제어자 ${controller} 는 이미 신뢰합니다(지문 ${existing.fingerprint}). 키를 바꾸려면 untrust 뒤 다시 trust 합니다.`;
  if (lexists(keyPath)) return `${keyPath} 가 이미 있습니다 — 덮어쓰지 않습니다. 쓰지 않는 파일이면 사람이 지운 뒤 다시 trust 합니다.`;
  return undefined;
}

function createTrust(file: TrustFile, controller: string, keyPath: string, createdBy: TrustEntry["createdBy"]): TrustEntry {
  privateDir(trustKeyDir());
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const entry: TrustEntry = { controller, publicKey: pem, fingerprint: fingerprintOf(pem), createdAt: new Date().toISOString(), createdBy };
  writeTrustFile({ ...file, controllers: { ...file.controllers, [controller]: entry } });
  return entry;
}

export interface TrustPreview {
  controller: string; trusted: boolean; fingerprint: string | null; canTrust: boolean; reason: string | null
  keyPath: string; lines: string[]; shownHash: string; word: "trust"
}

/** 대시보드 확인 화면의 내용(읽기 전용) — 보일 문구와 그 해시. 새로 신뢰할 수 없으면 canTrust:false 와 사유 */
export function trustPreview(controller: string): TrustPreview {
  const file = readTrustFile(), keyPath = trustKeyPath(controller), entry = file.controllers[controller];
  const lines = trustLines(controller, keyPath, "dashboard"), reason = trustBlocker(file, controller, keyPath) ?? null;
  const shownHash = `sha256:${createHash("sha256").update(JSON.stringify({ domain: TRUST_DOMAIN, controller, keyPath, lines })).digest("hex")}`;
  return { controller, trusted: sound(controller, entry), fingerprint: entry?.fingerprint ?? null, canTrust: !reason, reason, keyPath, lines, shownHash, word: "trust" };
}

export function masterTrustPreview(controller: string | undefined): string {
  if (!validTrustId(controller)) throw new Stop(USAGE);
  return stop(() => JSON.stringify(trustPreview(controller)));
}

/**
 * 대시보드 확인으로 하는 PC 신뢰 등록(TTY 없음) — 사람이 본 문구의 해시(shownHash)가 지금 trustPreview 의 해시와 같을 때만 키를 만든다.
 * 호스트 셸(CLAUDECODE·Codex 표지)에서는 받지 않는다. 같은 OS 계정의 프로세스가 대시보드를 거쳐 요청하는 것은 막지 못하므로 기록에 dashboard 로 남긴다.
 */
export function masterTrustConfirmed(controller: string | undefined, shownHash: string | undefined): string {
  if (!validTrustId(controller) || typeof shownHash !== "string" || !SHOWN_HASH.test(shownHash)) throw new Stop(USAGE);
  return stop(() => {
    if (hostMarked()) throw new ControlError("policy-forbids", "호스트 세션의 셸에서는 대시보드 확인으로 신뢰하지 않습니다 — 대시보드 화면이나 사람의 터미널(code-agent master trust)에서 합니다");
    const preview = trustPreview(controller);
    if (!preview.canTrust) throw new ControlError("conflict", preview.reason ?? "");
    if (preview.shownHash !== shownHash) throw new ControlError("stale-state", "확인한 뒤 신뢰 내용이 바뀌었습니다 — 최신 내용을 다시 확인합니다");
    const entry = createTrust(readTrustFile(), controller, preview.keyPath, { actor: actorName(), channel: "dashboard", shownHash });
    return JSON.stringify({ controller, fingerprint: entry.fingerprint, keyPath: preview.keyPath, createdAt: entry.createdAt, channel: "dashboard" });
  });
}

/** PC 신뢰 등록(TTY) — 키를 새로 만든다. 이미 있으면 덮어쓰지 않는다 */
export function masterTrust(controller: string | undefined): string {
  if (!validTrustId(controller)) throw new Stop(USAGE);
  return stop(() => {
    const file = readTrustFile(), keyPath = trustKeyPath(controller);
    const blocker = trustBlocker(file, controller, keyPath);
    if (blocker) throw new Stop(blocker);
    confirmOnTerminal(trustLines(controller, keyPath, "tty").join("\n"), "trust");
    const entry = createTrust(file, controller, keyPath, { actor: actorName(), channel: "tty" });
    return [
      `대시보드 제어자 ${controller} 를 이 PC 에서 신뢰합니다 — 지문 ${entry.fingerprint}`,
      `개인 키: ${keyPath} (대시보드 서버 설정에만 둡니다. 저장소·모델 프롬프트·브라우저·로그에 넣지 않습니다)`,
      "프로젝트 연결은 대시보드에서 확인합니다(pair.challenge → pair). 해제: code-agent master untrust --controller " + controller,
    ].join("\n");
  });
}

/** PC 신뢰 해제(TTY) — 이후의 페어링만 막는다. 이미 켠 연동·발급한 토큰은 그대로 둔다 */
export function masterUntrust(controller: string | undefined): string {
  if (!validTrustId(controller)) throw new Stop(USAGE);
  return stop(() => {
    const file = readTrustFile(), keyPath = trustKeyPath(controller);
    const entry = file.controllers[controller];
    if (!entry && !lexists(keyPath)) return `제어자 ${controller} 는 이 PC 에서 신뢰하지 않습니다.`;
    confirmOnTerminal([
      `이 PC 의 대시보드 제어자 ${controller} 신뢰를 해제합니다${entry ? `(지문 ${entry.fingerprint})` : ""}.`,
      `- 개인 키 ${keyPath} 를 지우고, 이후 이 제어자의 페어링(pair.challenge·pair)을 받지 않습니다.`,
      "- 이미 켠 연동·발급한 토큰·사람 채널은 그대로입니다. 프로젝트별로 끊으려면 그 프로젝트에서 code-agent master disable 을 실행합니다.",
    ].join("\n"), "untrust");
    const { [controller]: _removed, ...rest } = file.controllers;
    const revoked = entry ? [...file.revoked, { ...entry, revokedAt: new Date().toISOString(), revokedBy: { actor: actorName(), channel: "tty" as const } }].slice(-50) : file.revoked;
    // 기록을 먼저 고친다 — 키를 지우다 실패해도 신뢰는 이미 풀려 있다
    writeTrustFile({ version: 1, controllers: rest, revoked });
    if (lexists(keyPath)) rmSync(keyPath, { force: true });
    return `대시보드 제어자 ${controller} 의 신뢰를 해제했습니다. 이미 켠 연동은 master status 에 '신뢰 해제된 제어자'로 표시됩니다.`;
  });
}

/** 신뢰 목록(읽기 전용) — 공개 정보와 개인 키 자리만 보인다 */
export function masterTrustList(): string {
  return stop(() => {
    const file = readTrustFile();
    const ids = Object.keys(file.controllers);
    if (!ids.length && !file.revoked.length) return "이 PC 에서 신뢰한 대시보드 제어자가 없습니다 — code-agent master trust --controller <ID>";
    return [
      ...ids.map((id) => {
        const entry = file.controllers[id], keyPath = trustKeyPath(id);
        const notes = [...(sound(id, entry) ? [] : ["기록 손상 — 신뢰하지 않음"]), ...(existsSync(keyPath) ? [] : ["개인 키 파일 없음"])];
        return `신뢰: ${id} · 지문 ${entry.fingerprint} · 등록 ${entry.createdAt}${entry.createdBy?.channel === "dashboard" ? "(대시보드 확인)" : ""} · 개인 키 ${keyPath}${notes.length ? ` (${notes.join(", ")})` : ""}`;
      }),
      ...file.revoked.slice(-10).map((entry) => `해제: ${entry.controller} · 지문 ${entry.fingerprint} · 해제 ${entry.revokedAt}`),
    ].join("\n");
  });
}
