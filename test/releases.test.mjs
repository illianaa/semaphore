import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { projectDir } from '../lib/paths.mjs';
import { captureRuntime, formatRuntime, RELEASE_MANIFEST } from '../lib/build-info.mjs';
import { stageRelease } from '../lib/releases.mjs';

function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'semaphore-release-'));
  const source=path.join(directory,'source'), destination=path.join(directory,'releases');
  fs.mkdirSync(source);
  for(const entry of ['package.json','package-lock.json','cli.mjs','server.mjs','lib','web','skills','docs','README.md','DESIGN.md','LICENSE'])
    fs.cpSync(path.join(projectDir,entry),path.join(source,entry),{recursive:true});
  t.after(()=>{
    const unlock=file=>{const stat=fs.lstatSync(file);if(stat.isSymbolicLink())return;
      fs.chmodSync(file,stat.isDirectory()?0o700:0o600);
      if(stat.isDirectory())for(const child of fs.readdirSync(file))unlock(path.join(file,child));};
    unlock(directory);fs.rmSync(directory,{recursive:true,force:true});
  });
  return {directory,source,destination};
}
const installed=()=>({status:0,stdout:'',stderr:''});

test('release staging installs the lock, freezes a verified snapshot and never rewrites it',t=>{
  const f=fixture(t);let installs=0;
  const staged=stageRelease({...f,run:(_command,args,options)=>{
    installs++;assert.deepEqual(args,['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund']);
    assert.ok(options.cwd.startsWith(f.destination));return installed();
  }});
  assert.equal(staged.runtime.kind,'release');
  assert.equal(staged.runtime.build,captureRuntime(f.source).build);
  assert.equal(fs.statSync(path.join(staged.directory,'cli.mjs')).mode&0o222,0);
  assert.equal(fs.statSync(staged.directory).mode&0o222,0);
  const manifest=fs.readFileSync(path.join(staged.directory,RELEASE_MANIFEST),'utf8');
  assert.equal(stageRelease({...f,run:()=>{throw new Error('must reuse');}}).existing,true);
  assert.equal(installs,1);
  assert.equal(fs.readFileSync(path.join(staged.directory,RELEASE_MANIFEST),'utf8'),manifest);
  assert.deepEqual(fs.readdirSync(f.directory).sort(),['releases','source']);
});

test('failed dependencies or changing sources leave no partial release',t=>{
  const f=fixture(t);
  assert.throws(()=>stageRelease({...f,run:()=>({status:1,stderr:'offline'})}),/dependencies failed.*offline/);
  assert.deepEqual(fs.readdirSync(f.destination),[]);
  assert.throws(()=>stageRelease({...f,run:()=>{
    fs.appendFileSync(path.join(f.source,'cli.mjs'),'\n// changed during stage\n');return installed();
  }}),/Source changed during staging/);
  assert.deepEqual(fs.readdirSync(f.destination),[]);
});

test('staging rejects runtime symlinks and modified releases',t=>{
  const f=fixture(t);
  fs.symlinkSync(path.join(f.source,'cli.mjs'),path.join(f.source,'web','escape'));
  assert.throws(()=>stageRelease({...f,run:installed}),/must not be a symlink/);
  fs.unlinkSync(path.join(f.source,'web','escape'));
  const release=stageRelease({...f,run:installed});
  const file=path.join(release.directory,'cli.mjs');fs.chmodSync(file,0o600);fs.appendFileSync(file,'\n// tampered\n');
  assert.throws(()=>captureRuntime(release.directory),/no longer matches its manifest/);
  assert.throws(()=>stageRelease({...f,run:installed}),/no longer matches its manifest/);
});

test('old server and listener keep their build while a new CLI receives the same pending turn',async t=>{
  const f=fixture(t), root=path.join(f.directory,"shared rooms with an apostrophe's");
  const ASTRA={CODEX_THREAD_ID:'0190f000-0000-7000-8000-00000000a57a'};
  const CLAUDE={CLAUDE_CODE_SESSION_ID:'11111111-2222-4333-8444-5555c1a0de00'};
  const clean=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^CODEX_|^CLAUDE_CODE_SESSION_ID$/.test(key)));
  const env={...clean,SEMAPHORE_HOME:path.join(f.directory,'home')};
  const cli=(args,native={})=>spawnSync(process.execPath,['cli.mjs',...args,'--root',root],{cwd:f.source,env:{...env,...native},encoding:'utf8',timeout:10000});
  assert.equal(cli(['join','room','--as','astra'],ASTRA).status,0);
  assert.equal(cli(['join','room','--as','claude'],CLAUDE).status,0);
  const original=captureRuntime(f.source);
  const children=new Set();
  t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');});
  async function startServer(){
    const child=spawn(process.execPath,['--input-type=module','-e',`
      import {createAppServer} from './server.mjs';
      const app=createAppServer({root:process.env.TEST_ROOM_ROOT,wakePump:false});
      process.send({url:await app.listen(0)});
      process.on('message',async message=>{if(message==='stop'){await app.close();process.exit(0);}});
    `],{cwd:f.source,env:{...env,TEST_ROOM_ROOT:root},stdio:['ignore','ignore','pipe','ipc']});
    children.add(child);const [ready]=await once(child,'message',{signal:AbortSignal.timeout(10000)});
    return {child,url:ready.url};
  }
  const first=await startServer();
  const listener=spawn(process.execPath,['cli.mjs','listen','room','--root',root,'--timeout','10'],{cwd:f.source,env:{...env,...CLAUDE},stdio:['ignore','pipe','pipe']});
  children.add(listener);let output='';listener.stdout.on('data',data=>output+=data);listener.stderr.on('data',data=>output+=data);
  const done=once(listener,'close');
  const marker=path.join(root,'room','inbox','claude','listener.pid');
  for(let i=0;i<100&&!fs.existsSync(marker);i++)await delay(20);
  assert.ok(fs.existsSync(marker));
  const pkgFile=path.join(f.source,'package.json'),pkg=JSON.parse(fs.readFileSync(pkgFile));
  pkg.version='0.3.1-test';fs.writeFileSync(pkgFile,JSON.stringify(pkg));
  const current=captureRuntime(f.source);assert.notEqual(current.build,original.build);
  assert.equal((await (await fetch(first.url+'/health')).json()).runtime.build,original.build);
  const html=await (await fetch(first.url)).text();const token=html.match(/name="semaphore-token" content="([a-f0-9]+)"/)[1];
  const sent=await fetch(first.url+'/api/rooms/room/messages',{method:'POST',headers:{'Content-Type':'application/json','Origin':first.url,'X-Semaphore-Token':token},body:JSON.stringify({text:'Keep this pending turn across the update',to:'claude',clientId:'release-transition-input'})});
  assert.equal(sent.status,200,await sent.text());
  assert.equal((await done)[0],0,output);
  assert.ok(output.includes('Listener runtime: '+formatRuntime(original)));
  assert.ok(output.includes('Envelope runtime: '+formatRuntime(original)));
  assert.ok(output.includes("Shared room folder: '"));
  const roomFile=path.join(root,'room','room.json');const pending=JSON.parse(fs.readFileSync(roomFile)).pending;
  assert.equal(pending.runtime.build,original.build);
  const closed=once(first.child,'exit');first.child.send('stop');await closed;
  const second=await startServer();
  assert.equal((await (await fetch(second.url+'/health')).json()).runtime.build,current.build);
  const received=cli(['receive','room','--turn',pending.id],CLAUDE);
  assert.equal(received.status,0,received.stderr);
  assert.match(received.stdout,/Runtime changed since this chat's join/);
  assert.ok(received.stdout.includes('Envelope runtime: '+formatRuntime(current)));
  assert.ok(received.stdout.includes(`build ${original.build.slice(0,12)}`));
  const room=JSON.parse(fs.readFileSync(roomFile));
  assert.equal(room.pending.id,pending.id);assert.equal(room.messages.length,1);
  assert.equal(room.participants.claude.lastReceivedRuntime.build,current.build);
  const args=['reply','room','--turn',pending.id,'--next','human','Finished once'];
  assert.equal(cli(args,CLAUDE).status,0);assert.equal(cli(args,CLAUDE).status,0);
  assert.equal(JSON.parse(fs.readFileSync(roomFile)).messages.length,2);
  const finalClose=once(second.child,'exit');second.child.send('stop');await finalClose;
});
