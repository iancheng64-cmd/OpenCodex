"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionSelection = void 0;
/** Tracks attempts for the current selection, without permanently blacklisting a
 * failed target. Changing away and back permits another automatic attempt. */
class ConnectionSelection {
    signature = "";
    revision = 0;
    attemptedRevision = -1;
    select(signature) {
        if (signature !== this.signature) {
            this.signature = signature;
            this.revision++;
        }
    }
    canAutoConnect() { return this.attemptedRevision !== this.revision; }
    begin() { this.attemptedRevision = this.revision; return this.revision; }
    isCurrent(attempt) { return attempt === this.revision; }
}
exports.ConnectionSelection = ConnectionSelection;
