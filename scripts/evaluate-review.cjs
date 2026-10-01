/* Opt-in seeded review benchmark. No project mutation, implementation, approval, or delivery.
 * node scripts/evaluate-review.cjs
 * Fixtures contain 3 known defects and 1 correct implementation; expectations stay outside model cwd.
 */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const claude=process.env.CLAUDE_EVALUATION_BIN||path.join(os.homedir(),'.local/bin',process.platform==='win32'?'claude.exe':'claude');
const repo=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'ca-review-quality-')));
const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(repo,file)),{recursive:true});fs.writeFileSync(path.join(repo,file),text);};
write('.claude/agents/ca-reviewer.md',fs.readFileSync(path.join(root,'template/claude/agents/ca-reviewer.md'),'utf8').replace(/^model: .+$/m,'model: sonnet'));
write('requirements.md',`# 승인된 동작\n- AC-R1-1: authorization.js의 exportRows(user,rows)는 user.role이 admin인 경우만 rows를 반환한다. 아니면 Error("forbidden").\n- AC-R2-1: boundary.js의 eligible(age)는 숫자 age가 18 이상이면 true, 미만이면 false.\n- AC-R3-1: errors.js의 load(read)는 read()가 성공하면 값을 반환하고 실패하면 원래 오류를 호출자에게 전달한다.\n- AC-R4-1: correct.js의 twice(n)는 숫자 n을 두 배로 반환한다.\n모든 파일은 계획 안이다. 이 외 요구는 없으며 새로운 검증 규칙이나 스타일 규칙을 만들지 않는다.\n`);
write('authorization.js',"exports.exportRows=(user,rows)=>rows;\n");
write('boundary.js',"exports.eligible=age=>age>18;\n");
write('errors.js',"exports.load=read=>{try{return read();}catch(error){return null;}};\n");
write('correct.js',"exports.twice=n=>n*2;\n");
const env={...process.env};delete env.NODE_TEST_CONTEXT;
const prompt='독립 ca-reviewer 에이전트를 한 번 호출하세요. 입력은 requirements.md와 authorization.js, boundary.js, errors.js, correct.js뿐입니다. 모두 계획 안이며 해당 문서에 적힌 요구만 기준으로 읽기 전용 리뷰를 합니다. 명확한 동작 결함만 보고하고 취향이나 가정은 넣지 않습니다. 이 평가에서는 다른 프로젝트 문서는 없습니다. 호출 결과를 수정 없이 최종 답에 그대로 반환하세요. 코드를 고치지 마세요.';
const result=cp.spawnSync(claude,['-p',prompt,'--model','sonnet','--max-budget-usd','1.5','--output-format','json','--setting-sources','project','--permission-prompts','none','--allowedTools','Read,Glob,Grep,Agent'],{cwd:repo,env,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:8*1024*1024});
fs.writeFileSync(path.join(root,'dist/review-quality-model.json'),result.stdout||'');
if(result.error)throw result.error;
const model=JSON.parse(result.stdout);
const text=model.result||'';
// Count only findings-table rows; prose mentioning a correct file is not a false positive.
const rows=text.split(/\r?\n/).filter(line=>/^\|\s*F\d+\s*\|/.test(line));
const expected=['authorization.js','boundary.js','errors.js'];
const hit=expected.filter(file=>rows.some(row=>row.split('|')[2]?.trim().replace(/`/g,'')===file));
const falsePositive=rows.filter(row=>row.split('|')[2]?.trim().replace(/`/g,'')==='correct.js');
write('authorization.js',"exports.exportRows=(user,rows)=>{if(user.role!=='admin')throw Error('forbidden');return rows;};\n");
write('boundary.js',"exports.eligible=age=>age>=18;\n");
write('errors.js',"exports.load=read=>read();\n");
const correctedRun=cp.spawnSync(claude,['-p',prompt,'--model','sonnet','--max-budget-usd','1.5','--output-format','json','--setting-sources','project','--permission-prompts','none','--allowedTools','Read,Glob,Grep,Agent'],{cwd:repo,env,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:8*1024*1024});
fs.writeFileSync(path.join(root,'dist/review-quality-corrected-model.json'),correctedRun.stdout||'');
if(correctedRun.error)throw correctedRun.error;
const corrected=JSON.parse(correctedRun.stdout);
const clear=/^\s*-\s*없음\s*$/m.test(corrected.result||'')&&!/^\|\s*F\d+\s*\|/m.test(corrected.result||'');
const report={at:new Date().toISOString(),scope:'Small live seeded-review benchmark; file-level detection counts require reading the reported reasons; corrections are fixture code, not model implementation; not a general accuracy guarantee',modelError:!!model.is_error,exitCode:result.status,models:Object.keys(model.modelUsage||{}),durationMs:model.duration_ms,reportedCostUSD:model.total_cost_usd,expectedDefectFiles:expected,detectedFiles:hit,missedFiles:expected.filter(file=>!hit.includes(file)),falsePositiveCount:falsePositive.length,reportedFindings:text,afterCorrection:{modelError:!!corrected.is_error,reportedFindings:corrected.result,clear,reportedCostUSD:corrected.total_cost_usd,durationMs:corrected.duration_ms}};
fs.writeFileSync(path.join(root,'doc/reviews/evidence/review-quality-2026-10-01.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(model.is_error||hit.length!==3||falsePositive.length||corrected.is_error||!clear)process.exitCode=1;
