import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { processAgentStream } from '../../src/bot/channel';

// Shapes are normalized from the 2026-11-15 02:11:08 incident evidence:
// no collabAgentToolCall, no child.parentThreadId, completed spawn on stdout.
// No live model or business content is used in this subprocess replay.
describe('TraeX legacy persisted foreground activity', () => {
  it.each(['active', 'silent', 'background', 'result-before-stop'])(
    'handles %s with the incident API shape', async (scenario) => {
      const dir = await mkdtemp(join(tmpdir(), 'traex-legacy-idle-'));
      const binary = join(dir, 'cli.mjs');
      const rollout = join(dir, 'rollout-fixture-parent.jsonl');
      const progress = join(dir, 'progress');
      await writeFile(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const path=${JSON.stringify(rollout)}, progress=${JSON.stringify(progress)};
const scenario=${JSON.stringify(scenario)};
const emit=x=>console.log(JSON.stringify(x));
const record=(type,payload)=>JSON.stringify({type,payload})+'\\n';
if(process.argv[2]==='app-server'){
  createInterface({input:process.stdin}).on('line',line=>{
    const q=JSON.parse(line);
    if(q.method==='initialize')emit({id:q.id,result:{}});
    if(q.method!=='thread/read')return;
    const p=JSON.parse(readFileSync(progress,'utf8'));
    const parent=q.params.threadId==='parent';
    const items=parent?[{type:'subAgentActivity',id:'activity',kind:'started',agentThreadId:'child'}]:
      Array.from({length:p.count},(_,i)=>({type:'commandExecution',id:'cmd-'+i,status:'completed'}));
    if(parent&&p.returned)items.push({type:'commandExecution',id:'returned-result',status:'completed'});
    emit({id:q.id,result:{thread:{id:parent?'parent':'child',path:parent?path:null,cliVersion:'0.204.1',
      turns:[{id:parent?'parent-turn':'child-turn',status:!parent&&p.returned?'completed':'inProgress',items}]}}});
  });
}else{
  process.stdin.resume();process.stdin.on('end',()=>{
    writeFileSync(path,
      record('session_meta',{id:'parent'})+
      record('event_msg',{type:'task_started',turn_id:'parent-turn'})+
      record('history_mutation',{turn_id:'parent-turn',items:[{type:'function_call',name:'Agent',call_id:'spawn'}]})+
      record('event_msg',{type:'collab_agent_spawn_end',sender_thread_id:'parent',call_id:'spawn',
        new_thread_id:'child',status:'pending_init',run_in_background:scenario==='background'}));
    let count=1,returned=false;
    const save=()=>writeFileSync(progress,JSON.stringify({count,returned}));save();
    emit({type:'thread.started',thread_id:'parent'});
    const item={type:'collab_tool_call',id:'spawn',tool:'spawn_agent'};
    emit({type:'item.started',item:{...item,status:'in_progress'}});
    emit({type:'item.completed',item:{...item,status:'completed'}});
    const timer=setInterval(()=>{if(scenario!=='silent')count++;save();},100);
    if(scenario==='result-before-stop')setTimeout(()=>{
      returned=true;save();appendFileSync(path,record('history_mutation',{turn_id:'parent-turn',
        items:[{type:'function_call_output',call_id:'spawn'}]}));
    },900);
    setTimeout(()=>{clearInterval(timer);emit({type:'turn.completed'});},scenario==='result-before-stop'?1600:3200);
  });
}
`, 'utf8');
      await chmod(binary, 0o755);
      const run = new CodexAdapter({ binary, profileStateDir: dir, stdoutIdleProbeMs: 100 }).run({
        runId: scenario, prompt: 'sanitized replay', cwd: await realpath(dir),
      });
      try {
        const result = await processAgentStream({ run, interrupted: false }, run.events, scenario,
          1000, undefined, vi.fn(), vi.fn(async () => {}));
        expect(result.terminal).toBe(['active', 'result-before-stop'].includes(scenario) ? 'done' : 'idle_timeout');
      } finally {
        await run.stop();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
