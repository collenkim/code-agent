import { readFileSync } from "fs";
import { join } from "path";

import { workDocsDir } from "./layout";
import type { PlanningTask } from "./planningState";
import { planDraftProblems, planningDocumentProblems } from "./planningValidation";
import { sourceTrace } from "./sourceTrace";
import type { Work } from "./work";
import { docImpactProblems } from "./knowledgeImpact";
import { analysisProblems, designProblems, functionalProblems, loadRequirements, parseRequirements, testSpecProblems, type DocOverlay } from "./workDocs";

/**
 * 계획 담당 완료 hook 의 결정적 문서 검사 — staging 본문을 정식 문서로 옮기기 전에 그 역할의 `next`·`plan submit` 게이트와
 * **같은 함수**를 먼저 돌린다. 같은 본문·같은 함수라 hook 판정이 최종 게이트보다 엄격해지지 않는다(게이트는 그대로 남는다).
 * plan 역할은 07 검사와 plan.json 의 스키마·tasks·AC·요구 커버리지·남은 질문, 제출 규칙(순서·경로·preserve·종류별 — planRuleProblems)까지다.
 * needs-input·failed 결과와 explore·critic 에는 문서 검사가 없다(호출자가 고른다).
 */
export function stagedDocumentProblems(work: Work, role: PlanningTask["role"], artifacts: { path: string; content: string }[]): string[] {
  const overlay: DocOverlay = new Map(artifacts.map((artifact) => [artifact.path, artifact.content]));
  const { repoRoot: root } = work, id = work.active.id, dir = workDocsDir(id);
  // 선행 01 은 디스크에서 읽는다(이 배정의 출력이 아니다). 형식 오류는 그 단계의 게이트가 이미 막았다
  const keys = (): string[] => { try { return loadRequirements(root, id)?.keys ?? []; } catch { return []; } };
  const problems: string[] = [];
  switch (role) {
    case "analysis": {
      const path = `${dir}/01-requirements.md`, text = overlay.get(path) ?? "";
      try { parseRequirements(text); }
      // 규칙 ID 는 문구 맨 앞에 둔다 — `[REQ-FORMAT] <경로>: …`
      catch (error) { problems.push(...String(error instanceof Error ? error.message : error).split("\n").map((line) => line.replace(/^(\[[A-Z]+-[A-Z]+\] )?/, (tag) => `${tag}${path}: `))); }
      problems.push(...sourceTrace(readFileSync(join(root, work.active.spec), "utf8"), text, path).problems);
      problems.push(...planningDocumentProblems(work, "analysis", { overlay, only: ["01-requirements.md"] }));
      break;
    }
    case "impact": case "synthesis":
      problems.push(...analysisProblems(root, id, keys(), work.order.kind, work.active.spec, overlay), ...docImpactProblems(work, overlay));
      problems.push(...planningDocumentProblems(work, "impact", { overlay, only: ["02-analysis.md"] }));
      break;
    case "design":
      problems.push(...designProblems(root, id, overlay), ...functionalProblems(root, id, keys(), overlay).problems);
      problems.push(...planningDocumentProblems(work, "design", { overlay, only: ["03-design.md", "04-functional.md"] }));
      break;
    case "plan": {
      const acceptance = functionalProblems(root, id, keys()).acceptance;   // 04 는 선행 결과(디스크)
      problems.push(...testSpecProblems(root, id, acceptance, work.manifest, work.order.kind, work.active.spec, overlay).problems);
      problems.push(...planningDocumentProblems(work, "plan", { overlay, only: ["07-test-spec.md"] }));
      problems.push(...planDraftProblems(work, overlay.get(`${dir}/plan.json`), acceptance, keys(), overlay));
      break;
    }
  }
  return [...new Set(problems)];
}
