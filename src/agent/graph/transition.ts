import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { applyNextTransition, nextTransition, type PhaseTransition } from "../commands";
import { loadActive, PHASES } from "../layout";
import { Stop } from "../stop";
import { withGraphRun } from "./runtime";

/** 수동 next·계획 연쇄·루트 그래프가 같은 단계별 게이트와 커서 기록 노드를 쓴다. */
export async function advancePhase(root: string): Promise<string> {
  const active = loadActive(root);
  if (!active) throw new Stop("진행 중인 작업이 없습니다.");
  return withGraphRun(root, "transition", `${active.id}:${active.target}`, async run => {
    const State = Annotation.Root({ phase: Annotation<string>() });
    let transition!: PhaseTransition, output = "";
    const graph = new StateGraph(State);
    for (const phase of PHASES) graph.addNode(`gate.${phase}`, () => {
      run.event(`gate.${phase}`, "running");
      if (loadActive(root)?.phase !== phase) throw new Stop("단계가 바뀌었습니다. 현재 상태에서 다시 진행하세요.");
      transition = nextTransition(root);
      return {};
    });
    graph.addNode("commit", () => {
      run.event("commit", "running");
      // await 경계 사이에 문서·승인이 바뀌었을 수 있어 기록 직전에 게이트를 다시 평가한다.
      const current = nextTransition(root);
      if (JSON.stringify(current) !== JSON.stringify(transition)) throw new Stop("단계 전이 대상이 바뀌었습니다. 다시 진행하세요.");
      output = applyNextTransition(root, current);
      return {};
    });
    const edges = graph as unknown as { addEdge(from: string, to: string): unknown; addConditionalEdges(from: string, path: (state: typeof State.State) => string, paths: string[]): unknown };
    edges.addConditionalEdges(START, state => `gate.${state.phase}`, PHASES.map(phase => `gate.${phase}`));
    for (const phase of PHASES) edges.addEdge(`gate.${phase}`, "commit");
    edges.addEdge("commit", END);
    await run.invoke<typeof State.State>(graph.compile({ checkpointer: run.saver }), { phase: active.phase });
    return output;
  });
}
