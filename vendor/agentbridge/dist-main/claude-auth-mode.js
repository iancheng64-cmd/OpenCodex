"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isolateOfficialSettings = isolateOfficialSettings;
exports.prepareClaudeAuth = prepareClaudeAuth;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const providerKey = (key) => /^ANTHROPIC_|^CLAUDE_CODE_(?:USE_BEDROCK|USE_VERTEX|USE_FOUNDRY|SUBAGENT_MODEL|MAX_OUTPUT_TOKENS)$/.test(key);
const providerSettings = new Set(['model', 'fallbackModel', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod', 'forceLoginOrgUUID', 'availableModels', 'modelOverrides']);
function isolateOfficialSettings(values, initial) {
    const env = { ...initial };
    for (const key of Object.keys(env))
        if (providerKey(key))
            delete env[key];
    let settings = {};
    for (const value of values) {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            continue;
        for (const [key, item] of Object.entries(value)) {
            if (key === 'env') {
                for (const [name, text] of Object.entries(item && typeof item === 'object' ? item : {}))
                    if (!providerKey(name) && typeof text === 'string')
                        env[name] = text;
                continue;
            }
            if (providerSettings.has(key))
                continue;
            settings[key] = item && typeof item === 'object' && !Array.isArray(item) ? { ...(settings[key] || {}), ...item } : item;
        }
    }
    // OAuth remains resolved by the native CLI's own keychain/config directory.
    return { settings, env };
}
async function prepareClaudeAuth(mode, cwd, api, environment = process.env) {
    let endpoint;
    if (mode === 'api' && api?.baseUrl) {
        let u;
        try {
            u = new URL(api.baseUrl);
        }
        catch {
            throw new Error('API 端點格式無效。');
        }
        if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
            throw new Error('API 端點須為 HTTPS，或本機 loopback HTTP。');
        endpoint = u.href.replace(/\/$/, '');
    }
    // API without overrides loads its existing native provider configuration unchanged.
    const overrides = mode === 'api' && !!(endpoint || api?.apiKey || api?.model);
    if (mode === 'api' && !overrides)
        return { env: { ...environment }, args: [], cleanup: async () => { } };
    const home = environment.CLAUDE_CONFIG_DIR || node_path_1.default.join(node_os_1.default.homedir(), '.claude');
    const values = [];
    for (const file of [node_path_1.default.join(home, 'settings.json'), node_path_1.default.join(cwd, '.claude/settings.json'), node_path_1.default.join(cwd, '.claude/settings.local.json')]) {
        try {
            values.push(JSON.parse(await promises_1.default.readFile(file, 'utf8')));
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw new Error('Claude 原生設定無法安全載入；未修改原始設定。');
        }
    }
    const isolated = isolateOfficialSettings(values, environment);
    const settings = isolated.settings;
    const env = isolated.env;
    if (mode === 'api') {
        // Keep existing provider settings unless explicitly overridden, but keep all env secrets in memory.
        Object.assign(env, environment);
        for (const value of values) {
            for (const [key, item] of Object.entries(value)) {
                if (key === 'env') {
                    for (const [name, text] of Object.entries(item && typeof item === 'object' ? item : {}))
                        if (typeof text === 'string')
                            env[name] = text;
                }
                else if (providerSettings.has(key))
                    settings[key] = item;
            }
        }
        if (endpoint) {
            env.ANTHROPIC_BASE_URL = endpoint;
            for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])
                delete env[key];
        }
        if (api?.apiKey) {
            env.ANTHROPIC_API_KEY = api.apiKey;
            delete env.ANTHROPIC_AUTH_TOKEN;
            delete env.CLAUDE_CODE_OAUTH_TOKEN;
            delete settings.apiKeyHelper;
        }
        if (api?.model) {
            if (api.model.length > 200 || /[\s\x00-\x1f]/.test(api.model))
                throw new Error('模型 ID 格式無效。');
            env.ANTHROPIC_MODEL = api.model;
            delete settings.model;
        }
    }
    const dir = await promises_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'agentbridge-claude-settings-'));
    await promises_1.default.chmod(dir, 0o700);
    const file = node_path_1.default.join(dir, 'settings.json');
    try {
        await promises_1.default.writeFile(file, JSON.stringify(settings), { mode: 0o600 });
    }
    catch (error) {
        await promises_1.default.rm(dir, { recursive: true, force: true });
        throw error;
    }
    // Restore native commands/skills/agents omitted by setting-source isolation, via a session-only native plugin.
    const plugin = node_path_1.default.join(dir, 'native-context');
    await promises_1.default.mkdir(node_path_1.default.join(plugin, '.claude-plugin'), { recursive: true });
    await promises_1.default.writeFile(node_path_1.default.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'agentbridge-native-context', version: '1.0.0', description: 'Existing native Mac commands, skills and agents' }), { mode: 0o600 });
    let entries = 0;
    for (const category of ['skills', 'commands', 'agents']) {
        const target = node_path_1.default.join(plugin, category);
        await promises_1.default.mkdir(target, { recursive: true });
        for (const source of [node_path_1.default.join(home, category), node_path_1.default.join(cwd, '.claude', category)]) {
            let names;
            try {
                names = await promises_1.default.readdir(source);
            }
            catch {
                continue;
            }
            for (const name of names) {
                if (name.startsWith('.'))
                    continue;
                const destination = node_path_1.default.join(target, name);
                await promises_1.default.rm(destination, { recursive: true, force: true });
                await promises_1.default.symlink(node_path_1.default.join(source, name), destination);
                entries++;
            }
        }
    }
    return { env, args: ['--setting-sources', '', '--settings', file, ...(entries ? ['--plugin-dir', plugin] : [])], cleanup: () => promises_1.default.rm(dir, { recursive: true, force: true }) };
}
