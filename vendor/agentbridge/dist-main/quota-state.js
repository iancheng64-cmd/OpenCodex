"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeQuotaState = void 0;
/** A selected Runtime owns its snapshots. Events supersede pending reads. */
class RuntimeQuotaState {
    runtimeId;
    revision = 0;
    sequence = 0;
    quota;
    baseline;
    busy = false;
    select(runtimeId) {
        if (runtimeId !== this.runtimeId) {
            this.runtimeId = runtimeId;
            this.revision++;
            this.quota = undefined;
            this.baseline = undefined;
            this.busy = false;
        }
    }
    get view() { return { runtimeId: this.runtimeId, quota: this.quota, baseline: this.baseline, busy: this.busy }; }
    begin() {
        if (!this.runtimeId || this.busy)
            return;
        this.busy = true;
        return { runtimeId: this.runtimeId, revision: this.revision, sequence: ++this.sequence };
    }
    complete(request, value) {
        if (request.runtimeId !== this.runtimeId || request.revision !== this.revision || request.sequence !== this.sequence)
            return false;
        this.busy = false;
        this.apply(value);
        return true;
    }
    receive(runtimeId, value) {
        if (runtimeId !== this.runtimeId)
            return false;
        this.revision++;
        this.busy = false;
        this.apply(value);
        return true;
    }
    apply(value) {
        if (value.resetBaseline)
            this.baseline = undefined;
        if (value.available && !this.baseline)
            this.baseline = value;
        this.quota = value;
    }
}
exports.RuntimeQuotaState = RuntimeQuotaState;
