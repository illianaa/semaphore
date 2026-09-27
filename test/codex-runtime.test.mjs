import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { WakeClient, socketURL } from '../lib/codex-runtime.mjs';

test('wake client speaks WebSocket over a private Unix socket and never answers approvals',async t=>{
  const dir=fs.mkdtempSync('/tmp/sem-ws-');const socket=dir+'/rpc.sock';
  const httpServer=http.createServer();const wss=new WebSocketServer({server:httpServer,perMessageDeflate:false});
  const received=[];let peer;
  wss.on('connection',ws=>{peer=ws;ws.on('message',data=>{
    const message=JSON.parse(String(data));received.push(message);
    if(message.id!==undefined)ws.send(JSON.stringify({id:message.id,result:message.method==='server/diagnostics'?{process:{id:123}}:{}}));
  });});
  httpServer.listen(socket);await once(httpServer,'listening');
  const client=new WakeClient({socket});
  t.after(async()=>{client.close();for(const ws of wss.clients)ws.terminate();await new Promise(resolve=>httpServer.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  await client.initialize();
  assert.deepEqual(await client.request('server/diagnostics'),{process:{id:123}});
  const unexpected=once(client,'unexpectedRequest');
  peer.send(JSON.stringify({id:88,method:'item/commandExecution/requestApproval',params:{}}));
  assert.equal((await unexpected)[0],'item/commandExecution/requestApproval');
  await delay(20);
  assert.equal(received.some(message=>message.id===88),false);
  for(const method of ['thread/resume','thread/start','turn/start','turn/interrupt','thread/queue/start','config/value/write'])
    await assert.rejects(client.request(method),/cannot call/);
  assert.ok(received.every(message=>['initialize','initialized','server/diagnostics'].includes(message.method)));
});

test('wake client bounds an unavailable socket and validates local-only endpoints',async()=>{
  assert.throws(()=>socketURL('https://example.com'),/absolute Unix/);
  const client=new WakeClient({socket:'/tmp/nonexistent-semaphore-wake.sock',timeoutMs:100});
  try{await assert.rejects(client.initialize());}finally{client.close();}
});
