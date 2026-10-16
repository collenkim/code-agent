/**
 * LangGraph 실행 경계. 도메인 기록이 승인·증거의 원천이고 체크포인트는 실행 위치만 보관한다.
 * 외부 효과가 남은 노드는 재생하지 않는다. 정상 wait만 깨우며 나머지는 새 입력으로 START에서 다시 관찰한다.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { Command } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

import { acquireLock } from "../lock";
import { Stop } from "../stop";
import { GRAPH_DIR, GRAPH_VERSION, type GraphRunStatus } from "./types";
import { MASTER_RUN_ENV, masterRunGuard } from "../master/runGuard";
import { readOwner, readRun } from "../master/store";
import { writeAtomic } from "../../core/atomic";
import type { GraphView } from "./types";

interface Connection { root: string; db: DatabaseSync; saver: SqliteSaver }
const active = new AsyncLocalStorage<Connection>();

/** hook 사이에서도 정지·소유 세대 변경을 검사한다. 한 노드의 자식 프로세스 종료는 master 감독이 담당한다. */
function requireController(root: string): void {
  const id = process.env[MASTER_RUN_ENV];
  if (!id) return;
  if (!/^run-[A-Za-z0-9-]+$/.test(id)) throw new Stop("master 실행 식별자가 올바르지 않습니다.");
  const run = readRun(root, id), owner = readOwner(root);
  if (!run || !owner || run.controller !== owner.controller || run.generation !== owner.generation) throw new Stop("master 실행의 소유 세대가 유효하지 않습니다. 최신 제어자에게 재개를 요청하세요.");
  const stopped = masterRunGuard({ tool_name: "Bash", tool_input: {} }, root);
  if (stopped) throw new Stop(stopped);
}

function connect(root: string): Connection {
  const file = join(root, GRAPH_DIR, "state.sqlite");
  const existing = existsSync(file);
  const db = new DatabaseSync(file);
  try {
    if (existing) {
      const meta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='graph_meta'").get();
      const version = meta ? db.prepare("SELECT value FROM graph_meta WHERE key='version'").get()?.value : undefined;
      if (version !== GRAPH_VERSION) throw new Stop(`그래프 저장 형식 ${version ?? "불명"}은 이 실행기에서 지원하지 않습니다. 설치 버전을 확인하세요.`);
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    db.exec(`CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_runs (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, graph TEXT NOT NULL, version INTEGER NOT NULL,
        status TEXT NOT NULL, node TEXT, started_at TEXT NOT NULL, finished_at TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS graph_runs_thread ON graph_runs(thread_id);
      CREATE TABLE IF NOT EXISTS graph_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, node TEXT NOT NULL,
        status TEXT NOT NULL, at TEXT NOT NULL, detail TEXT
      );`);
    db.prepare("INSERT OR IGNORE INTO graph_meta VALUES ('version', ?)").run(GRAPH_VERSION);
    // 공식 saver가 쓰는 better-sqlite3의 작은 인터페이스를 Node 내장 SQLite에 연결한다.
    const adapter = {
      pragma(sql: string) { return db.exec(`PRAGMA ${sql}`); },
      exec(sql: string) { return db.exec(sql); },
      prepare(sql: string) {
        const statement = db.prepare(sql);
        const values = (args: (SQLInputValue | undefined)[]) => args.map(value => value === undefined ? null : value);
        return {
          run: (...args: (SQLInputValue | undefined)[]) => statement.run(...values(args)),
          get: (...args: (SQLInputValue | undefined)[]) => statement.get(...values(args)),
          all: (...args: (SQLInputValue | undefined)[]) => statement.all(...values(args)),
        };
      },
      transaction(fn: (...args: unknown[]) => unknown) {
        return (...args: unknown[]) => {
          db.exec("BEGIN IMMEDIATE");
          try { const result = fn(...args); db.exec("COMMIT"); return result; }
          catch (error) { db.exec("ROLLBACK"); throw error; }
        };
      },
    };
    return { root, db, saver: new SqliteSaver(adapter as unknown as ConstructorParameters<typeof SqliteSaver>[0]) };
  } catch (error) { db.close(); throw error; }
}

export interface PersistedGraph<S> {
  invoke(input: S, config: RunnableConfig): Promise<S>;
  getState(config: RunnableConfig): Promise<{ next: string[]; tasks: { interrupts?: unknown[] }[] }>;
}

export interface GraphRun {
  id: string;
  threadId: string;
  saver: SqliteSaver;
  config: RunnableConfig;
  event(node: string, status: string, detail?: string): void;
  invoke<S>(graph: PersistedGraph<S>, input: S, resumeWait?: boolean): Promise<S>;
}

/** 같은 프로젝트의 그래프를 직렬화한다. 대기를 반환하면 실행 소유권을 해제한다. */
export async function withGraphRun<T>(root: string, name: string, scope: string, body: (run: GraphRun) => Promise<T>): Promise<T> {
  root = resolve(root);
  requireController(root);
  const parent = active.getStore();
  if (parent && parent.root !== root) throw new Stop("같은 그래프 실행에서 다른 프로젝트를 변경할 수 없습니다.");
  mkdirSync(join(root, GRAPH_DIR), { recursive: true });
  const ignore = join(root, GRAPH_DIR, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const release = parent ? undefined : acquireLock(join(root, GRAPH_DIR, "run.lock"), {
    waitMs: 0, ageReclaim: false, label: "그래프 실행", display: `${GRAPH_DIR}/run.lock`,
  });
  let connection: Connection | undefined;
  try {
    connection = parent ?? connect(root);
    const { db, saver } = connection;
    const id = randomUUID(), threadId = `code-agent:v${GRAPH_VERSION}:${name}:${scope}`;
    const config: RunnableConfig = { configurable: { thread_id: threadId, checkpoint_ns: "" }, recursionLimit: 1024 };
    // 죽은 소유자의 실행 기록은 성공으로 추정하지 않는다. 효과의 확인은 각 도메인 서비스가 한다.
    db.prepare("UPDATE graph_runs SET status='interrupted', finished_at=? WHERE thread_id=? AND status='running'").run(new Date().toISOString(), threadId);
    db.prepare("INSERT INTO graph_runs(id,thread_id,graph,version,status,started_at) VALUES(?,?,?,?,?,?)")
      .run(id, threadId, name, GRAPH_VERSION, "running", new Date().toISOString());
    // SQLite의 readOnly 연결도 WAL 보조 파일을 만들 수 있다. 조회는 원자적으로 발행한 관찰 사본만 읽는다.
    const publish = () => {
      const row = db.prepare("SELECT * FROM graph_runs WHERE id=?").get(id)!;
      const view: GraphView = { version: GRAPH_VERSION, latest: {
        id, threadId, graph: name, status: row.status as GraphRunStatus, node: row.node === null ? null : String(row.node),
        startedAt: String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at),
      }, latestSeq: Number(db.prepare("SELECT coalesce(max(seq),0) AS seq FROM graph_events").get()!.seq) };
      writeAtomic(join(root, GRAPH_DIR, "view.json"), `${JSON.stringify(view)}\n`);
    };
    publish();
    let finalStatus: GraphRunStatus = "completed";
    const run: GraphRun = {
      id, threadId, saver, config,
      event(node, status, detail) {
        if (status === "running") requireController(root);
        db.prepare("UPDATE graph_runs SET node=? WHERE id=?").run(node, id);
        db.prepare("INSERT INTO graph_events(run_id,node,status,at,detail) VALUES(?,?,?,?,?)")
          .run(id, node, status, new Date().toISOString(), detail ?? null);
        publish();
      },
      async invoke(graph, input, resumeWait = false) {
        const prior = resumeWait ? await graph.getState(config) : undefined;
        const waiting = prior?.next.length === 1 && prior.next[0] === "wait" && prior.tasks.some(task => task.interrupts?.length);
        // Command의 노드 이름 타입은 그래프마다 다르다. 이 경계는 resume 신호만 만들며 goto/update는 받지 않는다.
        const result = await graph.invoke(waiting ? new Command({ resume: { recheck: true } }) as unknown as typeof input : input,
          { ...config, durability: "sync" } as RunnableConfig);
        const state = await graph.getState(config);
        if (state.tasks.some(task => task.interrupts?.length)) finalStatus = "waiting";
        return result;
      },
    };
    try {
      const result = await active.run(connection, () => AsyncLocalStorageProviderSingleton.runWithConfig({}, () => body(run), true));
      db.prepare("UPDATE graph_runs SET status=?,finished_at=? WHERE id=?").run(finalStatus, new Date().toISOString(), id);
      publish();
      return result;
    } catch (error) {
      db.prepare("UPDATE graph_runs SET status='failed',finished_at=?,error=? WHERE id=?")
        .run(new Date().toISOString(), error instanceof Error ? error.message : String(error), id);
      publish();
      throw error;
    }
  } finally {
    if (!parent) connection?.db.close();
    release?.();
  }
}
