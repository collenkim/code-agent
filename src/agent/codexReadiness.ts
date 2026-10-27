import { canonical as real, pathKey as fold, samePath } from "./layout";
/**
 * Codex 실행 준비 판정 — 관리 실행이 띄울 같은 실행 파일·계정(CODEX_HOME)·작업 경로로 Codex app-server 를 띄워 묻는다.
 * 설정 파일을 직접 읽어 추정하지 않는다.
 *
 * 1. `config/read {includeLayers, cwd}` — 저장소 `.codex` 의 project 층에 비활성화 사유(disabledReason)가 있으면 Codex 가 이 저장소의
 *    프로젝트 설정·hook 을 끈 것이다. 신뢰 항목이 없을 때·`trust_level = "untrusted"`일 때·상위 폴더만 신뢰했을 때가 모두 이렇게 나오고,
 *    그동안 hooks/list 는 hook 을 하나도 돌려주지 않는다(codex-cli 0.163.0, 2026-10-22 실측) — 그래서 프로젝트 신뢰를 먼저 알리고 hook 은
 *    신뢰한 뒤 다시 조회해 판정한다. 프로젝트 층이 켜져 있으면 실효 설정의 `[features] hooks`(옛 이름 codex_hooks)가 꺼졌는지 본다.
 * 2. `hooks/list {cwds}` — code-agent 가 설치한 Codex hook(CODEX_EVENTS)마다 로드됐는지, 신뢰(trusted·managed)·켜짐·동기 실행인지 본다.
 *    검토 전(untrusted)·바뀜(modified)·꺼짐인 hook 만 검토 대상으로 알린다. codex exec 는 신뢰되지 않은 hook 을 알리지 않고 건너뛴다.
 *    config/read 가 없는 Codex 는 hooks/list 만으로 판정한다 — hook 은 신뢰된 프로젝트에서만 로드되므로 모두 신뢰돼 있으면 준비다. 하나도
 *    로드되지 않았으면 미신뢰와 설치 누락을 가르지 못하므로 Codex 갱신을 안내한다.
 * 조회가 끝나지 않거나(시간 상한·조기 종료·RPC 오류) 판정 근거가 없으면 '조회 실패'이고 준비로 보지 않는다.
 *
 * 동기 호출자(doctor·init·제어 요청)는 같은 프로세스의 worker 가 app-server 와 대화하는 동안 Atomics.wait 로 기다린다 — 요청을 한꺼번에
 * 쓰고 stdin 을 닫으면 app-server 는 initialize 에만 답하고 끝난다(실측). 관리 실행 감독(CodexTransport)은 실제로 쓸 app-server 에 같은
 * 두 요청을 보내 같은 분류(classifyCodexReadiness)를 한다.
 *
 * 판정은 사용자 키 자리(storeDir — hook 이 모델의 읽기·쓰기를 막는다)의 `cache/codex-readiness/` 에 저장소·CODEX_HOME·실행 파일·
 * code-agent 버전마다 하나 남는다. 실행 파일·사용자 설정(신뢰·hook 검토가 여기에 기록된다)·프로젝트 hook·설정 파일의 지문이 같을 때만
 * 다시 쓴다. 대시보드는 프로젝트마다 몇 초 간격·짧은 상한으로 hello 를 부르므로 hello 는 조회하지 않고 이 기록만 읽는다 — 없거나 기한이
 * 지났으면 연동한 프로젝트에서만 분리 프로세스(`master codex-check`)가 다시 묻고, 그동안은 '확인 중'(준비 아님)이다.
 * Codex 샌드박스 안(sandboxMarkers)에서는 app-server 를 띄우지 않는다 — 지문이 같은 기록만 쓰고, 없으면 터미널에서 확인하도록 알린다.
 */
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import { Worker } from "worker_threads";

import { isPackaged, packageVersion } from "./assets";
import { hostBaseEnv, sandboxMarkers } from "./crossEnv";
import { hostLaunch } from "./hosts";
import { CODEX_EVENTS } from "./init";
import { acquireLock } from "./lock";
import { storeDir } from "./plugins/store";
import { entryScript } from "./runtimeSelect";

/** 실행 준비 상태 — 설치 누락·프로젝트 미신뢰·hook 검토 필요·조회 실패·확인 중(hello 만)·준비 완료 */
export type ReadinessState = "not-installed" | "project-untrusted" | "hooks-review" | "query-failed" | "checking" | "ready";
export interface ReadinessProblem { code: string; message: string }
/** 검토가 필요한 code-agent hook — status 는 Codex 의 trustStatus(untrusted·modified) 또는 disabled */
export interface CodexHookStatus { event: string; status: string }
/** 물은 대상 — 어느 실행 파일·계정의 판정인지(doctor·hello 가 보인다) */
export interface CodexTarget { executable: string; codexHome: string; version?: string }
export interface CodexReadiness { state: ReadinessState; problems: ReadinessProblem[]; hooks?: CodexHookStatus[]; checkedAt: string; target?: CodexTarget }
/** 조회 방식 — fresh: 지금 묻는다(doctor·init·분리 갱신), reuse: 기한 안의 판정이 있으면 쓰고 없으면 짧은 상한으로 묻는다(제어 잠금 안의
 * 접수·재개·복원), stored: 묻지 않고 기록만 읽는다(hello) */
export type CodexCheckMode = "fresh" | "reuse" | "stored";

/** app-server 응답 중 판정에 쓰는 부분 — worker 가 이만큼만 추려 넘기고, CodexTransport 는 응답 전체를 넘긴다 */
export interface CodexProbeRaw {
  error?: string;
  /** ENOENT(실행 파일 없음)·timeout·unsupported(hooks/list 가 없는 Codex) */
  code?: string;
  /** initialize 응답 — userAgent 의 Codex 버전과 Codex 가 쓰는 CODEX_HOME */
  server?: { userAgent?: string; codexHome?: string };
  /** config/read 가 없는 Codex(옛 버전) */
  configUnsupported?: boolean;
  config?: {
    layers?: { name?: { type?: string; dotCodexFolder?: string; file?: string }; disabledReason?: string | null }[] | null;
    config?: { features?: Record<string, unknown> | null } | null;
  };
  hooks?: { data?: { cwd?: string; errors?: { path?: string; message?: string }[]; hooks?: CodexHookRow[] }[] | null };
}
interface CodexHookRow { eventName?: string; handlerType?: string; enabled?: boolean; async?: boolean; trustStatus?: string; sourcePath?: string; command?: string }

/** 재검사 경로 — doctor 가 같은 조회를 하고 그 판정을 hello 가 읽는다 */
export const CODEX_RECHECK = "code-agent doctor --host codex 로 다시 확인합니다";
/** 지금 조회(doctor·init·분리 갱신)의 상한 */
const PROBE_MS = 20_000;
/** 제어 잠금 안의 조회 상한 — 다른 제어 요청이 잠금을 기다리는 시간(10초) 안에 끝나야 한다 */
const LOCKED_PROBE_MS = 8_000;
/** 답을 얻은 뒤 stdin 을 닫고 app-server 가 끝나기를 기다리는 상한 — 넘으면 프로세스 트리를 끝낸다 */
const EXIT_MS = 1_000;
/** 판정을 다시 쓰는 기한 — 지문이 같아도 이만큼 지나면 다시 묻는다(Codex 갱신·관리 설정처럼 지문 밖의 변화). 조회 실패는 짧다 */
const CACHE_TTL_MS: Record<ReadinessState, number> = {
  ready: 600_000, "project-untrusted": 600_000, "hooks-review": 600_000, "not-installed": 600_000, "query-failed": 30_000, checking: 0,
};
/** 이만큼 쓰이지 않은 기록은 지운다 */
const CACHE_KEEP_MS = 7 * 24 * 3_600_000;
/** worker 가 돌려줄 수 있는 응답 크기 — 추린 응답만 싣는다 */
const PROBE_BYTES = 1 << 20;

const now = (): string => new Date().toISOString();
const camel = (event: string): string => event[0].toLowerCase() + event.slice(1);
const HOOK_STATUS_TEXT: Record<string, string> = { untrusted: "검토 전", modified: "바뀌어 다시 검토", disabled: "꺼짐" };
/** 모르는 요청의 RPC 오류인가 — 옛 Codex 는 없는 메서드를 `Invalid request: unknown variant` 로 답한다(0.163.0 실측). worker 도 같은 식을 쓴다 */
export const unknownCodexMethod = (message: string): boolean => /unknown variant|method not found/i.test(message);
/** initialize 의 userAgent(`<클라이언트>/<Codex 버전> (…)`)에서 Codex 버전 */
const codexVersion = (raw: CodexProbeRaw): string | undefined => /^[^/\s]+\/([^\s(]+)/.exec(raw.server?.userAgent ?? "")?.[1];

/**
 * code-agent Codex hook 의 실행 조건 — CODEX_EVENTS 마다 이 저장소 `.codex/hooks.json` 의 `codex-event` 명령 hook 이 로드돼 있어야 하고,
 * 신뢰(trusted·managed)·켜짐·동기 실행이어야 돈다. 로드되지 않았거나 비동기로 등록된 것은 missing(설치 문제), 그 밖은 review(검토 대상)다.
 */
export function codexHookGate(root: string, hooks: readonly CodexHookRow[]): { missing: string[]; review: CodexHookStatus[] } {
  const source = join(root, ".codex", "hooks.json");
  const missing: string[] = [], review: CodexHookStatus[] = [];
  for (const event of CODEX_EVENTS) {
    const ours = hooks.filter((hook) => hook?.eventName === camel(event) && hook.handlerType === "command" && samePath(hook.sourcePath, source)
      && /\bcodex-event\b/.test(String(hook.command ?? "")));
    if (!ours.length) { missing.push(event); continue; }
    if (ours.some((hook) => hook.async === true)) { missing.push(`${event}(비동기 등록)`); continue; }
    if (ours.some((hook) => (hook.trustStatus === "trusted" || hook.trustStatus === "managed") && hook.enabled === true)) continue;
    const hook = ours[0];
    review.push({ event, status: hook.trustStatus === "trusted" || hook.trustStatus === "managed" ? "disabled" : String(hook.trustStatus ?? "unknown") });
  }
  return { missing, review };
}

/** app-server 응답을 실행 준비로 분류한다 — 앞 단계가 막히면 뒤 단계는 판정하지 않는다(프로젝트 미신뢰면 hook 을 알리지 않는다) */
export function classifyCodexReadiness(root: string, raw: CodexProbeRaw, checkedAt: string = now()): CodexReadiness {
  const result = (state: ReadinessState, problems: ReadinessProblem[], hooks?: CodexHookStatus[]): CodexReadiness =>
    ({ state, problems, ...(hooks ? { hooks } : {}), checkedAt });
  const failed = (detail: string): CodexReadiness => result("query-failed", [{ code: "codex-query-failed",
    message: `Codex 준비 상태를 조회하지 못했습니다 — ${detail}. 확인되기 전에는 Codex 로 실행하지 않습니다(${CODEX_RECHECK})` }]);
  const version = codexVersion(raw);
  const outdated = (detail: string): CodexReadiness => result("not-installed", [{ code: "codex-unsupported",
    message: `이 Codex${version ? `(${version})` : ""}는 ${detail} — Codex 를 갱신한 뒤 ${CODEX_RECHECK}` }]);
  if (raw.error !== undefined) {
    if (raw.code === "ENOENT") return codexNotFound(`Codex 실행 파일을 실행하지 못했습니다(${raw.error})`, checkedAt);
    if (raw.code === "unsupported") return outdated("hook 조회(hooks/list)를 지원하지 않아 code-agent hook 을 확인할 수 없습니다");
    return failed(raw.error);
  }
  const unsupported = raw.configUnsupported === true;
  if (!unsupported) {
    const layers = raw.config?.layers;
    if (!Array.isArray(layers)) return failed("config/read 가 설정 층(layers)을 돌려주지 않았습니다");
    const project = layers.find((layer) => layer?.name?.type === "project" && samePath(layer.name.dotCodexFolder, join(root, ".codex")));
    if (!project) return failed("Codex 가 이 저장소의 .codex 를 프로젝트 설정 층으로 읽지 않았습니다");
    const reason = typeof project.disabledReason === "string" ? project.disabledReason.trim() : "";
    if (reason) {
      // 실측한 사유는 모두 신뢰다(신뢰 항목 없음·untrusted·상위 폴더만 신뢰). 다른 사유도 프로젝트 설정·hook 이 꺼진 것은 같다
      return result("project-untrusted", [/trust/i.test(reason)
        ? { code: "codex-project-untrusted", message: `Codex 가 이 저장소를 신뢰하지 않아 프로젝트 설정·hook 을 껐습니다(Codex: ${reason}) — Codex 대화형 세션에서 ` +
          `이 저장소를 열어 프로젝트를 신뢰한 뒤 ${CODEX_RECHECK}. hook 검토가 필요한지는 신뢰한 뒤 다시 조회해 알립니다` }
        : { code: "codex-project-disabled", message: `Codex 가 이 저장소의 프로젝트 설정·hook 을 껐습니다(Codex: ${reason}) — 그 사유를 해결한 뒤 ${CODEX_RECHECK}. ` +
          "hook 검토가 필요한지는 그 뒤 다시 조회해 알립니다" }]);
    }
    const features = raw.config?.config?.features;
    const off = features ? (["hooks", "codex_hooks"] as const).filter((key) => features[key] === false) : [];
    if (off.length) {
      return result("not-installed", [{ code: "codex-hooks-disabled",
        message: `Codex 설정에서 hook 기능이 꺼져 있습니다([features] ${off.map((key) => `${key} = false`).join(" · ")}) — 이 설정을 지워 hook 을 켠 뒤 ${CODEX_RECHECK}` }]);
    }
  }
  const entries = raw.hooks?.data;
  if (!Array.isArray(entries)) return failed("hooks/list 응답에 data 가 없습니다");
  const entry = entries.find((item) => samePath(item?.cwd, root));
  if (!entry) return failed("hooks/list 가 이 저장소의 항목을 돌려주지 않았습니다");
  // 다른 층(사용자 hook 등)의 오류는 code-agent hook 판정과 무관하다 — 이 저장소 hooks.json 의 오류만 설치 문제로 본다
  const errors = (entry.errors ?? []).filter((error) => samePath(error?.path, join(root, ".codex", "hooks.json")));
  if (errors.length) {
    return result("not-installed", [{ code: "codex-hooks-invalid",
      message: `Codex 가 .codex/hooks.json 을 읽지 못했습니다(${errors.map((error) => String(error.message ?? "")).join(" · ")}) — code-agent init(또는 doctor)으로 복구합니다` }]);
  }
  const gate = codexHookGate(root, entry.hooks ?? []);
  if (unsupported && gate.missing.length === CODEX_EVENTS.length) {
    return outdated("프로젝트 신뢰 조회(config/read)를 지원하지 않습니다. code-agent hook 이 하나도 로드되지 않았는데 프로젝트를 신뢰하지 않아서인지 hook 이 빠져서인지 가릴 수 없습니다");
  }
  if (gate.missing.length) {
    return result("not-installed", [{ code: "codex-hooks-not-loaded",
      message: `Codex 가 code-agent hook(${gate.missing.join(" · ")})을 로드하지 않았습니다 — .codex/hooks.json 을 code-agent init(또는 doctor)으로 복구합니다` }]);
  }
  if (gate.review.length) {
    return result("hooks-review", [{ code: "codex-hooks-untrusted",
      message: `검토·신뢰가 필요한 code-agent hook: ${gate.review.map((hook) => `${hook.event}(${HOOK_STATUS_TEXT[hook.status] ?? hook.status})`).join(" · ")} — ` +
        `Codex 대화형 세션의 /hooks 에서 검토·신뢰한 뒤 ${CODEX_RECHECK}(codex exec 는 신뢰되지 않은 hook 을 알리지 않고 건너뜁니다)` }], gate.review);
  }
  return result("ready", []);
}

/** 실행 파일을 찾지 못했거나 실행하지 못했다 — 설치 누락 */
export function codexNotFound(reason: string, checkedAt: string = now()): CodexReadiness {
  return { state: "not-installed", problems: [{ code: "codex-not-found", message: `${reason} — Codex 를 설치하거나 실행 파일 설정(CODE_AGENT_CODEX_BIN·master 호스트 command)을 확인합니다` }], checkedAt };
}

/**
 * 조회 worker — app-server 를 띄워 initialize → initialized → config/read → hooks/list 를 차례로 묻고, 판정에 쓰는 필드만 추려 공유 버퍼에 쓴다.
 * 서버가 보내는 요청은 거절한다. config/read 를 모르는 Codex 는 hooks/list 만 묻는다. 결과를 얻으면 stdin 을 닫고(app-server 는 EOF 에 끝난다)
 * 자식이 끝난 뒤에 결과를 쓴다 — 먼저 돌려주면 npm 진입점 node 아래의 Codex 실행 파일이 작업 경로를 잡은 채 남아 Windows 에서 그 폴더를
 * 지우지 못한다. 상한이 지나거나 EOF 뒤에도 끝나지 않으면 Windows 는 프로세스 트리를 끝낸다. 상태 칸 0: 끝남, 1: 길이
 */
const CODEX_PROBE_WORKER = [
  "const { workerData } = require('worker_threads'); const { spawn } = require('child_process');",
  "const { file, args, cwd, env, ms, exitMs, shared, version } = workerData; const state = new Int32Array(shared, 0, 2); const bytes = new Uint8Array(shared, 8);",
  "let finished = false, child, buffer = '', stderr = ''; const result = {};",
  "const report = (value) => { let text = Buffer.from(JSON.stringify(value));",
  "  if (text.length > bytes.length) text = Buffer.from(JSON.stringify({ error: 'Codex 응답이 너무 큽니다' }));",
  "  bytes.set(text); state[1] = text.length; Atomics.store(state, 0, 1); Atomics.notify(state, 0); };",
  "const stop = () => { if (process.platform === 'win32' && child && child.pid) {",
  "    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', detached: true }).unref(); return; } catch {} }",
  "  try { child && child.kill(); } catch {} };",
  "const done = (value) => { if (finished) return; finished = true; clearTimeout(timer);",
  "  if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) { report(value); return; }",
  "  if (value.code === 'timeout') { stop(); report(value); return; }",
  "  const late = setTimeout(() => { stop(); report(value); }, exitMs);",
  "  child.once('exit', () => { clearTimeout(late); report(value); });",
  "  try { child.stdin.end(); } catch {} };",
  "const timer = setTimeout(() => done({ error: 'Codex app-server 가 ' + (ms / 1000) + '초 안에 답하지 않았습니다', code: 'timeout', server: result.server }), ms);",
  "const send = (row) => child.stdin.write(JSON.stringify(row) + '\\n');",
  "const tail = () => stderr.trim().split(/\\r?\\n/).filter(Boolean).slice(-3).join(' / ');",
  "const STEP = { 'ca-i': 'initialize', 'ca-c': 'config/read', 'ca-h': 'hooks/list' };",
  "const unknown = (e) => e.code === -32601 || /unknown variant|method not found/i.test(String(e.message || ''));",
  "const configOf = (r) => { const f = r && r.config && r.config.features;",
  "  return { layers: Array.isArray(r && r.layers) ? r.layers.map((l) => ({ name: l && l.name, disabledReason: l && typeof l.disabledReason === 'string' ? l.disabledReason : null })) : null,",
  "    config: { features: f && typeof f === 'object' ? { hooks: f.hooks, codex_hooks: f.codex_hooks } : null } }; };",
  "const hooks = (r) => ({ data: Array.isArray(r && r.data) ? r.data.map((e) => ({ cwd: e && e.cwd, errors: Array.isArray(e && e.errors) ? e.errors : [],",
  "  hooks: Array.isArray(e && e.hooks) ? e.hooks.map((h) => ({ eventName: h.eventName, handlerType: h.handlerType, enabled: h.enabled, async: h.async,",
  "    trustStatus: h.trustStatus, sourcePath: h.sourcePath, command: h.command })) : [] })) : null });",
  "try {",
  "  child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });",
  "  child.on('error', (error) => done({ error: error.message, code: error.code }));",
  "  child.on('close', (code) => done({ error: 'Codex app-server 가 답하기 전에 끝났습니다(exit ' + code + ')' + (tail() ? ' — ' + tail() : ''), server: result.server }));",
  "  child.stdin.on('error', () => {}); child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');",
  "  child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk; });",
  "  child.stdout.on('data', (chunk) => { buffer += chunk; for (let index; (index = buffer.indexOf('\\n')) >= 0;) {",
  "    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); if (!line) continue;",
  "    let row; try { row = JSON.parse(line); } catch { continue; }",
  "    if (row.method && row.id !== undefined) { send({ id: row.id, error: { code: -32601, message: 'code-agent readiness probe' } }); continue; }",
  "    if (row.error && row.id === 'ca-c' && unknown(row.error)) { result.configUnsupported = true; send({ id: 'ca-h', method: 'hooks/list', params: { cwds: [cwd] } }); continue; }",
  "    if (row.error && row.id === 'ca-h' && unknown(row.error)) { done({ error: 'hooks/list 를 지원하지 않습니다', code: 'unsupported', server: result.server }); return; }",
  "    if (row.error && STEP[row.id]) { done({ error: STEP[row.id] + ' 실패: ' + String(row.error.message || JSON.stringify(row.error)), server: result.server }); return; }",
  "    if (row.id === 'ca-i') { result.server = { userAgent: row.result && row.result.userAgent, codexHome: row.result && row.result.codexHome };",
  "      send({ method: 'initialized', params: {} }); send({ id: 'ca-c', method: 'config/read', params: { includeLayers: true, cwd } }); }",
  "    else if (row.id === 'ca-c') { result.config = configOf(row.result); send({ id: 'ca-h', method: 'hooks/list', params: { cwds: [cwd] } }); }",
  "    else if (row.id === 'ca-h') { result.hooks = hooks(row.result); done(result); return; } } });",
  "  send({ id: 'ca-i', method: 'initialize', params: { clientInfo: { name: 'code_agent', title: 'code-agent', version } } });",
  "} catch (error) { done({ error: String((error && error.message) || error), code: error && error.code }); }",
].join("\n");

/**
 * 조회 실행 — 동기 호출자가 worker 의 결과를 기다린다. worker 를 띄우지 못했거나 답이 없으면 오류 결과(조회 실패)다.
 * 시험만 이 자리를 바꿔 끼운다(환경 변수로 열지 않는다 — 준비 판정을 끄는 길을 두지 않는다).
 */
export const codexProbeRunner = {
  query(launch: { file: string; prefix: string[] }, root: string, env: Record<string, string | undefined>, ms: number): CodexProbeRaw {
    let worker: Worker | undefined;
    try {
      const shared = new SharedArrayBuffer(8 + PROBE_BYTES);
      const state = new Int32Array(shared, 0, 2);
      worker = new Worker(CODEX_PROBE_WORKER, { eval: true, workerData: {
        file: launch.file, args: [...launch.prefix, "app-server", "--listen", "stdio://"], cwd: root, env, ms, exitMs: EXIT_MS, shared, version: packageVersion() } });
      worker.unref();
      worker.on("error", () => { /* 답이 없으면 아래에서 조회 실패로 본다 — 늦은 오류 이벤트가 CLI 를 죽이지 않게 */ });
      // worker 는 상한(ms)과 종료 대기(EXIT_MS)에 스스로 끝낸다 — 여유는 worker 기동만큼이다
      Atomics.wait(state, 0, 0, ms + EXIT_MS + 1_000);
      if (Atomics.load(state, 0) !== 1) return { error: `조회 worker 가 ${Math.round(ms / 1000)}초 안에 끝나지 않았습니다`, code: "timeout" };
      return JSON.parse(Buffer.from(new Uint8Array(shared, 8, state[1])).toString("utf8")) as CodexProbeRaw;
    } catch (error) {
      return { error: `조회 worker 를 실행하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      try { worker?.terminate().catch(() => undefined); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ }
    }
  },
};

export interface CodexCheckOptions {
  /** master 호스트 설정의 command — 없으면 기본(`codex` → hostCommand) */
  command?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * stored(hello) — 기록이 없거나 기한이 지났으면 분리 프로세스로 다시 묻는다. 연동한 프로젝트에서만 켠다. 인증 없는 hello 가 실행을 일으키므로
   * 실행 파일이 절대 경로일 때만 띄운다(상대 경로면 작업 경로의 파일이 실행될 수 있다 — 그때는 사람이 doctor 로 묻는다)
   */
  kick?: boolean;
}

type Launch = { file: string; prefix: string[] };
interface Place { dir: string; file: string; lock: string; kick: string; key: string }

/**
 * Codex 실행 준비 — mode 가 묻는 방식을 정한다(CodexCheckMode). 실행 파일을 찾지 못하면 묻지 않고 설치 누락이다.
 * Codex 샌드박스 안에서는 묻지 않는다 — 다른 Codex 를 띄우면 막히거나 샌드박스의 결과가 나온다.
 */
export function codexReadiness(root: string, mode: CodexCheckMode, options: CodexCheckOptions = {}): CodexReadiness {
  const source = options.env ?? process.env;
  const env = hostBaseEnv(source);
  const launch = hostLaunch("codex", options.command ?? ["codex"]);
  if (typeof launch === "string") return codexNotFound(launch);
  const place = cachePlace(root, launch, env);
  const entry = readCache(place);
  const fresh = !!entry && Date.now() - Date.parse(entry.result.checkedAt) < ttlOf(entry.result);
  if (mode === "stored") {
    if (entry && fresh) return entry.result;
    const kicked = options.kick === true && isAbsolute(launch.file) && !sandboxMarkers(source) && kickCodexCheck(root, place);
    return entry?.result ?? unchecked(kicked);
  }
  if (sandboxMarkers(source)) return entry?.result ?? sandboxed();
  // 조회 실패도 기한(짧다) 동안은 다시 쓴다 — 멈춘 Codex 를 제어 잠금 안에서 거듭 기다리지 않게
  if (mode === "reuse" && entry && fresh) return entry.result;
  return probe(root, launch, env, place, mode === "reuse" ? LOCKED_PROBE_MS : PROBE_MS);
}

/** 분리 갱신 — `code-agent master codex-check` 가 부른다. 같은 기록을 갱신하는 다른 프로세스가 있으면 하지 않는다 */
export function refreshCodexReadiness(root: string, options: CodexCheckOptions = {}): void {
  const source = options.env ?? process.env;
  if (sandboxMarkers(source)) return;
  const env = hostBaseEnv(source);
  const launch = hostLaunch("codex", options.command ?? ["codex"]);
  if (typeof launch === "string" || !isAbsolute(launch.file)) return;
  const place = cachePlace(root, launch, env);
  let release: () => void;
  try {
    mkdirSync(place.dir, { recursive: true, mode: 0o700 });
    release = acquireLock(place.lock, { waitMs: 0, ageReclaim: true, label: "Codex 준비 조회" });
  } catch { return; }
  try { probe(root, launch, env, place, PROBE_MS); } finally { release(); rmSync(place.kick, { force: true }); }
}

/** 묻고 기록한다 — 지문을 조회 앞뒤로 찍어 그 사이 신뢰·설정이 바뀌었으면 기록하지 않는다(바뀌기 전의 판정이 새 지문으로 남지 않게) */
function probe(root: string, launch: Launch, env: Record<string, string | undefined>, place: Place, ms: number): CodexReadiness {
  const before = baseStamps(root, launch, env);
  const raw = codexProbeRunner.query(launch, root, env, ms);
  const version = codexVersion(raw);
  const result: CodexReadiness = { ...classifyCodexReadiness(root, raw),
    target: { executable: [launch.file, ...launch.prefix].join(" "), codexHome: raw.server?.codexHome || codexHome(env), ...(version ? { version } : {}) } };
  const after = baseStamps(root, launch, env);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    const layers = (raw.config?.layers ?? []).map((layer) => layer?.name?.file).filter((file): file is string => typeof file === "string" && isAbsolute(file));
    writeCache(place, [...after, ...layers.filter((file) => !after.some(([path]) => path === file)).map(stamp)], result);
  }
  return result;
}

function unchecked(kicked: boolean): CodexReadiness {
  return { state: "checking", problems: [kicked
    ? { code: "codex-checking", message: `Codex 준비 상태를 확인하는 중입니다 — 확인되기 전에는 Codex 로 실행하지 않습니다. 계속되면 ${CODEX_RECHECK}` }
    : { code: "codex-unchecked", message: `Codex 준비 상태를 아직 확인하지 않았습니다 — 확인되기 전에는 Codex 로 실행하지 않습니다(${CODEX_RECHECK})` }], checkedAt: now() };
}
function sandboxed(): CodexReadiness {
  return { state: "query-failed", problems: [{ code: "codex-sandboxed",
    message: "Codex 샌드박스 안에서는 Codex 준비를 조회하지 않습니다(다른 Codex 를 띄우면 막히거나 샌드박스 안의 결과가 나옵니다) — " +
      `확인되기 전에는 Codex 로 실행하지 않습니다. 사람의 터미널에서 ${CODEX_RECHECK}` }], checkedAt: now() };
}
const ttlOf = (result: CodexReadiness): number =>
  result.problems.some((problem) => problem.code === "codex-unsupported") ? CACHE_TTL_MS["not-installed"] : CACHE_TTL_MS[result.state];

// ── 판정 기록 ──────────────────────────────────────────────────────────────

/** [경로, 수정 시각, 크기] — 없으면 [경로, null] */
type Stamp = [string, number, number] | [string, null];
interface CacheEntry { version: 2; key: string; stamps: Stamp[]; result: CodexReadiness }

const codexHome = (env: Readonly<Record<string, string | undefined>>): string => env.CODEX_HOME?.trim() || join(homedir(), ".codex");
function stamp(path: string): Stamp {
  try { const stat = statSync(path); return [path, stat.mtimeMs, stat.size]; } catch { return [path, null]; }
}
/** 지문 — 실행 파일, 사용자 설정(신뢰·hook 검토 기록), 프로젝트 hook·설정 파일 */
function baseStamps(root: string, launch: Launch, env: Readonly<Record<string, string | undefined>>): Stamp[] {
  return [...new Set([launch.file, ...launch.prefix.filter((arg) => isAbsolute(arg)), join(codexHome(env), "config.toml"),
    join(root, ".codex", "hooks.json"), join(root, ".codex", "config.toml")])].map(stamp);
}

/** 기록 자리 — 저장소 실제 경로·CODEX_HOME·실행 파일·code-agent 버전이 같아야 같은 기록이다(같은 계정·같은 실행 파일·같은 판정 규칙) */
function cachePlace(root: string, launch: Launch, env: Readonly<Record<string, string | undefined>>): Place {
  const key = JSON.stringify([packageVersion(), fold(real(root)), fold(codexHome(env)), launch.file, launch.prefix]);
  const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
  const dir = join(storeDir(), "cache", "codex-readiness");
  return { dir, file: join(dir, `${name}.json`), lock: join(dir, `${name}.lock`), kick: join(dir, `${name}.kick`), key };
}
/** 지문이 지금과 같은 기록 — 다르면 없는 것으로 본다 */
function readCache(place: Place): CacheEntry | undefined {
  try {
    const entry = JSON.parse(readFileSync(place.file, "utf8")) as CacheEntry;
    if (entry?.version !== 2 || entry.key !== place.key || !Array.isArray(entry.stamps) || typeof entry.result?.checkedAt !== "string") return undefined;
    return entry.stamps.every((saved) => JSON.stringify(stamp(saved[0])) === JSON.stringify(saved)) ? entry : undefined;
  } catch { return undefined; }
}
/** 쓰지 못하면 기록 없이 지나간다 — 기록은 hello 와 다음 접수를 빠르게 할 뿐이다 */
function writeCache(place: Place, stamps: Stamp[], result: CodexReadiness): void {
  if (result.state === "checking") return;
  const entry: CacheEntry = { version: 2, key: place.key, stamps, result };
  try {
    mkdirSync(place.dir, { recursive: true, mode: 0o700 });
    const temp = `${place.file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(entry), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try { renameSync(temp, place.file); } catch { rmSync(temp, { force: true }); }
    // 지운 저장소·임시 저장소의 기록이 쌓이지 않게 — 오래 쓰지 않은 기록을 치운다(잠금은 acquireLock 이 다룬다)
    for (const name of readdirSync(place.dir)) {
      const file = join(place.dir, name);
      if (/\.(json|kick|tmp)$/.test(name) && Date.now() - statSync(file).mtimeMs > CACHE_KEEP_MS) rmSync(file, { force: true });
    }
  } catch { /* 기록 없이 지나간다 */ }
}
/** 분리 갱신이 도는 중이거나 막 띄웠는가 — 잠금·띄운 표지가 조회 상한보다 새로우면 */
function refreshing(place: Place): boolean {
  return [place.lock, place.kick].some((file) => { try { return Date.now() - statSync(file).mtimeMs < PROBE_MS + 10_000; } catch { return false; } });
}
/**
 * 분리 갱신을 띄운다 — 실행 파일은 인자로 넘기지 않는다(master 연동 설정에서 다시 읽는다). 띄운 표지를 먼저 남겨 다음 hello 가 겹쳐 띄우지
 * 않는다. 띄웠거나 도는 중이면 true, 못 띄우면 false(다음 hello 가 다시 시도한다)
 */
function kickCodexCheck(root: string, place: Place): boolean {
  if (refreshing(place)) return true;
  try {
    mkdirSync(place.dir, { recursive: true, mode: 0o700 });
    writeFileSync(place.kick, now(), { encoding: "utf8", mode: 0o600 });
    const child = spawn(process.execPath, [...(isPackaged() ? [] : [entryScript()]), "master", "codex-check"],
      { cwd: root, detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env } });
    child.on("error", () => { /* 다음 hello 가 다시 시도한다 */ });
    child.unref();
    return true;
  } catch { return false; }
}
