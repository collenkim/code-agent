import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { userInfo } from "os";

import { recordDecision } from "../core/approval";
import type { Decision } from "../core/approval";
import { collectExemplars, formatExemplars } from "../core/exemplar";
import { checkPaths, missingPlannedFiles } from "../core/gate";
import { stagesFor } from "../core/manifest";
import type { StageDef } from "../core/manifest";
import { formatPlan, missingPreserve, planFormatFor } from "../core/plan";
import { writeAtomic } from "../core/atomic";
import { checkProjectDocs, docsReady, formatDocChecks, projectDocsHash } from "./docs";
import {
  canonical,
  clearActive,
  loadActive,
  PHASES,
  planFile,
  questionsFile,
  saveActive,
  workDocsDir,
} from "./layout";
import type { ActiveWork, Phase } from "./layout";
import { unansweredQuestions } from "./questions";
import { isGitRepo, switchToWorkBranch } from "./git";
import { confirmOnTerminal } from "./tty";
import { approvalOf, loadManifestIfAny, loadWork, readOrder } from "./work";
import type { Work } from "./work";

/** 사람이 고칠 수 있는 이유로 멈출 때. 스택 없이 메시지만 보인다 */
export class Stop extends Error {}

const STARTABLE = ["feature", "fix", "refactor"];

const PHASE_LABEL: Record<Phase, string> = {
  analysis: "요구사항 분석",
  research: "범위 조사·작업 문서",
  plan: "개발 계획",
  implement: "구현",
  verify: "검증·개선",
  handoff: "인계",
};

function requireWork(repoRoot: string): Work {
  const work = loadWork(repoRoot);
  if (!work) {
    throw new Stop("진행 중인 작업이 없습니다. /ca-feature · /ca-fix · /ca-refactor 로 시작하세요.");
  }
  return work;
}

function requireDocs(repoRoot: string, work?: Work): void {
  const checks = checkProjectDocs(repoRoot, work?.manifest ?? loadManifestIfAny(repoRoot));
  if (!docsReady(checks)) {
    throw new Stop(
      "프로젝트 필수 문서가 갖춰지지 않아 진행할 수 없습니다.\n" +
        `${formatDocChecks(checks)}\n` +
        "/ca-docs 로 작성하세요 (역공학 · 사용자 입력 · 기존 문서 연결).",
    );
  }
}

function requireAnswers(repoRoot: string, active: ActiveWork): void {
  const open = unansweredQuestions(repoRoot, questionsFile(active.id));
  if (open.length > 0) {
    throw new Stop(
      `답이 없는 질문이 ${open.length}개 있어 넘어갈 수 없습니다 (${questionsFile(active.id)}):\n` +
        open.map((question) => `  - ${question.title}`).join("\n") +
        "\n/ca-answer 로 답하세요.",
    );
  }
}

/** implement 가 도는 단계 — 검증 단계는 verify 스테이지가 맡는다 */
function codeStages(work: Work): StageDef[] {
  return work.stages.filter((stage) => stage.kind !== "verify");
}

function toRepoPath(repoRoot: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  return relative(repoRoot, canonical(absolute)).replace(/\\/g, "/");
}

// ---- start ----

export function start(repoRoot: string, spec: string, options: { target?: string; base?: string } = {}): string {
  const { target } = options;
  const manifest = loadManifestIfAny(repoRoot);
  if (!manifest) {
    throw new Stop("code-agent.json 이 없습니다. /ca-adopt 로 프로젝트를 먼저 도입하세요.");
  }
  requireDocs(repoRoot);

  const specPath = toRepoPath(repoRoot, spec);
  const order = readOrder(repoRoot, specPath, manifest);
  if (!STARTABLE.includes(order.kind)) {
    throw new Stop(`${order.kind} 는 작업으로 시작하지 않습니다 (시작할 수 있는 것: ${STARTABLE.join(", ")}).`);
  }
  const chosen = target ?? order.target[0];
  if (!order.target.includes(chosen)) {
    throw new Stop(`지시서의 대상이 아닙니다: ${chosen} (대상: ${order.target.join(", ")})`);
  }
  stagesFor(manifest, order.kind);

  const current = loadActive(repoRoot);
  if (current && (current.id !== order.id || current.target !== chosen)) {
    throw new Stop(
      `진행 중인 작업이 있습니다: ${current.id} (${current.target}, ${current.phase}). ` +
        "끝내거나 code-agent abort 로 멈춘 뒤 시작하세요.",
    );
  }
  if (current) {
    return `이미 진행 중입니다: ${current.id} · ${PHASE_LABEL[current.phase]}\n\n${status(repoRoot)}`;
  }

  // 작업 브랜치 — 기준은 사용자 입력(--base) > code-agent.json 의 git.base > master
  let branch: string | undefined;
  let base: string | undefined;
  let branchNote = "git 저장소가 아니라 작업 브랜치를 만들지 않았습니다.";
  if (isGitRepo(repoRoot)) {
    base = options.base ?? manifest.git.base;
    branch = `${order.kind}/${order.id}`;
    try {
      const how = switchToWorkBranch(repoRoot, branch, base);
      branchNote =
        how === "created" ? `작업 브랜치 ${branch} 를 ${base} 에서 만들었습니다.`
        : how === "switched" ? `이미 있는 작업 브랜치 ${branch} 로 전환했습니다.`
        : `작업 브랜치 ${branch} 에 있습니다.`;
    } catch (error) {
      throw new Stop(`작업 브랜치로 옮기지 못했습니다: ${error instanceof Error ? error.message : error}`);
    }
  }

  const questions = join(repoRoot, questionsFile(order.id));
  mkdirSync(dirname(questions), { recursive: true });
  if (!existsSync(questions)) {
    writeFileSync(
      questions,
      `# ${order.id} 질문\n\n` +
        "<!-- 질문은 `## Q<번호> · <스테이지>` 로 시작하고, 답은 `[Answer]:` 뒤에 적는다. 답이 없으면 다음으로 넘어가지 않는다. -->\n",
    );
  }
  saveActive(repoRoot, { id: order.id, spec: specPath, target: chosen, phase: "analysis", branch, base });
  return `시작했습니다: ${order.id} · ${order.title} (${order.kind}, 대상 ${chosen})\n${branchNote}\n\n${status(repoRoot)}`;
}

// ---- status ----

function nextHint(work: Work): string {
  const { repoRoot, active } = work;
  const open = unansweredQuestions(repoRoot, questionsFile(active.id)).length;
  if (open > 0) {
    return `답이 없는 질문 ${open}개 — /ca-answer`;
  }
  switch (active.phase) {
    case "analysis":
    case "research":
      return `${PHASE_LABEL[active.phase]}을 마치면 code-agent next`;
    case "plan": {
      if (!work.plan) {
        return `계획 초안을 ${workDocsDir(active.id)}/plan.json 에 쓰고 code-agent plan submit ${workDocsDir(active.id)}/plan.json`;
      }
      const approval = approvalOf(work);
      return approval.status === "approved"
        ? "승인됨 — code-agent next 로 구현 시작"
        : `사람이 별도 터미널에서 code-agent approve (현재: ${approval.status})`;
    }
    case "implement":
      return `단계 ${active.stage} 를 구현한 뒤 code-agent next`;
    case "verify":
      return "검증(code-agent verify)은 아직 구현되지 않았습니다 (P4)";
    case "handoff":
      return "인계를 마치면 code-agent next 로 작업 종료";
  }
}

export function status(repoRoot: string): string {
  const manifest = loadManifestIfAny(repoRoot);
  const checks = checkProjectDocs(repoRoot, manifest);
  const lines = [`code-agent — ${repoRoot}`, "", "프로젝트 문서:", formatDocChecks(checks)];

  const work = loadWork(repoRoot);
  if (!work) {
    const hint = !manifest
      ? "/ca-adopt 로 도입 (레거시) · 신규 프로젝트면 /ca-docs 로 아키텍처·컨벤션부터"
      : !docsReady(checks)
        ? "/ca-docs 로 필수 문서를 갖추세요 — 확정은 별도 터미널에서 code-agent confirm doc <종류>"
        : "/ca-feature <지시서> 로 시작";
    lines.push("", "작업: 없음", `다음: ${hint}`);
    return lines.join("\n");
  }

  const { active, order } = work;
  const flow = PHASES.map((phase) => (phase === active.phase ? `[${phase}]` : phase)).join(" → ");
  const open = unansweredQuestions(repoRoot, questionsFile(active.id));
  lines.push(
    "",
    `작업: ${order.id} · ${order.title} (${order.kind}, 대상 ${active.target})`,
    `지시서: ${active.spec}`,
    `작업 폴더: ${workDocsDir(active.id)}/`,
    `브랜치: ${active.branch ? `${active.branch} (기준 ${active.base})` : "없음"}`,
    `스테이지: ${PHASE_LABEL[active.phase]} — ${flow}`,
  );
  if (active.phase === "implement") {
    const keys = codeStages(work).map((stage) => (stage.key === active.stage ? `[${stage.key}]` : stage.key));
    lines.push(`단계: ${keys.join(" → ")}`);
  }
  lines.push(`질문: ${open.length === 0 ? "답 없는 질문 없음" : open.map((q) => q.id).join(", ") + " 답 없음"}`);
  if (work.plan) {
    lines.push(`계획: 제출됨 · 승인 ${approvalOf(work).status}`);
  } else {
    lines.push("계획: 없음");
  }
  lines.push(`다음: ${nextHint(work)}`);
  return lines.join("\n");
}

// ---- next ----

export function next(repoRoot: string): string {
  const work = requireWork(repoRoot);
  const { active } = work;
  requireDocs(repoRoot, work);
  requireAnswers(repoRoot, active);

  const advance = (phase: Phase, stage?: string): string => {
    saveActive(repoRoot, { ...active, phase, stage });
    return status(repoRoot);
  };

  switch (active.phase) {
    case "analysis":
      return advance("research");
    case "research":
      return advance("plan");
    case "plan": {
      if (!work.plan) {
        throw new Stop("제출된 계획이 없습니다. code-agent plan submit <초안> 으로 제출하세요.");
      }
      const approval = approvalOf(work);
      if (approval.status !== "approved") {
        throw new Stop(`계획이 승인되지 않았습니다 (${approval.status}). 사람이 별도 터미널에서 code-agent approve 를 실행해야 합니다.`);
      }
      return advance("implement", codeStages(work)[0]?.key);
    }
    case "implement": {
      const stages = codeStages(work);
      const index = stages.findIndex((stage) => stage.key === active.stage);
      const stage = stages[index];
      if (stage && work.plan) {
        const present = work.plan.files
          .filter((file) => file.stage === stage.key && existsSync(join(repoRoot, file.path)))
          .map((file) => file.path);
        const missing = missingPlannedFiles(work.plan, stage, present);
        if (missing.length > 0) {
          throw new Stop(
            `단계 ${stage.key} 의 계획 파일이 아직 없습니다:\n` +
              missing.map((violation) => `  - ${violation.file}`).join("\n"),
          );
        }
      }
      const following = stages[index + 1];
      return following ? advance("implement", following.key) : advance("verify");
    }
    case "verify":
      throw new Stop("검증(code-agent verify)은 아직 구현되지 않았습니다 (P4).");
    case "handoff":
      clearActive(repoRoot);
      return `작업을 마쳤습니다: ${active.id}\n\n${status(repoRoot)}`;
  }
}

export function abort(repoRoot: string): string {
  const active = loadActive(repoRoot);
  if (!active) {
    throw new Stop("진행 중인 작업이 없습니다.");
  }
  clearActive(repoRoot);
  return `작업 커서를 지웠습니다: ${active.id}. 작업 폴더·계획·원장은 남아 있습니다 — 같은 지시서로 다시 시작할 수 있습니다.`;
}

// ---- context ----

/**
 * 지금 스테이지에 필요한 것만. 모델이 저장소를 헤매지 않게 코드가 골라 준다 —
 * 참조 코드는 매니페스트대로 결정론적으로 읽고, 긴 문서는 경로만 준다.
 */
export function context(repoRoot: string): string {
  const work = requireWork(repoRoot);
  const { active, manifest, order } = work;
  const out: string[] = [
    `# code-agent context — ${order.id} · ${PHASE_LABEL[active.phase]}`,
    "",
    `- 지시서: ${active.spec} (${order.kind}, 대상 ${active.target})`,
    `- 작업 폴더: ${workDocsDir(active.id)}/ — 분석·질문·작업 문서·계획 초안을 여기에 쓴다`,
    `- 질문: ${questionsFile(active.id)}`,
    `- 아키텍처: ${manifest.docs.architecture ?? "(없음)"}`,
    `- 코드 컨벤션: ${manifest.conventions.join(", ") || "(없음)"}`,
  ];
  if (order.scope.length > 0) out.push(`- scope (건드려도 되는 곳): ${order.scope.join(", ")}`);
  if (order.preserve.length > 0) out.push(`- preserve (바뀌면 안 되는 것): ${order.preserve.join(" / ")}`);

  if (active.phase === "plan") {
    const format = planFormatFor(order.kind);
    out.push(
      "",
      "## 계획 형식",
      `초안을 ${workDocsDir(active.id)}/plan.json 에 쓰고 \`code-agent plan submit ${workDocsDir(active.id)}/plan.json\` 로 제출한다.`,
      "openQuestions 가 남아 있으면 제출되지 않는다 — questions.md 로 옮겨 답을 받는다.",
      "```json",
      format.shape,
      "```",
      "",
      "## 단계 (files[].stage 에 쓰는 key)",
      ...codeStages(work).map(
        (stage) =>
          `- ${stage.key}: ${stage.title} — 위치 ${stage.scope === "project" ? "(저장소 기준) " : ""}${stage.outputDirs.join(", ") || "제한 없음"}` +
          (stage.base ? ` · base ${stage.base}` : ""),
      ),
      "",
      `도메인 위치: ${manifest.domainBase}/{${manifest.domainRoots.join(",")}}/<도메인>/<단계 위치>`,
      `참조 도메인: ${manifest.referenceDomain ?? "(없음)"}`,
    );
  }

  if (active.phase === "implement" && work.stage && work.plan) {
    const stage = work.stage;
    const planned = work.plan.files.filter((file) => file.stage === stage.key);
    out.push("", `## 단계 ${stage.key} — ${stage.title}`, "", "만들 파일 (승인된 계획 — 이 밖은 hook 이 거부한다):");
    out.push(...planned.map((file) => `- ${file.path} — ${file.purpose}`));
    const template = join(repoRoot, stage.template);
    if (existsSync(template)) {
      out.push("", `## 단계 규칙 (${stage.template})`, readFileSync(template, "utf-8").trim());
    }
    if (work.plan.conventions.length > 0) {
      out.push("", "## 이번 계획이 적용하기로 한 규칙");
      out.push(...work.plan.conventions.map((rule) => `- ${rule.rule} (${rule.source})`));
    }
    if (stage.exemplars.length > 0 && manifest.referenceDomain) {
      const exemplars = collectExemplars(repoRoot, manifest, manifest.referenceDomain, stage);
      out.push("", `## 참조 표준 — ${manifest.referenceDomain} (이 구조를 그대로 따른다)`, formatExemplars(exemplars.files, manifest.language));
      if (exemplars.missing.length > 0) out.push("", `찾지 못한 참조: ${exemplars.missing.join(", ")}`);
      for (const omitted of exemplars.omitted) {
        out.push(`내용을 생략한 참조 (${omitted.pattern}): ${omitted.names.join(", ")}`);
      }
    }
  }

  if ((active.phase === "verify" || active.phase === "handoff") && work.plan) {
    out.push("", "## 계획 파일", ...work.plan.files.map((file) => `- [${file.stage}] ${file.path} — ${file.purpose}`));
  }
  return out.join("\n");
}

// ---- plan submit ----

export function submitPlan(repoRoot: string, draft: string): string {
  const work = requireWork(repoRoot);
  const { active, order, manifest } = work;
  if (active.phase !== "plan") {
    throw new Stop(`계획은 plan 스테이지에서 제출합니다 (지금: ${active.phase}).`);
  }
  requireDocs(repoRoot, work);
  requireAnswers(repoRoot, active);

  const format = planFormatFor(order.kind);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(process.cwd(), draft), "utf-8"));
  } catch (error) {
    throw new Stop(`계획 초안을 읽을 수 없습니다: ${error instanceof Error ? error.message : error}`);
  }
  const parsed = format.schema.safeParse(raw);
  if (!parsed.success) {
    throw new Stop(
      "계획 형식이 맞지 않습니다:\n" +
        parsed.error.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n"),
    );
  }
  const plan = format.toPlan(parsed.data);

  const problems: string[] = [];
  if (plan.openQuestions.length > 0) {
    problems.push(`남은 질문이 있습니다 — questions.md 로 옮겨 답을 받으세요: ${plan.openQuestions.join(" / ")}`);
  }
  if (format.requiresPreserve) {
    problems.push(...missingPreserve(order, plan).map((item) => `preserve 가 계획에 없습니다: ${item}`));
  }
  const stages = codeStages(work);
  for (const file of plan.files) {
    const stage = stages.find((candidate) => candidate.key === file.stage);
    if (!stage) {
      problems.push(`${file.path}: 알 수 없는 단계 ${file.stage} (단계: ${stages.map((s) => s.key).join(", ")})`);
      continue;
    }
    for (const violation of checkPaths({ repoRoot, order, manifest, plan, stage, files: [file.path].map((path) => ({ path, content: "" })) })) {
      problems.push(`[${violation.item}] ${violation.file}: ${violation.detail}`);
    }
  }
  if (problems.length > 0) {
    throw new Stop(`계획을 제출하지 않았습니다:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }

  const path = planFile(repoRoot, active.id, active.target);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  return (
    `계획을 제출했습니다.\n\n${formatPlan(plan)}\n\n` +
    "사람이 **별도 터미널**에서 `code-agent approve` 를 실행해야 구현으로 넘어갑니다."
  );
}

// ---- approve / reject ----

export function decide(repoRoot: string, decision: Decision, comment?: string): string {
  const work = requireWork(repoRoot);
  const { active, order, manifest, plan } = work;
  if (!plan) {
    throw new Stop("제출된 계획이 없습니다.");
  }
  if (decision === "rejected" && !comment) {
    throw new Stop("반려에는 사유가 필요합니다: code-agent reject --comment \"사유\"");
  }

  // 확정되지 않은 문서 위의 계획은 승인하지 않는다 — 승인이 묶을 근거가 없다.
  requireDocs(repoRoot, work);
  const docsHash = projectDocsHash(checkProjectDocs(repoRoot, manifest));

  const state = approvalOf(work);
  const shown = [formatPlan(plan)];
  if (state.status === "stale-plan" && state.diff.length > 0) {
    shown.push("", "이전 판정 이후 바뀐 곳:", ...state.diff.map((entry) => `  ${JSON.stringify(entry)}`));
  }
  const presence = confirmOnTerminal(shown.join("\n"), decision === "approved" ? "approve" : "reject");
  recordDecision(repoRoot, {
    order,
    target: active.target,
    plan,
    manifest,
    decision,
    approver: order.approver ?? userInfo().username,
    comment,
    presence,
    docsHash,
  });
  return decision === "approved"
    ? "승인을 원장에 남겼습니다. Claude Code 에서 /ca-next 로 구현을 시작하세요."
    : "반려를 원장에 남겼습니다. 계획을 고쳐 다시 제출해야 합니다.";
}
