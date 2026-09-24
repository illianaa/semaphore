import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoomStore, Semaphore } from "../lib/core.mjs";
import { createLiveRoom, createStartedRoom } from "../lib/rooms.mjs";
import { openingTitle, titleText } from "../lib/titles.mjs";
import { InboxTransport, listen, LiveDeliveryError } from "../lib/live.mjs";
import { recordListenerObservation, timingView, timingReport } from "../lib/timing.mjs";

const SESSION = "11111111-2222-4333-8444-5555c1a0de00";
const THREAD = "0190f000-0000-7000-8000-00000000a57a";
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "semaphore-names-timing-"));
  const {store} = await createStartedRoom(root, {text:"Please discuss how to improve this room",to:"claude",clientId:"titles-timing-request"});
  store.acquire(); t.after(() => { store.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const room = store.read(); room.participants.claude.id = SESSION; room.participants.astra.id = THREAD; store.save(room);
  const app = new Semaphore(store, {claude:new InboxTransport({kind:"claude-inbox"}),astra:new InboxTransport({kind:"astra-inbox"})});
  await app.startOpening();
  return {root,store,app,id:app.room.pending.id};
}

test("automatic titles use whole words, blank first lines and intact Unicode; chosen titles are validated", () => {
  assert.equal(openingTitle("\n \n Hello 👩🏽‍💻 team\nMore"), "Hello 👩🏽‍💻 team");
  const words = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen";
  const short = openingTitle(words);
  assert.ok(short.endsWith("…")); assert.ok(words.startsWith(short.slice(0,-1)));
  assert.equal(words[short.length-1], " "); assert.ok([...short].length <= 80);
  assert.equal(openingTitle("👩🏽‍💻".repeat(100)), "👩🏽‍💻".repeat(79)+"…");
  assert.equal(titleText("  A\n  <name> & 'Unicode 🌱'  "), "A <name> & 'Unicode 🌱'");
  assert.equal(titleText("🌱".repeat(100)), "🌱".repeat(100));
  for (const value of [null, "   ", "x".repeat(101)]) assert.throws(()=>titleText(value), /1–100/);
});

test("only the received first AI turn may suggest a title once; human and legacy titles survive", async t => {
  const f = await fixture(t), {app,id} = f;
  assert.throws(()=>app.setTitle("Short name",{speaker:"claude",turnId:id}), /Receive/);
  app.receive(id,"claude");
  assert.throws(()=>app.setTitle("Wrong",{speaker:"astra",turnId:id}), /Stale/);
  const original = {count:app.room.messages.length,budget:app.room.autoTurns,pending:app.room.pending.id};
  assert.equal(app.setTitle("Short <name> 🌱",{speaker:"claude",turnId:id}).duplicate,false);
  assert.equal(app.setTitle("Short <name> 🌱",{speaker:"claude",turnId:id}).duplicate,true);
  assert.throws(()=>app.setTitle("Another",{speaker:"claude",turnId:id}),/once/);
  app.setTitle("Human choice");
  assert.throws(()=>app.setTitle("Short <name> 🌱",{speaker:"claude",turnId:id}),/User-chosen/);
  assert.deepEqual({count:app.room.messages.length,budget:app.room.autoTurns,pending:app.room.pending.id}, original);
  assert.equal(f.store.read().title,"Human choice");
  delete app.room.titleSource;
  assert.throws(()=>app.setTitle("Replace legacy",{speaker:"claude",turnId:id}),/existing titles/);
  const named = createLiveRoom(f.root, "Explicit user title"); assert.equal(named.room.titleSource,"human");
});

test("listener observation never acknowledges a turn and all first-stage timestamps survive reply and reopen", async t => {
  const {store,app,id} = await fixture(t);
  assert.equal(app.room.pending.receivedAt,undefined);
  const get = () => timingView(app.room, store.dir);
  assert.ok(get().queuedAt); assert.equal(get().listenerObservedAt,null);
  const observed = await listen({roomDir:store.dir,speaker:"claude",isOpen:()=>true,
    onObserved:item=>recordListenerObservation(store.dir,item)});
  assert.equal(observed.length,1);
  const first = get().listenerObservedAt; assert.ok(first);
  recordListenerObservation(store.dir,observed[0]); assert.equal(get().listenerObservedAt,first);
  assert.equal(app.room.pending.receivedAt,undefined); assert.equal(app.room.messages[0].readAt,undefined);
  assert.equal(app.room.autoTurns,0); assert.equal(app.room.participants.claude.seen,0);
  const receipt = app.receive(id,"claude"); app.receive(id,"claude");
  assert.equal(get().acknowledgedAt,receipt.receivedAt);
  fs.rmSync(path.join(store.dir,"inbox","claude","observed",`${id}.json`));
  assert.equal(get().listenerObservedAt,first,"received timing survives loss of the advisory observation copy");
  await app.accept({turnId:id,speaker:"claude",message:"Finished",next:"human"});
  const report = timingReport(store.read(),store.dir);
  assert.equal(report.samples.length,1); const sample = report.samples[0];
  assert.equal(sample.listenerObservedAt,first); assert.equal(sample.acknowledgedAt,receipt.receivedAt);
  assert.equal(sample.repliedAt,app.room.messages.at(-1).at); assert.equal(sample.outcome,"replied");
  assert.equal(sample.hostDeliveredAt,null); assert.equal(report.groups[0].route,"listener");
  assert.equal(report.groups[0].phases.queueToAcknowledgment.count,1);
  assert.equal(report.groups[0].phases.nativeQueueToHostObservation.count,0);
});

test("foreign observations are excluded and failures/recovery are measured without redispatch", async t => {
  const {store,app,id} = await fixture(t);
  recordListenerObservation(store.dir,{roomId:app.room.id,session:"another-chat",turn:{id,speaker:"claude"}});
  assert.equal(timingView(app.room,store.dir).listenerObservedAt,null);
  app.takeStick(); app.recover();
  assert.equal(timingReport(app.room,store.dir).samples[0].outcome,"recovered");
  let calls=0;
  app.adapters.astra={kind:"astra-inbox",deliver:async()=>{calls++;throw new LiveDeliveryError("No delivery",{certain:true,code:"test-failure"});}};
  await assert.rejects(app.pass("astra"), /No delivery/);
  assert.equal(calls,1); assert.equal(app.room.pending,null);
  const report = timingReport(store.read(),store.dir), failed=report.samples.find(row=>row.failureCode==="test-failure");
  assert.equal(failed.outcome,"failed-certain"); assert.ok(failed.failedAt); assert.equal(failed.queuedAt,null);
  assert.equal(report.groups.find(group=>group.speaker==="astra").failures,1);
});

test("distributions omit missing/reversed clocks and distinguish legacy evidence", () => {
  const at = n => new Date(n).toISOString();
  const samples=[100,200,300,400,500].map((ms,i)=>({turnId:`turn-${i}`,speaker:"claude",transport:"claude-inbox",route:"listener",instrumentation:"v1",outcome:"replied",queuedAt:at(1000),acknowledgedAt:at(1000+ms)}));
  samples.push({...samples[0],turnId:"backwards",acknowledgedAt:at(900)});
  samples.push({...samples[0],turnId:"missing",acknowledgedAt:null});
  const room={name:"test",events:samples.map(detail=>({type:"turn-timing",detail})),messages:[]};
  room.events.push({type:"delivery-queued",detail:{turnId:"old",receipt:{transport:"astra-inbox",at:at(0)}}});
  room.events.push({type:"turn-received",detail:{turnId:"old",speaker:"astra"},at:at(1000)});
  const before=JSON.stringify(room), report=timingReport(room,"/does-not-exist");
  assert.equal(JSON.stringify(room),before,"reporting never mutates the journal");
  assert.deepEqual(report.groups[0].phases.queueToAcknowledgment,{count:5,missing:1,clockReversed:1,minMs:100,p50Ms:300,p95Ms:500,maxMs:500});
  assert.equal(report.groups[1].instrumentation,"legacy"); assert.equal(report.groups[1].failures,null);
});
