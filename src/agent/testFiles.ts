import type { StageDef } from "../core/manifest";
import { trackedPaths } from "./tree";
import type { Work } from "./work";

/**
 * 한 단계가 **스스로 밝힌** 테스트 자리. 밝히지 않았으면 빈 목록이다.
 *
 * `domainBase` 로 물러서지 않는다 — 그러면 소스 루트 전체가 "기존 테스트" 가 되어, 테스트가 소스
 * 옆에 있는 프로젝트(`*.test.ts` · `_test.go` · pytest)에서 refactor 가 **제 파일도** 못 고친다.
 * 자리를 밝히지 않은 단계는 테스트 파일을 가려낼 수 없어 아무것도 지키지 못한다
 * (`code-agent manifest check` 가 그 사실을 경고한다).
 */
export function stageTestRoots(stage: StageDef): string[] {
  const roots =
    stage.scope === "project" && stage.outputDirs.length > 0 ? stage.outputDirs : stage.base ? [stage.base] : [];
  return roots.map((root) => root.replace(/\/+$/, "")).filter((root) => root !== "");
}

/**
 * kind:"test" 단계가 덮는 저장소 기준 경로 접두어.
 *
 * **매니페스트의 모든 `kind:"test"` 단계를 본다** — `work.stages` 는 이번 종류로 도는 단계뿐이라,
 * `kinds` 에서 `refactor` 를 뺀 테스트 단계(새 테스트를 만들지 않으니 자연스러운 선언)가 거기서
 * 사라지고 기존 테스트 보호가 세 자리(제출 · 쓰기 · 검증)에서 한꺼번에 꺼진다.
 */
export function testRoots(work: Work): string[] {
  return work.manifest.stages.filter((stage) => stage.kind === "test").flatMap(stageTestRoots);
}

/** 기준 커밋에 이미 있던 테스트 파일 — refactor 가 손대면 안 되는 것 */
export function trackedTestFiles(work: Work): string[] {
  const roots = testRoots(work);
  if (!work.active.baseCommit || roots.length === 0) {
    return [];
  }
  return trackedPaths(work.repoRoot, work.active.baseCommit).filter((path) =>
    roots.some((root) => path === root || path.startsWith(`${root}/`)),
  );
}
