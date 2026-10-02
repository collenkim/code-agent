import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { workDocsDir } from "./layout";
import { referenceProblem } from "./planningState";
import { parseQuestions } from "./questions";
import type { Work } from "./work";
import { hashPlan } from "../core/approval";
import { planFormatFor } from "../core/plan";

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

/** 신규 흐름의 미결 사항과 실제 근거 검사. 내용의 타당성은 별도 critic이 판단한다. */
export function planningDocumentProblems(work: Work, phase: string): string[] {
  if (!work.active.planningVersion) return [];
  const files = ["01-requirements.md", ...(phase !== "analysis" ? ["02-analysis.md"] : []), ...(["design", "plan"].includes(phase) ? ["03-design.md", "04-functional.md"] : []), ...(phase === "plan" ? ["07-test-spec.md"] : [])];
  const root = work.repoRoot, dir = workDocsDir(work.active.id), problems: string[] = [];
  const questionsPath = join(root, dir, "questions.md");
  const answered = existsSync(questionsPath) ? parseQuestions(readFileSync(questionsPath, "utf8")).filter(question => question.answer).map(question => question.id) : [];
  for (const file of files) {
    const path = `${dir}/${file}`;
    if (!existsSync(join(root, path))) { problems.push(`필수 계획 문서가 없습니다: ${path}`); continue; }
    const text = readFileSync(join(root, path), "utf8").replace(/<!--[\s\S]*?-->/g, "");
    if (/확인\s*필요|\bTODO\b|\bTBD\b/.test(text)) problems.push(`${path}: 미결 표시를 질문으로 옮겨 답을 받고 문서를 확정하세요.`);
    const references = [...text.matchAll(/([\w가-힣./-]+\.[A-Za-z]\w*):(\d+)/g)];
    for (const match of references) {
      const problem = referenceProblem(root, { path: match[1], line: Number(match[2]) });
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
