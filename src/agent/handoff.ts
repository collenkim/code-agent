import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, posix } from "path";

import { writeAtomic } from "../core/atomic";
import { assetText } from "./assets";
import { context } from "./commands";
import { STATE_DIR } from "./layout";
import { isWorkDocKind, skeleton, WORK_SCHEMAS } from "./schemas";
import { loadWork } from "./work";

/**
 * 서브에이전트에게 넘길 긴 자료를 파일로 둔다.
 *
 * 메인이 CLI 출력을 받아 Agent 프롬프트에 다시 쓰면 같은 내용이 메인의 입력과 **출력 토큰**으로 두 번 든다.
 * 파일로 두면 메인은 경로 한 줄만 넘기고, 담당은 그 파일을 직접 읽는다.
 */
export function handoffDir(id: string): string {
  return posix.join(STATE_DIR, "work", id, "handoff");
}

/** 반영 커밋은 `.code-agent/work/<ID>`를 통째로 담는다 — 전달용 사본은 `.gitignore`로 뺀다 */
function writeHandoff(root: string, id: string, name: string, text: string): string {
  const dir = join(root, handoffDir(id));
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
  writeAtomic(join(dir, name), text);
  return posix.join(handoffDir(id), name);
}

/** 역할별 문서 작성 기준 — 단계 스킬 옆의 criteria.md. 설치본과 같은 번들에서 읽는다 */
const CRITERIA: Record<string, string> = {
  analysis: "ca-analyze", explore: "ca-impact", impact: "ca-impact", synthesis: "ca-impact",
  design: "ca-design", plan: "ca-plan", critic: "ca-plan",
};

/** `code-agent context --file` — 전문은 파일로, 메인에게는 첫 줄·담당·경로만 */
export function contextHandoff(root: string): string {
  const text = context(root);
  const work = loadWork(root);
  if (!work) return text; // 접수 중에는 메인이 직접 쓰는 형식이라 그대로 보여 준다
  const { phase } = work.active;
  const file = writeHandoff(root, work.active.id, "context.md", `${text}\n`);
  const agent = phase === "implement" ? (work.stage?.kind === "test" ? "ca-tester" : "ca-implementer")
    : phase === "test" ? "ca-tester" : phase === "review" ? "ca-reviewer" : undefined;
  return [
    text.split("\n")[0],
    ...(agent ? [`- 담당: ${agent}`] : []),
    `- 전문: ${file} — 서브에이전트에게 이 경로를 넘긴다. 메인이 본문을 옮겨 쓰지 않는다.`,
  ].join("\n");
}

interface Assignment {
  agent: string;
  hostAgents: Record<string, string>;
  task: { id: string; role: string; title: string };
  resultShape: { dispatchId: string };
  mode?: string;
}

function assignmentText(item: Assignment & { staging?: Record<string, string> }, stage: string): string {
  const lines = [
    `# 계획 배정 — ${item.task.id} · ${item.task.title}`,
    "",
    "이 파일이 이 배정의 계약이다. 아래 `instructions`와 `resultShape`를 따르고 결과는 그 형태의 JSON 하나로 반환한다.",
    "입력과 선행 결과는 `inputs`·`dependencies`의 파일을 직접 읽는다.",
    "",
    "## 배정",
    "",
    "```json",
    JSON.stringify(item, null, 2),
    "```",
  ];
  if (item.mode === "correction") return `${lines.join("\n")}\n`;
  const criteria = CRITERIA[item.task.role];
  if (criteria) lines.push("", "## 문서 기준", "", assetText(`template/claude/skills/${criteria}/criteria.md`).trim());
  // 이전 흐름에서 담당이 받던 결정론적 자료 — 접수 요구 원문 목록·문서 형식·후보 파일·계획 형식
  lines.push("", "## 단계 context (code-agent context)", "", stage.trim());
  for (const output of Object.keys(item.staging ?? {})) {
    const kind = posix.basename(output, ".md");
    if (isWorkDocKind(kind)) lines.push("", `## 뼈대 — ${output}`, "", "```markdown", skeleton(WORK_SCHEMAS[kind]).trim(), "```");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `planning advance|dispatch|repair` 출력의 배정을 파일로 옮기고 요약으로 바꾼다.
 * 함수(`advancePlanning` 등)는 전체 배정을 그대로 돌려주고, CLI 출력에서만 줄인다.
 */
export function handoffPlanning(root: string, json: string): string {
  const value = JSON.parse(json) as { assignments?: unknown[] } & Partial<Assignment>;
  const work = loadWork(root);
  if (!work) return json;
  let stage: string | undefined;
  const move = (item: unknown): unknown => {
    const assignment = item as Assignment;
    if (!assignment?.resultShape?.dispatchId) return item; // 재사용된 결과는 이미 요약이다
    // 배정은 이미 기록됐다 — 보조 자료를 못 만들어도 배정 파일은 남겨야 담당이 일을 시작할 수 있다
    if (stage === undefined) {
      try { stage = context(root); } catch (error) { stage = `(context를 만들지 못했습니다: ${error instanceof Error ? error.message : error})`; }
    }
    const file = writeHandoff(root, work.active.id, `${assignment.resultShape.dispatchId}.md`, assignmentText(assignment, stage));
    return {
      taskId: assignment.task.id, role: assignment.task.role, title: assignment.task.title,
      agent: assignment.agent, hostAgents: assignment.hostAgents, dispatchId: assignment.resultShape.dispatchId,
      ...(assignment.mode ? { mode: assignment.mode } : {}), assignmentFile: file,
    };
  };
  if (Array.isArray(value.assignments)) return JSON.stringify({ ...value, assignments: value.assignments.map(move) }, null, 2);
  return JSON.stringify(move(value), null, 2);
}
