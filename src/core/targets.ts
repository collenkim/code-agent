/**
 * 대상이 여럿일 때 — 대상마다 따로 돈다.
 *
 * 지시서 하나가 대상 여럿을 다루면 대상마다 **독립된 왕복**이 돈다. 계획도 질문도 승인도
 * 턴 기록도 대상 단위다. 대상 A 의 계획을 승인한 것이 B 의 승인이 될 수는 없기 때문이다.
 *
 * ```
 * out/                          ← --out (지시서 하나의 뿌리)
 *   .code-agent/run.json        지시서 단위 상태 — 스펙 경로 · 프롬프트를 내준 대상
 *   PROJ-1421/
 *     app-settlement/           ← 레인 하나. 계획 · 질문 · 세션 · 생성물이 여기 있다
 *     app-common-tx/            ← 〃
 * ```
 *
 * 대상 간 의존은 전제하지 않는다. 배열 순서는 순서일 뿐이라, **막힌 대상은 건너뛰고**
 * 진행할 수 있는 대상으로 간다. 정말 순서가 필요하면 지시서를 나눈다 — 나누는 편이
 * 승인 단위로도 옳다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { checkApproval, checkStage } from "./approval";
import type { StageState } from "./approval";
import type { Manifest } from "./manifest";
import { decideTarget, describeTarget, loadSession } from "./session";
import type { Target } from "./session";
import { needsIntake } from "./specSchema";
import type { SpecSchema } from "./specSchema";
import { loadPlan, loadStageFiles, PLAN_FILE } from "./state";
import { slug } from "./workOrder";
import type { WorkOrder } from "./workOrder";

/** 대상 하나가 도는 자리 */
export interface Lane {
  target: string;
  /** 그 대상의 계획·질문·세션·생성물이 있는 곳 */
  outDir: string;
}

export function laneDir(baseOut: string, order: WorkOrder, target: string): string {
  return join(baseOut, slug(order.id), slug(target));
}

export function lanesOf(baseOut: string, order: WorkOrder): Lane[] {
  return order.target.map((target) => ({ target, outDir: laneDir(baseOut, order, target) }));
}

// ---- 지시서 단위 상태 ----

const RUN_FILE = join(".code-agent", "run.json");

export interface RunState {
  /** 최초 한 번 받아 두면 이후 실행에서는 --spec 을 다시 주지 않아도 된다 */
  specPaths: string[];
  /** 프롬프트를 마지막으로 내준 대상 */
  dispatch?: { id: string; target: string };
}

export function runStatePath(baseOut: string): string {
  return join(baseOut, RUN_FILE);
}

export function readRunState(baseOut: string): RunState {
  const path = runStatePath(baseOut);
  if (!existsSync(path)) {
    return { specPaths: [] };
  }
  const stored = JSON.parse(readFileSync(path, "utf-8")) as Partial<RunState>;
  return { specPaths: stored.specPaths ?? [], dispatch: stored.dispatch };
}

export function writeRunState(baseOut: string, state: RunState): void {
  const path = runStatePath(baseOut);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * 스펙 경로를 기억한다.
 *
 * 작업 지시서가 스펙 문서의 머리말에 있으므로 명령마다 그 경로가 필요하다. 사람이 매번
 * 다시 쓰지 않게 하려는 것뿐이고, **기억하는 것은 경로뿐이다** — 지시서를 요구하는 것도,
 * 그 내용을 매번 다시 읽어 검사하는 것도 그대로다.
 *
 * 대상 단위가 아니라 지시서 단위인 이유는 순서다. 어느 대상으로 갈지 정하려면 지시서를
 * 먼저 읽어야 하고, 지시서를 읽으려면 스펙 경로가 먼저 있어야 한다.
 */
export function withRememberedSpec<T extends { specPaths: string[]; outDir: string }>(input: T): T {
  const state = readRunState(input.outDir);

  if (input.specPaths.length === 0) {
    return { ...input, specPaths: state.specPaths };
  }
  if (input.specPaths.join("\n") !== state.specPaths.join("\n")) {
    writeRunState(input.outDir, { ...state, specPaths: input.specPaths });
  }
  return input;
}

/** 프롬프트를 내준 대상을 적어 둔다 — 응답이 엉뚱한 대상에 반영되지 않게 */
export function rememberDispatch(baseOut: string, id: string, target: string): void {
  writeRunState(baseOut, { ...readRunState(baseOut), dispatch: { id, target } });
}

/**
 * 마지막으로 프롬프트를 내준 대상. 읽고 나면 지운다.
 *
 * 이것이 없으면 next 와 apply 사이에 사람이 다른 대상의 질문에 답했을 때 선택이 달라져,
 * 붙여넣은 응답이 **다른 대상의 레인에 반영된다.** 추측으로 고르지 않기 위한 기록이다.
 */
export function takeDispatch(baseOut: string): string | undefined {
  const state = readRunState(baseOut);
  if (!state.dispatch) {
    return undefined;
  }
  writeRunState(baseOut, { specPaths: state.specPaths });
  return state.dispatch.target;
}

// ---- 어느 대상을 돌 차례인가 ----

export interface LaneState {
  lane: Lane;
  /** 그 대상이 지금 할 차례 */
  step: Target;
}

export interface LaneDeps {
  repoRoot: string;
  specText: string;
  specSchema?: SpecSchema;
  gate: boolean;
}

/** 대상마다 지금 무엇을 할 차례인지. 1차 게이트도 승인도 확정도 여기서 대상별로 갈린다. */
export function laneStates(baseOut: string, order: WorkOrder, manifest: Manifest, deps: LaneDeps): LaneState[] {
  return lanesOf(baseOut, order).map((lane) => {
    const plan = existsSync(join(lane.outDir, PLAN_FILE)) ? loadPlan(lane.outDir) : undefined;
    // 4차 게이트가 볼 것 — 단계마다 "지금 out/ 에 있는 파일들"이 확정된 것과 같은가.
    // 계획이 없으면 어느 단계가 무엇을 만드는지 자체를 모르므로 계산하지 않는다.
    const stages = plan
      ? new Map<string, StageState>(
          manifest.stages.map((stage) => [
            stage.key,
            checkStage(
              deps.repoRoot,
              order,
              lane.target,
              stage.key,
              loadStageFiles(lane.outDir, plan, stage.key),
            ),
          ]),
        )
      : undefined;

    return {
      lane,
      step: decideTarget(lane.outDir, manifest, loadSession(lane.outDir), {
        gate: deps.gate,
        // 대상마다 필요한 것이 다르다. 도메인 A 에는 상태 전이가 있고 B 에는 없다.
        intakeNeeded: deps.specSchema !== undefined && needsIntake(lane.outDir, deps.specText),
        approval: plan
          ? checkApproval(deps.repoRoot, order, plan, lane.target, {
              requireVerifiedApproval: manifest.workOrder.requireVerifiedApproval,
            })
          : undefined,
        stages,
      }),
    };
  });
}

function actionable(step: Target): boolean {
  // 모델에 낼 프롬프트가 있는 단계들. 사람을 기다리는 것(질문·승인·확정)은 여기 들지 않는다.
  return (
    step.kind !== "blocked" &&
    step.kind !== "approval" &&
    step.kind !== "confirm" &&
    step.kind !== "done"
  );
}

/**
 * 지금 돌 대상 하나.
 *
 * 진행할 수 있는 첫 대상을 고른다. 막힌 대상(질문 미답변·승인 대기)에서 멈춰 서면 사람이
 * 답하거나 승인할 때까지 나머지 대상이 통째로 서 버리는데, 대상 간 의존은 전제하지 않는다.
 */
export function pickLane(states: LaneState[]): LaneState {
  return (
    states.find((state) => actionable(state.step)) ??
    states.find((state) => state.step.kind !== "done") ??
    states[0]
  );
}

/** 대상별 상태를 한 줄씩. 여러 대상이 있을 때만 뜻이 있다. */
export function describeLanes(states: LaneState[]): string {
  return states
    .map((state) => {
      const step = state.step;
      const detail =
        step.kind === "blocked"
          ? "미결 질문"
          : step.kind === "approval"
            ? "승인 대기"
            : step.kind === "confirm"
              ? `확정 대기 — ${step.stage.key}`
              : step.kind === "done"
                ? "끝남"
                : describeTarget(step);
      return `  - ${state.lane.target}: ${detail}`;
    })
    .join("\n");
}
