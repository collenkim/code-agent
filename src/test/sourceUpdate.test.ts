/**
 * 새 버전 설치(릴리스 저장소) — Git 소스의 upstream 커밋을 **실행 중인 설치 폴더를 건드리지 않고** 별도 폴더에 설치·검증·등록하고,
 * 그 릴리스의 CLI 가 스스로 적용하게 한다. Git·빌드·자식 실행은 실제이고 의존성 설치만 바꿔 끼운다.
 * 적용 자체(템플릿·예약·잠금)는 runtimeRelease.test.ts 가 실제 code-agent 릴리스로 본다.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { installGitRelease, listReleases, lockStore } from "../agent/releaseStore";
import { entryScript, installedRelease } from "../agent/runtimeSelect";
import { previewSourceUpdate, sourceUpdateSnapshot, updateFromSource, type SourceUpdateOptions } from "../agent/update";

let root: string;
let remote: string;
let seed: string;
let source: string;
let target: string;
let home: string;
let calls: { args: string[]; cwd: string }[];
let savedHome: string | undefined;

function write(base: string, file: string, value: string): void {
  mkdirSync(dirname(join(base, file)), { recursive: true });
  writeFileSync(join(base, file), value);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-config") },
  }).trim();
}

function identity(cwd: string): void {
  git(cwd, "config", "user.name", "Source Update Test");
  git(cwd, "config", "user.email", "source-update@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "config", "core.autocrlf", "false");
}

function commit(cwd: string, message: string): void {
  git(cwd, "add", "--all");
  git(cwd, "commit", "-m", message);
}

/**
 * 독립 빌드되는 작은 CLI — 어느 릴리스가 어떤 인자·환경으로 불렸는지 대상 프로젝트에 남긴다.
 * applyExit: 적용 명령의 종료 코드(0 적용 · 3 예약 · 1 실패)
 */
function cli(version: string, applyExit = 0, doctorExit = 0): string {
  return `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('child-invocations.jsonl', JSON.stringify({args, pid: process.pid, version: ${JSON.stringify(version)}, self: process.env.CODE_AGENT_RUNTIME_SELF, entry: process.env.CODE_AGENT_ENTRY, dir: __dirname}) + '\\n');
if (args[0] === 'help') console.log('code-agent fixture ${version}');
else if (args[0] === 'update' && args[1] === '--apply-release') {
  if (${applyExit} === 0) fs.writeFileSync('applied-version', ${JSON.stringify(version)});
  console.log(${applyExit} === 3 ? 'fixture reserved ${version}' : 'fixture applied ${version}');
  process.exitCode = ${applyExit};
} else if (args[0] === 'doctor') {
  console.log('doctor ${version}: ${doctorExit ? "failed" : "ok"}');
  process.exitCode = ${doctorExit};
} else throw new Error('unexpected command ' + args.join(' '));
`;
}

function publish(version: string, applyExit = 0, doctorExit = 0): string {
  write(seed, "cli-entry.js", cli(version, applyExit, doctorExit));
  write(seed, "template/value", `template ${version}`);
  commit(seed, version);
  git(seed, "push", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}

function options(): SourceUpdateOptions {
  return {
    sourceRoot: source,
    runNpm(args, cwd) {
      calls.push({ args: [...args], cwd });
      if (args[0] === "ci") write(cwd, "node_modules/.package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {} }));
      else if (args[0] === "run") execFileSync(process.execPath, ["build.js"], { cwd, windowsHide: true });
      return `ran npm ${args.join(" ")}`;
    },
  };
}

function invocations(): { args: string[]; version: string; self?: string; entry?: string; dir: string; pid: number }[] {
  const file = join(target, "child-invocations.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

const releaseId = (commitId: string) => `1.0.0-${commitId.slice(0, 12)}`;
const storeEntries = () => existsSync(home) ? readdirSync(home).filter((name) => name !== "install.lock") : [];

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca source update ")));
  remote = join(root, "upstream.git");
  seed = join(root, "publisher");
  source = join(root, "source install");
  target = join(root, "user project");
  home = join(root, "release store");
  savedHome = process.env.CODE_AGENT_RELEASE_HOME;
  process.env.CODE_AGENT_RELEASE_HOME = home;
  calls = [];
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, seed);
  identity(seed);
  write(seed, ".gitignore", "node_modules/\ndist/\n.code-agent/\n");
  write(seed, ".npmrc", "audit=false\nfund=false\noffline=true\n");
  write(seed, "package.json", JSON.stringify({ name: "source-update-fixture", version: "1.0.0", scripts: { build: "node build.js", prepare: "node build.js" } }));
  write(seed, "package-lock.json", JSON.stringify({ name: "source-update-fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "source-update-fixture", version: "1.0.0" } } }));
  write(seed, "build.js", "const fs = require('node:fs'); fs.mkdirSync('dist/agent', {recursive: true}); fs.copyFileSync('cli-entry.js', 'dist/agent/cli.js');");
  publish("old");
  git(root, "clone", remote, source);
  identity(source);
  execFileSync(process.execPath, ["build.js"], { cwd: source, windowsHide: true });
  mkdirSync(target);
  git(target, "init", "--initial-branch=main");
  identity(target);
  write(target, "user.txt", "user work stays here");
  commit(target, "user baseline");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.CODE_AGENT_RELEASE_HOME; else process.env.CODE_AGENT_RELEASE_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

test("미리보기는 설치된 소스만 로컬로 본다 — fetch·쓰기·npm 없음, 소스 폴더는 그대로 둔다고 알린다", () => {
  publish("new");
  git(source, "remote", "set-url", "origin", join(root, "unreachable.git"));
  const before = git(source, "rev-parse", "HEAD");
  const preview = previewSourceUpdate(target, options());
  assert.match(preview, /설치 유형: git-source/);
  assert.ok(preview.includes(source));
  assert.match(preview, /브랜치: main/);
  assert.match(preview, /upstream: refs\/remotes\/origin\/main/);
  assert.match(preview, /소스 폴더 커밋: [0-9a-f]{40} \(그대로 둡니다\)/);
  assert.match(preview, /이 프로젝트 적용 버전: 진입점 번들/);
  assert.ok(preview.includes(`릴리스 저장소: ${home} (설치된 릴리스 0개)`));
  assert.match(preview, /별도 폴더에 그 커밋을 꺼내[\s\S]*진행 중인 일이 있으면 다음 작업부터/);
  assert.match(preview, /실행 중인 설치 폴더·소스 폴더·다른 프로젝트를 바꾸지 않습니다/);
  assert.match(preview, /prepare/);
  assert.equal(git(source, "rev-parse", "HEAD"), before);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
  assert.equal(existsSync(home), false);
  assert.deepEqual(calls, []);
});

test("한 번에 — upstream 커밋을 별도 폴더에 설치·검증·등록하고 그 릴리스가 스스로 적용한 뒤 그 릴리스로 점검한다. 소스의 브랜치·색인·작업 트리는 그대로다", () => {
  const published = publish("new");
  // 소스 폴더의 사람 변경(미추적·스테이징·수정) — 더는 막지 않고 건드리지도 않는다
  write(source, "notes.txt", "untracked note");
  write(source, "template/value", "unstaged edit");
  write(source, "staged.txt", "staged");
  git(source, "add", "staged.txt");
  const sourceHead = git(source, "rev-parse", "HEAD"), sourceStatus = git(source, "status", "--porcelain");
  write(target, "user.txt", "uncommitted target change");
  const targetHead = git(target, "rev-parse", "HEAD");

  const report = updateFromSource(target, options());

  assert.equal(git(source, "rev-parse", "HEAD"), sourceHead, "소스 폴더의 브랜치는 그대로다(pull 하지 않는다)");
  assert.equal(git(source, "status", "--porcelain"), sourceStatus, "소스 폴더의 색인·작업 트리는 그대로다");
  assert.equal(readFileSync(join(source, "template/value"), "utf8"), "unstaged edit");
  assert.equal(readFileSync(join(source, "dist/agent/cli.js"), "utf8"), cli("old"), "실행 중인 설치의 빌드 결과를 다시 쓰지 않는다");
  const id = releaseId(published);
  const release = installedRelease(id, home)!;
  assert.ok(release, "검증을 마친 릴리스만 등록된다");
  assert.deepEqual(storeEntries(), [id], "임시 폴더가 남지 않는다");
  assert.deepEqual(release.info.source, { kind: "git", commit: published, tree: git(seed, "rev-parse", "HEAD^{tree}"), remote: "origin", ref: "refs/heads/main" });
  assert.match(release.info.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(release.info.version, "1.0.0");
  assert.equal(readFileSync(join(release.dir, "template/value"), "utf8"), "template new", "받은 커밋의 내용이다(소스 폴더의 수정이 아니다)");
  assert.deepEqual(calls.map((call) => call.args), [["ci", "--include=dev"], ["run", "build"], ["prune", "--omit=dev"]]);
  assert.ok(calls.every((call) => call.cwd.startsWith(join(home, ".staging-"))), "의존성 설치·빌드는 저장소의 임시 폴더에서만 돈다");

  const children = invocations();
  assert.deepEqual(children.map((child) => child.args), [["update", "--apply-release", id, "--trigger", "update"], ["doctor"]]);
  assert.ok(children.every((child) => child.version === "new" && child.pid !== process.pid && child.dir === join(release.dir, "dist", "agent")),
    "적용·점검은 새 릴리스의 CLI 가 자기 코드로 한다 — 이 프로세스가 다른 버전의 모듈을 읽지 않는다");
  assert.ok(children.every((child) => child.self === "1" && child.entry === entryScript()), "고르지 말고 스스로 돌라는 표지와 고정 진입점을 넘긴다");
  assert.equal(readFileSync(join(target, "applied-version"), "utf8"), "new");
  assert.equal(git(target, "rev-parse", "HEAD"), targetHead);
  assert.equal(readFileSync(join(target, "user.txt"), "utf8"), "uncommitted target change");
  assert.match(report, /fixture applied new/);
  assert.match(report, /doctor new: ok/);
});

test("같은 커밋은 다시 빌드하지 않고, 이미 적용된 버전이면 적용도 하지 않는다", () => {
  const published = publish("new");
  updateFromSource(target, options());
  calls = [];
  rmSync(join(target, "child-invocations.jsonl"));
  const again = updateFromSource(target, options());
  assert.deepEqual(calls, [], "설치된 커밋은 의존성 설치·빌드를 다시 돌리지 않는다");
  assert.match(again, /이미 설치되어 있습니다/);
  assert.deepEqual(invocations().map((child) => child.args[0]), ["update", "doctor"], "이 프로젝트에 적용 기록이 없으면 적용은 다시 부른다");
  write(target, ".code-agent/runtime.json", JSON.stringify({ schema: 1, applied: releaseId(published) }));
  rmSync(join(target, "child-invocations.jsonl"));
  assert.match(updateFromSource(target, options()), /이미 적용된 버전입니다/);
  assert.deepEqual(invocations(), []);
});

test("의존성 설치·빌드·검증 실패 — 아무것도 등록하지 않고 임시 폴더를 치우며 적용 버전을 바꾸지 않는다", () => {
  publish("new");
  for (const step of ["ci", "run"]) {
    calls = [];
    assert.throws(() => updateFromSource(target, {
      ...options(), runNpm(args) {
        calls.push({ args: [...args], cwd: "" });
        if (args[0] === step) throw new Error(`${step} failed`);
      },
    }), (error: Error) => error.message.includes(`${step} failed`) && error.message.includes("적용 버전은 바뀌지 않았고"));
    assert.deepEqual(storeEntries(), []);
    assert.deepEqual(listReleases(home), []);
    assert.equal(existsSync(join(target, ".code-agent/runtime.json")), false);
    assert.deepEqual(invocations(), []);
  }
  // 빌드는 됐지만 실행 검사(help)가 실패하는 커밋
  write(seed, "cli-entry.js", "process.exitCode = 1;\n");
  commit(seed, "broken");
  git(seed, "push", "origin", "main");
  assert.throws(() => updateFromSource(target, options()), /새 버전 실행 검사 실패/);
  assert.deepEqual(storeEntries(), []);
});

test("새 릴리스가 적용을 예약하면(진행 중인 일) 점검은 돌리지 않고 예약 보고를 낸다 · 적용이 실패하면 지금 버전으로 계속 돈다고 알린다", () => {
  publish("new", 3);
  const reserved = updateFromSource(target, options());
  assert.match(reserved, /fixture reserved new/);
  assert.deepEqual(invocations().map((child) => child.args[0]), ["update"], "예약이면 doctor 를 부르지 않는다");
  publish("newer", 1);
  assert.throws(() => updateFromSource(target, options()),
    (error: Error) => /새 버전 적용 단계에서 중단했습니다\. 이 프로젝트의 적용 버전은 바뀌지 않았고/.test(error.message) && /적용에 실패했습니다 — 지금 버전으로 계속 돕니다/.test(error.message));
  assert.equal(listReleases(home).length, 2, "설치·검증을 마친 릴리스는 남는다 — 나중에 다시 적용할 수 있다");
});

test("점검 실패는 적용이 끝난 뒤의 문제로 보고한다", () => {
  publish("new", 0, 1);
  const report = updateFromSource(target, options());
  assert.match(report, /doctor \(적용 완료 후 점검\) — 문제가 있습니다[\s\S]*doctor new: failed/);
  assert.equal(readFileSync(join(target, "applied-version"), "utf8"), "new");
});

test("동시 설치 — 같은 저장소에 다른 설치가 돌면 기다리다 멈추고 아무것도 받지 않는다", () => {
  publish("new");
  const release = lockStore(home);
  try {
    assert.throws(() => updateFromSource(target, options()), /다른 code-agent 갱신이 같은 릴리스 저장소에 설치하는 중/);
  } finally { release(); }
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
  assert.deepEqual(calls, []);
});

test("끊긴 설치 — 임시 폴더와 기록 없는 폴더는 고르지 않고, 다음 설치가 임시 폴더를 치운다", () => {
  const published = publish("new");
  const staging = join(home, ".staging-1.0.0-0123456789ab-99999999-deadbeef");
  write(staging, "dist/agent/cli.js", "half written");
  write(join(home, "1.0.0-0123456789ab"), "dist/agent/cli.js", "no release.json");
  assert.deepEqual(listReleases(home), []);
  assert.equal(installedRelease("1.0.0-0123456789ab", home), undefined, "release.json 이 없는 폴더는 설치된 릴리스가 아니다");
  write(target, ".code-agent/runtime.json", JSON.stringify({ schema: 1, applied: "1.0.0-0123456789ab" }));
  const report = updateFromSource(target, options());
  assert.match(report, /끊긴 설치의 임시 폴더 1개를 치웠습니다/);
  assert.equal(existsSync(staging), false);
  assert.deepEqual(listReleases(home).map((info) => info.id), [releaseId(published)]);
});

test("동의 미리보기 이후 소스 HEAD·remote 가 바뀌면 fetch 전에 멈춘다", () => {
  const expectedSourceSnapshot = sourceUpdateSnapshot(target, options());
  assert.ok(previewSourceUpdate(target, options()).includes(expectedSourceSnapshot));
  write(source, "saved-work", "a local commit after preview");
  commit(source, "new local HEAD");
  assert.throws(() => updateFromSource(target, { ...options(), expectedSourceSnapshot }), /동의 미리보기 이후/);
  const next = sourceUpdateSnapshot(target, options());
  git(source, "remote", "set-url", "origin", join(root, "changed.git"));
  assert.notEqual(sourceUpdateSnapshot(target, options()), next);
  assert.throws(() => updateFromSource(target, { ...options(), expectedSourceSnapshot: next }), /동의 미리보기 이후/);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
  assert.deepEqual(calls, []);
});

test("upstream 이 없거나 detached HEAD 면 받지 않는다", () => {
  git(source, "branch", "--unset-upstream");
  assert.throws(() => updateFromSource(target, options()), /upstream 이 필요/);
  git(source, "checkout", "--detach");
  assert.throws(() => updateFromSource(target, options()), /detached HEAD/);
  assert.equal(existsSync(join(source, ".git/FETCH_HEAD")), false);
  assert.deepEqual(calls, []);
});

test("받은 커밋에 잠금 파일이 없으면 의존성 설치·빌드 없이 멈춘다 — 등록하지 않는다", () => {
  git(seed, "rm", "package-lock.json");
  commit(seed, "remove lock");
  git(seed, "push", "origin", "main");
  assert.throws(() => updateFromSource(target, options()), /잠금 파일이 없습니다/);
  assert.deepEqual(calls, []);
  assert.deepEqual(storeEntries(), []);
});

test("지원하지 않는 설치는 실제 할 일을 알리고 대상 저장소를 소스로 쓰지 않는다", () => {
  assert.match(previewSourceUpdate(target, { packaged: true }), /설치 유형: binary/);
  assert.throws(() => updateFromSource(target, { packaged: true }), /새 실행 파일/);
  const pkg = join(target, "node_modules/code-agent");
  mkdirSync(pkg, { recursive: true });
  const preview = previewSourceUpdate(target, { sourceRoot: pkg });
  assert.match(preview, /설치 유형: npm-package/);
  assert.match(preview, /기존 설치에 사용한 패키지 관리자/);
  assert.throws(() => updateFromSource(target, { sourceRoot: pkg }), /npm 패키지 설치/);
  const archive = join(root, "archive");
  mkdirSync(archive);
  assert.match(previewSourceUpdate(target, { sourceRoot: archive }), /설치 유형: non-git/);
});

test("실제 npm ci(오프라인)·prepare·build 가 공백이 든 저장소 경로에서 돈다", () => {
  publish("new");
  const report = updateFromSource(target, { sourceRoot: source });
  assert.match(report, /npm ci --include=dev/);
  assert.match(report, /prepare/);
  assert.match(report, /doctor new: ok/);
  assert.equal(listReleases(home).length, 1);
});

test("Git worktree 설치도 그 worktree 의 upstream 으로 설치하고 어느 worktree 도 옮기지 않는다", () => {
  const worktree = join(root, "linked source");
  git(source, "worktree", "add", "-b", "linked", worktree, "main");
  git(worktree, "branch", "--set-upstream-to=origin/main");
  const published = publish("new");
  const before = [git(source, "rev-parse", "HEAD"), git(worktree, "rev-parse", "HEAD")];
  updateFromSource(target, { ...options(), sourceRoot: worktree });
  assert.deepEqual([git(source, "rev-parse", "HEAD"), git(worktree, "rev-parse", "HEAD")], before);
  assert.ok(installedRelease(releaseId(published), home));
  cpSync(join(home, releaseId(published), "template"), join(root, "copy-check"), { recursive: true });
  assert.equal(readFileSync(join(root, "copy-check", "value"), "utf8"), "template new");
});

test("installGitRelease 는 지정한 원격 브랜치만 받는다 — 강제 refspec·태그 없이 FETCH_HEAD 로", () => {
  const published = publish("new");
  git(seed, "tag", "v-new");
  git(seed, "push", "origin", "v-new");
  const outcome = installGitRelease({ source, remote: "origin", ref: "refs/heads/main" }, options().runNpm!, home);
  assert.equal(outcome.id, releaseId(published));
  assert.equal(git(source, "tag", "--list"), "", "태그를 받지 않는다");
  assert.notEqual(git(source, "rev-parse", "refs/remotes/origin/main"), published, "원격 추적 브랜치도 옮기지 않는다(FETCH_HEAD 만)");
});
