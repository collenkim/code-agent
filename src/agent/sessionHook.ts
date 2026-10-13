import { existsSync } from "fs";
import { join } from "path";

import { canonical, DOCS_SESSION_FILE, findRepoRoot, workDocsDir } from "./layout";
import { loadPlanning, runView, TASK_AGENTS } from "./planningState";
import { loadRequestSession } from "./request";
import { approvalOf, loadWork, type Work } from "./work";
import { aidlcBlock, aidlcWarning } from "./aidlc";
import { crossChild } from "./crossEnv";
import { hookInstallWarning } from "./init";
import { agentName, skill, skillFile, withNotation, type HostName } from "./hostText";
import { sessionStartLease } from "./lease";
import { openConsent } from "./consentState";
import { loadTriage, triageSummary } from "./triageState";

/**
 * SessionStart hook — 대화가 새로 열리거나(startup·resume·fork) 비워지거나(clear) 압축된(compact) 뒤
 * 진행 중인 code-agent 상태를 몇 줄로 붙인다. Claude 는 `session-event` 의 stdout, Codex 는 `codex-event` 의 additionalContext 다.
 *
 * 상태와 문서는 `.code-agent/`·작업 폴더에 있으므로 이전 대화 없이도 정확히 이어갈 수 있다.
 * 압축 요약이 동의 ID·단계를 잃어도 여기서 다시 잡는다. 진행 중인 것이 없으면 아무것도 붙이지 않는다.
 * `source` 는 SessionStart 입력의 값(Claude startup·resume·clear·compact, Codex 는 fork 도)이다. `session` 이 있으면 작업 임대를
 * `host` 의 이 세션으로 넘겨받는다(압축 `compact` 은 빼고 — lease.ts sessionStartLease). 이전 세션이 있었으면 작업 줄 뒤에 한 줄로 알린다.
 * 스킬 이름·경로는 부르는 hook 의 표기(withNotation)로 쓴다.
 */
export function sessionAnchor(repoRoot: string, source?: string, session?: string, host: HostName = "claude"): string {
  const anchor = withReread(repoRoot, progress(repoRoot, source, session, host), source);
  const aidlc = aidlcBlock(repoRoot) ?? aidlcWarning(repoRoot);
  const text = aidlc && anchor ? `${anchor}\n- ${aidlc.replace(/\n/g, "\n  ")}` : anchor;
  // 빠진 hook 은 진행 상태와 무관하게 알린다 — hook 이 없으면 쓰기 판정·동의 관찰이 꺼진다
  let hooks: string | undefined;
  try { hooks = hookInstallWarning(repoRoot); } catch { hooks = undefined; }
  return hooks ? [text, `- ${hooks}`].filter(Boolean).join("\n") : text;
}

/**
 * 실행 중으로 기록된 계획 배정 — 대화가 새로 열리면 이전 대화가 부른 담당의 결과는 이 대화로 돌아오지 않는다.
 * 읽기 실패는 무시한다(이 hook 은 막지 않는다).
 */
function runningPlanning(work: Work, source?: string): string[] {
  if (!work.active.planningVersion) return [];
  try {
    const state = loadPlanning(work), now = Date.now();
    const running = state.tasks.flatMap((record) => {
      const last = record.attempts.at(-1);
      if (last?.status !== "running") return [];
      const view = runView(state, record, last, now);
      return [{ id: record.task.id, text: `${record.task.id}(${agentName(TASK_AGENTS[record.task.role])}, 담당 시작 ${view.observedStart ? "관찰됨" : "미관찰"}, ${view.elapsedMin}분 전)` }];
    });
    if (!running.length) return [];
    const cancel = running.map((item) => `\`code-agent planning cancel ${item.id}\``).join("·");
    return [
      `- 실행 중으로 기록된 계획 배정: ${running.map((item) => item.text).join(", ")}`,
      source === "startup" || source === "resume" || source === "clear" || source === "fork"
        ? `- 이 대화는 방금 시작·재개·비워졌으므로 그 담당의 결과는 이 대화로 돌아오지 않는다. 다른 터미널에서 실행 중이 아니면 ${cancel} 뒤 \`code-agent planning advance\`로 다시 배정한다.`
        : "- 담당 완료를 기다리는 중이 아니면 `code-agent planning advance`의 stale·cancel 안내를 따른다.",
    ];
  } catch {
    return [];
  }
}

/**
 * 압축·비우기 뒤에는 이전 대화가 읽은 ca-answer 절차가 사라진다 — 스킬은 "이 대화에서 아직 읽지 않았거나 압축·비워진 뒤라면 읽는다" 이므로
 * 진행 중인 것이 있을 때 다시 읽으라고 한 줄 붙인다. 작업·접수·문서 세션 밖에서 응답·적용을 기다리는 동의(색인의 열린 창 안 —
 * 도입 뒤 setup, update·model·플러그인 등)만 있어도 붙인다. 경로는 부르는 hook 의 설치 자리다(Claude `.claude/skills`, Codex `.agents/skills`)
 */
function withReread(repoRoot: string, anchor: string, source?: string): string {
  if (source !== "compact" && source !== "clear") return anchor;
  const line = `- 대화가 압축·비워졌다 — 질문·동의 전에 ca-answer 절차(${skillFile("ca-answer")})를 다시 읽는다.`;
  if (anchor) return `${anchor}\n${line}`;
  let open: ReturnType<typeof openConsent>;
  try { open = openConsent(repoRoot); } catch { open = undefined; }
  return open ? [
    "code-agent 진행 상태 (대화 시작·재개·압축·비우기 뒤 자동으로 붙는 요약)",
    `- 응답·적용을 기다리는 동의가 있다(${open.title}). 동의는 준비한 세션에서만 적용된다. 이전 세션의 동의 ID는 적용하지 말고 필요하면 새로 준비한다.`,
    line,
  ].join("\n") : "";
}

/** 작업 임대 넘겨받기 줄 — 이 hook 은 막지 않으므로 실패는 삼킨다 */
function leaseNote(work: Work, host: HostName, session?: string, source?: string): string[] {
  if (!session) return [];
  try {
    const line = sessionStartLease(work, session, source, Date.now(), undefined, host);
    return line ? [line] : [];
  } catch {
    return [];
  }
}

function progress(repoRoot: string, source: string | undefined, sessionId: string | undefined, host: HostName): string {
  const triage = loadTriage(repoRoot);
  if (triage) return triageSummary(triage);
  const work = loadWork(repoRoot);
  if (work) {
    const { active, order } = work;
    return [
      "code-agent 진행 상태 (대화 시작·재개·압축·비우기 뒤 자동으로 붙는 요약)",
      `- 작업 ${order.id} (${order.kind}) · 스테이지 ${active.phase}${active.task ? ` · Task ${active.task}` : ""} · 계획 ${work.plan ? approvalOf(work).status : "미제출"} · 작업 폴더 ${workDocsDir(active.id)}/`,
      ...leaseNote(work, host, sessionId, source),
      ...runningPlanning(work, source),
      `- 이전 대화 내용이 아니라 \`code-agent status\`와 그 스테이지의 스킬로 이어간다. 사용자가 이어가자고 하면 \`${skill("ca-next")}\` 절차를 따른다.`,
      "- 동의는 준비한 세션에서만 적용된다. 이전 세션의 동의 ID는 적용하지 말고 필요하면 새로 준비한다.",
    ].join("\n");
  }
  const session = loadRequestSession(repoRoot);
  if (session) {
    return [
      "code-agent 진행 상태 (대화 시작·재개·압축·비우기 뒤 자동으로 붙는 요약)",
      `- 요구사항 접수 중: ${session.id} (${session.kind}) · 작업 폴더 ${workDocsDir(session.id)}/`,
      `- 사용자가 이어가자고 하면 \`code-agent status\`로 확인하고 \`${skill("ca-request")}\`(또는 \`${skill("ca-next")}\`) 절차로 이어간다.`,
    ].join("\n");
  }
  if (existsSync(join(repoRoot, DOCS_SESSION_FILE))) {
    return [
      "code-agent 진행 상태 (대화 시작·재개·압축·비우기 뒤 자동으로 붙는 요약)",
      `- 공통 문서 준비 세션이 열려 있다. 사용자가 이어가자고 하면 \`${skill("ca-docs")}\` 또는 \`${skill("ca-adopt")}\` 절차로 이어간다.`,
    ].join("\n");
  }
  return "";
}

/** 막지 않는다 — 실패해도 대화 시작을 방해하지 않고 사유만 stderr로 남긴다 */
export function runSessionHook(stdin: string): number {
  // 교차 실행이 띄운 다른 호스트 안에서는 진행 상태를 넣지 않는다
  if (crossChild()) return 0;
  try {
    const input = JSON.parse(stdin || "{}") as { cwd?: string; source?: string; session_id?: string };
    const projectDir = process.env.CLAUDE_PROJECT_DIR;
    const text = withNotation("claude", () => sessionAnchor(findRepoRoot(projectDir ?? input.cwd ?? process.cwd()), typeof input.source === "string" ? input.source : undefined,
      typeof input.session_id === "string" && input.session_id ? input.session_id : undefined));
    if (text) process.stdout.write(`${text}\n`);
  } catch (error) {
    process.stderr.write(`code-agent session-event: ${error instanceof Error ? error.message : error}\n`);
  }
  return 0;
}
