import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { checkApproval } from "../core/approval";
import type { ApprovalState } from "../core/approval";
import { loadManifest, MANIFEST_FILE, stagesFor } from "../core/manifest";
import type { Manifest, StageDef } from "../core/manifest";
import { planFormatFor, sequenceProblems } from "../core/plan";
import type { BuildPlan } from "../core/types";
import { loadWorkOrder } from "../core/workOrder";
import type { WorkKind, WorkOrder } from "../core/workOrder";
import { checkProjectDocs, projectDocsHash, sha } from "./docs";
import { workDocsHash } from "./workDocs";
import { loadActive, planFile, workDocsDir } from "./layout";
import type { ActiveWork } from "./layout";
import { Stop } from "./stop";

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
 * 승인이 묶는 문서의 해시 — 확정된 POLICY 4종 + 이 작업의 고정 목록(지시서 본문 · 01 · 02 · 03 · 04 · 07).
 * 승인은 "이 문서들을 근거로 한 이 계획"에 대한 것이라, 승인 뒤 어느 쪽이 바뀌어도 무효가 된다.
 * 필수 문서가 확정되지 않았으면 undefined — 묶을 근거가 없다 (대조하는 쪽은 그것을 어긋난 것으로 받는다).
 */
export function approvalDocsHash(work: Work): string | undefined {
  const project = projectDocsHash(checkProjectDocs(work.repoRoot, work.manifest));
  if (!project) {
    return undefined;
  }
  return sha(`${project}\n${workDocsHash(work.repoRoot, work.active.id, work.active.spec)}`);
}

/**
 * 제출된 계획을 다시 읽는다 — 저장돼 있다는 것만으로 믿지 않는다.
 *
 * `<대상>.plan.json` 은 커밋되는 파일이라 옛 형식(계획 스키마가 바뀌기 전)이 그대로 남아 있을 수 있다.
 * 검사 없이 읽으면 렌더·승인 화면이 없는 필드를 읽다 죽는다 — 다시 제출하라고 말하고 멈춘다.
 */
function readPlan(repoRoot: string, id: string, target: string, kind: WorkKind): BuildPlan | undefined {
  const path = planFile(repoRoot, id, target);
  if (!existsSync(path)) {
    return undefined;
  }
  const format = planFormatFor(kind);
  const parsed = format.schema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
  if (!parsed.success) {
    throw new Stop(
      `제출된 계획의 형식이 지금 스키마와 맞지 않습니다 (${path}):\n` +
        parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n") +
        `\n${workDocsDir(id)}/plan.json 을 고쳐 code-agent plan submit 으로 다시 제출하세요.`,
    );
  }
  const plan = format.toPlan(parsed.data);
  return plan;
}

/**
 * 지금 계획의 승인 상태. 판정하는 곳이 여럿이라(hook·next·status·approve) 기준을 한 벌로 둔다 —
 * 한 곳만 문서 해시를 빠뜨리면 거기가 구멍이 된다.
 */
export function approvalOf(work: Work): ApprovalState {
  if (!work.plan) {
    return { status: "none" };
  }
  const problems = sequenceProblems(work.plan, work.stages, work.order.kind);
  if (problems.length) throw new Stop(`제출된 계획의 실행 순서가 유효하지 않습니다:\n${problems.join("\n")}\nplan.json 의 sequence 를 고쳐 다시 제출하고 승인받으세요.`);
  return checkApproval(work.repoRoot, work.order, work.plan, work.active.target, {
    manifest: work.manifest,
    requireVerifiedApproval: work.manifest.workOrder.requireVerifiedApproval,
    // 확정이 깨졌으면 대조를 끄는 것이 아니라 어긋난 것으로 본다 — 여기서 undefined 를 주면
    // 확정된 POLICY 문서 한 글자만 고쳐도 문서 묶음 대조가 통째로 꺼진다 (fail-open).
    docsHash: approvalDocsHash(work) ?? "unconfirmed",
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
  const plan = readPlan(repoRoot, active.id, active.target, order.kind);
  const stage = active.stage ? stages.find((candidate) => candidate.key === active.stage) : undefined;
  return { repoRoot, active, manifest, order, stages, plan, stage };
}
