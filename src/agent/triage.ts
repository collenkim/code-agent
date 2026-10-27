import { sha256 as hash } from "../core/serialize";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { z } from "zod";
import { errorFingerprint } from "./errorFingerprint";
import { isAbsolute, join, relative, resolve } from "path";
import { writeAtomic } from "../core/atomic";
import { canonical, DOCS_SESSION_FILE, loadActive, REQUEST_SESSION_FILE, workDocsDir } from "./layout";
import { acquireLock } from "./lock";
import { TIMING } from "./retryPolicy";
import { Stop } from "./stop";
import { aidlcBlock } from "./aidlc";
import { JiraSchema, loadTriage, readTriageRecord, TRIAGE_ACTIVE, TRIAGE_DIR, triageDraft, triageFolder, triageRecordFile,
  triageSummary, TriageReportSchema, type TriageRecord, type TriageReport } from "./triageState";

function save(root: string, record: TriageRecord): void {
  writeAtomic(join(root, triageRecordFile(record.id)), JSON.stringify(record, null, 2) + "\n");
}
function locked<T>(root: string, run: () => T): T {
  mkdirSync(join(root, TRIAGE_DIR), { recursive: true });
  const release = acquireLock(join(root, TRIAGE_DIR, "triage.lock"), { waitMs: TIMING.lockWaitMs, ageReclaim: false, label: "사전 판별" });
  try { return run(); } finally { release(); }
}
function current(root: string): TriageRecord {
  const record = loadTriage(root);
  if (!record) throw new Stop("사전 판별이 없습니다 — code-agent triage ingest <입력JSON>");
  return record;
}
function repoFile(root: string, path: string): string {
  const rel = relative(canonical(root), canonical(resolve(root, path)));
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || path.includes(":")) throw new Stop(`저장소 안의 경로가 필요합니다: ${path}`);
  if (!existsSync(join(root, rel))) throw new Stop(`존재하지 않는 경로입니다: ${path}`);
  return join(root, rel);
}
function checkEvidence(root: string, report: TriageReport): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const item of report.evidence) {
    const file = repoFile(root, item.path);
    const content = readFileSync(file, "utf8");
    if (!content.replace(/\r\n/g, "\n").split("\n")[item.line - 1]?.includes(item.quote)) {
      throw new Stop(`코드 근거가 실제 줄과 다릅니다: ${item.path}:${item.line}`);
    }
    hashes[item.path] = hash(content);
  }
  if (report.proposal) for (const path of [report.proposal.target, ...report.proposal.scope]) repoFile(root, path);
  return hashes;
}
function ready(root: string, record: TriageRecord): TriageReport {
  const report = record.report;
  if (!report || report.codeChange !== "required") throw new Stop("코드 변경 필요 판정만 Jira 준비·연결·fix 인계를 할 수 있습니다");
  if (report.duplicate.status === "unchecked") throw new Stop("Sentry 이슈에 연결된 기존 Jira와 진행 중 작업을 먼저 확인하세요");
  if (record.intake?.candidates.some(id => !report.candidateReview?.some(r => {
    if (r.id !== id) return false;
    if (r.decision === "different") return true;
    const previous = readTriageRecord(root, id);
    return r.decision === "reassess" && ["resolved", "operational", "paused"].includes(previous.lifecycle ?? "")
      && (!!record.reassessmentReason || (previous.lifecycle === "resolved" && !!record.intake?.release && record.intake.release === previous.deployment?.release));
  }))) {
    throw new Stop("유사 후보를 비교하세요 — 동일 원인은 attach, 불확실하면 판단 보류로 두고 새 Jira를 만들지 않습니다");
  }
  const hashes = checkEvidence(root, report);
  if (JSON.stringify(hashes) !== JSON.stringify(record.codeHashes)) throw new Stop(record.jira
    ? `조사한 코드가 바뀌었습니다 — 연결된 ${record.jira.key} 를 보존하고 조사 결과를 재검토하세요. triage close 뒤 기존 티켓으로 직접 fix 접수할 수 있습니다.`
    : "조사한 코드가 바뀌었습니다 — 근거를 다시 확인하고 triage submit 하세요");
  return report;
}
export function triageBegin(root: string, source: string, base?: string): string {
  if (source.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source)) throw new Stop("Sentry 출처는 조직/프로젝트/이슈ID로 적으세요");
  if (base !== undefined && (!base.trim() || base.startsWith("-") || /[\r\n]/.test(base))) throw new Stop("기준 브랜치 값이 잘못됐습니다");
  return locked(root, () => beginLocked(root, source, base));
}
function beginLocked(root: string, source: string, base?: string, seed?: Partial<TriageRecord>): string {
    const active = loadTriage(root);
    if (active) {
      if (active.source !== source) throw new Stop(`다른 오류를 판별 중입니다: ${active.source}`);
      if (base !== undefined && active.base !== base) throw new Stop("조사에 기록한 기준 브랜치와 다릅니다 — 인계 후 접수에서 기준을 확인하세요");
      return triageSummary(active);
    }
    const id = hash(source).slice(0, 24);
    const previous = existsSync(join(root, triageRecordFile(id))) ? readTriageRecord(root, id) : undefined;
    if (previous?.handedOff) return `이미 Jira ${previous.jira!.key} 로 인계했습니다. 새 Jira를 만들지 않습니다.\n${triageSummary(previous)}`;
    if (loadActive(root) || existsSync(join(root, REQUEST_SESSION_FILE)) || existsSync(join(root, DOCS_SESSION_FILE))) {
      throw new Stop("진행 중인 작업·접수·문서 준비를 마친 뒤 사전 판별을 시작하세요");
    }
    const aidlc = aidlcBlock(root);
    if (aidlc) throw new Stop(aidlc);
    (require("./init") as typeof import("./init")).requireStartHooks(root);
    if (previous && base !== undefined && previous.base !== base) throw new Stop("보존된 조사의 기준 브랜치와 다릅니다");
    const record: TriageRecord = previous ?? { id, source, revision: 0, ...(base ? { base } : {}), ...seed };
    record.lifecycle = "investigating";
    save(root, record);
    if (!existsSync(join(root, triageDraft(id)))) writeAtomic(join(root, triageDraft(id)), JSON.stringify({
      title: "", errorLog: record.intake?.original ?? "", release: record.intake?.release ?? "미확인 — 발생 버전과 현재 코드의 대응을 조사하세요",
      facts: [], hypotheses: [], cause: "unknown", codeChange: "undetermined", reason: "",
      evidence: [], nextActions: [], missingEvidence: [], duplicate: { status: "unchecked", evidence: "미조회" },
    }, null, 2) + "\n");
    writeAtomic(join(root, TRIAGE_ACTIVE), JSON.stringify({ id }) + "\n");
    return triageSummary(record);
}
export function triageStatus(root: string, id?: string): string {
  const record = id ? readTriageRecord(root, id) : loadTriage(root);
  return record ? `${triageSummary(record)}\n${JSON.stringify(record, null, 2)}` : "진행 중인 사전 판별이 없습니다.";
}
export function triageSubmit(root: string): string {
  return locked(root, () => {
    const record = current(root);
    if (record.jira) throw new Stop("Jira에 연결한 판별은 바꾸지 않습니다 — 변경 사항은 연결된 티켓과 fix 접수에서 검토하세요");
    const result = TriageReportSchema.safeParse(JSON.parse(readFileSync(join(root, triageDraft(record.id)), "utf8")));
    if (!result.success) throw new Stop(`사전 판별 형식이 맞지 않습니다: ${result.error.message}`);
    const report = result.data;
    if (record.intake && report.errorLog !== record.intake.original) throw new Stop("접수한 오류 로그 원문은 바꾸지 않습니다");
    if (record.report && report.errorLog !== record.report.errorLog) throw new Stop("제출한 오류 로그 원문은 바꾸지 않습니다");
    const codeHashes = checkEvidence(root, report);
    Object.assign(record, { report, codeHashes, revision: record.revision + 1 });
    save(root, record);
    writeAtomic(join(root, triageFolder(record.id), `report-${record.revision}.json`), JSON.stringify(record, null, 2) + "\n");
    return triageSummary(record);
  });
}
export function renderTriage(record: TriageRecord): string {
  const r = record.report!;
  return [
    `# ${r.title}`, "", `Sentry: ${record.source}`, `발생 버전: ${r.release}`, `추적 표지: sentry-triage-${record.id}`,
    "", "## 관측 사실", ...r.facts.map(x => `- ${x}`), "", "## 가설", ...r.hypotheses.map(x => `- ${x}`),
    "", "## 판별", `원인 분류: ${r.cause}`, `코드 변경: ${r.codeChange}`, r.reason,
    "", "## 코드 근거", ...r.evidence.map(x => `- ${x.path}:${x.line} — ${x.quote}`),
    "", "## 추가 증거", ...r.missingEvidence.map(x => `- ${x}`),
    "", "## 다음 조치", ...r.nextActions.map(x => `- ${x}`),
    "", "## 중복 확인", r.duplicate.evidence,
    ...(r.candidateReview ?? []).map(x => `- ${x.id}: ${x.decision} — ${x.reason}`),
    ...(record.reassessmentReason ? [`재판별 사유: ${record.reassessmentReason}`] : []),
    ...(r.proposal ? ["", "## 수정 제안 (요구 확인·계획 승인 전)", `대상: ${r.proposal.target}`,
      `범위: ${r.proposal.scope.join(", ")}`, ...r.proposal.preserve.map(x => `- 보존: ${x}`),
      ...r.proposal.requirements.map(x => `- 요구: ${x}`), ...r.proposal.done.map(x => `- 완료: ${x}`)] : []),
    "", "## 오류 로그", r.errorLog, "",
  ].join("\n");
}
export function triageJira(root: string): string {
  return locked(root, () => {
    const record = current(root);
    const report = ready(root, record);
    const file = `${triageFolder(record.id)}/jira.md`;
    writeAtomic(join(root, file), renderTriage(record));
    return `${record.jira ? `이미 연결됨: ${record.jira.key} — 새 티켓을 만들지 않습니다.`
      : report.duplicate.status === "existing" ? `기존 Jira ${report.duplicate.jira!.key} 를 사용하세요.`
      : "이 본문과 추적 표지로 Jira를 수동 생성하세요. 응답을 잃었으면 표지로 먼저 검색하고 중복 생성하지 않습니다."}\n본문: ${file}\n실제 티켓의 키·URL을 확인한 뒤 code-agent triage link <Jira티켓키> <URL>\nCLI는 Jira API를 호출하거나 원격 티켓의 실재를 검증하지 않습니다.`;
  });
}
export function triageLink(root: string, key: string, url: string): string {
  return locked(root, () => {
    const record = current(root), report = ready(root, record);
    const result = JiraSchema.safeParse({ key, url });
    if (!result.success) throw new Stop("Jira 키와 URL 형식이 맞지 않습니다");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== `/browse/${key}` || parsed.search || parsed.hash) {
      throw new Stop("Jira URL은 키와 일치하는 https://<호스트>/browse/<KEY> 형식이어야 합니다");
    }
    const existing = record.jira ?? report.duplicate.jira;
    if (existing && (existing.key !== key || existing.url !== url)) throw new Stop("이미 확인한 Jira와 다른 티켓을 연결할 수 없습니다");
    record.jira = { key, url };
    save(root, record);
    return triageSummary(record);
  });
}
export function triageHandoff(root: string): string {
  return locked(root, () => {
    const record = current(root), report = ready(root, record);
    if (!record.jira) throw new Stop("실제 Jira를 생성하거나 기존 티켓을 확인한 뒤 triage link 로 연결하세요");
    const id = record.jira.key, folder = workDocsDir(id);
    const request = require("./request") as typeof import("./request");
    const session = request.loadRequestSession(root);
    if (loadActive(root) || (session && (session.id !== id || session.kind !== "fix"))) throw new Stop("다른 작업·접수가 진행 중입니다");
    const sourceFile = join(root, folder, "triage.json");
    if (existsSync(join(root, folder)) && (!existsSync(sourceFile) || JSON.parse(readFileSync(sourceFile, "utf8")).id !== record.id)) {
      throw new Stop(`기존 ${id} 작업 폴더가 있습니다 — 덮어쓰지 않고 기존 작업을 확인하세요`);
    }
    // 원문·근거와 제안을 함께 인계한다. 판별 결과는 사람의 요구 확정을 대신하지 않는다.
    writeAtomic(sourceFile, JSON.stringify(record, null, 2) + "\n");
    writeAtomic(join(root, folder, "triage.md"), renderTriage(record));
    request.requestBegin(root, id, "fix", { target: report.proposal!.target, base: record.base, triageId: record.id });
    const draft = join(root, folder, "request.json");
    if (!existsSync(draft)) writeAtomic(draft, JSON.stringify({ id, kind: "fix", title: report.title,
      original: report.errorLog,
      background: `Sentry: ${record.source}\nJira: ${record.jira.url}\n사전 판별 제안 (사용자 확정 전): ${report.reason}\n조사 보고서: ${folder}/triage.md`,
      sourceMap: [{ quote: report.errorLog,
        targets: ["BACKGROUND", ...report.proposal!.requirements.map((_, i) => `REQ-${i + 1}`), ...report.proposal!.done.map((_, i) => `DONE-${i + 1}`)],
        note: "원본 오류 로그와 저장소 조사에서 도출한 수정 제안입니다. 사용자의 증상·기대 동작 서술이 아니며 요구 확인에서 검토합니다." }],
      errorLog: report.errorLog, ...report.proposal, target: [report.proposal!.target],
    }, null, 2) + "\n");
    record.handedOff = true;
    record.lifecycle = "fixing";
    save(root, record);
    unlinkSync(join(root, TRIAGE_ACTIVE));
    return `Jira ${id} 를 fix로 접수했습니다.\n근거: ${folder}/triage.md\n다음: code-agent request submit ${folder}/request.json — 이후 요구 확인과 기존 fix 절차를 따릅니다.`;
  });
}
export function triageClose(root: string): string {
  return locked(root, () => {
    const record = current(root);
    record.lifecycle = record.report?.codeChange === "unnecessary" ? "operational" : "paused";
    save(root, record);
    unlinkSync(join(root, TRIAGE_ACTIVE));
    return `사전 판별을 닫았습니다: ${record.source}. 조사 기록과 Jira 연결은 보존합니다.`;
  });
}

function records(root: string): TriageRecord[] {
  if (!existsSync(join(root, TRIAGE_DIR))) return [];
  return readdirSync(join(root, TRIAGE_DIR)).filter(id => /^[a-f0-9]{24}$/.test(id)
    && existsSync(join(root, triageRecordFile(id)))).map(id => readTriageRecord(root, id));
}
const InputSchema = z.object({ project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  errorLog: z.string().refine(x => !!x.trim()), release: z.string().trim().min(1).optional(),
  base: z.string().trim().min(1).refine(x => !x.startsWith("-") && !/[\r\n]/.test(x)).optional() });

/** 파일은 모델이 저장한 입력일 뿐이며 내부 상태나 판별 결과를 받지 않는다. */
export function triageIngest(root: string, file: string): string {
  const input = InputSchema.parse(JSON.parse(readFileSync(repoFile(root, file), "utf8")));
  const fp = errorFingerprint(input.project, input.errorLog);
  return locked(root, () => {
    const all = records(root), now = new Date().toISOString();
    const exact = all.filter(r => r.intake?.fingerprint === fp.key);
    const matches = [...new Map(exact.map(r => {
      const target = r.related ? readTriageRecord(root, r.related) : r;
      return [target.id, target] as const;
    })).values()].sort((a, b) => a.intake!.firstSeen.localeCompare(b.intake!.firstSeen));
    const previous = matches[matches.length - 1];
    // 작업 중 기록을 우선한다. 같은 오류의 배포 후 재조사가 이미 있으면 그 조사에 합친다.
    const existing = [...matches].reverse().find(r => r.lifecycle === "fixing" || r.lifecycle === "investigating") ?? previous;
    if (existing && (fp.reliable || exact.some(r => r.related === existing.id))) {
      existing.intake!.count++;
      existing.intake!.lastSeen = now;
      writeAtomic(join(root, triageFolder(existing.id), `occurrence-${existing.intake!.count}.json`), JSON.stringify({ ...input, at: now }, null, 2));
      save(root, existing);
      if (existing.lifecycle === "resolved") {
        if (!input.release || input.release !== existing.deployment?.release) {
          return `배포 이력이 있는 오류입니다: ${existing.id}. 발생 버전과 수정 배포 버전의 관계를 확인하세요. 새 작업을 만들지 않았습니다.\n${triageSummary(existing)}\n새 근거가 있으면 triage reassess <조사ID> <사유>로 재판별합니다.`;
        }
        // 수정 배포 버전에서 발생한 로그는 새 조사로 보존한다. 기존 Jira는 비교 후보다.
      } else {
        if (existing.lifecycle === "investigating" && !loadTriage(root) && !loadActive(root)
          && !existsSync(join(root, REQUEST_SESSION_FILE)) && !existsSync(join(root, DOCS_SESSION_FILE))) {
          beginLocked(root, existing.source, existing.base);
        }
        return `동일 오류 기록에 추가했습니다. 새 Jira·수정 실행은 생략합니다.\n${triageSummary(existing)}\n새 근거가 있으면 triage reassess <조사ID> <사유>로 재판별합니다.`;
      }
    }
    const candidates = [...new Set(all.filter(r => r.intake?.family === fp.family || r.intake?.fingerprint === fp.key).map(r => r.related ?? r.id))];
    return beginLocked(root, `logs/${input.project}/${randomUUID()}`, input.base, {
      lifecycle: "investigating", intake: { project: input.project, fingerprint: fp.key, family: fp.family,
        reliable: fp.reliable, original: input.errorLog, count: 1, firstSeen: now, lastSeen: now,
        release: input.release, candidates },
    });
  });
}

export function triageReassess(root: string, id: string, reason: string): string {
  if (!reason.trim()) throw new Stop("재판별 사유가 필요합니다");
  return locked(root, () => {
    const record = readTriageRecord(root, id);
    if (record.related) throw new Stop(`연결된 원본 기록으로 재판별하세요: ${record.related}`);
    if (loadTriage(root) || loadActive(root) || existsSync(join(root, REQUEST_SESSION_FILE))) throw new Stop("진행 중 작업을 먼저 확인하세요");
    if (record.lifecycle === "fixing" || record.lifecycle === "awaiting-deployment") throw new Stop("기존 수정·배포 작업에 증거를 추가하세요");
    if (!record.intake) throw new Stop("로그 입력으로 접수한 기록만 재판별할 수 있습니다");
    const latestFile = join(root, triageFolder(id), `occurrence-${record.intake.count}.json`);
    const latest = existsSync(latestFile) ? InputSchema.parse(JSON.parse(readFileSync(latestFile, "utf8"))) : undefined;
    const original = latest?.errorLog ?? record.intake.original;
    const fingerprint = errorFingerprint(record.intake.project, original);
    return beginLocked(root, `logs/${record.intake.project}/${randomUUID()}`, record.base, {
      lifecycle: "investigating", reassessmentReason: reason, intake: { ...record.intake, count: 1, candidates: [id],
        original, release: latest ? latest.release : record.intake.release,
        fingerprint: fingerprint.key, family: fingerprint.family, reliable: fingerprint.reliable,
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString() },
    }) + `\n재판별 사유: ${reason}`;
  });
}

export function triageWorkState(root: string, key: string, state: "fixing" | "paused" | "awaiting-deployment"): void {
  // 관련 없는 신규 개발·직접 접수에서는 판별 저장소를 열거나 만들지 않는다.
  const copy = join(root, workDocsDir(key), "triage.json");
  if (!existsSync(copy)) return;
  const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }).parse(JSON.parse(readFileSync(copy, "utf8")));
  if (!existsSync(join(root, triageRecordFile(id)))) return; // 다른 체크아웃의 로컬 기록은 추정하지 않는다.
  locked(root, () => {
    const record = readTriageRecord(root, id);
    if (record.jira?.key === key && record.handedOff && !record.related) {
      record.lifecycle = state;
      save(root, record);
    }
  });
}

export function triageDeployed(root: string, id: string, release: string, evidence: string): string {
  if (!release.trim() || !evidence.trim()) throw new Stop("배포 버전과 사람이 확인한 배포 근거가 필요합니다");
  return locked(root, () => {
    const record = readTriageRecord(root, id);
    if (record.lifecycle !== "awaiting-deployment") throw new Stop("수정 반영 후 배포 대기 상태에서만 배포를 기록합니다");
    record.deployment = { release, evidence, at: new Date().toISOString() };
    record.lifecycle = "resolved";
    save(root, record);
    return `배포 확인을 기록했습니다 (원격 검증 없음).\n${triageSummary(record)}`;
  });
}

export function triageAttach(root: string, id: string, reason: string): string {
  if (!reason.trim()) throw new Stop("동일 원인으로 확인한 근거가 필요합니다");
  return locked(root, () => {
    const currentRecord = current(root), target = readTriageRecord(root, id);
    if (!currentRecord.intake || !target.intake || currentRecord.id === id || currentRecord.jira
      || currentRecord.intake.project !== target.intake.project || target.related || target.lifecycle === "resolved") {
      throw new Stop("같은 프로젝트의 미해결 기록으로만 병합할 수 있습니다");
    }
    currentRecord.related = id;
    currentRecord.lifecycle = "paused";
    save(root, currentRecord);
    writeAtomic(join(root, triageFolder(currentRecord.id), "match.json"), JSON.stringify({ id, reason }));
    unlinkSync(join(root, TRIAGE_ACTIVE));
    return `기존 오류에 연결했습니다. 새 Jira·수정 실행은 생략합니다.\n${triageSummary(target)}`;
  });
}
