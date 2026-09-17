/**
 * 얇은 HTTP 계층. 라우팅과 직렬화만 하고 판단은 하지 않는다.
 *
 * 기본 바인딩이 127.0.0.1 인 것은 의도다 — 이 서버는 대상 저장소를 읽고 build/test 명령을
 * 이 머신에서 실행한다. 외부에 열면 그게 그대로 원격 명령 실행이 된다.
 *
 * 밖에 내놓으려면 앞에 인증하는 프록시를 두고 `--auth-header` 로 그 주체를 받는다.
 * 그때 이 파일이 지키는 것은 셋이다.
 *
 * - **누구의 요청인가** — 인증 주체가 곧 작업의 주인이고 승인 원장의 approver 다.
 *   본문에서 받으면 아무 이름이나 적을 수 있어 원장이 증거가 되지 못한다.
 * - **남의 작업은 없는 것과 같다** — 403 이 아니라 404 다. 있다는 사실 자체를 알리지 않는다.
 * - **사람이 보낸 요청인가** — 상태를 바꾸는 요청에는 커스텀 헤더를 요구한다. 브라우저가
 *   그 헤더를 붙이려면 preflight 를 거쳐야 하므로, 다른 사이트가 사람 몰래 이 서버를
 *   두드리는 길(CSRF)이 구조적으로 막힌다. 루프백에 묶였을 때는 Host 까지 본다 —
 *   그러지 않으면 공격자 도메인을 127.0.0.1 로 가리키는 것만으로 같은 문이 다시 열린다.
 */
import { createServer } from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";

import { TurnMismatchError } from "../core/turn";
import * as api from "./api";
import { JobStore } from "./jobs";
import type { JobInput } from "./jobs";
import { JobQueue, settledWithin } from "./queue";
import type { Run } from "./queue";
import { page } from "./ui";

/** 응답 본문 상한. 코드 여러 파일이 오가므로 넉넉하되 무제한은 아니다. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** 응답이 어느 자리에서 나온 것인지 실어 오는 헤더. node 는 헤더 이름을 소문자로 준다. */
const TURN_HEADER = "x-code-agent-turn";

/**
 * 이 시간 안에 끝나면 결과를 그 자리에서 준다. 넘으면 202 로 돌려주고 뒤에서 계속 돈다.
 *
 * 왕복 대부분(파일 몇 개 쓰기)은 여기 한참 못 미치므로 화면은 지금처럼 한 번에 끝난다.
 * 빌드·테스트만 202 로 갈리는데, 그것을 붙잡고 있으면 프록시가 먼저 끊는다.
 */
const FAST_RESPONSE_MS = 2000;

export interface ServeOptions {
  port: number;
  host: string;
  statePath: string;
  /**
   * 인증 주체가 실려 오는 헤더 이름. 없으면 인증이 꺼진다 — 혼자 쓰는 로컬용이다.
   *
   * **앞단 프록시가 이 헤더를 덮어쓴다는 전제**에서만 뜻이 있다. 프록시가 없으면
   * 클라이언트가 스스로 아무 값이나 적어 보낼 수 있어 인증이 아니라 자기 신고가 된다.
   */
  authHeader?: string;
  /** 작업이 가리킬 수 있는 경로의 뿌리. 비면 제한하지 않는다 */
  roots?: string[];
}

/** 없는 작업과 남의 작업을 같은 말로 돌려주기 위한 것 — 있다는 사실도 알리지 않는다 */
class NotFound extends Error {}

/** 상태를 바꾸는 요청에 요구하는 헤더. 값은 보지 않는다 — 있다는 것 자체가 preflight 의 증거다 */
const INTENT_HEADER = "x-code-agent";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 루프백에 묶였는가. 그때만 Host 를 따진다 — 프록시 뒤에서는 Host 가 실제 도메인이다 */
function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/**
 * 이 요청이 **이 서버를 직접 가리켜** 왔는가.
 *
 * DNS rebinding 을 막는다. 공격자가 자기 도메인을 127.0.0.1 로 가리키게 해 두면, 피해자의
 * 브라우저는 그 페이지의 스크립트로 이 서버를 같은 출처처럼 두드릴 수 있다 — 그때 Host
 * 헤더에는 공격자의 도메인이 실린다.
 */
function assertSameHost(req: IncomingMessage, bound: string): void {
  if (!isLoopback(bound)) {
    return;
  }
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").trim();
  if (host === "" || LOOPBACK.has(host)) {
    return;
  }
  throw new Error(
    `이 서버는 루프백에 묶여 있는데 Host 가 ${host} 입니다 — 받지 않았습니다.\n` +
      "  브라우저에서는 http://127.0.0.1:<port> 로 직접 여세요.",
  );
}

/**
 * 사람이 이 화면에서 보낸 요청인가.
 *
 * 값은 보지 않는다. 막고 싶은 것은 **다른 사이트가 사람 몰래 보내는 단순 요청**인데,
 * 커스텀 헤더가 하나라도 붙으면 브라우저가 preflight 를 먼저 보내고 이 서버는 CORS 허용을
 * 내주지 않으므로 거기서 끝난다. curl·Postman 은 헤더를 직접 붙이면 그만이다.
 */
function assertIntent(req: IncomingMessage, method: string): void {
  if (method === "GET" || method === "HEAD") {
    return;
  }
  if (req.headers[INTENT_HEADER] !== undefined) {
    return;
  }
  throw new Error(
    `상태를 바꾸는 요청에는 ${INTENT_HEADER} 헤더가 필요합니다 — 받지 않았습니다.\n` +
      "  값은 무엇이든 됩니다(예: 1). 다른 사이트가 사람 몰래 보내는 요청을 막기 위한 것입니다.",
  );
}

/** 프록시가 알려 준 요청자. 인증이 꺼져 있으면 undefined 이고, 그때는 주인 개념이 없다 */
function requesterOf(req: IncomingMessage, authHeader?: string): string | undefined {
  if (!authHeader) {
    return undefined;
  }
  const raw = req.headers[authHeader.toLowerCase()];
  const value = (Array.isArray(raw) ? raw[0] : raw ?? "").trim();
  if (value === "") {
    throw new Unauthorized(
      `${authHeader} 헤더가 없습니다 — 인증되지 않은 요청입니다.\n` +
        "  이 서버는 앞단 프록시가 인증하고 그 주체를 이 헤더로 넘겨 준다는 전제로 떠 있습니다.",
    );
  }
  return value;
}

class Unauthorized extends Error {}

/** 요청 하나를 지나며 채워지는 것. 기록은 route 밖에서 찍으므로 여기에 모아 둔다 */
interface Trace {
  requester?: string;
  error?: string;
}

/**
 * 한 줄짜리 기록. **상태를 바꾼 요청과 실패한 요청만 남긴다.**
 *
 * 조회까지 남기면 화면이 폴링할 때마다 몇 줄씩 쌓여 정작 봐야 할 줄이 묻힌다. 남겨야 하는
 * 것은 "누가 무엇을 바꿨는가"와 "무엇이 왜 거절됐는가" 둘이고, 그 둘은 나중에 "이 승인은
 * 누가 눌렀나"를 되짚는 자리다 — 원장이 담지 못하는 거절과 실패까지 여기 남는다.
 */
function logRequest(
  req: IncomingMessage,
  res: ServerResponse,
  startedAt: number,
  trace: Trace,
): void {
  const method = req.method ?? "GET";
  const changed = method !== "GET" && method !== "HEAD";
  if (!changed && res.statusCode < 400) {
    return;
  }

  const line = [
    new Date().toISOString(),
    String(res.statusCode).padStart(3),
    method.padEnd(6),
    (req.url ?? "/").padEnd(34),
    `${Date.now() - startedAt}ms`.padStart(8),
    trace.requester ?? "-",
    trace.error ? `— ${trace.error.split("\n")[0]}` : "",
  ].join("  ");

  // 실패는 표준오류로. 파이프로 갈라 두면 로그를 뒤지지 않아도 고장이 보인다.
  (res.statusCode >= 400 ? console.error : console.log)(line.trimEnd());
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`요청이 너무 큽니다 (상한 ${MAX_BODY_BYTES / 1024 / 1024}MB).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (raw.trim() === "") {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`JSON 파싱 실패: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 응답 전문만 본문 형식이 두 가지다.
 *
 * 이것은 코드블록이 든 수 KB 텍스트인데, JSON 문자열로 감싸는 일이 클라이언트에서 조용히
 * 깨진다 — PowerShell 의 ConvertTo-Json 은 긴 문자열을 `{value, Count}` 객체로 감싼다.
 * 그래서 `text/plain` 이면 본문을 그대로 받고, JSON 이면 감싸기가 깨졌는지 여기서 말해 준다.
 */
async function readResponseText(req: IncomingMessage): Promise<string> {
  if ((req.headers["content-type"] ?? "").startsWith("text/plain")) {
    return readBody(req);
  }

  const body = await readJson<{ response?: unknown }>(req);
  if (body.response !== undefined && typeof body.response !== "string") {
    throw new Error(
      `response 는 문자열이어야 하는데 ${typeof body.response} 를 받았습니다. ` +
        "감싸지 말고 Content-Type: text/plain 으로 응답 전문을 그대로 본문에 실으세요.",
    );
  }
  return body.response ?? "";
}

/**
 * 상태를 바꾸는 요청 하나를 그 작업의 줄에 태우고, 빨리 끝나면 그 자리에서 돌려준다.
 *
 * 느린 것(빌드·테스트)만 202 로 갈린다. 그때도 실행은 계속 돌고 있고, 클라이언트는
 * `GET /api/jobs/:id/runs/:runId` 로 받아 간다.
 */
async function settleOrAccept(
  res: ServerResponse,
  run: Run,
  pending: () => unknown,
): Promise<void> {
  await settledWithin(run, FAST_RESPONSE_MS);

  if (run.state.status === "done") {
    json(res, 200, run.state.value);
    return;
  }
  if (run.state.status === "failed") {
    // 기존 오류 처리를 그대로 지나가게 던진다 — 400·409 구분이 한 자리에만 있어야 한다.
    throw run.state.error;
  }
  json(res, 202, { runId: run.id, what: run.what, since: run.startedAt, ...(pending() as object) });
}

/**
 * 요청 하나를 처리한다. 던져진 오류는 전부 400으로 나간다 —
 * 여기서 나오는 오류는 대개 경로 오타나 잘못 붙여넣은 응답이라 사용자가 고칠 수 있는 것들이다.
 */
async function route(
  store: JobStore,
  queue: JobQueue,
  options: ServeOptions,
  req: IncomingMessage,
  res: ServerResponse,
  trace: Trace,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  assertSameHost(req, options.host);
  assertIntent(req, method);
  const requester = requesterOf(req, options.authHeader);
  trace.requester = requester;

  /** 내 작업인가. 없는 것과 남의 것을 구분해 알리지 않는다 */
  const requireJob = (id: string) => {
    const job = store.list().find((candidate) => candidate.id === id);
    if (!job || !store.visibleTo(job, requester)) {
      throw new NotFound(`그런 작업이 없습니다: ${id}`);
    }
  };

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    const html = page();
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (path === "/api/jobs") {
    if (method === "GET") {
      json(res, 200, { jobs: api.listJobs(store, requester) });
      return;
    }
    if (method === "POST") {
      const input = await readJson<JobInput>(req);
      const job = store.create(input, requester);
      try {
        json(res, 201, api.status(store, job.id));
      } catch (error) {
        // 만들어는 놓고 응답을 못 만들면, 사람은 실패로 보는데 서버에는 남는다 —
        // 그러면 같은 요청을 다시 보낼 때 "이미 같은 출력 디렉토리" 로 막힌다.
        store.remove(job.id);
        throw error;
      }
      return;
    }
  }

  const match =
    /^\/api\/jobs\/([^/]+)(?:\/(prompt|response|questions|approval|log)|\/runs\/([^/]+))?$/.exec(
      path,
    );
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const runId = match[3];

    requireJob(id);

    // 진행 중인 실행을 받아 가는 자리. 202 를 받은 클라이언트가 여기로 다시 온다.
    if (runId && method === "GET") {
      const run = queue.get(runId);
      if (!run || run.jobId !== id) {
        json(res, 404, {
          error:
            `그런 실행이 없습니다: ${runId}\n` +
            "  끝난 지 오래된 실행은 잊습니다. 지금 상태는 GET /api/jobs/:id 로 보세요.",
        });
        return;
      }
      if (run.state.status === "running") {
        json(res, 202, { runId: run.id, what: run.what, since: run.startedAt });
        return;
      }
      if (run.state.status === "failed") {
        throw run.state.error;
      }
      json(res, 200, run.state.value);
      return;
    }

    if (!action && method === "GET") {
      // 조회는 줄에 세우지 않는다 — 빌드가 도는 동안에도 상태는 보여야 한다.
      json(res, 200, { ...api.status(store, id), running: queue.runningOn(id) });
      return;
    }
    if (!action && method === "DELETE") {
      store.remove(id);
      queue.release(id);
      json(res, 200, { removed: id });
      return;
    }
    if (action === "prompt" && method === "GET") {
      json(res, 200, api.prompt(store, id));
      return;
    }
    if (action === "response" && method === "POST") {
      // 이 응답이 **어느 자리에서 나온 프롬프트의 것인지**. 없으면 받지 않는다.
      //
      // 커스텀 헤더인 것은 덤이 아니다 — 브라우저가 이 헤더를 붙이려면 preflight 를 거쳐야
      // 하므로, 다른 사이트가 사람 몰래 이 서버를 두드리는 길(CSRF)이 같이 막힌다.
      const issued = String(req.headers[TURN_HEADER] ?? "").trim();
      if (issued === "") {
        throw new Error(
          `${TURN_HEADER} 헤더가 없습니다 — 어느 자리의 응답인지 알 수 없어 받지 않았습니다.\n` +
            "  GET /api/jobs/:id/prompt 의 응답에 있는 token 을 그대로 실어 보내세요.",
        );
      }
      // 본문은 큐에 태우기 **전에** 읽는다 — 소켓은 기다려 주지 않는다.
      const responseText = await readResponseText(req);
      const run = queue.submit(id, "응답 반영", () =>
        api.respond(store, id, responseText, issued),
      );
      await settleOrAccept(res, run, () => ({
        message: "반영이 오래 걸립니다(검증 명령 실행 중). 아래 runId 로 결과를 받아 가세요.",
        next: api.status(store, id),
      }));
      return;
    }
    if (action === "questions" && method === "POST") {
      const body = await readJson<{ answers?: { id: number; answer: string }[] }>(req);
      const run = queue.submit(id, "질문 답변", async () =>
        api.answer(store, id, body.answers ?? []),
      );
      await settleOrAccept(res, run, () => ({}));
      return;
    }
    if (action === "approval" && method === "POST") {
      const body = await readJson<{
        decision?: string;
        approver?: string;
        comment?: string;
        target?: string;
      }>(req);
      const run = queue.submit(id, "판정", async () =>
        api.decide(store, id, { ...body, requester }),
      );
      await settleOrAccept(res, run, () => ({}));
      return;
    }
    if (action === "log" && method === "GET") {
      json(res, 200, api.log(store, id));
      return;
    }
  }

  json(res, 404, { error: `그런 경로가 없습니다: ${method} ${path}` });
}

/** 테스트가 끝나고 닫을 수 있도록 서버를 돌려준다. CLI 는 쓰지 않는다. */
export function serve(options: ServeOptions): Server {
  const store = new JobStore(options.statePath, options.roots ?? []);
  // 줄은 프로세스가 들고 있다. 서버를 껐다 켜면 진행 중이던 실행은 사라지고 — 그래도
  // 상태는 out/ 에 남아 있으므로, 사람은 프롬프트를 다시 받아 이어서 하면 된다.
  const queue = new JobQueue();

  const server = createServer((req, res) => {
    const startedAt = Date.now();
    const trace: Trace = {};
    res.on("finish", () => logRequest(req, res, startedAt, trace));

    route(store, queue, options, req, res, trace).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      trace.error = message;
      // 지나간 자리의 응답은 **사용자가 고칠 수 없는 충돌**이라 400 과 구분한다 —
      // 클라이언트가 이것을 보고 프롬프트를 다시 받아야 하는지 판단할 수 있어야 한다.
      const code =
        err instanceof Unauthorized
          ? 401
          : err instanceof NotFound
            ? 404
            : err instanceof TurnMismatchError
              ? 409
              : 400;
      if (!res.headersSent) {
        json(res, code, { error: message });
      } else {
        res.end();
      }
    });
  });

  // 시작하지 못하는 이유는 대개 포트 충돌이다. 스택트레이스로 죽으면 그것이 안 보인다.
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `포트 ${options.port} 을 이미 쓰고 있습니다.\n` +
          "  --port 로 다른 포트를 주거나, 먼저 떠 있는 서버를 닫으세요.",
      );
    } else {
      console.error(`서버를 시작하지 못했습니다: ${error.message}`);
    }
    process.exitCode = 1;
    server.close();
  });

  server.listen(options.port, options.host, () => {
    console.log(`code-agent 서버: http://${options.host}:${options.port}`);
    console.log(`작업 목록: ${options.statePath}`);

    if (options.authHeader) {
      console.log(`인증: ${options.authHeader} 헤더 (앞단 프록시가 넣어 준다고 신뢰합니다)`);
      const orphans = store.ownerless();
      if (orphans.length > 0) {
        console.log(
          `  ⚠ 주인이 없는 작업 ${orphans.length}건 — 인증을 켜기 전에 만들어진 것들이라` +
            " 아무에게도 보이지 않습니다: " +
            orphans.map((job) => job.id).join(", "),
        );
      }
      if ((options.roots ?? []).length === 0) {
        console.log(
          "  ⚠ --root 가 없습니다. 작업이 이 프로세스가 닿는 모든 경로를 가리킬 수 있습니다.",
        );
      }
    } else if (!isLoopback(options.host)) {
      console.log(
        `\n  ⚠ 인증 없이 ${options.host} 에 열려 있습니다.\n` +
          "    이 서버는 대상 저장소를 읽고 build·test 명령을 이 머신에서 실행합니다 —\n" +
          "    지금 상태는 포트에 닿는 누구나 그것을 시킬 수 있다는 뜻입니다.\n" +
          "    --auth-header 로 앞단 프록시의 인증 주체를 받으세요.",
      );
    }

    console.log("\n브라우저로 위 주소를 열고, 프롬프트를 Console 에 붙여넣으세요.");
  });

  return server;
}
