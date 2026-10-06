import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { codexHook, patchPaths } from "../agent/codexHook";
import { applyConsent, consentCommandGuard, loadConsent, prepareConsent } from "../agent/consent";
import { readDocLedger } from "../agent/docs";
import { doctor } from "../agent/doctor";
import { hostAssets, parseHost, selectedHosts } from "../agent/hosts";
import { init, installedHook } from "../agent/init";
import { loadActive } from "../agent/layout";
import { dispatchPlanning, preparePlanning } from "../agent/planning";
import { loadPlanning } from "../agent/planningState";
import { update } from "../agent/update";
import { loadWork } from "../agent/work";
import { modelsTable, setModel, codexModelOf } from "../agent/models";
import { defaultCodexModel } from "../agent/modelPolicy";
import { usage } from "../agent/usage";
import { start } from "../agent/commands";
import { approveAndApplyFixture, CONSENT_SPEC, CONSENT_WORK_ID, prepareDeliveryFixture, setupConsentProject, submitConsentRequest, writeFixture } from "./consentFixture";

let root: string;
const cli = join(__dirname, "../agent/cli.js");
beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), "ca-codex-"))); });
afterEach(() => {
  const target = resolve(root), temporary = realpathSync.native(tmpdir());
  assert.ok(target.startsWith(temporary + sep) && target.slice(temporary.length + 1).startsWith("ca-codex-"));
  rmSync(target, {recursive:true, force:true});
});
const read = (file: string) => readFileSync(join(root, file), "utf8");
function reply(id: string, choices = "1", extra: object = {}) {
  return {cwd:root, hook_event_name:"UserPromptSubmit", session_id:"codex-test-session", turn_id:`turn-${id}`,
    prompt:`code-agent consent respond ${id} ${choices}`, ...extra};
}
function pre(tool_name: string, command: string) { return codexHook({cwd:root,hook_event_name:"PreToolUse",tool_name,tool_input:{command}}) as {hookSpecificOutput?: {permissionDecisionReason:string}}; }

test("Codex 단독 설치와 갱신은 Claude 없이 사용자 설정·지침·다른 훅을 보존한다", () => {
  writeFixture(root,"AGENTS.md","# 사용자 지침\n보존한다.\n");
  writeFixture(root,".codex/config.toml",'model = "custom-model"\n');
  writeFixture(root,".codex/hooks.json",JSON.stringify({description:"사용자 훅",hooks:{Stop:[{hooks:[{type:"command",command:"custom-stop"}]}]}}));
  init(root,{host:"codex",cli});
  const before = read(".codex/hooks.json");
  assert.equal(hostAssets("codex").size,36);
  assert.deepEqual(selectedHosts(root),["codex"]);
  assert.equal(existsSync(join(root,".claude")),false);
  assert.equal(existsSync(join(root,"CLAUDE.md")),false);
  assert.match(read("AGENTS.md"),/^# 사용자 지침/);
  assert.equal(read(".codex/config.toml"),'model = "custom-model"\n');
  for (const [path,text] of hostAssets("codex")) {
    assert.equal(read(path),text);
    assert.doesNotMatch(text,/AskUserQuestion|\.claude\//);
    if (path.endsWith(".toml")) assert.match(text, /^name = "[a-z0-9_]+"/);
  }
  const agent = read(".codex/agents/ca-analyst.toml");
  assert.match(agent,/^name = "ca_analyst"/);
  assert.match(read(".agents/skills/ca-analyze/SKILL.md"), /hostAgents\.codex/);
  assert.match(read(".agents/skills/ca-analyze/legacy.md"), /ca_analyst/);
  assert.match(agent,/^model = "gpt-6.1-sol"$/m);
  assert.match(agent,/^model_reasoning_effort = "high"$/m);
  assert.match(modelsTable(root),/Codex.*제품 기본값/);
  assert.throws(()=>setModel(root,"all","opus"),/Codex 모델 식별자/);
  assert.match(usage(root),/아직 집계하지 않습니다/);
  update(root);
  assert.equal(read(".codex/hooks.json"),before);
  assert.match(installedHook(root,"PreToolUse","codex-event","codex")!,/node .*cli\.js.*codex-event/);
  assert.equal((read("AGENTS.md").match(/<!-- code-agent:start -->/g) ?? []).length,1);
});

test("역할별 Codex 모델은 동의 후 적용되고 다른 호스트와 역할을 보존하며 갱신·복원한다", () => {
  setupConsentProject(root); init(root,{host:"both",cli});
  const claude = read(".claude/agents/ca-writer.md");
  assert.deepEqual(codexModelOf(root,"writer"), defaultCodexModel("writer"));
  assert.throws(()=>setModel(root,"writer","gpt-6-luna"),/--host/);
  assert.throws(()=>setModel(root,"writer","gpt-6-luna",{host:"codex",reasoning:"high"}),/터미널에서만/);
  approveAndApplyFixture(root,{action:"model",host:"codex",agent:"ca_writer",model:"gpt-6-luna",reasoning:"high"},"codex");
  assert.deepEqual(codexModelOf(root,"writer"),{model:"gpt-6-luna",reasoning:"high"});
  assert.deepEqual(codexModelOf(root,"reviewer"), defaultCodexModel("reviewer"));
  assert.equal(read(".claude/agents/ca-writer.md"),claude);
  assert.match(read(".codex/agents/ca-writer.toml"),/^model = "gpt-6-luna"$/m);
  const changed = read(".codex/agents/ca-writer.toml");
  update(root);
  assert.equal(read(".codex/agents/ca-writer.toml"),changed);
  assert.doesNotMatch(doctor(root,"codex").text,/✗ Codex 스킬·에이전트/);
  approveAndApplyFixture(root,{action:"model",host:"codex",agent:"writer",model:"default"},"codex");
  assert.deepEqual(codexModelOf(root,"writer"),defaultCodexModel("writer"));
  assert.equal(read(".claude/agents/ca-writer.md"),claude);
  approveAndApplyFixture(root,{action:"model",host:"codex",agent:"all",model:"gpt-6-luna"},"codex");
  assert.deepEqual(codexModelOf(root,"writer"),{model:"gpt-6-luna",reasoning:"medium"});
  assert.deepEqual(codexModelOf(root,"reviewer"),{model:"gpt-6-luna",reasoning:"high"});
  approveAndApplyFixture(root,{action:"model",host:"codex",agent:"all",model:"default"},"codex");
  assert.deepEqual(JSON.parse(read(".code-agent/codex-models.json")),{});
});

test("Codex 모델 명령은 호스트 조회를 제공하고 잘못된 변경과 비대화형 직접 변경을 거부한다", () => {
  init(root,{host:"codex",cli});
  const run = (...args:string[]) => spawnSync(process.execPath,[cli,"model",...args],{cwd:root,encoding:"utf8"});
  const shown = run("--host","codex");
  assert.equal(shown.status,0,shown.stderr);
  assert.match(shown.stdout,/analyst\s+gpt-6\.1-sol \/ high/);
  assert.match(shown.stdout,/writer\s+gpt-6\.1-sol \/ medium/);
  const denied = run("writer","gpt-6-luna","--host","codex","--reasoning","high");
  assert.notEqual(denied.status,0);
  assert.match(denied.stderr,/터미널에서만/);
  assert.throws(()=>prepareConsent(root,{action:"model",host:"codex",agent:"writer",model:'bad"\nmodel = "x'}),/Codex 모델 식별자/);
  assert.throws(()=>prepareConsent(root,{action:"model",host:"codex",agent:"writer",model:"gpt-6-luna",reasoning:"invalid"}),/추론 강도/);
  assert.throws(()=>prepareConsent(root,{action:"model",host:"codex",agent:"all",model:"default",reasoning:"high"}),/기본값 복원/);
  assert.equal(existsSync(join(root,".code-agent/codex-models.json")),false);
});

test("양쪽 호스트를 추가 설치하고 기본 update는 둘 다 갱신한다", () => {
  init(root,{host:"claude",cli});
  const claude = read(".claude/settings.json");
  init(root,{host:"codex",cli});
  assert.deepEqual(selectedHosts(root),["claude","codex"]);
  assert.equal(read(".claude/settings.json"),claude);
  writeFixture(root,".agents/skills/ca-status/SKILL.md","오래된 Codex 지침");
  writeFixture(root,".claude/skills/ca-status/SKILL.md","오래된 Claude 지침");
  update(root);
  assert.match(read(".agents/skills/ca-status/SKILL.md"),/name: ca-status/);
  assert.match(read(".claude/skills/ca-status/SKILL.md"),/name: ca-status/);
  assert.throws(()=>parseHost("unknown"),/--host/);
});

test("잘못된 설정은 설치 전에 거부하고 같은 그룹의 사용자 훅도 보존한다", () => {
  writeFixture(root,".codex/hooks.json","{broken");
  assert.throws(()=>init(root,{host:"codex"}),/읽을 수 없습니다/);
  assert.equal(existsSync(join(root,".agents")),false);
  writeFixture(root,".codex/hooks.json",JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:"command",command:"code-agent codex-event"},{type:"command",command:"custom-check"}]}]}}));
  init(root,{host:"codex"});
  assert.match(read(".codex/hooks.json"),/custom-check/);
  assert.equal((read(".codex/hooks.json").match(/custom-check/g) ?? []).length,1);
});

test("doctor는 Codex 설치를 인식하고 빠진 역할 파일을 찾는다", () => {
  setupConsentProject(root); init(root,{host:"codex",cli});
  const report = doctor(root).text;
  assert.match(report,/Codex 스킬·에이전트: 26개 · 보조 문서 10개 모두/);
  assert.doesNotMatch(report,/설치되지 않았습니다 \(\.claude/);
  writeFixture(root,".codex/agents/ca-critic.toml","누락된 지침");
  assert.match(doctor(root).text,/✗ Codex 스킬·에이전트/);
  const hooks = JSON.parse(read(".codex/hooks.json"));
  hooks.hooks.PreToolUse[0].matcher = "Bash";
  writeFixture(root,".codex/hooks.json",JSON.stringify(hooks));
  assert.match(doctor(root).text,/✗ Codex PreToolUse.*matcher/);
});

test("패치의 모든 파일과 이동 목적지를 검사하며 상태·훅 변경을 거부한다", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: .code-agent/active.json\n@@\n-a\n+b\n*** End Patch";
  assert.deepEqual(patchPaths(patch),["src/a.ts",".code-agent/active.json"]);
  assert.match(pre("apply_patch",patch).hookSpecificOutput!.permissionDecisionReason,/상태/);
  assert.match(pre("apply_patch","*** Begin Patch\n*** Delete File: .codex/hooks.json\n*** End Patch").hookSpecificOutput!.permissionDecisionReason,/호스트/);
  assert.throws(()=>pre("apply_patch","unknown"),/패치/);
  assert.match(pre("Bash","code-agent codex-event").hookSpecificOutput!.permissionDecisionReason,/hook|허용|명령/);
});

test("Codex는 작업 중 전용 파일 읽기를 제공하고 일반 셸 쓰기·연결은 계속 거부한다", () => {
  setupConsentProject(root); init(root,{host:"codex",cli});
  approveAndApplyFixture(root,{action:"setup"},"codex");
  submitConsentRequest(root);
  approveAndApplyFixture(root,{action:"request",id:CONSENT_WORK_ID},"codex");
  start(root,join(root,CONSENT_SPEC));
  assert.deepEqual(pre("Bash", `code-agent read ${CONSENT_SPEC}`), {});
  assert.match(pre("Bash", "Get-Content code-agent.json").hookSpecificOutput!.permissionDecisionReason, /code-agent read/);
  assert.ok(pre("Bash", "code-agent read code-agent.json; Set-Content x y").hookSpecificOutput);
  const result = spawnSync(process.execPath,[cli,"read",CONSENT_SPEC,"1","2"],{cwd:root,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).lines.length,2);
  assert.match(read(".codex/agents/ca-analyst.toml"),/code-agent read/);
  assert.match(read(".agents/skills/ca-analyze/SKILL.md"),/^---/);
});

test("Codex 실제 사용자 이벤트의 동의만 적용되고 원장에 Codex 출처가 남는다", () => {
  setupConsentProject(root);
  const prepared = JSON.parse(prepareConsent(root,{action:"docs"}));
  assert.match(prepared.codexReply.format,/consent respond/);
  assert.throws(()=>applyConsent(root,prepared.id),/명시적/);
  codexHook({...reply(prepared.id),hook_event_name:"PostToolUse"});
  assert.equal(loadConsent(root,prepared.id).status,"pending");
  codexHook(reply(prepared.id));
  assert.equal(loadConsent(root,prepared.id).status,"approved");
  assert.match(consentCommandGuard(root,`code-agent consent apply ${prepared.id}`,"other-session")!,/세션/);
  applyConsent(root,prepared.id);
  assert.ok(readDocLedger(root).every(row=>row.presence.channel==="codex-prompt"));
  assert.throws(()=>codexHook(reply(prepared.id)),/미응답/);
});

for (const change of ["subagent","missing-session","missing-turn","extra-text","changed-input","defer"] as const) {
  test(`Codex 승인 거부: ${change}`, () => {
    setupConsentProject(root);
    const prepared = JSON.parse(prepareConsent(root,{action:"docs"}));
    const event = reply(prepared.id);
    if (change === "changed-input") writeFixture(root,"doc/quality.md",read("doc/quality.md")+"\n변경\n");
    const extra = change === "subagent" ? {agent_id:"child"} : change === "missing-session" ? {session_id:undefined} :
      change === "missing-turn" ? {turn_id:undefined} : change === "extra-text" ? {prompt:event.prompt+" 승인"} :
      change === "defer" ? {prompt:`code-agent consent respond ${prepared.id} 3`} : {};
    if (change === "defer") codexHook({...event,...extra});
    else assert.throws(()=>codexHook({...event,...extra}));
    assert.notEqual(loadConsent(root,prepared.id).status,"approved");
    assert.throws(()=>applyConsent(root,prepared.id));
    assert.equal(readDocLedger(root).length,0);
  });
}

test("Codex 계획 결과는 실제 배정에 묶이고 입력 변경 결과는 거부한다", () => {
  setupConsentProject(root);
  approveAndApplyFixture(root,{action:"setup"},"codex"); submitConsentRequest(root);
  approveAndApplyFixture(root,{action:"request",id:CONSENT_WORK_ID},"codex");
  start(root,join(root,CONSENT_SPEC)); preparePlanning(root);
  const task = JSON.parse(dispatchPlanning(root,"analysis"));
  const event = {cwd:root,session_id:"parent",agent_id:"child",agent_type:task.hostAgents.codex};
  codexHook({...event,hook_event_name:"SubagentStart"});
  const result = {...task.resultShape,status:"completed",summary:"분석",evidence:[{path:CONSENT_SPEC,line:1}],
    artifacts:[{path:`doc/work/${CONSENT_WORK_ID}/01-requirements.md`,content:"오래된 결과"}]};
  writeFixture(root,"code-agent.json",read("code-agent.json")+"\n");
  assert.throws(()=>codexHook({...event,hook_event_name:"SubagentStop",last_assistant_message:JSON.stringify(result)}),/입력/);
  assert.equal(loadPlanning(loadWork(root)!).tasks[0].attempts.at(-1)?.status,"failed");
});

test("Codex 접수·계획·승인·Task·검증·리뷰·통합 흐름이 같은 게이트를 통과한다", async () => {
  setupConsentProject(root); init(root,{host:"codex",cli});
  await prepareDeliveryFixture(root,"codex");
  assert.equal(loadActive(root)?.phase,"deliver");
  assert.ok(loadPlanning(loadWork(root)!).tasks.every(task=>task.attempts.at(-1)?.status==="completed"));
});

test("실제 CLI 훅 프로세스는 판정 실패를 Claude 훅과 같은 결과로 반환한다", () => {
  const run = (event: object) => spawnSync(process.execPath,[cli,"codex-event"],{cwd:root,input:JSON.stringify(event),encoding:"utf8"});
  const output = (event: object) => { const result = run(event); assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout); };
  assert.deepEqual(output({cwd:root,hook_event_name:"Stop"}),{});
  // Codex는 exit 2로 도구를 막지 않는다. 판정 실패는 거부 응답으로 닫는다.
  assert.match(output({cwd:root,hook_event_name:"PreToolUse",tool_name:"apply_patch",tool_input:{command:"broken"}}).hookSpecificOutput.permissionDecisionReason,/판정에 실패해 막았습니다.*패치/);
  writeFixture(root,".code-agent/active.json","{broken");
  assert.equal(output({cwd:root,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"code-agent status"}}).hookSpecificOutput.permissionDecision,"deny");
  // Claude matcher 밖의 도구는 판정하지 않으므로 상태 오류로 막히지 않는다.
  assert.deepEqual(output({cwd:root,hook_event_name:"PreToolUse",tool_name:"spawn_agent",tool_input:{agent_type:"ca_analyst"}}),{});
  const stopped = run({cwd:root,hook_event_name:"Stop"});
  assert.equal(stopped.status,0,stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout),{});
  assert.match(stopped.stderr,/턴은 막지 않았습니다/);
  assert.equal(run({cwd:root,hook_event_name:"SubagentStop",agent_type:"ca_analyst"}).status,2);
});
