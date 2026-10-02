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

/** 외부 실행자는 작업 요청만 받는다. 에이전트의 완료 선언으로 게이트를 열지 않는다. */
export async function runWorkflow<C>(
  nodes: Record<string, WorkflowNode<C>>,
  entry: string,
  context: C,
  record: (event: NodeEvent) => void,
): Promise<WorkflowHandoff> {
  let current = entry;
  for (let transitions = 0; transitions < 32; transitions += 1) {
    const node = nodes[current];
    if (!node) throw new Error(`정의되지 않은 workflow 노드: ${current}`);
    const emit = (status: NodeEvent["status"], outcome?: string, detail?: string) =>
      record({ node: current, executor: node.executor, status, outcome, detail, at: new Date().toISOString() });
    if (node.executor !== "program") {
      emit("waiting");
      return { node: current, executor: node.executor, task: node.task };
    }
    emit("running");
    try {
      const outcome = await node.run(context);
      const following = node.edges[outcome];
      if (!following || !nodes[following]) throw new Error(`정의되지 않은 workflow 전이: ${current} / ${outcome}`);
      emit("completed", outcome);
      current = following;
    } catch (error) {
      emit("error", undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  throw new Error("workflow 자동 전이 한도를 넘겼습니다.");
}
