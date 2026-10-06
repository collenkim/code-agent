import { execFileSync } from "child_process";
import { createHash, randomUUID } from "crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, unlinkSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { isDeepStrictEqual } from "util";
import { z } from "zod";
import { writeAtomic } from "../core/atomic";
import type { Presence } from "../core/approval";
import { abort, decide, requireValidatable, status } from "./commands";
import { hasBaseline, setupBaseline } from "./bootstrap";
import { docPaths } from "./docs";
import { confirmDoc } from "./docsCommands";
import { deliver, deliveryPaths, knowledgeChoices } from "./deliver";
import { knowledgePrune, pruneCandidates } from "./knowledgeCommands";
import { findRepoRoot } from "./layout";
import { modelsTable, setModel, validateModelChange } from "./models";
import { pluginAdd, pluginRemove, previewPluginAdd, previewPluginRemove } from "./plugins/commands";
import { readStore } from "./plugins/store";
import { decideRequest } from "./request";
import { KNOWLEDGE_KINDS, POLICY_KINDS, SCHEMAS } from "./schemas";
import { Stop } from "./stop";
import { withInteraction } from "./tty";
import { loadManifestIfAny } from "./work";
import { previewSourceUpdate, sourceUpdateSnapshot, updateFromSource } from "./sourceUpdate";

const ActionSchema = z.object({
  action: z.enum(["setup", "docs", "baseline", "request", "plan", "deliver", "knowledge-prune", "model", "abort", "plugin-add", "plugin-remove", "update"]),
  kind: z.string().optional(), id: z.string().optional(), spec: z.string().optional(),
  decision: z.enum(["accept", "reject"]).default("accept"), comment: z.string().optional(),
  agent: z.string().optional(), model: z.string().optional(), name: z.string().optional(),
  host: z.enum(["claude", "codex"]).optional(), reasoning: z.string().optional(),
  command: z.string().optional(), slots: z.string().optional(), sendsCode: z.boolean().default(false),
  secretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
}).strict();
export type ConsentAction = z.input<typeof ActionSchema>;
type Action = z.output<typeof ActionSchema>;
interface Prompt { shown: string; word: string }
interface Question { question: string; header: string; options: { label: string; description: string }[]; multiSelect: false }
interface Choice { shown: string; prompt: string; target?: string; key?: string; answer?: string }
export interface ConsentRecord {
  id: string; root: string; action: Action; snapshot: string; createdAt: string;
  status: "pending" | "approved" | "changes-requested" | "deferred" | "applying" | "applied" | "failed";
  confirmations: Prompt[]; choices: Choice[]; summary: string;
  sessionId?: string; sessionCwd?: string; binding?: { toolId: string; questions: Question[]; cwd?: string };
  seenToolIds?: string[];
  observed?: { toolId: string; at: string; answers: Record<string, string> }[];
  result?: string;
  sourceSnapshot?: string;
  channel?: "claude-question" | "codex-prompt";
}
const DIR = ".code-agent/consents";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ACCEPT = "확인하고 진행";
const CHANGE = "수정 요청";
const DEFER = "보류";
const APPLY = "적용";
const KEEP = "유지";
const TITLES: Record<Action["action"], string> = {
  setup: "초기 설정 확정", docs: "공통 문서 확정", baseline: "기준 커밋 생성", request: "요구사항 확인",
  plan: "작업 계획 확인", deliver: "결과와 로컬 커밋 확인", "knowledge-prune": "지식 문서 정리",
  model: "에이전트 모델 변경", abort: "작업 진행 종료", "plugin-add": "플러그인 등록", "plugin-remove": "플러그인 제거",
  update: "code-agent 업데이트",
};

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
function statIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** 루트 아래 경로의 모든 조상을 검사한다. 링크·junction을 타고 읽거나 쓰지 않는다. */
function localPath(root: string, file: string, allowLeafLink = false): string {
  const full = resolve(root, file), rel = relative(root, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Stop("확인 대상 경로가 저장소 밖입니다.");
  let cursor = root;
  const parts = rel ? rel.split(sep) : [];
  for (const [index, part] of parts.entries()) {
    if (process.platform === "win32" && part.includes(":")) throw new Stop("대체 데이터 스트림은 확인 대상으로 사용할 수 없습니다.");
    cursor = join(cursor, part);
    const stat = statIfPresent(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink() && !(allowLeafLink && index === parts.length - 1)) throw new Stop(`확인 대상에 심볼릭 링크가 있습니다: ${file}`);
  }
  return full;
}
function recordPath(root: string, id: string): string {
  if (!UUID.test(id)) throw new Stop("확인 요청 ID가 올바르지 않습니다.");
  return localPath(root, `${DIR}/${id}.json`);
}
function save(root: string, record: ConsentRecord): void {
  const file = recordPath(root, record.id); mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(record, null, 2) + "\n");
}
export function loadConsent(root: string, id: string): ConsentRecord {
  root = canonicalRoot(root);
  const record = JSON.parse(readFileSync(recordPath(root, id), "utf8")) as ConsentRecord;
  if (record.id !== id || !samePath(record.root, root)) throw new Stop("다른 프로젝트의 확인 요청입니다.");
  return record;
}
/** 같은 저장소의 확인·적용을 직렬화한다. 비정상 종료의 잠금은 자동으로 훔치지 않는다. */
function withConsentLock<T>(root: string, run: () => T): T {
  const dir = localPath(root, DIR);
  mkdirSync(dir, { recursive: true });
  const lock = localPath(root, `${DIR}/apply.lock`);
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Stop("다른 확인·적용이 진행 중입니다. 이전 프로세스가 종료됐는지 확인하세요.");
    throw error;
  }
  try { return run(); }
  finally { closeSync(fd); unlinkSync(lock); }
}
function git(root: string, args: string[], optional = false): string {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }); }
  catch (error) {
    if (optional && (error as {status?: number}).status === 1) return "";
    throw new Stop("확인 대상의 Git 상태를 읽을 수 없습니다. 저장소 상태를 확인하세요.");
  }
}

/** 승인 대상은 작업 트리·index·기준·진행 상태다. 확인 기록 자체는 비교에서 제외한다. */
export function consentSnapshot(root: string, action: Action): string {
  root = canonicalRoot(root);
  const files = new Set<string>();
  const skipped = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", ".idea", "__pycache__", ".pytest_cache"]);
  const excluded = (file: string) => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    return key === DIR || key.startsWith(`${DIR}/`);
  };
  function walk(dir: string, control = false) {
    if (excluded(dir)) return;
    const full = localPath(root, dir, !control);
    const stat = statIfPresent(full);
    if (!stat) return;
    if (!stat.isDirectory()) { files.add(dir); return; }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const file = dir ? `${dir}/${entry.name}` : entry.name;
      const name = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
      if (excluded(file) || name === ".git" || (!control && skipped.has(name))) continue;
      walk(file, control);
    }
  }
  const hasGit = !!statIfPresent(localPath(root, ".git"));
  if (hasGit) {
    if (!samePath(git(root, ["rev-parse", "--show-toplevel"]).trim(), root)) throw new Stop("Git 루트와 확인 대상 저장소가 다릅니다.");
    for (const file of git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0")) if (file) files.add(file);
  }
  // Git에서 무시하는 문서·설정도 사람이 본 내용과 실행 환경을 바꾸므로 포함한다.
  walk("");
  for (const dir of [".code-agent", ".claude", ".agents", ".codex", "doc", "docs"]) walk(dir, true);
  localPath(root, "code-agent.json");
  const manifest = loadManifestIfAny(root);
  for (const file of [...POLICY_KINDS, ...KNOWLEDGE_KINDS].flatMap(kind => docPaths(manifest, kind))) walk(file, true);
  for (const stage of manifest?.stages ?? []) if (stage.template) walk(stage.template, true);
  if (action.spec) walk(action.spec, true);
  const hash = createHash("sha256");
  for (const file of [...files].filter(f => !excluded(f)).sort()) {
    const full = localPath(root, file, true), stat = statIfPresent(full);
    const content = !stat ? "missing" : stat.isSymbolicLink() ? `link:${readlinkSync(full)}` : stat.isFile() ? createHash("sha256").update(readFileSync(full)).digest("hex") : stat.isDirectory() ? "directory" : "special";
    hash.update(JSON.stringify([file, stat?.mode, content]));
  }
  if (hasGit) {
    for (const args of [["rev-parse", "--verify", "--quiet", "HEAD"], ["symbolic-ref", "-q", "HEAD"]]) hash.update(JSON.stringify(git(root, args, true)));
    hash.update(git(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"]));
    hash.update(git(root, ["ls-files", "--stage", "-z"]));
    hash.update(git(root, ["config", "--null", "--list", "--show-origin"]));
  }
  if (action.action.startsWith("plugin-")) hash.update(JSON.stringify(readStore()));
  if (action.action === "update") hash.update(sourceUpdateSnapshot(root));
  return hash.digest("hex");
}

const CAPTURE = Symbol("capture confirmation");
function capture(run: () => string): Prompt[] {
  const prompts: Prompt[] = [];
  try {
    withInteraction({ confirm: (shown, word) => { prompts.push({ shown, word }); throw CAPTURE; }, ask: () => { throw new Stop("확인 준비에서 입력을 요청할 수 없습니다."); } }, run);
  } catch (error) { if (error !== CAPTURE) throw error; }
  return prompts;
}
function preview(root: string, action: Action): { confirmations: Prompt[]; choices: Choice[]; summary: string } {
  let confirmations: Prompt[] = [], choices: Choice[] = [], summary = "";
  const reject = action.decision === "reject";
  switch (action.action) {
    case "setup":
      confirmations = capture(() => confirmDoc(root, "all"));
      if (!hasBaseline(root)) confirmations.push(...capture(() => setupBaseline(root)));
      break;
    case "docs": confirmations = capture(() => confirmDoc(root, action.kind ?? "all")); break;
    case "baseline": confirmations = capture(() => setupBaseline(root)); break;
    case "request": confirmations = capture(() => decideRequest(root, action.id, reject ? "rejected" : "confirmed", action.comment, action.spec)); break;
    case "plan": confirmations = capture(() => decide(root, reject ? "rejected" : "approved", action.comment)); break;
    case "deliver": {
      const work = requireValidatable(root, "deliver");
      confirmations = capture(() => deliver(work));
      // 첫 렌더가 보고서를 복구했다면 적용 때의 확인 문구는 복구 후 상태와 맞춰 둔다.
      const first = confirmations;
      confirmations = capture(() => deliver(work));
      choices = knowledgeChoices(work).map(c => ({ shown: c.shown, prompt: "적용하려면 y", target: c.target, key: c.entry.key }));
      summary = ["검증된 작업 파일·작업 문서·증거·선택한 지식 문서를 로컬 커밋합니다. 원격 push·배포는 하지 않습니다.",
        "커밋 대상(작업·문서·증거·도입 설정):", ...[...new Set(deliveryPaths(work).flatMap(path => listLocalFiles(root, path)))].map(file => `- ${file}`),
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
      const reasoningHint = change.host === "codex" ? "기본값 복원은 모델·추론 강도를 함께 복원합니다. 모델만 변경하면 기존 추론 강도를 유지합니다. " : "";
      summary = `${modelsTable(root, change.host)}\n\n변경: ${change.host} / ${action.agent} → ${action.model}${action.reasoning ? ` / ${action.reasoning}` : ""}\n${reasoningHint}적용 후 호스트를 재시작하세요. 이미 실행 중인 서브에이전트에는 소급 적용하지 않습니다.`;
      break;
    }
    case "abort": summary = `${status(root)}\n\n접수 또는 작업 진행 상태를 종료합니다. 소스·작업 문서·Git 이력은 삭제하지 않습니다.`; break;
    case "plugin-add": summary = previewPluginAdd(root, action); break;
    case "plugin-remove": summary = previewPluginRemove(action.name); break;
    case "update":
      summary = previewSourceUpdate(root);
      if (summary.includes("업데이트 중단:")) throw new Stop(summary);
      break;
  }
  summary = [TITLES[action.action], ...(reject ? [`반려 사유: ${action.comment ?? ""}`] : []), summary, ...confirmations.map(c => c.shown)].filter(Boolean).join("\n\n");
  if (!confirmations.length && ["docs", "setup", "baseline", "request"].includes(action.action)) summary += "\n현재 내용은 이미 처리되어 추가 변경이 없습니다.";
  return { confirmations, choices, summary };
}

function listLocalFiles(root: string, file: string): string[] {
  const full = localPath(root, file), stat = statIfPresent(full);
  if (!stat) return [];
  if (stat.isFile()) return [relative(root, full).replace(/\\/g, "/")];
  if (!stat.isDirectory()) throw new Stop(`일반 파일이나 디렉토리가 아닌 확인 대상입니다: ${file}`);
  return readdirSync(full).sort().flatMap(name => listLocalFiles(root, `${file}/${name}`));
}

function questions(record: ConsentRecord): Question[] {
  const pending = record.choices.map((choice, index) => ({ choice, index })).filter(c => c.choice.answer === undefined);
  if (pending.length) return pending.slice(0, 4).map(({choice,index}) => ({
    question: `${index + 1}. ${choice.shown}\n${record.action.action === "knowledge-prune" ? "이 항목을 삭제할까요?" : "이 문서 갱신을 적용할까요?"}`,
    header: "문서 변경", multiSelect: false,
    options: [{label: APPLY, description: record.action.action === "knowledge-prune" ? "이 항목을 삭제합니다." : "제안한 내용으로 갱신합니다."}, {label: KEEP, description: "현재 내용을 유지합니다."}, {label: DEFER, description: "변경하지 않고 확인을 보류합니다."}],
  }));
  const selected = record.choices.length ? ["", "", "문서 변경 선택:", ...record.choices.map(c =>
    `- ${c.answer}: ${c.target ?? c.shown.split("\n")[0]}${c.key ? ` · ${c.key}` : ""}`)].join("\n") : "";
  return [{ question: `${record.summary}${selected}\n이 내용으로 진행할까요?`, header: "진행 확인", multiSelect: false,
    options: [{label: ACCEPT,description: "표시한 내용과 선택한 범위에 한해 실행합니다."}, {label: CHANGE,description: "수정할 내용을 정리한 뒤 다시 확인합니다."}, {label: DEFER,description: "현재 상태를 유지하고 나중에 이어갑니다."}]}];
}
export function consentStatus(root: string, id: string): string {
  const record = loadConsent(root, id);
  const items = record.status === "pending" ? questions(record) : [];
  return JSON.stringify({id, status:record.status, summary:record.summary, questions:items,
    toolInput:{questions:items,metadata:{source:`code-agent:${id}`}},
    codexReply: items.length ? {format:`code-agent consent respond ${id} <질문별 선택지 번호를 쉼표로 연결>`,
      questions: items.map(q => ({question:q.question, choices:q.options.map((o,index) => ({number:index+1,...o}))}))} : undefined,
    result:record.result}, null, 2);
}
export function prepareConsent(root: string, raw: unknown): string {
  root = canonicalRoot(root);
  const action = ActionSchema.parse(raw);
  return withConsentLock(root, () => {
    // 미리보기가 문서·설정을 읽기 전에 링크 경로를 차단한다. 확인 지점에서 실행을 끊으므로
    // 도메인 변경은 하지 않는다. deliver의 보고서 렌더만 의도한 준비 산출물이다.
    const before = consentSnapshot(root, action);
    const displayed = preview(root, action);
    const snapshot = consentSnapshot(root, action);
    if (action.action !== "deliver" && before !== snapshot) throw new Stop("확인 준비 중 대상이 바뀌었습니다. 현재 내용을 다시 준비하세요.");
    const record: ConsentRecord = {id:randomUUID(),root,action,...displayed,snapshot,createdAt:new Date().toISOString(),status:"pending",
      ...(action.action === "update" ? {sourceSnapshot:sourceUpdateSnapshot(root)} : {})};
    save(root,record);
    return consentStatus(root,record.id);
  });
}

export interface ConsentHookInput {
  cwd?: string; hook_event_name?: string; session_id?: string; tool_use_id?: string; tool_name?: string;
  agent_id?: string; agent_type?: string;
  tool_input?: { questions?: Question[]; answers?: unknown; metadata?: {source?: string}; [key:string]:unknown };
  tool_response?: unknown;
}
/** 신뢰하는 로컬 hook의 실행 입력을 관찰한다. OS 보안 경계나 사용자 신원 증명은 아니다. */
export function observeConsent(input: ConsentHookInput, projectDir?: string, channel: "claude-question" | "codex-prompt" = "claude-question"): void {
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
  if (record.channel && record.channel !== channel) throw new Stop("동의를 시작한 호스트와 다릅니다. 새로 준비하세요.");
  if (record.status !== "pending") throw new Stop("이미 응답했거나 종료한 확인 요청입니다.");
  if (record.snapshot !== consentSnapshot(root,record.action)) throw new Stop("확인 대상이 바뀌었습니다. 변경 내용을 다시 준비해 확인하세요.");
  if (record.sessionId && record.sessionId !== sessionId) throw new Stop("다른 세션의 확인 요청입니다. 현재 세션에서 새로 준비하세요.");
  if (record.sessionCwd && !samePath(record.sessionCwd, cwd)) throw new Stop("확인을 시작한 작업 경로와 다릅니다. 새로 준비하세요.");
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
    if (!isDeepStrictEqual(items, bound) || !isDeepStrictEqual(bound, questions(record))) throw new Stop("시작이 관찰된 질문의 응답이 아닙니다.");
    const response = input.tool_response;
    if (!plainObject(response) || Object.keys(response).some(key => !["questions", "answers", "annotations", "afkTimeoutMs", "followUp", "response"].includes(key)) ||
        !plainObject(response.answers) || !isDeepStrictEqual(response.questions, bound) ||
        Object.hasOwn(response, "afkTimeoutMs") || (Object.hasOwn(response, "followUp") && response.followUp !== false) ||
        Object.hasOwn(response, "response") || !unqualifiedAnnotations(response.annotations, bound)) {
      throw new Stop("명시적 선택 응답이 없습니다. 시간 초과·추가 질문·응답 메모는 승인하지 않았습니다.");
    }
    if (!isDeepStrictEqual(Object.keys(response.answers).sort(), bound.map(q => q.question).sort())) throw new Stop("모든 확인 질문에 명시적으로 답해야 합니다.");
    const answers:Record<string,string> = Object.create(null);
    for (const q of items) {
      const answer = response.answers[q.question];
      if (typeof answer !== "string" || !q.options.some(o => o.label === answer)) throw new Stop("선택지와 일치하는 응답만 확인 기록으로 사용할 수 있습니다.");
      answers[q.question]=answer;
    }
    record.status = "pending";
    record.observed ??= [];
    record.observed.push({toolId,at:new Date().toISOString(),answers});
    const pending = record.choices.map((choice, index) => ({choice,index})).filter(c => c.choice.answer === undefined).slice(0, 4);
    const final = pending.length === 0;
    for (const [questionIndex, q] of items.entries()) {
      const answer=answers[q.question];
      if(answer===DEFER) record.status="deferred";
      else if(answer===CHANGE) record.status="changes-requested";
      else if(final && answer===ACCEPT) record.status="approved";
      else { const item = pending[questionIndex]; if(!item)throw new Stop("확인 항목이 없습니다."); record.choices[item.index].answer=answer; }
    }
    record.binding=undefined;
  } else return;
  save(root,record);
  });
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

/** 응답 뒤 한 번의 호출 — 승인이면 그 자리에서 적용하고, 아니면 status와 같은 내용을 돌려준다. */
export function finishConsent(root: string, id: string): string {
  const status = loadConsent(root, id).status;
  if (status !== "approved" && status !== "applied") return consentStatus(root, id);
  const result = applyConsent(root, id);
  return JSON.stringify({ id, status: "applied", result }, null, 2);
}

export function applyConsent(root: string, id: string): string {
  root = canonicalRoot(root);
  const cached = loadConsent(root, id);
  if (cached.status === "applied") return cachedResult(cached);
  return withConsentLock(root, () => applyLocked(root, id));
}
function cachedResult(record: ConsentRecord): string {
  if (typeof record.result !== "string") throw new Stop("적용 완료 기록의 결과가 없습니다. 자동으로 다시 실행하지 않습니다.");
  return record.result;
}
function applyLocked(root: string, id: string): string {
  // 잠금을 얻기 전에 읽은 승인 상태를 재사용하지 않는다.
  const record = loadConsent(root, id);
  if (record.status === "applied") return cachedResult(record);
  if(record.status!=="approved" || !record.sessionId || !record.observed?.length)throw new Stop("현재 세션에서 명시적으로 확인한 응답이 없습니다.");
  if(record.snapshot!==consentSnapshot(root,record.action))throw new Stop("확인 이후 파일·Git 상태가 바뀌었습니다. 다시 확인하세요.");
  const action=record.action;
  const pluginPreview = action.action === "plugin-add" ? previewPluginAdd(root, action) : action.action === "plugin-remove" ? previewPluginRemove(action.name) : undefined;
  if (pluginPreview !== undefined && record.summary !== `${TITLES[action.action]}\n\n${pluginPreview}`) throw new Stop("플러그인 설명이 바뀌었습니다. 다시 확인하세요.");
  if(record.snapshot!==consentSnapshot(root,record.action))throw new Stop("실행 준비 중 확인 대상이 바뀌었습니다. 다시 확인하세요.");
  record.status="applying";save(root,record);
  const presence:Presence={channel:record.channel ?? "claude-question",verified:true,detail:`${record.channel === "codex-prompt" ? "Codex 사용자 메시지" : "Claude Code 질문"} ${id} · 세션 ${record.sessionId} · 명시적 선택`};
  try {
    record.result=withInteraction({
      confirm(shown,word){
        if(!record.confirmations.some(p=>p.shown===shown&&p.word===word) && !(action.action==="plugin-add"&&word===action.name&&shown===pluginPreview))throw new Stop("확인한 내용과 실행할 내용이 다릅니다.");
        return presence;
      },
      ask(shown,prompt){const c=record.choices.find(c=>c.shown===shown&&c.prompt===prompt);if(!c?.answer)throw new Stop("응답하지 않은 문서 변경입니다.");return c.answer===APPLY?"y":"n";}
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
        case "plugin-add": return pluginAdd(root,action);
        case "plugin-remove": return pluginRemove(action.name);
        case "update": return updateFromSource(root,{expectedSourceSnapshot:record.sourceSnapshot}) + "\n사용 중인 호스트를 다시 열어 새 훅·스킬을 적용한 뒤 ca-next로 이어가세요.";
      }
    });
    record.status="applied";save(root,record);return record.result;
  }catch(error){record.status="failed";save(root,record);throw error;}
}
export function consentCommandGuard(root:string,command:string,sessionId?:string):string|undefined {
  const match=/^code-agent consent (?:apply|finish) ([a-f0-9-]+)$/.exec(command.trim());
  if(!match)return;
  try {const record=loadConsent(root,match[1]);if(!sessionId||record.sessionId!==sessionId)return "현재 세션에서 확인한 요청만 실행할 수 있습니다.";}
  catch{return "확인 요청을 읽을 수 없습니다.";}
}
export function runConsentHook(stdin:string):number {
  try{observeConsent(JSON.parse(stdin),process.env.CLAUDE_PROJECT_DIR);return 0;}
  catch(error){process.stderr.write(`code-agent consent-event: ${error instanceof Error?error.message:error}\n`);return 2;}
}
