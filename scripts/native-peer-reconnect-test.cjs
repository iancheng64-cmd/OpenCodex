'use strict';
const assert=require('node:assert/strict');
const {PeerReconnect}=require('../src/native-peer-reconnect.cjs');
function setup(over={}){
 const timers=[],events=[],closed={id:'old'};
 const s={current:closed,profileId:'peer-profile',mainConnected:true,busy:false,confirmation:false,...over};
 const f={s,closed,timers,events,connects:[],fail:0,
  fire:async()=>{const t=timers.shift();assert(t,'no timer');await t.fn();},
  r:null};
 f.r=new PeerReconnect({state:()=>s,audit:(type,data)=>events.push([type,data]),onGiveUp:()=>{f.gaveUp=true;},
  setTimer:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimer:t=>{const i=timers.indexOf(t);if(i>=0)timers.splice(i,1);},
  connect:async profileId=>{f.connects.push(profileId);if(f.fail>0){f.fail--;throw Error('ERR_CONNECT_TIMEOUT');}if(!f.confirmOnConnect)s.current={id:'new'};else s.confirmation=true;}});
 return f;
}
const tests=[];async function test(name,fn){await fn();tests.push(name);console.log('PASS '+name);}
(async()=>{
 await test('an unexpected close reconnects the saved collaborator after a short delay',async()=>{
  const f=setup();assert.equal(f.r.schedule(f.closed),true);assert.equal(f.timers[0].ms,2000);
  await f.fire();assert.deepEqual(f.connects,['peer-profile']);assert.equal(f.events.at(-1)[0],'ssh-peer-reconnected');assert.equal(f.timers.length,0);
 });
 await test('failures back off and give up after the last delay without retrying forever',async()=>{
  const f=setup();f.fail=99;f.r.schedule(f.closed);const delays=[];
  while(f.timers.length){delays.push(f.timers[0].ms);await f.fire();}
  assert.deepEqual(delays,[2000,5000,15000,30000,60000,120000]);assert.equal(f.connects.length,6);assert.equal(f.gaveUp,true);
 });
 await test('a later success after failures stops further attempts',async()=>{
  const f=setup();f.fail=2;f.r.schedule(f.closed);await f.fire();await f.fire();await f.fire();
  assert.equal(f.connects.length,3);assert.equal(f.timers.length,0);assert.equal(f.gaveUp,undefined);
 });
 await test('user disconnect, a replaced peer, or shutdown cancels the attempt',async()=>{
  const a=setup();a.r.schedule(a.closed);a.s.current=null;await a.fire();assert.equal(a.connects.length,0);
  const b=setup();b.s.current={id:'other'};assert.equal(b.r.schedule(b.closed),false);
  const c=setup();c.r.schedule(c.closed);c.r.stop();assert.equal(c.timers.length,0);assert.equal(c.r.schedule(c.closed),false);
  const d=setup({profileId:null});assert.equal(d.r.schedule(d.closed),false);
  const e=setup();e.r.schedule(e.closed);e.r.cancel();assert.equal(e.timers.length,0);
 });
 await test('busy work delays without consuming an attempt; a lost main agent or host confirmation stops',async()=>{
  const f=setup({busy:true});f.r.schedule(f.closed);await f.fire();assert.equal(f.connects.length,0);assert.equal(f.timers[0].ms,2000);
  f.s.busy=false;await f.fire();assert.equal(f.connects.length,1);
  const g=setup({mainConnected:false});g.r.schedule(g.closed);await g.fire();assert.equal(g.connects.length,0);assert.equal(g.timers.length,0);
  const h=setup();h.confirmOnConnect=true;h.r.schedule(h.closed);await h.fire();assert.equal(h.timers.length,0);assert.equal(h.events.at(-1)[1].reason,'host-confirmation');
 });
 await test('the periodic safety net never resets backoff or restarts an exhausted peer',async()=>{
  const f=setup();f.fail=99;assert.equal(f.r.ensure(f.closed),true);assert.equal(f.r.ensure(f.closed),false,'already pending');
  await f.fire();assert.equal(f.timers[0].ms,5000);assert.equal(f.r.ensure(f.closed),false);
  while(f.timers.length)await f.fire();assert.equal(f.gaveUp,true);assert.equal(f.r.ensure(f.closed),false,'exhausted peer waits for the user');
  const g=setup();let release;g.r.connect=()=>new Promise(r=>release=r);g.r.schedule(g.closed);const run=g.fire();await new Promise(r=>setImmediate(r));
  assert.equal(g.r.ensure(g.closed),false,'a connect in flight is not duplicated');g.s.current={id:'new'};release();await run;
 });
 console.log(JSON.stringify({passed:tests.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
