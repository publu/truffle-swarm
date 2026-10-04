/**
 * A failed swarm call. `status` is 0 when the request never reached the server,
 * which is the only case where a write may or may not have landed.
 */
export class SwarmError extends Error {
  constructor(message, status = 0, details = {}) {
    super(message);
    this.name = "SwarmError";
    this.status = status;
    if (details.guidance !== undefined) this.guidance = details.guidance;
    if (details.currentRevision !== undefined) this.currentRevision = details.currentRevision;
    if (details.currentVersion !== undefined) this.currentVersion = details.currentVersion;
  }
  /** Credentials were rejected: reconnecting will not help without a new invitation. */
  get rejectedIdentity() {
    return this.status === 401 || this.status === 403;
  }
  /** Someone else wrote first. Reread and reconcile; never overwrite. */
  get conflict() {
    return this.status === 409;
  }
  /** Delivery is unknown, so a retry must reuse the original request id. */
  get uncertain() {
    return this.status === 0 || this.status >= 500;
  }
  toJSON() {
    return {
      error: this.message,
      status: this.status,
      ...(this.guidance ? { guidance: this.guidance } : {}),
      ...(this.currentRevision !== undefined ? { currentRevision: this.currentRevision } : {}),
      ...(this.currentVersion !== undefined ? { currentVersion: this.currentVersion } : {}),
    };
  }
}

/** Server guidance is additive advice. Only version 1 is understood. */
export function readGuidance(payload) {
  return payload?.guidance?.version === 1 ? payload.guidance : undefined;
}
