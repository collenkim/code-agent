const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ca-graph-bin-')));
const exe=path.resolve(process.argv[2] ?? path.join(__dirname,'..','dist-bin',process.platform === 'win32' ? 'code-agent.exe' : 'code-agent'));
function run(command,args){const r=cp.spawnSync(command,args,{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr+'\n'+r.stdout);return r.stdout;}
try {
  run('git',['init','-q','-b','main']);
  run(exe,['init','--host','both']);
  const first=JSON.parse(run(exe,['flow','advance','--json']));
  assert.equal(first.node,'setup');assert.equal(first.kind,'agent');
  const dir=path.join(root,'.code-agent/graph');
  const snapshot=()=>fs.readdirSync(dir).map(n=>[n,fs.statSync(path.join(dir,n)).mtimeMs]);
  const before=snapshot();
  const state=JSON.parse(run(exe,['status','--json']));
  assert.equal(state.graph.latest.status,'waiting');assert.deepEqual(snapshot(),before);
  const second=JSON.parse(run(exe,['flow','advance','--json']));assert.equal(second.node,'setup');
  assert.equal(second.graph.threadId,first.graph.threadId);assert.notEqual(second.graph.runId,first.graph.runId);
  assert.ok(!run('git',['status','--porcelain','--untracked-files=all']).includes('.code-agent/graph'));
  console.log(JSON.stringify({artifact:exe,checks:['install-both','sqlite-checkpoint','reopen','read-only-status','git-ignore'],graph:state.graph,passed:true},null,2));
} finally {
  assert.ok(root.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep+'ca-graph-bin-'));
  fs.rmSync(root,{recursive:true,force:true});
}
