/**
 * 사람이 터미널(TTY)에서만 하는 master 연동 설정 — 켜기·끄기·제어자 추가·위임 권한 주기·회수·강제 인계. 모두 확인 단어를 입력받는다
 * (confirmOnTerminal — stdin 이 TTY 가 아니면 거부). hook 은 호스트 세션의 셸에서 `code-agent master` 를 막는다. 켜기의 적용(applyEnable)은
 * 대시보드 페어링(pairing.ts — 사람의 대시보드 확인 + PC 신뢰 키 서명)도 같이 쓴다. 정책·호스트 설정·위임 권한은 터미널에서만 정한다.
 *
 * 위임 권한(grant)은 넓게 줄 수 없다: 작업 ID 또는 master 임무 ID 를 하나 이상, 위임 가능한 동작만, 저장소 전체가 아닌 경로 범위,
 * 만료(최대 7일)와 사용 한도(최대 100)가 필요하다.
 */
import { randomBytes, randomUUID } from "crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { isAbsolute, relative, resolve } from "path";

import { actorName } from "../actor";
import { Stop } from "../stop";
import { confirmOnTerminal } from "../tty";
import { forceHandover } from "./handover";
import { defaultManagedHost } from "./hostProfile";
import { trustedController } from "./trust";
import { ControlError, DEFAULT_POLICY, DELEGABLE_ACTIONS, HUMAN_ONLY_ACTIONS, hostProfileOf, mergePolicy, validId, type HostProfile, type Policy } from "./protocol";
import { activeRuns, reconcileRuns } from "./runs";
import {
  appendGrantRow, emit, ensureMasterDir, grantViews, listRuns, masterPath, readBinding, readOwner, tokenHash, writeBinding, writeOwner, type Binding, type EnabledBy, type Grant,
  type PairingRecord,
} from "./store";

const MAX_GRANT_DAYS = 7;
const MAX_GRANT_USES = 100;

function stop(error: unknown): never {
  if (error instanceof ControlError) throw new Stop(`${error.code}: ${error.message}`);
  throw error;
}
function readJsonFile(path: string, what: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Stop(`${what} 파일을 읽지 못했습니다(${path}): ${error instanceof Error ? error.message : error}`); }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export interface EnableOptions { controller?: string; label?: string; tokenOut?: string; policy?: string; host?: string }

/** 켜기·제어자 추가·토큰 교체의 적용 내용 — 터미널 확인(masterEnable)과 대시보드 페어링(pairing.ts)이 같은 적용 함수(applyEnable)를 쓴다 */
export interface EnablePlan { controller: string; label?: string; policy: Policy; host: HostProfile; existing?: Binding; rotating: boolean; projectId: string }
export type EnableVia = { channel: "tty"; actor: string } | { channel: "dashboard-pairing"; actor: string; pairing: PairingRecord };

/** 정책은 지금 값(없으면 기본), 호스트는 지금 값(없으면 처음 켤 때의 기본 호스트 규칙 — defaultManagedHost) 위에 사람이 고른 것을 얹는다 */
export function planEnable(root: string, controller: string, existing: Binding | undefined, choice: { label?: string; policy?: Policy; host?: HostProfile } = {}): EnablePlan {
  const host = choice.host ?? existing?.host ?? (() => {
    const kind = defaultManagedHost(root).kind;
    return kind === "claude" ? hostProfileOf(undefined) : hostProfileOf({ kind });
  })();
  return { controller, ...(choice.label ? { label: choice.label } : {}), policy: choice.policy ?? existing?.policy ?? DEFAULT_POLICY, host, ...(existing ? { existing } : {}),
    rotating: !!existing?.controllers[controller], projectId: existing?.projectId ?? randomUUID() };
}
export function enableShown(root: string, plan: EnablePlan): string {
  const { controller, existing, rotating, policy, host } = plan;
  return [
    existing ? (rotating ? `master 제어자 ${controller} 의 토큰을 새로 만듭니다(이전 토큰은 더 받지 않습니다).` : `master 제어자 ${controller} 를 더합니다(지금 소유: ${readOwner(root)?.controller ?? "없음"}).`)
      : `이 프로젝트의 master 연동을 켭니다 — 제어자 ${controller} 가 소유합니다.`,
    `프로젝트: ${root}`,
    `정책: ${JSON.stringify(policy)}`,
    host.kind === "codex" ? `호스트: ${host.command.join(" ")} · sandbox ${host.sandbox} · start·verify·repro 실행 권한은 대시보드 사람의 단건 승인 필요`
      : `호스트: ${host.command.join(" ")} · 권한 모드 ${host.permissionMode} · 허용 도구 ${host.allowedTools.join(", ")} · 금지 도구 ${host.disallowedTools.join(", ")}`,
    "연결만으로는 승인·답 권한이 생기지 않습니다 — 위임은 code-agent master grant 로 따로 줍니다.",
  ].join("\n");
}
/** 확인을 마친 켜기 적용 — binding·owner·이벤트. 토큰은 해시만 남긴다. 페어링은 제어 잠금 안에서 부른다 */
export function applyEnable(root: string, plan: EnablePlan, token: string, via: EnableVia): Binding {
  const { controller, existing, policy, host } = plan;
  const at = new Date().toISOString();
  const entry: Binding["controllers"][string] = { tokenHash: tokenHash(token), ...(plan.label ? { label: plan.label } : {}), addedAt: at, ...(via.channel === "dashboard-pairing" ? { pairing: via.pairing } : {}) };
  const enabledBy: EnabledBy = via.channel === "tty" ? { actor: via.actor, channel: "tty" }
    : { actor: via.actor, channel: "dashboard-pairing", trustFingerprint: via.pairing.trustFingerprint, approvalHash: via.pairing.approvalHash };
  const binding: Binding = existing ? { ...existing, policy, host, controllers: { ...existing.controllers, [controller]: entry } }
    : { version: 1, projectId: plan.projectId, enabledAt: at, enabledBy, policy, host, controllers: { [controller]: entry } };
  binding.hostProfiles = { ...existing?.hostProfiles, ...(existing ? { [existing.host.kind]: existing.host } : {}), [host.kind]: host };
  ensureMasterDir(root);
  writeBinding(root, binding);
  // 다시 켤 때도 세대는 이어서 올린다 — 이전 연동의 늦은 요청이 같은 세대 번호로 받아들여지지 않게
  const previous = readOwner(root);
  if (!existing || !previous) {
    const generation = (previous?.generation ?? 0) + 1;
    writeOwner(root, { controller, generation, since: at, history: [...(previous?.history ?? []), { at, controller, generation, how: via.channel === "tty" ? "enable" : "pair" }] });
  }
  emit(root, existing ? "controller.added" : "binding.enabled", { data: { controller, projectId: binding.projectId, rotated: plan.rotating, channel: via.channel } });
  return binding;
}

/** 연동 켜기 또는 제어자 추가·토큰 교체 — 토큰은 이때 한 번만 보이고 code-agent 는 해시만 둔다 */
export function masterEnable(root: string, options: EnableOptions): string {
  const controller = options.controller;
  if (!validId(controller)) throw new Stop("사용법: code-agent master enable --controller <ID> [--label <설명>] [--token-out <파일>] [--policy <정책.json>] [--host <호스트설정.json>]");
  if (options.tokenOut && inside(root, options.tokenOut)) throw new Stop("토큰 파일은 저장소 밖에 둡니다 — 저장소 안이면 실행 세션의 모델이 읽을 수 있습니다");
  const existing = readBinding(root);
  let policy = existing?.policy ?? DEFAULT_POLICY;
  let host: HostProfile | undefined;
  try {
    if (options.policy) policy = mergePolicy(policy, readJsonFile(options.policy, "정책"));
    if (options.host) host = hostProfileOf(readJsonFile(options.host, "호스트 설정"));
  } catch (error) { stop(error); }
  const plan = planEnable(root, controller, existing, { label: options.label, policy, host });
  const { rotating } = plan;
  confirmOnTerminal(enableShown(root, plan), "enable");
  const token = randomBytes(32).toString("hex");
  const binding = applyEnable(root, plan, token, { channel: "tty", actor: actorName() });
  if (options.tokenOut) writeFileSync(options.tokenOut, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return [
    existing ? `제어자 ${controller} 를 ${rotating ? "새 토큰으로 바꿨습니다" : "더했습니다"}.` : `master 연동을 켰습니다 — 프로젝트 ID ${binding.projectId}, 소유 ${controller}(세대 ${readOwner(root)?.generation}).`,
    options.tokenOut ? `토큰을 ${options.tokenOut} 에 썼습니다(다시 보여 주지 않습니다).` : `토큰(다시 보여 주지 않습니다): ${token}`,
    "위임 권한은 따로 줍니다: code-agent master grant <권한.json>",
  ].join("\n");
}

export function masterDisable(root: string): string {
  const binding = readBinding(root);
  if (!binding) return "master 연동이 켜져 있지 않습니다.";
  try { reconcileRuns(root, binding.policy, true); } catch (error) { stop(error); }
  const active = activeRuns(root);
  if (active.length) throw new Stop(`실행 중인 master 실행이 있어 끄지 않습니다: ${active.map((run) => `${run.runId}(${run.state})`).join(", ")}`);
  confirmOnTerminal(`이 프로젝트의 master 연동을 끕니다(프로젝트 ID ${binding.projectId}). 기록(실행·판단·이벤트)은 남고, 이후 master 요청은 not-enabled 로 거부됩니다.`, "disable");
  emit(root, "binding.disabled", { data: { projectId: binding.projectId, by: actorName() } });
  renameSync(masterPath(root, "binding.json"), masterPath(root, `binding.disabled-${Date.now()}.json`));
  return "master 연동을 껐습니다. 다시 켜려면 code-agent master enable --controller <ID>.";
}

/** 위임 권한 문서 검사 — 넓은 권한은 받지 않는다 */
export function grantOf(raw: unknown, binding: Binding, now = Date.now()): Omit<Grant, "createdAt" | "createdBy"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Stop("권한 문서는 객체입니다");
  const value = raw as Record<string, unknown>;
  const allowed = ["id", "controller", "works", "missions", "actions", "paths", "expiresAt", "ttlHours", "maxUses", "note"];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Stop(`모르는 권한 키: ${extra.join(", ")}`);
  const strings = (key: string): string[] => {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item.trim())) throw new Stop(`${key} 는 문자열 배열입니다`);
    return [...new Set(list as string[])];
  };
  const controller = value.controller;
  if (typeof controller !== "string" || !Object.hasOwn(binding.controllers, controller)) throw new Stop("controller 는 enable 로 등록한 제어자여야 합니다");
  const works = strings("works"), missions = strings("missions"), actions = strings("actions"), paths = strings("paths");
  if (!works.length && !missions.length) throw new Stop("works(작업 ID) 또는 missions(master 임무 ID)가 하나 이상 필요합니다 — 모든 작업에 주는 권한은 받지 않습니다");
  if ([...works, ...missions].some((id) => id.includes("*"))) throw new Stop("works·missions 에 와일드카드를 쓰지 않습니다");
  const human = actions.filter((action) => (HUMAN_ONLY_ACTIONS as readonly string[]).includes(action));
  if (human.length) throw new Stop(`사람만 하는 동작은 위임하지 않습니다: ${human.join(", ")}`);
  const unknown = actions.filter((action) => !(DELEGABLE_ACTIONS as readonly string[]).includes(action));
  if (!actions.length || unknown.length) throw new Stop(`actions 는 ${DELEGABLE_ACTIONS.join("·")} 중에서 고릅니다${unknown.length ? ` — 모르는 동작: ${unknown.join(", ")}` : ""}`);
  if ((actions.includes("plan") || actions.includes("deliver")) && !paths.length) throw new Stop("plan·deliver 위임에는 paths(계획 파일이 들어갈 경로 glob)가 필요합니다");
  const broad = paths.filter(raw => {
    const glob = raw.trim().replace(/\\/g, "/"), first = glob.split("/")[0];
    return glob.startsWith("/") || /^[A-Za-z]:/.test(glob) || glob.split("/").includes("..") ||
      (/[?*\[\]{}]/.test(glob) && (!glob.includes("/") || /[?*\[\]{}]/.test(first) || first === "."));
  });
  if (broad.length) throw new Stop(`저장소 전체·저장소 밖 경로는 받지 않습니다: ${broad.join(", ")} — 디렉토리로 좁혀 주세요`);
  let expiresAt: number;
  if (typeof value.expiresAt === "string") expiresAt = Date.parse(value.expiresAt);
  else if (typeof value.ttlHours === "number") expiresAt = now + value.ttlHours * 3_600_000;
  else throw new Stop("expiresAt(ISO 시각) 또는 ttlHours 가 필요합니다");
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Stop("만료 시각이 지났거나 올바르지 않습니다");
  if (expiresAt - now > MAX_GRANT_DAYS * 86_400_000) throw new Stop(`권한은 최대 ${MAX_GRANT_DAYS}일입니다`);
  const maxUses = value.maxUses;
  if (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_GRANT_USES) throw new Stop(`maxUses 는 1~${MAX_GRANT_USES} 정수입니다`);
  const id = typeof value.id === "string" ? value.id : `grant-${randomUUID().slice(0, 8)}`;
  if (!validId(id)) throw new Stop("id 형식이 올바르지 않습니다");
  return { id, controller, works, missions, actions, paths, expiresAt: new Date(expiresAt).toISOString(), maxUses, ...(typeof value.note === "string" ? { note: value.note.slice(0, 500) } : {}) };
}

export function masterGrant(root: string, file: string | undefined): string {
  if (!file) throw new Stop("사용법: code-agent master grant <권한.json>");
  const binding = readBinding(root);
  if (!binding) throw new Stop("master 연동이 켜져 있지 않습니다 — code-agent master enable 먼저");
  const grant = grantOf(readJsonFile(file, "권한"), binding);
  if (grantViews(root).some((item) => item.id === grant.id)) throw new Stop(`같은 ID 의 권한이 있습니다: ${grant.id}`);
  confirmOnTerminal([
    `master 제어자 ${grant.controller} 에게 위임 권한 ${grant.id} 를 줍니다.`,
    `동작: ${grant.actions.join(", ")}`,
    `작업: ${grant.works.join(", ") || "(없음)"} · 임무: ${grant.missions.join(", ") || "(없음)"}`,
    `경로: ${grant.paths.join(", ") || "(없음)"}`,
    `만료: ${grant.expiresAt} · 사용 한도: ${grant.maxUses}`,
    "이 범위 안의 routine 판단은 사람의 응답 없이 적용되고, 원장에는 master-delegation(사람 응답 아님)으로 남습니다. critical 판단과 사람만 하는 동작은 받지 않습니다.",
  ].join("\n"), "grant");
  const at = new Date().toISOString();
  appendGrantRow(root, { type: "grant", at, grant: { ...grant, createdAt: at, createdBy: { actor: actorName(), channel: "tty" } } });
  emit(root, "grant.added", { data: { grantId: grant.id, controller: grant.controller, actions: grant.actions, expiresAt: grant.expiresAt, maxUses: grant.maxUses } });
  return `위임 권한 ${grant.id} 를 줬습니다(만료 ${grant.expiresAt}, 한도 ${grant.maxUses}). 회수: code-agent master revoke ${grant.id}`;
}

export function masterRevoke(root: string, id: string | undefined, reason?: string): string {
  if (!id) throw new Stop("사용법: code-agent master revoke <권한 ID> [--reason <사유>]");
  const grant = grantViews(root).find((item) => item.id === id);
  if (!grant) throw new Stop(`권한 ${id} 가 없습니다`);
  if (grant.revoked) return `권한 ${id} 는 이미 ${grant.revoked.at} 에 회수됐습니다.`;
  confirmOnTerminal(`위임 권한 ${id}(${grant.controller} · ${grant.actions.join(", ")})를 회수합니다. 이미 적용된 판단은 되돌리지 않습니다.`, "revoke");
  const actor = actorName();
  appendGrantRow(root, { type: "revoke", at: new Date().toISOString(), id, by: { kind: "human", name: actor }, ...(reason ? { reason } : {}) });
  emit(root, "grant.revoked", { data: { grantId: id, by: `human:${actor}` } });
  return `권한 ${id} 를 회수했습니다.`;
}

export function masterHandover(root: string, to: string | undefined, forceStop: boolean): string {
  if (!to) throw new Stop("사용법: code-agent master handover --to <제어자 ID> [--force-stop]");
  const binding = readBinding(root);
  if (!binding) throw new Stop("master 연동이 켜져 있지 않습니다");
  const owner = readOwner(root);
  const runs = activeRuns(root);
  confirmOnTerminal([
    `제어권을 ${owner?.controller ?? "(없음)"}(세대 ${owner?.generation ?? 0}) → ${to} 로 넘깁니다(사람의 강제 인계).`,
    runs.length ? `실행 중: ${runs.map((run) => `${run.runId}(${run.state})`).join(", ")} — ${forceStop ? "확인된 호스트 프로세스를 끝낸 뒤" : "멈추지 않으면 넘기지 않습니다"}` : "실행 중인 실행 없음",
    `이전 제어자의 요청은 이후 fenced 로 거부되고, ${to} 가 accept 해야 실행을 받습니다.`,
  ].join("\n"), "handover");
  try {
    const next = forceHandover(root, binding, to, forceStop, actorName());
    return `제어권을 ${next.controller}(세대 ${next.generation})에게 넘겼습니다 — 인계 ${next.handover?.id}, ${to} 의 accept 를 기다립니다.`;
  } catch (error) { return stop(error); }
}

export function masterStatus(root: string, json: boolean): string {
  const binding = readBinding(root);
  const owner = readOwner(root);
  const runs = listRuns(root);
  // 페어링으로 받은 연결은 지금도 같은 지문의 PC 신뢰가 있는가 — 해제했으면 이후 페어링만 막고 지금 연결은 그대로 둔다
  const trusted = (id: string, fingerprint: string): boolean => { try { return trustedController(id)?.fingerprint === fingerprint; } catch { return false; } };
  const view = {
    enabled: !!binding, projectId: binding?.projectId ?? null, enabledBy: binding?.enabledBy ?? null,
    controllers: binding ? Object.entries(binding.controllers).map(([id, entry]) => ({ id, label: entry.label ?? null, addedAt: entry.addedAt, via: entry.pairing ? "dashboard-pairing" : "tty",
      pairing: entry.pairing ? { at: entry.pairing.at, actor: entry.pairing.actor, trustFingerprint: entry.pairing.trustFingerprint, trusted: trusted(id, entry.pairing.trustFingerprint) } : null })) : [],
    owner: owner ? { controller: owner.controller, generation: owner.generation, lastSeenAt: owner.lastSeenAt ?? null, handover: owner.handover ?? null } : null,
    policy: binding?.policy ?? null,
    grants: binding ? grantViews(root).map((grant) => ({ id: grant.id, controller: grant.controller, actions: grant.actions, works: grant.works, missions: grant.missions, paths: grant.paths,
      expiresAt: grant.expiresAt, used: grant.used, maxUses: grant.maxUses, revoked: !!grant.revoked, expired: grant.expired })) : [],
    runs: runs.slice(-10).map((run) => ({ runId: run.runId, state: run.state, mode: run.mode, workId: run.workId, links: run.links, acceptedAt: run.acceptedAt, finishedAt: run.finishedAt ?? null })),
  };
  if (json) return JSON.stringify(view, null, 2);
  if (!binding) return existsSync(masterPath(root)) ? "master 연동: 꺼짐(이전 기록 있음)" : "master 연동: 꺼짐";
  const untrusted = view.controllers.filter((item) => item.pairing && !item.pairing.trusted);
  return [
    `master 연동: 켜짐 · 프로젝트 ID ${binding.projectId} · 연결 방식 ${binding.enabledBy.channel === "dashboard-pairing" ? `대시보드 페어링(확인 ${binding.enabledBy.actor})` : `터미널(${binding.enabledBy.actor})`}`,
    `제어자: ${view.controllers.map((item) => `${item.id}(${item.pairing ? "페어링" : "터미널"})`).join(", ")} · 소유 ${owner?.controller ?? "없음"}(세대 ${owner?.generation ?? 0})${owner?.handover ? ` · 인계 ${owner.handover.id} ${owner.handover.state} → ${owner.handover.to}` : ""}`,
    ...(untrusted.length ? [`신뢰 해제된 제어자: ${untrusted.map((item) => item.id).join(", ")} — 이후 페어링은 받지 않고 지금 연결은 그대로입니다(끊으려면 master disable)`] : []),
    `위임 권한: ${view.grants.length ? view.grants.map((grant) => `${grant.id}(${grant.actions.join("/")}, ${grant.used}/${grant.maxUses}${grant.revoked ? ", 회수" : grant.expired ? ", 만료" : ""})`).join(" · ") : "없음"}`,
    `최근 실행: ${view.runs.length ? view.runs.map((run) => `${run.runId} ${run.state}`).join(" · ") : "없음"}`,
  ].join("\n");
}
