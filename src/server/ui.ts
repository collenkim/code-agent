/**
 * 로컬 화면 하나. 외부 의존이 없다 — 오프라인에서도 뜬다.
 *
 * 이 화면이 없애는 것은 왕복마다 끼어들던 두 가지다: 응답을 파일로 저장하는 일과
 * 명령을 다시 부르는 일. 사람이 하는 일은 복사와 붙여넣기만 남는다.
 */

const STYLE = `
:root {
  --bg: #ffffff; --fg: #16181d; --muted: #5c6370; --line: #e3e6ea;
  --panel: #f7f8fa; --accent: #2f6feb; --warn: #b4341f; --ok: #1a7f45;
  --mono: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181d; --fg: #e6e8eb; --muted: #9aa3ad; --line: #2b2f37;
    --panel: #1c1f26; --accent: #6c9bff; --warn: #ff8069; --ok: #4bd07f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.55 -apple-system, "Segoe UI", "Malgun Gothic", sans-serif;
}
header {
  display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 5;
}
h1 { font-size: 15px; margin: 0; font-weight: 650; }
main { padding: 16px; max-width: 1500px; margin: 0 auto; }
select, input, button, textarea {
  font: inherit; color: inherit; background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px;
}
button { cursor: pointer; background: var(--panel); }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: .45; cursor: not-allowed; }
.chip {
  font-family: var(--mono); font-size: 12px; padding: 2px 8px;
  border: 1px solid var(--line); border-radius: 999px; background: var(--bg);
}
.chip.blocked { color: var(--warn); border-color: var(--warn); }
.chip.done { color: var(--ok); border-color: var(--ok); }
.muted { color: var(--muted); }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
section { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
section > h2 {
  font-size: 12px; text-transform: uppercase; letter-spacing: .05em; margin: 0;
  padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--line);
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.body { padding: 12px; }
pre {
  font-family: var(--mono); font-size: 12.5px; margin: 0; white-space: pre-wrap;
  word-break: break-word; max-height: 58vh; overflow: auto;
}
textarea {
  width: 100%; min-height: 58vh; font-family: var(--mono); font-size: 12.5px;
  resize: vertical;
}
ul { margin: 0; padding-left: 18px; }
li { margin: 2px 0; }
li.file { font-family: var(--mono); font-size: 12.5px; color: var(--ok); }
li.violation { color: var(--warn); }
li.violation code { font-family: var(--mono); }
.q { border-top: 1px solid var(--line); padding: 10px 0; }
.q:first-child { border-top: 0; padding-top: 0; }
.q .text { font-weight: 600; margin-bottom: 6px; }
.q input { width: 100%; }
.q.open { border-left: 3px solid var(--warn); padding-left: 10px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.grid2 { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: center; }
.notice { padding: 10px 12px; border-radius: 6px; background: var(--panel); white-space: pre-wrap; }
.notice.warn { color: var(--warn); border: 1px solid var(--warn); }
`;

const SCRIPT = String.raw`
let jobs = [];
let current = null;
let state = null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function call(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
  return body;
}

function flash(message, isError) {
  const el = $("flash");
  el.textContent = message || "";
  el.className = message ? ("notice" + (isError ? " warn" : "")) : "";
  el.style.display = message ? "block" : "none";
}

async function loadJobs() {
  const body = await call("/api/jobs");
  jobs = body.jobs;
  const select = $("jobs");
  select.innerHTML = jobs.map((job) =>
    '<option value="' + esc(job.id) + '">' + esc(job.label) + " — " + esc(job.target) + "</option>"
  ).join("");
  if (jobs.length === 0) {
    current = null;
    $("work").style.display = "none";
    $("newjob").open = true;
    return;
  }
  if (!jobs.some((job) => job.id === current)) current = jobs[0].id;
  select.value = current;
  $("work").style.display = "";
  await refresh();
}

async function refresh() {
  state = await call("/api/jobs/" + encodeURIComponent(current));
  render();
  await loadPrompt();
}

function render() {
  const blocked = state.target === "blocked";
  const done = state.target === "done";
  $("target").textContent = state.target;
  $("target").className = "chip" + (blocked ? " blocked" : done ? " done" : "");
  $("turn").textContent = "턴 " + state.turn;
  $("stages").textContent = state.completedStages.length
    ? "완료 " + state.completedStages.join(", ") : "완료된 단계 없음";
  $("paths").textContent = state.repoRoot + "  →  " + state.outDir;

  const open = state.questions.filter((q) => !q.answer);
  $("qcount").textContent = state.questions.length
    ? (open.length ? open.length + "건 미답변" : "전부 답변됨") : "";
  $("questions").style.display = state.questions.length ? "" : "none";
  $("qlist").innerHTML = state.questions.map((q) =>
    '<div class="q' + (q.answer ? "" : " open") + '">' +
      '<div class="text">Q' + q.id + " · " + esc(q.target) + " — " + esc(q.question) + "</div>" +
      '<input data-qid="' + q.id + '" value="' + esc(q.answer) + '" placeholder="답을 적으세요">' +
    "</div>"
  ).join("");

  const v = state.lastViolations;
  $("carry").style.display = v.length ? "" : "none";
  $("carrylist").innerHTML = v.map((x) =>
    '<li class="violation">[' + esc(x.item) + "] <code>" + esc(x.file) + "</code>: " + esc(x.detail) + "</li>"
  ).join("");
}

async function loadPrompt() {
  const body = await call("/api/jobs/" + encodeURIComponent(current) + "/prompt");
  const has = Boolean(body.prompt);
  $("prompt").textContent = has ? body.prompt : (body.message || "");
  $("copy").disabled = !has;
  $("send").disabled = !has;
  $("response").disabled = !has;
}

async function send() {
  const text = $("response").value;
  if (!text.trim()) { flash("Console 응답을 붙여넣으세요.", true); return; }
  $("send").disabled = true;
  try {
    const out = await call("/api/jobs/" + encodeURIComponent(current) + "/response", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: text }),
    });
    showResult(out);
    if (out.parseErrors.length === 0 && out.violations.length === 0) $("response").value = "";
    state = out.next;
    render();
    await loadPrompt();
    await loadJobs();
  } catch (err) {
    flash(err.message, true);
  } finally {
    $("send").disabled = false;
  }
}

function showResult(out) {
  const parts = [];
  if (out.parseErrors.length) {
    parts.push('<div class="notice warn">응답 형식 오류 — 아무것도 반영하지 않았습니다:<ul>' +
      out.parseErrors.map((e) => "<li>" + esc(e) + "</li>").join("") + "</ul></div>");
  }
  if (out.planSaved) {
    parts.push("<p>계획 저장: <code>" + esc(out.planSaved) + "</code></p><pre>" + esc(out.planText || "") + "</pre>");
  }
  if (out.writtenFiles.length) {
    parts.push("<ul>" + out.writtenFiles.map((f) => '<li class="file">+ ' + esc(f) + "</li>").join("") + "</ul>");
  }
  if (out.violations.length) {
    parts.push('<div class="notice warn">위반 ' + out.violations.length + "건<ul>" +
      out.violations.map((x) => '<li class="violation">[' + esc(x.item) + "] <code>" +
        esc(x.file) + "</code>: " + esc(x.detail) + "</li>").join("") + "</ul></div>");
  }
  if (out.notes.length) {
    parts.push("<p class='muted'>note</p><ul>" + out.notes.map((n) => "<li>" + esc(n) + "</li>").join("") + "</ul>");
  }
  if (out.observations.length) {
    parts.push("<p class='muted'>모델이 요청한 것 (다음 프롬프트에 실립니다)</p>" +
      out.observations.map((o) => "<details><summary>" + esc(o.label) + "</summary><pre>" +
        esc(o.body) + "</pre></details>").join(""));
  }
  if (out.questionsAdded) parts.push("<p>질문 " + out.questionsAdded + "건이 추가되었습니다.</p>");
  if (out.message) parts.push('<div class="notice">' + esc(out.message) + "</div>");

  $("result").style.display = parts.length ? "" : "none";
  $("resultbody").innerHTML = parts.join("");
  flash("");
}

async function saveAnswers() {
  const answers = Array.from(document.querySelectorAll("#qlist input")).map((input) => ({
    id: Number(input.dataset.qid),
    answer: input.value,
  }));
  state = await call("/api/jobs/" + encodeURIComponent(current) + "/questions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  render();
  await loadPrompt();
  flash("답을 저장했습니다. 다음 프롬프트에 실려 들어갑니다.");
}

async function createJob(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const specs = String(form.get("specs") || "").split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    const job = await call("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: form.get("label"),
        repo: form.get("repo"),
        templates: form.get("templates"),
        out: form.get("out"),
        reference: form.get("reference") || undefined,
        specs,
      }),
    });
    current = job.id;
    $("newjob").open = false;
    event.target.reset();
    await loadJobs();
    flash("작업을 만들었습니다: " + job.label);
  } catch (err) {
    flash(err.message, true);
  }
}

async function showLog() {
  const body = await call("/api/jobs/" + encodeURIComponent(current) + "/log");
  $("log").style.display = "";
  $("logbody").textContent = body.text;
}

window.addEventListener("DOMContentLoaded", () => {
  $("jobs").addEventListener("change", (e) => { current = e.target.value; refresh(); });
  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("prompt").textContent);
    $("copy").textContent = "복사됨";
    setTimeout(() => { $("copy").textContent = "복사"; }, 1200);
  });
  $("send").addEventListener("click", send);
  $("saveq").addEventListener("click", () => saveAnswers().catch((e) => flash(e.message, true)));
  $("reload").addEventListener("click", () => loadJobs().catch((e) => flash(e.message, true)));
  $("showlog").addEventListener("click", () => showLog().catch((e) => flash(e.message, true)));
  $("createform").addEventListener("submit", createJob);
  loadJobs().catch((e) => flash(e.message, true));
});
`;

const BODY = `
<header>
  <h1>code-agent</h1>
  <select id="jobs"></select>
  <span class="chip" id="target">—</span>
  <span class="muted" id="turn"></span>
  <span class="muted" id="stages"></span>
  <button id="reload">새로고침</button>
  <button id="showlog">턴 기록</button>
</header>

<main>
  <div id="flash" style="display:none"></div>

  <details id="newjob">
    <summary style="cursor:pointer;margin-bottom:10px">새 작업 만들기</summary>
    <section><div class="body">
      <form id="createform" class="grid2">
        <label>이름</label><input name="label" placeholder="shipment">
        <label>대상 저장소</label><input name="repo" required placeholder="C:\\path\\to\\project">
        <label>템플릿 디렉토리</label><input name="templates" required placeholder="doc\\templates">
        <label>출력 디렉토리</label><input name="out" required placeholder=".\\out-shipment">
        <label>참조 도메인</label><input name="reference" placeholder="(매니페스트 기본값 사용)">
        <label>스펙 문서</label><textarea name="specs" style="min-height:80px"
          placeholder="한 줄에 하나씩&#10;요구사항.md&#10;schema.sql"></textarea>
        <span></span><span><button class="primary" type="submit">만들기</button></span>
      </form>
      <p class="muted" style="margin-bottom:0">
        출력 디렉토리는 작업마다 새로 잡으세요 — 계획과 세션이 그 안에 있습니다.
      </p>
    </div></section>
  </details>

  <div id="work" style="display:none">
    <p class="muted" id="paths" style="font-family:var(--mono);font-size:12px"></p>

    <section id="questions" style="display:none">
      <h2>사람이 답해야 넘어갑니다 <span class="muted" id="qcount"></span></h2>
      <div class="body">
        <div id="qlist"></div>
        <div class="row" style="margin-top:10px"><button class="primary" id="saveq">답 저장</button></div>
      </div>
    </section>

    <section id="carry" style="display:none">
      <h2>앞 턴에 남은 위반 — 다음 프롬프트에 실립니다</h2>
      <div class="body"><ul id="carrylist"></ul></div>
    </section>

    <div class="cols">
      <section>
        <h2>프롬프트 <button id="copy">복사</button></h2>
        <div class="body"><pre id="prompt"></pre></div>
      </section>
      <section>
        <h2>Console 응답 붙여넣기 <button class="primary" id="send">반영하기</button></h2>
        <div class="body"><textarea id="response" placeholder="Console 응답을 통째로 붙여넣으세요."></textarea></div>
      </section>
    </div>

    <section id="result" style="display:none">
      <h2>결과</h2>
      <div class="body" id="resultbody"></div>
    </section>

    <section id="log" style="display:none">
      <h2>턴 기록</h2>
      <div class="body"><pre id="logbody"></pre></div>
    </section>
  </div>
</main>
`;

export function page(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>code-agent</title>
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>`;
}
