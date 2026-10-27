/** 임시 저장소의 파일·Git·hook 도우미. 질문 관찰 등 시험별 동작은 호출 쪽에 둔다. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const PASS = ["node", "-e", "process.exit(0)"];
export const NOT_INSTALLED = ["code-agent-does-not-exist-on-this-machine"];

export function writeFixture(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

export function gitFixture(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}

export function repoTools(root: () => string) {
  const write = (file: string, text: string): void => writeFixture(root(), file, text);
  const git = (...args: string[]): string => gitFixture(root(), "-c", "user.name=t", "-c", "user.email=t@t", ...args);
  const hook = (tool: string, input: Record<string, string>): string | undefined => {
    const { decide } = require("../agent/hook") as typeof import("../agent/hook");
    return decide({ cwd: root(), tool_name: tool, tool_input: input });
  };
  const writeFileHook = (file: string): string | undefined => hook("Write", { file_path: join(root(), file) });
  const confirmDocs = (): void => {
    const { checkProjectDocs, recordDocConfirmation } = require("../agent/docs") as typeof import("../agent/docs");
    const { loadManifestIfAny } = require("../agent/work") as typeof import("../agent/work");
    for (const entry of checkProjectDocs(root(), loadManifestIfAny(root()))) {
      recordDocConfirmation(root(), entry, "test", { channel: "tty", verified: true, detail: "테스트" });
    }
  };
  return { write, git, hook, writeFileHook, confirmDocs };
}

const created = new Set<string>();
export function createRepo(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.add(root);
  gitFixture(root, "init", "-q", "-b", "master");
  gitFixture(root, "config", "user.name", "t");
  gitFixture(root, "config", "user.email", "t@t");
  return root;
}

export function removeRepo(root: string): void {
  if (!created.has(root)) throw new Error("이 도우미가 만든 임시 저장소만 지울 수 있습니다.");
  rmSync(root, { recursive: true, force: true });
  created.delete(root);
}
