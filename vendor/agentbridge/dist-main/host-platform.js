"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.profileRuntimePlatform = profileRuntimePlatform;
exports.connectionPlatformIdentity = connectionPlatformIdentity;
function profileRuntimePlatform(profile) {
    return profile.runtimePlatform === 'windows' || profile.runtimePlatform === 'posix' ? profile.runtimePlatform : 'auto';
}
/** Preserve existing chat/usage identities when an explicit choice becomes auto. */
function connectionPlatformIdentity(requested, resolved) {
    if (requested !== 'auto')
        return requested;
    const platform = resolved.toLowerCase();
    if (platform === 'windows' || platform === 'win32')
        return 'windows';
    if (['posix', 'darwin', 'macos', 'linux', 'freebsd', 'openbsd', 'netbsd', 'sunos'].includes(platform))
        return 'posix';
    throw new Error('Runtime 未回報已辨識的主機系統，請重新連線。');
}
