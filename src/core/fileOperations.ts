import type { BuildPlan, PlannedFile } from "./types";

/** path는 최종 경로(삭제는 원본), from은 이동 원본이다. 생략은 기존 생성·수정 계획이다. */
export function filePaths(file: PlannedFile): string[] {
  return file.operation === "move" && file.from ? [file.from, file.path] : [file.path];
}
export function taskPaths(plan: BuildPlan, paths: string[]): string[] {
  return plan.files.filter(file => paths.includes(file.path)).flatMap(filePaths);
}
export function fileOperationProblems(files: PlannedFile[]): string[] {
  const problems: string[] = [], seen = new Set<string>();
  for (const file of files) {
    if (file.operation === "move" ? !file.from || file.from === file.path : file.from !== undefined) problems.push(`이동 계획은 서로 다른 from·path가 필요하고 다른 작업에는 from을 쓰지 않습니다: ${file.path}`);
    for (const path of filePaths(file)) {
      if (!path || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) problems.push(`계획 파일은 정규화된 저장소 상대경로여야 합니다: ${path}`);
      if (seen.has(path)) problems.push(`계획의 파일 작업이 겹칩니다: ${path}`);
      seen.add(path);
    }
  }
  return problems;
}
/** 존재 여부만으로 작업 완료를 보장하지 않는다. 변경 대조·검증 게이트도 함께 통과해야 한다. */
export function fileOutcomeProblems(files: PlannedFile[], exists: (path: string) => boolean): string[] {
  return files.flatMap(file => {
    if (file.operation === "delete") return exists(file.path) ? [`삭제할 파일이 남아 있습니다: ${file.path}`] : [];
    return [...(!exists(file.path) ? [`계획에 있는데 없는 파일: ${file.path}`] : []),
      ...(file.operation === "move" && file.from && exists(file.from) ? [`이동 원본이 남아 있습니다: ${file.from}`] : [])];
  });
}
export function fileLabel(file: PlannedFile): string {
  return `${file.operation ?? "생성·수정"} ${file.from ? `${file.from} → ` : ""}${file.path}`;
}
