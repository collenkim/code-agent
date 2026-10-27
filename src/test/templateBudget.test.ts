/**
 * 템플릿 크기 예산(C7 OPT-4) — 스킬·에이전트 문장은 메인·담당 컨텍스트에 그대로 들어간다. 파일별 예산과 흐름 합계(CLAUDE.block·CODEX.block + 흐름 스킬 12)를 넘기면 실패한다. 값은 `node scripts/template-sizes.cjs --suggest`(파일별 현재×1.03, 합계 ×1.02 를 100 단위로 올림)로 정했다.
 * 넘기면 필요할 때만 읽는 보조 문서(reference·criteria·legacy·contract)로 옮기거나, 예산을 올리는 근거를 doc/reviews 에 남기고 고친다.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { hostAssets } from "../agent/hosts";

const ROOT = join(__dirname, "../..");
/** LF 글자 수 예산 — C7 기준(근거: doc/reviews/2026-10-08-procedure-fix-summary.md '템플릿 크기 예산'). 계획 스킬 4개·ca-answer 참고 문서·흐름 합계는 2026-10-13 토큰 최적화로 줄인 크기에 다시 맞췄고, 계획 담당 넷은 요구 분석 본문을 ca-analyze/criteria.md 로 옮긴 크기다(doc/reviews/2026-10-13-result-summary.md '템플릿 예산'). ca-docs·ca-integrate 와 ca-integrate/knowledge.md 는 기능·흐름 지식과 지식 제안 형식을 더한 크기다(같은 기록의 '템플릿 예산'). ca-check·ca-integrate 는 발견 보고·작업 경험 안내 한 줄씩을 더한 크기다(같은 기록의 '템플릿 예산'). ca-test/tc-names.md 는 러너별 TC 이름 표를 ca-tester.md 밖으로 둔 보조 문서다(같은 기록의 '템플릿 예산') */
const BUDGET: Record<string, number> = {
  "template/claude/agents/ca-analyst.md": 900,
  "template/claude/agents/ca-critic.md": 1900,
  "template/claude/agents/ca-explorer.md": 2200,
  "template/claude/agents/ca-implementer.md": 1500,
  "template/claude/agents/ca-reviewer.md": 3800,
  "template/claude/agents/ca-surveyor.md": 1600,
  "template/claude/agents/ca-tester.md": 1900,
  "template/claude/agents/ca-writer.md": 2700,
  "template/claude/skills/ca-adopt/SKILL.md": 8700,
  "template/claude/skills/ca-analyze/criteria.md": 2800,
  "template/claude/skills/ca-analyze/legacy.md": 800,
  "template/claude/skills/ca-analyze/SKILL.md": 3000,
  "template/claude/skills/ca-answer/appendix.md": 5400,
  "template/claude/skills/ca-answer/dashboard.md": 2600,
  "template/claude/skills/ca-answer/reference.md": 4700,
  "template/claude/skills/ca-answer/SKILL.md": 9300,
  "template/claude/skills/ca-check/SKILL.md": 5400,
  "template/claude/skills/ca-design/criteria.md": 1100,
  "template/claude/skills/ca-design/legacy.md": 800,
  "template/claude/skills/ca-design/SKILL.md": 2500,
  "template/claude/skills/ca-docs/SKILL.md": 7300,
  "template/claude/skills/ca-feature/SKILL.md": 2200,
  "template/claude/skills/ca-fix/SKILL.md": 3700,
  "template/claude/skills/ca-fix/triage.md": 3800,
  "template/claude/skills/ca-impact/criteria.md": 1300,
  "template/claude/skills/ca-impact/legacy.md": 1200,
  "template/claude/skills/ca-impact/SKILL.md": 2700,
  "template/claude/skills/ca-implement/SKILL.md": 2800,
  "template/claude/skills/ca-integrate/knowledge.md": 1400,
  "template/claude/skills/ca-integrate/SKILL.md": 3300,
  "template/claude/skills/ca-next/SKILL.md": 7200,
  "template/claude/skills/ca-plan/contract.md": 2700,
  "template/claude/skills/ca-plan/criteria.md": 3500,
  "template/claude/skills/ca-plan/legacy.md": 1000,
  "template/claude/skills/ca-plan/SKILL.md": 4800,
  "template/claude/skills/ca-refactor/SKILL.md": 1700,
  "template/claude/skills/ca-request/SKILL.md": 5700,
  "template/claude/skills/ca-review/SKILL.md": 3600,
  "template/claude/skills/ca-status/SKILL.md": 2100,
  "template/claude/skills/ca-test/SKILL.md": 3000,
  "template/claude/skills/ca-test/tc-names.md": 1500,
  "template/CLAUDE.block.md": 1700,
  "template/codex/ca-answer.md": 5600,
  "template/CODEX.block.md": 2200,
};
/** Claude 흐름 합계(CLAUDE.block + 흐름 스킬 12) */
const FLOW_BUDGET = 54000;
/** Codex 흐름 합계(CODEX.block + .agents 흐름 스킬 12 — codexText 변환본, ca-answer 는 template/codex 대체본) */
const CODEX_FLOW_BUDGET = 50500;

const FLOW_SKILLS = ["ca-request", "ca-answer", "ca-next", "ca-analyze", "ca-impact", "ca-design", "ca-plan", "ca-implement", "ca-check", "ca-test", "ca-review", "ca-integrate"];
const FLOW = ["template/CLAUDE.block.md", ...FLOW_SKILLS.map((name) => `template/claude/skills/${name}/SKILL.md`)];
const ADVICE = "필요할 때만 읽는 보조 문서(reference·criteria·legacy·contract)로 옮기거나, 예산을 올리려면 근거를 doc/reviews 에 남기고 BUDGET 을 고치세요(node scripts/template-sizes.cjs --suggest)";
const lf = (text: string): number => text.replace(/\r\n/g, "\n").length;
const size = (path: string): number => lf(readFileSync(join(ROOT, path), "utf8"));
function templates(dir = "template"): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? templates(`${dir}/${entry.name}`) : entry.name.endsWith(".md") ? [`${dir}/${entry.name}`] : []);
}

test("템플릿마다 크기 예산이 있고 넘지 않는다", () => {
  const files = templates();
  for (const path of files) {
    const budget = BUDGET[path];
    assert.ok(budget !== undefined, `템플릿 ${path} 의 크기 예산이 없습니다 — templateBudget.test.ts BUDGET 에 더하세요`);
    const n = size(path);
    assert.ok(n <= budget, `템플릿 크기 예산 초과: ${path} ${n}자 > ${budget}자 — ${ADVICE}`);
  }
  for (const path of Object.keys(BUDGET)) assert.ok(files.includes(path), `없는 템플릿의 예산이 남아 있습니다: ${path}`);
});

test("흐름 합계(Claude·Codex)가 예산을 넘지 않는다", () => {
  const claude = FLOW.reduce((sum, path) => sum + size(path), 0);
  assert.ok(claude <= FLOW_BUDGET, `템플릿 크기 예산 초과: Claude 흐름 합계 ${claude}자 > ${FLOW_BUDGET}자 — ${ADVICE}`);
  const assets = hostAssets("codex");
  const codex = FLOW_SKILLS.reduce((sum, name) => sum + lf(assets.get(`.agents/skills/${name}/SKILL.md`) ?? ""), 0) + size("template/CODEX.block.md");
  assert.ok(codex <= CODEX_FLOW_BUDGET, `템플릿 크기 예산 초과: Codex 흐름 합계 ${codex}자 > ${CODEX_FLOW_BUDGET}자 — ${ADVICE}`);
});
