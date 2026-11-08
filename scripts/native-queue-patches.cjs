'use strict';
// ChatGPT app behavior: a message typed while a turn runs is queued; steering is explicit.
const PATTERN=/(followUpQueueMode:\w+\(\{agentAccess:`read-write`,default:`)steer(`)/;
function queueDefault(code){
 if(!PATTERN.test(code)){
  if(/followUpQueueMode:\w+\(\{agentAccess:`read-write`,default:`queue`/.test(code))return code;
  throw Error('Unrecognized follow-up queue default boundary');
 }
 return code.replace(PATTERN,'$1queue$2');
}
module.exports={queueDefault};
