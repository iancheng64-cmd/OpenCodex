'use strict';
// The native composer steers a running turn only once that turn's id is known. In the
// stock app the id arrives within a second; OpenCodex starts a turn behind Mac tool
// verification, and a native title thread can hold the workspace lease first, so the id
// may take longer than the native 30 s wait. Keep waiting while the turn is in progress;
// a turn that ends still rejects at once and the message falls back to the queue.
function once(code,before,after){if(code.includes(after)&&code.indexOf(after)===code.lastIndexOf(after))return code;if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized native steer boundary: '+before.slice(0,80));return code.replace(before,after);}
const WAIT_BEFORE='without an active turn id`))},az),s=e.addConversationCallback(t,e';
const WAIT_AFTER='without an active turn id`))},18e4),s=e.addConversationCallback(t,e';
function shared(code){return once(code,WAIT_BEFORE,WAIT_AFTER);}
module.exports={shared,WAIT_BEFORE,WAIT_AFTER};
