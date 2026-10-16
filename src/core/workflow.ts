import { Annotation, END, START, StateGraph, MemorySaver, interrupt } from "@langchain/langgraph";
import type { GraphRun } from "../agent/graph/runtime";

/** 실행 방식은 노드 정의가 결정한다. program 사이에는 모델 호출이 없다. */
export type WorkflowNode<C> =
  | { executor: "program"; run: (context: C) => Promise<string> | string; edges: Record<string, string> }
  | { executor: "agent" | "human"; task: string };

export interface NodeEvent {
  node: string;
  executor: "program" | "agent" | "human";
  status: "running" | "completed" | "waiting" | "error";
  outcome?: string;
  detail?: string;
  at: string;
}

export interface WorkflowHandoff {
  node: string;
  executor: "agent" | "human";
  task: string;
}

/** 노드별 실행과 조건 분기는 LangGraph가 맡는다. 외부 담당의 완료 선언은 게이트를 열지 않는다. */
export async function runWorkflow<C>(
  nodes: Record<string, WorkflowNode<C>>,
  entry: string,
  context: C,
  record: (event: NodeEvent) => void,
  run?: GraphRun,
): Promise<WorkflowHandoff> {
  if (!nodes[entry]) throw new Error(`정의되지 않은 workflow 노드: ${entry}`);
  const State = Annotation.Root({ route: Annotation<string>(), handoff: Annotation<WorkflowHandoff | null>() });
  const builder = new StateGraph(State);
  const routes = Object.fromEntries(Object.keys(nodes).map(key => [key, key]));
  for (const [key, node] of Object.entries(nodes)) {
    const emit = (status: NodeEvent["status"], outcome?: string, detail?: string) => {
      record({ node: key, executor: node.executor, status, outcome, detail, at: new Date().toISOString() });
      run?.event(key, status, detail ?? outcome);
    };
    builder.addNode(key, async () => {
      if (node.executor !== "program") {
        emit("waiting");
        return { route: "wait", handoff: { node: key, executor: node.executor, task: node.task } };
      }
      emit("running");
      try {
        const outcome = await node.run(context), following = node.edges[outcome];
        if (!following || !nodes[following]) throw new Error(`정의되지 않은 workflow 전이: ${key} / ${outcome}`);
        emit("completed", outcome);
        return { route: following };
      } catch (error) {
        emit("error", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }
  builder.addNode("wait", state => { interrupt(state.handoff); return {}; });
  // 동적 이름은 모두 위에서 등록한다. 타입의 정적 노드 집합 대신 실행기 검증을 사용한다.
  const graphBuilder = builder as unknown as {
    addConditionalEdges(source: string, route: (state: typeof State.State) => string, paths: Record<string, string>): void;
    addEdge(source: string, target: string): void;
  };
  for (const key of Object.keys(nodes)) graphBuilder.addConditionalEdges(key, state => state.route, { ...routes, wait: "wait" });
  graphBuilder.addEdge(START, entry);
  graphBuilder.addEdge("wait", END);
  const graph = builder.compile({ checkpointer: run?.saver ?? new MemorySaver() });
  let result: typeof State.State;
  try {
    const input = { route: entry, handoff: null };
    // 검증 재개는 최신 증거에서 진입점을 다시 계산하므로 이전 wait도 재생하지 않는다.
    result = run ? await run.invoke<typeof State.State>(graph, input) : await graph.invoke(input, { configurable: { thread_id: "workflow" }, recursionLimit: 32 });
  } catch (error) {
    if (error instanceof Error && error.name === "GraphRecursionError") throw new Error("workflow 자동 전이 한도를 넘겼습니다.");
    throw error;
  }
  if (!result.handoff) throw new Error("workflow 인계 결과가 없습니다.");
  return result.handoff;
}
