// Shared types for the AlertActions family.
import type { AlertActionSettingField } from '@showtrak/protocol';

// An action's settings schema reaches the rule editor as it is declared
// (GetAlertActionTypes), so each field is the protocol's.
export type { AlertActionSettingField };

export interface AlertActionResult {
  Success: boolean;
  Error?: string | null;
  Warning?: string;
  StatusCode?: number;
  [key: string]: unknown;
}

export type AlertContext = Record<string, unknown>;

// The runtime action config handed to Execute (the persisted rule action plus a
// normalized Settings bag). Fields are intentionally loose; Execute normalizes
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
