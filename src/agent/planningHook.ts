import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, dirname, relative, resolve, sep } from "path";
import { writeAtomic } from "../core/atomic";
import { sha } from "./docs";
import { findRepoRoot, questionsFile } from "./layout";
import { mutatePlanning, requireRolePhase } from "./planning";
import { fileHash, inputFiles, planningPath, readyProblems, referenceProblem, ResultSchema, TASK_AGENTS, taskHash } from "./planningState";
import type { ReviewHookInput } from "./reviewHook";
import { loadWork } from "./work";

/** hook의 세션별 실제 하위 transcript만 읽는다. 저장소 안의 임의 JSON은 실행 증거가 아니다. */
function handback(input: ReviewHookInput, root: string, startedAt: string): string {
  let result = input.last_assistant_message ?? "";
  if (input.agent_transcript_path) {
    if (!input.transcript_path || !/^[\w-]+$/.test(input.agent_id ?? "")) throw new Error("계획 실행 기록 경로가 유효하지 않습니다.");
    const expected = resolve(dirname(input.transcript_path), basename(input.transcript_path, ".jsonl"), "subagents", `agent-${input.agent_id}.jsonl`);
    const actual = resolve(input.agent_transcript_path);
    if (actual !== expected || !existsSync(actual)) throw new Error("해당 세션의 하위 에이전트 기록이 아닙니다.");
    const inside = relative(realpathSync(root), realpathSync(actual));
    if (!inside.startsWith(`..${sep}`) && inside !== ".." && !/^[A-Za-z]:/.test(inside)) throw new Error("저장소 파일은 실행 관찰 기록으로 사용할 수 없습니다.");
    for (const line of readFileSync(actual, "utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      if (!(Date.parse(entry.timestamp) >= Date.parse(startedAt)) || entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
      for (const block of entry.message.content) if (block.type === "tool_use" && block.name === "SubagentHandback" && typeof block.input?.message === "string") result = block.input.message;
    }
  }
  if (result.length > 500_000) throw new Error("계획 결과가 크기 한도를 넘었습니다.");
  return result.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
}
export function observePlanner(input: ReviewHookInput, projectDir?: string): void {
  if (!Object.values(TASK_AGENTS).includes(input.agent_type as never) || !["SubagentStart", "SubagentStop"].includes(input.hook_event_name ?? "")) return;
  const root = findRepoRoot(projectDir ?? input.cwd ?? process.cwd()), work = loadWork(root);
  if (!work?.active.planningVersion) return;
  if (!input.session_id || !input.agent_id) throw new Error("계획 담당의 세션과 에이전트 식별자가 없습니다.");
  const error = mutatePlanning(work, state => {
    if (input.hook_event_name === "SubagentStart") {
      const candidates = state.tasks.filter(record => TASK_AGENTS[record.task.role] === input.agent_type && record.attempts.at(-1)?.status === "running");
      if (!candidates.length) return;
      if (state.agents.some(agent => agent.id === input.agent_id && agent.session === input.session_id && !agent.finished)) throw new Error("중복 시작 이벤트입니다.");
      const dispatchId = candidates.length === 1 ? candidates[0].attempts.at(-1)!.dispatchId : undefined;
      state.agents.push({ id: input.agent_id!, session: input.session_id!, type: input.agent_type!, startedAt: new Date().toISOString(), dispatchId });
      return;
    }
    const agent = [...state.agents].reverse().find(agent => agent.id === input.agent_id && agent.session === input.session_id);
    if (!agent) return; // 다른 스킬이 부른 동일 이름 에이전트
    if (agent.finished) throw new Error("이미 처리한 완료 이벤트입니다.");
    // 관찰 출처 검증 실패는 모델 출력 형식 오류와 구분한다.
    const raw = handback(input, root, agent.startedAt);
    let parsed: unknown, parseError: unknown;
    try { parsed = JSON.parse(raw); } catch (error) { parseError = error; }
    const identity = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    const schema = ResultSchema.safeParse(parsed);
    if (!schema.success) {
      // JSON 자체가 깨졌을 때는 시작 시 유일하게 연결된 배정만 교정한다. 병렬 담당을 추측하지 않는다.
      const record = identity ? state.tasks.find(item => item.task.id === identity.taskId) : state.tasks.find(item => item.attempts.at(-1)?.dispatchId === agent.dispatchId);
      const last = record?.attempts.at(-1);
      if (!record || !last || last.status !== "running" || TASK_AGENTS[record.task.role] !== agent.type || Date.parse(agent.startedAt) < Date.parse(last.at) ||
        (agent.dispatchId && agent.dispatchId !== last.dispatchId) ||
        (identity && (identity.dispatchId !== last.dispatchId || identity.inputHash !== last.inputHash))) throw new Error("현재 배정에 속한 형식 오류인지 확인할 수 없습니다. 배정을 확인하고 취소 후 다시 실행하세요.");
      requireRolePhase(work, record.task.role);
      if (taskHash(work, state, record.task) !== last.inputHash) throw new Error("실행 중 입력이 바뀌었습니다. 새 입력으로 다시 배정하세요.");
      const detail = (parseError instanceof Error ? parseError.message : schema.error.message).slice(0, 4000);
      agent.finished = true;
      last.error = `결과 형식 오류: ${detail}`;
      if (last.correction?.used) {
        last.status = "failed";
        return `${last.error} — 한 번의 교정을 사용했습니다. 원인을 확인하세요.`;
      }
      last.correction = { raw, error: detail, agentId: agent.id, sessionId: agent.session, used: false };
      last.status = "needs-correction";
      return `${last.error} — planning advance 또는 planning repair ${record.task.id}로 원본 결과의 형식만 교정하세요.`;
    }
    const result = schema.data;
    const record = state.tasks.find(record => record.task.id === result.taskId), last = record?.attempts.at(-1);
    if (!record || !last || last.status !== "running" || last.dispatchId !== result.dispatchId || last.inputHash !== result.inputHash || (agent.dispatchId && agent.dispatchId !== last.dispatchId) || TASK_AGENTS[record.task.role] !== agent.type || Date.parse(agent.startedAt) < Date.parse(last.at)) throw new Error("현재 배정에 속한 실행 결과가 아닙니다.");
    agent.finished = true;
    try {
      requireRolePhase(work, record.task.role);
      if (taskHash(work, state, record.task) !== last.inputHash) throw new Error("실행 중 입력이 바뀌었습니다. 새 입력으로 다시 배정하세요.");
      const problems = readyProblems(work, state, record);
      if (problems.length) throw new Error(problems.join("\n"));
      const permitted = new Set(inputFiles(work, record.task));
      for (const dep of record.task.dependsOn) for (const ref of state.tasks.find(item => item.task.id === dep)?.attempts.at(-1)?.result?.evidence ?? []) permitted.add(ref.path);
      const references = [...result.evidence, ...result.facts.map(fact => fact.source), ...result.findings.map(finding => finding.source)];
      for (const ref of references) {
        if (!permitted.has(ref.path)) throw new Error(`배정 범위 밖 근거입니다: ${ref.path}`);
        const problem = referenceProblem(root, ref);
        if (problem) throw new Error(problem);
      }
      if (result.status === "completed" && (!result.evidence.length || result.questions.length)) throw new Error("완료 결과에는 실제 근거가 필요하며 미결 질문이 없어야 합니다.");
      if (result.questions.some(question => question.requirements.some(key => !record.task.requirements.includes(key)))) throw new Error("배정 요구 범위 밖 질문입니다.");
      if (new Set(result.questions.map(question => question.id)).size !== result.questions.length) throw new Error("중복 질문 번호입니다.");
      const outputs = result.artifacts.map(artifact => artifact.path);
      if (result.status === "completed" && JSON.stringify([...outputs].sort()) !== JSON.stringify([...record.task.outputs].sort())) throw new Error("배정된 출력 문서 전체를 정확히 한 번 반환해야 합니다.");
      if (result.status !== "completed" && outputs.length) throw new Error("미완료 결과는 확정 문서를 쓰지 않습니다.");
      if (last.correction?.used && result.status !== "failed") {
        let original: unknown;
        try { original = JSON.parse(last.correction.raw); } catch { /* 깨진 JSON은 원본과 근거를 사람이 검토할 수 있도록 보존한다. */ }
        if (original && typeof original === "object" && !Array.isArray(original)) {
          const source = original as Record<string, unknown>;
          for (const key of ["status", "summary", "evidence", "facts", "questions", "artifacts", "findings"] as const) {
            const value = ResultSchema.shape[key].safeParse(source[key]);
            if (value.success && JSON.stringify(value.data) !== JSON.stringify(result[key])) throw new Error(`형식 교정에서 유효한 원본 ${key}를 바꿀 수 없습니다. 판단 보완은 새 작업으로 처리하세요.`);
          }
        }
      }
      if (result.status === "completed") for (const artifact of result.artifacts) writeAtomic(planningPath(root, artifact.path), artifact.content);
      if (result.questions.length) {
        const path = planningPath(root, questionsFile(work.active.id));
        let body = existsSync(path) ? readFileSync(path, "utf8") : "# 질문\n";
        for (const question of result.questions) {
          if (new RegExp(`^## ${question.id}\\b`, "m").test(body)) throw new Error(`기존 질문 번호와 겹칩니다: ${question.id}`);
          body += `\n## ${question.id} · ${record.task.title}\n${question.question}\n[Requirements]: ${question.requirements.join(", ")}\n[Answer]:\n`;
        }
        writeAtomic(path, body);
      }
      last.status = result.status;
      delete last.error;
      last.result = result;
      last.resultHash = sha(JSON.stringify(result));
      last.outputs = Object.fromEntries(outputs.map(path => [path, fileHash(root, path)]));
      last.agentId = agent.id;
      last.sessionId = agent.session;
    } catch (error) {
      last.status = "failed";
      last.error = error instanceof Error ? error.message : String(error);
      return last.error;
    }
  });
  if (error) throw new Error(error);
}
export function runPlanningHook(stdin: string): number {
  try { observePlanner(JSON.parse(stdin), process.env.CLAUDE_PROJECT_DIR); return 0; }
  catch (error) { process.stderr.write(`code-agent planning-event: ${error instanceof Error ? error.message : error}\n`); return 2; }
}
