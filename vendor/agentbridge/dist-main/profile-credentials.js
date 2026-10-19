"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sameCredentialTarget = sameCredentialTarget;
exports.publicProfile = publicProfile;
exports.saveCredentialProfile = saveCredentialProfile;
exports.savedCredentialFor = savedCredentialFor;
const host_platform_1 = require("./host-platform");
function sameCredentialTarget(a, b) { return a.host.trim().toLowerCase() === b.host.trim().toLowerCase() && (a.port || 22) === (b.port || 22) && a.username === b.username && a.authType === b.authType; }
function publicProfile(profile) { const { password, encryptedPassword, ...value } = profile; return { ...value, hasSavedPassword: !!encryptedPassword }; }
function saveCredentialProfile(incoming, previous, encrypt, encryptionAvailable) {
    const profile = { id: incoming.id, name: incoming.name, host: incoming.host.trim(), port: incoming.port || 22, username: incoming.username, authType: incoming.authType, keyPath: incoming.keyPath, networkMode: incoming.networkMode || 'auto', relayUrl: incoming.relayUrl?.trim() || undefined, claudeConfigDir: incoming.claudeConfigDir?.trim() || undefined, savePassword: incoming.savePassword === true, runtimePlatform: (0, host_platform_1.profileRuntimePlatform)(incoming.runtimePlatform === undefined ? previous || {} : incoming) };
    if (!profile.id || (!profile.host || !profile.username) && !(profile.networkMode !== 'direct' && profile.relayUrl))
        throw new Error('請填入完整的連線設定。');
    if (profile.savePassword && profile.authType === 'password') {
        if (incoming.password) {
            if (!encryptionAvailable)
                throw new Error('macOS 加密儲存目前不可用，未儲存密碼。');
            profile.encryptedPassword = encrypt(incoming.password);
        }
        else if (previous?.encryptedPassword && sameCredentialTarget(profile, previous))
            profile.encryptedPassword = previous.encryptedPassword;
    }
    return profile;
}
function savedCredentialFor(incoming, profiles) { const saved = profiles.find(profile => profile.id === incoming.id); return saved?.savePassword && saved.encryptedPassword && sameCredentialTarget(saved, incoming) ? saved : undefined; }
