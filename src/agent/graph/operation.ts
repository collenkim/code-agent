import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { loadActive } from "../layout";
import { masterRunGuard } from "../master/runGuard";
import { Stop } from "../stop";
import { withGraphRun } from "./runtime";

/**
 * 접수·문서·승인·수정·리뷰·반영 명령의 실행 경계. 입력 해석·권한·해시 검사는 각 도메인 서비스가 맡는다.
 * 외부 효과가 있는 apply는 저장된 체크포인트로 재생하지 않는다. 동의 ID·배정 ID·기존 증거가 재호출을 판정한다.
 * 응답 본문(확인 코드·사용자 원문 포함)은 체크포인트에 저장하지 않는다.
 */
export async function runOperation<T>(root: string, family: string, action: string, apply: () => T | Promise<T>): Promise<T> {
  const active = loadActive(root);
  return withGraphRun(root, family, active ? `${active.id}:${active.target}` : "preparation", async run => {
    const State = Annotation.Root({ action: Annotation<string>(), phase: Annotation<string | null>() });
    let result!: T;
    const guard = () => {
      const stopped = masterRunGuard({ tool_name: "Bash", tool_input: {} }, root);
      if (stopped) throw new Stop(stopped);
    };
    const graph = new StateGraph(State)
      .addNode("observe", () => { guard(); run.event("observe", "running", action); return { phase: loadActive(root)?.phase ?? null }; })
      .addNode("apply", async () => {
        guard(); run.event(action, "running");
        result = await apply();
        run.event(action, "completed");
        return {};
      })
      .addNode("reconcile", () => ({ phase: loadActive(root)?.phase ?? null }))
      .addEdge(START, "observe").addEdge("observe", "apply").addEdge("apply", "reconcile").addEdge("reconcile", END)
      .compile({ checkpointer: run.saver });
    await run.invoke<typeof State.State>(graph, { action, phase: active?.phase ?? null });
    return result;
  });
}
