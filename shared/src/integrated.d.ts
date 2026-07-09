// Integrated-client (SDK) surface: declared actions and self-reported state.

/**
 * An action ("event") declared by an integrated client via the ShowTrak
 * Integration SDK (`RegisterActions`).
 */
export interface IntegratedAction {
  /** Matches `^[A-Za-z0-9_.-]+$`. */
  ID: string;
  Label: string;
  /** Colour palette index, 0-7. */
  ColourIndex: number;
  /** When true, the server waits for an `IntegratedEventResponse`. */
  HasFeedback: boolean;
}

/**
 * Health state an integrated client may self-report via `SetIntegratedState`.
 * `OFFLINE` is never accepted from the client.
 */
export type IntegratedState = 'ONLINE' | 'DEGRADED';
