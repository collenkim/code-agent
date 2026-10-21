/**
 * 버전 경계의 명령 — 다음 작업을 여는 명령의 관문(atNextWork), 버전 조회(version), update 의 갈래(runUpdate).
 *
 * 다음 작업을 여는 명령(요구사항 접수·문서 준비·사전 판별·작업 시작)은 먼저 예약된 새 버전을 적용하고, 적용됐으면 같은 명령을
 * 진입점으로 다시 실행해 새 버전으로 연다. 세션 파일은 실행 잠금(runtime.lock) 안에서 만든다 — 적용(runtimeApply.applyHere)도
 * 같은 잠금 안에서 진행 중인 일을 다시 보므로, 버전 전환과 새 작업의 시작이 엇갈리지 않는다.
 * 진입점이 npm 패키지면 예약 대신 그 패키지(사람이 패키지 관리자로 설치한 것)를 릴리스로 복사해 적용한다 — 작업은 늘 복사본으로 돌아,
 * 패키지 관리자가 진입점을 바꿔도 진행 중인 작업의 코드가 바뀌지 않는다.
 */
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

import { writeAtomic } from "../core/atomic";
import { isPackaged, packageVersion } from "./assets";
import type { HostSelection } from "./hosts";
import { STATE_DIR } from "./layout";
import { pidAlive } from "./lock";
import { installPackageRelease, listReleases, packageRelease } from "./releaseStore";
import { applyHere, busyReasons, lockRuntime, ownLabel, requireInstalled, type ApplyTrigger } from "./runtimeApply";
import { appliedStore, entryPackage, entryScript, installedRelease, ownRelease, readRuntime, releaseHome, RUNTIME_FILE, type RuntimeState } from "./runtimeSelect";
import { runReleaseApply, SANDBOX_BLOCKED, updateFromSourceConfirmed, updateToReleaseConfirmed } from "./sourceUpdate";
import { Stop } from "./stop";

/** 같은 명령을 다시 실행한 자식 — 한 번만 다시 실행한다(선택이 끝내 맞지 않아도 되풀이하지 않는다) */
const RERUN_ENV = "CODE_AGENT_RUNTIME_RERUN";
/** 선택 UI MCP 의 실행 기록 — 장시간 도는 연결부가 어느 버전인지 version 이 보인다 */
export const CHOICE_SERVER_DIR = `${STATE_DIR}/log/choice-server`;

function runtimeOf(root: string): RuntimeState | undefined {
  try { return readRuntime(root); } catch { return undefined; }
}

/** 같은 명령을 진입점으로 다시 실행한다 — 진입점이 그 사이 바뀐 적용 버전을 고른다 */
function rerun(argv: string[]): number {
  const [file, args] = isPackaged() ? [process.execPath, argv] : [process.execPath, [entryScript(), ...argv]];
  const result = spawnSync(file, args, { stdio: "inherit", windowsHide: true, env: { ...process.env, [RERUN_ENV]: "1" } });
  if (result.error) throw new Stop(`새 버전으로 명령을 다시 실행하지 못했습니다: ${result.error.message}`);
  return result.status ?? 1;
}

/** hook 이 다음 작업을 여는 명령 직전에 적용했을 때의 보고 — 그 명령(새 버전)이 한 번 출력하고 지운다 */
export const APPLY_NOTE = `${STATE_DIR}/log/runtime-applied.json`;

/**
 * 예약된 새 버전(npm 패키지 진입점이면 설치된 패키지)을 이 프로젝트에 적용한다 — 적용했으면 true. 진행 중인 일이 있으면 하지 않고,
 * 실패하면 사유를 print 로 알리고 지금 버전으로 둔다(예약은 그대로).
 */
function applyPending(root: string, state: RuntimeState | undefined, print: (text: string) => void): boolean {
  const pkg = isPackaged() ? undefined : entryPackage();
  // npm 패키지 진입점 — 사람이 패키지 관리자로 설치한 그 패키지가 새 버전이다(예약 대신). 사본을 들여 적용한다
  if (pkg) return adoptAtNextWork(root, pkg, state, print) === 0;
  const pending = state?.pending;
  if (!pending || pending.id === ownRelease()?.id || busyReasons(root).length) return false;
  if (!installedRelease(pending.id, pending.home ?? releaseHome())) {
    print(`적용 대기 중인 ${pending.id} 가 릴리스 저장소(${pending.home ?? releaseHome()})에 없습니다 — 지금 버전(${ownLabel()})으로 시작합니다. code-agent update 로 다시 설치하면 적용됩니다.`);
    return false;
  }
  let applied: { code: number; text: string };
  try { applied = runReleaseApply(root, pending.id, { trigger: "next-work", home: pending.home }); }
  catch (error) {
    print(`${error instanceof Error ? error.message : String(error)}\n지금 버전(${ownLabel()})으로 시작합니다 — 적용 대기는 그대로 둡니다.`);
    return false;
  }
  print(applied.code === 0 ? `${applied.text}\n` : applied.text);
  return applied.code === 0;
}

/**
 * 다음 작업을 여는 셸 명령 직전의 PreToolUse hook 이 부른다 — 예약된 새 버전을 여기서 적용한다. 호스트는 hook 을 샌드박스 밖에서
 * 돌리므로 Codex 샌드박스 셸이 쓰지 못하는 사본(.agents/·.codex/)과 릴리스 저장소도 여기서는 쓴다. 보고는 그 명령이 새 버전으로 출력한다.
 * 실패하면 아무것도 남기지 않는다 — 그 명령의 관문(atNextWork)이 다시 시도하고 사유를 알린다.
 */
export function applyBeforeOpening(root: string): void {
  const lines: string[] = [];
  if (!applyPending(root, runtimeOf(root), (text) => lines.push(text))) return;
  writeAtomic(join(root, APPLY_NOTE), `${JSON.stringify({ id: runtimeOf(root)?.applied, at: new Date().toISOString(), text: lines.join("\n") })}\n`);
}

/** hook 이 남긴 적용 보고 — 이 코드가 그 릴리스일 때만 돌려주고, 읽으면 지운다(다른 버전의 낡은 보고도 지운다) */
function takeApplyNote(root: string): string | undefined {
  const path = join(root, APPLY_NOTE);
  if (!existsSync(path)) return undefined;
  let note: { id?: string; text?: string } = {};
  try { note = JSON.parse(readFileSync(path, "utf8")) as typeof note; } catch { /* 깨진 기록은 버린다 */ }
  rmSync(path, { force: true });
  return note.id && note.id === ownRelease()?.id && note.text ? note.text : undefined;
}

/**
 * 다음 작업을 여는 명령의 관문. 돌려주는 것: 다시 실행했으면 그 종료 코드, 아니면 open() 의 출력.
 *  0. hook 이 직전에 적용했으면 그 보고를 낸다(applyBeforeOpening).
 *  1. 예약된 새 버전이 있고 진행 중인 일이 없으면 그 릴리스가 스스로 적용한다(update --apply-release). 적용되면 그 보고를 내고 같은 명령을 다시 실행한다.
 *  2. 실행 잠금을 쥐고 적용 버전을 다시 읽는다 — 이 프로세스를 고른 뒤 바뀌었으면 다시 실행한다.
 *  3. 잠금 안에서 open() — 세션 파일을 만든다.
 */
export function atNextWork<T extends string | Promise<string>>(root: string, argv: string[], open: () => T, print: (text: string) => void): number | T {
  const own = ownRelease()?.id;
  const again = process.env[RERUN_ENV] === "1";
  const note = takeApplyNote(root);
  if (note) print(`${note}\n`);
  if (!again && applyPending(root, runtimeOf(root), print)) return rerun(argv);
  const release = lockRuntime(root);
  let asynchronous = false;
  try {
    const current = runtimeOf(root), now = current?.applied;
    if (!again && now !== own && (now === undefined || installedRelease(now, appliedStore(current)))) {
      release();
      return rerun(argv);
    }
    const result = open();
    if (result instanceof Promise) {
      asynchronous = true;
      return result.finally(release) as T;
    }
    return result;
  } finally { if (!asynchronous) release(); }
}

/**
 * 진입점 패키지를 이 프로젝트에 들인다 — 고정이 없거나, 마지막으로 들인 패키지와 다른 패키지가 설치됐을 때만(사람이 그 뒤 --release 로
 * 고른 버전은 새 패키지가 설치될 때까지 둔다). 돌려주는 것: 적용했으면 0, 아니면 undefined(지금 버전으로 연다).
 */
function adoptAtNextWork(root: string, pkg: string, state: RuntimeState | undefined, print: (text: string) => void): 0 | undefined {
  if (busyReasons(root).length) return undefined;
  // 설치되지 않은 폴더에는 템플릿을 들이지 않는다 — 그 판정은 여는 명령 자신이 한다
  try { requireInstalled(root); } catch { return undefined; }
  let id: string;
  try { id = packageRelease(pkg).id; }
  catch (error) { print(`진입점 패키지(${pkg})를 읽지 못했습니다 — ${error instanceof Error ? error.message.split("\n")[0] : String(error)}. 지금 버전(${ownLabel()})으로 시작합니다.`); return undefined; }
  if (state?.applied === id || (state?.applied && state.adopted === id)) return undefined;
  try {
    const outcome = installPackageRelease(pkg);
    const applied = runReleaseApply(root, outcome.id, { trigger: "package" });
    if (applied.code === 0) { print(`${[...outcome.log, applied.text].join("\n")}\n`); return 0; }
    print(applied.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(`진입점 npm 패키지를 이 프로젝트에 적용하지 못했습니다 — ${message.split("\n")[0]}\n지금 버전(${ownLabel()})으로 시작합니다. ` +
      (/\b(?:EPERM|EACCES)\b/.test(message) ? SANDBOX_BLOCKED : "다시 하려면 진행 중인 일이 없을 때 code-agent update --templates-only 를 실행합니다."));
  }
  return undefined;
}

interface ChoiceServerRecord { pid: number; connector: string; entry: string; startedAt: string; lastCall?: { at: string; tool: string; handler: string } }

/** 살아 있는 선택 UI MCP 연결부 — 기록 폴더의 pid 별 파일 중 프로세스가 있는 것 */
export function liveChoiceServers(root: string): ChoiceServerRecord[] {
  const dir = join(root, CHOICE_SERVER_DIR);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((name) => /^\d+\.json$/.test(name)).flatMap((name) => {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as ChoiceServerRecord;
      return Number.isInteger(record.pid) && pidAlive(record.pid) ? [record] : [];
    } catch { return []; }
  });
}

/** 버전 조회 — 이 명령을 돌린 코드, 이 프로젝트의 적용·적용 대기 버전, 저장소에 설치된 릴리스, 실행 중인 선택 UI MCP */
export function versionView(root: string): Record<string, unknown> {
  const own = ownRelease();
  let state: RuntimeState | undefined, stateProblem: string | undefined;
  try { state = readRuntime(root); } catch (error) { stateProblem = error instanceof Error ? error.message : String(error); }
  const releases = listReleases();
  // npm 패키지 진입점이면 그 패키지의 릴리스 ID — 다음 작업을 열 때 들일 버전
  const pkg = isPackaged() ? undefined : entryPackage();
  let entryPkg: { root: string; id: string | null; problem?: string } | null = null;
  if (pkg) {
    try { entryPkg = { root: pkg, id: packageRelease(pkg).id }; }
    catch (error) { entryPkg = { root: pkg, id: null, problem: error instanceof Error ? error.message : String(error) }; }
  }
  return {
    schema: "code-agent.version v1",
    running: { kind: own ? "release" : "bundle", id: own?.id ?? null, version: packageVersion(), entry: isPackaged() ? process.execPath : entryScript(),
      entryPackage: entryPkg, ...(own ? { source: own.source, stateSchema: own.stateSchema } : {}) },
    project: { root, applied: state?.applied ?? null, appliedAt: state?.appliedAt ?? null, stateSchema: state?.stateSchema ?? null, store: state?.applied ? appliedStore(state) : null,
      adopted: state?.adopted ?? null, pending: state?.pending ?? null, ...(stateProblem ? { problem: `${RUNTIME_FILE}: ${stateProblem}` } : {}),
      busy: busyReasons(root) },
    store: { home: releaseHome(), releases: releases.map((info) => ({ id: info.id, installedAt: info.installedAt, stateSchema: info.stateSchema,
      source: info.source, contentHash: info.contentHash })) },
    choiceServers: liveChoiceServers(root),
  };
}

export function renderVersion(view: ReturnType<typeof versionView>): string {
  const running = view.running as { kind: string; id: string | null; version: string; entry: string; entryPackage: { root: string; id: string | null; problem?: string } | null };
  const project = view.project as { root: string; applied: string | null; appliedAt: string | null; adopted: string | null; pending: { id: string; since: string; reason: string } | null; problem?: string; busy: string[] };
  const pkg = running.entryPackage;
  const store = view.store as { home: string; releases: { id: string; installedAt: string; stateSchema: number; source: { kind: string; commit?: string } }[] };
  const servers = view.choiceServers as ChoiceServerRecord[];
  const latest = store.releases.at(-1)?.id;
  return [
    `code-agent 버전 — ${project.root}`,
    `  이 명령을 돌린 코드: ${running.id ?? `진입점 번들 ${running.version}`} (진입점 ${running.entry})`,
    ...(pkg ? [`  진입점 npm 패키지: ${pkg.id ?? `읽지 못함(${pkg.problem})`} — ${pkg.id && pkg.id === project.applied ? "이 프로젝트에 적용 중"
      : pkg.id && project.applied && pkg.id === project.adopted ? "사람이 고른 적용 버전을 둡니다(새 패키지를 설치하면 다음 작업부터 그 패키지)"
      : "다음 작업을 열 때 이 패키지의 사본을 적용합니다(지금 적용하려면 update --templates-only)"}`] : []),
    `  이 프로젝트 적용 버전: ${project.applied ?? "진입점 번들(고정 없음)"}${project.appliedAt ? ` · ${project.appliedAt} 적용` : ""}`,
    ...(project.problem ? [`  !! ${project.problem} — 진행 중인 일이 없으면 진입점 번들로 돕니다`] : []),
    project.pending ? `  설치 완료·적용 대기: ${project.pending.id} (${project.pending.since} 예약) — 예약 당시 사유: ${project.pending.reason}\n    실행 버전 전환은 아직 완료되지 않았습니다. 질문은 interaction list로 정리합니다. 진행 중 작업이 끝나면 다음 작업을 열 때 자동 적용하거나 호스트 밖 터미널에서 code-agent update --release ${project.pending.id}로 적용하세요. 현재 차단 사유는 아래 진행 중인 일입니다.`
      : "  적용 대기: 없음",
    `  진행 중인 일: ${project.busy.length ? project.busy.join(" · ") : "없음"}`,
    `  릴리스 저장소: ${store.home} — 설치된 릴리스 ${store.releases.length}개${latest ? ` (가장 최근 ${latest})` : ""}`,
    ...store.releases.map((info) => `    - ${info.id} · ${info.source.kind === "git" ? `커밋 ${info.source.commit}` : "패키지 사본"} · 상태 세대 ${info.stateSchema} · ${info.installedAt} 설치` +
      `${info.id === project.applied ? " · 적용 중" : ""}${info.id === project.pending?.id ? " · 적용 대기" : ""}`),
    ...(servers.length ? servers.map((server) => `  선택 UI MCP (pid ${server.pid}): 연결부 ${server.connector} · ${server.startedAt} 시작` +
      (server.lastCall ? ` · 마지막 호출 ${server.lastCall.tool} → 처리 ${server.lastCall.handler} (${server.lastCall.at})` : " · 호출 없음") +
      " — 연결부는 시작 때 버전, 처리는 호출마다 이 프로젝트의 적용 버전") : []),
  ].join("\n");
}

export interface UpdateRequest {
  templatesOnly: boolean; bundled: boolean; release?: string; applyRelease?: string; trigger?: string; consent?: string;
  host?: HostSelection; cli?: string;
}

/** update 의 갈래 — 돌려주는 코드: 0 적용·설치, 3 예약·보류(바뀐 것 없음) */
export function runUpdate(root: string, request: UpdateRequest): { code: number; text: string } {
  const modes = [request.templatesOnly, request.bundled, request.release !== undefined, request.applyRelease !== undefined].filter(Boolean).length;
  if (modes > 1) throw new Stop("update 의 --templates-only · --bundled · --release · --apply-release 는 하나만 씁니다.");
  if ((request.trigger !== undefined || request.consent !== undefined) && request.applyRelease === undefined) throw new Stop("--trigger · --consent 는 --apply-release 와만 씁니다(갱신이 내부에서 부른다).");
  // 어느 갈래든 설치되지 않은 폴더(프로젝트 밖 등)는 바꾸지 않는다 — 릴리스 설치·템플릿·적용 버전 기록 모두 쓰기 전에 멈춘다
  requireInstalled(root);
  const options = { host: request.host, cli: request.cli };
  if (request.applyRelease !== undefined) {
    const own = ownRelease();
    if (own?.id !== request.applyRelease) throw new Stop(`이 코드(${ownLabel()})는 ${request.applyRelease} 가 아닙니다 — 적용은 그 릴리스의 CLI 가 스스로 합니다.`);
    const trigger = (request.trigger ?? "update") as ApplyTrigger;
    if (!["update", "next-work", "release", "package"].includes(trigger)) throw new Stop(`--trigger 는 update · next-work · release · package 중 하나입니다: ${request.trigger}`);
    const result = applyHere(root, { ...options, trigger, consentId: request.consent });
    return { code: result.status === "applied" ? 0 : 3, text: result.text };
  }
  if (request.bundled) {
    const result = applyHere(root, { ...options, trigger: "bundled" });
    return { code: 0, text: result.text };
  }
  if (request.release !== undefined) return { code: 0, text: updateToReleaseConfirmed(root, request.release, options) };
  const pkg = request.templatesOnly && !ownRelease() && !isPackaged() ? entryPackage() : undefined;
  if (pkg) {
    // npm 패키지 진입점 — 사람이 설치한 그 패키지를 릴리스로 들여 적용한다(진행 중인 일이 있으면 다음 작업부터)
    const outcome = installPackageRelease(pkg);
    const result = runReleaseApply(root, outcome.id, { trigger: "package", ...options });
    return { code: result.code === 0 ? 0 : 3, text: [...outcome.log, result.text].join("\n") };
  }
  if (request.templatesOnly) {
    // 이미 설치해 둔 적용 대기 버전이 있으면 그 버전을 적용한다(진행 중인 일이 있으면 그대로 대기) — 지금 버전의 템플릿을 다시 쓰지 않는다
    const pending = runtimeOf(root)?.pending;
    if (pending && pending.id !== ownRelease()?.id && installedRelease(pending.id, pending.home ?? releaseHome())) {
      const result = runReleaseApply(root, pending.id, { trigger: "next-work", home: pending.home, ...options });
      return { code: result.code === 0 ? 0 : 3, text: result.text };
    }
    const result = applyHere(root, { ...options, trigger: "templates-only" });
    return { code: result.status === "applied" ? 0 : 3, text: result.text };
  }
  return { code: 0, text: updateFromSourceConfirmed(root, options) };
}
