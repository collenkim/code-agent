import { failedRuns, loadEvidence, runsOf, testFrozen, testStageFiles, type Evidence } from "./evidence";
import { writeHandoff } from "./handoff";
import { budgetText, type VerifyBudget } from "./retryPolicy";
import { shortCommand } from "./screenText";
import { trackedTestFiles } from "./testFiles";
import type { Work } from "./work";
import { parseTestCases, readWorkDoc } from "./workDocs";

/**
 * 검증 수정 배정 파일 — `verify` 가 repair 로 끝나면 원인 단위 수정에 필요한 것을 코드가 모아 handoff 에 쓴다:
 * 실패한 명령·로그 경로, 실패 TC → AC → 계획 Task·파일, 로그 꼬리에 이름이 나온 계획 파일, 고칠 수 없는 테스트 파일, 남은 회차.
 * 메인은 이 경로만 수정 담당에게 넘기고 실패 내용을 옮겨 쓰지 않는다. 고칠 수 있는 범위는 그대로 계획 파일·동결 규칙(hook)이 정한다 —
 * 이 파일은 범위를 넓히지 않고, 같은 원인을 한 담당이 함께 고치게 묶음을 보여 줄 뿐이다.
 */
export function writeRepairHandoff(work: Work, problems: string[], budget?: VerifyBudget): string | undefined {
  const evidence = loadEvidence(work.repoRoot, work.active.id, work.active.target);
  if (!evidence || !work.plan) return undefined;
  return writeHandoff(work.repoRoot, work.active.id, `repair-${evidence.rounds}.md`, repairText(work, evidence, problems, budget));
}

function repairText(work: Work, evidence: Evidence, problems: string[], budget?: VerifyBudget): string {
  const plan = work.plan!;
  const planned = plan.files.map((file) => file.path);
  const runs = (["check", "test", "integrate"] as const).flatMap((phase) => failedRuns(runsOf(evidence, phase)));
  const lines = [
    `# 검증 수정 — ${work.active.id} · ${work.active.target} · 회차 ${evidence.rounds}`,
    "",
    "이 파일이 수정 담당의 입력이다. 원인 하나를 한 담당이 맡는다 — 같은 원인에 닿는 계획 파일은 함께 고친다. 아래에 없는 파일·계획 밖은 고치지 않고 보고한다.",
    "검증 명령·단언·기대값을 약하게 만들어 통과시키지 않는다. 고친 뒤 메인이 `code-agent verify --json` 으로 check 부터 다시 돈다.",
    "",
    "## 실패한 명령",
    "",
    ...(runs.length ? runs.map((run) => `- ${run.phase}·${run.kind}: ${run.outcome}${run.command ? ` (${shortCommand(run.command)})` : ""}${run.logFile ? ` · 전체 로그 ${run.logFile}` : ""}`) : ["- (실패한 실행 기록 없음 — 아래 문제를 본다)"]),
  ];
  // 실패한 명령 줄을 되풀이하는 문제는 뺀다 — 남는 것은 TC 대조·게이트 문제다
  const rest = problems.filter((problem) => !runs.some((run) => problem.startsWith(`${run.kind}: ${run.outcome}`)));
  if (rest.length) lines.push("", "## 문제", "", ...rest.map((problem) => `- ${problem}`));
  // 로그 꼬리에 경로가 나온 계획 파일 — 컴파일·정적 분석 오류가 가리키는 자리다
  const named = planned.filter((path) => runs.some((run) => run.tail.replace(/\\/g, "/").includes(path)));
  if (named.length) lines.push("", "## 로그에 나온 계획 파일", "", ...named.map((path) => `- ${path}`));

  const spec = readWorkDoc(work.repoRoot, work.active.id, "07-test-spec");
  const cases = spec ? parseTestCases(spec) : [];
  const failing = evidence.testCases.filter((entry) => entry.status && entry.status !== "passed" && entry.status !== "unknown");
  if (failing.length) {
    lines.push("", "## 실패한 TC → AC → 계획 Task", "", "| TC | 결과 | AC | 케이스 → 기대 결과 | Task · 파일 |", "|---|---|---|---|---|");
    for (const entry of failing) {
      const tc = cases.find((item) => item.id === entry.id);
      const tasks = (plan.tasks ?? []).filter((task) => task.acceptance.some((ac) => tc?.acceptance.includes(ac)));
      const cell = (text: string) => text.replace(/\|/g, "\\|");
      lines.push(`| ${entry.id} | ${entry.status} | ${tc?.acceptance.join(", ") ?? "-"} | ${cell(tc ? `${tc.scenario} → ${tc.expected}` : "-")} | ` +
        `${tasks.map((task) => `${task.id}: ${task.files.join(", ")}`).join(" · ") || "-"} |`);
    }
  }
  const frozen = [...new Set([...(testFrozen(evidence) ? testStageFiles(work) : []), ...(work.order.kind === "refactor" ? trackedTestFiles(work) : [])])];
  lines.push("", "## 고칠 수 있는 범위", "", `- 계획 파일: ${planned.join(", ")}`);
  if (frozen.length) lines.push(`- 고칠 수 없는 테스트 파일(동결·기존 테스트): ${frozen.join(", ")} — 실패가 테스트 탓으로 보이면 고치지 않고 근거와 함께 보고한다`);
  if (budget) lines.push(`- 남은 회차: ${budgetText(budget)}`);
  return `${lines.join("\n")}\n`;
}
