import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { isAbsolute, join, posix, relative, resolve, sep } from "path";
import { z } from "zod";
import { hashManifest } from "../core/approval";
import { sha, docPaths } from "./docs";
import { canonical, STATE_DIR, workDocsDir } from "./layout";
import { POLICY_KINDS } from "./schemas";
import { parseQuestions, structuralLine, type Question } from "./questions";
import { answerSources } from "./answers";
import { crossPointHint, crossPointState, grantScope, orphanState, type FailureRecord, type RetryGrant } from "./retryPolicy";
import { Stop } from "./stop";
import type { Work } from "./work";
import { selectedHosts } from "./hosts";
import { otherHost, runtimeHost } from "./crossEnv";
import {
  crossHintText, orphanView, planningCrossAttemptsOf, planningCrossView, pointHost, pointLabel,
  type CrossWaiver, type PlanningCrossAttempt, type PlanningCrossView, type QuestionView,
} from "./crossRecord";

export const TASK_AGENTS = { analysis: "ca-analyst", explore: "ca-explorer", impact: "ca-explorer", synthesis: "ca-writer", design: "ca-analyst", plan: "ca-analyst", critic: "ca-critic" } as const;
export const TaskSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  role: z.enum(["analysis", "explore", "impact", "synthesis", "design", "plan", "critic"]),
  contextVersion: z.literal(2).optional(),
  title: z.string().trim().min(1).max(500).regex(/^[^\r\n]+$/),
  requirements: z.array(z.string().regex(/^(?:R\d+|REQ-\d+|DONE-\d+|CON-\d+)$/)).min(1),
  inputs: z.array(z.string().min(1)).min(1).max(100),
  scopes: z.array(z.string().min(1)).max(20).default([]),
  outputs: z.array(z.string()).max(3).default([]),
  dependsOn: z.array(z.string()).max(100).default([]),
  questionIds: z.array(z.string().regex(/^Q\d+$/)).default([]),
}).strict();
export type PlanningTask = z.infer<typeof TaskSchema>;
/** 역할이 도는 계획 단계. planning.ts 가 import 한다(planning.ts 를 import 하면 순환이다) — planning.ts 는 PHASE 로 재수출한다 */
export const ROLE_PHASE: Record<PlanningTask["role"], "analysis" | "impact" | "design" | "plan"> = { analysis: "analysis", explore: "impact", impact: "impact", synthesis: "impact", design: "design", plan: "plan", critic: "plan" };
export const PLANNING_PHASES = ["analysis", "impact", "design", "plan"] as const;
const Reference = z.object({ path: z.string(), line: z.number().int().positive() }).strict();
/** 질문 본문 검사 — 파서가 구조 필드로 읽는 줄(제목·답변·상태·범위·출처)을 담당·교차 결과가 끼워 넣지 못하게 한다 */
export const questionText = z.string().min(1).refine(text => !structuralLine(text), "질문 본문에 질문 제목·답변·상태·범위·출처 필드를 넣을 수 없습니다");
export const ResultSchema = z.object({
  taskId: z.string(), dispatchId: z.string(), inputHash: z.string(),
  status: z.enum(["completed", "needs-input", "failed"]),
  summary: z.string().trim().min(1).max(4000),
  evidence: z.array(Reference).max(100),
  facts: z.array(z.object({ key: z.string().min(1), value: z.string().min(1), source: Reference }).strict()).max(100),
  questions: z.array(z.object({ id: z.string().regex(/^Q\d+$/), question: questionText, requirements: z.array(z.string()).min(1) }).strict()).max(30),
  // 본문은 staging 파일로 넘기는 것이 기본이다. Write 도구가 없는 호스트는 content로 직접 싣는다.
  artifacts: z.array(z.union([z.object({ path: z.string(), content: z.string().max(131072) }).strict(), z.object({ path: z.string(), staged: z.string() }).strict()])).max(3),
  findings: z.array(z.object({ id: z.string().min(1), severity: z.enum(["blocking", "advisory"]), detail: z.string().min(1), source: Reference }).strict()).max(100),
}).strict();
export type PlanningResult = z.infer<typeof ResultSchema>;
/** staging 본문을 읽어 들인 결과. 상태에는 이 형태로 보존한다 */
export type ResolvedResult = Omit<PlanningResult, "artifacts"> & { artifacts: { path: string; content: string }[] };
/** 입력 해시의 부품 — 낡은 이유(staleCauses)를 항목별로 보이기 위해 새 시도에만 기록한다 */
export interface InputParts {
  task: string; base?: string; manifest: string; inputs: string;
  /** 입력 파일이 50개 이하일 때만 경로별 해시 */
  files?: Record<string, string>; host?: string;
  dependencies: [string, string | undefined][];
  /** [id, sha(질문 투영), origin] */
  questions: [string, string, string?][];
}
export interface HashedInput { hash: string; parts: InputParts }
export interface TaskAttempt {
  dispatchId: string; inputHash: string; at: string;
  status: "running" | "completed" | "needs-input" | "needs-correction" | "failed" | "cancelled" | "orphaned";
  result?: ResolvedResult; resultHash?: string; outputs?: Record<string, string>;
  agentId?: string; sessionId?: string; error?: string;
  correction?: { raw: string; error: string; agentId: string; sessionId: string; used: boolean };
  /** 실패 원인(retryPolicy) — 새로 기록하는 시도에만 붙인다 */
  failure?: FailureRecord;
  inputParts?: InputParts;
}
export interface TaskRecord { task: PlanningTask; attempts: TaskAttempt[] }
export interface PlanningAgent {
  id: string; session: string; type: string; startedAt: string; finished?: boolean; dispatchId?: string;
  /** 같은 담당에게 되돌린 횟수(Claude SubagentStop exit 2) */
  returns?: number;
  /** 되돌릴 때까지 판정한 SubagentHandback 보고 수 — 다음 완료는 그 뒤의 보고만 결과로 본다(되돌린 옛 보고를 다시 읽지 않는다) */
  judgedHandbacks?: number;
  failure?: FailureRecord;
  endedAt?: string;
}
export interface PlanningRetry {
  version: 1;
  /** 이 시각 이후의 배정만 작업별 총 배정 한도에 센다 — 처음 쓸 때 기록한다 */
  since: string;
  grants: RetryGrant[];
  /** 자동 되감기 기록(최근 20개) — 같은 사유의 두 번째부터는 자동으로 되감지 않는다 */
  rewinds?: { at: string; phase: string; key: string }[];
}
export interface PlanningState {
  version: 1; id: string; target: string; maxParallel: number;
  tasks: TaskRecord[];
  agents: PlanningAgent[];
  /**
   * 파생 사본(옛 필드) — 두 호스트 설치 프로젝트의 교차 계획 검토. crossAttempts 가 저장된 뒤에는 syncLegacyPlanning 이 그 지점이
   * completed·stopped 일 때 다시 쓴다. 판정은 crossAttempts(없으면 이 필드에서 추정한 시도)만 본다
   */
  cross?: { host: string; model: string; at: string; criticDispatchId: string; status: "completed" | "needs-input" | "failed" | "unavailable"; summary: string;
    findings: { id: string; severity: "blocking" | "advisory"; detail: string; source: { path: string; line: number } }[]; questions: number };
  /** 교차 계획 검토 시도 — critic 배정(criticDispatchId)마다 지점 하나, append-only. 승인 해시(작업별 마지막 시도) 밖이다 */
  crossAttempts?: PlanningCrossAttempt[];
  /** 사람 판단으로 기각한 교차 계획 검토의 차단 지적 — 그 critic 지점에만 묶인다 */
  crossWaivers?: CrossWaiver[];
  /** 재시도 카운터의 이행 시각·사람 허용·자동 되감기 기록. 승인 해시(작업별 마지막 시도) 밖이다 */
  retry?: PlanningRetry;
  /**
   * 코드가 questions.md 에 쓴 질문의 출처(질문 ID → 작업 ID) — 완료 hook·교차 검토가 질문을 쓸 때 남긴다.
   * `[Origin]` 줄은 이 기록과 같을 때만 무효화 범위를 줄인다(questionOrigin). 승인 해시 밖이다
   */
  questionOrigins?: Record<string, string>;
}

export function planningFile(work: Work): string {
  return join(work.repoRoot, STATE_DIR, "work", work.active.id, `${work.active.target}.planning.json`);
}
export function loadPlanning(work: Work): PlanningState {
  const file = planningFile(work);
  if (!existsSync(file)) return { version: 1, id: work.active.id, target: work.active.target, maxParallel: 3, tasks: [], agents: [] };
  const state = JSON.parse(readFileSync(file, "utf8")) as PlanningState;
  if (state.version !== 1 || state.id !== work.active.id || state.target !== work.active.target || !Array.isArray(state.tasks) || !Array.isArray(state.agents)) throw new Stop("계획 작업 기록 형식이 올바르지 않습니다.");
  return state;
}

// ---- 명령 1회 범위의 계산 메모 ----

/** statSync(path, { bigint: true }) 값을 문자열로 둔다 — Windows 파일 ID(ino)는 2^53 근처라 number 로는 낮은 자리를 잃을 수 있다 */
interface StatKey { mtimeNs: string; size: string; ino: string }
interface PlanningCache {
  /** 절대 경로 → stat 키와 sha */
  files: Map<string, StatKey & { hash: string }>;
  /** questions.md 절대 경로 → stat 키와 본문 */
  questions: Map<string, StatKey & { text: string }>;
  /** root → git ls-files 결과 */
  inventory: Map<string, string[]>;
  /** taskHash 메모 */
  hashes: Map<string, HashedInput>;
}
let cache: PlanningCache | undefined;
/** 한 명령(또는 hook 1회) 안에서만 재사용한다. 범위 밖에서는 매번 계산한다. 안쪽에서 다시 불리면 바깥 범위를 그대로 쓴다 */
export function withPlanningCache<T>(fn: () => T): T {
  if (cache) return fn();
  cache = { files: new Map(), questions: new Map(), inventory: new Map(), hashes: new Map() };
  try { return fn(); } finally { cache = undefined; }
}
/** 판정 결과 메모(taskHash)만 버린다 — 파일·질문 메모는 stat 으로 스스로 검증하므로 남긴다 */
export function invalidatePlanningCache(): void { cache?.hashes.clear(); }
/** 메모를 모두 버린다 — rewind-required 확정처럼 메모 없는 값이 필요할 때 */
export function dropPlanningCache(): void {
  if (cache) { cache.files.clear(); cache.questions.clear(); cache.inventory.clear(); cache.hashes.clear(); }
}
/** 파일이 아니면 undefined */
function statKey(path: string): StatKey | undefined {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? { mtimeNs: String(stat.mtimeNs), size: String(stat.size), ino: String(stat.ino) } : undefined;
}
const sameStat = (a: StatKey, b: StatKey): boolean => a.mtimeNs === b.mtimeNs && a.size === b.size && a.ino === b.ino;

/** 파일 내용 검증에 사용하는 경로. 저장소 밖·링크를 통한 이탈을 허용하지 않는다. */
export function planningPath(root: string, file: string): string {
  const full = resolve(root, file), rel = relative(canonical(root), canonical(full));
  if (isAbsolute(file) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || file.includes(":")) throw new Stop(`저장소 밖 계획 자료: ${file}`);
  return full;
}
/**
 * 파일 sha. 메모 범위 안에서는 부를 때마다 stat 을 다시 하고 (mtimeNs, size, ino)가 같을 때만 sha 를 재사용한다 —
 * 원자 쓰기(임시 파일 rename)는 ino 를 바꾸므로 정식 문서 교체도 잡힌다. 아끼는 것은 파일 전체 읽기이고 stat 은 아끼지 않는다.
 */
export function fileHash(root: string, file: string): string {
  const path = planningPath(root, file);
  if (!cache) return existsSync(path) && statSync(path).isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
  const key = statKey(path);
  if (!key) { cache.files.delete(path); return "missing"; }
  const memo = cache.files.get(path);
  if (memo && sameStat(memo, key)) return memo.hash;
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  cache.files.set(path, { ...key, hash });
  return hash;
}
/** 근거 위치 검사. overlay 에 있는 경로(같은 결과의 출력 문서)는 그 내용으로 줄 범위를 본다 */
export function referenceProblem(root: string, ref: { path: string; line: number }, overlay?: ReadonlyMap<string, string>): string | undefined {
  try {
    const path = planningPath(root, ref.path);
    const staged = overlay?.get(ref.path);
    if (staged === undefined && (!existsSync(path) || !statSync(path).isFile())) return `근거 파일이 없습니다: ${ref.path}`;
    const lines = (staged ?? readFileSync(path, "utf8")).split(/\r?\n/).length;
    if (!Number.isInteger(ref.line) || ref.line < 1 || ref.line > lines) return `근거 줄이 파일 범위를 넘었습니다: ${ref.path}:${ref.line}`;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  return undefined;
}

function listFiles(root: string): string[] {
  try { return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean); }
  catch {
    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
        if (entry.isSymbolicLink() || [".git", ".code-agent", ".claude", ".codex", ".agents", "node_modules", "dist", "build", "target", ".venv", "venv"].includes(entry.name)) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(path); else files.push(path);
        if (files.length > 10000) throw new Stop("계획 입력이 1만 파일을 넘었습니다. Git 저장소와 조사 범위를 확인하세요.");
      }
    };
    visit(""); return files;
  }
}
/**
 * 저장소 파일 목록. 메모 범위 안에서는 root 마다 한 번만 실행한다(잠금 안에서도 그 메모를 쓴다) — code-agent 가 쓰는 파일은
 * scopedFiles 가 빼는 자리(doc/work·.code-agent)에 있고, 사람이 그 사이 만든·지운 파일 이름만 다음 명령이 다시 본다.
 */
function inventory(root: string): string[] {
  if (!cache) return listFiles(root);
  const memo = cache.inventory.get(root);
  if (memo) return memo;
  const files = listFiles(root);
  cache.inventory.set(root, files);
  return files;
}
export function scopedFiles(work: Work, scopes: string[], focused = false): string[] {
  return scopes.length ? inventory(work.repoRoot).filter(file => !/^(?:\.git|\.code-agent|\.claude|\.codex|\.agents|doc\/work)(?:\/|$)/.test(file)
    && !(focused && (/^(?:CLAUDE|AGENTS)\.md$/i.test(file) || /^doc\/code-agent(?:\/|$)/.test(file)))
    && scopes.some(scope => scope === "." || file === scope || file.startsWith(`${scope.replace(/\/$/, "")}/`))) : [];
}
/** 새 작업만 좁은 전달 계약을 사용한다. 저장된 기존 작업의 해시 계약은 유지한다. */
export function inputFiles(work: Work, task: PlanningTask, state = loadPlanning(work)): string[] {
  const visited = new Set<string>();
  const outputs = (ids: string[]): string[] => ids.flatMap(id => {
    if (visited.has(id)) return [];
    visited.add(id);
    const dep = state.tasks.find(record => record.task.id === id)?.task;
    return dep ? [...dep.outputs, ...(task.contextVersion === 2 ? [] : outputs(dep.dependsOn))] : [];
  });
  const policies = task.contextVersion === 2 && ["explore", "synthesis"].includes(task.role) ? ["architecture", "conventions"] as const : POLICY_KINDS;
  const policyFiles = policies.flatMap(kind => docPaths(work.manifest, kind));
  const allPolicyFiles = POLICY_KINDS.flatMap(kind => docPaths(work.manifest, kind));
  const scoped = scopedFiles(work, task.scopes, task.contextVersion === 2).filter(file => !allPolicyFiles.includes(file) || policyFiles.includes(file) || task.inputs.includes(file) || task.scopes.includes(file));
  const docs = task.contextVersion === 2 && task.role !== "analysis" ? [`${workDocsDir(work.active.id)}/01-requirements.md`] : [];
  // 계획의 회귀 TC는 영향도에서 확인한 호출자·공유 모듈 위험을 반드시 이어받는다.
  if (task.contextVersion === 2 && task.role === "plan") docs.push(`${workDocsDir(work.active.id)}/02-analysis.md`);
  // 독립 검토는 전체 판단 문서를 읽어 범위 축소로 지적이 사라지지 않게 한다.
  if (task.contextVersion === 2 && task.role === "critic") docs.push(...["02-analysis.md", "03-design.md", "04-functional.md"].map(file => `${workDocsDir(work.active.id)}/${file}`));
  return [...new Set([work.active.spec, "code-agent.json", ...policyFiles, ...docs, ...task.inputs, ...scoped, ...outputs(task.dependsOn)])].filter(file => !task.outputs.includes(file)).sort();
}
export function dependencyHash(record: TaskRecord | undefined): string | undefined {
  const result = record?.attempts.at(-1)?.result;
  if (!result) return undefined;
  const { taskId, dispatchId, inputHash, ...content } = result;
  return sha(JSON.stringify(content));
}
/** 선행 결과 값 — 새 계약은 판단 내용, 옛 계약은 결과 전체의 해시 */
function dependencyValue(state: PlanningState, task: PlanningTask, id: string): string | undefined {
  const dep = state.tasks.find(item => item.task.id === id);
  return task.contextVersion === 2 ? dependencyHash(dep) : dep?.attempts.at(-1)?.resultHash;
}

/** dependsOn 의 전이 폐포(자기 제외, 순환 안전) */
export function ancestorsOf(state: PlanningState, id: string, seen = new Set<string>()): Set<string> {
  const visit = (current: string): void => {
    for (const dep of state.tasks.find(record => record.task.id === current)?.task.dependsOn ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      visit(dep);
    }
  };
  visit(id);
  seen.delete(id);
  return seen;
}
/**
 * 질문의 출처 — 질문을 쓴 코드(완료 hook·교차 검토)가 planning.json `questionOrigins` 에 남긴 출처와 `[Origin]` 줄이 같고
 * 그 작업이 상태에 있을 때만 믿는다. 메인이 직접 적은 `[Origin]` 은 검증할 수 없으므로 출처 없는 질문으로 본다 —
 * 잘못 적은 한 줄이 앞 단계 작업의 무효화를 막지 못하게 한다.
 */
export function questionOrigin(question: { id: string; origin?: string }, state: PlanningState): string | undefined {
  const origin = question.origin;
  return origin && state.questionOrigins?.[question.id] === origin && state.tasks.some(record => record.task.id === origin) ? origin : undefined;
}
/**
 * 질문이 이 작업의 입력인가 — 코드가 기록한 출처가 있는 질문은 출처 작업과 그 후손만, 없는 질문은 기존 규칙(요구 겹침·범위 없음).
 * 출처 작업이 상태에 없으면(작업 삭제·이름 변경) 기존 규칙으로 떨어진다.
 */
export function questionApplies(question: Question, task: PlanningTask, state: PlanningState): boolean {
  if (task.questionIds.includes(question.id)) return true;
  const origin = questionOrigin(question, state);
  if (origin) return task.id === origin || ancestorsOf(state, task.id).has(origin);
  return !question.requirements?.length || question.requirements.some(key => task.requirements.includes(key));
}
/** 해시에 들어가는 질문 모양 — parseQuestions 에 키(options·source 등)가 늘어도 해시가 바뀌지 않는다. 키 순서는 옛 `{...question, content}` 와 같다 */
export function hashedQuestion(question: Question, content: string) {
  return { id: question.id, title: question.title, answer: question.answer,
    ...(question.status ? { status: question.status } : {}), ...(question.requirements ? { requirements: question.requirements } : {}),
    ...(question.origin ? { origin: question.origin } : {}), content };
}
/** questions.md 본문 — 메모 범위 안에서는 stat 으로 검증한 메모를 쓴다. 없으면 undefined */
function questionsText(work: Work): string | undefined {
  const path = join(work.repoRoot, workDocsDir(work.active.id), "questions.md");
  if (!cache) return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
  const key = statKey(path);
  if (!key) { cache.questions.delete(path); return undefined; }
  const memo = cache.questions.get(path);
  if (memo && sameStat(memo, key)) return memo.text;
  const text = readFileSync(path, "utf8");
  cache.questions.set(path, { ...key, text });
  return text;
}
function relevantQuestions(work: Work, task: PlanningTask, state: PlanningState) {
  const text = questionsText(work);
  if (text === undefined) return [];
  const blocks = text.split(/^## /m).slice(1);
  return parseQuestions(text).filter(question => questionApplies(question, task, state))
    .map(question => hashedQuestion(question, blocks.filter(block => block.split(/\s/)[0] === question.id).map(block => block.trim()).join("\n")));
}
/** 입력 해시와 그 부품. 직렬화 객체는 기존 taskHash 와 키 순서까지 같다 — 진행 중 작업의 결과를 낡게 만들지 않는다 */
export function hashInput(work: Work, state: PlanningState, task: PlanningTask): HashedInput {
  const memoKey = cache ? JSON.stringify([task, task.dependsOn.map(id => [id, dependencyValue(state, task, id)]), [...ancestorsOf(state, task.id)].sort(), state.tasks.map(record => record.task.id)]) : undefined;
  const memo = memoKey === undefined ? undefined : cache!.hashes.get(memoKey);
  if (memo) return memo;
  const inputs = inputFiles(work, task, state).map(file => [file, fileHash(work.repoRoot, file)] as [string, string]);
  // 호스트가 직접 주입하는 지침은 중복 전달하지 않지만 변경 시 기존 판단을 재사용하지 않는다.
  const host = task.contextVersion === 2 ? ["CLAUDE.md", "AGENTS.md"].map(file => [file, fileHash(work.repoRoot, file)] as [string, string]) : undefined;
  const dependencies = task.dependsOn.map(id => [id, dependencyValue(state, task, id)] as [string, string | undefined]);
  const questions = relevantQuestions(work, task, state);
  const manifest = hashManifest(work.manifest);
  const hash = sha(JSON.stringify({ task, base: work.active.baseCommit, manifest, inputs, ...(host ? { hostInstructions: host } : {}), dependencies, questions }));
  const value: HashedInput = { hash, parts: {
    task: sha(JSON.stringify(task)), base: work.active.baseCommit, manifest, inputs: sha(JSON.stringify(inputs)),
    ...(inputs.length <= 50 ? { files: Object.fromEntries(inputs) } : {}), ...(host ? { host: sha(JSON.stringify(host)) } : {}), dependencies,
    // 셋째 칸은 적용 범위를 정한 출처(코드가 기록한 출처만) — 낡은 이유 문구가 실제 적용 규칙을 보인다
    questions: questions.map(question => {
      const origin = questionOrigin(question, state);
      return [question.id, sha(JSON.stringify(question)), ...(origin ? [origin] : [])] as [string, string, string?];
    }),
  } };
  if (memoKey !== undefined) cache!.hashes.set(memoKey, value);
  return value;
}
export function taskHash(work: Work, state: PlanningState, task: PlanningTask): string {
  return hashInput(work, state, task).hash;
}
export function taskCurrent(work: Work, state: PlanningState, record: TaskRecord, seen = new Set<string>()): boolean {
  if (seen.has(record.task.id)) return false;
  const next = new Set([...seen, record.task.id]);
  const last = record.attempts.at(-1);
  return !!last && last.status === "completed" && last.inputHash === taskHash(work, state, record.task) &&
    Object.entries(last.outputs ?? {}).every(([file, hash]) => fileHash(work.repoRoot, file) === hash) &&
    record.task.dependsOn.every(id => { const dep = state.tasks.find(item => item.task.id === id); return !!dep && taskCurrent(work, state, dep, next); });
}
export function readyProblems(work: Work, state: PlanningState, record: TaskRecord): string[] {
  const problems: string[] = [];
  for (const id of record.task.dependsOn) {
    const dep = state.tasks.find(item => item.task.id === id);
    if (!dep || !taskCurrent(work, state, dep)) problems.push(`선행 작업 ${id}의 현재 입력에 대한 완료 결과가 없습니다`);
    if (dep?.attempts.at(-1)?.result?.findings.some(item => item.severity === "blocking")) problems.push(`선행 작업 ${id}에 차단 지적이 있습니다`);
  }
  // 출처가 기록된 질문은 출처 작업과 그 후손 배정만 막는다 — 앞 단계 재배정(되감은 뒤)은 막지 않는다
  const text = questionsText(work);
  // 답의 출처를 확인할 수 없는 질문도 미응답으로 본다(게이트와 같은 판정)
  const parsed = text === undefined ? [] : parseQuestions(text);
  const sources = parsed.some(question => question.answer) ? answerSources(work.repoRoot, work.active.id, parsed) : new Map<string, string>();
  const open = parsed.filter(question => question.answer === "" || sources.get(question.id) === "unverified");
  for (const question of open) if (questionApplies(question, record.task, state)) problems.push(`미결 질문 ${question.id}`);
  for (const file of record.task.inputs) if (fileHash(work.repoRoot, file) === "missing") problems.push(`입력 파일이 없습니다: ${file}`);
  return problems;
}

// ---- 실행 중 배정의 관찰 상태 ----

/** running 시도의 관찰 정보 — advance·dispatch·status·SessionStart 가 같은 판정(retryPolicy.orphanState)과 같은 문구를 쓴다 */
export interface RunView {
  state: "running" | "orphaned" | "suspect";
  dispatchId: string; observedStart: boolean;
  /** 배정 시각부터 */
  elapsedMin: number; reason: string; agentSession?: string;
}
const minutesSince = (now: number, at: string): number => Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
export const ORPHANED_REASON = "연결된 담당이 끝났는데 결과가 기록되지 않았습니다";
/** 출처(transcript) 검증 실패로 고아가 된 시도의 failure.kind — 담당이 고칠 수 없는 hook·환경 원인이라 advance 는 연속이면 자동 재배정을 멈춘다 */
export const SOURCE_FAILURE = "source";
export function runView(state: PlanningState, record: TaskRecord, attempt: TaskAttempt, now: number): RunView {
  const agentType = TASK_AGENTS[record.task.role];
  const verdict = orphanState({ attempt, agentType, agents: state.agents, now });
  const dispatched = Date.parse(attempt.at), elapsedMin = minutesSince(now, attempt.at);
  const base = { state: verdict, dispatchId: attempt.dispatchId, elapsedMin };
  const linked = state.agents.filter(agent => agent.dispatchId === attempt.dispatchId);
  const open = linked.filter(agent => !agent.finished);
  if (open.length) {
    const latest = open.reduce((a, b) => Date.parse(a.startedAt) >= Date.parse(b.startedAt) ? a : b);
    return { ...base, observedStart: true, agentSession: latest.session, reason: `담당이 ${minutesSince(now, latest.startedAt)}분째 끝나지 않았습니다` };
  }
  if (linked.length) return { ...base, observedStart: true, agentSession: linked.at(-1)!.session, reason: ORPHANED_REASON };
  // 시작 때 후보가 여럿이라 연결하지 못한 담당(병렬 시작)은 이 배정의 담당일 수 있다
  const ambiguous = state.agents.filter(agent => !agent.dispatchId && agent.type === agentType && Date.parse(agent.startedAt) >= dispatched && !agent.finished);
  if (ambiguous.length) {
    const earliest = ambiguous.reduce((a, b) => Date.parse(a.startedAt) <= Date.parse(b.startedAt) ? a : b);
    return { ...base, observedStart: true, agentSession: earliest.session, reason: `담당이 ${minutesSince(now, earliest.startedAt)}분째 끝나지 않았습니다` };
  }
  // 시작 미관찰 — 배정 뒤 관찰된 마지막 담당 활동(시작·종료)이 있으면 함께 보인다
  const activity = state.agents.flatMap(agent => [agent.startedAt, agent.endedAt]).filter((at): at is string => !!at).filter(at => Date.parse(at) >= dispatched);
  const last = activity.length ? activity.reduce((a, b) => Date.parse(a) >= Date.parse(b) ? a : b) : undefined;
  return { ...base, observedStart: false, reason: `담당 시작이 관찰되지 않았습니다(배정 ${elapsedMin}분 전${last ? `, 마지막 담당 활동 ${minutesSince(now, last)}분 전` : ""})` };
}

// ---- 낡은 이유 ----

export type StaleKind = "no-run" | "status" | "unknown" | "task" | "base" | "manifest" | "host" | "inputs" | "dependencies" | "questions" | "outputs" | "upstream";
export interface StaleCause { kind: StaleKind; text: string }
/** 되감기 알림의 원인 요약을 고르는 순서 */
export const STALE_PRIORITY: readonly StaleKind[] = ["base", "manifest", "host", "task", "inputs", "questions", "dependencies", "outputs", "upstream", "unknown", "status", "no-run"];
const listed = (paths: string[]): string => paths.length <= 6 ? paths.join(", ") : `${paths.slice(0, 6).join(", ")} … 외 ${paths.length - 6}개`;
/** 작업이 current 가 아닌 이유 — 기록된 입력 부품과 지금 값을 항목별로 비교한다 */
export function staleCauses(work: Work, state: PlanningState, record: TaskRecord): StaleCause[] {
  const last = record.attempts.at(-1);
  if (!last) return [{ kind: "no-run", text: "실행 기록이 없습니다" }];
  if (last.status !== "completed") return [{ kind: "status", text: `마지막 실행 상태: ${last.status}` }];
  const causes: StaleCause[] = [];
  const now = hashInput(work, state, record.task);
  if (now.hash !== last.inputHash) {
    const before = last.inputParts;
    if (!before) causes.push({ kind: "unknown", text: "입력이 바뀌었습니다 — 이전 기록이라 바뀐 항목을 알 수 없습니다" });
    else {
      const after = now.parts;
      if (before.task !== after.task) causes.push({ kind: "task", text: "작업 정의(inputs·requirements 등)가 바뀌었습니다" });
      if (before.base !== after.base) causes.push({ kind: "base", text: "기준 커밋이 바뀌었습니다" });
      if (before.manifest !== after.manifest) causes.push({ kind: "manifest", text: "code-agent.json 이 바뀌었습니다" });
      if (before.host !== after.host) causes.push({ kind: "host", text: "CLAUDE.md·AGENTS.md 가 바뀌었습니다" });
      if (before.inputs !== after.inputs) {
        if (before.files && after.files) {
          const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort().filter(path => before.files![path] !== after.files![path]);
          causes.push({ kind: "inputs", text: paths.length ? `입력 파일: ${listed(paths)}` : "입력 파일 내용·목록이 바뀌었습니다" });
        } else causes.push({ kind: "inputs", text: "입력 파일 내용·목록이 바뀌었습니다" });
      }
      const depBefore = new Map(before.dependencies), changedDeps = after.dependencies.filter(([id, hash]) => depBefore.get(id) !== hash).map(([id]) => id);
      if (changedDeps.length || before.dependencies.length !== after.dependencies.length) causes.push({ kind: "dependencies", text: `선행 결과가 바뀌었습니다: ${changedDeps.join(", ") || before.dependencies.map(([id]) => id).join(", ")}` });
      const qBefore = new Map(before.questions.map(item => [item[0], item])), qAfter = new Map(after.questions.map(item => [item[0], item]));
      const scope = (origin?: string) => origin ? `출처 ${origin}` : "출처 없음 — [Requirements] 범위로 적용";
      for (const [id, item] of qAfter) if (qBefore.get(id)?.[1] !== item[1]) causes.push({ kind: "questions", text: `질문 ${id} 추가·변경(${scope(item[2])})` });
      for (const [id, item] of qBefore) if (!qAfter.has(id)) causes.push({ kind: "questions", text: `질문 ${id} 빠짐(${scope(item[2])})` });
      if (!causes.length) causes.push({ kind: "unknown", text: "입력이 바뀌었습니다 — 바뀐 항목을 알 수 없습니다" });
    }
  }
  for (const [file, hash] of Object.entries(last.outputs ?? {})) if (fileHash(work.repoRoot, file) !== hash) causes.push({ kind: "outputs", text: `출력 문서가 기록 뒤 바뀌었습니다: ${file}` });
  for (const id of record.task.dependsOn) {
    const dep = state.tasks.find(item => item.task.id === id);
    if (!dep || !taskCurrent(work, state, dep)) causes.push({ kind: "upstream", text: `선행 작업 ${id} 가 낡았습니다` });
  }
  return causes;
}
export function staleReasons(work: Work, state: PlanningState, record: TaskRecord): string[] {
  return staleCauses(work, state, record).map(cause => cause.text);
}

const OUTPUTS: Record<PlanningTask["role"], string[]> = {
  analysis: ["01-requirements.md"], explore: [], impact: ["02-analysis.md"], synthesis: ["02-analysis.md"], design: ["03-design.md", "04-functional.md"], plan: ["plan.json", "07-test-spec.md"], critic: [],
};
export function requiredOutputs(work: Work, role: PlanningTask["role"]): string[] { return OUTPUTS[role].map(file => `${workDocsDir(work.active.id)}/${file}`); }

/** questions.md 의 질문 보기 — 계획 교차 지점의 needs-input 판정(질문을 모두 답했는가)에 쓴다 */
export function crossQuestionViews(work: Work): QuestionView[] {
  const text = questionsText(work);
  return text === undefined ? [] : parseQuestions(text).map(question => ({ id: question.id, title: question.title, answered: question.answer !== "" }));
}
/**
 * 현재 critic 지점(마지막 critic 시도가 completed 일 때)의 교차 검토 보기 — 게이트 쪽 고아 보기와 질문 판정(answered-input)을 거친다.
 * 저장된 시도(attempts)와 판정용 보기(view)를 함께 돌려준다
 */
export function criticCrossPoint(work: Work, state: PlanningState, now = Date.now()) {
  const critic = state.tasks.find(record => record.task.role === "critic")?.attempts.at(-1);
  if (!critic || critic.status !== "completed") return undefined;
  const attempts = planningCrossAttemptsOf(state, critic.dispatchId);
  const { view, awaiting } = planningCrossView(orphanView(attempts, now), crossQuestionViews(work));
  return { dispatchId: critic.dispatchId, attempts, view, awaiting, point: crossPointState(view) };
}
/**
 * 현재 critic 결과에 대한 교차 검토가 끝났는지 — 두 호스트가 설치된 프로젝트의 계획 제출 조건. 중지 지점은 통과하고,
 * 완료 지점은 질문 대기·실패·기각되지 않은 차단 지적이 없어야 한다. 열린 지점은 직전 실행의 원인을 붙인다.
 */
export function crossCriticProblems(work: Work, state: PlanningState): string[] {
  if (selectedHosts(work.repoRoot).length < 2) return [];
  const current = criticCrossPoint(work, state);
  if (!current) return [];
  const { dispatchId, view, awaiting, point } = current;
  const caller = runtimeHost();
  const host = pointHost(view) ?? (caller ? otherHost(caller) : undefined);
  const by = `--by ${host ?? "<다른 호스트>"}`;
  switch (point.state) {
    // 다른 호스트를 실행할 수 없었던(또는 사람이 중지를 결정한) critic 결과는 교차 검토 없이 진행한다
    case "stopped": return [];
    case "running": return ["교차 검토: 실행 중입니다 — 끝난 뒤 planning advance 로 확인하세요"];
    case "completed": {
      const outcome = (point.completed as PlanningCrossView).outcome;
      if (outcome?.status === "needs-input") {
        return [`교차 검토: 질문에 답하세요(${(awaiting ?? []).join(", ")}) — 답하면 critic 이 다시 배정되거나, critic 입력이 그대로면 같은 critic 결과로 교차 검토를 한 번 더 실행합니다`];
      }
      if (outcome?.status === "failed") {
        if (view.some(attempt => attempt.class === "cross-stop")) return [];
        return [`교차 검토가 실패로 끝났습니다: ${outcome.summary.replace(/\s+/g, " ").slice(0, 300)} — 같은 critic 결과로는 다시 실행하지 않습니다. ` +
          "원인 작업을 수정 피드백으로 다시 배정하거나, 사용자가 이 지점의 중지를 결정하면 ca-answer 동의 judgment cross-stop 으로 기록하세요"];
      }
      const waivers = state.crossWaivers ?? [];
      const blocking = (outcome?.findings ?? []).filter(finding => finding.severity === "blocking"
        && !waivers.some(waiver => waiver.criticDispatchId === dispatchId && waiver.id === finding.id));
      return blocking.length ? [`교차 검토: 차단 지적이 남아 있습니다(${blocking.map(finding => finding.id).join(", ")}) — 고칠 작업을 지적 내용으로 정해 계약의 수정 피드백으로 다시 배정하세요(앞 단계 작업이면 사용자에게 보고하고 지시를 받습니다). ` +
        "사용자가 지적을 기각하면 ca-answer 동의 judgment waive-finding 으로 기록합니다"] : [];
    }
    default: {
      let line = view.some(attempt => attempt.class === "answered-input")
        ? `교차 검토: 질문에 답했습니다 — 같은 critic 결과로 교차 검토를 한 번 더 실행하세요: code-agent planning cross ${by}`
        : `교차 검토: 두 호스트가 설치된 프로젝트라 다른 호스트의 계획 검토가 필요합니다 — code-agent planning cross ${by} (실행할 수 없으면 중지로 기록되고 진행합니다)`;
      const hint = crossPointHint({ attempts: view, grants: state.retry?.grants, scope: grantScope({ file: "planning", key: "crossPoint", criticDispatchId: dispatchId }),
        rawExists: path => existsSync(join(work.repoRoot, path)) });
      if (hint) {
        line += ` — 직전 실행: ${pointLabel(view)}: ${(point.lastFailure?.detail ?? hint.detail).replace(/\s+/g, " ").slice(0, 120)}. ` +
          crossHintText(hint, { host: host ?? "다른 호스트", point: `계획 검토 critic ${dispatchId.slice(0, 8)}`, attempts: view });
      }
      return [line];
    }
  }
}

export function planningProblems(work: Work, phase: "analysis" | "impact" | "design" | "plan"): string[] {
  if (!work.active.planningVersion) return [];
  return withPlanningCache(() => {
    const state = loadPlanning(work);
    const impactRole = state.tasks.some(record => record.task.role === "impact") ? "impact" : "synthesis";
    const roles: PlanningTask["role"][] = phase === "analysis" ? ["analysis"] : phase === "impact" ? ["analysis", impactRole] : phase === "design" ? ["analysis", impactRole, "design"] : ["analysis", impactRole, "design", "plan", "critic"];
    const problems: string[] = [];
    for (const role of roles) {
      const records = state.tasks.filter(record => record.task.role === role);
      if (records.length !== 1 || !taskCurrent(work, state, records[0])) {
        problems.push(PLANNING_PHASES.indexOf(ROLE_PHASE[role]) < PLANNING_PHASES.indexOf(phase)
          ? `${role}: 현재 입력에 대한 관찰된 완료 결과가 필요합니다 — 앞 단계(${ROLE_PHASE[role]}) 결과가 낡았습니다. code-agent planning advance 가 되감을 단계를 알려 줍니다`
          : `${role}: 현재 입력에 대한 관찰된 완료 결과가 필요합니다 — code-agent planning status`);
      }
      const result = records[0]?.attempts.at(-1)?.result;
      if (result?.findings.some(item => item.severity === "blocking")) problems.push(`${role}: 차단 지적이 남아 있습니다`);
    }
    if (phase !== "analysis") {
      const explorers = state.tasks.filter(record => record.task.role === "explore" || record.task.role === "impact");
      if (!explorers.length) problems.push("영역 조사 작업이 필요합니다. 빈 저장소도 조사 결과로 기록하세요");
      for (const record of explorers) if (!taskCurrent(work, state, record)) problems.push(`영역 조사 ${record.task.id}가 완료되지 않았거나 오래됐습니다`);
      problems.push(...mergeProblems(state));
    }
    if (phase === "plan") problems.push(...crossCriticProblems(work, state));
    return problems;
  });
}
export function mergeProblems(state: PlanningState): string[] {
  const facts = new Map<string, string>();
  const problems: string[] = [];
  for (const record of state.tasks.filter(item => item.task.role === "explore" || item.task.role === "impact")) {
    for (const fact of record.attempts.at(-1)?.result?.facts ?? []) {
      if (facts.has(fact.key) && facts.get(fact.key) !== fact.value) problems.push(`영역 조사 결과 충돌: ${fact.key} — 근거 확인 후 관련 조사 작업을 다시 실행하세요`);
      facts.set(fact.key, fact.value);
    }
  }
  return [...new Set(problems)];
}

/**
 * 업무 규칙 KNOWLEDGE 파일 — 새 analysis·design 기본 작업의 inputs 에 넣는다. 매니페스트의 경로가 파일이면 그 경로,
 * 폴더면 바로 아래 `.md` 를 정렬해 넣는다. 계획 자료 경로 규칙을 지키지 않는 경로와 작업 폴더 아래 경로는 뺀다.
 */
export function businessRuleFiles(work: Work): string[] {
  const files: string[] = [];
  for (const entry of docPaths(work.manifest, "business-rules")) {
    if (entry.includes("\\") || entry.startsWith("./") || entry.split("/").includes("..") || /^\.(?:git|code-agent|claude|codex|agents)(?:\/|$)/i.test(entry) || /^doc\/work(?:\/|$)/.test(entry)) continue;
    let full: string;
    try { full = planningPath(work.repoRoot, entry); } catch { continue; }
    const stat = statSync(full, { throwIfNoEntry: false });
    if (stat?.isFile()) files.push(entry);
    else if (stat?.isDirectory()) files.push(...readdirSync(full).filter(name => name.endsWith(".md")).sort().map(name => posix.join(entry, name)));
  }
  return [...new Set(files)].sort();
}
