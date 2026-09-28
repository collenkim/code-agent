import { existsSync } from "fs";
import { join } from "path";

import type { Manifest } from "../core/manifest";

/**
 * 프로젝트 필수 문서 — 아키텍처와 코드 컨벤션.
 *
 * 없으면 어떤 작업도 요구사항 분석 이후로 가지 않는다. 그 빈자리를 모델이 지어내기 때문이다.
 * 지금은 **있는가**만 본다. 필수 섹션 검사와 사람의 확정은 P2 에서 여기에 더한다.
 */
export interface DocCheck {
  kind: "architecture" | "conventions";
  label: string;
  paths: string[];
  ok: boolean;
  problem?: string;
}

export function checkProjectDocs(repoRoot: string, manifest: Manifest | undefined): DocCheck[] {
  if (!manifest) {
    const problem = "code-agent.json 이 없습니다";
    return [
      { kind: "architecture", label: "아키텍처", paths: [], ok: false, problem },
      { kind: "conventions", label: "코드 컨벤션", paths: [], ok: false, problem },
    ];
  }

  const architecture = manifest.docs.architecture;
  const conventions = manifest.conventions;
  return [
    check("architecture", "아키텍처", architecture ? [architecture] : [], repoRoot,
      "code-agent.json 의 docs.architecture 에 경로가 없습니다"),
    check("conventions", "코드 컨벤션", conventions, repoRoot,
      "code-agent.json 의 conventions 에 경로가 없습니다"),
  ];
}

function check(
  kind: DocCheck["kind"],
  label: string,
  paths: string[],
  repoRoot: string,
  unregistered: string,
): DocCheck {
  if (paths.length === 0) {
    return { kind, label, paths, ok: false, problem: unregistered };
  }
  const missing = paths.filter((path) => !existsSync(join(repoRoot, path)));
  if (missing.length > 0) {
    return { kind, label, paths, ok: false, problem: `파일이 없습니다: ${missing.join(", ")}` };
  }
  return { kind, label, paths, ok: true };
}

export function docsReady(checks: DocCheck[]): boolean {
  return checks.every((entry) => entry.ok);
}

export function formatDocChecks(checks: DocCheck[]): string {
  return checks
    .map((entry) =>
      entry.ok
        ? `  ✓ ${entry.label}: ${entry.paths.join(", ")}`
        : `  ✗ ${entry.label}: ${entry.problem}`,
    )
    .join("\n");
}
