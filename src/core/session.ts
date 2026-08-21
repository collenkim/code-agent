/**
 * 어디까지 왔는지를 코드가 들고 있게 한다.
 *
 * 단계마다 사람이 `--step` 으로 대상을 지정하던 것을 없애기 위한 것이다. 사람이 할 일은
 * "다음" 과 "반영" 두 가지로 줄고, 무엇을 할 차례인지는 상태에서 결정된다.
 *
 * 턴 기록을 남기는 이유는 따로 있다. 수동 모드로 돌려 보고 효율이 검증되면 서버를 붙이겠다는
 * 계획인데, 기록이 없으면 검증할 데이터 자체가 안 생긴다. 단계당 턴 수·경계 위반·read 비율은
 * 그대로 "API로 돌리면 몇 번 호출될까"와 "자동으로 맡겨도 되나"의 답이 된다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import type { ActionType } from "./action";
import type { Observation } from "./execute";
import type { Manifest, StageDef } from "./manifest";
import { PLAN_FILE } from "./state";
import type { GateViolation } from "./types";

export const SESSION_DIR = ".code-agent";
const SESSION_FILE = "session.json";
const QUESTIONS_FILE = "questions.md";
const ANSWER_PLACEHOLDER = "(여기에 답을 적으세요)";

export interface PendingQuestion {
  id: number;
  target: string;
  question: string;
  answer: string;
}

export interface TurnRecord {
  turn: number;
  at: string;
  target: string;
  counts: Partial<Record<ActionType, number>>;
  written: number;
  observations: number;
  violations: number;
  parseErrors: number;
}

export interface Session {
  version: 1;
  /** 최초 한 번 받아 두면 이후 실행에서는 --spec 을 다시 주지 않아도 된다 */
  specPaths: string[];
  completedStages: string[];
  gatedStages: string[];
  /** 단계별 검수 시도 횟수. 같은 곳에서 계속 막힐 때 사람에게 넘기려고 센다 */
  gateAttempts: Record<string, number>;
  turn: number;
  /** 앞 턴에서 요청한 read·list·run 의 결과. 다음 프롬프트에 실린다 */
  lastObservations: Observation[];
  /** 앞 턴의 위반. 다음 프롬프트에 "이번에는 반드시 고친다"로 실린다 */
  lastViolations: GateViolation[];
  log: TurnRecord[];
}

export function emptySession(): Session {
  return {
    version: 1,
    specPaths: [],
    completedStages: [],
    gatedStages: [],
    gateAttempts: {},
    turn: 0,
    lastObservations: [],
    lastViolations: [],
    log: [],
  };
}

function sessionPath(outDir: string): string {
  return join(outDir, SESSION_DIR, SESSION_FILE);
}

export function loadSession(outDir: string): Session {
  const path = sessionPath(outDir);
  if (!existsSync(path)) {
    return emptySession();
  }
  return { ...emptySession(), ...(JSON.parse(readFileSync(path, "utf-8")) as Session) };
}

export function saveSession(outDir: string, session: Session): void {
  const path = sessionPath(outDir);
  mkdirSync(join(outDir, SESSION_DIR), { recursive: true });
  writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
}

// ---- 미결 질문 ----

export function questionsPath(outDir: string): string {
  return join(outDir, SESSION_DIR, QUESTIONS_FILE);
}

/**
 * 질문을 사람이 고쳐 쓸 수 있는 문서로 남긴다.
 *
 * 계획 단계의 openQuestions 가 "뱉고 멈춤"으로 끝나 버리던 것을 루프로 바꾸는 자리다.
 * 답이 채워지면 다음 프롬프트에 그대로 실려 들어간다.
 */
export function writeQuestions(outDir: string, questions: PendingQuestion[]): string {
  const path = questionsPath(outDir);
  mkdirSync(join(outDir, SESSION_DIR), { recursive: true });

  const body = questions
    .map(
      (question) =>
        `## Q${question.id} · ${question.target}\n\n${question.question}\n\n` +
        `**답:**\n${question.answer || ANSWER_PLACEHOLDER}\n`,
    )
    .join("\n---\n\n");

  writeFileSync(
    path,
    "# 미결 질문\n\n" +
      "code-agent 가 스펙만으로 정할 수 없어 남긴 것들입니다. " +
      "**답:** 아래에 답을 적으면 다음 프롬프트에 반영됩니다.\n\n" +
      "답하지 않은 질문이 남아 있는 동안에는 다음 단계로 넘어가지 않습니다.\n\n" +
      `---\n\n${body}`,
    "utf-8",
  );
  return path;
}

export function readQuestions(outDir: string): PendingQuestion[] {
  const path = questionsPath(outDir);
  if (!existsSync(path)) {
    return [];
  }

  const text = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  const blocks = text.split(/^## Q/m).slice(1);

  return blocks.map((block, index) => {
    const heading = block.match(/^(\d+)\s*·\s*(.*)$/m);
    const [question, answerPart] = block.split(/^\*\*답:\*\*$/m);
    // 블록 구분선(---)이 앞 질문의 답 끝에 딸려 온다. 떼어 내지 않으면 답을 적지 않은 질문이
    // "답이 있는" 것으로 읽혀 그냥 지나간다 — 질문이 둘 이상일 때만 드러나는 자리다.
    const answer = (answerPart ?? "").replace(/\n\s*-{3,}\s*$/, "").trim();

    return {
      id: heading ? Number(heading[1]) : index + 1,
      target: heading ? heading[2].trim() : "",
      question: question.split("\n").slice(1).join("\n").trim(),
      answer: answer === ANSWER_PLACEHOLDER ? "" : answer,
    };
  });
}

export function unanswered(questions: PendingQuestion[]): PendingQuestion[] {
  return questions.filter((question) => question.answer === "");
}

/** 질문을 이어붙인다. 같은 질문을 다시 묻는 경우는 무시한다. */
export function appendQuestions(
  outDir: string,
  target: string,
  asked: string[],
): PendingQuestion[] {
  const existing = readQuestions(outDir);
  const known = new Set(existing.map((question) => question.question));
  const added = asked
    .filter((question) => !known.has(question))
    .map((question, index) => ({
      id: existing.length + index + 1,
      target,
      question,
      answer: "",
    }));

  const all = [...existing, ...added];
  if (added.length > 0) {
    writeQuestions(outDir, all);
  }
  return all;
}

// ---- 다음에 할 일 ----

export type Target =
  | { kind: "intake" }
  | { kind: "plan" }
  | { kind: "stage"; stage: StageDef }
  | { kind: "gate"; stage: StageDef }
  | { kind: "blocked"; reason: string }
  | { kind: "done" };

export function describeTarget(target: Target): string {
  switch (target.kind) {
    case "intake":
      return "intake";
    case "plan":
      return "plan";
    case "stage":
      return target.stage.key;
    case "gate":
      return `gate:${target.stage.key}`;
    case "blocked":
      return "blocked";
    case "done":
      return "done";
  }
}

/**
 * 지금 무엇을 할 차례인지 정한다.
 *
 * 단계는 선언된 순서대로, 각 단계마다 생성 → 검수로 이어진다. 미결 질문이 남아 있으면
 * 어느 것도 진행하지 않는다 — 추측으로 채운 코드가 나오는 것보다 멈추는 게 낫다.
 */
export function decideTarget(
  outDir: string,
  manifest: Manifest,
  session: Session,
  options: { gate: boolean; intakeNeeded?: boolean } = { gate: true },
): Target {
  // 스펙에서 필요한 항목을 뽑는 일이 먼저다. 무엇이 비었는지 모르는 채로 계획을 세우면
  // 그 빈칸이 곧 모델이 지어내는 자리가 된다.
  if (options.intakeNeeded) {
    return { kind: "intake" };
  }

  // 질문 검사가 계획보다 앞에 있어야 한다 — 1차 게이트가 남긴 질문은 계획 이전에 걸린다.
  const open = unanswered(readQuestions(outDir));
  if (open.length > 0) {
    return {
      kind: "blocked",
      reason:
        `답하지 않은 질문이 ${open.length}건 남아 있습니다.\n` +
        `  ${questionsPath(outDir)}\n` +
        "이 파일의 **답:** 아래에 답을 적고 다시 실행하세요.",
    };
  }

  if (!existsSync(join(outDir, PLAN_FILE))) {
    return { kind: "plan" };
  }

  for (const stage of manifest.stages) {
    if (!session.completedStages.includes(stage.key)) {
      return { kind: "stage", stage };
    }
    if (options.gate && !session.gatedStages.includes(stage.key)) {
      return { kind: "gate", stage };
    }
  }

  return { kind: "done" };
}

// ---- 효율 기록 ----

function sum(records: TurnRecord[], pick: (record: TurnRecord) => number): number {
  return records.reduce((total, record) => total + pick(record), 0);
}

/**
 * 턴 기록을 사람이 읽는 표로. 서버를 붙일지 판단하는 근거가 여기서 나온다.
 */
export function summarizeSession(session: Session): string {
  if (session.log.length === 0) {
    return "아직 기록된 턴이 없습니다.";
  }

  const byTarget = new Map<string, TurnRecord[]>();
  for (const record of session.log) {
    byTarget.set(record.target, [...(byTarget.get(record.target) ?? []), record]);
  }

  const countOf = (records: TurnRecord[], type: ActionType) =>
    sum(records, (record) => record.counts[type] ?? 0);

  const lines = [
    `## 턴 기록 — 총 ${session.log.length}턴`,
    "",
    "| 대상 | 턴 | write | edit | read | ask | 위반 | 형식오류 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (const [target, records] of byTarget) {
    lines.push(
      `| ${target} | ${records.length} | ${countOf(records, "write")} | ${countOf(records, "edit")} | ` +
        `${countOf(records, "read")} | ${countOf(records, "ask")} | ` +
        `${sum(records, (record) => record.violations)} | ` +
        `${sum(records, (record) => record.parseErrors)} |`,
    );
  }

  const reads = countOf(session.log, "read") + countOf(session.log, "list");
  const total = session.log.length;

  lines.push(
    "",
    `- 대상당 평균 턴: ${(total / byTarget.size).toFixed(1)} — API로 돌릴 때의 호출 횟수 추정치`,
    `- 탐색(read·list) 요청: ${reads}건 — 많으면 프롬프트 선주입이 부족하다는 뜻`,
    `- 경계 위반: ${sum(session.log, (record) => record.violations)}건 — 많으면 자동화에 아직 이르다`,
    `- 응답 형식 오류: ${sum(session.log, (record) => record.parseErrors)}건`,
  );

  return lines.join("\n");
}
