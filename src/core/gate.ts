/**
 * 경계 검사 — 순수 규칙 대조만 한다.
 *
 * 검수(컨벤션 준수 같은 문맥 판단)는 Claude Code 안의 ca-reviewer 가 맡는다. 여기 남는 것은
 * 경로·계획 대조처럼 비교 연산으로 끝나는 것들이고, 그것이 hook 이 딛는 자리다.
 */
import { existsSync } from "fs";
import { join, posix } from "path";

import { domainDirOf } from "./exemplar";
import type { WorkOrder } from "./workOrder";
import type { Manifest, StageDef } from "./manifest";
import type { BuildPlan, GateViolation, GeneratedFile } from "./types";

/** 경로 하나가 어떤 경로(파일 또는 디렉토리) 안에 드는가. */
function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/** 고치는 작업은 여러 기존 도메인을 다룬다. 분류/도메인 한 단계씩만 소비하고 계층 제한은 유지한다. */
function existingDomainDir(manifest: Manifest, stage: StageDef, path: string): string | undefined {
  const roots = manifest.domainRoots.length ? manifest.domainRoots : [""];
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const base = posix.join(stage.base ?? manifest.domainBase, root);
    const prefix = base === "." ? "" : `${base}/`;
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length).split("/");
    if (rest.length >= 2 && rest[0]) return posix.join(base, rest[0]);
  }
  return undefined;
}

/**
 * 보존하라고 한 것 중 **경로로 확인되는 것**.
 *
 * preserve 는 경로와 문장을 섞어 쓴다(`app/settlement` 과 `공개 시그니처를 유지한다`).
 * 저장소에 실제로 있는 경로면 코드가 막고, 나머지 문장형은 `plan submit` 의 missingPreserve 가
 * 계획에 적혔는지로 본다 — 어느 쪽인지를 추측하지 않고 실재로 가른다.
 */
export function preservedPaths(repoRoot: string, order: WorkOrder): string[] {
  return order.preserve
    .map((entry) => entry.trim().replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((entry) => entry !== "" && existsSync(join(repoRoot, entry)));
}

export interface BoundaryInput {
  repoRoot: string;
  /** 사람이 확정한 경계 — scope 는 상한선, preserve 는 손대면 안 되는 것 */
  order: WorkOrder;
  manifest: Manifest;
  plan: BuildPlan;
  stage: StageDef;
  files: GeneratedFile[];
}

/**
 * 경로 규칙 검사 — 판단이 아니라 규칙 대조라서 모델에 맡기지 않는다.
 * 다른 계층 파일을 만들지 않는다는 do-not-touch 경계가 여기서 강제된다.
 *
 * 경계는 두 곳에서 온다. **지시서**(사람이 확정한 scope·preserve)와 **매니페스트**
 * (단계별 outputDirs)이고, 둘 다 통과해야 한다. 지시서 쪽이 먼저인 이유는 그것이
 * 사람이 정한 상한선이기 때문이다 — 매니페스트가 넓게 열려 있어도 그 밖으로 못 나간다.
 */
export function checkPaths({
  repoRoot,
  order,
  manifest,
  plan,
  stage,
  files,
}: BoundaryInput): GateViolation[] {
  const violations: GateViolation[] = [];
  const preserved = preservedPaths(repoRoot, order);

  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");

    if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("..")) {
      violations.push({ item: "경로 규칙", file: path, detail: "절대경로 또는 상위 경로 참조" });
      continue;
    }

    // 바뀌면 안 된다고 사람이 적은 것. 종류와 무관하게 막는다 —
    // 이걸 통과시키면 지시서의 preserve 는 모델에게 하는 부탁일 뿐이 된다.
    const kept = preserved.find((entry) => under(path, entry));
    if (kept) {
      violations.push({
        item: "보존 대상",
        file: path,
        detail:
          `작업 지시서가 보존하라고 한 것입니다: ${kept}. ` +
          "바꾸려면 지시서를 먼저 고쳐야 합니다.",
      });
      continue;
    }

    // 지시서가 건드려도 되는 곳을 적었으면 그것이 상한선이다.
    if (order.scope.length > 0 && !order.scope.some((entry) => under(path, entry))) {
      violations.push({
        item: "지시서 scope 밖",
        file: path,
        detail: `이번에 건드려도 되는 곳: ${order.scope.join(", ")}`,
      });
      continue;
    }
    // outputDirs가 비면 위치를 제한하지 않는다 (문서 산출물 등).
    if (stage.outputDirs.length === 0) {
      continue;
    }
    // 프로젝트 범위 단계는 도메인 디렉토리가 아니라 저장소 루트를 기준으로 본다.
    if (stage.scope === "project") {
      const allowed = stage.outputDirs.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      );
      if (!allowed) {
        violations.push({
          item: "do-not-touch 경계",
          file: path,
          detail: `${stage.key} 단계가 만들 수 있는 위치가 아님 (허용: ${stage.outputDirs.join(", ")})`,
        });
      }
      continue;
    }
    const domainDir = order.kind === "fix" || order.kind === "refactor"
      ? existingDomainDir(manifest, stage, path)
      : domainDirOf(manifest, plan.domainRoot, plan.domainDirName, stage.base);
    if (domainDir === undefined || !path.startsWith(`${domainDir}/`)) {
      violations.push({
        item: "do-not-touch 경계",
        file: path,
        detail: `이번 도메인 디렉토리(${domainDir ?? stage.base ?? manifest.domainBase}) 밖의 파일`,
      });
      continue;
    }
    // 도메인 디렉토리 바로 아래 파일은 하위 디렉토리가 없어 "." 으로 본다
    const rest = path.slice(domainDir.length + 1);
    const layer = rest.includes("/") ? rest.split("/")[0] : ".";
    if (!stage.outputDirs.includes(layer)) {
      violations.push({
        item: "do-not-touch 경계",
        file: path,
        detail: `${stage.key} 단계가 만들 수 있는 위치가 아님 (허용: ${stage.outputDirs.join(", ")})`,
      });
    }
  }

  return violations;
}

/**
 * 이 단계에서 만들라고 계획이 적은 파일들.
 *
 * **비어 있으면 검사하지 않는다.** 계획이 그 단계에 대해 아무 말도 하지 않았으면 어길 것도
 * 없다 — 문서 산출물처럼 계획이 파일을 열거하지 않는 단계까지 막아 버리면, 없던 규칙을
 * 코드가 발명하는 셈이 된다.
 */
function plannedFor(plan: BuildPlan, stage: StageDef): Set<string> {
  return new Set(
    plan.files
      .filter((file) => file.stage === stage.key)
      .map((file) => file.path.replace(/\\/g, "/")),
  );
}

/**
 * 계획에 없는 파일을 만들려 하는가.
 *
 * 경계(`outputDirs`·`scope`)는 **어디에** 를 막고, 계획은 **무엇을** 을 정한다. 후자의 대조가
 * 없으면 사람의 승인은 경계 안에서만 유효하다 — 승인한 목록과 다른 것이 같은 디렉토리에
 * 생기는 것을 아무도 막지 않는다.
 *
 * 쓰기 **전에** 거부한다. 쓴 뒤에 알리면 되돌릴 수단이 없어(모델은 파일을 지울 수 없다)
 * 위반이 저장소 작업트리에 남은 채 경고만 반복된다.
 */
export function unplannedFiles(
  plan: BuildPlan,
  stage: StageDef,
  paths: string[],
): GateViolation[] {
  const planned = plannedFor(plan, stage);
  if (planned.size === 0) {
    return [];
  }
  return paths
    .map((path) => path.replace(/\\/g, "/"))
    .filter((path) => !planned.has(path))
    .map((path) => ({
      item: "계획 준수",
      file: path,
      detail:
        "승인된 계획에 없는 파일입니다. 필요하면 note 로만 남기세요 — " +
        "계획을 고치면 승인이 무효가 되고 재승인을 받습니다.",
    }));
}

/**
 * 계획에 있는데 아직 없는가. **단계를 끝냈다고 할 때만 본다** —
 * 한 단계가 여러 턴에 걸쳐 도므로 중간 턴에 보면 매번 거짓 위반이 뜬다.
 *
 * 이쪽은 막아도 갇히지 않는다. 모델이 그 파일을 쓰면 풀린다.
 */
export function missingPlannedFiles(
  plan: BuildPlan,
  stage: StageDef,
  present: string[],
): GateViolation[] {
  const planned = plannedFor(plan, stage);
  if (planned.size === 0) {
    return [];
  }
  const have = new Set(present.map((path) => path.replace(/\\/g, "/")));
  return [...planned]
    .filter((path) => !have.has(path))
    .map((path) => ({
      item: "계획 준수",
      file: path,
      detail: "승인된 계획에 있는데 만들어지지 않았습니다.",
    }));
}

