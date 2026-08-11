import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { StageDef } from "./manifest";
import type { BuildPlan, StageResult } from "./types";

/** 계획을 담아 두는 파일. 수동 모드는 단계마다 프로세스가 끝나므로 디스크에 남겨야 이어진다. */
export const PLAN_FILE = ".plan.json";

export function savePlan(outDir: string, plan: BuildPlan): string {
  const path = join(outDir, PLAN_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(plan, null, 2), "utf-8");
  return path;
}

export function loadPlan(outDir: string): BuildPlan {
  const path = join(outDir, PLAN_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `계획 파일이 없습니다: ${path}\n` +
        "먼저 계획을 만드세요 — --emit-prompt plan 으로 프롬프트를 뽑고, 응답을 --ingest 로 넣습니다.",
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as BuildPlan;
}

/**
 * 이미 만들어진 앞 단계 산출물을 디스크에서 되읽는다.
 *
 * 내용을 상태 파일에 중복 저장하지 않는 이유는, 계획이 이미 "어느 단계가 어느 경로를 만드는지"를
 * 갖고 있어 경로만으로 복원되기 때문이다. 사람이 out/ 안의 파일을 손봤다면 그 손본 내용이 다음
 * 단계 입력으로 들어간다 — 수동 모드에서는 그게 맞는 동작이다.
 */
export function loadPreviousResults(
  outDir: string,
  plan: BuildPlan,
  stages: StageDef[],
  targetStageKey: string,
): StageResult[] {
  const targetIndex = stages.findIndex((stage) => stage.key === targetStageKey);
  if (targetIndex < 0) {
    return [];
  }

  return stages.slice(0, targetIndex).map((stage) => ({
    stage: stage.key,
    attempts: 1,
    files: plan.files
      .filter((file) => file.stage === stage.key)
      .map((file) => ({ path: file.path, absolute: join(outDir, file.path) }))
      .filter((file) => existsSync(file.absolute))
      .map((file) => ({ path: file.path, content: readFileSync(file.absolute, "utf-8") })),
  }));
}
