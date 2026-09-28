import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { loadManifest, MANIFEST_FILE, stagesFor } from "../core/manifest";
import type { Manifest, StageDef } from "../core/manifest";
import type { BuildPlan } from "../core/types";
import { loadWorkOrder } from "../core/workOrder";
import type { WorkOrder } from "../core/workOrder";
import { loadActive, planFile } from "./layout";
import type { ActiveWork } from "./layout";

/** 진행 중인 작업 하나를 판정에 필요한 만큼 전부 읽은 것 */
export interface Work {
  repoRoot: string;
  active: ActiveWork;
  manifest: Manifest;
  order: WorkOrder;
  /** 이 종류가 도는 매니페스트 단계, 선언 순서대로 */
  stages: StageDef[];
  /** 제출된 계획. plan 스테이지에서 제출하기 전에는 없다 */
  plan?: BuildPlan;
  /** implement 에서 지금 도는 단계 */
  stage?: StageDef;
}

export function loadManifestIfAny(repoRoot: string): Manifest | undefined {
  return existsSync(join(repoRoot, MANIFEST_FILE)) ? loadManifest(repoRoot) : undefined;
}

export function readOrder(repoRoot: string, spec: string, manifest: Manifest): WorkOrder {
  return loadWorkOrder(repoRoot, [join(repoRoot, spec)], {
    attributes: manifest.workOrder.attributes,
    requireApprover: manifest.workOrder.requireApprover,
  });
}

/** 진행 중인 작업이 없으면 undefined. 있는데 읽을 수 없으면 던진다 — 호출자가 막는 쪽으로 처리한다 */
export function loadWork(repoRoot: string): Work | undefined {
  const active = loadActive(repoRoot);
  if (!active) {
    return undefined;
  }
  const manifest = loadManifest(repoRoot);
  const order = readOrder(repoRoot, active.spec, manifest);
  const stages = stagesFor(manifest, order.kind);
  const path = planFile(repoRoot, active.id, active.target);
  const plan = existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as BuildPlan) : undefined;
  const stage = active.stage ? stages.find((candidate) => candidate.key === active.stage) : undefined;
  return { repoRoot, active, manifest, order, stages, plan, stage };
}
