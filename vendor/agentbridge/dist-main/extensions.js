"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.remoteExtensionScript = void 0;
exports.localExtensions = localExtensions;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
async function localExtensions(options = {}) {
    const items = [];
    const seen = new Set();
    const add = (name, kind, agent, status = kind === "mcp" ? "configured" : "installed") => {
        const id = `local:${agent}:${kind}:${name}`;
        if (!seen.has(id)) {
            seen.add(id);
            items.push({ id, name, kind, agent, source: "local", status });
        }
        else if (status === "configured") {
            const item = items.find((x) => x.id === id);
            if (item)
                item.status = status;
        }
    };
    let budget = 30000;
    const walk = async (root, agent, depth = 0, discovered = false) => {
        if (depth > 9 || budget-- <= 0)
            return;
        let entries;
        try {
            entries = await node_fs_1.default.promises.readdir(root, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            if (e.name === "SKILL.md") {
                const name = node_path_1.default.basename(root);
                add(name, "skill", agent, discovered ? "discovered" : "installed");
                const item = items.find(item => item.id === `local:${agent}:skill:${name}`);
                if (item) {
                    item.path = node_path_1.default.join(root, e.name);
                    item.enabled = !discovered;
                    item.executionLocation = "local";
                    item.capability = "skill";
                    try {
                        const doc = await node_fs_1.default.promises.readFile(item.path, "utf8");
                        const description = /^description:\s*(.+)$/m.exec(doc);
                        item.description = description?.[1]?.replace(/^['"]|['"]$/g, '').slice(0, 500);
                    }
                    catch { }
                }
            }
            else if (e.name === "plugin.json") {
                let name = node_path_1.default.basename(node_path_1.default.basename(root) === ".codex-plugin" || node_path_1.default.basename(root) === ".claude-plugin" ? node_path_1.default.dirname(root) : root);
                try {
                    const config = JSON.parse(await node_fs_1.default.promises.readFile(node_path_1.default.join(root, e.name), "utf8"));
                    if (typeof config.name === "string")
                        name = config.name;
                }
                catch { }
                add(name, "plugin", agent, "discovered");
            }
            else if (e.isDirectory() && !["node_modules", ".git", ".venv", "vendor"].includes(e.name))
                await walk(node_path_1.default.join(root, e.name), agent, depth + 1, discovered);
        }
    };
    const home = node_os_1.default.homedir();
    for (const [dir, agent] of [[".codex/skills", "codex"], [".agents/skills", "codex"], [".codex/plugins", "codex"], [".claude/skills", "claude"], [".claude/plugins", "claude"]])
        await walk(node_path_1.default.join(home, dir), agent, 0, dir.includes("/plugins"));
    try {
        const config = await node_fs_1.default.promises.readFile(node_path_1.default.join(process.env.CODEX_HOME || node_path_1.default.join(home, ".codex"), "config.toml"), "utf8");
        for (const match of config.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^\].\s]+))\]\s*$/gm))
            add(match[1] || match[2] || match[3], "mcp", "codex");
    }
    catch { }
    for (const file of [".claude.json", ".claude/settings.json"]) {
        try {
            const data = JSON.parse(await node_fs_1.default.promises.readFile(node_path_1.default.join(home, file), "utf8"));
            for (const name of Object.keys(data.mcpServers || {}))
                add(name, "mcp", "claude");
            for (const [name, enabled] of Object.entries(data.enabledPlugins || {}))
                if (enabled)
                    add(name, "plugin", "claude", "configured");
        }
        catch { }
    }
    if (options.cwd) {
        for (const [dir, agent] of [[".agents/skills", "codex"], [".codex/skills", "codex"], [".claude/skills", "claude"]])
            await walk(node_path_1.default.join(options.cwd, dir), agent);
    }
    for (const item of items) {
        item.executionLocation = "local";
        item.capability = item.kind === "plugin" ? "metadata" : item.kind;
        item.enabled ??= item.status !== "discovered";
    }
    return { items: items.filter(item => !options.agent || item.agent === options.agent).sort((a, b) => a.name.localeCompare(b.name)), warnings: [] };
}
// This emits names and installation state only; credentials, URLs and commands never leave the host.
exports.remoteExtensionScript = String.raw `
import os,json,re
home=os.path.expanduser('~')
items=[]
seen=set()
def add(name,kind,agent,status=None):
  ident='remote:'+agent+':'+kind+':'+name
  if ident not in seen:
    seen.add(ident)
    items.append(dict(id=ident,name=name,kind=kind,agent=agent,source='remote',status=status or ('configured' if kind=='mcp' else 'installed')))
  elif status=='configured':
    for item in items:
      if item['id']==ident: item['status']=status
for root,agent in [('.codex/skills','codex'),('.agents/skills','codex'),('.codex/plugins','codex'),('.claude/skills','claude'),('.claude/plugins','claude')]:
  base=os.path.join(home,root)
  count=0
  for current,dirs,files in os.walk(base):
    count+=1
    dirs[:]=[d for d in dirs if d not in ('node_modules','.git','.venv','vendor')]
    if current[len(base):].count(os.sep)>9 or count>30000: dirs[:]=[]; continue
    if 'SKILL.md' in files: add(os.path.basename(current),'skill',agent,'discovered' if '/plugins' in root else 'installed')
    if 'plugin.json' in files:
      name=os.path.basename(os.path.dirname(current) if os.path.basename(current) in ('.codex-plugin','.claude-plugin') else current)
      try:
        with open(os.path.join(current,'plugin.json')) as f: name=json.load(f).get('name',name)
      except Exception: pass
      if isinstance(name,str): add(name,'plugin',agent,'discovered')
try:
  with open(os.path.join(os.environ.get('CODEX_HOME',os.path.join(home,'.codex')),'config.toml')) as f: config=f.read()
  for match in re.finditer(r'^\s*\[mcp_servers\.([^\]]+)\]\s*$',config,re.M):
    name=match.group(1).strip().strip('"').strip("'")
    if '.' not in name: add(name,'mcp','codex')
except Exception: pass
for filename in ['.claude.json','.claude/settings.json']:
  try:
    with open(os.path.join(home,filename)) as f: config=json.load(f)
    for name in config.get('mcpServers',{}): add(name,'mcp','claude')
    for name,enabled in config.get('enabledPlugins',{}).items():
      if enabled: add(name,'plugin','claude','configured')
  except Exception: pass
print(json.dumps(dict(items=items,warnings=[])))
`;
