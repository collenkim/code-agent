import { listReferenceTree } from "./exemplar";
import { previewStagePrompt } from "./generate";
import { selectStages } from "./manifest";
import { previewPlanPrompt } from "./plan";
import { withResolvedInputs } from "./run";
import type { BuildContext, BuildPlan, PromptPreview } from "./types";

/**
 * 계획 결과 자리에 넣는 예시 값.
 * 02 이후 단계의 프롬프트는 계획을 입력으로 받는데, dry-run은 API를 호출하지 않아 실제 계획이
 * 없다. 형식만 보여주기 위한 더미이며, 이 때문에 해당 단계는 reproducible=false 다.
 */
function samplePlan(): BuildPlan {
  return {
    domainName: "sample",
    domainLabel: "예시",
    domainRoot: "",
    domainDirName: "sample",
    files: [],
    conventions: [],
    conflicts: [],
    openQuestions: [],
    reasoning: "(dry-run 예시 계획)",
  };
}

export function buildDryRunPreviews(input: BuildContext): PromptPreview[] {
  const { context, manifest } = withResolvedInputs(input);
  const stages = selectStages(manifest, context.onlyStages);
  const referenceTree = listReferenceTree(
    context.repoRoot,
    manifest,
    context.referenceDomain,
    stages,
  );

  const planPreview = previewPlanPrompt(context, manifest, stages, referenceTree);
  const previews: PromptPreview[] = [
    { ...planPreview, note: `컨벤션 문서: ${context.conventionsSource}` },
  ];
  const plan = samplePlan();

  for (const stage of stages) {
    const preview = previewStagePrompt(context, manifest, plan, stage, []);
    previews.push({
      ...preview,
      reproducible: false,
      note: [preview.note, "계획이 예시값이라 '만들 파일' 목록이 비어 있음"]
        .filter(Boolean)
        .join(" / "),
    });
  }

  return previews;
}

export function formatDryRunReport(previews: PromptPreview[]): string {
  return previews
    .map((preview) => {
      const header = `${"=".repeat(70)}\n# ${preview.stage}${
        preview.reproducible ? "" : " (실제 실행과 다름)"
      }`;
      const note = preview.note ? `\n> ${preview.note}` : "";
      return `${header}${note}\n\n--- system ---\n${preview.system}\n\n--- user ---\n${preview.user}`;
    })
    .join("\n\n");
}
