"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.permissionMode = permissionMode;
exports.codexPermissionPolicy = codexPermissionPolicy;
function permissionMode(value) {
    if (value !== 'ask' && value !== 'project' && value !== 'full')
        throw new Error('請選擇有效的操作權限。');
    return value;
}
function codexPermissionPolicy(mode) { return mode === 'full' ? { approvalPolicy: 'never', sandbox: 'danger-full-access' } : { approvalPolicy: 'untrusted', sandbox: 'read-only' }; }
