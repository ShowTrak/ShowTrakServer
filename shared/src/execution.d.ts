// Script / integrated-event execution contracts.

/** Correlates a dispatched task with its asynchronous response. */
export type ExecutionRequestID = string;

/** Server -> client payload accompanying a LAN software update. */
export interface UpdateSoftwareFromLANPayload {
  /** Path appended to the server origin to build the update feed URL. */
  FeedPath?: string;
  ReleaseVersion?: string | null;
}
