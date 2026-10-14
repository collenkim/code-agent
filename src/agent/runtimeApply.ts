/**
 * 버전 적용 — **이 프로세스의 코드**(릴리스 저장소의 릴리스, 또는 진입점의 번들)를 이 프로젝트의 적용 버전으로 만들고 그 템플릿을 반영한다.
 *
 * 진행 중인 일(작업·접수·문서 세션·사전 판별, 응답·적용을 기다리는 확인, 다른 프로세스의 동의 적용)이 있으면 바꾸지 않고 적용을
 * 예약한다(runtime.json 의 pending) — 다음 작업을 시작할 때(request·docs·triage begin) 그 릴리스가 스스로 적용한다. 판정과 전환은
 * 프로젝트 실행 잠금(`.code-agent/runtime.lock`) 안에서 다시 확인하고, 세션을 여는 명령도 같은 잠금 안에서 연다(runtimeGate.ts).
 *
 * 템플릿은 반영 전 파일을 모두 기억했다가 도중에 실패하면 되돌리고 적용 버전을 바꾸지 않는다. 사람이 고친 스킬·에이전트 사본
 * (마지막 적용 기록 `templates.json` 의 해시와 다른 파일)은 덮어쓰지 않고 새 번들 내용을 `.code-agent/template-conflicts/` 에 둔다.
 * 승인·증거는 옮기지 않는다 — 진행 중인 작업이 없을 때만 바꾸므로 이어 받을 작업 승인이 없고, 남은 원장은 형식 세대(stateSchema)가
 * 같거나 높은 릴리스만 읽는다.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { writeAtomic } from "../core/atomic";
import { packageVersion, templateHash } from "./assets";
import { consentLockHeld, CONSENT_TITLES, OPEN_STATUSES, readConsentIndex } from "./consentState";
import { hostAssets, selectedHosts, type Host, type HostSelection } from "./hosts";
import { installedHook } from "./init";
import { loadActive, STATE_DIR } from "./layout";
import { acquireLock } from "./lock";
import { TIMING } from "./retryPolicy";
import { ownRelease, ownStore, readRuntime, RUNTIME_FILE, STATE_SCHEMA, type RuntimeState } from "./runtimeSelect";
import { Stop } from "./stop";
import { update } from "./update";

export const RUNTIME_LOCK = `${STATE_DIR}/runtime.lock`;
/** 마지막으로 적용한 스킬·에이전트 사본의 해시 — 팀이 함께 쓰는 파일이라 준비 커밋에 담는다 */
export const TEMPLATES_FILE = `${STATE_DIR}/templates.json`;
/** 사람이 고친 사본 대신 둔 새 번들 내용 — PC 별 안내라 커밋하지 않는다 */
export const CONFLICT_DIR = `${STATE_DIR}/template-conflicts`;
/** 템플릿 적용이 쓸 수 있는 설치 파일(사본 밖) — 실패하면 이것까지 되돌린다 */
const INSTALL_FILES = [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", "CLAUDE.md", "AGENTS.md", ".gitignore",
  `${STATE_DIR}/version`, `${STATE_DIR}/hosts.json`, TEMPLATES_FILE];

export type ApplyTrigger = "update" | "next-work" | "templates-only" | "release" | "package" | "bundled";
export interface ApplyOptions { host?: HostSelection; cli?: string; trigger: ApplyTrigger; consentId?: string }
export interface ApplyResult { status: "applied" | "pending" | "unchanged"; text: string }
interface TemplateManifest { schema: 1; release: string; files: Record<string, string> }

/** 이 코드의 이름 — 릴리스 ID, 번들이면 `번들 <버전>` */
export function ownLabel(): string {
  const own = ownRelease();
  return own ? own.id : `번들 ${packageVersion()}`;
}

/**
 * 갱신·적용은 code-agent 가 설치된 프로젝트만 바꾼다 — init 이 남기는 설치 기록(.code-agent/version · hosts.json)이나 두 호스트의
 * code-agent hook 등록이 있어야 한다. 대상은 실행한 위치가 속한 git 저장소의 루트(저장소가 아니면 그 폴더)라, 프로젝트 밖에서 실행하면
 * 그 폴더에 설치 파일을 새로 만들게 된다. 그 전에 아무것도 쓰지 않고 멈춘다(처음 설치는 init).
 */
export function requireInstalled(root: string): void {
  if (["version", "hosts.json"].some((name) => existsSync(join(root, STATE_DIR, name)))) return;
  if (installedHook(root, "PreToolUse", "hook") || installedHook(root, "PreToolUse", "codex-event", "codex")) return;
  throw new Stop(`이 폴더(${root})에는 code-agent 가 설치되어 있지 않아 갱신하지 않습니다 — 아무것도 바꾸지 않았습니다. ` +
    "대상은 실행한 위치가 속한 git 저장소의 루트(저장소가 아니면 그 폴더)입니다. 설치된 프로젝트 안에서 실행하거나, 이 폴더에 처음 설치하려면 code-agent init 을 씁니다.");
}

/** 진행 중인 일 — 하나라도 있으면 버전을 바꾸지 않는다. consentId 는 지금 적용 중인 갱신 동의(자기 자신)다 */
export function busyReasons(root: string, consentId?: string): string[] {
  const reasons: string[] = [];
  let active: ReturnType<typeof loadActive>;
  try { active = loadActive(root); } catch { reasons.push("작업 상태(.code-agent/active.json)를 읽지 못함"); }
  if (active) reasons.push(`진행 중인 작업 ${active.id} (${active.phase}${active.stage ? `/${active.stage}` : ""})`);
  if (existsSync(join(root, STATE_DIR, "request-session.json"))) reasons.push("요구사항 접수 중");
  if (existsSync(join(root, STATE_DIR, "docs-session.json"))) reasons.push("공통 문서 준비 세션");
  if (existsSync(join(root, STATE_DIR, "log", "triage", "active.json"))) reasons.push("사전 판별 중");
  const index = readConsentIndex(root);
  for (const [id, entry] of Object.entries(index?.open ?? {})) {
    if (id === consentId || !OPEN_STATUSES.includes(entry.status)) continue;
    if (Date.parse(entry.createdAt) < Date.now() - TIMING.consentOpenWindowMs) continue;
    reasons.push(`응답·적용을 기다리는 확인: ${(CONSENT_TITLES as Record<string, string>)[entry.action] ?? entry.action}`);
  }
  const holder = consentLockHeld(root);
  if (holder && holder.pid !== process.pid && !(consentId && holder.pid === process.ppid)) reasons.push(`다른 프로세스가 확인을 적용하는 중 (pid ${holder.pid})`);
  return reasons;
}

/** 사본의 소유 해시 — 줄바꿈과 모델·추론 강도 줄(사람의 설정을 code-agent model 이 다시 쓰는 자리)은 빼고 본다 */
export function ownedHash(text: string): string {
  return templateHash(text.replace(/\r\n/g, "\n").replace(/^model = .*\n/gm, "").replace(/^model_reasoning_effort = .*\n/gm, ""));
}

function readText(root: string, path: string): string | undefined {
  try { return readFileSync(join(root, path), "utf8"); } catch { return undefined; }
}

function readManifest(root: string): TemplateManifest | undefined {
  try {
    const value = JSON.parse(readFileSync(join(root, TEMPLATES_FILE), "utf8")) as TemplateManifest;
    return value?.schema === 1 && value.files && typeof value.files === "object" ? value : undefined;
  } catch { return undefined; }
}

export function writeRuntime(root: string, state: RuntimeState | undefined): void {
  const path = join(root, RUNTIME_FILE);
  if (!state || (!state.applied && !state.pending)) { rmSync(path, { force: true }); return; }
  writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** 반영 전 내용 — 없던 파일은 null, 파일이 아닌 것(같은 이름의 폴더 등)은 false(건드리지 않는다). 실패하면 이대로 되돌린다 */
function snapshot(root: string, paths: string[]): Map<string, string | null | false> {
  return new Map(paths.map((path) => {
    const full = join(root, path);
    return [path, !existsSync(full) ? null : statSync(full).isFile() ? readFileSync(full, "utf8") : false];
  }));
}
function restore(root: string, saved: Map<string, string | null | false>): string[] {
  const failed: string[] = [];
  for (const [path, text] of saved) {
    if (text === false) continue;
    try {
      if (text === null) { if (existsSync(join(root, path)) && statSync(join(root, path)).isFile()) rmSync(join(root, path), { force: true }); }
      else if (readText(root, path) !== text) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
    } catch { failed.push(path); }
  }
  return failed;
}

interface Changes { skills: string[]; agentsChanged: string[]; agentsAdded: string[]; instructions: string[]; hooks: string[]; mcp: boolean; other: string[] }

function classify(before: Map<string, string | null | false>, root: string): Changes {
  const changes: Changes = { skills: [], agentsChanged: [], agentsAdded: [], instructions: [], hooks: [], mcp: false, other: [] };
  for (const [path, was] of before) {
    const now = readText(root, path) ?? null;
    if (was === false || now === was) continue;
    if (/^\.(?:claude|agents)\/skills\//.test(path)) changes.skills.push(path);
    else if (/^\.(?:claude|codex)\/agents\//.test(path)) (was === null ? changes.agentsAdded : changes.agentsChanged).push(path);
    else if (path === "CLAUDE.md" || path === "AGENTS.md") changes.instructions.push(path);
    else if (path === ".claude/settings.json" || path === ".codex/hooks.json") changes.hooks.push(path);
    else if (path === ".codex/config.toml") changes.mcp = true;
    else changes.other.push(path);
  }
  return changes;
}

/**
 * 바뀐 종류별로 실행 중인 호스트가 무엇을 다시 읽는지 — 근거는 doc/install.md 5절 '호스트를 종료하지 않는다' 표와 doc/codex.md 갱신 절(호스트 공식 문서·소스와 실측).
 * 다시 열어야 하는 것은 Codex 의 hook 등록·MCP 설정·새 에이전트 파일뿐이다. 대화에 이미 실린 지침은 파일이 바뀌어도 그대로라 다시 읽게 한다.
 */
export function hostGuidance(changes: Changes, hosts: readonly Host[], versionChanged: boolean): string[] {
  const restart: string[] = [], reread: string[] = [], live: string[] = [];
  if (versionChanged) live.push("CLI·hook·검증은 다음 호출부터 새 버전으로 돕니다(hook 은 호출마다 새 프로세스)");
  // 호스트의 스킬 다시 읽기는 파일 감시라 바로 반영되지 않는다(Claude Code 2.1.299 실측: 2초 뒤 호출은 이전 본문, 20초 뒤는 새 본문) — 파일을 직접 읽힌다
  if (changes.skills.length) reread.push(`바뀐 스킬 ${changes.skills.length}개(${changes.skills.slice(0, 3).join(" · ")}${changes.skills.length > 3 ? " …" : ""}) — 대화에 이미 실린 스킬 본문은 이전 버전입니다. ` +
    "지금 단계의 스킬은 그 SKILL.md 를 파일로 다시 읽고 따릅니다(호스트의 스킬 다시 읽기는 파일 감시라 바로 반영되지 않을 수 있습니다)");
  if (changes.agentsChanged.length) live.push("바뀐 에이전트 정의는 다음 서브에이전트 호출부터 씁니다");
  for (const path of changes.instructions) reread.push(`${path} 의 code-agent 블록이 바뀌었습니다 — 대화에 실린 이전 블록은 그대로이므로 ${path} 를 다시 읽고 따릅니다`);
  if (hosts.includes("codex")) {
    if (changes.hooks.includes(".codex/hooks.json")) restart.push("Codex: hook 등록(.codex/hooks.json)이 바뀌어 다시 열고 /hooks 에서 검토·신뢰해야 새 등록이 돕니다");
    if (changes.mcp) restart.push("Codex: 선택 UI MCP 설정(.codex/config.toml)이 바뀌어 다시 열어야 새 설정으로 MCP 를 띄웁니다");
    if (changes.agentsAdded.some((path) => path.startsWith(".codex/"))) restart.push("Codex: 새 에이전트 정의는 세션을 시작할 때만 읽습니다");
  }
  if (hosts.includes("claude")) {
    if (changes.hooks.includes(".claude/settings.json")) live.push("Claude Code: hook 설정 변경은 설정 파일 감시로 실행 중인 세션에 반영됩니다(몇 초 안에 반영되지 않으면 다시 엽니다)");
  }
  return [
    restart.length ? `호스트를 다시 열어야 하는 것: ${restart.join(" · ")}` : "호스트를 다시 열 필요가 없습니다.",
    ...live.map((line) => `  - ${line}`),
    ...reread.map((line) => `  - ${line}`),
  ];
}

/**
 * 사람이 고친 사본 — 기록(templates.json)의 해시와 지금 내용이 다르고 새 번들과도 다른 파일. 기록이 없는 파일(이전 설치·처음 적용)은
 * 가리지 못하므로 덮어쓴다(이전과 같다).
 */
function conflicts(root: string, bundle: Map<string, string>, manifest: TemplateManifest | undefined): Set<string> {
  const keep = new Set<string>();
  if (!manifest) return keep;
  for (const [path, text] of bundle) {
    const current = readText(root, path), recorded = manifest.files[path];
    if (current === undefined || recorded === undefined) continue;
    const mine = ownedHash(current);
    if (mine !== recorded && mine !== ownedHash(text)) keep.add(path);
  }
  return keep;
}

/** 템플릿 반영 — 실패하면 전부 되돌리고 Stop. 돌려주는 것은 update() 보고·바뀐 종류·보존한 사본 */
export function applyTemplates(root: string, options: { host?: HostSelection; cli?: string }): { report: string; changes: Changes; kept: string[]; unknown: string[] } {
  const hosts = selectedHosts(root, options.host);
  const bundle = new Map<string, string>(hosts.flatMap((host) => [...hostAssets(host, root)]));
  const manifest = readManifest(root);
  const keep = conflicts(root, bundle, manifest);
  // 기록이 없으면(처음 적용) 사람이 고친 사본인지 가리지 못한다 — 새 번들과 다른 사본은 바꾸되 그렇다고 알린다
  const unknown = manifest ? [] : [...bundle].filter(([path, text]) => { const now = readText(root, path); return now !== undefined && ownedHash(now) !== ownedHash(text); }).map(([path]) => path).sort();
  const before = snapshot(root, [...bundle.keys(), ...INSTALL_FILES]);
  let report: string;
  try {
    report = update(root, { host: options.host, cli: options.cli, preserve: keep });
    for (const path of keep) {
      const copy = join(root, CONFLICT_DIR, path);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(copy, bundle.get(path)!);
    }
    const files: Record<string, string> = { ...(manifest?.files ?? {}) };
    for (const path of bundle.keys()) {
      if (keep.has(path)) continue;
      const text = readText(root, path);
      if (text !== undefined) files[path] = ownedHash(text);
    }
    // 이번에 반영한 호스트의 사본인데 번들에 없는 기록(이름이 바뀌었거나 빠진 파일)은 지운다 — 다른 호스트의 기록은 그대로 둔다
    const ownedBy = (path: string) => hosts.some((host) => host === "claude" ? path.startsWith(".claude/") : path.startsWith(".agents/") || path.startsWith(".codex/"));
    for (const path of Object.keys(files)) if (!bundle.has(path) && ownedBy(path)) delete files[path];
    writeAtomic(join(root, TEMPLATES_FILE), `${JSON.stringify({ schema: 1, release: ownLabel(), files: Object.fromEntries(Object.entries(files).sort()) }, null, 2)}\n`);
  } catch (error) {
    const failed = restore(root, before);
    throw new Stop([`템플릿 적용 중 실패했습니다 — ${error instanceof Error ? error.message : String(error)}`,
      failed.length ? `되돌리지 못한 파일: ${failed.join(" · ")} — 사람이 git 으로 확인하세요` : "반영 전 파일로 모두 되돌렸습니다.",
      "적용 버전은 바꾸지 않았습니다."].join("\n"));
  }
  return { report, changes: classify(before, root), kept: [...keep].sort(), unknown };
}

export function lockRuntime(root: string): () => void {
  mkdirSync(join(root, STATE_DIR), { recursive: true });
  return acquireLock(join(root, RUNTIME_LOCK), { waitMs: 5_000, ageReclaim: true, label: "버전 적용", display: RUNTIME_LOCK });
}

/**
 * 이 코드를 이 프로젝트에 적용한다. trigger:
 *  - update·release: 갱신이 설치한(또는 고른) 이 릴리스로 바꾼다. 바쁘면 예약.
 *  - package: 사람이 npm 으로 설치한 진입점 패키지의 사본(이 릴리스)으로 바꾸고 그 ID 를 `adopted` 로 남긴다. 바쁘면 예약.
 *  - next-work: 예약된 이 릴리스를 다음 작업을 열기 직전에 적용한다. 바쁘면 그대로 예약.
 *  - templates-only: 지금 적용 버전의 템플릿을 다시 반영한다(버전은 그대로). 바쁘면 보류.
 *  - bundled: 고정을 풀고 진입점 번들로 돌아간다. 바쁘면 거부.
 */
export function applyHere(root: string, options: ApplyOptions): ApplyResult {
  const own = ownRelease();
  if (!own && options.trigger !== "templates-only" && options.trigger !== "bundled") {
    throw new Stop("이 코드는 릴리스 저장소의 릴리스가 아닙니다 — 적용 버전으로 등록할 수 없습니다(진입점 번들은 update --bundled 로 고릅니다).");
  }
  let release: () => void;
  try { release = lockRuntime(root); }
  catch (error) {
    if (!(error instanceof Stop) || !own || options.trigger === "templates-only" || options.trigger === "bundled") throw error;
    return reserve(root, own.id, `다른 code-agent 명령이 버전 적용 잠금을 쥐고 있음 — ${error.message.split("\n")[0]}`);
  }
  try {
    let state: RuntimeState | undefined;
    try { state = readRuntime(root); }
    catch (error) { throw new Stop(`${RUNTIME_FILE} 을 읽지 못했습니다 — ${error instanceof Error ? error.message : String(error)}. 사람이 파일을 확인하세요(지우면 진입점 번들로 돕니다).`); }
    const from = state?.applied ?? `번들`;
    const target = options.trigger === "bundled" ? undefined : own?.id;
    const busy = busyReasons(root, options.consentId);
    if (busy.length) {
      if (options.trigger === "templates-only") return { status: "unchanged", text: `진행 중인 일이 있어 템플릿을 반영하지 않았습니다 — ${busy.join(" · ")}. 지금 버전(${ownLabel()})으로 계속하고, 작업을 반영하거나 끝낸 뒤 다시 실행하세요.` };
      if (options.trigger === "bundled" || !target) throw new Stop(`진행 중인 일이 있어 진입점 번들로 바꾸지 않았습니다 — ${busy.join(" · ")}`);
      if (state?.applied === target) return { status: "unchanged", text: `${target} 이 이미 적용되어 있습니다.` };
      return reserve(root, target, busy.join(" · "), state);
    }
    const projectSchema = state?.stateSchema ?? 1, mine = own?.stateSchema ?? STATE_SCHEMA;
    if (projectSchema > mine) {
      throw new Stop(`이 프로젝트의 상태는 더 새 형식(세대 ${projectSchema})으로 기록됐습니다 — ${ownLabel()}(세대 ${mine})은 그 상태를 읽지 못해 적용하지 않습니다. 세대 ${projectSchema} 이상의 릴리스를 쓰세요.`);
    }
    const { report, changes, kept, unknown } = applyTemplates(root, { host: options.host, cli: options.cli });
    // 사람이 고른 버전(--release·--bundled, 사람이 설치한 npm 패키지)이면 남은 예약을 지운다 — 다음 작업에서 그 선택을 되돌리지 않게
    const explicit = options.trigger === "release" || options.trigger === "bundled" || options.trigger === "package";
    const pending = !explicit && state?.pending && state.pending.id !== target ? state.pending : undefined;
    const adopted = options.trigger === "package" ? target : state?.adopted;
    writeRuntime(root, { schema: 1, ...(target ? { applied: target, appliedAt: new Date().toISOString(), home: ownStore() } : {}),
      stateSchema: Math.max(projectSchema, mine), ...(pending ? { pending } : {}), ...(adopted ? { adopted } : {}) });
    const versionChanged = (state?.applied ?? undefined) !== target;
    return { status: "applied", text: [
      versionChanged ? `적용 버전: ${from} → ${target ?? `번들 ${packageVersion()}`}` : `적용 버전: ${ownLabel()} (그대로 — 템플릿 다시 반영)`,
      report,
      ...(kept.length ? [`  !! 사람이 고친 사본 ${kept.length}개는 덮어쓰지 않았습니다: ${kept.slice(0, 5).join(" · ")}${kept.length > 5 ? ` (+${kept.length - 5})` : ""}`,
        `     새 번들 내용은 ${CONFLICT_DIR}/ 아래 같은 경로에 있습니다 — 사람이 병합한 뒤 code-agent update --templates-only 로 다시 반영하세요.`] : []),
      ...(unknown.length ? [`  !! 마지막 적용 기록(${TEMPLATES_FILE})이 없어 사람이 고친 사본인지 가리지 못했습니다 — 번들과 달랐던 사본 ${unknown.length}개를 새 번들로 바꿨습니다: ${unknown.slice(0, 5).join(" · ")}${unknown.length > 5 ? ` (+${unknown.length - 5})` : ""}`,
        "     이전 내용은 git 으로 확인하세요. 이제 기록이 생겨 다음 적용부터는 사람이 고친 사본을 보존합니다."] : []),
      "",
      ...hostGuidance(changes, selectedHosts(root, options.host), versionChanged),
      "  바뀐 설치 파일은 다음 작업을 시작하기 전에 준비 커밋(setup/baseline 확인)으로 반영됩니다 — 작업의 계획 밖 변경이 되지 않습니다.",
    ].join("\n") };
  } finally { release(); }
}

function reserve(root: string, id: string, reason: string, state = (() => { try { return readRuntime(root); } catch { return undefined; } })()): ApplyResult {
  writeRuntime(root, { ...(state ?? { schema: 1 }), schema: 1, pending: { id, since: new Date().toISOString(), reason, home: ownStore() } });
  return { status: "pending", text: [
    `새 버전 ${id} 설치 완료. 현재 작업은 기존 버전(${state?.applied ?? "번들"})으로 계속 진행하며, 작업 완료 후 다음 작업부터 새 버전을 적용합니다.`,
    `  대기 사유: ${reason}`,
    "  적용 시점: 진행 중인 일이 끝난 뒤 다음 작업을 시작할 때(요구사항 접수·문서 준비·사전 판별 시작) 자동으로 — 호스트를 종료할 필요가 없습니다.",
    "  지금 할 일: 없습니다. 바로 적용하려면 작업을 반영하거나 끝낸 뒤 code-agent update --templates-only 를 실행합니다.",
  ].join("\n") };
}
