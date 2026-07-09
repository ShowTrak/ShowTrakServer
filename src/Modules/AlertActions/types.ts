// Shared types for the AlertActions family.

export interface AlertActionSettingField {
  Key: string;
  Label: string;
  Type: string;
  Default?: unknown;
  Min?: number;
  Max?: number;
  Options?: unknown[];
  Source?: string;
  Preview?: string;
  Hidden?: boolean;
  [key: string]: unknown;
}

export interface AlertActionResult {
  Success: boolean;
  Error?: string | null;
  Warning?: string;
  StatusCode?: number;
  [key: string]: unknown;
}

export type AlertContext = Record<string, unknown>;

// The runtime action config handed to Execute (the persisted rule action plus a
// normalized Settings bag). Fields are intentionally loose — Execute normalizes
// its own Settings defensively.
export interface AlertActionInput {
  Type?: string;
  Settings?: unknown;
  [key: string]: unknown;
}

// The subset of the shared Logger surface the action transports actually use.
export interface ActionLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(suffix: string): ActionLogger;
}

export interface AlertAction {
  ID: string;
  Name: string;
  Description?: string;
  Settings: AlertActionSettingField[];
  NormalizeSettings?(Input: unknown): Record<string, unknown>;
  ValidateSettings?(Input: unknown): boolean;
  Execute(
    Action: AlertActionInput,
    Context: AlertContext,
    Logger: ActionLogger
  ): Promise<AlertActionResult> | AlertActionResult;
}
