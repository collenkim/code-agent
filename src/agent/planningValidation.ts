import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { workDocsDir } from "./layout";
import { referenceProblem } from "./planningState";
import { parseQuestions } from "./questions";
import type { Work } from "./work";
import { coverageProblems, type DocOverlay } from "./workDocs";
import { hashPlan } from "../core/approval";
import { planFormatFor } from "../core/plan";
import type { BuildPlan } from "../core/types";

/** critic이 본 초안과 실제 승인·구현할 제출본이 같은 계획이어야 한다. */
export function reviewedPlanProblems(work: Work): string[] {
  if (!work.active.planningVersion || !work.plan) return [];
  try {
    const format = planFormatFor(work.order.kind);
    const draft = format.toPlan(format.schema.parse(JSON.parse(readFileSync(join(work.repoRoot, workDocsDir(work.active.id), "plan.json"), "utf8"))));
    if (hashPlan(draft) === hashPlan(work.plan)) return [];
  } catch { /* 아래의 재제출 안내로 통합한다. */ }
  return ["독립 검토한 초안과 제출된 계획이 다릅니다. 관찰된 plan.json을 다시 제출하세요."];
}

/**
 * 신규 흐름의 미결 사항과 실제 근거 검사. 내용의 타당성은 별도 critic이 판단한다.
 * `only` 가 있으면 그 파일 이름만 본다. `overlay` 의 문서(완료 hook 의 staging 본문)는 디스크보다 먼저 읽는다.
 */
export function planningDocumentProblems(work: Work, phase: string, options: { overlay?: DocOverlay; only?: string[] } = {}): string[] {
  if (!work.active.planningVersion) return [];
  const all = ["01-requirements.md", ...(phase !== "analysis" ? ["02-analysis.md"] : []), ...(["design", "plan"].includes(phase) ? ["03-design.md", "04-functional.md"] : []), ...(phase === "plan" ? ["07-test-spec.md"] : [])];
  const files = options.only ? all.filter(file => options.only!.includes(file)) : all;
  const root = work.repoRoot, dir = workDocsDir(work.active.id), problems: string[] = [];
  const questionsPath = join(root, dir, "questions.md");
  const answered = existsSync(questionsPath) ? parseQuestions(readFileSync(questionsPath, "utf8")).filter(question => question.answer).map(question => question.id) : [];
  for (const file of files) {
    const path = `${dir}/${file}`;
    const staged = options.overlay?.get(path);
    if (staged === undefined && !existsSync(join(root, path))) { problems.push(`필수 계획 문서가 없습니다: ${path}`); continue; }
    const text = (staged ?? readFileSync(join(root, path), "utf8")).replace(/<!--[\s\S]*?-->/g, "");
    if (/확인\s*필요|\bTODO\b|\bTBD\b/.test(text)) problems.push(`${path}: 미결 표시를 질문으로 옮겨 답을 받고 문서를 확정하세요.`);
    const references = [...text.matchAll(/([\w가-힣./-]+\.[A-Za-z]\w*):(\d+)/g)];
    for (const match of references) {
      const problem = referenceProblem(root, { path: match[1], line: Number(match[2]) }, options.overlay);
      if (problem) problems.push(`${path}: ${problem}`);
    }
    if (file === "04-functional.md") {
      for (const row of text.split(/\r?\n/)) {
        if (/AC-R\d+-\d+/.test(row) && !row.replace(/AC-R\d+-\d+/g, "").replace(/[\s|:#*`._-]/g, "")) problems.push(`${path}: AC 번호에 구체적인 완료 조건이 없습니다: ${row.trim()}`);
        if (/\bBR-\w+/.test(row) && !/[\w가-힣./-]+\.[A-Za-z]\w*:\d+/.test(row) && !answered.some(id => new RegExp(`\\b${id}\\b`).test(row))) problems.push(`${path}: 업무 규칙에 실제 파일:줄 또는 답변된 Q 번호 근거를 넣으세요: ${row.trim()}`);
      }
    }
  }
  return [...new Set(problems)];
}

/** 계획 스키마 오류 문구 — plan submit 과 완료 hook 이 같은 문구를 쓴다 */
export function formatPlanIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return "계획 형식이 맞지 않습니다:\n" + issues.map((issue) => `  - ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("\n");
}

/** 계획 초안의 자기 완결 검사 — plan submit 과 완료 hook 이 같이 쓴다. 순서·경로·preserve·종류별 규칙은 submit 에만 있다 */
export function planShapeProblems(work: Work, plan: BuildPlan, acceptance: string[], keys: string[]): string[] {
  const problems: string[] = [];
  if (work.active.planningVersion && !plan.tasks) problems.push("신규 계획에는 파일 소유·의존성·AC를 갖춘 tasks가 필요합니다.");
  for (const task of plan.tasks ?? []) if (task.acceptance.some(ac => !acceptance.includes(ac))) problems.push(`${task.id}: 기능 명세에 없는 완료 기준입니다.`);
  problems.push(...coverageProblems(keys, plan.files));
  if (plan.openQuestions.length > 0) problems.push(`남은 질문이 있습니다 — questions.md 로 옮겨 답을 받으세요: ${plan.openQuestions.join(" / ")}`);
  return problems;
}

/** staging 의 plan.json 본문 검사 — 없음·JSON 아님·스키마 오류·자기 완결 검사 */
export function planDraftProblems(work: Work, text: string | undefined, acceptance: string[], keys: string[]): string[] {
  const path = `${workDocsDir(work.active.id)}/plan.json`;
  if (text === undefined) return [`필수 계획 문서가 없습니다: ${path}`];
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (error) { return [`plan.json: JSON 이 아닙니다 — ${error instanceof Error ? error.message : error}`]; }
  const format = planFormatFor(work.order.kind);
  const parsed = format.schema.safeParse(raw);
  if (!parsed.success) return [formatPlanIssues(parsed.error.issues)];
  return planShapeProblems(work, format.toPlan(parsed.data), acceptance, keys);
}
