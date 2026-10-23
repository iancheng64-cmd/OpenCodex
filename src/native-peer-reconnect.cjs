'use strict';
// Reconnect a collaborator agent that dropped without the user asking.
// The user's own connect or disconnect, a host-key confirmation, a lost main
// agent or app shutdown ends the attempt; nothing is retried forever.
const DELAYS=[2000,5000,15000,30000,60000,120000];
class PeerReconnect{
 // state() -> {current, profileId, mainConnected, busy, confirmation}
 constructor({connect,state,audit=()=>{},onGiveUp,delays=DELAYS,setTimer=setTimeout,clearTimer=clearTimeout}){
  Object.assign(this,{connect,state,audit,onGiveUp,delays,setTimer,clearTimer});this.pending=null;this.running=null;this.exhausted=null;this.stopped=false;
 }
 schedule(closed,attempt=1){
  if(this.stopped||!closed)return false;
  const s=this.state();if(s.current!==closed||!s.profileId)return false;
  this.cancel();
  if(attempt>this.delays.length){this.exhausted=closed;this.audit('ssh-peer-reconnect-gave-up',{attempts:attempt-1});this.onGiveUp?.();return false;}
  const token={closed,attempt},delayMs=this.delays[attempt-1];
  token.timer=this.setTimer(()=>void this.run(token),delayMs);token.timer?.unref?.();
  this.pending=token;this.audit('ssh-peer-reconnect-scheduled',{attempt,delayMs});
  return true;
 }
 async run(token){
  if(this.pending!==token||this.stopped)return;
  this.pending=null;
  const s=this.state();
  if(s.current!==token.closed||s.confirmation)return;
  if(!s.mainConnected){this.audit('ssh-peer-reconnect-stopped',{reason:'main-disconnected'});return;}
  // Never interrupt work; wait for it without consuming an attempt.
  if(s.busy){this.schedule(token.closed,token.attempt);return;}
  this.running=token;
  try{await this.connect(s.profileId);}
  catch(error){this.running=null;this.audit('ssh-peer-reconnect-failed',{attempt:token.attempt,message:error.message});if(!this.stopped)this.schedule(token.closed,token.attempt+1);return;}
  this.running=null;const after=this.state();
  if(after.current!==token.closed){this.audit('ssh-peer-reconnected',{attempt:token.attempt});return;}
  if(after.confirmation){this.audit('ssh-peer-reconnect-stopped',{reason:'host-confirmation'});return;}
  this.schedule(token.closed,token.attempt+1);
 }
 // Periodic safety net for a close that produced no event: never resets the backoff.
 ensure(closed){if(this.pending||this.running||this.exhausted===closed)return false;return this.schedule(closed);}
 cancel(){if(this.pending){this.clearTimer(this.pending.timer);this.pending=null;}}
 stop(){this.stopped=true;this.cancel();}
}
module.exports={PeerReconnect,DELAYS};
