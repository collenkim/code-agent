import { isAbsolute, relative, resolve } from "path";

import { checkApproval } from "../core/approval";
import { checkPaths, unplannedFiles } from "../core/gate";
import { canonical, STATE_DIR, workDocsDir } from "./layout";
import { loadWork } from "./work";
import type { Work } from "./work";

/**
 * Claude Code PreToolUse hook 의 판정.
 *
 * 규칙 대조라 모델에게 맡기지 않는다. 거부 사유는 모델에게 그대로 보이므로, 무엇을 하면 풀리는지까지 적는다.
 * 진행 중인 작업이 없으면 관여하지 않는다 — code-agent 로 하는 작업이 아닐 때까지 막을 이유는 없다.
 */
export interface HookInput {
  cwd: string;
  tool_name: string;
  tool_input: { file_path?: string; notebook_path?: string; command?: string };
}

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** 셸 연결·리다이렉트·치환. 허용 목록의 명령 뒤에 무엇이든 붙일 수 있게 되는 자리다 */
const SHELL_META = /[;&|<>`\n]|\$\(/;

const READONLY_GIT = /^git (status|diff|log|show|branch)(\s|$)/;

export function decide(input: HookInput, projectDir?: string): string | undefined {
  const repoRoot = canonical(projectDir ?? input.cwd);
  const work = loadWork(repoRoot);
  if (!work) {
    return undefined;
  }
  if (input.tool_name === "Bash") {
    return decideBash(work, (input.tool_input.command ?? "").trim());
  }
  if (!WRITE_TOOLS.includes(input.tool_name)) {
    return undefined;
  }
  const target = input.tool_input.file_path ?? input.tool_input.notebook_path ?? "";
  return decideWrite(work, target);
}

function decideBash(work: Work, command: string): string | undefined {
  const declared = [
    work.manifest.build,
    work.manifest.test,
    ...Object.values(work.manifest.commands),
  ]
    .filter((argv): argv is string[] => Array.isArray(argv) && argv.length > 0)
    .map((argv) => argv.join(" "));

  const allowed =
    !SHELL_META.test(command) &&
    (command === "code-agent" ||
      command.startsWith("code-agent ") ||
      declared.includes(command) ||
      READONLY_GIT.test(command));
  if (allowed) {
    return undefined;
  }
  return (
    "작업 중에는 Bash 로 code-agent 명령, 선언된 명령" +
    (declared.length > 0 ? ` (${declared.join(" / ")})` : "") +
    ", 읽기용 git(status·diff·log·show·branch)만 실행할 수 있습니다. 연결·리다이렉트(; && | >)는 안 됩니다. " +
    "파일은 Write/Edit 로 고치고, 읽기는 Read/Grep/Glob 을 쓰세요."
  );
}

function decideWrite(work: Work, target: string): string | undefined {
  const { repoRoot, active } = work;
  const absolute = isAbsolute(target) ? target : resolve(repoRoot, target);
  const path = relative(repoRoot, canonical(absolute)).replace(/\\/g, "/");

  if (path === "" || path.startsWith("..") || isAbsolute(path)) {
    return `저장소 밖의 파일입니다: ${target}`;
  }
  if (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`)) {
    return (
      "작업 상태·제출된 계획·승인 기록은 도구로 고칠 수 없습니다. " +
      "진행은 code-agent next, 계획은 code-agent plan submit 으로 바뀝니다."
    );
  }
  // 작업 폴더(분석·질문·작업 문서·계획 초안)는 어느 스테이지에서든 쓴다.
  const workDir = workDocsDir(active.id);
  if (path === workDir || path.startsWith(`${workDir}/`)) {
    return undefined;
  }

  if (active.phase === "analysis" || active.phase === "research" || active.phase === "plan") {
    return (
      `지금은 ${active.phase} 스테이지라 작업 폴더(${workDir}/) 밖은 쓸 수 없습니다. ` +
      "코드는 계획이 승인된 뒤 implement 스테이지에서 씁니다."
    );
  }
  if (active.phase === "handoff") {
    return "인계 스테이지에서는 코드를 고치지 않습니다. 고칠 것이 있으면 사람에게 알리세요.";
  }

  const { plan, order, manifest } = work;
  if (!plan) {
    return "제출된 계획이 없습니다. code-agent plan submit 으로 계획을 제출하고 승인을 받아야 합니다.";
  }
  const approval = checkApproval(repoRoot, order, plan, active.target, {
    manifest,
    requireVerifiedApproval: manifest.workOrder.requireVerifiedApproval,
  });
  if (approval.status !== "approved") {
    return (
      `계획이 승인되지 않았습니다 (${approval.status}). ` +
      "사람이 별도 터미널에서 code-agent approve 를 실행해야 쓸 수 있습니다."
    );
  }

  // implement 는 지금 단계의 파일만. verify 는 고쳐 쓰는 자리라 계획의 어느 단계 파일이든, 그 파일의 단계 규칙으로.
  const stage =
    active.phase === "implement"
      ? work.stage
      : work.stages.find((candidate) =>
          plan.files.some((file) => file.stage === candidate.key && file.path === path),
        );
  if (!stage) {
    return active.phase === "implement"
      ? `지금 단계(${active.stage ?? "없음"})를 매니페스트에서 찾을 수 없습니다. code-agent status 로 확인하세요.`
      : `승인된 계획에 없는 파일입니다: ${path}. 필요하면 사람에게 알리세요 — 계획을 고치면 재승인을 받습니다.`;
  }
  const violations = [
    ...checkPaths({ repoRoot, order, manifest, plan, stage, files: [{ path, content: "" }] }),
    ...unplannedFiles(plan, stage, [path]),
  ];
  if (violations.length > 0) {
    return violations.map((v) => `[${v.item}] ${v.file}: ${v.detail}`).join("\n");
  }
  return undefined;
}

/** stdin 으로 받아 stdout 으로 낸다. 판정 자체가 실패하면 exit 2 — 막는 쪽으로 닫는다 */
export function runHook(stdin: string): number {
  try {
    const reason = decide(JSON.parse(stdin) as HookInput, process.env.CLAUDE_PROJECT_DIR);
    if (reason) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
    }
    return 0;
  } catch (error) {
    process.stderr.write(
      `code-agent hook 이 판정에 실패해 막았습니다: ${error instanceof Error ? error.message : error}\n`,
    );
    return 2;
  }
}
