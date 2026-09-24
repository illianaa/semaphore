import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomStore } from '../lib/core.mjs';
import { wakePending, cancelQueuedWake, WakePump } from '../lib/wake-delivery.mjs';
import { verifyNativeSeat } from '../lib/codex-runtime.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'semaphore-wake-delivery-'));
  const store=new RoomStore(root,'room'); store.acquire();
  t.after(()=>{store.release();fs.rmSync(root,{recursive:true,force:true});});
  const room=store.loadOrCreate();
  room.owner='astra'; room.participants.astra={id:'native-thread',transport:'astra-inbox',seen:0,
    wakeVerification:{pid:42,started:'Thu Sep 24 09:00:00 2026',socket:'/tmp/test.sock'}};
  room.pending={id:'room-turn',speaker:'astra',state:'awaiting-reply',receivedAt:null};
  store.save(room);
  fs.mkdirSync(path.join(store.dir,'inbox','astra'),{recursive:true});
  fs.writeFileSync(path.join(store.dir,'inbox','astra','room-turn.json'),'{}');
  const run=(_cmd,args)=>({status:0,stdout:`${args[1]==='42'?1:42} Thu Sep 24 09:00:00 2026`});
  const native={queue:[],state:'idle',calls:[],addMode:null,autoConsume:true,history:[],started:0,
    async request(method,params){
      this.calls.push({method,params});
      if(method==='server/diagnostics')return{process:{id:42}};
      if(method==='thread/loaded/list')return{data:['native-thread']};
      if(method==='thread/read')return{thread:{status:{type:this.state},turns:[]}};
      if(method==='thread/turns/list')return{data:this.history,nextCursor:null};
      if(method==='thread/queue/list')return{data:this.queue,nextCursor:null};
      if(method==='thread/queue/add'){
        if(this.addMode==='lost-before')throw new Error('socket closed before receipt');
        const item={id:'queued-id',clientUserMessageId:params.clientUserMessageId,input:params.input};
        this.queue.push(item);
        if(this.autoConsume){this.queue=[];this.started++;this.state='active';this.history.push({id:'native-turn',items:[{type:'userMessage',clientId:params.clientUserMessageId}]});}
        if(this.addMode==='lost-after')throw new Error('socket closed after enqueue');
        return{queuedSubmission:item};
      }
      if(method==='thread/queue/delete'){this.queue=this.queue.filter(item=>item.id!==params.queuedSubmissionId);return{};}
      throw new Error(`Forbidden method ${method}`);
    }};
  return {store,native,run,options:{client:native,runtime:{id:42},loaded:['native-thread'],socket:'/tmp/test.sock',run,isListening:()=>({active:false})}};
}

test('wake saves intent before enqueue and starts only its own queue entry, once',async t=>{
  const f=fixture(t); const request=f.native.request.bind(f.native);
  f.native.request=async(method,params)=>{
    if(method==='thread/queue/add')assert.equal(f.store.read().pending.wake.status,'queueing');
    return request(method,params);
  };
  await wakePending(f.store,f.options); await wakePending(f.store,f.options);
  assert.equal(f.native.started,1);assert.equal(f.store.read().pending.wake.status,'sent');
  const observed = f.store.read().pending.wake.startedObservedAt;
  assert.ok(Number.isFinite(Date.parse(observed)));
  await wakePending(f.store,f.options);
  assert.equal(f.store.read().pending.wake.startedObservedAt, observed);
  assert.equal(f.store.read().pending.receivedAt, null, 'host discovery never acknowledges a native turn');
  assert.equal(f.native.calls.filter(call=>call.method==='thread/queue/add').length,1);
  assert.ok(f.native.calls.every(call=>!['thread/resume','turn/start','thread/queue/start'].includes(call.method)));
  assert.match(f.native.calls.find(call=>call.method==='thread/queue/add').params.input[0].text,/receive room .*--turn room-turn/);
});

test('busy, unloaded, different runtime and foreground listener never receive a new wake',async t=>{
  for(const condition of ['busy','unloaded','runtime','listener']){
    const f=fixture(t); const options={...f.options};
    if(condition==='busy')f.native.state='active';
    if(condition==='unloaded')options.loaded=[];
    if(condition==='runtime')options.runtime={id:99};
    if(condition==='listener')options.isListening=()=>({active:true});
    await wakePending(f.store,options);
    assert.equal(f.native.calls.some(call=>call.method==='thread/queue/add'),false,condition);
  }
});

test('lost enqueue response reconciles a saved queue entry without adding a duplicate',async t=>{
  const f=fixture(t);f.native.addMode='lost-after';
  await wakePending(f.store,f.options);
  assert.equal(f.store.read().pending.wake.status,'uncertain');
  await wakePending(f.store,f.options);
  assert.equal(f.native.started,1);
  assert.equal(f.native.calls.filter(call=>call.method==='thread/queue/add').length,1);
});

test('an absent queue entry after an uncertain send is never re-enqueued',async t=>{
  const f=fixture(t);f.native.addMode='lost-before';
  await wakePending(f.store,f.options);f.native.addMode=null;
  await wakePending(f.store,f.options);
  assert.equal(f.native.started,0);
  assert.equal(f.native.calls.filter(call=>call.method==='thread/queue/add').length,1);
  assert.equal(f.store.read().pending.wake.status,'uncertain');
});

test('a native queue entry is preserved without re-enqueueing or jumping past human input',async t=>{
  const f=fixture(t);f.native.autoConsume=false;
  f.native.queue.push({id:'human',clientUserMessageId:'human-message'});
  await wakePending(f.store,f.options);await wakePending(f.store,f.options);
  assert.equal(f.native.calls.filter(call=>call.method==='thread/queue/add').length,1);
  assert.equal(f.native.calls.some(call=>call.method==='thread/queue/start'),false);
  assert.equal(f.native.queue[0].id,'human');
});

test('native receive removes only the matching wake notice and leaves human input alone',async t=>{
  const f=fixture(t);f.native.autoConsume=false;await wakePending(f.store,f.options);
  f.native.queue.push({id:'human',clientUserMessageId:'human-message'});
  await cancelQueuedWake(f.native,f.store.read());
  assert.deepEqual(f.native.queue,[{id:'human',clientUserMessageId:'human-message'}]);
  const room=f.store.read();room.pending.receivedAt=new Date().toISOString();f.store.save(room);
  const count=f.native.calls.length;await wakePending(f.store,f.options);assert.equal(f.native.calls.length,count);
});

test('an idle queue paused after interruption offers native Send without starting or duplicating input',async t=>{
  const f=fixture(t);f.native.autoConsume=false;
  f.native.queue.push({id:'human',clientUserMessageId:'human-message'});
  let now=Date.now();f.options.now=()=>now;
  await wakePending(f.store,f.options);
  assert.equal(f.store.read().pending.wake.status,'queued');
  now+=16000;await wakePending(f.store,f.options);
  assert.equal(f.store.read().pending.wake.status,'needs-send');
  assert.match(f.store.read().pending.wake.reason,/press Send/);
  assert.equal(f.native.queue[0].id,'human');
  assert.equal(f.native.calls.filter(call=>call.method==='thread/queue/add').length,1);
  assert.equal(f.native.calls.some(call=>['turn/start','thread/queue/start'].includes(call.method)),false);
  f.native.queue=[];f.native.state='active';f.native.history.push({id:'native-turn',items:[{type:'userMessage',clientId:f.store.read().pending.wake.clientUserMessageId}]});
  await wakePending(f.store,f.options);
  assert.equal(f.store.read().pending.wake.status,'sent');
});

test('seat verification requires native process ancestry and a loaded thread',async t=>{
  const f=fixture(t);
  const seat=await verifyNativeSeat({client:f.native,threadId:'native-thread',socket:'/tmp/test.sock',pid:80,run:f.run});
  assert.equal(seat.pid,42);
  await assert.rejects(verifyNativeSeat({client:f.native,threadId:'native-thread',socket:'/tmp/test.sock',pid:80,run:()=>({status:0,stdout:'1 other-start'})}),/not running/);
  await assert.rejects(verifyNativeSeat({client:f.native,threadId:'absent',socket:'/tmp/test.sock',pid:80,run:f.run}),/not loaded/);
});

test('service cleanup cancels a paused room notice and preserves the human queue',async t=>{
  const f=fixture(t);f.native.autoConsume=false;await wakePending(f.store,f.options);
  f.native.queue.push({id:'human',clientUserMessageId:'human-message'});
  const room=f.store.read();room.owner='human';room.pending.state='uncertain';f.store.save(room);f.store.release();
  f.native.initialize=async()=>{};f.native.close=()=>{};
  const pump=new WakePump({root:path.dirname(f.store.dir),paths:{socket:'/tmp/test.sock'},settings:()=>({enabled:true}),clientFactory:()=>f.native,run:f.run});
  await pump.tick();
  assert.deepEqual(f.native.queue,[{id:'human',clientUserMessageId:'human-message'}]);
  assert.equal(f.store.read().owner,'human');
  assert.equal(pump.mode(f.store.read().participants.astra,f.store.dir),'automatic');
  pump.settings=()=>({enabled:false});await pump.tick();
  assert.equal(pump.mode(f.store.read().participants.astra,f.store.dir),'reconnect');
});
