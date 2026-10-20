/** Codex app-server stdio。JSON-RPC 승인 응답은 살아 있는 호출에만 전달한다. */
import type { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { StringDecoder } from "string_decoder";
import { realpathSync } from "fs";
import { join } from "path";
import type { CodexHostProfile } from "./protocol";
import { readRun, type RunRecord } from "./store";
import { closeCodexPermissions, forwardCodexPermission, publishCodexPermission, recordCodexCommandResult, type CodexApproval } from "./codexPermissions";

type Row = Record<string, any>;
export class CodexTransport {
  private readonly connectionId = randomUUID();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private seq = 0;
  private closed = false;
  private ending = false;
  private threadId?: string;
  private turnId?: string;
  private readonly requests = new Map<string, { resolve: (result: Row) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly approvals = new Map<string, { requestId: string; rpcId: string | number }>();
  private readonly answered = new Set<string>();
  constructor(private readonly root: string, private readonly run: RunRecord, private readonly profile: CodexHostProfile,
    private readonly child: ChildProcess, private readonly output: (row: Row) => void, private readonly fail: (error: string) => void) {
    child.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 16 * 1024 * 1024) { this.fail("Codex app-server 메시지 크기 상한을 넘었습니다"); return; }
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
        if (!line || this.closed) continue;
        try { this.receive(JSON.parse(line)); }
        catch (error) { this.fail(`Codex app-server 처리 실패: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
    child.stdin!.on("error", error => { if (!this.closed && !this.ending) this.fail(`Codex 승인 통신 실패: ${error.message}`); });
    child.once("close", () => this.close());
  }
  private send(message: Row): void {
    if (this.closed || this.child.stdin!.destroyed || this.child.stdin!.writableEnded) throw new Error("Codex app-server 연결이 종료됐습니다");
    this.child.stdin!.write(JSON.stringify(message) + "\n");
  }
  private request(method: string, params: Row): Promise<Row> {
    const id = `ca-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error(`${method} 응답 시간 초과`)); }, 60000);
      this.requests.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.requests.delete(id); reject(error); }
    });
  }
  async start(prompt: string): Promise<void> {
    try {
      await this.request("initialize", { clientInfo: { name: "code_agent", title: "code-agent", version: "1.0.0" } });
      this.send({ method: "initialized", params: {} });
      const hooks = await this.request("hooks/list", { cwds: [this.root] });
      const expectedSource = realpathSync(join(this.root, ".codex/hooks.json"));
      const activeGuard = hooks.data?.some((entry: Row) => realpathSync(entry.cwd) === realpathSync(this.root) && !entry.errors?.length &&
        entry.hooks?.some((hook: Row) => hook.eventName === "preToolUse" && hook.handlerType === "command" && hook.enabled && !hook.async &&
          ["trusted", "managed"].includes(hook.trustStatus) && realpathSync(hook.sourcePath) === expectedSource && /\bcodex-event\b/.test(hook.command)));
      if (!activeGuard) throw new Error("Codex app-server가 신뢰된 code-agent PreToolUse hook을 로드하지 않았습니다. 현재 hook을 검토·신뢰하세요");
      const result = await this.request(this.run.mode === "continue" ? "thread/resume" : "thread/start", {
        ...(this.run.mode === "continue" ? { threadId: this.run.sessionId } : {}), cwd: this.root, sandbox: this.profile.sandbox,
        approvalPolicy: "on-request", approvalsReviewer: "user", ...(this.profile.model ? { model: this.profile.model } : {}),
      });
      const id = result.thread?.id;
      if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) || (this.run.mode === "continue" && id !== this.run.sessionId)) throw new Error("Codex thread ID가 없거나 재개할 세션과 다릅니다");
      this.threadId = id;
      // 감독이 세션을 영속화한 뒤에만 도구를 시작한다.
      this.output({ type: "thread.started", thread_id: id });
      const turn = await this.request("turn/start", { threadId: id, input: [{ type: "text", text: prompt }], approvalPolicy: "on-request", approvalsReviewer: "user" });
      if (this.turnId && turn.turn?.id !== this.turnId) throw new Error("Codex turn ID가 다릅니다");
      this.turnId = turn.turn?.id;
      if (!this.turnId) throw new Error("Codex turn ID가 없습니다");
    } catch (error) { if (!this.closed) this.fail(error instanceof Error ? error.message : String(error)); }
  }
  private receive(row: Row): void {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("잘못된 JSON-RPC 메시지");
    if (row.id !== undefined && !row.method) {
      const pending = this.requests.get(row.id);
      if (!pending) return;
      this.requests.delete(row.id); clearTimeout(pending.timer);
      if (row.error) pending.reject(new Error(String(row.error.message ?? "Codex RPC 실패"))); else pending.resolve(row.result ?? {});
      return;
    }
    const p = row.params ?? {};
    if (row.id !== undefined) {
      if (typeof row.id !== "string" && typeof row.id !== "number") throw new Error("잘못된 RPC ID");
      const key = JSON.stringify(row.id);
      if (this.answered.has(key)) throw new Error("이미 응답한 Codex RPC ID를 다시 받았습니다");
      if (this.ending) { this.send({ id: row.id, error: { code: -32600, message: "turn ended" } }); return; }
      if (row.method !== "item/commandExecution/requestApproval") {
        // 파일·네트워크·MCP·권한 묶음은 이 단건 Git 승인 경로로 허용하지 않는다.
        this.send({ id: row.id, error: { code: -32601, message: "code-agent supports only scoped Git command approvals" } });
        this.output({ type: "permission.denied", method: row.method, reason: "지원하지 않는 호스트 요청" });
        this.answered.add(key); return;
      }
      try {
        this.output({ type: "permission.requested", rpcId: row.id, threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, command: p.command, cwd: p.cwd, kind: p.kind, environmentId: p.environmentId });
        if (!this.threadId || p.threadId !== this.threadId || !this.turnId || p.turnId !== this.turnId) throw new Error("Codex 권한 요청의 thread·turn이 다릅니다");
        const record = publishCodexPermission(this.root, readRun(this.root, this.run.runId)!, this.connectionId, row.id, p as CodexApproval);
        this.approvals.set(key, { requestId: record.requestId, rpcId: row.id });
      } catch (error) {
        this.send({ id: row.id, result: { decision: "decline" } }); this.answered.add(key);
        this.output({ type: "permission.denied", reason: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (row.method === "thread/started" && this.threadId && p.thread?.id !== this.threadId) throw new Error("Codex thread ID가 실행 중 바뀌었습니다");
    if (row.method === "serverRequest/resolved" && p.threadId === this.threadId) {
      const key = JSON.stringify(p.requestId), pending = this.approvals.get(key);
      if (pending) {
        // 서버가 먼저 닫은 호출에는 늦은 사람 응답을 전달하지 않는다.
        closeCodexPermissions(this.root, this.run.runId, "Codex가 대기 중 권한 호출을 종료했습니다", pending.requestId);
        this.approvals.delete(key); this.answered.add(key);
        this.output({ type: "permission.denied", requestId: pending.requestId, reason: "serverRequest/resolved" });
      }
    }
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return; // 하위 에이전트의 알림은 주 세션 완료로 보지 않는다.
    if (row.method === "hook/completed") this.output({ type: "hook.completed", thread_id: p.threadId, eventName: p.run?.eventName, status: p.run?.status, sourcePath: p.run?.sourcePath });
    if (row.method === "turn/started") {
      if (this.turnId && p.turn?.id !== this.turnId) throw new Error("Codex turn ID가 실행 중 바뀌었습니다");
      this.turnId = p.turn?.id;
    }
    if (row.method === "item/completed") {
      if (p.item?.type === "agentMessage") this.output({ type: "item.completed", item: { type: "agent_message", text: p.item.text } });
      if (p.item?.type === "commandExecution") {
        recordCodexCommandResult(this.root, this.run.runId, p.threadId, p.turnId, p.item);
        this.output({ type: "item.completed", item: { ...p.item, type: "command_execution" } });
      }
    }
    if (row.method === "turn/completed") {
      if (!this.turnId || p.turn?.id !== this.turnId || p.threadId !== this.threadId) throw new Error("완료된 Codex turn ID가 다릅니다");
      const success = p.turn.status === "completed";
      this.output({ type: success ? "turn.completed" : "turn.failed", ...(success ? {} : { error: p.turn.error ?? { message: p.turn.status } }) });
      this.ending = true;
      closeCodexPermissions(this.root, this.run.runId, "원래 Codex 턴이 종료되었습니다. 실행 권한을 재사용하지 않습니다.");
      this.child.stdin!.end();
    }
  }
  poll(): void {
    if (this.closed || this.ending) return;
    for (const [key, approval] of this.approvals) {
      if (forwardCodexPermission(this.root, approval.requestId, this.connectionId, decision => {
        this.send({ id: approval.rpcId, result: { decision } });
        if (decision !== "accept") this.output({ type: "permission.denied", requestId: approval.requestId, decision });
      })) {
        this.approvals.delete(key); this.answered.add(key);
      }
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.requests.values()) { clearTimeout(r.timer); r.reject(new Error("Codex app-server 연결 종료")); }
    this.requests.clear(); this.approvals.clear();
    closeCodexPermissions(this.root, this.run.runId, "원래 Codex 프로세스가 종료되었습니다. 승인 재전송 없이 같은 작업의 상태를 확인하세요.");
  }
}
