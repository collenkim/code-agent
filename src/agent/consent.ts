import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, type Stats } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { isDeepStrictEqual } from "util";
import { z } from "zod";
import { writeAtomic } from "../core/atomic";
import type { Presence } from "../core/approval";
import { abort, decide, next, nextStep, requireReproable, requireValidatable, start, status } from "./commands";
import { stageHandoff } from "./handoff";
import { changedPaths } from "./tree";
import { baselineFiles, setupBaseline } from "./bootstrap";
import { docPaths } from "./docs";
import { confirmDoc } from "./docsCommands";
import { deliver, deliveryPaths, isDeliveryExcluded, knowledgeChoices } from "./deliver";
import { approveLogBasis } from "./validate";
import { knowledgePrune, pruneCandidates } from "./knowledgeCommands";
import { findRepoRoot, loadActive, STATE_DIR } from "./layout";
import { noteHookOutput } from "./hookLog";
import { acquireLock, type LockMessages } from "./lock";
import { modelsTable, setModel, validateModelChange, workInProgress } from "./models";
import { claudeSupportsEffort, modelPolicyFingerprint } from "./modelPolicy";
import { pluginAdd, pluginRemove, previewPluginAdd, previewPluginRemove } from "./plugins/commands";
import { readStore } from "./plugins/store";
import { confirmStartNotice, confirmStartsWork, decideRequest, loadRequestSession, requestSpecPath } from "./request";
import { failure, guidance, TIMING, type FailureRecord } from "./retryPolicy";
import { KNOWLEDGE_KINDS, POLICY_KINDS, SCHEMAS } from "./schemas";
import { SnapshotCache } from "./snapshotCache";
import { Stop } from "./stop";
import { withInteraction } from "./tty";
import { loadManifestIfAny } from "./work";
import { previewSourceUpdate, sourceUpdateSnapshot, updateFromSource } from "./sourceUpdate";
import { CONSENT_DIR, CONSENT_LOCK, CONSENT_TITLES, repeatedTargetChange, updateConsentIndex } from "./consentState";
import { observeAnswerEvent } from "./answers";
import { withNotation } from "./hostText";
import { clipLine, excerpt, questionScreenProblem } from "./screenText";

export { openConsent } from "./consentState";

const ACTIONS = ["setup", "docs", "baseline", "request", "plan", "deliver", "knowledge-prune", "model", "abort", "plugin-add", "plugin-remove", "update", "repro-log", "judgment"] as const;
const ActionSchema = z.object({
  action: z.enum(ACTIONS),
  kind: z.string().optional(), id: z.string().optional(), spec: z.string().optional(),
  decision: z.enum(["accept", "reject"]).default("accept"), comment: z.string().optional(),
  agent: z.string().optional(), model: z.string().optional(), name: z.string().optional(),
  host: z.enum(["claude", "codex"]).optional(), reasoning: z.string().optional(),
  command: z.string().optional(), slots: z.string().optional(), sendsCode: z.boolean().default(false),
  secretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
}).strict();
/** 동의 동작 이름 — ca-answer 세 곳(Claude SKILL·reference, Codex ca-answer)의 목록과 테스트가 대조한다 */
export const CONSENT_ACTIONS: readonly string[] = ActionSchema.shape.action.options;
export type ConsentAction = z.input<typeof ActionSchema>;
type Action = z.output<typeof ActionSchema>;
interface Prompt { shown: string; word: string }
interface Question { question: string; header: string; options: { label: string; description: string }[]; multiSelect: false }
interface Choice { shown: string; prompt: string; target?: string; key?: string; answer?: string }
interface SnapshotEntries { files: Record<string, string>; state: Record<string, string> }
/** 동의 실패의 세부 갈래 — 안내(다시 묻는가·고치는가·멈추는가)가 갈래마다 다르다 */
export type ConsentFailureKind = "target" | "response-change" | "response-defer" | "response-none" | "response-invalid" | "apply";
/** class 는 consent-target-changed(apply 를 뺀 갈래) | consent-apply-failed(apply) */
export interface ConsentFailure extends FailureRecord { kind: ConsentFailureKind }
export interface ConsentRecord {
  id: string; root: string; action: Action; snapshot: string; createdAt: string;
  status: "pending" | "approved" | "changes-requested" | "deferred" | "applying" | "applied" | "failed";
  confirmations: Prompt[]; choices: Choice[]; summary: string;
  sessionId?: string; sessionCwd?: string; binding?: { toolId: string; questions: Question[]; cwd?: string };
  seenToolIds?: string[];
  observed?: { toolId: string; at: string; answers: Record<string, string> }[];
  result?: string;
  sourceSnapshot?: string;
  snapshotEntries?: SnapshotEntries;
  channel?: "claude-question" | "codex-prompt" | "codex-elicitation";
  /** 새 prepare 가 쓴다 — 없으면 이전 형식(확인 코드 없이 Codex 응답을 받는다) */
  format?: 2;
  /** 확인 내용 전문 파일(저장소 기준 경로). 있으면 선택 화면 질문에는 앞부분과 이 경로만 싣는다 — 없는 이전 기록은 전문을 질문에 싣는다 */
  fullText?: string;
  /** 준비 때의 작업·접수 ID — 반영 영수증이 이 작업의 동의를 고른다 */
  workId?: string;
  /** 준비 명령을 관찰한 hook 의 세션(CON-1) — 응답·적용은 이 세션에서만 받는다. 없으면 첫 응답 관찰이 세션을 정한다(이전 규칙) */
  preparedSession?: { id: string; host: "claude" | "codex"; at: string };
  failure?: ConsentFailure;
  /** `consent prepare --for <호스트>` — CLI 출력(prepare·status·finish)을 그 호스트가 쓰는 필드로 줄인다. 없으면 전체 출력(이전 형식) */
  form?: "claude" | "codex";
}
const DIR = CONSENT_DIR;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ACCEPT = "확인하고 진행";
const CHANGE = "수정 요청";
const DEFER = "보류";
const APPLY = "적용";
const KEEP = "유지";
export const TITLES: Record<Action["action"], string> = CONSENT_TITLES;
/**
 * 동의 스냅샷에서 빼는 code-agent 자체 기록 — hook·CLI 가 응답을 기다리는 동안에도 쓴다(모두 gitignore 대상).
 * 동의 기록·티켓·색인·캐시(consents), 단계 이동·검증·플러그인 로그와 Codex 미판정 도구 기록(log), 작업 임대(lease.json*).
 * 확인 화면은 이 파일들을 읽지 않으므로 빼도 사람이 확인한 대상이 줄지 않는다. 업무 답 기록(work/<ID>/answers.jsonl)은 남긴다.
 */
const SNAPSHOT_EXCLUDED = [DIR, `${STATE_DIR}/log`, `${STATE_DIR}/lease.json`, `${STATE_DIR}/lease.json.lock`];

function canonicalRoot(root: string): string {
  return realpathSync.native(resolve(root));
}
function pathKey(path: string): string {
  const key = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? key.toLowerCase() : key;
}
function samePath(a: string, b: string): boolean {
  return pathKey(canonicalRoot(a)) === pathKey(canonicalRoot(b));
}
function statIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/**
 * 루트 아래 경로의 모든 조상을 검사한다. 링크·junction을 타고 읽거나 쓰지 않는다.
 * verified 는 한 번의 스냅샷 안에서 이미 링크가 아님을 본 조상 폴더 — 같은 폴더의 파일마다 조상을 다시 lstat 하지 않는다.
 */
function localPath(root: string, file: string, allowLeafLink = false, verified?: Set<string>, leafStat?: { stat?: Stats }): string {
  const full = resolve(root, file), rel = relative(root, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Stop("확인 대상 경로가 저장소 밖입니다.");
  let cursor = root;
  const parts = rel ? rel.split(sep) : [];
  for (const [index, part] of parts.entries()) {
    if (process.platform === "win32" && part.includes(":")) throw new Stop("대체 데이터 스트림은 확인 대상으로 사용할 수 없습니다.");
    cursor = join(cursor, part);
    const leaf = index === parts.length - 1;
    if (!leaf && verified?.has(cursor)) continue;
    const stat = statIfPresent(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink() && !(allowLeafLink && leaf)) throw new Stop(`확인 대상에 심볼릭 링크가 있습니다: ${file}`);
    if (!leaf && verified) verified.add(cursor);
    if (leaf && leafStat) leafStat.stat = stat;
  }
  return full;
}
function recordPath(root: string, id: string): string {
  if (!UUID.test(id)) throw new Stop("확인 요청 ID가 올바르지 않습니다.");
  return localPath(root, `${DIR}/${id}.json`);
}
/** 기록을 쓴 뒤 같은 잠금 안에서 색인(열린 동의·최근 종료)을 고친다 */
function save(root: string, record: ConsentRecord): void {
  const file = recordPath(root, record.id); mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(record, null, 2) + "\n");
  try { updateConsentIndex(root, record); } catch { /* 색인은 보조 기록이다 — 다음 저장이 다시 만든다 */ }
}
export function loadConsent(root: string, id: string): ConsentRecord {
  root = canonicalRoot(root);
  const record = JSON.parse(readFileSync(recordPath(root, id), "utf8")) as ConsentRecord;
  if (record.id !== id || !samePath(record.root, root)) throw new Stop("다른 프로젝트의 확인 요청입니다.");
  return record;
}

/** 동의 잠금의 문구 — 기존 안내(지울 경로·pid)를 그대로 잇는다 */
const CONSENT_LOCK_MESSAGES: LockMessages = {
  busy: (lock) => `다른 확인·적용이 진행 중입니다 (pid ${lock.pid}, ${lock.at ?? "시각 모름"} 시작). 잠시 뒤 같은 명령을 한 번 다시 실행하세요.`,
  foreign: (lock) => `다른 확인·적용이 진행 중이거나 이전 프로세스가 비정상 종료했습니다. 실행 중인 code-agent 가 없으면 ${lock.display} 을 지운 뒤 다시 실행하세요.`,
  unknown: (lock) => `다른 확인·적용이 진행 중이거나 이전 프로세스가 비정상 종료했습니다. 실행 중인 code-agent 가 없으면 ${lock.display} 을 지운 뒤 다시 실행하세요.`,
};
/**
 * 같은 저장소의 확인·적용을 직렬화한다(공통 acquireLock). 주인(pid·호스트·시각)을 적고, 같은 PC 에서 그 프로세스가 끝났을 때만
 * 같은 호출 안에서 되찾는다 — Bash 시간 제한에 죽은 apply 의 잠금이 이후의 모든 확인을 막지 않게. 나이로는 회수하지 않는다(적용이
 * 길 수 있다). 살아 있는 주인은 CLI 2초·hook 10초 기다린 뒤 멈추고, 주인을 모르는 잠금은 훔치지 않고 경로를 알린다.
 */
function withConsentLock<T>(root: string, run: () => T, waitMs: number = TIMING.lockWaitMs): T {
  mkdirSync(localPath(root, DIR), { recursive: true });
  const release = acquireLock(localPath(root, CONSENT_LOCK), { waitMs, ageReclaim: false, label: "확인·적용", display: CONSENT_LOCK, messages: CONSENT_LOCK_MESSAGES });
  try { return run(); } finally { release(); }
}
function git(root: string, args: string[], optional = false): string {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }); }
  catch (error) {
    if (optional && (error as {status?: number}).status === 1) return "";
    throw new Stop("확인 대상의 Git 상태를 읽을 수 없습니다. 저장소 상태를 확인하세요.");
  }
}

// ---- 실패 기록 ----

function fail(record: ConsentRecord, kind: ConsentFailureKind, detail: string): void {
  record.failure = { ...failure(kind === "apply" ? "consent-apply-failed" : "consent-target-changed", detail), kind };
}
/** 쓸 수 없게 된 동의를 폐기한다 — 같은 동의로 다시 묻거나 적용하지 않는다 */
function discard(root: string, record: ConsentRecord, kind: "target" | "apply", detail: string): void {
  record.status = "failed"; record.binding = undefined; fail(record, kind, detail); save(root, record);
}
const KINDS: readonly ConsentFailureKind[] = ["target", "response-change", "response-defer", "response-none", "response-invalid", "apply"];
/** 실패 갈래 — kind 가 없는 기록(C5 이전에는 생길 수 없다)은 class 로 고른다 */
function kindOf(record: Pick<ConsentFailure, "class"> & { kind?: string }): ConsentFailureKind {
  return record.kind && (KINDS as readonly string[]).includes(record.kind) ? record.kind as ConsentFailureKind : record.class === "consent-apply-failed" ? "apply" : "target";
}
/**
 * 갈래별 다음 행동 안내 — 출력의 failure.guide. 문구 원천은 재시도 규약(retryPolicy.ts)이다: 적용 실패는 consent-apply-failed 기본 문구,
 * 대상 변경은 consent-target-changed 기본 문구, 승인이 아닌 응답은 그 원인의 response-* 변형. status 의 다음:(failureHint)도 같은 원천이다.
 */
export function consentGuide(record: Pick<ConsentFailure, "class" | "detail"> & { kind?: string }): string {
  const kind = kindOf(record);
  if (kind === "apply") return guidance("consent-apply-failed", { detail: record.detail });
  return guidance("consent-target-changed", { detail: record.detail }, kind === "target" ? undefined : kind);
}
function failureView(record: ConsentRecord): object | undefined {
  if (!record.failure || !["failed", "changes-requested", "deferred"].includes(record.status)) return undefined;
  const { class: cls, detail } = record.failure;
  return { class: cls, kind: kindOf(record.failure), detail, guide: consentGuide(record.failure) };
}

// ---- 스냅샷 ----

/** 승인 대상은 작업 트리·index·기준·진행 상태다. 확인 기록·로그 같은 자체 기록은 비교에서 제외한다. */
export function consentSnapshot(root: string, action: Action): string {
  return inspectConsentSnapshot(root, action).hash;
}
function inspectConsentSnapshot(root: string, action: Action): { hash: string; entries: SnapshotEntries } {
  root = canonicalRoot(root);
  const files = new Set<string>();
  /** 따라가지 않는 링크 — Git 이 그 아래 파일을 나열해도(Windows 접합점) 링크 하나로만 해시한다 */
  const links = new Set<string>();
  const skipped = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", ".idea", "__pycache__", ".pytest_cache"]);
  const excluded = (file: string) => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    return SNAPSHOT_EXCLUDED.some((path) => key === path || key.startsWith(`${path}/`));
  };
  /**
   * control: 제어 루트(상태·호스트 설정·문서) — 조상 링크는 언제나 거부한다. 마지막 구성요소 링크는 재귀로 들어간 하위 항목(nested)만
   * 허용하고 따라가지 않는다(아래 해시가 link:<대상>). 최상위 제어 루트·제어 파일·문서 경로 자체가 링크이면 거부한다 — 그렇지 않으면
   * `.code-agent` 가 링크일 때 상태 전체가 해시에서 빠진다.
   */
  function walk(dir: string, control = false, nested = false) {
    if (excluded(dir)) return;
    const full = localPath(root, dir, !control || nested);
    const stat = statIfPresent(full);
    if (!stat) return;
    if (stat.isSymbolicLink()) { files.add(dir); links.add(dir); return; }
    if (!stat.isDirectory()) { files.add(dir); return; }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      const name = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
      if (excluded(file) || name === ".git" || (!control && skipped.has(name))) continue;
      walk(file, control, true);
    }
  }
  const hasGit = !!statIfPresent(localPath(root, ".git"));
  if (hasGit) {
    if (!samePath(git(root, ["rev-parse", "--show-toplevel"]).trim(), root)) throw new Stop("Git 루트와 확인 대상 저장소가 다릅니다.");
    for (const file of git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0")) if (file) files.add(file);
  }
  // Git 저장소는 추적 파일과 무시되지 않은 새 파일만 기본 대상으로 삼는다.
  // 외부 hook의 무시된 세션·캐시는 제외하되 아래 제어 파일·문서는 반드시 포함한다.
  if (!hasGit) walk("");
  for (const dir of [".code-agent", ".claude", ".agents", ".codex", "doc", "docs"]) walk(dir, true);
  for (const file of ["code-agent.json", "CLAUDE.md", "AGENTS.md"]) walk(file, true);
  const manifest = loadManifestIfAny(root);
  for (const file of [...POLICY_KINDS, ...KNOWLEDGE_KINDS].flatMap(kind => docPaths(manifest, kind))) walk(file, true);
  for (const stage of manifest?.stages ?? []) if (stage.template) walk(stage.template, true);
  if (action.spec) walk(action.spec, true);
  if (action.action === "setup" || action.action === "baseline") for (const file of baselineFiles(root)) walk(file, true);
  const hash = createHash("sha256");
  const entries: SnapshotEntries = { files: Object.create(null), state: Object.create(null) };
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  // 내용 해시는 (size·mtime·ctime·ino) 캐시로 재사용한다 — 값과 형식은 캐시가 없을 때와 같다
  const cache = SnapshotCache.open(root);
  const verified = new Set<string>();
  const underLink = (file: string) => [...links].some((link) => file.startsWith(`${link}/`));
  for (const file of [...files].filter(f => !excluded(f) && !underLink(f)).sort()) {
    // 마지막 구성요소의 lstat 은 조상 검사가 이미 했다 — 다시 하지 않는다
    const leaf: { stat?: Stats } = {};
    const full = localPath(root, file, true, verified, leaf), stat = leaf.stat;
    const content = !stat ? "missing" : stat.isSymbolicLink() ? `link:${readlinkSync(full)}` : stat.isFile() ? cache.contentHash(file, full, stat) : stat.isDirectory() ? "directory" : "special";
    const value = JSON.stringify([file, stat?.mode, content]);
    hash.update(value);
    entries.files[file] = digest(value);
  }
  cache.save();
  const state = (name: string, value: string) => { hash.update(value); entries.state[name] = digest(value); };
  if (hasGit) {
    state("Git HEAD", JSON.stringify(git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], true)));
    state("Git 브랜치", JSON.stringify(git(root, ["symbolic-ref", "-q", "HEAD"], true)));
    state("Git 스테이지 diff", git(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]));
    state("Git index", git(root, ["ls-files", "--stage", "-z"]));
    state("Git 설정", gitConfigState(root));
  }
  if (action.action.startsWith("plugin-")) state("플러그인 저장소", JSON.stringify(readStore()));
  if (action.action === "update") state("업데이트 소스", sourceUpdateSnapshot(root));
  // 적용은 저장된 summary 를 다시 만들지 않는다 — 준비 뒤 CLI 의 모델 정책만 바뀌어도 그 동의가 새 의미로 적용되지 않게 묶는다
  if (action.action === "model") state("모델 정책", modelPolicyFingerprint());
  return { hash: hash.digest("hex"), entries };
}

/**
 * Git 설정 — 적용(커밋·hook·신원)에 닿는 값만 묶는다. 다른 worktree 의 `git push -u` 가 공유 .git/config 에 남기는
 * 추적 정보(branch.*)는 적용 내용과 무관한데, 묶으면 응답을 기다리는 동안 동의가 깨진다.
 */
function gitConfigState(root: string): string {
  const parts = git(root, ["config", "--null", "--list", "--show-origin"]).split("\0");
  const normalize = (value: string) => process.platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
  const repo = normalize(root).replace(/\/$/, "");
  let kept = "";
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const entry = parts[index + 1];
    // Codex Windows 셸은 현재 저장소와 그 하위 경로의 신뢰를 환경변수로 주입한다.
    // 설정 파일·다른 경로·전역 wildcard는 계속 비교하며 실제 Git 호출 환경은 바꾸지 않는다.
    const newline = entry.indexOf("\n");
    const value = normalize(entry.slice(newline + 1));
    const transientTrust = parts[index] === "command line:" && newline >= 0
      && entry.slice(0, newline).toLowerCase() === "safe.directory"
      && (value === repo || value === `${repo}/*`);
    if (!/^branch\./i.test(entry) && !transientTrust) kept += `${parts[index]}\0${entry}\0`;
  }
  return kept;
}

type Snapshotted = Pick<ConsentRecord, "snapshot" | "snapshotEntries" | "action">;
/** 준비 때와 다른 대상 목록 — 같으면 undefined. 판정은 해시 한 줄, 목록은 경로·상태별 해시로 만든다 */
function snapshotChanges(record: Snapshotted, current: { hash: string; entries: SnapshotEntries }): { text: string; policy: boolean } | undefined {
  if (record.snapshot === current.hash) return undefined;
  const previous = record.snapshotEntries;
  if (!previous) return { text: "이전 동의 기록에 경로별 해시 없음", policy: false };
  const changes: string[] = [];
  for (const group of ["files", "state"] as const) {
    for (const key of [...new Set([...Object.keys(previous[group]), ...Object.keys(current.entries[group])])].sort()) {
      if (previous[group][key] !== current.entries[group][key]) changes.push(group === "files" ? `파일 ${JSON.stringify(key)}` : key);
    }
  }
  const limit = 6;
  return {
    text: `${changes.slice(0, limit).join(" · ") || "스냅샷 수집 범위"}${changes.length > limit ? ` 외 ${changes.length - limit}건` : ""}`,
    policy: changes.includes("모델 정책"),
  };
}
function snapshotStop(record: Snapshotted, message: string, changes: { text: string; policy: boolean }): Stop {
  if (!record.snapshotEntries) return new Stop(`${message}\n이전 동의 기록에는 경로별 해시가 없습니다. 동의를 다시 준비하세요.`);
  // 모델 정책은 파일이 아니라 지금 도는 code-agent 빌드가 계산한다 — 준비(셸 CLI)와 hook 관찰·적용(hook 명령의 CLI)이
  // 서로 다른 설치본이면 바뀐 것이 없어도 매번 어긋나므로, "정책이 바뀌었다"만 보이지 않게 원인 후보를 함께 적는다
  const policy = changes.policy
    ? "\n이 동의를 준비한 code-agent와 지금 code-agent의 모델 정책이 다릅니다. 업데이트 직후라면 동의를 다시 준비하세요. 다시 준비해도 반복되면 code-agent doctor로 PATH의 code-agent와 hook 명령이 같은 설치본인지 확인하세요."
    : "";
  return new Stop(`${message}\n변경 대상: ${changes.text}${policy}`);
}
function requireConsentSnapshot(root: string, record: Snapshotted, message: string, current = inspectConsentSnapshot(root, record.action)): void {
  const changes = snapshotChanges(record, current);
  if (changes) throw snapshotStop(record, message, changes);
}
/** 대상이 바뀌었으면 동의를 폐기(kind target)하고 멈춘다 — 되돌려도 같은 동의로 다시 묻거나 적용하지 않는다 */
function discardIfChanged(root: string, record: ConsentRecord, message: string): void {
  const changes = snapshotChanges(record, inspectConsentSnapshot(root, record.action));
  if (!changes) return;
  discard(root, record, "target", `확인 대상 변경: ${changes.text}`);
  throw snapshotStop(record, message, changes);
}

// ---- 미리보기 ----

const CAPTURE = Symbol("capture confirmation");
function capture(run: () => string): Prompt[] {
  const prompts: Prompt[] = [];
  try {
    withInteraction({ confirm: (shown, word) => { prompts.push({ shown, word }); throw CAPTURE; }, ask: () => { throw new Stop("확인 준비에서 입력을 요청할 수 없습니다."); } }, run);
  } catch (error) { if (error !== CAPTURE) throw error; }
  return prompts;
}
const JUDGMENT_KINDS = { "retry-grant": "재시도 한도 추가", "waive-finding": "지적 기각", "cross-stop": "교차 검증 중지 결정" } as const;
/**
 * judgment 소유 함수(retryGrant·reviewJudgment)는 그 동작의 준비·적용 때만 읽는다 — hook(PreToolUse)·consent-event 가
 * 매 도구 호출마다 이 파일을 읽으므로, 정적으로 import 하면 교차·검증 흐름 모듈까지 hook 기동 비용에 든다(C5 §3.2.1, C7 OPT-15).
 */
function judgmentModules(): { grant: typeof import("./retryGrant"); review: typeof import("./reviewJudgment") } {
  return { grant: require("./retryGrant") as typeof import("./retryGrant"), review: require("./reviewJudgment") as typeof import("./reviewJudgment") };
}
type JudgmentKind = keyof typeof JUDGMENT_KINDS;
/** judgment 의 공통 검증 — kind·comment(500자)·id·name. 소유 함수(retryGrant·reviewJudgment)는 자기 도메인 전제만 본다 */
function judgmentOf(action: Action): { kind: JudgmentKind; reason: string } {
  if (!action.kind || !Object.hasOwn(JUDGMENT_KINDS, action.kind)) throw new Stop("judgment 의 kind 는 retry-grant · waive-finding · cross-stop 중 하나입니다.");
  const reason = action.comment?.trim();
  if (!reason) throw new Stop("사람 판단에는 사용자가 말한 사유(comment)가 필요합니다.");
  if (reason.length > 500) throw new Stop("사람 판단의 사유(comment)는 500자 이하로 사용자가 말한 근거를 그대로 넣으세요.");
  const kind = action.kind as JudgmentKind;
  if (kind === "waive-finding" && !action.id) throw new Stop("waive-finding 에는 지적 번호(id: F1 · X1 · C1)가 필요합니다.");
  if (kind === "cross-stop" && action.name !== "review" && action.name !== "planning") throw new Stop("cross-stop 의 name 은 review 또는 planning 입니다.");
  return { kind, reason };
}
function preview(root: string, action: Action): { confirmations: Prompt[]; choices: Choice[]; summary: string } {
  let confirmations: Prompt[] = [], choices: Choice[] = [], summary = "";
  const reject = action.decision === "reject";
  // 요구 확정이 작업 시작까지 하면(finish) 만들 브랜치를 화면에 함께 싣는다 — 이미 확정된 내용이어도 시작은 변경이다
  let starting = false;
  switch (action.action) {
    case "setup":
      confirmations = capture(() => confirmDoc(root, "all"));
      confirmations.push(...capture(() => setupBaseline(root)));
      break;
    case "docs": confirmations = capture(() => confirmDoc(root, action.kind ?? "all")); break;
    case "baseline": confirmations = capture(() => setupBaseline(root)); break;
    case "request": {
      confirmations = capture(() => decideRequest(root, action.id, reject ? "rejected" : "confirmed", action.comment, action.spec));
      const session = !reject && action.id ? confirmStartsWork(root, action.id) : undefined;
      if (session) { summary = confirmStartNotice(root, session, requestSpecPath(root, action.id!, action.spec)); starting = true; }
      break;
    }
    case "plan": confirmations = capture(() => decide(root, reject ? "rejected" : "approved", action.comment)); break;
    case "deliver": {
      const work = requireValidatable(root, "deliver");
      confirmations = capture(() => deliver(work));
      // 첫 렌더가 보고서를 복구했다면 적용 때의 확인 문구는 복구 후 상태와 맞춰 둔다.
      const first = confirmations;
      confirmations = capture(() => deliver(work));
      choices = knowledgeChoices(work).map(c => ({ shown: c.shown, prompt: "적용하려면 y", target: c.target, key: c.entry.key }));
      // 커밋 대상 중 아래 확인 화면의 '변경 요약'(기준 커밋 대비 변경·새 파일)에 이미 나오는 파일은 수만 적는다 — 같은 목록을 두 번 싣지 않는다.
      // 나머지(작업 상태·원장처럼 무시 목록이라 변경 요약에 없는 파일)는 하나씩 적어 커밋 범위 전체가 화면에 남는다.
      // 변경 요약에 있지만 커밋하지 않는 파일(전달 사본·staging·잠금 등)은 따로 적어 수만 보고 범위를 오해하지 않게 한다
      const files = [...new Set(deliveryPaths(work).flatMap(path => listLocalFiles(root, path)))].filter(file => !isDeliveryExcluded(work, file));
      const changed = new Set(work.active.baseCommit ? changedPaths(root, work.active.baseCommit).filter(change => change.status !== "D").map(change => change.path) : []);
      const below = files.filter(file => changed.has(file));
      summary = ["검증된 작업 파일·작업 문서·증거·선택한 지식 문서를 로컬 커밋합니다. 원격 push·배포는 하지 않습니다.",
        `커밋 대상(작업·문서·증거·도입 설정) ${files.length}개:`,
        ...(below.length ? [`- 아래 '변경 요약'의 추가·수정·이름변경 파일 ${below.length}개`] : []),
        ...files.filter(file => !changed.has(file)).map(file => `- ${file}`),
        ...(() => {
          const committed = new Set(files);
          const skipped = [...changed].filter(file => !committed.has(file)).sort();
          return skipped.length ? ["", "'변경 요약'에 있지만 커밋하지 않는 파일:", ...skipped.map(file => `- ${file}`)] : [];
        })(),
        ...(!isDeepStrictEqual(first, confirmations) ? ["준비 중 반영 보고서의 코드 구역을 다시 렌더했습니다."] : []),
      ].join("\n");
      break;
    }
    case "knowledge-prune":
      choices = pruneCandidates(root).found.map(c => ({ shown: [`${c.path} · ${SCHEMAS[c.kind].label}`, "", c.heading, c.body, "", `없는 경로: ${c.missing.join(" · ")}`].join("\n"), prompt: "지우려면 y", target: c.path, key: c.key }));
      summary = "선택한 오래된 지식 문서 항목만 삭제합니다. 파일 삭제나 자동 커밋은 하지 않습니다.";
      break;
    case "model": {
      const change = validateModelChange(root, action.agent, action.model, action);
      const target = action.model === "default" ? "제품 기본값(모델·추론 강도)"
        : change.host === "claude" && !claudeSupportsEffort(change.model) ? `${change.model} (추론 강도 지원 안 함)`
        : `${change.model} / ${action.reasoning ?? "지금 추론 강도 유지"}`;
      summary = `${modelsTable(root, change.host)}\n\n변경: ${change.host} / ${action.agent} → ${target}\n` +
        "기본값 복원은 모델·추론 강도를 함께 복원합니다. 모델만 변경하면 그 역할의 지금 추론 강도를 유지합니다. " +
        "적용 후 호스트를 재시작하세요. 이미 실행 중인 서브에이전트에는 소급 적용하지 않습니다.";
      break;
    }
    case "repro-log": confirmations = capture(() => approveLogBasis(requireReproable(root))); break;
    case "abort": summary = `${status(root)}\n\n접수 또는 작업 진행 상태를 종료합니다. 소스·작업 문서·Git 이력은 삭제하지 않습니다.`; break;
    case "plugin-add": summary = previewPluginAdd(root, action); break;
    case "plugin-remove": summary = previewPluginRemove(action.name); break;
    case "update":
      summary = previewSourceUpdate(root);
      if (summary.includes("업데이트 중단:")) throw new Stop(summary);
      break;
    case "judgment": {
      const { kind, reason } = judgmentOf(action);
      const { grant, review } = judgmentModules();
      const report = kind === "retry-grant" ? grant.budgetReport(root, action.name ?? "", action.id)
        : kind === "waive-finding" ? review.previewWaiveFinding(root, action.id!)
        : review.previewCrossStop(root, action.name as "review" | "planning");
      summary = [`종류: ${JUDGMENT_KINDS[kind]}`, `사유: ${reason}`, report].join("\n");
      break;
    }
  }
  summary = [TITLES[action.action], ...(reject ? [`반려 사유: ${action.comment ?? ""}`] : []), summary, ...confirmations.map(c => c.shown)].filter(Boolean).join("\n\n");
  if (!confirmations.length && !starting && ["docs", "setup", "baseline", "request"].includes(action.action)) summary += "\n현재 내용은 이미 처리되어 추가 변경이 없습니다.";
  return { confirmations, choices, summary };
}

function listLocalFiles(root: string, file: string): string[] {
  const full = localPath(root, file), stat = statIfPresent(full);
  if (!stat) return [];
  if (stat.isFile()) return [relative(root, full).replace(/\\/g, "/")];
  if (!stat.isDirectory()) throw new Stop(`일반 파일이나 디렉토리가 아닌 확인 대상입니다: ${file}`);
  return readdirSync(full).sort().flatMap(name => listLocalFiles(root, `${file}/${name}`));
}

/**
 * 확인 내용 전문 — 요약과 문서 변경 후보 전부. 선택 화면은 긴 질문을 잘라 보이므로(screenText) 질문에는 앞부분과 이 파일 경로만 싣는다.
 * 이름이 내용 해시라 같은 이름은 같은 내용이다. consents/ 아래라 스냅샷에서 빠지고, hook 이 모델의 도구 쓰기를 막는다.
 */
function writeFullText(root: string, summary: string, choices: Choice[]): string {
  const text = ["<!-- code-agent 확인 내용 전문 — 확인 준비 때 CLI 가 썼다. 선택 화면에는 앞부분만 보인다. -->", "", summary,
    ...(choices.length ? ["", "## 문서 변경 후보", ...choices.flatMap((choice, index) => ["", `### ${index + 1}번 후보`, "", choice.shown])] : []), ""].join("\n");
  const file = `${DIR}/confirm-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.md`;
  const full = localPath(root, file); mkdirSync(dirname(full), { recursive: true });
  writeAtomic(full, text);
  return file;
}
/** 앞부분 발췌 + 생략 줄 수 + 전문 경로(다 보이면 생략) */
function brief(text: string, lines: number, fullText: string, where = ""): string {
  const head = excerpt(text, lines);
  return [head.text, ...(head.omitted ? [`… 이하 ${head.omitted}줄 생략`] : []), ...(head.complete ? [] : [`전문: ${fullText}${where}`])].join("\n");
}
/** 선택 화면 질문의 앞부분 줄 수 — 문서 변경 선택 목록이 붙는 최종 확인은 줄여 screenText.QUESTION_ROWS 안에 든다 */
const HEAD_LINES = 6, HEAD_LINES_WITH_CHOICES = 3, CHOICE_LINES = 4, SELECTED_LINES = 2;
const FINAL_OPTIONS = [{label: ACCEPT,description: "표시한 내용과 선택한 범위에 한해 실행합니다."}, {label: CHANGE,description: "수정할 내용을 정리한 뒤 다시 확인합니다."}, {label: DEFER,description: "현재 상태를 유지하고 나중에 이어갑니다."}];
function questions(record: ConsentRecord): Question[] {
  const pending = record.choices.map((choice, index) => ({ choice, index })).filter(c => c.choice.answer === undefined);
  const fullText = record.fullText;
  if (pending.length) return pending.slice(0, 4).map(({choice,index}) => ({
    question: `${index + 1}. ${fullText ? brief(choice.shown, CHOICE_LINES, fullText, ` (${index + 1}번 후보)`) : choice.shown}\n${record.action.action === "knowledge-prune" ? "이 항목을 삭제할까요?" : "이 문서 갱신을 적용할까요?"}`,
    header: "문서 변경", multiSelect: false,
    options: [{label: APPLY, description: record.action.action === "knowledge-prune" ? "이 항목을 삭제합니다." : "제안한 내용으로 갱신합니다."}, {label: KEEP, description: "현재 내용을 유지합니다."}, {label: DEFER, description: "변경하지 않고 확인을 보류합니다."}],
  }));
  const answered = record.choices.map(c => `- ${c.answer}: ${c.target ?? c.shown.split("\n")[0]}${c.key ? ` · ${c.key}` : ""}`);
  if (fullText) {
    const selected = answered.length ? ["문서 변경 선택:", ...answered.slice(0, SELECTED_LINES).map(line => clipLine(line).text),
      ...(answered.length > SELECTED_LINES ? [`… 외 ${answered.length - SELECTED_LINES}개`] : [])] : [];
    return [{ question: [brief(record.summary, answered.length ? HEAD_LINES_WITH_CHOICES : HEAD_LINES, fullText), ...selected, "이 내용으로 진행할까요?"].join("\n"),
      header: "진행 확인", multiSelect: false, options: FINAL_OPTIONS }];
  }
  const selected = answered.length ? ["", "", "문서 변경 선택:", ...answered].join("\n") : "";
  return [{ question: `${record.summary}${selected}\n이 내용으로 진행할까요?`, header: "진행 확인", multiSelect: false, options: FINAL_OPTIONS }];
}
/**
 * Codex 응답의 확인 코드(CON-5) — 지금 묻는 질문 묶음의 해시 앞 6자. prepare·status 출력에 실려 모델도 보는 값이다 — 요약을 줄이다
 * 마지막 질문·코드 줄까지 빠지는 실수를 막을 뿐, 사람이 입력했다는 증명은 아니다(`codex exec resume` 한계와 같다).
 */
function replyCode(items: Question[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 6);
}
/** 확인 코드와 그 요구 여부 — 이전 형식 기록(format 없음)은 코드 없이도 받는다 */
export function codexReplyCode(root: string, id: string): { required: boolean; code: string } {
  const record = loadConsent(root, id);
  return { required: record.format === 2, code: replyCode(record.status === "pending" ? questions(record) : []) };
}
/** extra.summary: false — finish 의 대기 응답. 요약은 처음 질문 전에 한 번 보여 줬고(ca-answer), 남은 질문의 toolInput 만 필요하다 */
export function consentStatus(root: string, id: string, extra: { warning?: string; summary?: boolean } = {}): string {
  const record = loadConsent(root, id);
  const items = record.status === "pending" ? questions(record) : [];
  const coded = record.format === 2 && items.length > 0;
  const code = coded ? replyCode(items) : "";
  const codexQuestions = items.map((q, index) => ({
    question: coded && index === items.length - 1
      ? `${q.question}\n\n확인 코드: ${code} — 위 요약과 질문을 끝까지 확인했다면 응답 끝에 이 코드를 붙입니다.` : q.question,
    choices: q.options.map((o, number) => ({ number: number + 1, ...o })),
  }));
  return JSON.stringify({id, status:record.status, ...(extra.summary === false ? {} : { summary: record.summary }), questions:items,
    toolInput:{questions:items,metadata:{source:`code-agent:${id}`}},
    codexReply: items.length ? {
      format: coded ? `code-agent consent respond ${id} <질문별 선택지 번호를 쉼표로 연결> <확인 코드>` : `code-agent consent respond ${id} <질문별 선택지 번호를 쉼표로 연결>`,
      questions: codexQuestions } : undefined,
    result:record.result, failure: failureView(record), warning: extra.warning}, null, 2);
}

/**
 * 동의 준비. `options.binding` 은 CLI 가 준비 티켓(이 준비 명령을 관찰한 hook 의 세션)에서 넘긴다 — 응답은 그 세션에서만 받는다.
 * 프로세스 안에서 binding 없이 부르면(테스트 fixture) 준비 세션이 없는 기록이 되고, 첫 응답 관찰이 세션을 정한다(이전 규칙).
 * `form` 은 CLI 출력 형식이다(`--for`) — 기록에 남겨 같은 동의의 status·finish 출력도 같은 필드만 낸다(`renderConsentOutput`).
 * 함수 반환은 언제나 전체 JSON 이다(hook·Codex 응답 관찰·테스트가 쓴다).
 */
export function prepareConsent(root: string, raw: unknown, options: { binding?: { id: string; host: "claude" | "codex" }; form?: "claude" | "codex" } = {}): string {
  root = canonicalRoot(root);
  const action = ActionSchema.parse(raw);
  return withConsentLock(root, () => {
    // 미리보기가 문서·설정을 읽기 전에 링크 경로를 차단한다. 확인 지점에서 실행을 끊으므로
    // 도메인 변경은 하지 않는다. deliver의 보고서 렌더만 의도한 준비 산출물이다.
    const before = inspectConsentSnapshot(root, action);
    const displayed = preview(root, action);
    const inspected = inspectConsentSnapshot(root, action);
    const snapshot = inspected.hash;
    if (action.action !== "deliver") requireConsentSnapshot(root, { action, snapshot: before.hash, snapshotEntries: before.entries },
      "확인 준비 중 대상이 바뀌었습니다. 현재 내용을 다시 준비하세요.", inspected);
    // 같은 동작이 연속 두 번 대상 변경으로 폐기됐으면 경고만 붙인다 — 사람의 응답 경로는 막지 않는다
    const repeated = repeatedTargetChange(root, action.action);
    const at = new Date().toISOString();
    const workId = currentWorkId(root);
    const fullText = writeFullText(root, displayed.summary, displayed.choices);
    const record: ConsentRecord = {id:randomUUID(),root,action,...displayed,snapshot,snapshotEntries:inspected.entries,createdAt:at,status:"pending",
      format: 2, fullText, ...(workId ? { workId } : {}), ...(options.form ? { form: options.form } : {}),
      ...(options.binding ? { preparedSession: { id: options.binding.id, host: options.binding.host, at } } : {}),
      ...(action.action === "update" ? {sourceSnapshot:sourceUpdateSnapshot(root)} : {})};
    save(root,record);
    const warning = repeated
      ? `같은 동작(${TITLES[action.action]})의 확인이 연속 2회 대상 변경으로 폐기됐습니다 — 외부 hook·편집기·백그라운드 빌드가 확인 대상(${(repeated.detail ?? "").replace(/^확인 대상 변경:\s*/, "") || "기록 없음"})을 바꾸고 있는지 사용자에게 확인받으세요. 원인을 두고 같은 동의를 반복해서 준비하지 않습니다.`
      : undefined;
    return consentStatus(root,record.id,{ warning });
  });
}
function currentWorkId(root: string): string | undefined {
  try { return loadActive(root)?.id ?? loadRequestSession(root)?.id; } catch { return undefined; }
}

export interface ConsentHookInput {
  cwd?: string; hook_event_name?: string; session_id?: string; tool_use_id?: string; tool_name?: string;
  agent_id?: string; agent_type?: string;
  tool_input?: { questions?: Question[]; answers?: unknown; metadata?: {source?: string}; [key:string]:unknown };
  tool_response?: unknown;
}
/** 신뢰하는 로컬 hook의 실행 입력을 관찰한다. OS 보안 경계나 사용자 신원 증명은 아니다. */
export function observeConsent(input: ConsentHookInput, projectDir?: string, channel: "claude-question" | "codex-prompt" | "codex-elicitation" = "claude-question"): void {
  if (input.tool_name !== "AskUserQuestion") return;
  if (input.hook_event_name !== "PreToolUse" && input.hook_event_name !== "PostToolUse") return;
  const source = input.tool_input?.metadata?.source;
  if (typeof source !== "string" || !source.startsWith("code-agent:")) return;
  const id = source.slice("code-agent:".length);
  if (!UUID.test(id)) throw new Stop("질문 도구의 확인 요청 ID가 올바르지 않습니다.");
  const items = input.tool_input?.questions;
  if (!Array.isArray(items) || !isDeepStrictEqual(input.tool_input?.metadata, {source})) throw new Stop("CLI가 준비한 질문과 메타데이터를 그대로 사용하세요.");
  // agent_type은 --agent로 선택한 메인에도 있다. 서브에이전트 식별자는 agent_id다.
  if (input.agent_id !== undefined) throw new Stop("승인 질문은 메인 세션에서만 받을 수 있습니다.");
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw new Stop("질문 도구의 작업 경로가 없습니다.");
  if (typeof input.session_id !== "string" || !input.session_id.trim() || typeof input.tool_use_id !== "string" || !input.tool_use_id.trim()) throw new Stop("질문 도구의 세션·호출 ID가 없습니다.");
  const cwd = canonicalRoot(input.cwd), root = canonicalRoot(findRepoRoot(projectDir ?? cwd));
  const rel = relative(root, cwd);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Stop("질문 도구의 작업 경로가 다른 프로젝트입니다.");
  if (statIfPresent(join(root, ".git")) && !samePath(findRepoRoot(cwd), root)) throw new Stop("질문 도구의 작업 경로가 다른 Git 저장소입니다.");
  const sessionId = input.session_id, toolId = input.tool_use_id;
  withConsentLock(root, () => {
  const record = loadConsent(root,id);
  // 1~5 의 거부는 기록을 폐기하지 않는다 — 다른 세션·다른 codex exec 의 이벤트가 남의 동의를 깨뜨리지 못하게,
  // 세션·채널 검사를 스냅샷 대조보다 먼저 한다(스냅샷 해시도 계산하지 않는다)
  if (record.channel && record.channel !== channel) throw new Stop("동의를 시작한 호스트와 다릅니다. 새로 준비하세요.");
  if (record.status !== "pending") throw new Stop("이미 응답했거나 종료한 확인 요청입니다.");
  if (record.preparedSession) {
    const hostMatches = record.preparedSession.host === "codex" ? channel === "codex-prompt" || channel === "codex-elicitation" : channel === "claude-question";
    if (record.preparedSession.id !== sessionId || !hostMatches) {
      throw new Stop(`확인을 준비한 세션의 응답이 아닙니다 — 이 요청은 ${record.preparedSession.host} 세션에서 준비됐습니다. 응답은 준비한 대화에서만 받습니다. 지금 세션에서 진행하려면 새로 준비하세요.`);
    }
  }
  if (record.sessionId && record.sessionId !== sessionId) throw new Stop("다른 세션의 확인 요청입니다. 현재 세션에서 새로 준비하세요.");
  if (record.sessionCwd && !samePath(record.sessionCwd, cwd)) throw new Stop("확인을 시작한 작업 경로와 다릅니다. 새로 준비하세요.");
  discardIfChanged(root, record, "확인 대상이 바뀌었습니다. 변경 내용을 다시 준비해 확인하세요.");
  if (input.hook_event_name === "PreToolUse") {
    if (!isDeepStrictEqual(Object.keys(input.tool_input ?? {}).sort(), ["metadata", "questions"])) throw new Stop("답변을 미리 채운 승인 질문은 허용하지 않습니다.");
    if (!isDeepStrictEqual(items, questions(record))) throw new Stop("CLI가 준비한 질문과 선택지를 그대로 사용하세요.");
    if (record.seenToolIds?.includes(toolId) || record.observed?.some(row => row.toolId === toolId)) throw new Stop("이미 관찰한 질문 호출입니다. 새 질문으로 다시 확인하세요.");
    record.sessionId = sessionId;
    record.channel = channel;
    record.sessionCwd = cwd;
    (record.seenToolIds ??= []).push(toolId);
    record.binding = {toolId,questions:items,cwd};
  } else if (input.hook_event_name === "PostToolUse") {
    if (!record.sessionId || !record.binding || record.binding.toolId !== toolId || !record.binding.cwd || !samePath(record.binding.cwd, cwd)) throw new Stop("시작이 관찰된 질문의 세션·작업 경로·응답이 아닙니다.");
    // 이 호출은 한 번만 소비한다. 불완전한 결과 뒤 같은 ID로 답을 바꿔 재생할 수 없다.
    const bound = record.binding.questions;
    record.binding = undefined;
    record.status = "failed";
    save(root, record);
    /** 응답 거부 — 소비한 기록에 갈래를 남기고 멈춘다(같은 동의를 자동으로 다시 묻지 않는다) */
    const refuse = (kind: "response-none" | "response-invalid", detail: string, message: string): never => {
      fail(record, kind, `응답: ${detail}`); save(root, record);
      throw new Stop(message);
    };
    if (!isDeepStrictEqual(items, bound) || !isDeepStrictEqual(bound, questions(record))) refuse("response-invalid", "질문 불일치", "시작이 관찰된 질문의 응답이 아닙니다.");
    const response = input.tool_response;
    if (!plainObject(response) || Object.keys(response).some(key => !["questions", "answers", "annotations", "afkTimeoutMs", "followUp", "response"].includes(key)) ||
        !plainObject(response.answers) || !isDeepStrictEqual(response.questions, bound) ||
        Object.hasOwn(response, "afkTimeoutMs") || (Object.hasOwn(response, "followUp") && response.followUp !== false) ||
        Object.hasOwn(response, "response") || !unqualifiedAnnotations(response.annotations, bound)) {
      refuse("response-none", "명시적 선택 없음(시간 초과·추가 질문·메모)", "명시적 선택 응답이 없습니다. 시간 초과·추가 질문·응답 메모는 승인하지 않았습니다.");
    }
    const answered = response as { answers: Record<string, unknown> };
    if (!isDeepStrictEqual(Object.keys(answered.answers).sort(), bound.map(q => q.question).sort())) refuse("response-none", "일부 질문 미응답", "모든 확인 질문에 명시적으로 답해야 합니다.");
    const answers:Record<string,string> = Object.create(null);
    for (const q of items) {
      const answer = answered.answers[q.question];
      if (typeof answer !== "string" || !q.options.some(o => o.label === answer)) refuse("response-invalid", "선택지 밖 응답", "선택지와 일치하는 응답만 확인 기록으로 사용할 수 있습니다.");
      answers[q.question]=answer as string;
    }
    record.status = "pending";
    record.failure = undefined;
    record.observed ??= [];
    record.observed.push({toolId,at:new Date().toISOString(),answers});
    const pending = record.choices.map((choice, index) => ({choice,index})).filter(c => c.choice.answer === undefined).slice(0, 4);
    const final = pending.length === 0;
    for (const [questionIndex, q] of items.entries()) {
      const answer=answers[q.question];
      if(answer===DEFER) record.status="deferred";
      else if(answer===CHANGE) record.status="changes-requested";
      else if(final && answer===ACCEPT) record.status="approved";
      else { const item = pending[questionIndex]; if(!item) refuse("response-invalid", "확인 항목 없음", "확인 항목이 없습니다."); record.choices[item!.index].answer=answer; }
    }
    if (record.status === "deferred") fail(record, "response-defer", "응답: 보류");
    else if (record.status === "changes-requested") fail(record, "response-change", "응답: 수정 요청");
    record.binding=undefined;
  } else return;
  save(root,record);
  }, TIMING.hookLockWaitMs);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function unqualifiedAnnotations(value: unknown, bound: Question[]): boolean {
  if (value === undefined) return true;
  if (!plainObject(value)) return false;
  return Object.entries(value).every(([question, annotation]) => bound.some(q => q.question === question) &&
    plainObject(annotation) && Object.entries(annotation).every(([key, note]) =>
      key === "notes" && typeof note === "string" && note.trim() === ""));
}

/** CLI 적용 경로의 호출자 — 사람의 TTY(호스트 표지 없음)이거나, hook 이 이 적용 명령을 본 세션 */
export interface ConsentCaller { sessionId?: string; tty?: true }

/**
 * 응답 뒤 한 번의 호출 — 승인이면 그 자리에서 적용하고, 아니면 status와 같은 내용(summary 제외)을 돌려준다. 적용하면 지금 할 일(`next`)과
 * 스테이지(`phase`)를 함께 돌려준다 — 메인이 적용 뒤 `code-agent status` 를 다시 부르지 않는다.
 */
export function finishConsent(root: string, id: string, caller?: ConsentCaller): string {
  const record = loadConsent(root, id);
  if (record.status !== "approved" && record.status !== "applied") return consentStatus(root, id, { summary: false });
  const result = applyConsent(root, id, caller);
  return JSON.stringify({ id, status: "applied", result, ...afterApply(root, record.action) }, null, 2);
}

/** 적용 뒤 흐름이 멈추거나 원래 흐름으로 돌아가는 동작 — 나머지는 status 의 `다음:` 과 같은 값(`nextStep`) */
const AFTER_APPLY: Partial<Record<Action["action"], string>> = {
  deliver: "반영을 마쳤습니다 — 커밋과 변경 파일을 보고하고 끝낸다",
  abort: "진행을 종료했습니다 — 결과를 보고하고 멈춘다",
  update: "결과를 보고하고 멈춘다 — 호스트를 다시 열어 갱신된 hook·스킬을 로드한 뒤 ca-next 로 재개한다",
  model: "결과를 보고한다 — 새 모델은 호스트를 다시 시작한 뒤 적용된다",
  "plugin-add": "결과를 보고하고 원래 흐름으로 돌아간다",
  "plugin-remove": "결과를 보고하고 원래 흐름으로 돌아간다",
  "knowledge-prune": "결과를 보고하고 원래 흐름으로 돌아간다",
};
function afterApply(root: string, action: Action): { started?: string; startBlocked?: string; phase?: string; next: string; contextFile?: string; contextAgent?: string } {
  const fixed = AFTER_APPLY[action.action];
  if (fixed) return { next: fixed };
  try {
    const begun = action.action === "request" && action.decision !== "reject" ? startConfirmed(root, action) : undefined;
    if (begun && "startBlocked" in begun) return begun;
    const handoff = action.action === "plan" && action.decision !== "reject" ? enterImplement(root) : undefined;
    const step = nextStep(root);
    return { ...begun, ...(step.phase ? { phase: step.phase } : {}), next: step.next, ...(handoff?.file ? { contextFile: handoff.file, contextAgent: handoff.agent } : {}) };
  } catch {
    return { next: "code-agent status 로 현재 위치를 확인한다" };
  }
}
/**
 * 요구 확정을 적용했고 이 ID 를 접수 중이며 진행 중인 작업이 없으면 그 자리에서 작업을 시작한다(접수 세션의 기준 브랜치·대상) — 메인이
 * start 를 따로 부르지 않는다. 시작이 막히면(미커밋 변경·hook 누락 등) 확정은 남기고 막힌 사유와 다시 시작할 명령을 돌려준다
 */
function startConfirmed(root: string, action: Action): { started: string } | { startBlocked: string; next: string } | undefined {
  if (!action.id || !confirmStartsWork(root, action.id)) return undefined;
  const spec = requestSpecPath(root, action.id, action.spec);
  try {
    return { started: start(root, join(root, spec), { brief: true }) };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return { startBlocked: error.message, next: `요구사항은 확정했지만 작업을 시작하지 못했다 — startBlocked 의 사유대로 정리한 뒤(사람이 할 일이면 보고하고 멈춘다) code-agent start ${spec}` };
  }
}
/**
 * 계획 승인을 적용했고 커서가 plan 에 있으면 구현으로 옮기고 첫 Task 의 context 파일을 쓴다 — 메인이 next·context --file 을 따로
 * 부르지 않는다. 게이트가 막으면 옮기지 않는다(`next` 값이 그 자리의 할 일을 말한다). 이미 지난 자리의 재승인(승인 무효 재진입)은 옮기지 않는다
 */
function enterImplement(root: string): ReturnType<typeof stageHandoff> {
  if (loadActive(root)?.phase !== "plan") return undefined;
  try {
    next(root);
  } catch (error) {
    if (error instanceof Stop) return undefined;
    throw error;
  }
  return stageHandoff(root, "implement");
}

/** `--for` 로 준비한 동의의 CLI 출력에서 그 호스트가 쓰지 않는 필드를 뺀다(제외 목록이라 실패·경고·결과 필드는 남는다) */
const OMIT: Record<"claude" | "codex", string[]> = { claude: ["questions", "codexReply"], codex: ["questions", "toolInput"] };
/** CLI 출력 — 준비할 때 고른 호스트가 쓰는 필드만. form 이 없는 기록(--for 없이 준비)은 그대로 */
export function renderConsentOutput(root: string, json: string): string {
  const value = JSON.parse(json) as Record<string, unknown> & { id: string };
  let form: ConsentRecord["form"];
  try { form = loadConsent(root, value.id).form; } catch { return json; }
  if (!form) return json;
  for (const key of OMIT[form]) delete value[key];
  return JSON.stringify(value, null, 2);
}

export function applyConsent(root: string, id: string, caller?: ConsentCaller): string {
  root = canonicalRoot(root);
  const cached = loadConsent(root, id);
  if (cached.status === "applied") return cachedResult(cached);
  return withConsentLock(root, () => applyLocked(root, id, caller));
}
function cachedResult(record: ConsentRecord): string {
  if (typeof record.result !== "string") throw new Stop("적용 완료 기록의 결과가 없습니다. 자동으로 다시 실행하지 않습니다.");
  return record.result;
}
/** 적용 때 확인 화면·문서 선택이 준비 때와 다르다 — 앞선 확인을 지났는지로 대상 변경과 적용 실패를 가른다 */
class ScreenMismatch extends Stop {}
function applyLocked(root: string, id: string, caller?: ConsentCaller): string {
  // 잠금을 얻기 전에 읽은 승인 상태를 재사용하지 않는다.
  const record = loadConsent(root, id);
  if (record.status === "applied") return cachedResult(record);
  if (record.status === "applying") {
    // 잠금을 쥔 지금 applying 이면 이전 적용 프로세스가 끝맺지 못하고 죽은 것이다 — 같은 동의로 다시 돌리지 않는다
    discard(root, record, "apply", "이전 적용이 끝나지 않은 채 중단");
    throw new Stop("이전 적용이 끝나지 않은 채 중단됐습니다 — 일부만 반영됐을 수 있습니다. code-agent status 와 git status 로 상태를 확인하고, 필요하면 code-agent consent prepare 로 새로 확인하세요.");
  }
  if(record.status!=="approved" || !record.sessionId || !record.observed?.length)throw new Stop("현재 세션에서 명시적으로 확인한 응답이 없습니다.");
  // 준비 세션이 있는 동의는 응답을 관찰한 세션의 hook 이 본 적용 명령(또는 사람의 TTY)만 받는다 — 스냅샷을 보기 전에 거부해 폐기하지 않는다
  if (record.preparedSession && !caller?.tty && caller?.sessionId !== record.sessionId) {
    throw new Stop("응답을 관찰한 세션의 셸에서 hook 이 확인한 적용 명령만 실행할 수 있습니다. 다른 경로로 적용하지 않습니다.");
  }
  // 역할 모델은 작업 중에 바꾸지 않는다(D1) — 준비 뒤 접수·작업이 시작됐으면 대상 변경으로 폐기하고 그 사유로 멈춘다. 스냅샷 대조보다
  // 먼저 본다 — 시작은 상태 파일도 바꾸므로 대조가 사유 없이 '파일이 바뀌었다'로만 멈추지 않게. 같은 검사를 setModel 이 한 번 더 한다
  if (record.action.action === "model") {
    const started = workInProgress(root);
    if (started) {
      discard(root, record, "target", `확인 대상 변경: 진행 중인 작업 ${started.id}(${started.phase}) — 작업 중에는 역할 모델을 바꾸지 않습니다. 작업을 반영(deliver)하거나 종료(abort)한 뒤 새로 준비하세요`);
      throw new Stop(guidance("precondition", { id: started.id, phase: started.phase }, "model-in-work"));
    }
  }
  discardIfChanged(root, record, "확인 이후 파일·Git 상태가 바뀌었습니다. 다시 확인하세요.");
  const action=record.action;
  const pluginPreview = action.action === "plugin-add" ? previewPluginAdd(root, action) : action.action === "plugin-remove" ? previewPluginRemove(action.name) : undefined;
  if (pluginPreview !== undefined) {
    if (record.summary !== `${TITLES[action.action]}\n\n${pluginPreview}`) {
      discard(root, record, "target", "확인 대상 변경: 플러그인 설명");
      throw new Stop("플러그인 설명이 바뀌었습니다. 다시 확인하세요.");
    }
    // 플러그인 미리보기는 저장소 밖(키 저장소)을 읽는다 — 그 사이 바뀌지 않았는지 한 번 더 본다
    discardIfChanged(root, record, "실행 준비 중 확인 대상이 바뀌었습니다. 다시 확인하세요.");
  }
  record.status="applying";save(root,record);
  const presence:Presence={channel:record.channel ?? "claude-question",verified:true,detail:`${record.channel === "codex-elicitation" ? "Codex 선택 UI" : record.channel === "codex-prompt" ? "Codex 사용자 메시지" : "Claude Code 질문"} ${id} · 세션 ${record.sessionId} · ${record.preparedSession ? "준비 세션 일치" : "준비 세션 기록 없음(이전 형식)"} · 명시적 선택`};
  let passed = 0;
  try {
    record.result=withInteraction({
      confirm(shown,word){
        if(!record.confirmations.some(p=>p.shown===shown&&p.word===word) && !(action.action==="plugin-add"&&word===action.name&&shown===pluginPreview))throw new ScreenMismatch("확인한 내용과 실행할 내용이 다릅니다.");
        passed++;
        return presence;
      },
      ask(shown,prompt){
        const c=record.choices.find(c=>c.shown===shown&&c.prompt===prompt);
        if(!c?.answer)throw new ScreenMismatch("응답하지 않은 문서 변경입니다.");
        passed++;
        return c.answer===APPLY?"y":"n";
      }
    },()=>{
      switch(action.action){
        case "setup": return [confirmDoc(root,"all"),setupBaseline(root)].join("\n");
        case "docs": return confirmDoc(root,action.kind??"all");
        case "baseline": return setupBaseline(root);
        case "request": return decideRequest(root,action.id,action.decision==="reject"?"rejected":"confirmed",action.comment,action.spec);
        case "plan": return decide(root,action.decision==="reject"?"rejected":"approved",action.comment);
        case "deliver": return deliver(requireValidatable(root,"deliver"));
        case "knowledge-prune": return knowledgePrune(root);
        case "model": return setModel(root,action.agent,action.model,action);
        case "abort": return abort(root);
        case "repro-log": return approveLogBasis(requireReproable(root));
        case "plugin-add": return pluginAdd(root,action);
        case "plugin-remove": return pluginRemove(action.name);
        case "update": return updateFromSource(root,{expectedSourceSnapshot:record.sourceSnapshot}) + "\n사용 중인 호스트를 다시 열어 새 훅·스킬을 적용한 뒤 ca-next로 이어가세요.";
        case "judgment": {
          // 각 함수가 소유 기록의 잠금 안에서 전제(카운터 소진·지적 존재·교차 지점 막힘)를 다시 확인한다
          const { kind, reason } = judgmentOf(action);
          const { grant, review } = judgmentModules();
          if (kind === "retry-grant") return grant.grantRetry(root, action.name ?? "", id, reason, action.id);
          if (kind === "waive-finding") return review.waiveFinding(root, action.id!, id, reason);
          return review.recordCrossStop(root, action.name as "review" | "planning", id, reason);
        }
      }
    });
    record.status="applied";save(root,record);return record.result;
  }catch(error){
    if (error instanceof ScreenMismatch) {
      // 도메인 함수는 첫 확인 전에 효과를 내지 않는다 — 그 전 불일치는 대상 변경(업그레이드로 화면이 바뀐 경우 등)이다
      if (passed === 0) discard(root, record, "target", "확인 대상 변경: 확인 화면");
      else discard(root, record, "apply", `확인 화면 불일치(앞선 확인 ${passed}건 통과 뒤 — 일부 반영됐을 수 있음)`);
    } else {
      discard(root, record, "apply", (error instanceof Error ? error.message : String(error)).split("\n").find((line) => line.trim()) ?? "알 수 없는 오류");
    }
    throw error;
  }
}
export function consentCommandGuard(root:string,command:string,sessionId?:string):string|undefined {
  const match=/^code-agent consent (?:apply|finish) ([a-f0-9-]+)$/.exec(command.trim());
  if(!match)return;
  try {
    // 하위 폴더에서 연 세션(projectDir 가 저장소 안 폴더)도 티켓·CLI 와 같은 저장소 루트의 기록을 읽는다
    const record=loadConsent(findRepoRoot(root),match[1]);
    // 응답 전에는 준비 세션이 기준이다 — Codex 가 응답 전에 finish 로 상태를 볼 수 있다
    const owner = record.sessionId ?? record.preparedSession?.id;
    if(!sessionId||owner!==sessionId)return "현재 세션에서 확인한 요청만 실행할 수 있습니다.";
  }
  catch{return "확인 요청을 읽을 수 없습니다.";}
}
/** Claude 업무 질문의 화면 크기 — 선택지는 이름과 설명을 함께 센다. 형식이 다른 입력은 판단하지 않는다(도구가 거른다) */
function askScreenProblem(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  for (const item of items as Partial<Question>[]) {
    if (typeof item?.question !== "string") continue;
    const options = Array.isArray(item.options) ? item.options.map(option => [option?.label, option?.description].filter(text => typeof text === "string").join("\n")) : [];
    const problem = questionScreenProblem(item.question, options);
    if (problem) return problem;
  }
}
/**
 * Claude AskUserQuestion 관찰. 동의 질문(metadata.source 가 code-agent:)의 관찰 실패는 질문을 막는다(exit 2).
 * 업무 질문은 선택 화면을 넘는 크기만 막고(PreToolUse, exit 2) 답 관찰(answers.jsonl)은 실패해도 질문을 막지 않는다 — 게이트가
 * 나중에 '답 출처 미확인'으로 잡는다.
 */
export function runConsentHook(stdin:string):number {
  return withNotation("claude", () => consentEvent(stdin));
}
function consentEvent(stdin:string):number {
  let input: ConsentHookInput;
  try { input = JSON.parse(stdin) as ConsentHookInput; }
  catch (error) { process.stderr.write(`code-agent consent-event: ${error instanceof Error ? error.message : error}\n`); return 2; }
  // 질문을 막은 사유는 모델에게 간다 — 측정 기록(hookLog)에도 남긴다
  const block = (text: string): number => {
    process.stderr.write(text);
    try {
      const dir = process.env.CLAUDE_PROJECT_DIR ?? input?.cwd;
      if (dir) noteHookOutput(findRepoRoot(dir), { host: "claude", event: input?.hook_event_name ?? "PreToolUse", kind: "block", tool: "AskUserQuestion", text,
        ...(input?.session_id ? { session: input.session_id } : {}), ...(input?.agent_id ? { agent: input.agent_id } : {}) });
    } catch { /* 측정용 기록이다 */ }
    return 2;
  };
  const source = input?.tool_input?.metadata?.source;
  if (typeof source === "string" && source.startsWith("code-agent:")) {
    try { observeConsent(input, process.env.CLAUDE_PROJECT_DIR); return 0; }
    catch (error) { return block(`code-agent consent-event: ${error instanceof Error ? error.message : error}\n`); }
  }
  // 업무 질문도 선택 화면에 다 보여야 답할 수 있다 — 화면을 넘는 질문은 표시하기 전에 돌려보낸다(Codex ask 와 같은 기준)
  const problem = input?.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion" ? askScreenProblem(input.tool_input?.questions) : undefined;
  if (problem) return block(`code-agent consent-event: ${problem}\n`);
  try { observeAnswerEvent(input, process.env.CLAUDE_PROJECT_DIR); }
  catch (error) { process.stderr.write(`code-agent consent-event: 업무 답을 기록하지 못했습니다(질문은 막지 않았습니다): ${error instanceof Error ? error.message : error}\n`); }
  return 0;
}
