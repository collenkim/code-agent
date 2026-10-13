import { existsSync, readFileSync, realpathSync, rmSync } from "fs";
import { basename, dirname, relative, resolve, sep } from "path";
import { writeAtomic } from "../core/atomic";
import { sha } from "./docs";
import { findRepoRoot, questionsFile, workDocsDir } from "./layout";
import { mutatePlanning, openStaging, requireRolePhase, stagingPath } from "./planning";
import { fileHash, hashInput, inputFiles, invalidatePlanningCache, loadPlanning, planningPath, readyProblems, referenceProblem, ResultSchema, SOURCE_FAILURE, TASK_AGENTS, withPlanningCache,
  type PlanningAgent, type PlanningResult, type PlanningState, type ResolvedResult, type TaskAttempt, type TaskRecord } from "./planningState";
import { failure, guidance, LIMITS, subagentExit, TIMING, type FailureClass, type FailureRecord } from "./retryPolicy";
import { RecordedFailure, type ReviewHookInput } from "./reviewHook";
import { stagedDocumentProblems } from "./stagedChecks";
import { loadWork, type Work } from "./work";
import { crossChild } from "./crossEnv";
import { withNotation } from "./hostText";
import { noteSubagentReturn } from "./hookLog";

/** 기록하지 않고 같은 담당에게 한 번 돌려보낸다(Claude SubagentStop exit 2) — 담당이 고쳐 다시 멈추면 처음부터 다시 판정한다 */
export class ReturnToAgent extends Error { constructor(message: string, readonly failureClass: FailureClass) { super(message); } }
/** 실패를 기록한 뒤의 실패 — 담당이 다시 멈춰도 바뀌는 것이 없다 */
export class PlanningFailure extends RecordedFailure { constructor(message: string, readonly failureClass: FailureClass) { super(message); } }

/** handbacks: 읽은 SubagentHandback 보고 수(담당 시작 뒤) — 되돌릴 때 기록해 다음 완료가 그 뒤의 보고만 보게 한다 */
type Received = { raw: string; handbacks: number; sourceError?: undefined; tooLarge?: boolean } | { sourceError: string; raw?: undefined };
/** 결과 크기 한도(글자) — 넘으면 원본을 보존하지 않는다(상태 비대 방지) */
const RESULT_LIMIT = 500_000;
/**
 * hook의 세션별 실제 하위 transcript만 읽는다. 저장소 안의 임의 JSON은 실행 증거가 아니다.
 * 출처 검증 실패(경로·세션·transcript 줄)는 되돌릴 수 없는 실패로, 크기 한도는 형식 오류로 나눈다.
 * 되돌린 담당이면 되돌릴 때까지 판정한 보고(`judgedHandbacks`개) 뒤의 SubagentHandback 만 본다 — 되돌린 옛 보고를 다시 판정하지 않고,
 * 뒤에 보고가 없으면 최종 응답(last_assistant_message)을 쓴다. 시각이 아니라 순서로 나누므로 기록 시각의 오차에 기대지 않는다.
 */
function receive(input: ReviewHookInput, root: string, startedAt: string, judged = 0): Received {
  let result = input.last_assistant_message ?? "", handbacks = 0;
  if (input.agent_transcript_path) {
    try {
      if (!input.transcript_path || !/^[\w-]+$/.test(input.agent_id ?? "")) throw new Error("계획 실행 기록 경로가 유효하지 않습니다.");
      const expected = resolve(dirname(input.transcript_path), basename(input.transcript_path, ".jsonl"), "subagents", `agent-${input.agent_id}.jsonl`);
      const actual = resolve(input.agent_transcript_path);
      if (actual !== expected || !existsSync(actual)) throw new Error("해당 세션의 하위 에이전트 기록이 아닙니다.");
      const inside = relative(realpathSync(root), realpathSync(actual));
      if (!inside.startsWith(`..${sep}`) && inside !== ".." && !/^[A-Za-z]:/.test(inside)) throw new Error("저장소 파일은 실행 관찰 기록으로 사용할 수 없습니다.");
      for (const line of readFileSync(actual, "utf8").split("\n").filter(Boolean)) {
        const entry = JSON.parse(line);
        if (!(Date.parse(entry.timestamp) >= Date.parse(startedAt)) || entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
        for (const block of entry.message.content) {
          if (block.type === "tool_use" && block.name === "SubagentHandback" && typeof block.input?.message === "string" && ++handbacks > judged) result = block.input.message;
        }
      }
    } catch (error) { return { sourceError: error instanceof Error ? error.message : String(error) }; }
  }
  if (result.length > RESULT_LIMIT) return { raw: "", handbacks, tooLarge: true };
  return { handbacks, raw: result.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1") };
}
/** 담당이 staging에 쓴 출력 문서를 읽는다. 배정된 경로가 아니면 받지 않는다. */
function stagedContent(root: string, id: string, dispatchId: string, item: { path: string; staged: string }): string {
  if (item.staged !== stagingPath(id, dispatchId, item.path)) throw new Error(`배정된 staging 경로가 아닙니다: ${item.staged}`);
  const file = planningPath(root, item.staged);
  if (!existsSync(file)) throw new Error(`staging 문서가 없습니다: ${item.staged}`);
  const content = readFileSync(file, "utf8");
  if (content.length > 131072) throw new Error(`staging 문서가 크기 한도를 넘었습니다: ${item.staged}`);
  return content;
}
/** 형식 교정 비교용 — 원본이 staging으로 냈다면 그 파일이 남아 있을 때 본문으로 바꿔 대조한다 */
function comparable(root: string, items: PlanningResult["artifacts"]): unknown {
  return items.map(item => {
    if (!("staged" in item)) return item;
    try { return { path: item.path, content: readFileSync(planningPath(root, item.staged), "utf8") }; } catch { return item; }
  });
}

/** 보고된 출력 문서의 본문과 그 역할의 결정적 문서 검사 — 잠금 밖에서 미리 계산하고, 잠금 안에서 같은 배정이면 그대로 쓴다 */
interface Staged { dispatchId: string; artifacts: { path: string; content: string }[]; readErrors: string[]; docProblems: string[] }
function readStaged(work: Work, record: TaskRecord, reported: PlanningResult): Staged {
  const artifacts: { path: string; content: string }[] = [], readErrors: string[] = [];
  for (const item of reported.artifacts) {
    if (!("staged" in item)) { artifacts.push(item); continue; }
    try { artifacts.push({ path: item.path, content: stagedContent(work.repoRoot, work.active.id, reported.dispatchId, item) }); }
    catch (error) { readErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  const outputs = reported.artifacts.map(artifact => artifact.path);
  const exact = JSON.stringify([...outputs].sort()) === JSON.stringify([...record.task.outputs].sort());
  let docProblems: string[] = [];
  if (!readErrors.length && exact && artifacts.length) {
    try { docProblems = stagedDocumentProblems(work, record.task.role, artifacts); }
    catch (error) { docProblems = [`문서 검사를 실행하지 못했습니다: ${error instanceof Error ? error.message : error}`]; }
  }
  return { dispatchId: reported.dispatchId, artifacts, readErrors, docProblems };
}

interface Prepared {
  received: Received;
  parsed?: unknown;
  /** JSON·스키마·크기 오류 문구 */
  formatError?: string;
  reported?: PlanningResult;
  staged?: Staged;
}
/** 잠금 밖 준비 — 결과 수신·파싱·staging 읽기·문서 검사를 먼저 하고, 같은 범위의 해시 계산으로 메모를 채운다 */
function prepareStop(input: ReviewHookInput, work: Work): Prepared | undefined {
  const snapshot = loadPlanning(work);
  const agent = [...snapshot.agents].reverse().find(agent => agent.id === input.agent_id && agent.session === input.session_id);
  if (!agent) return undefined;
  const received = receive(input, work.repoRoot, agent.startedAt, agent.judgedHandbacks);
  if (received.sourceError !== undefined) return { received };
  if (received.tooLarge) return { received, formatError: `계획 결과가 크기 한도(${RESULT_LIMIT.toLocaleString("en-US")}자)를 넘었습니다` };
  let parsed: unknown, parseError: unknown;
  try { parsed = JSON.parse(received.raw); } catch (error) { parseError = error; }
  const schema = ResultSchema.safeParse(parsed);
  if (!schema.success) return { received, parsed, formatError: (parseError instanceof Error ? parseError.message : schema.error.message).slice(0, 4000) };
  const reported = schema.data;
  const record = snapshot.tasks.find(item => item.task.id === reported.taskId), last = record?.attempts.at(-1);
  let staged: Staged | undefined;
  if (record && last?.status === "running" && last.dispatchId === reported.dispatchId) {
    try {
      // 잠금 안의 같은 계산은 stat 만 다시 보고 sha 를 재사용한다
      hashInput(work, snapshot, record.task); readyProblems(work, snapshot, record); inputFiles(work, record.task, snapshot);
    } catch { /* 잠금 안에서 다시 판정한다 */ }
    if (reported.status === "completed") staged = readStaged(work, record, reported);
  }
  return { received, parsed, reported, staged };
}

type Decision = { kind: "ignored" } | { kind: "done" } | { kind: "recorded"; message: string; cls: FailureClass } | { kind: "return"; message: string; cls: FailureClass };
const recorded = (message: string, cls: FailureClass): Decision => ({ kind: "recorded", message, cls });
function endAgent(agent: PlanningAgent, record?: FailureRecord): void {
  agent.finished = true;
  agent.endedAt = new Date().toISOString();
  if (record) agent.failure = record;
}
function markOrphaned(attempt: TaskAttempt, detail: string, kind?: string): void {
  attempt.status = "orphaned";
  attempt.error = detail;
  attempt.failure = failure("dispatch-orphan", detail, kind ? { kind } : {});
}
/**
 * 이 담당이 연결된 시도를 고아로 둔다. 같은 시도에 연결된 다른 미완료 담당이 있으면 두지 않는다 — 그 담당의 결과를 기다린다
 * (advance 의 고아 판정 orphanState 와 같은 기준: 연결된 담당이 모두 끝나야 고아다).
 */
function orphanLinked(state: PlanningState, agent: PlanningAgent, linked: TaskAttempt | undefined, detail: string, kind?: string): void {
  if (!linked || state.agents.some(other => other !== agent && !other.finished && other.dispatchId === linked.dispatchId)) return;
  markOrphaned(linked, detail, kind);
}
/** 실행 중 단계·입력이 바뀌었으면 그 사유. 진행 중 배정은 취소한다(늦은 결과는 새 입력의 결과가 아니다) */
function inputChanged(work: Work, state: PlanningState, record: TaskRecord, last: TaskAttempt): string | undefined {
  try { requireRolePhase(work, record.task.role); } catch (error) { return error instanceof Error ? error.message : String(error); }
  if (hashInput(work, state, record.task).hash !== last.inputHash) return "실행 중 입력이 바뀌었습니다. 새 입력으로 다시 배정하세요.";
  return undefined;
}

/**
 * 잠금 안 판정 — 결과를 값으로 돌려준다. 예외면 mutatePlanning 이 저장하지 않으므로(되돌림 카운터·고아 기록을 남겨야 한다)
 * 던지지 않는다. 되돌림(return)은 Claude 의 첫 SubagentStop 에서만, 담당이 고칠 수 있는 실패(형식·식별·내용)에만 쓴다.
 */
function decideStop(input: ReviewHookInput, work: Work, state: PlanningState, prepared: Prepared, host?: "claude" | "codex"): Decision {
  const root = work.repoRoot;
  const agent = [...state.agents].reverse().find(agent => agent.id === input.agent_id && agent.session === input.session_id);
  if (!agent) return { kind: "ignored" }; // 다른 스킬이 부른 동일 이름 에이전트
  if (agent.finished) return recorded("이미 처리한 완료 이벤트입니다.", "dispatch-orphan");
  const canReturn = host === "claude" && input.stop_hook_active !== true && (agent.returns ?? 0) < LIMITS.agentReturn;
  const giveBack = (message: string, cls: FailureClass): Decision => {
    agent.returns = (agent.returns ?? 0) + 1;
    if (prepared.received.sourceError === undefined) agent.judgedHandbacks = prepared.received.handbacks;
    return { kind: "return", message, cls };
  };
  const linkedRecord = agent.dispatchId ? state.tasks.find(item => item.attempts.at(-1)?.status === "running" && item.attempts.at(-1)?.dispatchId === agent.dispatchId) : undefined;
  const linked = linkedRecord?.attempts.at(-1);
  /**
   * 취소·교체된 배정의 늦은 결과 — 되돌리지 않고 담당 기록만 남기며 시도는 건드리지 않는다. 보고한 시도가 이미 실행 중이 아니면
   * 담당의 연결을 그 시도로 옮긴다 — 재배정 뒤 늦게 시작해 후보가 하나라 새 배정에 연결됐던 담당의 종료가 새 배정을 고아로 만들지 않게.
   */
  const lateResult = (reportedAttempt?: TaskAttempt): Decision => {
    if (reportedAttempt && reportedAttempt.status !== "running") agent.dispatchId = reportedAttempt.dispatchId;
    endAgent(agent, failure("dispatch-orphan", "취소·교체된 배정의 늦은 결과"));
    return recorded("현재 배정에 속한 실행 결과가 아닙니다.", "dispatch-orphan");
  };

  // 출처 검증 실패 — 되돌릴 수 없다
  if (prepared.received.sourceError !== undefined) {
    const detail = prepared.received.sourceError;
    endAgent(agent, failure("dispatch-orphan", detail, { kind: SOURCE_FAILURE }));
    orphanLinked(state, agent, linked, detail, SOURCE_FAILURE);
    return recorded(detail, "dispatch-orphan");
  }

  // 형식 오류(JSON·스키마·크기)
  if (prepared.formatError !== undefined) {
    const detail = prepared.formatError;
    const parsed = prepared.parsed;
    const identity = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    // JSON 자체가 깨졌을 때는 시작 시 유일하게 연결된 배정만 교정한다. 병렬 담당을 추측하지 않는다.
    const record = identity ? state.tasks.find(item => item.task.id === identity.taskId) : state.tasks.find(item => item.attempts.at(-1)?.dispatchId === agent.dispatchId);
    const last = record?.attempts.at(-1);
    // 식별 필드가 이미 실행 중이 아닌 시도(취소·고아·교체·종료)를 가리키면 형식과 상관없이 그 배정의 늦은 결과다(아래 식별과 같다)
    const reportedAttempt = identity && typeof identity.dispatchId === "string" ? record?.attempts.find(attempt => attempt.dispatchId === identity.dispatchId) : undefined;
    if (reportedAttempt && reportedAttempt.status !== "running") return lateResult(reportedAttempt);
    if (!record || !last || last.status !== "running" || TASK_AGENTS[record.task.role] !== agent.type || Date.parse(agent.startedAt) < Date.parse(last.at) ||
      (agent.dispatchId && agent.dispatchId !== last.dispatchId) ||
      (identity && (identity.dispatchId !== last.dispatchId || identity.inputHash !== last.inputHash))) {
      if (canReturn && linked) return giveBack(`${guidance("agent-format-error", { detail })} 식별 필드(taskId·dispatchId·inputHash)는 배정 파일 resultShape의 값을 그대로 씁니다.`, "dispatch-orphan");
      const message = "현재 배정에 속한 형식 오류인지 확인할 수 없습니다. 배정을 확인하고 취소 후 다시 실행하세요.";
      endAgent(agent, failure("dispatch-orphan", message));
      orphanLinked(state, agent, linked, message);
      return recorded(message, "dispatch-orphan");
    }
    const changed = inputChanged(work, state, record, last);
    if (changed) {
      last.status = "cancelled";
      last.failure = failure("dispatch-orphan", changed.startsWith("실행 중 입력") ? "실행 중 입력이 바뀌었습니다" : changed);
      endAgent(agent);
      return recorded(changed, "dispatch-orphan");
    }
    if (canReturn) return giveBack(guidance("agent-format-error", { detail }), "agent-format-error");
    endAgent(agent);
    last.error = `결과 형식 오류: ${detail}`;
    last.failure = failure("agent-format-error", detail);
    if (last.correction?.used) {
      last.status = "failed";
      return recorded(`${last.error} — 한 번의 교정을 사용했습니다. 원인을 확인하세요.`, "agent-format-error");
    }
    // 크기 한도를 넘은 결과는 원본을 보존하지 않는다 — 교정 담당에게 넘길 원본이 없으므로(빈 원본은 대조 없이 새 판단을 받게 된다) 교정 대기로 두지 않는다
    if (prepared.received.tooLarge) {
      last.status = "failed";
      return recorded(`${last.error} — 원본을 보존하지 않아 형식 교정 대상이 아닙니다. 결과를 한도 안으로 줄이라는 수정 피드백을 남겨 다시 배정하세요.`, "agent-format-error");
    }
    last.correction = { raw: prepared.received.raw ?? "", error: detail, agentId: agent.id, sessionId: agent.session, used: false };
    last.status = "needs-correction";
    return recorded(`${last.error} — planning advance 또는 planning repair ${record.task.id}로 원본 결과의 형식만 교정하세요.`, "agent-format-error");
  }

  // 식별
  const reported = prepared.reported!;
  const record = state.tasks.find(item => item.task.id === reported.taskId), last = record?.attempts.at(-1);
  if (!record || !last || last.status !== "running" || last.dispatchId !== reported.dispatchId || last.inputHash !== reported.inputHash || (agent.dispatchId && agent.dispatchId !== last.dispatchId) || TASK_AGENTS[record.task.role] !== agent.type || Date.parse(agent.startedAt) < Date.parse(last.at)) {
    const reportedAttempt = record?.attempts.find(attempt => attempt.dispatchId === reported.dispatchId);
    // 보고한 시도가 이미 실행 중이 아니다(취소·고아·교체·종료) — 담당의 시작 연결과 상관없이 그 배정의 늦은 결과다
    const superseded = !!reportedAttempt && reportedAttempt.status !== "running";
    const late = superseded || (agent.dispatchId
      ? !state.tasks.some(item => item.attempts.some(attempt => attempt.dispatchId === agent.dispatchId && attempt.status === "running"))
      : !!reportedAttempt && Date.parse(agent.startedAt) < Date.parse(reportedAttempt.at));
    if (late) return lateResult(reportedAttempt);
    if (canReturn) return giveBack("결과의 식별 필드가 배정과 다릅니다 — 배정 파일 resultShape의 taskId·dispatchId·inputHash를 그대로 써서 같은 결과를 다시 반환하세요.", "dispatch-orphan");
    endAgent(agent, failure("dispatch-orphan", "결과의 식별 필드가 배정과 다릅니다"));
    orphanLinked(state, agent, linked, "결과의 식별 필드가 배정과 다릅니다");
    return recorded("현재 배정에 속한 실행 결과가 아닙니다.", "dispatch-orphan");
  }

  // 실행 중 단계·입력 변경, 선행 조건
  const changed = inputChanged(work, state, record, last);
  const ready = changed ? [] : readyProblems(work, state, record);
  if (changed || ready.length) {
    const reason = changed ?? ready.join("\n");
    last.status = "cancelled";
    last.failure = failure("dispatch-orphan", changed?.startsWith("실행 중 입력") ? "실행 중 입력이 바뀌었습니다" : reason);
    endAgent(agent);
    return recorded(reason, "dispatch-orphan");
  }

  // 내용 검사 — 예외 대신 문제 목록으로 모은다. 기존 단일 문구가 앞에 오도록 기존 검사 순서를 지킨다
  const staged = prepared.staged?.dispatchId === last.dispatchId ? prepared.staged : reported.status === "completed" ? readStaged(work, record, reported) : undefined;
  const problems: string[] = [...(staged?.readErrors ?? [])];
  const result: ResolvedResult = { ...reported, artifacts: reported.status === "completed" ? staged?.artifacts ?? [] : [] };
  const permitted = new Set(inputFiles(work, record.task, state));
  for (const dep of record.task.dependsOn) for (const ref of state.tasks.find(item => item.task.id === dep)?.attempts.at(-1)?.result?.evidence ?? []) permitted.add(ref.path);
  for (const ref of [...result.evidence, ...result.facts.map(fact => fact.source), ...result.findings.map(finding => finding.source)]) {
    if (!permitted.has(ref.path)) { problems.push(`배정 범위 밖 근거입니다: ${ref.path}`); continue; }
    const problem = referenceProblem(root, ref);
    if (problem) problems.push(problem);
  }
  if (result.status === "completed" && (!result.evidence.length || result.questions.length)) problems.push("완료 결과에는 실제 근거가 필요하며 미결 질문이 없어야 합니다.");
  if (result.questions.some(question => question.requirements.some(key => !record.task.requirements.includes(key)))) problems.push("배정 요구 범위 밖 질문입니다.");
  const outputs = reported.artifacts.map(artifact => artifact.path);
  if (result.status === "completed" && JSON.stringify([...outputs].sort()) !== JSON.stringify([...record.task.outputs].sort())) problems.push("배정된 출력 문서 전체를 정확히 한 번 반환해야 합니다.");
  if (result.status !== "completed" && outputs.length) problems.push("미완료 결과는 확정 문서를 쓰지 않습니다.");
  if (last.correction?.used && result.status !== "failed") {
    let original: unknown;
    try { original = JSON.parse(last.correction.raw); } catch { /* 깨진 JSON은 원본과 근거를 사람이 검토할 수 있도록 보존한다. */ }
    if (original && typeof original === "object" && !Array.isArray(original)) {
      const source = original as Record<string, unknown>;
      for (const key of ["status", "summary", "evidence", "facts", "questions", "artifacts", "findings"] as const) {
        const value = ResultSchema.shape[key].safeParse(source[key]);
        const now = key === "artifacts" ? comparable(root, reported.artifacts) : result[key];
        if (value.success && JSON.stringify(key === "artifacts" ? comparable(root, value.data as PlanningResult["artifacts"]) : value.data) !== JSON.stringify(now)) problems.push(`형식 교정에서 유효한 원본 ${key}를 바꿀 수 없습니다. 판단 보완은 새 작업으로 처리하세요.`);
      }
    }
  }
  // 출력 집합이 맞는 completed 결과에만 있다(readStaged) — 같은 게이트 함수를 staging 본문에 먼저 돈 결과다
  const docProblems = staged?.docProblems ?? [];
  problems.push(...docProblems);
  if (problems.length) {
    // 교정 시도의 문서 검사 실패는 되돌리지 않는다 — 교정 담당은 내용을 바꿀 수 없다
    if (canReturn && (!last.correction?.used || problems.some(problem => !docProblems.includes(problem)))) {
      return giveBack(guidance("agent-content-error", { detail: problems.map(problem => `- ${problem}`).join("\n") }), "agent-content-error");
    }
    last.status = "failed";
    last.error = problems.join("\n");
    last.failure = failure("agent-content-error", problems[0]);
    endAgent(agent);
    return recorded(last.error, "agent-content-error");
  }

  // 기록
  if (result.status === "completed") {
    for (const artifact of result.artifacts) writeAtomic(planningPath(root, artifact.path), artifact.content);
    rmSync(planningPath(root, `${workDocsDir(work.active.id)}/.staging/${last.dispatchId}`), { recursive: true, force: true });
    invalidatePlanningCache();
  }
  if (result.questions.length) {
    // 질문 번호는 코드가 매긴다 — 병렬 담당이 각자 Q1 을 내도 겹치지 않고, 결과의 번호도 문서와 같게 고친다.
    // 출처(`[Origin]`)를 적고 상태에도 남겨(questionOrigins — 검증된 출처) 답이 그 작업과 후속 작업만 다시 돌게 한다
    const path = planningPath(root, questionsFile(work.active.id));
    let body = existsSync(path) ? readFileSync(path, "utf8") : "# 질문\n";
    let next = Math.max(0, ...[...body.matchAll(/^## Q(\d+)\b/gm)].map((match) => Number(match[1]))) + 1;
    result.questions = result.questions.map((question) => ({ ...question, id: `Q${next++}` }));
    for (const question of result.questions) {
      body += `\n## ${question.id} · ${record.task.title}\n${question.question}\n[Requirements]: ${question.requirements.join(", ")}\n[Origin]: ${record.task.id}\n[Answer]:\n`;
      state.questionOrigins = { ...state.questionOrigins, [question.id]: record.task.id };
    }
    writeAtomic(path, body);
    invalidatePlanningCache();
  }
  last.status = result.status;
  delete last.error;
  delete last.failure;   // 교정 전 형식 오류 기록은 교정된 결과의 원인이 아니다
  last.result = result;
  last.resultHash = sha(JSON.stringify(result));
  last.outputs = Object.fromEntries(outputs.map(path => [path, fileHash(root, path)]));
  last.agentId = agent.id;
  last.sessionId = agent.session;
  if (result.status === "failed") last.failure = failure("agent-content-error", `담당이 failed로 반환: ${result.summary.slice(0, 200)}`);
  endAgent(agent);
  return { kind: "done" };
}

/**
 * 계획 담당의 시작·완료 관찰. host 가 "claude" 일 때만 같은 담당에게 되돌린다(ReturnToAgent) — 테스트처럼 host 없이 직접 부르면
 * Codex 처럼 즉시 기록한다. 기록한 실패는 PlanningFailure(RecordedFailure)로 던진다.
 */
export function observePlanner(input: ReviewHookInput, projectDir?: string, options: { host?: "claude" | "codex" } = {}): void {
  if (!Object.values(TASK_AGENTS).includes(input.agent_type as never) || !["SubagentStart", "SubagentStop"].includes(input.hook_event_name ?? "")) return;
  const root = findRepoRoot(projectDir ?? input.cwd ?? process.cwd()), work = loadWork(root);
  if (!work?.active.planningVersion) return;
  if (!input.session_id || !input.agent_id) throw new Error("계획 담당의 세션과 에이전트 식별자가 없습니다.");
  withPlanningCache(() => {
    if (input.hook_event_name === "SubagentStart") {
      const writes = mutatePlanning(work, state => {
        const candidates = state.tasks.filter(record => TASK_AGENTS[record.task.role] === input.agent_type && record.attempts.at(-1)?.status === "running");
        if (!candidates.length) return false;
        if (state.agents.some(agent => agent.id === input.agent_id && agent.session === input.session_id && !agent.finished)) throw new Error("중복 시작 이벤트입니다.");
        const dispatchId = candidates.length === 1 ? candidates[0].attempts.at(-1)!.dispatchId : undefined;
        state.agents.push({ id: input.agent_id!, session: input.session_id!, type: input.agent_type!, startedAt: new Date().toISOString(), dispatchId });
        return candidates.some(record => record.task.outputs.length > 0);
      }, { waitMs: TIMING.hookLockWaitMs });
      // staging 폴더는 샌드박스 밖인 이 hook 이 만든다(openStaging) — 담당은 그 안에 배정별 폴더와 문서를 쓴다
      if (writes) openStaging(work);
      return;
    }
    const prepared = prepareStop(input, work);
    if (!prepared) return; // 다른 스킬이 부른 동일 이름 에이전트
    const decision = mutatePlanning(work, state => decideStop(input, work, state, prepared, options.host), { waitMs: TIMING.hookLockWaitMs });
    if (decision.kind === "recorded") throw new PlanningFailure(decision.message, decision.cls);
    if (decision.kind === "return") throw new ReturnToAgent(decision.message, decision.cls);
  });
}
export function runPlanningHook(stdin: string): number {
  // 교차 실행이 띄운 다른 호스트 안에서는 계획 담당을 관찰하지 않는다
  if (crossChild()) return 0;
  let input: ReviewHookInput | undefined;
  try { input = JSON.parse(stdin) as ReviewHookInput; const event = input; withNotation("claude", () => observePlanner(event, process.env.CLAUDE_PROJECT_DIR, { host: "claude" })); return 0; }
  catch (error) {
    const text = `code-agent planning-event: ${error instanceof Error ? error.message : error}\n`;
    process.stderr.write(text);
    const cls = error instanceof ReturnToAgent || error instanceof PlanningFailure ? error.failureClass : "hook-failure";
    const code = subagentExit({ host: "claude", event: input?.hook_event_name, stopHookActive: input?.stop_hook_active === true, failure: cls, recorded: error instanceof RecordedFailure });
    if (code === 2) noteSubagentReturn(input, text);
    return code;
  }
}
