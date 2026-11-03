import { sha256 as digest } from "../core/serialize";
/**
 * 명시적으로 지정한 Git 근거만 읽는다. 계약 재인용은 사람 답이나 승인 권한이 아니다.
 *
 * 계약은 제공 저장소의 기준 커밋에 고정한다 — 지정 커밋의 blob 이 계약 원문이고, 의존 범위는 등록한 항목 줄과 항목이 지정한 섹션이다.
 * 제공 저장소의 작업 트리·이후 커밋은 채택된 계약이 아니다: 판정·해시에 쓰지 않고 `contractDrift` 가 범위 안 차이만 알린다.
 * 새 계약은 다시 등록해야 채택된다(planning.ts 가 바뀐 항목과 영향받는 작업을 다시 판정한다).
 * 범위의 글은 표기 차이(BOM·줄바꿈·줄 끝 공백·유니코드 조합)를 지운 뒤 비교·해시한다 — 그 밖의 글자 차이는 모두 의미 있는 변경이다.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { z } from "zod";
import { writeAtomic } from "../core/atomic";
import { securityLabels, type ClaimChange } from "./changeImpact";
import { STATE_DIR } from "./layout";

const LIMIT = 131072;
// 한 명령의 동기 판정 구간에서 같은 계약을 다시 읽을 때 Git 자식을 반복하지 않는다. 기준 커밋의 blob 은 바뀌지 않지만
// 저장소 자체가 바뀔 수 있어 await·다음 명령으로 넘어가기 전에 버린다.
const sourceMemo = new Map<string, Derived>();
let clearScheduled = false;
const Key = z.string().regex(/^[a-z][a-z0-9.-]{0,95}$/);
const Line = z.string().trim().min(1).max(8000).regex(/^[^\r\n\u2028\u2029]+$/);
/** 의존하는 계약의 종류 — jwt-claim·auth 는 보안 계약이다(바뀌면 설계·계획·검증을 다시 돈다) */
export const CLAIM_KINDS = ["api", "header", "jwt-claim", "auth", "config", "data", "other"] as const;
export type ClaimKind = typeof CLAIM_KINDS[number];
const SECURITY_KINDS: readonly ClaimKind[] = ["jwt-claim", "auth"];
const RequirementId = z.string().regex(/^(?:R\d+|REQ-\d+|DONE-\d+|CON-\d+)$/);
const ClaimV1 = z.object({ key: Key, text: Line }).strict();
const Claim = z.object({
  key: Key, kind: z.enum(CLAIM_KINDS), text: Line,
  /** 항목이 기대는 섹션 제목 — 있으면 그 섹션 전체가 의존 범위다 */
  section: Line.optional(),
  /** 항목에 기대는 요구 ID — 없으면 모든 계획 작업이 기댄다 */
  requirements: z.array(RequirementId).min(1).max(50).optional(),
  /** pending: 제공 저장소에 아직 구현되지 않았다(외부 의존 대기) */
  availability: z.enum(["provided", "pending"]).default("provided"),
}).strict();
const RefFields = { id: Key, repository: z.string().min(1), path: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) };
const InputV1 = z.object({ version: z.literal(1), contracts: z.array(z.object({ ...RefFields, claims: z.array(ClaimV1).min(1).max(40) }).strict()).min(1).max(20) }).strict();
const InputV2 = z.object({ version: z.literal(2), contracts: z.array(z.object({ ...RefFields, claims: z.array(Claim).min(1).max(40) }).strict()).min(1).max(20) }).strict();
const StoredClaim = Claim.extend({ scope: z.string().regex(/^[a-f0-9]{64}$/) });
const StoredV1 = z.object({ version: z.literal(1), contracts: z.array(z.object({ ...RefFields, claims: z.array(ClaimV1).min(1).max(40), content: z.string().max(LIMIT) }).strict()).min(1).max(20) }).strict();
/** excerpt: 의존 범위의 원문(문맥·지정 섹션·상위 제목, 원문 순서). normalized: 기준 원문 전체를 정규화한 해시 — 범위 밖 변경을 알리는 데만 쓴다 */
const StoredV2 = z.object({ version: z.literal(2), contracts: z.array(z.object({ ...RefFields, claims: z.array(StoredClaim).min(1).max(40), excerpt: z.string().max(LIMIT), normalized: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(20) }).strict();
const StoredV3 = StoredV2.extend({ version: z.literal(3) });
type Reference = z.infer<typeof InputV2>["contracts"][number];
export type ContractClaim = z.infer<typeof StoredClaim>;
export type DependencyContract = z.infer<typeof StoredV2>["contracts"][number];
export const contractsFile = (id: string): string => `${STATE_DIR}/work/${id}/dependency-contracts.json`;
export const isSecurityClaim = (claim: Pick<ContractClaim, "kind" | "text">): boolean => SECURITY_KINDS.includes(claim.kind) || securityLabels([claim.text]).length > 0;
/** 계약 항목의 의미 해시 — 기준 커밋·저장소 경로·파일 경로는 출처라 넣지 않는다. 같은 범위를 다른 커밋에서 다시 등록해도 같다 */
export const claimDigest = (contract: Pick<DependencyContract, "id">, claim: ContractClaim): string =>
  digest(JSON.stringify([contract.id, claim.key, claim.kind, claim.availability, claim.requirements ?? [], claim.text, claim.section ?? "", claim.scope]));

/** 표기 차이를 지운 글 — BOM·줄바꿈(CRLF·CR)·줄 끝 공백·끝의 빈 줄·유니코드 조합(NFC). 그 밖의 글자는 그대로다 */
export function normalizeContract(text: string): string {
  return text.replace(/^﻿/, "").normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/[ \t]+$/, "")).join("\n").replace(/\n*$/, "\n");
}
interface Section { title: string; start: number; end: number }
/** ATX 제목의 섹션 — 다음 같은·상위 수준 제목 전까지. 코드 블록 안의 `#` 줄은 제목이 아니다 */
function sections(lines: string[]): Section[] {
  const found: (Section & { level: number })[] = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) { fence = fence ? undefined : marker; return; }
    if (fence) return;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!heading) return;
    const level = heading[1].length;
    for (const open of found) if (open.end === lines.length && open.level >= level) open.end = index;
    found.push({ title: heading[2].trim(), start: index, end: lines.length, level });
  });
  return found.map(({ title, start, end }) => ({ title, start, end }));
}
interface Derived { claims: ContractClaim[]; excerpt: string; normalized: string }
/** 정규화한 원문에서 항목마다 의존 범위를 정한다 — 항목 줄이 없거나 섹션 밖이면 오류다 */
function derive(contractId: string, text: string, claims: z.infer<typeof Claim>[], contextual = true): Derived {
  const normalized = normalizeContract(text), lines = normalized.split("\n");
  const all = sections(lines);
  const ranges: [number, number][] = [];
  const scoped = claims.map(claim => {
    const want = claim.text.normalize("NFC").trim();
    let range: [number, number] | undefined;
    if (claim.section) {
      const title = claim.section.normalize("NFC").trim();
      const matches = all.filter(section => section.title === title);
      if (matches.length !== 1) throw new Error(`계약 ${contractId}의 ${claim.key} 섹션 '${claim.section}'이 ${matches.length ? "여러 번 나옵니다" : "원문에 없습니다"}`);
      range = [matches[0].start, matches[0].end];
    }
    const matches = lines.flatMap((line, index) => line.trim() === want && (!range || index >= range[0] && index < range[1]) ? [index] : []);
    if (contextual && matches.length > 1) throw new Error(`계약 ${contractId}의 ${claim.key} 원문 줄이 여러 번 나옵니다 — 고유한 section을 지정하세요`);
    const at = matches[0] ?? -1;
    if (at < 0) throw new Error(`계약 ${contractId}의 ${claim.key}가 ${range ? "지정 섹션의 " : ""}원문 한 줄과 다릅니다`);
    if (!range && contextual) {
      const enclosing = all.filter(section => section.start <= at && at < section.end).at(-1);
      // 자동 범위는 가장 가까운 제목의 직접 본문이다. 하위·다음 제목은 별도 범위다.
      if (enclosing) range = [enclosing.start, all.find(section => section.start > at)?.start ?? lines.length];
      else {
        let start = at, end = at + 1;
        while (start > 0 && lines[start - 1].trim()) start--;
        while (end < lines.length && lines[end].trim() && !all.some(section => section.start === end)) end++;
        range = [start, end];
      }
    }
    range ??= [at, at + 1];
    const ancestors = contextual ? all.filter(section => section.start < range![0] && section.end > range![0]).map(section => section.start) : [];
    ranges.push(...ancestors.map(start => [start, start + 1] as [number, number]));
    ranges.push(range);
    return { ...claim, text: want, scope: digest([...ancestors.map(start => lines[start]), ...lines.slice(range[0], range[1])].join("\n").replace(/\n+$/, "")) };
  });
  // 범위들을 원문 순서로 합친다 — 겹치는 섹션·줄은 한 번만
  const merged: [number, number][] = [];
  for (const range of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return { claims: scoped, excerpt: merged.map(([start, end]) => lines.slice(start, end).join("\n").replace(/\n+$/, "")).join("\n\n…\n\n") + "\n", normalized: digest(normalized) };
}
/** 변경 설명용 글 — 명시 섹션 또는 자동 문맥을 담은 사본. 변경 여부 자체는 항목의 scope 해시로 판정한다. */
function scopeLines(contract: DependencyContract, claim: ContractClaim): string[] {
  if (!claim.section) return contract.excerpt.split("\n");
  const lines = contract.excerpt.split("\n"), found = sections(lines).find(section => section.title === claim.section!.normalize("NFC").trim());
  return found ? lines.slice(found.start, found.end) : [claim.text];
}
/**
 * 이전 사본과 새 사본의 항목별 차이(`<계약ID>/<항목키>`) — 의미 해시가 같은 항목은 그대로다(기준 커밋·범위 밖 글만 바뀐 것).
 * 요구 연결이 없는 쪽이 있으면 requirements 는 비운다(모든 작업이 기댄다). texts 는 전후 항목 줄과 범위에서 한쪽에만 있는 줄이다.
 */
export function claimChanges(before: DependencyContract[], after: DependencyContract[]): ClaimChange[] {
  const index = (contracts: DependencyContract[]) => new Map(contracts.flatMap(contract => contract.claims.map(claim => [`${contract.id}/${claim.key}`, { contract, claim }] as const)));
  const was = index(before), now = index(after);
  const changes: ClaimChange[] = [];
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const a = was.get(key), b = now.get(key);
    if (a && b && claimDigest(a.contract, a.claim) === claimDigest(b.contract, b.claim)) continue;
    const linesA = a ? scopeLines(a.contract, a.claim) : [], linesB = b ? scopeLines(b.contract, b.claim) : [];
    const changed = [...linesA.filter(line => !linesB.includes(line)), ...linesB.filter(line => !linesA.includes(line))];
    const entries = [a, b].filter(entry => !!entry);
    changes.push({ claim: key, change: !a ? "added" : !b ? "removed" : "changed",
      requirements: entries.every(entry => entry.claim.requirements) ? [...new Set(entries.flatMap(entry => entry.claim.requirements!))] : [],
      security: entries.some(entry => isSecurityClaim(entry.claim)), texts: [...(a ? [a.claim.text] : []), ...changed, ...(b ? [b.claim.text] : [])] });
  }
  return changes;
}
function boundedFile(path: string): string {
  if (statSync(path).size > LIMIT) throw new Error("계약 자료가 크기 한도를 넘었습니다");
  return readFileSync(path, "utf8");
}
function checkedPath(ref: Pick<Reference, "repository" | "path">): string {
  if (!isAbsolute(ref.repository)) throw new Error("계약 저장소는 절대 경로여야 합니다");
  if (ref.path.includes("\\") || ref.path.split("/").some(p => !p || p === "." || p === "..") || /[:\x00-\x1f]/.test(ref.path) || isAbsolute(ref.path)) throw new Error("계약 근거 경로가 유효하지 않습니다");
  return realpathSync(ref.repository);
}
const gitIn = (root: string) => (args: string[]): Buffer => execFileSync("git", ["-C", root, ...args], { maxBuffer: LIMIT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
/** 커밋의 일반 파일 blob 을 UTF8 글로 — 심볼릭 링크·하위 모듈·디렉터리·없는 경로는 거부한다 */
function committedText(git: ReturnType<typeof gitIn>, commit: string, path: string): { text: string; bytes: Buffer } {
  const entry = git(["ls-tree", commit, "--", path]).toString();
  if (!/^100(?:644|755) blob /.test(entry) || entry.trim().split("\n").length !== 1) throw new Error("계약 근거는 커밋된 일반 파일이어야 합니다");
  const bytes = git(["show", `${commit}:${path}`]);
  const text = bytes.toString("utf8");
  if (Buffer.compare(Buffer.from(text, "utf8"), bytes) !== 0 || text.includes("\0")) throw new Error("계약 근거는 UTF8 텍스트여야 합니다");
  return { text, bytes };
}
/** 기준 커밋의 원문으로 항목 범위를 정한다 — 작업 트리는 읽지 않는다 */
function source(ref: Reference, contextual = true): Derived {
  const root = checkedPath(ref);
  const key = JSON.stringify([ref, root, contextual]);
  const cached = sourceMemo.get(key);
  if (cached) return cached;
  const git = gitIn(root);
  if (realpathSync(git(["rev-parse", "--show-toplevel"]).toString().trim()) !== root) throw new Error("계약 repository는 Git 저장소 루트여야 합니다");
  const blob = committedText(git, ref.commit, ref.path);
  if (digest(blob.bytes) !== ref.sha256) throw new Error(`계약 근거의 커밋 내용 해시가 다릅니다 — sha256 은 git show ${ref.commit.slice(0, 12)}:${ref.path} 의 바이트입니다`);
  const derived = derive(ref.id, blob.text, ref.claims, contextual);
  sourceMemo.set(key, derived);
  if (!clearScheduled) {
    clearScheduled = true;
    queueMicrotask(() => { sourceMemo.clear(); clearScheduled = false; });
  }
  return derived;
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
/** 버전 1(항목 줄만)은 종류 other·범위 없는 항목으로 읽는다 */
const upgradeClaims = (claims: z.infer<typeof ClaimV1>[]): z.infer<typeof Claim>[] => claims.map(claim => ({ ...claim, kind: "other", availability: "provided" }));
function inputBundle(raw: unknown): Reference[] {
  const version = (raw as { version?: unknown } | null)?.version;
  if (version === 1) return InputV1.parse(raw).contracts.map(ref => ({ ...ref, claims: upgradeClaims(ref.claims) }));
  return InputV2.parse(raw).contracts;
}
/** 항목이 가리킬 수 있는 요구 ID — 지시서의 접수 항목과 01 의 R. r 이 없으면(01 이 아직 없다) R 은 대조하지 않는다 */
export interface KnownRequirements { intake: readonly string[]; r?: readonly string[] }
/**
 * 전체 검증 후 한 파일로 원자 기록한다. 호출자는 계획 잠금·단계·진행 배정을 확인한다.
 * 없는 요구 ID 를 가리킨 항목은 받지 않는다 — 어느 작업에도 닿지 않아 바뀌어도 아무것도 다시 돌지 않게 된다.
 */
export function registerContracts(root: string, id: string, input: string, known?: KnownRequirements): string {
  const refs = inputBundle(JSON.parse(boundedFile(input)));
  if (known) {
    const unknown = [...new Set(refs.flatMap(ref => ref.claims.flatMap(claim => claim.requirements ?? [])))]
      .filter(key => /^R\d+$/.test(key) ? known.r !== undefined && !known.r.includes(key) : !known.intake.includes(key));
    if (unknown.length) throw new Error(`계약 항목이 가리킨 요구 ID가 지시서·01-requirements.md 에 없습니다: ${unknown.join(", ")}`);
  }
  const contracts: DependencyContract[] = refs.map(ref => { const derived = source(ref); return { ...ref, claims: derived.claims, excerpt: derived.excerpt, normalized: derived.normalized }; });
  conflicts(contracts);
  const text = JSON.stringify({ version: 3, contracts }, null, 2) + "\n";
  if (Buffer.byteLength(text) > LIMIT) throw new Error("계약 묶음이 크기 한도를 넘었습니다");
  writeAtomic(join(root, contractsFile(id)), text);
  return `외부 의존 계약 ${contracts.length}개 기록: ${contractsFile(id)} — 사람 답·승인 아님`;
}
/**
 * 등록된 계약 — 사본을 기준 커밋의 원문과 다시 대조한다. `hash` 는 항목 의미 해시의 묶음이라 출처(커밋·경로)만 바뀐 재등록에는 그대로다.
 * 검증하지 못하면 항목 없이 problems 와 문제를 담은 hash 를 돌려준다(계획 배정을 막고 완료 결과를 재사용하지 않는다).
 */
export function dependencyContracts(root: string, id: string): { contracts: DependencyContract[]; files: string[]; problems: string[]; hash?: string } {
  const file = contractsFile(id);
  if (!existsSync(join(root, file))) return { contracts: [], files: [], problems: [] };
  let text = "";
  try {
    text = boundedFile(join(root, file));
    const raw = JSON.parse(text) as { version?: unknown };
    const contracts: DependencyContract[] = raw.version === 1
      ? StoredV1.parse(raw).contracts.map(({ content, ...ref }) => {
        const upgraded = { ...ref, claims: upgradeClaims(ref.claims) }, derived = source(upgraded);
        if (normalizeContract(content) !== normalizeContract(committedText(gitIn(checkedPath(ref)), ref.commit, ref.path).text)) throw new Error(`계약 사본이 근거와 다릅니다: ${ref.id}`);
        return { ...upgraded, claims: derived.claims, excerpt: derived.excerpt, normalized: derived.normalized };
      })
      : (raw.version === 2 ? StoredV2 : StoredV3).parse(raw).contracts;
    conflicts(contracts);
    for (const contract of contracts) {
      const { excerpt, claims, normalized, ...ref } = contract;
      const input = { ...ref, claims: claims.map(({ scope, ...claim }) => claim) };
      // 버전 2는 저장 당시 한 줄 범위로 먼저 무결성을 대조한 뒤 현재 문맥 범위로 읽는다. 조회는 파일을 다시 쓰지 않는다.
      const derived = source(input, raw.version !== 2);
      const same = derived.claims.length === claims.length && derived.claims.every((claim, index) => claimDigest(contract, claim) === claimDigest(contract, claims[index]));
      if (derived.excerpt !== excerpt || derived.normalized !== normalized || !same) throw new Error(`계약 사본이 근거와 다릅니다: ${contract.id}`);
      if (raw.version === 2) Object.assign(contract, source(input));
    }
    return { contracts, files: [file], problems: [], hash: digest(JSON.stringify(contracts.flatMap(contract => contract.claims.map(claim => claimDigest(contract, claim))))) };
  } catch (error) {
    const problem = `외부 의존 계약 미확인 — ${error instanceof Error ? error.message : error}. 원문·상충 조건을 확인하고 근거가 없으면 질문하세요`;
    return { contracts: [], files: [file], problems: [problem], hash: digest(text + problem) };
  }
}

/** 제공 저장소가 기준과 달라진 항목 — head 는 커밋됨(그 커밋으로 다시 등록해 채택할 수 있다), worktree 는 커밋되지 않은 변경이다 */
export interface ContractDrift { contract: string; key: string; kind: ClaimKind; security: boolean; change: "changed" | "removed"; where: "head" | "worktree"; head?: string }
/** 범위 밖만 달라진 계약 — 갱신할 작업이 없다 */
export interface ScopeOnlyChange { contract: string; where: "head" | "worktree"; head?: string }
/**
 * 제공 저장소의 지금 상태(HEAD·작업 트리)를 기준 커밋과 범위 안에서 비교한다 — 알림만 하고 채택하지 않는다(해시·배정 판정에 쓰지 않는다).
 * 네트워크로 원격을 받지 않는다. 표기 차이만 다르면 아무것도 알리지 않는다.
 */
export function contractDrift(root: string, id: string): { drift: ContractDrift[]; outOfScope: ScopeOnlyChange[]; problems: string[] } {
  const drift: ContractDrift[] = [], outOfScope: ScopeOnlyChange[] = [], problems: string[] = [];
  for (const contract of dependencyContracts(root, id).contracts) {
    try {
      const repo = checkedPath(contract), git = gitIn(repo);
      const head = git(["rev-parse", "HEAD"]).toString().trim();
      // 정규화한 원문 — 없거나 읽지 못하면 undefined(항목이 사라진 것으로 본다). 기준 커밋 그대로인 HEAD 는 다시 읽지 않는다
      let headText: string | undefined;
      if (head !== contract.commit) { try { headText = normalizeContract(committedText(git, head, contract.path).text); } catch { headText = undefined; } }
      let treeText: string | undefined;
      try {
        const file = realpathSync(resolve(repo, contract.path)), inside = relative(repo, file);
        treeText = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? undefined : normalizeContract(boundedFile(file));
      } catch { treeText = undefined; }
      const pinned = new Map<string, string | undefined>(contract.claims.map(claim => [claim.key, claim.scope]));
      const scopes = (text: string | undefined): Map<string, string | undefined> => new Map(contract.claims.map(claim => {
        if (text === undefined) return [claim.key, undefined];
        try { return [claim.key, derive(contract.id, text, [claim]).claims[0].scope]; } catch { return [claim.key, undefined]; }
      }));
      const headHash = head === contract.commit ? contract.normalized : headText === undefined ? undefined : digest(headText);
      const treeHash = treeText === undefined ? undefined : digest(treeText);
      const atHead = head === contract.commit ? pinned : scopes(headText), atTree = treeHash === headHash ? atHead : scopes(treeText);
      const before = drift.length;
      for (const claim of contract.claims) {
        // 작업 트리가 기준과 다르면 그것이 가장 새 상태다 — HEAD 와 같으면 커밋된 변경(채택할 수 있다), 다르면 커밋되지 않은 변경이다
        const inTree = atTree.get(claim.key) !== claim.scope;
        const latest = inTree ? atTree.get(claim.key) : atHead.get(claim.key);
        if (latest === claim.scope) continue;
        const where: ContractDrift["where"] = inTree && atTree.get(claim.key) !== atHead.get(claim.key) ? "worktree" : "head";
        drift.push({ contract: contract.id, key: claim.key, kind: claim.kind, security: isSecurityClaim(claim), change: latest === undefined ? "removed" : "changed", where, ...(where === "head" ? { head } : {}) });
      }
      if (drift.length === before && (treeHash !== contract.normalized || headHash !== contract.normalized)) {
        const where = treeHash !== headHash ? "worktree" : "head";
        outOfScope.push({ contract: contract.id, where, ...(where === "head" ? { head } : {}) });
      }
    } catch (error) {
      problems.push(`${contract.id}: 제공 저장소의 지금 상태를 읽지 못했습니다 — ${error instanceof Error ? error.message : error}`);
    }
  }
  return { drift, outOfScope, problems };
}
