/**
 * 액션을 실제로 실행한다.
 *
 * 여기가 "판단 불필요 = 코드" 원칙이 사는 자리다. 모델이 무엇을 요청하든 경계를 넘는지는
 * 전부 대조 연산으로 판정되므로 모델의 선의에 기대지 않는다. 전송이 클립보드든 API든
 * 이 함수는 같은 것을 한다.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { verifyByBuild } from "./build";
import type { Action, ActionType } from "./action";
import { checkPaths } from "./gate";
import type { Manifest, StageDef } from "./manifest";
import { loadStageFiles } from "./state";
import type { BuildPlan, GateViolation, GeneratedFile } from "./types";

/** 되돌려줄 관찰 결과의 상한 — 다음 프롬프트가 무한정 커지지 않게 한다 */
const MAX_READ_LINES = 500;
const MAX_LIST_ENTRIES = 200;
const MAX_LOG_LINES = 200;

/** read·list·run 의 결과. 다음 턴 프롬프트에 그대로 들어간다. */
export interface Observation {
  label: string;
  body: string;
}

export interface ExecuteOutcome {
  writtenFiles: string[];
  observations: Observation[];
  questions: string[];
  notes: string[];
  violations: GateViolation[];
  /** 모델이 이 단계를 끝냈다고 선언했는지 */
  done: boolean;
  counts: Partial<Record<ActionType, number>>;
}

export interface ExecuteInput {
  repoRoot: string;
  outDir: string;
  manifest: Manifest;
  plan: BuildPlan;
  stage: StageDef;
  actions: Action[];
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 저장소 밖으로 나가려는 경로인지. 파일명에 점이 들어간 경우와 구분하려고 조각 단위로 본다. */
function escapesRoot(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.split("/").includes("..");
}

function capLines(text: string, max: number, tail = false): string {
  const lines = text.split("\n");
  if (lines.length <= max) {
    return text;
  }
  return tail
    ? `(앞 ${lines.length - max}줄 생략)\n${lines.slice(-max).join("\n")}`
    : `${lines.slice(0, max).join("\n")}\n(총 ${lines.length}줄 중 앞 ${max}줄)`;
}

/**
 * 읽을 파일의 실제 위치. out/ 에 있으면 그쪽이 최신이다 — 이번 실행이 이미 만졌거나
 * 사람이 손본 내용이 거기 있기 때문이다.
 */
function locate(input: ExecuteInput, path: string): { absolute: string; origin: string } | null {
  const staged = join(input.outDir, path);
  if (existsSync(staged)) {
    return { absolute: staged, origin: "out" };
  }
  const original = join(input.repoRoot, path);
  if (existsSync(original)) {
    return { absolute: original, origin: "저장소" };
  }
  return null;
}

/** 파일을 바꾸는 액션들을 한꺼번에 경계 검사한다 — 하나라도 걸리면 전부 반영하지 않는다. */
function checkMutations(input: ExecuteInput, actions: Action[]): GateViolation[] {
  const targets: GeneratedFile[] = actions
    .filter((action) => action.type === "write" || action.type === "edit")
    .map((action) => ({ path: normalize((action as { path: string }).path), content: "" }));

  return checkPaths(input.manifest, input.plan, input.stage, targets);
}

function applyEdit(
  input: ExecuteInput,
  action: Extract<Action, { type: "edit" }>,
): { path: string } | { error: GateViolation } {
  const path = normalize(action.path);
  const found = locate(input, path);

  if (!found) {
    return {
      error: { item: "edit 대상 없음", file: path, detail: "저장소에도 out/ 에도 없는 파일입니다." },
    };
  }

  const before = readFileSync(found.absolute, "utf-8");
  const occurrences = before.split(action.find).length - 1;

  if (occurrences === 0) {
    return {
      error: {
        item: "edit find 불일치",
        file: path,
        detail: "find 로 준 내용이 원본에 없습니다. 공백·들여쓰기까지 정확히 일치해야 합니다.",
      },
    };
  }
  if (occurrences > 1) {
    return {
      error: {
        item: "edit find 모호",
        file: path,
        detail: `find 가 ${occurrences}곳에 걸립니다. 앞뒤를 더 붙여 한 곳만 지목하세요.`,
      },
    };
  }

  const target = join(input.outDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, before.replace(action.find, action.replace), "utf-8");
  return { path: target };
}

function observeRead(input: ExecuteInput, path: string): Observation {
  const found = locate(input, path);
  if (!found) {
    return { label: `read ${path}`, body: "(없는 파일입니다)" };
  }
  const language = input.manifest.language ?? "";
  const body = capLines(readFileSync(found.absolute, "utf-8"), MAX_READ_LINES);
  return { label: `read ${path} (${found.origin})`, body: `\`\`\`${language}\n${body}\n\`\`\`` };
}

function observeList(input: ExecuteInput, path: string): Observation {
  const found = locate(input, path);
  if (!found || !statSync(found.absolute).isDirectory()) {
    return { label: `list ${path}`, body: "(없는 디렉토리입니다)" };
  }
  const entries = readdirSync(found.absolute)
    .sort()
    .slice(0, MAX_LIST_ENTRIES)
    .map((name) => (statSync(join(found.absolute, name)).isDirectory() ? `${name}/` : name));
  return {
    label: `list ${path} (${found.origin})`,
    body: entries.length > 0 ? entries.join("\n") : "(빈 디렉토리)",
  };
}

function observeRun(input: ExecuteInput, command: string): Observation {
  if (command !== "build" && command !== "test") {
    return {
      label: `run ${command}`,
      body: "실행할 수 없습니다 — code-agent.json 에 선언된 build · test 만 돌릴 수 있습니다.",
    };
  }

  // 실행 대상은 계획이 알려 준 산출물이다. 임의 경로를 만들어 넘기지 않는다.
  const generated = input.manifest.stages.map((stage) => ({
    stage: stage.key,
    attempts: 1,
    files: loadStageFiles(input.outDir, input.plan, stage.key),
  }));

  const result = verifyByBuild(input.repoRoot, input.manifest, input.outDir, generated, command);
  return {
    label: `run ${command} — ${result.passed ? "통과" : "실패"}`,
    body: capLines(result.log, MAX_LOG_LINES, true),
  };
}

export function executeActions(input: ExecuteInput): ExecuteOutcome {
  const outcome: ExecuteOutcome = {
    writtenFiles: [],
    observations: [],
    questions: [],
    notes: [],
    violations: [],
    done: false,
    counts: {},
  };

  for (const action of input.actions) {
    outcome.counts[action.type] = (outcome.counts[action.type] ?? 0) + 1;
  }

  // 파일을 바꾸는 액션은 하나라도 경계를 넘으면 전부 반영하지 않는다. 절반만 반영된
  // out/ 은 다음 턴의 입력이 되어 오염이 번진다.
  const boundary = checkMutations(input, input.actions);
  if (boundary.length > 0) {
    outcome.violations = boundary;
    return outcome;
  }

  for (const action of input.actions) {
    switch (action.type) {
      case "write": {
        const path = normalize(action.path);
        const target = join(input.outDir, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, action.content, "utf-8");
        outcome.writtenFiles.push(target);
        break;
      }
      case "edit": {
        const applied = applyEdit(input, action);
        if ("error" in applied) {
          outcome.violations.push(applied.error);
        } else {
          outcome.writtenFiles.push(applied.path);
        }
        break;
      }
      case "read":
      case "list": {
        const path = normalize(action.path);
        if (escapesRoot(path)) {
          outcome.violations.push({
            item: "경로 규칙",
            file: path,
            detail: "절대경로 또는 상위 경로 참조",
          });
          break;
        }
        outcome.observations.push(
          action.type === "read" ? observeRead(input, path) : observeList(input, path),
        );
        break;
      }
      case "run": {
        if (input.stage.kind !== "verify") {
          outcome.violations.push({
            item: "run 허용 안 됨",
            file: input.stage.key,
            detail: `명령 실행은 kind가 verify인 단계에서만 됩니다 (현재: ${input.stage.kind}).`,
          });
          break;
        }
        outcome.observations.push(observeRun(input, action.command));
        break;
      }
      case "ask":
        outcome.questions.push(action.question);
        break;
      case "note":
        outcome.notes.push(action.text);
        break;
      case "done":
        outcome.done = true;
        break;
    }
  }

  return outcome;
}
