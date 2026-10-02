import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { userInfo } from "os";

import { MANIFEST_FILE } from "../core/manifest";
import { writeAtomic } from "../core/atomic";
import { Stop } from "./commands";
import { checkDoc, checkKnowledge, checkProjectDocs, docsReady, formatDocChecks, formatKnowledgeChecks, recordDocConfirmation } from "./docs";
import { DOCS_SESSION_FILE, loadActive } from "./layout";
import { loadRequestSession, requestStatusLines } from "./request";
import { interview, isDocKind, isPolicyKind, isWorkDocKind, KNOWLEDGE_KINDS, POLICY_KINDS, SCHEMAS, skeleton, WORK_SCHEMAS } from "./schemas";
import type { DocKind, KnowledgeKind, PolicyKind } from "./schemas";
import { confirmOnTerminal } from "./tty";
import { loadManifestIfAny } from "./work";

const KINDS = `${POLICY_KINDS.join(" · ")} · ${KNOWLEDGE_KINDS.join(" · ")}`;

function kindOf(value: string | undefined): DocKind {
  if (!value || !isDocKind(value)) {
    throw new Stop(`문서 종류는 ${KINDS} 입니다 (작업 문서 뼈대는 ${Object.keys(WORK_SCHEMAS).join(" · ")}).`);
  }
  return value;
}

/** 확정은 POLICY 만 — KNOWLEDGE 는 게이트가 파일 존재뿐이라 확정 절차가 없다 */
function policyKindOf(value: string | undefined): PolicyKind {
  const kind = kindOf(value);
  if (!isPolicyKind(kind)) {
    throw new Stop(`${SCHEMAS[kind].label} 은 공통 KNOWLEDGE 라 확정 대상이 아닙니다 — 게이트는 파일 존재뿐입니다.`);
  }
  return kind;
}

/** 문서 경로를 적는 code-agent.json 자리. 컨벤션만 `conventions[]` 로 따로 있다 */
const POLICY_KEY: Record<Exclude<PolicyKind, "conventions">, string> = {
  architecture: "architecture",
  "test-strategy": "testStrategy",
  quality: "quality",
};
const KNOWLEDGE_KEY: Record<KnowledgeKind, string> = {
  "data-dictionary": "dataDictionary",
  "api-catalog": "apiCatalog",
  "business-rules": "businessRules",
};

export function docsStatus(repoRoot: string): string {
  const manifest = loadManifestIfAny(repoRoot);
  const checks = checkProjectDocs(repoRoot, manifest);
  const knowledge = checkKnowledge(repoRoot, manifest);
  const session = existsSync(join(repoRoot, DOCS_SESSION_FILE));
  const next = docsReady(checks)
    ? knowledge.every((entry) => entry.exists)
      ? "필수 문서가 모두 확정됐습니다."
      : "필수 문서는 모두 확정됐습니다. KNOWLEDGE 빈 뼈대는 code-agent docs begin 이 만듭니다 (없어도 작업은 시작됩니다)"
    : checks.every((entry) => entry.state === "unconfirmed" || entry.state === "stale" || entry.ok)
      ? "현재 호스트 세션에서 ca-answer의 docs 동의 절차로 공통 문서를 묶어서 또는 개별 확정하세요. 적용 뒤 ca-next 흐름을 자동으로 이어갑니다. 직접 CLI를 원하면 TTY에서 code-agent confirm doc all 또는 code-agent confirm doc <종류>로 확정할 수도 있습니다."
      : "/ca-docs 로 작성하세요 (역공학 · 사용자 입력 · 기존 문서 연결)";
  return [
    "공통 POLICY (넷 다 확정돼야 작업이 시작됩니다):",
    formatDocChecks(checks, true),
    "",
    "공통 KNOWLEDGE (파일만 있으면 됩니다 — 반영마다 자랍니다):",
    formatKnowledgeChecks(knowledge),
    "",
    `문서 작성 세션: ${session ? "진행 중 (doc/ · 등록된 문서 · code-agent.json 만 쓸 수 있음)" : "없음"}`,
    `다음: ${next}`,
  ].join("\n");
}

/** POLICY 4종 · KNOWLEDGE 3종(`knowledge` 면 셋 다) · 작업 문서(01-requirements … 07-test-spec)의 뼈대 */
export function docsSkeleton(kind: string | undefined): string {
  if (kind === "knowledge") {
    return KNOWLEDGE_KINDS.map((entry) => `<!-- ${SCHEMAS[entry].defaultPath} -->\n${skeleton(SCHEMAS[entry])}`).join("\n");
  }
  if (kind && isWorkDocKind(kind)) {
    return skeleton(WORK_SCHEMAS[kind]);
  }
  return skeleton(SCHEMAS[kindOf(kind)]);
}

export function docsInterview(kind: string | undefined, sections?: string): string {
  return interview(SCHEMAS[kindOf(kind)], sections?.split(","));
}

/** 이미 있는 문서를 등록한다. code-agent.json 의 그 자리만 바꾼다 */
export function docsLink(repoRoot: string, kindArg: string | undefined, paths: string[]): string {
  const kind = kindOf(kindArg);
  // 등록 경로를 갈아끼우면 확정이 깨진다 — docs begin 과 같은 이유로 작업 도중에는 받지 않는다.
  // 열어 두면 모델이 제가 쓴 파일을 POLICY 문서 자리에 걸어 승인 무효화를 통째로 끌 수 있다.
  const active = loadActive(repoRoot);
  if (active) {
    throw new Stop(
      `작업이 진행 중입니다 (${active.id}). 근거 문서는 작업 도중에 바꾸지 않습니다 — 작업을 끝내거나 현재 호스트 세션에서 ca-answer의 abort 동의 절차로 종료한 뒤 연결하세요.`,
    );
  }
  requireNoIntake(repoRoot, "문서 연결");
  const manifestPath = join(repoRoot, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Stop(
      `${MANIFEST_FILE} 이 아직 없습니다. 기본 경로(${SCHEMAS[kind].defaultPath})에 두거나, /ca-adopt 로 매니페스트를 만든 뒤 연결하세요.`,
    );
  }
  // 여러 경로를 받는 것은 컨벤션뿐이다 — 나머지는 문서 하나가 정본이다
  if (paths.length === 0 || (kind !== "conventions" && paths.length !== 1)) {
    throw new Stop(kind === "conventions" ? "컨벤션 문서 경로(파일 또는 디렉토리)가 필요합니다." : `${SCHEMAS[kind].label} 문서 경로 하나가 필요합니다.`);
  }
  const missing = paths.filter((path) => !existsSync(join(repoRoot, path)));
  if (missing.length > 0) {
    throw new Stop(`없는 경로입니다: ${missing.join(", ")}`);
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  const docs = (raw.docs as Record<string, unknown>) ?? {};
  if (kind === "conventions") {
    raw.conventions = paths;
  } else if (isPolicyKind(kind)) {
    raw.docs = { ...docs, [POLICY_KEY[kind]]: paths[0] };
  } else {
    raw.docs = { ...docs, knowledge: { ...((docs.knowledge as Record<string, unknown>) ?? {}), [KNOWLEDGE_KEY[kind]]: paths[0] } };
  }
  writeAtomic(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  const manifest = loadManifestIfAny(repoRoot);
  const state = isPolicyKind(kind)
    ? formatDocChecks([checkDoc(repoRoot, manifest, kind)], true)
    : formatKnowledgeChecks(checkKnowledge(repoRoot, manifest).filter((entry) => entry.kind === kind));
  return `${SCHEMAS[kind].label} 문서를 연결했습니다: ${paths.join(", ")}\n\n${state}`;
}

/** 접수 중 문서 연결은 명시적인 준비 세션 안에서만 한다. 작업 시작 후에는 바꾸지 않는다. */
function requireNoIntake(repoRoot: string, what: string): void {
  const intake = loadRequestSession(repoRoot);
  if (intake && !existsSync(join(repoRoot, DOCS_SESSION_FILE))) {
    throw new Stop(
      `요구사항을 접수 중입니다 (${intake.id}). ${what}은(는) code-agent docs begin 으로 준비 세션을 연 뒤에 합니다. 접수는 유지됩니다.`,
    );
  }
}

export function docsBegin(repoRoot: string): string {
  const active = loadActive(repoRoot);
  if (active) {
    throw new Stop(
      `작업이 진행 중입니다 (${active.id}). 근거 문서는 작업 도중에 바꾸지 않습니다 — 작업을 끝내거나 현재 호스트 세션에서 ca-answer의 abort 동의 절차로 종료한 뒤 여세요.`,
    );
  }
  mkdirSync(dirname(join(repoRoot, DOCS_SESSION_FILE)), { recursive: true });
  writeFileSync(join(repoRoot, DOCS_SESSION_FILE), `${JSON.stringify({ startedAt: new Date().toISOString() })}\n`);
  const created = createKnowledgeSkeletons(repoRoot);
  return [
    "문서 작성 세션을 열었습니다. 끝날 때까지 doc/ · 등록된 문서 · code-agent.json 밖은 쓸 수 없습니다.",
    ...(loadRequestSession(repoRoot) ? ["접수한 ID·원문 초안은 유지됩니다. 준비 뒤 같은 요구사항으로 이어갑니다."] : []),
    ...(created.length > 0 ? [`공통 KNOWLEDGE 빈 뼈대를 만들었습니다: ${created.join(", ")}`] : []),
    "",
    docsStatus(repoRoot),
  ].join("\n");
}

/**
 * 없는 KNOWLEDGE 문서를 빈 뼈대로 만든다.
 *
 * 도입 세션을 여는 자리가 유일하게 "아직 작업이 없는" 자리다 — 명령을 하나 더 만드는 대신 여기서 만든다.
 * 막지 않는 문서라 사람에게 시키면 영영 안 생기고, 그러면 P5 의 반영이 쓸 자리가 없다.
 */
function createKnowledgeSkeletons(repoRoot: string): string[] {
  const created: string[] = [];
  for (const entry of checkKnowledge(repoRoot, loadManifestIfAny(repoRoot))) {
    if (entry.exists) continue;
    const path = join(repoRoot, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, skeleton(SCHEMAS[entry.kind]));
    created.push(entry.path);
  }
  return created;
}

export function docsEnd(repoRoot: string): string {
  rmSync(join(repoRoot, DOCS_SESSION_FILE), { force: true });
  const session = loadRequestSession(repoRoot);
  return `문서 작성 세션을 닫았습니다.\n\n${docsStatus(repoRoot)}` + (session ? `\n\n접수 ${session.id} 유지 — 다음: ${requestStatusLines(repoRoot, session).hint}` : "");
}

/** 사람이 문서를 근거로 삼겠다고 확정한다 — 현재 세션의 검증된 선택 또는 수동 TTY 입력. */
export function confirmDoc(repoRoot: string, kindArg: string | undefined): string {
  if (kindArg === "all") {
    const checks = checkProjectDocs(repoRoot, loadManifestIfAny(repoRoot));
    if (checks.some((entry) => entry.state === "missing-file" || entry.state === "missing-sections")) {
      throw new Stop(`확정할 수 없습니다 — 빠진 문서를 먼저 채우세요.\n${formatDocChecks(checks, true)}`);
    }
    if (checks.every((entry) => entry.ok)) return "공통 문서가 지금 내용으로 이미 확정돼 있습니다.";
    const shown = ["공통 POLICY 4종을 한 번에 확정합니다.", formatDocChecks(checks, true),
      ...checks.map((entry) => `${entry.label}: ${entry.paths.join(", ")} (${entry.hash})`),
      "각 문서를 읽고 확인하세요. 이후 계획은 이 문서 묶음을 근거로 삼습니다."].join("\n");
    const presence = confirmOnTerminal(shown, "confirm");
    const now = checkProjectDocs(repoRoot, loadManifestIfAny(repoRoot));
    if (now.some((entry, index) => entry.hash !== checks[index].hash || entry.paths.join("\n") !== checks[index].paths.join("\n") || entry.state === "missing-sections")) {
      throw new Stop("확정하는 동안 공통 문서가 바뀌었습니다 — 판정을 남기지 않았습니다. 다시 확인하세요.");
    }
    for (const entry of checks.filter((entry) => !entry.ok)) recordDocConfirmation(repoRoot, entry, userInfo().username, presence);
    return `공통 POLICY 4종을 확정했습니다.\n\n${docsStatus(repoRoot)}`;
  }
  const kind = policyKindOf(kindArg);
  const check = checkDoc(repoRoot, loadManifestIfAny(repoRoot), kind);
  if (check.state === "confirmed") {
    return `${check.label} 문서는 지금 내용으로 이미 확정돼 있습니다.`;
  }
  if (check.state === "missing-file" || check.state === "missing-sections") {
    throw new Stop(`확정할 수 없습니다 — ${check.problem}\n\n${formatDocChecks([check], true)}`);
  }
  const shown = [
    `${check.label} 문서를 확정합니다: ${check.paths.join(", ")}`,
    formatDocChecks([check], true),
    "",
    "확정하면 이후 모든 계획이 이 내용을 근거로 삼습니다. 내용을 직접 읽고 확인한 뒤 확정하세요.",
  ].join("\n");
  const presence = confirmOnTerminal(shown, "confirm");
  recordDocConfirmation(repoRoot, check, userInfo().username, presence);
  return `${check.label} 문서를 확정했습니다 (${check.hash}).\n\n${docsStatus(repoRoot)}`;
}
