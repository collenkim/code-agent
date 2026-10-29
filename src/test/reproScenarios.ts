/**
 * 재현 시나리오 — 같은 fixture(planningRepo)에서 사례를 다시 돌려 관찰한 사실·소요·실행 타임라인을 돌려준다.
 *
 * 판정하지 않는다. `reproScenarios.test`가 지금 동작을 고정하고, `scripts/repro-baseline.cjs`가 빌드(dist)마다 같은 시나리오를 돌려
 * 개선 전후의 사실과 시간을 비교한다. 저장소는 시나리오마다 새 임시 저장소이고 끝나면 지운다.
 *
 * - amendment: 확정한 요구가 있는 작업에 같은 ID 로 추가 요구만 든 전체 목록 초안을 낸 뒤(거부), 확정 개정 기준의 변경안을 제출·확정한다.
 * - staleIds: 확정한 요구에 새 요구 ID 가 생긴 뒤 계획을 다시 준비한다.
 * - completionStall: 격리한 가짜 Claude 호스트 — CLI 진입점에 hook 입력을 넣고 메인 대화 기록을 임시 폴더에 쓴다. 담당 완료 뒤 Stop hook 이
 *   턴을 이어 붙이지 않으면 사람 입력이 있어야 다음 행동을 실행한다.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIR, ID, planningRepo, REQUIREMENTS, SPEC } from "./planningRepo";
import { writeFixture } from "./repoFixture";
import { preparePlanning, planningWork } from "../agent/planning";
import { loadPlanning } from "../agent/planningState";
import { recordRequestDecision, renderRequirement, requestFormat, requestState, requestSubmit, revisionHeads, type RequestDraft } from "../agent/request";
import { sourceItems } from "../agent/sourceTrace";
import { readTimeline, runtimeLabel, summarizeByWork, type TimelineEvent, type TimelineSummary } from "../agent/timeline";
import { usageReport } from "../agent/usage";

export interface ScenarioResult {
  name: ScenarioName;
  title: string;
  runtime: string;
  /** 관찰한 사실 — 개선 전후에 바뀌는 값 */
  facts: Record<string, unknown>;
  /** 시나리오 실행 벽시계 */
  wallMs: number;
  timeline: TimelineSummary[];
  /** 그 저장소의 timeline.jsonl 전부 */
  events: TimelineEvent[];
}

const presence = { channel: "tty" as const, verified: true, detail: "재현 시나리오 — 격리 저장소" };
const confirm = (root: string) => recordRequestDecision(root, { id: ID, spec: SPEC, decision: "confirmed", approver: "repro", presence });
function draft(requirements: string[]): RequestDraft {
  return {
    kind: "feature", id: ID, title: "요구 변경 재현", target: ["value"], scope: [], preserve: [], extra: {}, background: "", requirements,
    original: requirements.join("\n"), done: [], outOfScope: [], constraints: [], clarifications: [],
    sourceMap: requirements.map((quote, index) => ({ quote, targets: [`REQ-${index + 1}`] })),
  };
}
/** 요구를 지시서에 쓰고 사람이 확정한 것으로 둔다 */
function seed(root: string, requirements: string[]): void {
  writeFixture(root, SPEC, renderRequirement(draft(requirements), requirements.join("\n"), "original"));
  confirm(root);
}
const sourceTexts = (root: string) => sourceItems(readFileSync(join(root, SPEC), "utf8"));

function amendment(root: string): Record<string, unknown> {
  const before = ["결제 뒤 24시간 안에 주문을 취소한다.", "배송이 시작된 주문은 취소하지 않는다."], added = ["취소 사유를 저장한다."];
  seed(root, before);
  const file = `${DIR}/request.json`;
  // 추가 요구만 든 전체 목록 초안 — 빠진 확정 요구를 지우지 않고 받지 않는다
  writeFixture(root, file, JSON.stringify(draft(added)));
  let refused = false;
  try { requestSubmit(root, file); } catch { refused = true; }
  const keptAfterRefusal = sourceTexts(root).map((item) => item.text);
  // 확정 개정 기준의 변경안 — 담당이 형식(code-agent request)에서 부모 개정을 읽는다
  const parent = Number(/## 확정된 요구 — 개정 (\d+)/.exec(requestFormat(root))?.[1]);
  const { requirements: _all, ...rest } = draft(added);
  writeFixture(root, file, JSON.stringify({ ...rest, revision: { parent, mode: "amend" }, changes: [{ op: "add", section: "REQ", text: added[0] }],
    sourceMap: [{ quote: added[0], targets: [`REQ-${before.length + 1}`] }] }));
  const response = requestSubmit(root, file);
  const after = sourceTexts(root).map((item) => item.text);
  const status = requestState(root, ID, SPEC).status;
  confirm(root);
  return {
    before, submitted: added, fullDraftRefused: refused, keptAfterRefusal: before.every((text) => keptAfterRefusal.includes(text)), after,
    keptPrevious: before.every((text) => after.includes(text)), parent, revision: revisionHeads(root, ID, SPEC).confirmed?.revision ?? null,
    statusAfterSubmit: status, proposalShown: /요구 변경안을 렌더했습니다/.test(response), reconfirmed: requestState(root, ID, SPEC).status,
  };
}

function staleIds(root: string): Record<string, unknown> {
  const analysisTask = () => loadPlanning(planningWork(root)).tasks.find((record) => record.task.role === "analysis")!.task;
  seed(root, ["값을 반환한다."]);
  preparePlanning(root);
  const assignedBefore = analysisTask().requirements;
  seed(root, ["값을 반환한다.", "추가 값을 반환한다."]);
  preparePlanning(root);
  return { sourceIds: sourceTexts(root).map((item) => item.id), assignedBefore, assignedAfter: analysisTask().requirements };
}

/** 격리 호스트 — 이 빌드의 CLI 진입점을 자식 프로세스로 부른다. 상위 node:test 의 전송 모드는 물려주지 않는다 */
function hostCli(root: string, args: string[], stdin?: object): { status: number | null; stdout: string; stderr: string } {
  const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
  const result = spawnSync(process.execPath, [join(__dirname, "..", "agent", "cli.js"), ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, input: stdin ? JSON.stringify(stdin) : "",
    env: { ...env, CLAUDE_PROJECT_DIR: root, CODE_AGENT_HOST: "claude" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const SESSION = "repro-main";

function completionStall(root: string, transcripts: string): Record<string, unknown> {
  // 메인 대화 기록(Claude 꼴) — 완료 알림·사람 입력·도구 호출의 시각만 쓴다
  const main: object[] = [];
  const say = (content: string) => main.push({ type: "user", timestamp: new Date().toISOString(), message: { content } });
  const tool = (command: string) => main.push({ type: "assistant", timestamp: new Date().toISOString(),
    message: { id: `msg-${main.length}`, content: [{ type: "tool_use", id: `tool-${main.length}`, name: "Bash", input: { command } }] } });
  const advance = () => {
    tool("code-agent planning advance --chain");
    const run = hostCli(root, ["planning", "advance", "--chain"]);
    return JSON.parse(run.stdout) as { action: string; assignments?: { assignmentFile: string }[]; chain?: { gate?: string } };
  };
  const dispatched = advance();
  const text = readFileSync(join(root, dispatched.assignments![0].assignmentFile), "utf8"), from = text.indexOf("```json\n") + 8;
  const item = JSON.parse(text.slice(from, text.indexOf("\n```", from)));
  const agent = { cwd: root, session_id: SESSION, agent_id: "repro-agent-1", agent_type: item.hostAgents.claude };
  hostCli(root, ["planning-event"], { ...agent, hook_event_name: "SubagentStart" });
  // 담당이 도는 동안 메인 턴이 끝난다 — 완료 알림이 와야 다시 움직인다
  const waiting = hostCli(root, ["stop"], { cwd: root, session_id: SESSION, hook_event_name: "Stop", last_assistant_message: "분석 담당을 배정했습니다. 완료 알림을 기다립니다." });
  const result = { taskId: item.task.id, dispatchId: item.resultShape.dispatchId, inputHash: item.resultShape.inputHash, status: "completed", summary: "재현 담당 완료",
    evidence: [{ path: SPEC, line: 1 }], facts: [], questions: [], findings: [], artifacts: [{ path: `${DIR}/01-requirements.md`, content: REQUIREMENTS }] };
  const finished = hostCli(root, ["planning-event"], { ...agent, hook_event_name: "SubagentStop", last_assistant_message: JSON.stringify(result) });
  say(`<task-notification>\n<task-id>${agent.agent_id}</task-id>\n<status>completed</status>\n</task-notification>`);
  // 알림을 받은 턴이 다음 행동 없이 끝난다 — Stop hook 이 막으면(턴을 이어 붙이면) 호스트가 바로 다음 행동을 실행한다
  const after = hostCli(root, ["stop"], { cwd: root, session_id: SESSION, hook_event_name: "Stop", last_assistant_message: "분석 담당이 완료되었습니다." });
  const blocked = after.stdout.trim() ? (JSON.parse(after.stdout) as { decision?: string }).decision === "block" : false;
  if (!blocked) say("계속 진행해");
  const resumed = advance();
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(join(transcripts, `${SESSION}.jsonl`), main.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return {
    dispatched: dispatched.action, stopWhileRunningBlocked: !!waiting.stdout.trim(), subagentStopExit: finished.status,
    stopAfterCompletionBlocked: blocked, humanInputNeeded: !blocked, resumedAction: resumed.action, gate: resumed.chain?.gate ?? null,
  };
}

export const SCENARIOS = {
  amendment: { title: "같은 ID 의 추가 요구가 확정한 요구를 보존한 새 개정으로 반영된다", run: amendment },
  staleIds: { title: "새 요구 ID 가 생겨도 계획 준비가 옛 요구 ID 로 배정한다", run: staleIds },
  completionStall: { title: "담당 완료 알림 뒤 Stop 이 턴을 잇지 않아 사람 입력으로 재개한다", run: completionStall },
} as const;
export type ScenarioName = keyof typeof SCENARIOS;

/** 시나리오 하나를 새 임시 저장소에서 돌리고 지운다 */
export function runScenario(name: ScenarioName): ScenarioResult {
  const root = planningRepo("ca-repro-"), transcripts = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-repro-host-")));
  try {
    const started = performance.now();
    const facts = (SCENARIOS[name].run as (root: string, transcripts: string) => Record<string, unknown>)(root, join(transcripts, "project"));
    const wallMs = Math.round(performance.now() - started);
    const events = readTimeline(root);
    const timeline = name === "completionStall" ? usageReport(root, { transcripts: join(transcripts, "project") }).timeline : summarizeByWork(events);
    return { name, title: SCENARIOS[name].title, runtime: runtimeLabel(), facts, wallMs, timeline, events };
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(transcripts, { recursive: true, force: true });
  }
}
