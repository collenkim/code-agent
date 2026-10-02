import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { writeAtomic } from "../core/atomic";
import { planFormatFor } from "../core/plan";
import { workDocsDir } from "./layout";
import { Stop } from "./stop";
import { readSourceTrace } from "./sourceTrace";
import { loadWork, type Work } from "./work";
import { inputFiles, loadPlanning, mergeProblems, planningFile, planningPath, readyProblems, requiredOutputs, TASK_AGENTS, taskCurrent, taskHash, TaskSchema, type PlanningState, type PlanningTask } from "./planningState";

const PHASE: Record<PlanningTask["role"], string> = { analysis: "analysis", explore: "impact", synthesis: "impact", design: "design", plan: "plan", critic: "plan" };
const BatchSchema = z.object({ maxParallel: z.number().int().min(1).max(4).default(3), tasks: z.array(TaskSchema).min(1).max(100) }).strict();

export function planningWork(root: string): Work {
  const work = loadWork(root);
  if (!work) throw new Stop("진행 중인 작업이 없습니다.");
  if (!work.active.planningVersion) throw new Stop("기존 작업은 종전 흐름으로 재개합니다. 새 작업부터 관찰된 계획 작업을 사용합니다.");
  return work;
}
/** 병렬 완료 이벤트는 짧은 파일 잠금 안에서 읽고 갱신한다. 에이전트 실행 동안 잠그지 않는다. */
export function mutatePlanning<T>(work: Work, fn: (state: PlanningState) => T): T {
  const path = planningFile(work);
  mkdirSync(dirname(path), { recursive: true });
  let lock: number;
  const deadline = Date.now() + 2000;
  for (;;) {
    try { lock = openSync(`${path}.lock`, "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Stop("계획 기록을 다른 프로세스가 갱신 중입니다. 같은 명령을 다시 실행하세요. 중단된 프로세스의 잠금은 실행 종료를 확인한 뒤 제거합니다.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const state = loadPlanning(work);
    const value = fn(state);
    writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
    return value;
  } finally { closeSync(lock); unlinkSync(`${path}.lock`); }
}
export function requireRolePhase(work: Work, role: PlanningTask["role"]): void {
  if (work.active.phase !== PHASE[role]) throw new Stop(`${role} 작업은 ${PHASE[role]} 단계에서 실행합니다. 필요하면 code-agent back ${PHASE[role]} 으로 돌아가세요.`);
}
function predecessor(state: PlanningState, role: PlanningTask["role"]): string[] {
  const previous = role === "explore" ? "analysis" : role === "synthesis" ? "explore" : role === "design" ? "synthesis" : role === "plan" ? "design" : role === "critic" ? "plan" : undefined;
  return state.tasks.filter(item => item.task.role === previous).map(item => item.task.id);
}
/** 인자 없는 준비는 한 영역을 조사하는 기본 흐름. 큰 작업은 명시한 영역별 작업으로 교체한다. */
function defaults(work: Work, state: PlanningState): unknown {
  const roles: PlanningTask["role"][] = work.active.phase === "analysis" ? ["analysis"] : work.active.phase === "impact" ? ["explore", "synthesis"] : work.active.phase === "design" ? ["design"] : work.active.phase === "plan" ? ["plan", "critic"] : [];
  const requirementsPath = `${workDocsDir(work.active.id)}/01-requirements.md`;
  const keys = work.active.phase === "analysis" ? readSourceTrace(work.repoRoot, work.active.id, work.active.spec).rows.map(row => row.id) : existsSync(planningPath(work.repoRoot, requirementsPath)) ? [...readFileSync(planningPath(work.repoRoot, requirementsPath), "utf8").matchAll(/^## (R\d+)\b/gm)].map(match => match[1]) : [];
  const pending: PlanningState = { ...state, tasks: [...state.tasks] };
  const tasks = roles.map(role => {
    const existing = pending.tasks.find(item => item.task.role === role);
    if (existing) return existing.task;
    const task: PlanningTask = { id: role, role, title: `${role} 단계 수행`, requirements: keys.length ? keys : ["REQ-1"], inputs: [work.active.spec], scopes: role === "explore" ? ["."] : [], outputs: requiredOutputs(work, role), dependsOn: predecessor(pending, role), questionIds: [] };
    pending.tasks.push({ task, attempts: [] });
    return task;
  });
  return { maxParallel: state.maxParallel, tasks };
}
export function preparePlanning(root: string, batch?: unknown): string {
  const work = planningWork(root);
  return mutatePlanning(work, state => {
    const parsed = BatchSchema.parse(batch ?? defaults(work, state));
    if (new Set(parsed.tasks.map(task => task.id)).size !== parsed.tasks.length) throw new Stop("계획 작업 식별자가 중복되었습니다.");
    const merged = state.tasks.filter(record => !parsed.tasks.some(task => task.id === record.task.id));
    for (const task of parsed.tasks) {
      requireRolePhase(work, task.role);
      const old = state.tasks.find(record => record.task.id === task.id);
      if (old?.attempts.at(-1)?.status === "running") throw new Stop(`${task.id}: 실행 중인 작업은 먼저 취소하세요.`);
      if (old && old.task.role !== task.role) throw new Stop("기존 작업의 역할은 바꿀 수 없습니다.");
      const outputs = requiredOutputs(work, task.role);
      if (JSON.stringify([...task.outputs].sort()) !== JSON.stringify(outputs.sort())) throw new Stop(`${task.id}: 출력은 ${outputs.join(", ") || "없음"}이어야 합니다.`);
      for (const path of [...task.inputs, ...task.scopes, ...task.outputs]) {
        planningPath(root, path);
        if (path.includes("\\") || path.startsWith("./") || path.split("/").includes("..") || /^\.(?:git|code-agent|claude)(?:\/|$)/i.test(path)) throw new Stop(`계획 자료 경로가 허용되지 않습니다: ${path}`);
      }
      if (task.inputs.some(file => task.outputs.includes(file))) throw new Stop("자신의 출력은 입력으로 사용할 수 없습니다.");
      if (task.role !== "explore" && task.scopes.length) throw new Stop("소스 영역은 조사 작업에만 지정합니다. 다른 역할은 선행 조사 결과를 입력으로 받습니다.");
      if (task.role === "explore" && !task.scopes.length) throw new Stop("조사할 소스 영역을 지정하세요.");
      for (const scope of task.scopes) if (!existsSync(planningPath(root, scope))) throw new Stop(`조사 영역이 없습니다: ${scope} — 기존 상위 영역이나 관련 영역을 지정하세요.`);
      merged.push({ task, attempts: old?.attempts ?? [] });
    }
    const candidate = { ...state, tasks: merged };
    if (merged.length > 100) throw new Stop("계획 작업은 최대 100개까지 등록합니다.");
    for (const role of Object.keys(TASK_AGENTS)) if (role !== "explore" && merged.filter(record => record.task.role === role).length > 1) throw new Stop(`${role} 역할은 한 작업만 소유합니다.`);
    for (const record of merged) {
      const expected = predecessor(candidate, record.task.role);
      if (record.task.role !== "analysis" && (!expected.length || expected.some(id => !record.task.dependsOn.includes(id)))) throw new Stop(`${record.task.id}: 선행 역할 작업 전체를 dependsOn에 넣으세요: ${expected.join(", ")}`);
      const visit = (id: string, seen: Set<string>): void => {
        if (seen.has(id)) throw new Stop(`계획 작업 순환 의존성: ${id}`);
        const item = merged.find(row => row.task.id === id);
        if (!item) throw new Stop(`선행 작업이 없습니다: ${id}`);
        item.task.dependsOn.forEach(dep => visit(dep, new Set([...seen, id])));
      };
      visit(record.task.id, new Set());
    }
    state.tasks = merged;
    state.maxParallel = parsed.maxParallel;
    return JSON.stringify({ prepared: parsed.tasks.map(task => task.id), maxParallel: state.maxParallel }, null, 2);
  });
}
export function planningStatus(root: string): string {
  const work = planningWork(root), state = loadPlanning(work);
  return JSON.stringify({ phase: work.active.phase, maxParallel: state.maxParallel, tasks: state.tasks.map(record => ({ ...record.task, state: taskCurrent(work, state, record) ? "completed" : record.attempts.at(-1)?.status === "running" ? "running" : "pending", attempts: record.attempts.length, problems: readyProblems(work, state, record), last: record.attempts.at(-1) })), conflicts: mergeProblems(state) }, null, 2);
}
export function dispatchPlanning(root: string, id: string): string {
  const work = planningWork(root);
  return mutatePlanning(work, state => {
    const record = state.tasks.find(record => record.task.id === id);
    if (!record) throw new Stop(`계획 작업이 없습니다: ${id} — planning prepare를 먼저 실행하세요.`);
    requireRolePhase(work, record.task.role);
    const problems = readyProblems(work, state, record);
    if (record.task.role === "synthesis") problems.push(...mergeProblems(state));
    if (problems.length) throw new Stop(problems.join("\n"));
    if (taskCurrent(work, state, record)) return JSON.stringify({ cached: true, result: record.attempts.at(-1)?.result }, null, 2);
    if (state.tasks.filter(item => item.attempts.at(-1)?.status === "running").length >= state.maxParallel) throw new Stop("동시 실행 한도에 도달했습니다. 실행 결과를 기다리세요.");
    if (record.attempts.at(-1)?.status === "running") throw new Stop("이미 실행 중입니다. 중단된 작업은 planning cancel로 취소 후 다시 배정하세요.");
    const inputHash = taskHash(work, state, record.task);
    if (record.attempts.filter(attempt => attempt.inputHash === inputHash).length >= 3) throw new Stop("같은 입력으로 세 번 실행했습니다. 원인·질문을 확인하고 입력이나 작업 정의를 보완하세요.");
    const attempt = { dispatchId: randomUUID(), inputHash, at: new Date().toISOString(), status: "running" as const };
    record.attempts.push(attempt);
    const dependencies = record.task.dependsOn.map(dep => state.tasks.find(item => item.task.id === dep)!.attempts.at(-1)!.result);
    return JSON.stringify({ cached: false, agent: TASK_AGENTS[record.task.role], task: record.task, inputs: inputFiles(work, record.task), dependencies,
      ...(record.task.role === "plan" ? { planShape: planFormatFor(work.order.kind).shape, stages: work.stages, target: work.active.target, kind: work.order.kind } : {}),
      instructions: "지정 입력과 선행 결과의 근거만 읽으세요. KNOWLEDGE는 검증할 단서이며 코드 재확인 없이 확정 사실로 쓰지 않습니다. 파일을 직접 쓰지 말고 아래 JSON 형태 하나로 반환하세요. 근거는 실제 파일과 줄입니다. 모든 출력은 artifacts에 완전한 내용으로 넣으세요. 미결 질문은 needs-input, 차단 지적은 blocking으로 반환하세요. design·plan은 대안과 경계를 판단하고 synthesis는 관찰 결과를 문서로 정리합니다. plan의 tasks에는 파일 소유·의존성·AC를 넣으세요.",
      resultShape: { taskId: id, dispatchId: attempt.dispatchId, inputHash, status: "completed | needs-input | failed", summary: "판단 및 근거 요약", evidence: [{ path: work.active.spec, line: 1 }], facts: [], questions: [], artifacts: record.task.outputs.map(path => ({ path, content: "전체 문서 내용" })), findings: [] },
      itemShapes: { fact: { key: "공유 사실 식별자", value: "관찰값", source: { path: work.active.spec, line: 1 } }, question: { id: "Q1", question: "사용자가 결정할 사항", requirements: record.task.requirements }, finding: { id: "F1", severity: "blocking | advisory", detail: "문제와 영향", source: { path: work.active.spec, line: 1 } } },
    }, null, 2);
  });
}
export function cancelPlanning(root: string, id: string): string {
  const work = planningWork(root);
  return mutatePlanning(work, state => {
    const last = state.tasks.find(record => record.task.id === id)?.attempts.at(-1);
    if (!last || last.status !== "running") throw new Stop("실행 중인 작업이 아닙니다.");
    last.status = "cancelled";
    return `${id} 배정을 취소했습니다. 이전 실행의 늦은 결과는 받지 않습니다.`;
  });
}
