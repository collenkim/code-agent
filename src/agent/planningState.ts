import { existsSync, readFileSync, statSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { z } from "zod";
import { hashManifest } from "../core/approval";
import { sha, docPaths } from "./docs";
import { canonical, STATE_DIR, workDocsDir } from "./layout";
import { POLICY_KINDS } from "./schemas";
import { parseQuestions, unansweredQuestions } from "./questions";
import { Stop } from "./stop";
import type { Work } from "./work";

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
const Reference = z.object({ path: z.string(), line: z.number().int().positive() }).strict();
export const ResultSchema = z.object({
  taskId: z.string(), dispatchId: z.string(), inputHash: z.string(),
  status: z.enum(["completed", "needs-input", "failed"]),
  summary: z.string().trim().min(1).max(4000),
  evidence: z.array(Reference).max(100),
  facts: z.array(z.object({ key: z.string().min(1), value: z.string().min(1), source: Reference }).strict()).max(100),
  questions: z.array(z.object({ id: z.string().regex(/^Q\d+$/), question: z.string().min(1).refine(text => !/^[ \t]*(?:##|\[(?:Answer|Status|Requirements)\]:)/m.test(text), "질문 본문에 질문 제목·답변·상태 필드를 넣을 수 없습니다"), requirements: z.array(z.string()).min(1) }).strict()).max(30),
  artifacts: z.array(z.object({ path: z.string(), content: z.string().max(131072) }).strict()).max(3),
  findings: z.array(z.object({ id: z.string().min(1), severity: z.enum(["blocking", "advisory"]), detail: z.string().min(1), source: Reference }).strict()).max(100),
}).strict();
export type PlanningResult = z.infer<typeof ResultSchema>;
export interface TaskAttempt {
  dispatchId: string; inputHash: string; at: string;
  status: "running" | "completed" | "needs-input" | "needs-correction" | "failed" | "cancelled";
  result?: PlanningResult; resultHash?: string; outputs?: Record<string, string>;
  agentId?: string; sessionId?: string; error?: string;
  correction?: { raw: string; error: string; agentId: string; sessionId: string; used: boolean };
}
export interface TaskRecord { task: PlanningTask; attempts: TaskAttempt[] }
export interface PlanningState {
  version: 1; id: string; target: string; maxParallel: number;
  tasks: TaskRecord[];
  agents: { id: string; session: string; type: string; startedAt: string; finished?: boolean; dispatchId?: string }[];
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

/** 파일 내용 검증에 사용하는 경로. 저장소 밖·링크를 통한 이탈을 허용하지 않는다. */
export function planningPath(root: string, file: string): string {
  const full = resolve(root, file), rel = relative(canonical(root), canonical(full));
  if (isAbsolute(file) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || file.includes(":")) throw new Stop(`저장소 밖 계획 자료: ${file}`);
  return full;
}
export function fileHash(root: string, file: string): string {
  const path = planningPath(root, file);
  return existsSync(path) && statSync(path).isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "missing";
}
export function referenceProblem(root: string, ref: { path: string; line: number }): string | undefined {
  try {
    const path = planningPath(root, ref.path);
    if (!existsSync(path) || !statSync(path).isFile()) return `근거 파일이 없습니다: ${ref.path}`;
    if (!Number.isInteger(ref.line) || ref.line < 1 || ref.line > readFileSync(path, "utf8").split(/\r?\n/).length) return `근거 줄이 파일 범위를 넘었습니다: ${ref.path}:${ref.line}`;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
  return undefined;
}

function inventory(root: string): string[] {
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
export function taskHash(work: Work, state: PlanningState, task: PlanningTask): string {
  return sha(JSON.stringify({
    task, base: work.active.baseCommit, manifest: hashManifest(work.manifest),
    inputs: inputFiles(work, task, state).map(file => [file, fileHash(work.repoRoot, file)]),
    // 호스트가 직접 주입하는 지침은 중복 전달하지 않지만 변경 시 기존 판단을 재사용하지 않는다.
    ...(task.contextVersion === 2 ? { hostInstructions: ["CLAUDE.md", "AGENTS.md"].map(file => [file, fileHash(work.repoRoot, file)]) } : {}),
    dependencies: task.dependsOn.map(id => { const dep = state.tasks.find(item => item.task.id === id); return [id, task.contextVersion === 2 ? dependencyHash(dep) : dep?.attempts.at(-1)?.resultHash]; }),
    questions: relevantQuestions(work, task),
  }));
}
function relevantQuestions(work: Work, task: PlanningTask) {
  const file = join(work.repoRoot, workDocsDir(work.active.id), "questions.md");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8"), blocks = text.split(/^## /m).slice(1);
  return parseQuestions(text).filter(question => !question.requirements?.length || task.questionIds.includes(question.id) || question.requirements.some(key => task.requirements.includes(key)))
    .map(question => ({ ...question, content: blocks.filter(block => block.split(/\s/)[0] === question.id).map(block => block.trim()).join("\n") }));
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
  const open = unansweredQuestions(work.repoRoot, `${workDocsDir(work.active.id)}/questions.md`);
  for (const question of open) if (!question.requirements?.length || record.task.questionIds.includes(question.id) || question.requirements.some(key => record.task.requirements.includes(key))) problems.push(`미결 질문 ${question.id}`);
  for (const file of record.task.inputs) if (fileHash(work.repoRoot, file) === "missing") problems.push(`입력 파일이 없습니다: ${file}`);
  return problems;
}

const OUTPUTS: Record<PlanningTask["role"], string[]> = {
  analysis: ["01-requirements.md"], explore: [], impact: ["02-analysis.md"], synthesis: ["02-analysis.md"], design: ["03-design.md", "04-functional.md"], plan: ["plan.json", "07-test-spec.md"], critic: [],
};
export function requiredOutputs(work: Work, role: PlanningTask["role"]): string[] { return OUTPUTS[role].map(file => `${workDocsDir(work.active.id)}/${file}`); }

export function planningProblems(work: Work, phase: "analysis" | "impact" | "design" | "plan"): string[] {
  if (!work.active.planningVersion) return [];
  const state = loadPlanning(work);
  const impactRole = state.tasks.some(record => record.task.role === "impact") ? "impact" : "synthesis";
  const roles: PlanningTask["role"][] = phase === "analysis" ? ["analysis"] : phase === "impact" ? ["analysis", impactRole] : phase === "design" ? ["analysis", impactRole, "design"] : ["analysis", impactRole, "design", "plan", "critic"];
  const problems: string[] = [];
  for (const role of roles) {
    const records = state.tasks.filter(record => record.task.role === role);
    if (records.length !== 1 || !taskCurrent(work, state, records[0])) problems.push(`${role}: 현재 입력에 대한 관찰된 완료 결과가 필요합니다 — code-agent planning status`);
    const result = records[0]?.attempts.at(-1)?.result;
    if (result?.findings.some(item => item.severity === "blocking")) problems.push(`${role}: 차단 지적이 남아 있습니다`);
  }
  if (phase !== "analysis") {
    const explorers = state.tasks.filter(record => record.task.role === "explore" || record.task.role === "impact");
    if (!explorers.length) problems.push("영역 조사 작업이 필요합니다. 빈 저장소도 조사 결과로 기록하세요");
    for (const record of explorers) if (!taskCurrent(work, state, record)) problems.push(`영역 조사 ${record.task.id}가 완료되지 않았거나 오래됐습니다`);
    problems.push(...mergeProblems(state));
  }
  return problems;
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
