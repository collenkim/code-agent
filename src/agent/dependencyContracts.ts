/** 명시적으로 지정한 Git 근거만 읽는다. 계약 재인용은 사람 답이나 승인 권한이 아니다. */
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { createHash } from "crypto";
import { z } from "zod";
import { writeAtomic } from "../core/atomic";
import { STATE_DIR } from "./layout";

const LIMIT = 131072;
const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const Key = z.string().regex(/^[a-z][a-z0-9.-]{0,95}$/);
const Claim = z.object({ key: Key, text: z.string().trim().min(1).max(8000).regex(/^[^\r\n\u2028\u2029]+$/) }).strict();
const Reference = z.object({
  id: Key, repository: z.string().min(1), path: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{40}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  claims: z.array(Claim).min(1).max(40),
}).strict();
const Bundle = z.object({ version: z.literal(1), contracts: z.array(Reference).min(1).max(20) }).strict();
const Stored = z.object({ version: z.literal(1), contracts: z.array(Reference.extend({ content: z.string().max(LIMIT) })).min(1).max(20) }).strict();
export type DependencyContract = z.infer<typeof Stored>["contracts"][number];
export const contractsFile = (id: string): string => `${STATE_DIR}/work/${id}/dependency-contracts.json`;

function boundedFile(path: string): string {
  if (statSync(path).size > LIMIT) throw new Error("계약 자료가 크기 한도를 넘었습니다");
  return readFileSync(path, "utf8");
}
function source(ref: z.infer<typeof Reference>): string {
  if (!isAbsolute(ref.repository)) throw new Error("계약 저장소는 절대 경로여야 합니다");
  if (ref.path.includes("\\") || ref.path.split("/").some(p => !p || p === "." || p === "..") || /[:\x00-\x1f]/.test(ref.path) || isAbsolute(ref.path)) throw new Error("계약 근거 경로가 유효하지 않습니다");
  const root = realpathSync(ref.repository);
  const file = realpathSync(resolve(root, ref.path));
  const inside = relative(root, file);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("계약 근거가 지정 저장소 밖입니다");
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { maxBuffer: LIMIT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (realpathSync(git(["rev-parse", "--show-toplevel"]).toString().trim()) !== root) throw new Error("계약 repository는 Git 저장소 루트여야 합니다");
  const entry = git(["ls-tree", ref.commit, "--", ref.path]).toString();
  if (!/^100(?:644|755) blob /.test(entry) || entry.trim().split("\n").length !== 1) throw new Error("계약 근거는 커밋된 일반 파일이어야 합니다");
  const blob = git(["show", `${ref.commit}:${ref.path}`]);
  const current = boundedFile(file);
  if (digest(blob) !== ref.sha256 || digest(current) !== ref.sha256) throw new Error("계약 근거의 커밋 또는 현재 내용 해시가 다릅니다");
  const content = blob.toString("utf8");
  if (digest(content) !== ref.sha256 || content.includes("\0")) throw new Error("계약 근거는 UTF8 텍스트여야 합니다");
  for (const claim of ref.claims) if (!content.split(/\r?\n/).some(line => line.trim() === claim.text)) throw new Error(`계약 ${ref.id}의 ${claim.key}가 원문 한 줄과 다릅니다`);
  return content;
}
function conflicts(contracts: DependencyContract[]): void {
  const ids = new Set<string>(), claims = new Map<string, string>(), paths = new Map<string, string>();
  for (const contract of contracts) {
    if (ids.has(contract.id)) throw new Error(`중복 계약 ID: ${contract.id}`);
    ids.add(contract.id);
    const path = `${realpathSync(contract.repository)}/${contract.path}`;
    if (paths.has(path) && paths.get(path) !== contract.sha256) throw new Error(`상충하는 계약 근거: ${contract.path}`);
    paths.set(path, contract.sha256);
    for (const claim of contract.claims) {
      if (claims.has(claim.key) && claims.get(claim.key) !== claim.text) throw new Error(`상충하는 계약 항목: ${claim.key}`);
      claims.set(claim.key, claim.text);
    }
  }
}
/** 전체 검증 후 한 파일로 원자 기록한다. 호출자는 계획 잠금·단계·진행 배정을 확인한다. */
export function registerContracts(root: string, id: string, input: string): string {
  const bundle = Bundle.parse(JSON.parse(boundedFile(input)));
  const contracts = bundle.contracts.map(ref => ({ ...ref, content: source(ref) }));
  conflicts(contracts);
  const text = JSON.stringify({ version: 1, contracts }, null, 2) + "\n";
  if (Buffer.byteLength(text) > LIMIT) throw new Error("계약 묶음이 크기 한도를 넘었습니다");
  writeAtomic(join(root, contractsFile(id)), text);
  return `외부 의존 계약 ${contracts.length}개 기록: ${contractsFile(id)} — 사람 답·승인 아님`;
}
export function dependencyContracts(root: string, id: string): { contracts: DependencyContract[]; files: string[]; problems: string[]; hash?: string } {
  const file = contractsFile(id);
  if (!existsSync(join(root, file))) return { contracts: [], files: [], problems: [] };
  let text = "";
  try {
    text = boundedFile(join(root, file));
    const bundle = Stored.parse(JSON.parse(text));
    conflicts(bundle.contracts);
    for (const contract of bundle.contracts) if (source(contract) !== contract.content) throw new Error(`계약 사본이 근거와 다릅니다: ${contract.id}`);
    return { contracts: bundle.contracts, files: [file], problems: [], hash: digest(text) };
  } catch (error) {
    const problem = `외부 의존 계약 미확인 — ${error instanceof Error ? error.message : error}. 원문·상충 조건을 확인하고 근거가 없으면 질문하세요`;
    return { contracts: [], files: [file], problems: [problem], hash: digest(text + problem) };
  }
}
