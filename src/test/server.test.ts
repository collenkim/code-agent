/**
 * 서버 경로의 회귀 테스트.
 *
 * 서버가 하는 일은 CLI와 같아야 한다 — 전송만 다르다. 그래서 여기서 확인하는 것은
 * "왕복 한 번이 상태를 정확히 한 칸 움직이는가"와 "설정 오류가 첫 요청이 아니라
 * 작업을 만들 때 드러나는가" 두 가지다.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { once } from "node:events";
import { request } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import * as api from "../server/api";
import { serve } from "../server/http";
import { JobStore } from "../server/jobs";
import { page } from "../server/ui";

const MANIFEST = {
  language: "python",
  sourceExtensions: [".py"],
  domainBase: "app/features",
  domainRoots: [],
  conventions: ["doc/conventions.md"],
  referenceDomain: "orders",
  stages: [
    {
      key: "model",
      title: "모델",
      template: "01-model.md",
      exemplars: ["models.py"],
      outputDirs: ["."],
    },
    {
      key: "service",
      title: "서비스",
      template: "02-service.md",
      exemplars: ["service.py"],
      outputDirs: ["."],
    },
  ],
};

const PLAN_RESPONSE = JSON.stringify({
  domainName: "shipment",
  domainLabel: "배송",
  domainRoot: "",
  domainDirName: "shipment",
  files: [
    { stage: "model", path: "app/features/shipment/models.py", purpose: "배송 모델" },
    { stage: "service", path: "app/features/shipment/service.py", purpose: "배송 서비스" },
  ],
  conventions: [{ rule: "dataclass 를 쓴다", source: "doc/conventions.md" }],
  conflicts: [],
  openQuestions: [],
  reasoning: "참조 도메인 구조를 그대로 따랐다",
});

/** 생성 단계 응답 — 채팅에서 오는 지시 블록 형태 그대로 */
const MODEL_RESPONSE = [
  "### write app/features/shipment/models.py",
  "```python",
  "from dataclasses import dataclass",
  "",
  "@dataclass",
  "class Shipment:",
  "    id: int",
  "```",
  "",
  "### done",
].join("\n");

let root: string;
let repoRoot: string;
let statePath: string;
let store: JobStore;
let jobId: string;

/**
 * 화면이 하는 일과 같다 — 프롬프트를 받은 자리의 토큰을 응답과 함께 되돌려 준다.
 * 실제 화면도 `GET /prompt` 로 받은 token 을 그대로 실어 보낸다.
 */
function respond(text: string) {
  return api.respond(store, jobId, text, api.prompt(store, jobId).token);
}

/** 대상 하나가 도는 자리. 대상마다 갈라지므로 out/ 바로 아래가 아니다. */
function lane(...parts: string[]): string {
  return join(root, "out", "TEST-1", "shipment", ...parts);
}

function write(relativePath: string, content: string) {
  const path = join(repoRoot, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "code-agent-server-test-"));
  repoRoot = join(root, "repo");
  statePath = join(root, "state", "jobs.json");

  write("app/features/orders/models.py", "from dataclasses import dataclass\n\n@dataclass\nclass Order:\n    id: int\n");
  write("app/features/orders/service.py", "class OrderService:\n    pass\n");
  write("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
  write("doc/templates/code-agent.json", JSON.stringify(MANIFEST, null, 2));
  write("doc/templates/01-model.md", "# [01] 모델\n\n## 4. 자가검증 체크리스트\n- [ ] dataclass 인가\n");
  write("doc/templates/02-service.md", "# [02] 서비스\n");
  // 0차 게이트가 생긴 뒤로는 어떤 실행이든 작업 지시서 머리말이 있어야 한다.
  writeFileSync(
    join(root, "spec.md"),
    "---\nkind: feature\nid: TEST-1\ntitle: 배송 도메인 추가\ntarget: shipment\n---\n\n" +
      "# 배송(shipment) 도메인. 필드: id\n",
    "utf-8",
  );

  store = new JobStore(statePath);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("JobStore — 작업 목록", () => {
  test("작업을 만들 때 설정을 실제로 읽어 본다", async () => {
    // 경로 오타를 첫 프롬프트 요청까지 끌고 가면 어디가 틀렸는지 알기 어려워진다.
    await assert.rejects(
      () =>
        store.create({
          repo: repoRoot,
          templates: "doc/없는디렉토리",
          out: join(root, "out-bad"),
        }),
      /code-agent\.json/,
    );
  });

  test("정상 설정이면 작업이 만들어진다", async () => {
    const job = await store.create({
      label: "shipment",
      repo: repoRoot,
      templates: "doc/templates",
      out: join(root, "out"),
      specs: [join(root, "spec.md")],
    });

    jobId = job.id;
    assert.equal(job.label, "shipment");
    assert.equal(store.list().length, 1);
  });

  test("같은 출력 디렉토리를 쓰는 작업은 거부한다", async () => {
    // 계획과 세션이 out/ 안에 있어 섞이면 두 작업 다 못 쓰게 된다.
    await assert.rejects(
      () =>
        store.create({
          repo: repoRoot,
          templates: "doc/templates",
          out: join(root, "out"),
        }),
      /이미 같은 출력 디렉토리/,
    );
  });

  test("새 인스턴스가 디스크에서 작업을 복구한다", async () => {
    // 서버를 껐다 켜도 이어져야 한다.
    assert.equal(new JobStore(statePath).list().length, 1);
  });
});

describe("왕복 — 프롬프트 하나에 상태 한 칸", () => {
  test("처음 할 차례는 계획이다", async () => {
    const state = api.status(store, jobId);

    assert.equal(state.target, "plan");
    assert.equal(state.hasPlan, false);
    assert.equal(state.turn, 0);
  });

  test("프롬프트를 여러 번 받아도 상태가 움직이지 않는다", async () => {
    const first = api.prompt(store, jobId).prompt;
    const second = api.prompt(store, jobId).prompt;

    assert.equal(first, second);
    assert.equal(api.status(store, jobId).turn, 0, "프롬프트 요청은 턴이 아니다");
  });

  test("빈 응답은 반영하지 않는다", async () => {
    await assert.rejects(() => respond("   "), /빈 응답/);
  });

  test("계획을 반영하면 승인을 기다린다 — 곧장 생성으로 가지 않는다", async () => {
    const out = await respond(PLAN_RESPONSE);

    assert.ok(out.planSaved, "계획 파일이 저장돼야 한다");
    assert.equal(out.advanced, true);
    assert.equal(out.next.target, "approval", "2차 게이트에서 멈춰야 한다");
    assert.equal(out.next.needsApproval, true);
    assert.equal(out.next.turn, 1);
    assert.equal(api.prompt(store, jobId).prompt, undefined, "승인 전에는 프롬프트가 없다");
    assert.match(api.prompt(store, jobId).message ?? "", /계획 승인이 필요합니다/);
  });

  test("반려에는 사유가 필요하고, 승인하면 첫 단계로 넘어간다", async () => {
    assert.throws(
      () => api.decide(store, jobId, { decision: "rejected", approver: "팀장" }),
      /사유/,
      "반려는 가장 값진 기록이라 사유 없이 남기지 않는다",
    );

    const out = api.decide(store, jobId, { decision: "approved", approver: "팀장" });

    assert.match(out.message, /승인/);
    assert.equal(out.next.target, "model");
    assert.equal(out.next.needsApproval, false);
    assert.ok(existsSync(join(repoRoot, ".code-agent", "approvals", "TEST-1.jsonl")));
  });

  test("생성 프롬프트에 참조 표준이 실려 있다", async () => {
    const body = api.prompt(store, jobId).prompt ?? "";

    assert.match(body, /class Order/, "참조 도메인 코드가 선주입돼야 한다");
    assert.match(body, /dataclass 를 쓴다/, "컨벤션이 실려야 한다");
  });

  test("응답을 반영하면 파일이 out/ 에 쓰이고 검수로 넘어간다", async () => {
    const out = await respond(MODEL_RESPONSE);

    assert.equal(out.violations.length, 0);
    assert.equal(out.writtenFiles.length, 1);
    assert.equal(out.advanced, true);
    assert.equal(out.next.target, "gate:model");
    assert.ok(existsSync(lane("app/features/shipment/models.py")));
  });

  test("검수를 통과해도 사람이 확정해야 다음 단계로 넘어간다", async () => {
    const out = await respond(JSON.stringify({ violations: [] }));

    assert.equal(out.advanced, true);
    assert.equal(out.next.target, "confirm:model", "검수는 모델이 했고, 받아들일지는 사람이 정한다");
    assert.equal(out.next.pending, "stage");
    assert.equal(out.next.hasPrompt, false, "확정 대기 중에는 프롬프트가 나오지 않는다");

    const confirmed = api.decide(store, jobId, { decision: "approved", approver: "팀장" });

    assert.match(confirmed.message, /단계 model/);
    assert.equal(confirmed.next.target, "service");
  });

  test("형식이 깨진 응답은 아무것도 반영하지 않는다", async () => {
    const out = await respond("네, 코드를 만들어 드리겠습니다!");

    assert.ok(out.parseErrors.length > 0);
    assert.equal(out.writtenFiles.length, 0);
    assert.equal(out.advanced, false);
    assert.equal(out.next.target, "service", "같은 단계에 머문다");
  });

  test("경계 밖 파일은 거부되고 디스크에 남지 않는다", async () => {
    const response = [
      "### write app/features/other/hack.py",
      "```python",
      "x = 1",
      "```",
      "",
      "### done",
    ].join("\n");

    const out = await respond(response);

    assert.equal(out.violations.length, 1);
    assert.match(out.violations[0].item, /경계/);
    assert.equal(out.writtenFiles.length, 0);
    assert.equal(existsSync(lane("app/features/other/hack.py")), false);
  });
});

describe("질문 — 답할 때까지 멈춘다", () => {
  test("모델이 물으면 진행이 막힌다", async () => {
    const out = await respond("### ask\n주소 최대 길이는?");

    assert.equal(out.questionsAdded, 1);
    assert.equal(out.next.target, "blocked");
    assert.equal(out.next.openQuestionCount, 1);
    assert.equal(out.next.hasPrompt, false, "막힌 동안에는 프롬프트가 나오지 않는다");
  });

  test("없는 질문에 답하려 하면 알려준다", async () => {
    assert.throws(() => api.answer(store, jobId, [{ id: 99, answer: "x" }]), /그런 질문이 없습니다/);
  });

  test("답을 채우면 풀리고 그 답이 프롬프트에 실린다", async () => {
    const state = api.answer(store, jobId, [{ id: 1, answer: "최대 200자" }]);

    assert.equal(state.openQuestionCount, 0);
    assert.equal(state.target, "service");

    const body = api.prompt(store, jobId).prompt ?? "";
    assert.match(body, /최대 200자/, "사람이 답한 것이 다음 프롬프트에 들어가야 한다");
  });
});

/**
 * 여기만 실제 HTTP 를 탄다. 응답 전문을 JSON 문자열로 감싸는 일이 클라이언트에서 조용히
 * 깨지기 때문에(PowerShell 의 ConvertTo-Json), 본문 형식은 api 함수가 아니라 전송 계층에서
 * 판정된다 — 그 자리를 직접 두드려야 회귀가 잡힌다.
 */
/** 상태를 바꾸는 요청에 붙는 헤더. 화면이 붙이는 것과 같다 */
const INTENT = { "x-code-agent": "1" };

describe("응답 전송 — 본문 형식", () => {
  let server: Server;
  let base: string;

  before(async () => {
    // 위 왕복이 움직여 놓은 작업에 얹으면 무엇을 재는지 흐려진다. 따로 만든다.
    const job = await new JobStore(statePath).create({
      label: "http",
      repo: repoRoot,
      templates: "doc/templates",
      out: join(root, "out-http"),
      specs: [join(root, "spec.md")],
    });

    // 포트 0 이면 빈 포트를 커널이 고른다 — 테스트가 특정 포트를 점유하지 않는다.
    server = serve({ port: 0, host: "127.0.0.1", statePath });
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jobs/${job.id}`;
  });

  after(() => {
    server.close();
  });

  /** 지금 자리의 토큰. 화면이 GET /prompt 로 받아 두는 것과 같다 */
  async function turnToken(): Promise<string> {
    const res = await fetch(`${base}/prompt`);
    return ((await res.json()) as { token: string }).token;
  }

  test("response 가 문자열이 아니면 무엇이 잘못됐는지 알려 준다", async () => {
    // PowerShell 의 ConvertTo-Json 이 긴 문자열을 이렇게 감싼다. 여기서 걸러 주지 않으면
    // "responseText.trim is not a function" 이 나가 원인을 짐작할 수 없다.
    const res = await fetch(`${base}/response`, {
      method: "POST",
      headers: { ...INTENT, "content-type": "application/json", "x-code-agent-turn": await turnToken() },
      body: JSON.stringify({ response: { value: PLAN_RESPONSE, Count: 1 } }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /문자열이어야/);
    assert.match(body.error, /text\/plain/, "어떻게 고치는지까지 알려 줘야 한다");
  });

  test("text/plain 본문은 감싸지 않고 그대로 들어간다", async () => {
    const res = await fetch(`${base}/response`, {
      method: "POST",
      headers: { ...INTENT, "content-type": "text/plain; charset=utf-8", "x-code-agent-turn": await turnToken() },
      body: PLAN_RESPONSE,
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { planSaved?: string };
    assert.ok(body.planSaved, "감싸지 않은 본문으로 계획이 저장돼야 한다");
  });

  test("JSON 본문도 그대로 돈다", async () => {
    const res = await fetch(`${base}/response`, {
      method: "POST",
      headers: { ...INTENT, "content-type": "application/json", "x-code-agent-turn": await turnToken() },
      body: JSON.stringify({ response: "네, 코드를 만들어 드리겠습니다!" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { parseErrors: string[]; advanced: boolean };
    // 문자열이 실제로 건너갔다는 증거 — 형식이 깨진 채로 파서까지 도달했다.
    assert.ok(body.parseErrors.length > 0);
    assert.equal(body.advanced, false, "형식이 깨진 응답은 상태를 움직이지 않는다");
  });

  test("자리 토큰이 없으면 받지 않는다", async () => {
    const res = await fetch(`${base}/response`, {
      method: "POST",
      headers: { ...INTENT, "content-type": "text/plain; charset=utf-8" },
      body: PLAN_RESPONSE,
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /x-code-agent-turn/i);
    assert.match(body.error, /token/, "어디서 얻는지까지 알려 줘야 한다");
  });

  test("지나간 자리의 응답은 409 로 거부하고 아무것도 반영하지 않는다", async () => {
    const stale = await turnToken();

    // 누군가 먼저 반영해 상태가 움직였다.
    const first = await fetch(`${base}/response`, {
      method: "POST",
      headers: { ...INTENT, "content-type": "text/plain; charset=utf-8", "x-code-agent-turn": stale },
      body: PLAN_RESPONSE,
    });
    assert.equal(first.status, 200);

    // 같은 토큰으로 다시 — 그 자리는 이미 지나갔다.
    const again = await fetch(`${base}/response`, {
      method: "POST",
      headers: { ...INTENT, "content-type": "text/plain; charset=utf-8", "x-code-agent-turn": stale },
      body: PLAN_RESPONSE,
    });

    assert.equal(again.status, 409, "충돌은 요청 오류(400)와 구분돼야 한다");
    const body = (await again.json()) as { error: string };
    assert.match(body.error, /아무것도 반영하지 않았습니다/);
  });
});

/**
 * 여럿이 쓰는 서버 — 요청이 누구의 것인지 갈리고, 남의 것은 보이지 않는다.
 *
 * 여기서 판정되는 것은 "인증을 켜면 소유권이 실제로 작동하는가"다. 이것이 없으면
 * 포트에 닿는 누구나 남의 계획을 승인할 수 있고, 원장의 approver 는 자기 신고가 된다.
 */
describe("여럿이 쓸 때 — 인증과 소유권", () => {
  let server: Server;
  let base: string;
  let mine: string;

  const as = (user: string) => ({ ...INTENT, "x-auth-user": user });

  before(async () => {
    // **자기 지시서를 쓴다.** 승인 원장은 저장소 안에서 지시서 id 로 갈리므로, 앞선 테스트와
    // 같은 id 를 쓰면 그쪽 승인이 이쪽 게이트를 열어 무엇을 재는지 흐려진다.
    writeFileSync(
      join(root, "spec-auth.md"),
      "---\nkind: feature\nid: AUTH-1\ntitle: 인증 시험\ntarget: shipment\n---\n\n" +
        "# 배송(shipment) 도메인. 필드: id\n",
      "utf-8",
    );

    const store = new JobStore(join(root, "jobs-auth.json"));
    mine = (
      await store.create(
        {
          label: "kai 의 작업",
          repo: repoRoot,
          templates: "doc/templates",
          out: join(root, "out-auth"),
          specs: [join(root, "spec-auth.md")],
        },
        "kai@crm.co.kr",
      )
    ).id;

    server = serve({
      port: 0,
      host: "127.0.0.1",
      statePath: join(root, "jobs-auth.json"),
      authHeader: "X-Auth-User",
    });
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  test("인증 헤더가 없으면 401 이다", async () => {
    const res = await fetch(`${base}/api/jobs`);

    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /X-Auth-User/);
  });

  test("남의 작업은 있다는 사실도 알리지 않는다 — 403 이 아니라 404", async () => {
    const res = await fetch(`${base}/api/jobs/${mine}`, {
      headers: { "x-auth-user": "someone-else@crm.co.kr" },
    });

    assert.equal(res.status, 404);
  });

  test("목록에는 내 것만 나온다", async () => {
    const other = await fetch(`${base}/api/jobs`, {
      headers: { "x-auth-user": "someone-else@crm.co.kr" },
    });
    assert.deepEqual(((await other.json()) as { jobs: unknown[] }).jobs, []);

    const owner = await fetch(`${base}/api/jobs`, {
      headers: { "x-auth-user": "kai@crm.co.kr" },
    });
    assert.equal(((await owner.json()) as { jobs: unknown[] }).jobs.length, 1);
  });

  test("승인자는 본문이 아니라 인증 주체에서 온다 — 자기 신고가 되지 않게", async () => {
    // 계획부터 세운다.
    const prompt = await fetch(`${base}/api/jobs/${mine}/prompt`, { headers: as("kai@crm.co.kr") });
    const token = ((await prompt.json()) as { token: string }).token;

    await fetch(`${base}/api/jobs/${mine}/response`, {
      method: "POST",
      headers: { ...as("kai@crm.co.kr"), "content-type": "text/plain", "x-code-agent-turn": token },
      body: PLAN_RESPONSE,
    });

    // 본문에는 다른 이름을 적어 보낸다. 원장에는 인증 주체가 남아야 한다.
    const res = await fetch(`${base}/api/jobs/${mine}/approval`, {
      method: "POST",
      headers: { ...as("kai@crm.co.kr"), "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", approver: "팀장인-척" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { message: string };
    assert.match(body.message, /kai@crm\.co\.kr/);
    assert.doesNotMatch(body.message, /팀장인-척/, "본문의 이름이 원장에 들어가면 안 된다");
  });

  test("상태를 바꾸는 요청에는 의도 헤더가 필요하다 — 다른 사이트가 몰래 보내지 못하게", async () => {
    const res = await fetch(`${base}/api/jobs`, {
      method: "POST",
      // 브라우저의 '단순 요청' 흉내 — 커스텀 헤더가 없다
      headers: { "content-type": "text/plain", "x-auth-user": "kai@crm.co.kr" },
      body: JSON.stringify({ repo: repoRoot, templates: "doc/templates", out: join(root, "x") }),
    });

    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /x-code-agent/);
  });

  test("루프백에 묶였는데 Host 가 다르면 받지 않는다 — DNS rebinding", async () => {
    // fetch 는 Host 를 금지된 헤더로 보고 무시한다. 공격자는 그런 제약을 받지 않으므로
    // (자기 도메인을 127.0.0.1 로 가리키면 브라우저가 알아서 그 Host 를 싣는다) 날것으로 보낸다.
    const port = (server.address() as AddressInfo).port;
    const answered = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const call = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/jobs",
          method: "GET",
          headers: { host: "evil.example.com", "x-auth-user": "kai@crm.co.kr" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      call.on("error", reject);
      call.end();
    });

    assert.equal(answered.status, 400);
    assert.match(answered.body, /Host/);
  });
});

describe("경로 울타리 — --root", () => {
  test("뿌리 밖을 가리키는 작업은 만들지 않는다", async () => {
    const store = new JobStore(join(root, "jobs-root.json"), [join(root, "repo")]);

    await assert.rejects(
      () =>
        store.create({
          repo: repoRoot,
          templates: "doc/templates",
          out: join(tmpdir(), "code-agent-somewhere-else"),
        }),
      /허용된 경로 밖입니다/,
    );
  });

  test("뿌리 안이면 그대로 만들어진다", async () => {
    const store = new JobStore(join(root, "jobs-root2.json"), [root]);

    const job = await store.create({
      repo: repoRoot,
      templates: "doc/templates",
      out: join(root, "out-fenced"),
      specs: [join(root, "spec.md")],
    });

    assert.ok(job.id);
  });

  test("링크 별칭으로 같은 out 을 두 번 등록할 수 없다", async () => {
    // 울타리는 링크를 풀어 보는데 중복 검사가 문자열만 보면, 같은 디렉토리가 두 작업으로
    // 등록된다. 그 둘은 같은 계획·세션 파일을 나눠 쓰면서 서로 다른 줄에 선다.
    const real = join(root, "out-alias");
    mkdirSync(real, { recursive: true });
    const alias = join(root, "out-alias-link");
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");

    try {
      const store = new JobStore(join(root, "jobs-alias.json"));
      const made = await store.create({
        repo: repoRoot,
        templates: "doc/templates",
        out: real,
        specs: [join(root, "spec.md")],
      });

      await assert.rejects(
        () =>
          store.create({
            repo: repoRoot,
            templates: "doc/templates",
            out: alias,
            specs: [join(root, "spec.md")],
          }),
        /이미 같은 출력 디렉토리/,
      );
      assert.equal(store.list().length, 1, `${made.id} 하나만 남아야 한다`);
    } finally {
      rmSync(alias, { recursive: true, force: true });
    }
  });

  test("같은 out 으로 동시에 들어와도 하나만 만들어진다", async () => {
    // 중복 검사와 등록 사이에 브랜치를 굳히는 await 가 있다. 둘이 겹치면 둘 다 "중복 없음"을
    // 보고 양보한 뒤 둘 다 등록된다 — 작업 하나에 out 하나라는 전제가 거기서 깨진다.
    const store = new JobStore(join(root, "jobs-race.json"));
    const same = {
      repo: repoRoot,
      templates: "doc/templates",
      out: join(root, "out-race"),
      specs: [join(root, "spec.md")],
    };

    const results = await Promise.allSettled([store.create(same), store.create(same)]);

    const made = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");

    assert.equal(made.length, 1, "하나만 만들어져야 한다");
    assert.equal(refused.length, 1);
    assert.match(
      (refused[0] as PromiseRejectedResult).reason.message,
      /이미 같은 출력 디렉토리/,
    );
    assert.equal(store.list().length, 1);
    // 디스크에도 하나만 남아야 한다 — 서버를 껐다 켜면 이 파일이 곧 목록이다.
    assert.equal(new JobStore(join(root, "jobs-race.json")).list().length, 1);
  });

  test("링크로 뿌리 밖을 가리키는 경로는 울타리를 넘지 못한다", async () => {
    // 문자열만 보는 울타리는 이것을 통과시켰다. Windows 의 junction 은 관리자 권한도
    // 필요 없어서, 뿌리 안에 쓸 수 있는 사람이면 누구나 밖의 파일을 읽고 쓸 수 있었다.
    const outside = mkdtempSync(join(tmpdir(), "code-agent-outside-"));
    const link = join(root, "escape");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");

    try {
      // 뿌리는 root — 저장소도 스펙도 그 안에 있어 걸릴 이유가 없다. 걸리는 것은 링크뿐이다.
      const store = new JobStore(join(root, "jobs-link.json"), [root]);

      await assert.rejects(
        () =>
          store.create({
            repo: repoRoot,
            templates: "doc/templates",
            out: join(link, "out-escaped"),
            specs: [join(root, "spec.md")],
          }),
        (error: Error) => {
          assert.match(error.message, /허용된 경로 밖입니다/);
          assert.match(error.message, /escape/, "무엇이 걸렸는지 그 경로를 보여 줘야 한다");
          return true;
        },
      );

      assert.ok(!existsSync(join(outside, "out-escaped")), "밖에 아무것도 만들지 않았어야 한다");
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("화면", () => {
  test("외부에서 가져오는 자원이 없다", async () => {
    // 오프라인에서도 떠야 한다. CDN 링크가 끼면 그 순간 깨진다.
    const html = page();

    assert.equal(/<(script|link|img)[^>]+(src|href)\s*=\s*["']https?:/i.test(html), false);
    assert.match(html, /<title>code-agent<\/title>/);
  });
});

/**
 * 도는 중에 지우면 무슨 일이 벌어지는가.
 *
 * 목록에서 빼는 것만으로는 실행이 멈추지 않는다 — 그 실행은 계속 out/ 을 쓰고, 그 사이
 * 같은 출력 디렉토리로 새 작업을 만들면 중복 검사도 통과한다. 그러면 서로 다른 줄에 선
 * 둘이 같은 계획·세션을 동시에 고친다. 여기서 판정되는 것은 **그 창이 닫혔는가**다.
 */
describe("도는 중에는 지우지 않는다", () => {
  let server: Server;
  let slowRoot: string;
  let slowOut: string;
  let jobUrl: string;

  /** 3초를 그냥 흘려보내는 명령. 도는 중이라는 상태를 만들려는 것이 전부다 */
  const SLEEP = ["node", "-e", "setTimeout(() => {}, 3000)"];

  /**
   * 명령 실행은 `kind: verify` 단계에서만 된다. 그래서 만드는 단계 하나와 돌리는 단계
   * 하나를 두고, 사이의 4차 게이트는 꺼 둔다 — 여기서 재는 것은 게이트가 아니라 삭제다.
   */
  const SLOW_MANIFEST = {
    ...MANIFEST,
    commands: { slow: SLEEP },
    stages: [
      { ...MANIFEST.stages[0], confirm: false },
      {
        key: "check",
        title: "검증",
        template: "03-check.md",
        kind: "verify",
        confirm: false,
        exemplars: [],
        outputDirs: ["."],
      },
    ],
  };

  /** 이 저장소의 단계는 model 하나뿐이다 — 계획도 그만큼만 담는다 */
  const SLOW_PLAN = JSON.stringify({
    domainName: "shipment",
    domainLabel: "배송",
    domainRoot: "",
    domainDirName: "shipment",
    files: [{ stage: "model", path: "app/features/shipment/models.py", purpose: "배송 모델" }],
    conventions: [{ rule: "dataclass 를 쓴다", source: "doc/conventions.md" }],
    conflicts: [],
    openQuestions: [],
    reasoning: "참조 도메인 구조를 그대로 따랐다",
  });

  before(async () => {
    slowRoot = mkdtempSync(join(tmpdir(), "code-agent-slow-"));
    const repo = join(slowRoot, "repo");
    slowOut = join(slowRoot, "out");

    const put = (relativePath: string, content: string) => {
      const path = join(repo, relativePath);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content, "utf-8");
    };

    put("app/features/orders/models.py", "class Order:\n    pass\n");
    put("app/features/orders/service.py", "class OrderService:\n    pass\n");
    put("doc/conventions.md", "# 컨벤션\n- dataclass 를 쓴다.\n");
    put("doc/templates/01-model.md", "# [01] 모델\n");
    put("doc/templates/03-check.md", "# [03] 검증\n");
    // 검증 명령이 실제로 돌아야 "도는 중"이 만들어진다 — 그래서 slow 를 선언해 둔다.
    put("doc/templates/code-agent.json", JSON.stringify(SLOW_MANIFEST, null, 2));

    // 검증은 임시 worktree 를 만들어 돈다. git 저장소가 아니면 그 자리에서 빨리 끝나 버린다.
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: repo,
    });

    writeFileSync(
      join(slowRoot, "spec.md"),
      "---\nkind: feature\nid: SLOW-1\ntitle: 배송 도메인 추가\ntarget: shipment\n---\n\n" +
        "# 배송(shipment) 도메인. 필드: id\n",
      "utf-8",
    );

    const statePathSlow = join(slowRoot, "jobs.json");
    const job = await new JobStore(statePathSlow).create({
      label: "slow",
      repo,
      templates: "doc/templates",
      out: slowOut,
      specs: [join(slowRoot, "spec.md")],
    });

    server = serve({ port: 0, host: "127.0.0.1", statePath: statePathSlow });
    await once(server, "listening");
    jobUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jobs/${job.id}`;
  });

  after(() => {
    server.close();
    rmSync(slowRoot, { recursive: true, force: true });
  });

  /** 화면이 하는 것과 같은 왕복 한 번 */
  async function send(text: string): Promise<Response> {
    const token = ((await (await fetch(`${jobUrl}/prompt`)).json()) as { token: string }).token;
    return fetch(`${jobUrl}/response`, {
      method: "POST",
      headers: { ...INTENT, "content-type": "text/plain; charset=utf-8", "x-code-agent-turn": token },
      body: text,
    });
  }

  async function running(): Promise<{ what: string } | undefined> {
    const state = (await (await fetch(jobUrl)).json()) as { running?: { what: string } };
    return state.running;
  }

  test("검증이 도는 중에 지우면 409 로 거부하고 작업은 남는다", async () => {
    assert.equal((await send(SLOW_PLAN)).status, 200);

    // 계획 승인(2차)을 지나야 생성 단계에 선다.
    const approved = await fetch(`${jobUrl}/approval`, {
      method: "POST",
      headers: { ...INTENT, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", approver: "팀장" }),
    });
    assert.equal(approved.status, 200);

    // 생성물이 있어야 검증이 건너뛰지 않는다. 쓰고, 모델 검수(3차)를 지나 verify 단계로.
    assert.equal((await send(MODEL_RESPONSE)).status, 200);
    assert.equal((await send(JSON.stringify({ violations: [] }))).status, 200);

    // 3초짜리 검증을 건다. 기다리지 않는다 — 도는 중에 지워 보는 것이 이 테스트다.
    const inFlight = send("### run slow\n\n### done\n");

    // 폴링은 조회라 줄에 서지 않는다. 실제로 돌기 시작한 것을 보고 나서 지운다.
    let seen: { what: string } | undefined;
    for (let attempt = 0; attempt < 100 && !seen; attempt += 1) {
      seen = await running();
    }
    assert.ok(seen, "검증이 도는 상태를 만들지 못했다 — 이 테스트는 그 위에서만 뜻이 있다");

    const dropped = await fetch(jobUrl, { method: "DELETE", headers: INTENT });

    assert.equal(dropped.status, 409, "도는 중 삭제는 요청 오류(400)가 아니라 충돌이다");
    const body = (await dropped.json()) as { error: string };
    assert.match(body.error, /도는 중이라 지우지 않았습니다/);
    assert.match(body.error, /끝난 뒤에 다시 지우세요/, "무엇을 하면 되는지까지 알려 줘야 한다");

    // 목록에 그대로 있어야 한다 — 지워졌다면 같은 out 으로 새 작업을 만들 수 있게 된다.
    assert.equal((await fetch(jobUrl)).status, 200);

    await inFlight;
  });

  test("끝나면 지워진다", async () => {
    for (let attempt = 0; attempt < 200 && (await running()); attempt += 1) {
      // 앞 테스트가 걸어 둔 검증이 끝나기를 기다린다.
    }
    assert.equal(await running(), undefined);

    const dropped = await fetch(jobUrl, { method: "DELETE", headers: INTENT });

    assert.equal(dropped.status, 200);
    assert.equal((await fetch(jobUrl)).status, 404);
  });
});
