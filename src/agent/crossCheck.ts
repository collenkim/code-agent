import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, posix } from "path";
import { z } from "zod";

import { writeAtomic } from "../core/atomic";
import { hashManifest, hashPlan } from "../core/approval";
import { assetText } from "./assets";
import { stripBlock, upsertBlock } from "./blocks";
import { requireValidatable } from "./commands";
import { treeHashNow } from "./evidence";
import { contextHandoff, handoffDir } from "./handoff";
import { hostAssets, hostCommand, type Host } from "./hosts";
import { questionsFile, workDocsDir } from "./layout";
import { codexModelOf } from "./modelPolicy";
import { modelOf } from "./models";
import { mutatePlanning, planningWork } from "./planning";
import { inputFiles, loadPlanning, referenceProblem, taskCurrent } from "./planningState";
import { CROSS_HEADING, crossRequired, loadReview, normalizeFindings, renderRoundsBlock, REVIEW_BLOCK, reviewDocFile, saveReview } from "./review";
import { Stop } from "./stop";

/**
 * 교차 검증 — 두 호스트(Claude·Codex)가 설치된 프로젝트에서 계획 반박 검토와 코드 리뷰를
 * **다른 호스트의 모델이 한 번 더** 독립적으로 본다. CLI 가 그 호스트를 읽기 전용·비대화형으로 직접 실행하고
 * 결과를 기록하므로 실행 출처는 CLI 가 보증한다. 어느 쪽이든 차단 지적이 남으면 게이트가 막고 사람이 판단한다.
 */
type Agent = "ca-reviewer" | "ca-critic";

export function parseHostArg(value: string | undefined): Host {
  if (value === "claude" || value === "codex") return value;
  throw new Stop("교차 검증을 맡을 호스트를 --by claude 또는 --by codex 로 지정하세요 — 지금 작업 중인 호스트가 아닌 쪽입니다.");
}

/**
 * 다른 호스트를 실행할 수 없다 — 실행 파일 없음·로그인 만료·사용 한도·장애·시간 초과. 교차 검증은 두 호스트를 모두 쓸 수
 * 있을 때만 돌므로, 이때는 그 지점의 교차 검증을 중지로 기록하고 작업은 진행한다. 호스트가 돌았는데 결과 형식이 틀린 것은
 * 여기에 들지 않는다(다시 실행한다).
 */
class HostUnavailable extends Stop {}

function unavailable(host: Host, reason: string): string {
  return `${host} 교차 검증 중지 — 다른 호스트를 실행할 수 없습니다: ${reason}. 이 지점은 교차 검증 없이 진행합니다. ` +
    "두 호스트를 모두 쓸 수 있게 되면(설치·로그인·사용 한도) 다음 지점부터 다시 돕니다.";
}

/** Codex 역할 정의(developer_instructions) — `.codex/agents/<역할>.toml` 과 같은 번들에서 읽는다 */
function codexInstructions(root: string, agent: Agent): string {
  const toml = hostAssets("codex", root).get(`.codex/agents/${agent}.toml`) ?? "";
  const raw = /^developer_instructions = (".*")$/m.exec(toml)?.[1];
  return raw ? JSON.parse(raw) as string : "";
}

function timeoutMs(): number {
  const minutes = Number(process.env.CODE_AGENT_CROSS_TIMEOUT_MIN ?? 20);
  return (minutes > 0 ? minutes : 20) * 60_000;
}

/** 다른 호스트를 읽기 전용으로 한 번 실행하고 마지막 응답을 돌려준다 */
export function runOtherHost(root: string, host: Host, agent: Agent, prompt: string): { text: string; model: string } {
  const role = agent === "ca-reviewer" ? "reviewer" : "critic";
  const resolved = hostCommand(host);
  if (typeof resolved === "string") throw new HostUnavailable(resolved);
  const { file, prefix } = resolved;
  const env = { ...process.env };
  delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.NODE_TEST_CONTEXT;
  let args: string[], model: string, outFile: string | undefined, scratch: string | undefined;
  if (host === "claude") {
    model = modelOf(root, role);
    args = ["-p", prompt, "--agent", agent, "--model", model, "--output-format", "json", "--setting-sources", "project",
      "--permission-prompts", "none", "--allowedTools", "Read,Grep,Glob"];
  } else {
    const config = codexModelOf(root, role);
    model = `${config.model}/${config.reasoning}`;
    scratch = mkdtempSync(join(tmpdir(), "code-agent-cross-"));
    outFile = join(scratch, "last-message.txt");
    args = ["exec", "-s", "read-only", "-C", root, "--ephemeral", "-m", config.model, "-c", `model_reasoning_effort="${config.reasoning}"`,
      "-o", outFile, `${codexInstructions(root, agent)}\n\n---\n\n${prompt}`];
  }
  try {
    const result = spawnSync(file, [...prefix, ...args], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: timeoutMs(), maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw new HostUnavailable(`${result.error.message}${/ETIMEDOUT/.test(result.error.message) ? ` (제한 ${timeoutMs() / 60_000}분 — CODE_AGENT_CROSS_TIMEOUT_MIN)` : ""}`);
    if (result.status !== 0) throw new HostUnavailable(`종료 코드 ${result.status} — ${(result.stderr || result.stdout || "").trim().slice(-400)}`);
    if (host === "claude") {
      let parsed: { result?: unknown; is_error?: boolean };
      try { parsed = JSON.parse(result.stdout); } catch { throw new HostUnavailable("claude 출력이 JSON 이 아닙니다"); }
      if (parsed.is_error || typeof parsed.result !== "string") throw new HostUnavailable(`결과 없이 끝났습니다 — ${String(parsed.result ?? "").slice(0, 300)}`);
      return { text: parsed.result, model };
    }
    if (!outFile || !existsSync(outFile)) throw new HostUnavailable("마지막 응답을 남기지 않았습니다");
    return { text: readFileSync(outFile, "utf8"), model };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

function unfence(text: string): string {
  return text.trim().replace(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/, "$1").trim();
}

// ---- 코드 리뷰 ----

/** ⑨ 의 `## 교차 지적` 절을 기록으로 다시 쓴다 — 결과 표·`- 없음`·중지 사유 */
function writeCrossSection(root: string, id: string, log: NonNullable<ReturnType<typeof loadReview>>, host: Host, body: string): void {
  const path = join(root, reviewDocFile(id));
  const text = stripBlock(readFileSync(path, "utf-8"), REVIEW_BLOCK);
  const section = `## ${CROSS_HEADING}\n\n<!-- ${host} 교차 리뷰 결과를 code-agent review cross 가 기록한다. 손으로 고치면 게이트가 거부한다. -->\n\n${body}\n\n`;
  const rendered = new RegExp(`^## ${CROSS_HEADING}\\s*$`, "m").test(text)
    ? text.replace(new RegExp(`^## ${CROSS_HEADING}[^\\S\\n]*\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, "m"), section)
    : `${text.replace(/\s*$/, "")}\n\n${section}`;
  writeAtomic(path, upsertBlock(rendered, REVIEW_BLOCK, renderRoundsBlock(log)));
}

const REVIEW_DOCS = ["01-requirements.md", "02-analysis.md", "03-design.md", "04-functional.md", "07-test-spec.md", "08-validation.md"];

export function crossReview(root: string, by: string | undefined): string {
  const host = parseHostArg(by);
  if (!crossRequired(root)) throw new Stop("두 호스트가 함께 설치된 프로젝트에서만 교차 리뷰를 합니다 — code-agent init --host both");
  const work = requireValidatable(root, "review");
  const log = loadReview(root, work.active.id, work.active.target);
  const last = log?.rounds.at(-1);
  if (!log || !last) throw new Stop("code-agent review 로 회차를 먼저 여세요.");
  if (last.treeHash !== treeHashNow(work) || last.planHash !== hashPlan(work.plan!) || last.manifestHash !== hashManifest(work.manifest)) {
    throw new Stop("회차를 연 뒤 코드·계획·경계가 바뀌었습니다 — check · test 뒤 새 회차를 여세요.");
  }
  const context = /전문: (\S+)/.exec(contextHandoff(root))?.[1] ?? posix.join(handoffDir(work.active.id), "context.md");
  const previous = log.rounds.at(-2)?.cross?.result;
  const docs = [work.active.spec, ...REVIEW_DOCS.map((file) => `${workDocsDir(work.active.id)}/${file}`)];
  const prompt = [
    `code-agent 교차 리뷰 — 작업 ${work.active.id} ${last.round}회차. 다른 호스트의 독립 리뷰와 별개로 같은 코드를 독립적으로 반박 검토한다. 파일은 고치지 않는다.`,
    `먼저 ${context} 를 읽는다(계획 파일·요구 항목·검증 증거 요약·로그 경로). 이어서 ${docs.join(", ")} 와 그 안에서 가리키는 컨벤션·테스트 전략·품질 기준, 계획 파일과 관련 호출자를 읽는다.`,
    ...(previous ? ["직전 회차의 교차 지적이다 — 고쳐졌는지 다시 확인해 상태를 `해결` 또는 `열림` 으로 갱신하고 같은 id 를 유지한다:", previous] : []),
    "결과는 아래 형식의 표 하나만 출력한다(설명문·코드 펜스 없이). id 는 X1, X2… 계획 파일 칸은 저장소 기준 경로 그대로, 범위는 `계획 안`·`계획 밖`, 상태는 `열림`·`해결`, 지적 칸에 근거(path:line · R/AC · 증거)를 적는다. 취향·가정은 지적이 아니다.",
    "| id | 계획 파일 | 범위 | 상태 | 지적 |", "|---|---|---|---|---|", "지적이 없으면 `- 없음` 한 줄만 출력한다.",
    "질문·설명문은 확정 지시서와 같은 언어로 쓴다.",
  ].join("\n");
  const startedAt = new Date().toISOString();
  let outcome: { text: string; model: string };
  try {
    outcome = runOtherHost(root, host, "ca-reviewer", prompt);
  } catch (error) {
    if (error instanceof HostUnavailable) {
      // 이 회차는 교차 리뷰 없이 진행한다 — 중지 사유를 회차 기록과 ⑨ 에 남긴다
      last.cross = { host, model: "", startedAt, unavailable: error.message.slice(0, 500) };
      saveReview(root, log);
      writeCrossSection(root, work.active.id, log, host, `- 교차 검증 중지 — ${host} 를 실행할 수 없습니다: ${error.message.replace(/\s+/g, " ").slice(0, 300)}`);
      return unavailable(host, error.message);
    }
    last.cross = { host, model: "", startedAt, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    saveReview(root, log);
    throw error;
  }
  const body = normalizeFindings(unfence(outcome.text).replace(new RegExp(`^##\\s*${CROSS_HEADING}\\s*\\n`), ""));
  const rows = body.split("\n");
  if (body !== "- 없음" && !(rows.some((line) => /^\|\s*X\d+\s*\|/.test(line)) && rows.every((line) => /^\|.*\|$/.test(line)))) {
    last.cross = { host, model: outcome.model, startedAt, error: "결과가 지적 표 또는 '- 없음' 이 아닙니다" };
    saveReview(root, log);
    throw new Stop(`${host} 교차 리뷰 결과가 지적 표 또는 '- 없음' 이 아닙니다 — 다시 실행하세요.\n${outcome.text.slice(0, 600)}`);
  }
  last.cross = { host, model: outcome.model, startedAt, completedAt: new Date().toISOString(), result: body };
  saveReview(root, log);
  writeCrossSection(root, work.active.id, log, host, body);
  const open = rows.filter((line) => /^\|\s*X\d+\s*\|/.test(line) && /\|\s*열림\s*\|/.test(line)).length;
  return `${host}(${outcome.model}) 교차 리뷰를 ${last.round}회차에 기록했습니다 — ${body === "- 없음" ? "지적 없음" : `열린 지적 ${open}개`}. ${reviewDocFile(work.active.id)} 의 ## ${CROSS_HEADING}`;
}

// ---- 계획 반박 검토 ----

const CrossCriticSchema = z.object({
  status: z.enum(["completed", "needs-input", "failed"]),
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(z.object({ id: z.string().min(1), severity: z.enum(["blocking", "advisory"]), detail: z.string().min(1),
    source: z.object({ path: z.string(), line: z.number().int().positive() }) })).max(100).default([]),
  questions: z.array(z.object({ id: z.string().min(1), question: z.string().min(1), requirements: z.array(z.string()).default([]) })).max(20).default([]),
});

export function crossCritic(root: string, by: string | undefined): string {
  const host = parseHostArg(by);
  if (!crossRequired(root)) throw new Stop("두 호스트가 함께 설치된 프로젝트에서만 교차 검토를 합니다 — code-agent init --host both");
  const work = planningWork(root);
  if (work.active.phase !== "plan") throw new Stop("계획 단계에서만 교차 검토를 합니다.");
  const state = loadPlanning(work);
  const critic = state.tasks.find((record) => record.task.role === "critic");
  const last = critic?.attempts.at(-1);
  if (!critic || !last || last.status !== "completed" || !taskCurrent(work, state, critic)) throw new Stop("관찰된 critic 완료 결과가 먼저 필요합니다 — planning advance 로 critic 을 배정하세요.");
  const inputs = inputFiles(work, critic.task, state);
  const brief = [
    `# 교차 계획 검토 — ${work.active.id}`, "",
    "다른 호스트의 critic 과 별개로 같은 계획을 독립적으로 반박 검토한다. 파일은 고치지 않는다. 아래 입력만 근거로 읽는다.", "",
    "## 입력", ...inputs.map((file) => `- ${file}`), "",
    "## 문서 기준", "", assetText("template/claude/skills/ca-plan/criteria.md").trim(), "",
    "## 결과", "", "JSON 하나만 출력한다(설명문·코드 펜스 없이):", "",
    JSON.stringify({ status: "completed | needs-input | failed", summary: "판단 요약", findings: [{ id: "C1", severity: "blocking | advisory", detail: "문제와 영향", source: { path: inputs[0], line: 1 } }], questions: [{ id: "Q1", question: "사람이 정할 것", requirements: ["R1"] }] }, null, 2),
    "", "근거 경로는 저장소 루트 기준 전체 상대 경로, 줄은 실제로 읽은 줄이다. 질문·요약·설명은 확정 지시서와 같은 언어로 쓴다.",
  ].join("\n");
  const file = posix.join(handoffDir(work.active.id), "cross-critic.md");
  writeAtomic(join(root, file), `${brief}\n`);
  let outcome: { text: string; model: string };
  try {
    outcome = runOtherHost(root, host, "ca-critic", `${file} 를 읽고 그 지시대로 교차 계획 검토 결과 JSON 하나만 반환하라.`);
  } catch (error) {
    if (!(error instanceof HostUnavailable)) throw error;
    // 이 critic 결과는 교차 검토 없이 진행한다 — 중지 사유를 계획 기록에 남긴다
    mutatePlanning(work, (current) => {
      current.cross = { host, model: "", at: new Date().toISOString(), criticDispatchId: last.dispatchId,
        status: "unavailable", summary: error.message.slice(0, 500), findings: [], questions: 0 };
    });
    return unavailable(host, error.message);
  }
  let parsed: z.infer<typeof CrossCriticSchema>;
  try { parsed = CrossCriticSchema.parse(JSON.parse(unfence(outcome.text))); }
  catch (error) { throw new Stop(`${host} 교차 검토 결과 형식이 맞지 않습니다 — 다시 실행하세요: ${error instanceof Error ? error.message.slice(0, 400) : error}`); }
  const permitted = new Set(inputs);
  const bad = parsed.findings.map((finding) => finding.source).find((ref) => !permitted.has(ref.path) || referenceProblem(root, ref));
  if (bad) throw new Stop(`${host} 교차 검토의 근거가 입력 밖이거나 없는 줄입니다: ${bad.path}:${bad.line} — 다시 실행하세요.`);
  // 질문 번호는 코드가 매긴다 — 담당이 정한 번호는 기존 질문과 겹칠 수 있다
  const questionPath = join(root, questionsFile(work.active.id));
  let body = existsSync(questionPath) ? readFileSync(questionPath, "utf8") : "# 질문\n";
  let next = Math.max(0, ...[...body.matchAll(/^## Q(\d+)\b/gm)].map((match) => Number(match[1]))) + 1;
  for (const question of parsed.questions) {
    body += `\n## Q${next++} · 교차 계획 검토(${host})\n${question.question}\n[Requirements]: ${question.requirements.join(", ")}\n[Answer]:\n`;
  }
  if (parsed.questions.length) writeAtomic(questionPath, body);
  mutatePlanning(work, (current) => {
    current.cross = { host, model: outcome.model, at: new Date().toISOString(), criticDispatchId: last.dispatchId,
      status: parsed.status, summary: parsed.summary, findings: parsed.findings, questions: parsed.questions.length };
  });
  const blocking = parsed.findings.filter((finding) => finding.severity === "blocking").length;
  return `${host}(${outcome.model}) 교차 계획 검토: ${parsed.status} · 차단 지적 ${blocking}개 · 질문 ${parsed.questions.length}개\n${parsed.summary}` +
    (parsed.findings.length ? `\n${parsed.findings.map((finding) => `- ${finding.id} [${finding.severity}] ${finding.detail} (${finding.source.path}:${finding.source.line})`).join("\n")}` : "");
}
