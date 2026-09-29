import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { checkApproval } from "../core/approval";
import type { ApprovalState } from "../core/approval";
import { loadManifest, MANIFEST_FILE, stagesFor } from "../core/manifest";
import type { Manifest, StageDef } from "../core/manifest";
import type { BuildPlan } from "../core/types";
import { loadWorkOrder } from "../core/workOrder";
import type { WorkOrder } from "../core/workOrder";
import { loadAnalysis, workDocsHash } from "./analysis";
import { checkProjectDocs, projectDocsHash, sha } from "./docs";
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
  return loadWorkOrder(repoRoot, join(repoRoot, spec), {
    attributes: manifest.workOrder.attributes,
    requireApprover: manifest.workOrder.requireApprover,
  });
}

/**
 * 승인이 묶는 문서의 해시 — 확정된 프로젝트 필수 문서 + 이 작업의 분석·작업 문서.
 * 승인은 "이 문서들을 근거로 한 이 계획"에 대한 것이라, 승인 뒤 어느 쪽이 바뀌어도 무효가 된다.
 * 필수 문서가 확정되지 않았으면 undefined — 묶을 근거가 없다.
 */
export function approvalDocsHash(work: Work): string | undefined {
  const project = projectDocsHash(checkProjectDocs(work.repoRoot, work.manifest));
  if (!project) {
    return undefined;
  }
  const analysis = loadAnalysis(work.repoRoot, work.active.id);
  return analysis ? sha(`${project}\n${workDocsHash(work.repoRoot, work.active.id, analysis)}`) : project;
}

/**
 * 지금 계획의 승인 상태. 판정하는 곳이 여럿이라(hook·next·status·approve) 기준을 한 벌로 둔다 —
 * 한 곳만 문서 해시를 빠뜨리면 거기가 구멍이 된다.
 */
export function approvalOf(work: Work): ApprovalState {
  if (!work.plan) {
    return { status: "none" };
  }
  return checkApproval(work.repoRoot, work.order, work.plan, work.active.target, {
    manifest: work.manifest,
    requireVerifiedApproval: work.manifest.workOrder.requireVerifiedApproval,
    docsHash: approvalDocsHash(work),
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
