import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nextStep, advancePassedIntegrate, requireValidatable } from "../commands";
import { stageHandoff } from "../handoff";
import { skill, skillFile, type SkillName } from "../hostText";
import { loadActive, loadDocsSession, PHASES, type Phase } from "../layout";
import { masterRun, masterRunGuard } from "../master/runGuard";
import { PHASE_SKILL } from "../reentry";
import { loadRequestSession } from "../request";
import { stateView, type StateJson, type StateOptions } from "../stateView";
import { Stop } from "../stop";
import { loadTriage } from "../triageState";
import { integrate } from "../validate";
import { verify } from "../verificationFlow";
import { loadWork } from "../work";
import { withGraphRun } from "./runtime";
import { advancePhase } from "./transition";

export interface FlowHandoff {
  schema: "code-agent.flow";
  version: 1;
  graph: { runId: string; threadId: string };
  node: string;
  kind: "agent" | "human" | "wait" | "done";
  phase?: string;
  action: string;
  instruction: string;
  procedure?: string;
  contextFile?: string;
  agent?: string;
  detail?: unknown;
  resume: "code-agent flow advance --json";
}

/**
 * 전체 작업의 재개 지점. 호스트는 반환한 담당/사람 작업만 수행하고 다시 이 그래프를 호출한다.
 * 승인·질문·계획·증거는 도메인 기록에서 관찰하며, 체크포인트의 값으로 승인하거나 완료시키지 않는다.
 */
export async function advanceFlow(root: string, options: StateOptions = {}): Promise<FlowHandoff> {
  const current = loadActive(root);
  const request = loadRequestSession(root);
  const scope = current ? `${current.id}:${current.target}` : request?.id ?? "preparation";
  // 기대 상태를 가진 호출은 DB나 배정 기록을 만들기 전에 대조한다.
  if (options.expectState !== undefined || options.expectWork !== undefined || options.expectAttempt !== undefined) {
    const check = stateView(root, options);
    if (check.resume.code === "stale-request") throw new Stop(check.resume.reasons[0].detail);
  }
  return withGraphRun(root, "lifecycle", scope, async run => {
    const State = Annotation.Root({ route: Annotation<string>(), node: Annotation<string>(), action: Annotation<string>() });
    let output!: FlowHandoff;
    let view!: StateJson;
    const handoff = (node: string, kind: FlowHandoff["kind"], action: string, instruction: string, procedure?: SkillName, extra: Partial<FlowHandoff> = {}) => {
      output = { schema: "code-agent.flow", version: 1, graph: { runId: run.id, threadId: run.threadId }, node, kind,
        ...(loadActive(root)?.phase ? { phase: loadActive(root)!.phase } : {}), action, instruction,
        ...(procedure ? { procedure: skillFile(procedure) } : {}), ...extra, resume: "code-agent flow advance --json" };
      return { route: kind === "done" ? END : "wait", node, action };
    };
    const procedure = (phase: Phase) => phase === "deliver" ? "ca-integrate" : PHASE_SKILL[phase];
    const graph = new StateGraph(State)
      .addNode("observe", () => {
        run.event("observe", "running");
        const stopped = masterRunGuard({ tool_name: "Bash", tool_input: {} }, root);
        if (stopped) return handoff("control", "wait", "master-stop", stopped);
        const controlled = masterRun(root);
        view = stateView(root, { ...options, session: options.session ?? controlled?.sessionId });
        const work = loadWork(root);
        if (view.resume.code === "unobservable" || view.resume.code === "stale-request") return handoff("inspect", "human", "inspect", view.resume.reasons.map(r => r.detail).join("\n"));
        // 셸 명령의 임대는 PreToolUse가 검사한다. 세션을 명시한 외부 호출은 여기서도 대조한다.
        if (view.resume.code === "ownership-conflict" && (options.session || controlled)) return handoff("ownership", "wait", "wait", view.resume.reasons.map(r => r.detail).join("\n"));
        if (!work) {
          if (loadTriage(root)) return { route: "triage" };
          if (loadDocsSession(root)) return { route: "docs" };
          if (loadRequestSession(root)) return { route: "request" };
          return { route: existsSync(join(root, "code-agent.json")) ? "idle" : "setup" };
        }
        if (view.resume.code === "wait") return handoff("external", "wait", "wait", view.resume.next.hint ?? "진행 중인 담당의 결과를 기다립니다.");
        const pending = view.consents.open.some(item => item.status === "pending" || item.status === "approved");
        const planDraft = work.active.phase === "plan" && !work.plan && !pending;
        if (!planDraft && ["needs-human", "reapproval-required", "limit-reached"].includes(view.resume.code)) {
          // 반영 준비도 승인 계약에 포함된다. 반영 단계 절차가 준비한 동의만 적용한다.
          if (work.active.phase === "deliver" && view.resume.next.action === "deliver-consent" && !pending) return { route: "deliver" };
          return handoff("decision", "human", view.resume.next.action, view.resume.next.hint ?? nextStep(root).next, "ca-answer");
        }
        if (view.resume.code === "replan-required") {
          const phase = view.approval?.staleFrom;
          const target = phase && phase in PHASE_SKILL ? PHASE_SKILL[phase as keyof typeof PHASE_SKILL] : "ca-plan";
          return handoff("replan", "agent", view.resume.next.action, view.resume.next.hint ?? nextStep(root).next, target);
        }
        if (work.active.phase === "plan" && view.approval?.status === "approved") return { route: "approved" };
        return { route: work.active.phase };
      })
      .addNode("setup", () => handoff("setup", "agent", "prepare-project", nextStep(root).next, "ca-adopt"))
      .addNode("idle", () => handoff("idle", "done", "no-work", nextStep(root).next))
      .addNode("docs", () => handoff("docs", "agent", "prepare-docs", nextStep(root).next, "ca-docs"))
      .addNode("request", () => handoff("request", "agent", "prepare-request", nextStep(root).next, "ca-request"))
      .addNode("triage", () => handoff("triage", "agent", "triage", nextStep(root).next, "ca-fix"))
      .addNode("approved", async () => { await advancePhase(root); return { route: "observe" }; })
      .addNode("check", async () => {
        const result = await verify(root);
        if (result.node === "review") return { route: "observe" };
        return handoff(result.node, result.executor === "human" ? "human" : "agent", result.node, result.task,
          result.executor === "human" ? "ca-answer" : "ca-check", { detail: result });
      })
      .addNode("test", () => ({ route: "check" }))
      .addNode("integrate", async () => {
        run.event("integrate", "running");
        // 통합 증거 저장 뒤 커서 이동 전에 중단됐으면 통과 증거로 먼저 게이트를 지난다.
        advancePassedIntegrate(root);
        if (loadActive(root)?.phase === "deliver") return { route: "observe" };
        const result = await integrate(requireValidatable(root, "integrate"));
        advancePassedIntegrate(root);
        if (loadActive(root)?.phase === "deliver") return { route: "observe" };
        return handoff("integrate", "agent", "integration-result", result, "ca-integrate");
      })
      .addNode("wait", state => {
        run.event(state.node, "waiting", state.action);
        interrupt({ node: state.node, action: state.action });
        return {};
      });
    const agentPhases = ["analysis", "impact", "design", "plan", "implement", "review", "deliver"] as const;
    for (const phase of agentPhases) {
      graph.addNode(phase, () => {
        run.event(phase, "running");
        const assigned = phase === "implement" ? stageHandoff(root, "implement") : undefined;
        return handoff(phase, phase === "deliver" ? "human" : "agent", `stage:${phase}`,
          `${skill(procedure(phase))} 절차를 수행하고 결과가 기록되면 code-agent flow advance --json 으로 이어갑니다. ${nextStep(root).next}`,
          procedure(phase), assigned ? { contextFile: assigned.file, agent: assigned.agent } : {});
      });
    }
    // 반복 중의 경로는 이 목록에 있는 노드만 선택할 수 있다.
    const nodes = ["observe", "idle", "setup", "docs", "request", "triage", "approved", ...PHASES, "wait"];
    const edges = graph as unknown as { addEdge(from: string, to: string): unknown; addConditionalEdges(from: string, path: (state: typeof State.State) => string, paths: string[]): unknown };
    edges.addEdge(START, "observe");
    for (const node of nodes.filter(node => node !== "wait")) edges.addConditionalEdges(node, state => state.route, [...nodes, END]);
    edges.addEdge("wait", END);
    // 대기 뒤에도 START에서 최신 승인·입력·master 정지를 다시 검사한다.
    await run.invoke<typeof State.State>(graph.compile({ checkpointer: run.saver }), { route: "observe", node: "observe", action: "observe" });
    return output;
  });
}
