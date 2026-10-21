import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join, resolve, relative, isAbsolute } from "path";
import { execFileSync } from "child_process";
import { PlanSchema } from "../core/plan";
import { checkPaths } from "../core/gate";
import { filePaths, fileOperationProblems } from "../core/fileOperations";
import type { BuildPlan, PlannedFile } from "../core/types";
import { loadWork, type Work } from "./work";
import { Stop } from "./stop";
import { runtimeHost } from "./crossEnv";

/** 분석 단계에서도 실행한다. 이동의 원본·대상 모두 기존 경계 안이어야 한다. */
export function preflightFiles(work: Work, files: PlannedFile[], plan?: BuildPlan): string[] {
  const problems = fileOperationProblems(files);
  if (problems.length) return problems;
  if (files.some(file => file.operation)) {
    try { execFileSync("git", ["cat-file", "-e", `${work.active.baseCommit}^{commit}`], { cwd: work.repoRoot, stdio: "ignore", windowsHide: true }); }
    catch { return ["파일 작업 사전 검사의 기준 커밋을 읽을 수 없습니다."]; }
  }
  for (const file of files) {
    const stage = work.stages.find(s => s.key === file.stage);
    if (!stage) { problems.push(`알 수 없는 파일 단계: ${file.stage}`); continue; }
    const domainRoot = work.manifest.domainRoots.find(root => file.path.startsWith(`${work.manifest.domainBase}/${root}/${work.active.target}/`)) ?? "";
    const candidate = plan ?? { domainRoot, domainDirName: work.active.target, files } as BuildPlan;
    problems.push(...checkPaths({ repoRoot: work.repoRoot, order: work.order, manifest: work.manifest, plan: candidate, stage,
      files: filePaths(file).map(path => ({ path, content: "" })) }).map(v => `${v.file}: ${v.detail}`));
    if (!file.operation) continue;
    if (!work.active.baseCommit) { problems.push("파일 작업 사전 검사에 기준 커밋이 필요합니다"); continue; }
    const typeAtBase = (path: string): string => {
      try { return execFileSync("git", ["cat-file", "-t", `${work.active.baseCommit}:${path}`], { cwd: work.repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim(); }
      catch { return "missing"; }
    };
    const source = file.operation === "move" ? file.from! : file.path;
    if (file.operation !== "create" && typeAtBase(source) !== "blob") problems.push(`기준 커밋에 원본 파일이 없습니다: ${source}`);
    if (["create", "move"].includes(file.operation) && typeAtBase(file.path) !== "missing") problems.push(`생성·이동 대상이 기준 커밋에 이미 있습니다: ${file.path}`);
  }
  return problems;
}
export function inspectFiles(root: string, path: string): string {
  const work = loadWork(root);
  if (!work) throw new Stop("진행 중인 작업의 분석 단계부터 파일 작업을 검사할 수 있습니다.");
  const input = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const files = PlanSchema.shape.files.parse(Array.isArray(input) ? input : input.files);
  const problems = preflightFiles(work, files);
  if (problems.length) throw new Stop(`파일 작업 사전 검사 실패:\n${problems.join("\n")}`);
  return "파일 작업 사전 검사 통과 — 이 결과는 계획 승인이나 파일 변경이 아닙니다.";
}
/** 승인된 현재 Task의 삭제·이동만 수행한다. 대상 덮어쓰기·디렉터리 삭제·링크 경유는 허용하지 않는다. */
export function applyFileOperations(root: string): string {
  const work = loadWork(root);
  if (!work?.plan || work.active.phase !== "implement") throw new Stop("승인된 구현 단계에서만 파일 삭제·이동을 수행합니다.");
  const plan = work.plan, task = plan.tasks?.find(t => t.id === work.active.task);
  if (plan.tasks?.length && (!task || task.stage !== work.active.stage)) throw new Stop("현재 구현 Task가 승인된 계획의 단계와 일치하지 않습니다.");
  const files = plan.files.filter(f => (task ? task.files.includes(f.path) : f.stage === work.active.stage) && ["delete", "move"].includes(f.operation ?? ""));
  const problems = preflightFiles(work, plan.files, plan);
  if (problems.length) throw new Stop(problems.join("\n"));
  const pending: PlannedFile[] = [];
  for (const file of files) {
    for (const path of filePaths(file)) {
      const full = resolve(root, path), rel = relative(resolve(root), full);
      if (isAbsolute(rel) || rel.startsWith("..")) throw new Stop(`저장소 밖 경로: ${path}`);
      for (let part = full; part !== resolve(root); part = dirname(part)) {
        let linked = false;
        try { linked = lstatSync(part).isSymbolicLink(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (linked) throw new Stop(`링크 경유 파일 작업은 지원하지 않습니다: ${path}`);
      }
      const { decide } = require("./hook") as typeof import("./hook");
      const host = runtimeHost();
      const session = host === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID;
      const denied = decide({ cwd: root, host, session_id: session, tool_name: "Write", tool_input: { file_path: full } }, root);
      if (denied) throw new Stop(denied);
    }
    const source = join(root, file.from ?? file.path);
    if (!existsSync(source)) {
      if (file.operation === "delete" || existsSync(join(root, file.path))) continue;
      throw new Stop(`이동 원본과 대상이 모두 없습니다: ${file.from}`);
    }
    if (!lstatSync(source).isFile()) throw new Stop(`일반 파일만 삭제·이동할 수 있습니다: ${source}`);
    if (file.operation === "move" && existsSync(join(root, file.path))) throw new Stop(`이동 대상을 덮어쓰지 않습니다: ${file.path}`);
    pending.push(file);
  }
  for (const file of pending) {
    if (file.operation === "delete") unlinkSync(join(root, file.path));
    else { mkdirSync(dirname(join(root, file.path)), { recursive: true }); renameSync(join(root, file.from!), join(root, file.path)); }
  }
  return `승인된 파일 삭제·이동 ${pending.length}건 수행 — 내용 수정과 검증을 이어가세요.`;
}
