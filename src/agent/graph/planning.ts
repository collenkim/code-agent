import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { planningAdvanceStep, planningWork } from "../planning";
import { loadPlanning, ROLE_PHASE } from "../planningState";
import { Stop } from "../stop";
import { recordEvent } from "../timeline";
import { withGraphRun } from "./runtime";

interface Step {
  phase: string; action: string; assignments: unknown[]; reused: string[]; waiting: string[];
  blocked: unknown[]; problems: string[]; rewind?: unknown;
  running?: { id: string }[]; orphaned?: { id: string }[]; stale?: { id: string }[];
  cancel?: string[]; feedback?: unknown[];
}

/** 배정 순서·반복·대기는 그래프가 소유한다. 한 작업의 판정과 배정 기록은 도메인 잠금 안에서 원자적으로 처리한다. */
export async function advancePlanningGraph(root: string): Promise<string> {
  const work = planningWork(root);
  const scope = `${work.active.id}:${work.active.target}:${work.active.phase}`;
  return withGraphRun(root, "planning", scope, async run => {
    const State = Annotation.Root({ tasks: Annotation<string[]>(), cursor: Annotation<number>(), action: Annotation<string>() });
    let result!: Step;
    const read = (ids: string[], observeRewind = false) => {
      const latest = planningWork(root);
      if (`${latest.active.id}:${latest.active.target}:${latest.active.phase}` !== scope) throw new Stop("계획 실행 중 작업·단계가 바뀌었습니다. 현재 상태에서 다시 진행하세요.");
      return JSON.parse(planningAdvanceStep(root, ids, observeRewind)) as Step;
    };
    const graph = new StateGraph(State)
      .addNode("prepare", () => {
        run.event("prepare", "running");
        result = read([], true);
        const tasks = loadPlanning(planningWork(root)).tasks.filter(item => ROLE_PHASE[item.task.role] === work.active.phase).map(item => item.task.id);
        return { tasks, cursor: 0, action: result.rewind ? "rewind-required" : "select" };
      })
      .addNode("select", state => ({ action: state.cursor < state.tasks.length ? "dispatch" : "assess" }))
      .addNode("dispatch", state => {
        const id = state.tasks[state.cursor];
        run.event("dispatch", "running", id);
        const step = read([id]);
        for (const key of ["assignments", "reused", "waiting", "blocked"] as const) (result[key] as unknown[]).push(...step[key]);
        for (const key of ["running", "orphaned", "stale"] as const) {
          const merged = new Map([...(result[key] ?? []), ...(step[key] ?? [])].map(item => [item.id, item]));
          if (merged.size) result[key] = [...merged.values()];
        }
        if (step.rewind) result.rewind = step.rewind;
        run.event("dispatch", "completed", `${id}:${step.action}`);
        return { cursor: state.cursor + 1, action: step.rewind ? "assess" : "select" };
      })
      .addNode("assess", () => {
        run.event("assess", "running");
        const latest = read([]);
        result.problems = latest.problems;
        result.feedback = latest.feedback;
        result.rewind = latest.rewind ?? result.rewind;
        result.action = result.rewind ? "rewind-required" : result.assignments.length ? "dispatch" : result.stale?.length ? "stale"
          : result.waiting.length ? "wait" : result.problems.length ? "blocked" : "ready-for-gate";
        if (result.stale?.length) result.cancel = result.stale.map(item => item.id);
        return { action: result.action };
      })
      .addNode("wait", state => {
        run.event("wait", "waiting", state.action);
        interrupt({ kind: "planning", action: state.action });
        return {};
      })
      .addEdge(START, "prepare")
      .addConditionalEdges("prepare", state => state.action === "rewind-required" ? "assess" : "select", ["assess", "select"])
      .addConditionalEdges("select", state => state.action, ["dispatch", "assess"])
      .addConditionalEdges("dispatch", state => state.action, ["select", "assess"])
      .addConditionalEdges("assess", state => state.action === "ready-for-gate" ? END : "wait", [END, "wait"])
      .addEdge("wait", END)
      .compile({ checkpointer: run.saver });
    // 결과는 최신 도메인 기록으로 다시 계산한다. 중단된 배정 노드를 재생하지 않는다.
    await run.invoke<typeof State.State>(graph, { tasks: [], cursor: 0, action: "prepare" });
    // 다음 행동은 그래프가 정한 최종 action 하나만 남긴다. 담당 결과 대기(wait) 말고는 메인이 이어서 한다 — 사람 판단은 흐름(flow advance)이 가른다
    const why = (item: unknown) => { const value = item as { reason?: string; reasons?: string[] } | undefined; return value?.reason ?? value?.reasons?.[0]; };
    recordEvent(root, { type: "next.selected", workId: work.active.id, target: work.active.target, phase: work.active.phase,
      reason: why(result.rewind) ?? why(result.stale?.[0]) ?? why(result.blocked[0]) ?? result.problems[0] ?? "",
      detail: { source: "planning", action: result.action, kind: result.action === "wait" ? "wait" : "agent",
        assignments: result.assignments.length, waiting: result.waiting.length, blocked: result.blocked.length } });
    return JSON.stringify(result, null, 2);
  });
}
