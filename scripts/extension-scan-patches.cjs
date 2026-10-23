'use strict';
// Scope disk discovery before walking. Memoize I/O only within one scan so
// duplicate home/project roots keep their original precedence without rereads.
function extensionScan(code){
 const marker='// OpenCodex scoped extension discovery';
 if(code.includes(marker))return code;
 const replacements=[
  ['    const items = [];',`    ${marker}
    const directoryReads = new Map(), fileReads = new Map();
    const readOnce = (cache, filename, operation) => {
        if (!cache.has(filename)) cache.set(filename, operation());
        return cache.get(filename);
    };
    const items = [];`],
  ['        if (depth > 9 || budget-- <= 0)','        if ((options.agent && agent !== options.agent) || depth > 9 || budget-- <= 0)'],
  ['await node_fs_1.default.promises.readdir(root, { withFileTypes: true })','await readOnce(directoryReads, root, () => node_fs_1.default.promises.readdir(root, { withFileTypes: true }))'],
  ['await node_fs_1.default.promises.readFile(item.path, "utf8")','await readOnce(fileReads, item.path, () => node_fs_1.default.promises.readFile(item.path, "utf8"))'],
  ['await node_fs_1.default.promises.readFile(node_path_1.default.join(root, e.name), "utf8")','await readOnce(fileReads, node_path_1.default.join(root, e.name), () => node_fs_1.default.promises.readFile(node_path_1.default.join(root, e.name), "utf8"))'],
  ['    for (const file of [".claude.json", ".claude/settings.json"]) {','    for (const file of (!options.agent || options.agent === "claude" ? [".claude.json", ".claude/settings.json"] : [])) {']
 ];
 for(const [before,after]of replacements){
  if(!code.includes(before)||code.indexOf(before)!==code.lastIndexOf(before))throw Error('Unrecognized extension scan boundary: '+before);
  code=code.replace(before,after);
 }
 return code;
}
module.exports={extensionScan};
