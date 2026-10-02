import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { pluginAdd, previewPluginAdd, previewPluginRemove, registerPlugin } from "../agent/plugins/commands";
import type { AddOptions, Prompts } from "../agent/plugins/commands";
import type { DescribeOutput } from "../agent/plugins/protocol";
import * as run from "../agent/plugins/run";
import * as store from "../agent/plugins/store";

const ENV = "CODE_AGENT_PLUGIN_CONFIRMATION_TEST_KEY";
const secretValue = "private-test-key-never-in-approval";
const previous = process.env[ENV];
let state: store.Store;
let adapter: DescribeOutput;
let options: AddOptions;
let operations: string[];
let shown: string[];
let prompts: Prompts;
let probeResult: ReturnType<typeof run.probeAdapter>;
let repo: string;
let serial = 0;

beforeEach(() => {
  repo = `plugin-confirmation-${++serial}`;
  state = { version: 1, plugins: {} };
  adapter = {
    name: "test-adapter", adapterVersion: "1.2.3",
    slots: ["candidates.rank", "review.prefilter"], sendsCode: true,
    secret: { required: true, delivery: "env", env: "ADAPTER_KEY" },
    note: "Sends selected source to the service.",
  };
  options = { name: "example", command: 'node "adapter with spaces.js" --flag', sendsCode: false, secretEnv: ENV };
  operations = [];
  shown = [];
  prompts = {
    ask: () => { throw new Error("An environment-backed secret must not be requested interactively"); },
    confirm: (text, word) => { assert.equal(word, "example"); shown.push(text); },
  };
  probeResult = { ok: true, output: { ready: true, detail: "ready" } };
  process.env[ENV] = secretValue;
  mock.method(store, "readStore", () => structuredClone(state));
  mock.method(store, "writeStore", (next: store.Store) => { operations.push("write"); state = next; });
  mock.method(run, "describeAdapter", () => { operations.push("describe"); return { ok: true, output: structuredClone(adapter) }; });
  mock.method(run, "probeAdapter", (_root: string, _command: string[], secret?: run.Secret) => {
    operations.push("probe");
    if (adapter.secret?.required) {
      assert.equal(secret?.value, secretValue);
      assert.equal(secret?.delivery, adapter.secret.delivery);
      assert.equal(secret?.env, adapter.secret.env);
    }
    return probeResult;
  });
});

afterEach(() => {
  mock.restoreAll();
  if (previous === undefined) delete process.env[ENV];
  else process.env[ENV] = previous;
});

test("add preview describes exact argv, selected slots, code implications and public metadata without probing", () => {
  options.slots = "review.prefilter";
  const preview = previewPluginAdd(repo, options);
  assert.match(preview, /플러그인 등록: example/);
  assert.ok(preview.includes(JSON.stringify(["node", "adapter with spaces.js", "--flag"])));
  assert.match(preview, /사용할 자리\(slots\): review\.prefilter/);
  assert.match(preview, /코드 외부 전송\(sendsCode\): 예/);
  assert.ok(preview.includes(ENV));
  assert.ok(preview.includes(JSON.stringify(adapter)));
  assert.ok(!preview.includes(secretValue));
  assert.deepEqual(operations, ["describe"]);
  assert.deepEqual(state.plugins, {});
  assert.equal(previewPluginAdd(repo, options), preview, "preview has no timestamps or random fields");
});

for (const delivery of ["env", "stdin"] as const) {
  test(`registration resolves secretEnv internally for ${delivery} and confirms the exact preview`, () => {
    adapter.secret = { required: true, delivery, ...(delivery === "env" ? { env: "ADAPTER_KEY" } : {}) };
    const preview = previewPluginAdd(repo, options);
    const result = registerPlugin(repo, options, prompts);
    assert.deepEqual(shown, [preview]);
    assert.deepEqual(operations, ["describe", "describe", "probe", "write"]);
    assert.equal(state.plugins.example.secret?.value, secretValue);
    assert.ok(!JSON.stringify(state.plugins.example.consent).includes(secretValue));
    assert.ok(!result.includes(secretValue));
  });
}

for (const field of ["version", "slots", "sendsCode", "secret", "note", "command", "secretEnv"] as const) {
  test(`registration refuses changed ${field} after preview before sending a key or writing`, () => {
    previewPluginAdd(repo, options);
    switch (field) {
      case "version": adapter.adapterVersion = "2"; break;
      case "slots": adapter.slots = ["review.prefilter"]; break;
      case "sendsCode": adapter.sendsCode = false; break;
      case "secret": adapter.secret = { required: true, delivery: "stdin" }; break;
      case "note": adapter.note = "Different service"; break;
      case "command": options.command = "node replacement.js"; break;
      case "secretEnv": options.secretEnv = "OTHER_KEY"; break;
    }
    assert.throws(() => registerPlugin(repo, options, prompts), /미리보기 이후 플러그인 정보가 바뀌었습니다/);
    assert.deepEqual(operations, ["describe", "describe"]);
    assert.deepEqual(shown, []);
  });
}

test("a newly reviewed preview permits changed metadata", () => {
  previewPluginAdd(repo, options);
  adapter.adapterVersion = "2";
  const revised = previewPluginAdd(repo, options);
  registerPlugin(repo, options, prompts);
  assert.deepEqual(shown, [revised]);
  assert.equal(state.plugins.example.adapter.version, "2");
});

test("invalid environment identifiers fail before describing and never echo the input", () => {
  for (const invalid of ["", "9KEY", "KEY-NAME", "KEY=secret", "KEY\nsecret", "KEY\n", "KEY\r\n"]) {
    options.secretEnv = invalid;
    for (const action of [() => previewPluginAdd(repo, options), () => registerPlugin(repo, options, prompts)]) {
      assert.throws(action, /secretEnv에는 환경변수 이름만 지정하세요/);
    }
  }
  assert.deepEqual(operations, []);
});

test("preview can name an unset key; registration rejects absent or blank values without prompting or probing", () => {
  for (const value of [undefined, "", "  \t  "]) {
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    assert.ok(previewPluginAdd(repo, options).includes(ENV));
    assert.throws(() => registerPlugin(repo, options, prompts), /값이 없거나 공백뿐입니다/);
  }
  assert.ok(operations.every(op => op === "describe"));
  assert.deepEqual(state.plugins, {});
});

test("adapters needing no secret retain standalone behavior, including no sends-code prompt", () => {
  adapter.sendsCode = false;
  delete adapter.secret;
  delete process.env[ENV];
  const preview = previewPluginAdd(repo, options);
  assert.match(preview, /코드 외부 전송\(sendsCode\): 아니오/);
  registerPlugin(repo, options, prompts);
  assert.deepEqual(shown, []);
  assert.equal(state.plugins.example.secret, undefined);
});

test("standalone secret entry remains supported when secretEnv is omitted", () => {
  delete options.secretEnv;
  const preview = previewPluginAdd(repo, options);
  assert.match(preview, /같은 세션에서 이미 설정된 환경변수 이름을 secretEnv에 지정하세요/);
  assert.match(preview, /실제 키 값은 입력하지 마세요/);
  assert.match(preview, /기존 직접 TTY 실행/);
  let asked = 0;
  prompts.ask = () => { asked++; return secretValue; };
  registerPlugin(repo, options, prompts);
  assert.equal(asked, 1);
  assert.equal(state.plugins.example.secret?.value, secretValue);
});

test("probe failures and stored success details redact echoed secrets", () => {
  for (const failure of [
    { ok: false as const, error: `rejected ${secretValue}` },
    { ok: true as const, output: { ready: false, detail: `rejected ${secretValue}` } },
  ]) {
    probeResult = failure;
    assert.throws(() => registerPlugin(repo, options, prompts), (error: Error) => {
      assert.ok(!error.message.includes(secretValue));
      return /probe/.test(error.message);
    });
    assert.deepEqual(state.plugins, {});
  }
  probeResult = { ok: true, output: { ready: true, detail: `accepted ${secretValue}` } };
  registerPlugin(repo, options, prompts);
  assert.ok(!state.plugins.example.probe.detail!.includes(secretValue));
});

test("describe cannot reflect an environment key into previews or errors", () => {
  adapter.note = secretValue;
  assert.throws(() => previewPluginAdd(repo, options), /어댑터 설명이나 명령에 키 값이 포함되어/);
  mock.method(run, "describeAdapter", () => ({ ok: false, error: `failed ${secretValue}` }));
  assert.throws(() => previewPluginAdd(repo, options), (error: Error) => !error.message.includes(secretValue));
  assert.deepEqual(state.plugins, {});
});

test("remove preview is read-only and excludes secrets even when echoed into public stored fields", () => {
  registerPlugin(repo, options, prompts);
  state.plugins.example.adapter.name = `adapter ${secretValue}`;
  operations.length = 0;
  const before = structuredClone(state);
  const preview = previewPluginRemove("example");
  assert.match(preview, /플러그인 제거: example/);
  assert.match(preview, /adapter with spaces\.js/);
  assert.ok(!preview.includes(secretValue));
  assert.deepEqual(state, before);
  assert.deepEqual(operations, []);
  assert.throws(() => previewPluginRemove("missing"), /등록돼 있지 않습니다/);
});

test("pluginAdd still requires the terminal entry guard", () => {
  if (!process.stdin.isTTY) {
    assert.throws(() => pluginAdd(repo, options), /TTY/);
    assert.deepEqual(operations, []);
  }
});
