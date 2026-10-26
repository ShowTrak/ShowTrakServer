// Script.json schema definition + normalizer
// - Single source of truth for the cross-platform script config shape
// - Auto-adds missing required keys and repairs/defaults invalid values
// - Used both when loading scripts from disk and when saving edits from the
//   Script Manager UI.
import { isDeepStrictEqual } from 'util';
import path from 'path';

import { SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS } from '../Config/constants';

// The platforms a script can target. Order is meaningful for display.
const PLATFORM_KEYS = ['Windows', 'macOS', 'Linux'];

// Console filter match modes. The filter is applied CLIENT-SIDE while a script
// runs: only console lines that match are surfaced as the live status tail.
// "none" disables filtering (every line is surfaced; the historical default).
// Order is meaningful for display in the Script Manager UI.
const CONSOLE_FILTER_MODES = ['none', 'startsWith', 'includes', 'regex'];
const DEFAULT_CONSOLE_FILTER_MODE = 'none';

// How hard a script asks before it runs. Script.json stores this as the
// historical `Confirmation` boolean plus an optional `ConfirmationStyle`, which
// is written ONLY for "Critical": every pre-existing Script.json stays
// byte-identical (no checksum churn, no mass redeploy), and older clients and
// SDK consumers that only read `Confirmation` still see a confirm-worthy script.
const CONFIRMATION_LEVELS = ['None', 'Standard', 'Critical'] as const;
type ConfirmationLevel = (typeof CONFIRMATION_LEVELS)[number];
const CRITICAL_CONFIRMATION_STYLE = 'Critical';

function IsConfirmationLevel(value: unknown): value is ConfirmationLevel {
  return typeof value === 'string' && (CONFIRMATION_LEVELS as readonly string[]).includes(value);
}

// Collapse the two Script.json keys into one level.
function ResolveConfirmationLevel(Config: {
  Confirmation?: unknown;
  ConfirmationStyle?: unknown;
}): ConfirmationLevel {
  if (Config.Confirmation !== true) return 'None';
  return Config.ConfirmationStyle === CRITICAL_CONFIRMATION_STYLE ? 'Critical' : 'Standard';
}

const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1', '.exe']);
const POSIX_SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.command']);

// Ordered colour palette used for the Colour field.
// Index 0-5 are rainbow hues; 6-7 are light/dark greys.
const SCRIPT_COLOURS = [
  '#e74c3c', // 0 – red
  '#e67e22', // 1 – orange
  '#f1c40f', // 2 – yellow
  '#2ecc71', // 3 – green
  '#3498db', // 4 – blue
  '#9b59b6', // 5 – purple
  '#bdc3c7', // 6 – light grey
  '#7f8c8d', // 7 – dark grey
];

// Map legacy Bootstrap style names to the nearest SCRIPT_COLOURS index.
const BOOTSTRAP_TO_COLOUR_INDEX: Record<string, number> = {
  primary: 4, // blue
  secondary: 7, // dark grey
  success: 3, // green
  danger: 0, // red
  warning: 2, // yellow
  info: 4, // blue (closest)
  light: 6, // light grey
  dark: 7, // dark grey
};

function IsPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Normalize a relative script path so it matches the folder's file listing and
// resolves identically on every ShowTrakClient OS.
function NormalizeRelativePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  let p = value.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p.trim();
}

function NormalizeArgumentString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

// A console filter ({ Mode, Pattern, Strip }). Mode "none" (or an empty Pattern)
// means "no filter": every console line is surfaced, the historical behaviour.
// When Strip is true the matched text is removed from the surfaced line (only
// the remainder is shown as the live status tail). Parsing/matching/stripping
// happens on the ShowTrakClient; this only validates shape.
interface ConsoleFilterConfig {
  Mode: string;
  Pattern: string;
  Strip: boolean;
}

// Normalize the optional ConsoleFilter object. Coerces Mode to a known mode
// (defaulting to "includes") and Pattern to a trimmed string. For regex mode a
// pattern that fails to compile is kept as-authored but reported as a warning
// so the author can fix it; the client disables an uncompilable filter.
function NormalizeConsoleFilter(value: unknown): { filter: ConsoleFilterConfig; errors: string[] } {
  const errors: string[] = [];
  const raw = IsPlainObject(value) ? value : {};
  if (value !== undefined && !IsPlainObject(value)) {
    errors.push('"ConsoleFilter" was not an object; reset to an empty filter.');
  }

  let Mode = typeof raw.Mode === 'string' ? raw.Mode.trim() : '';
  if (!CONSOLE_FILTER_MODES.includes(Mode)) {
    if (Mode)
      errors.push(
        `ConsoleFilter "Mode" was invalid; defaulted to "${DEFAULT_CONSOLE_FILTER_MODE}".`
      );
    Mode = DEFAULT_CONSOLE_FILTER_MODE;
  }

  const Pattern = typeof raw.Pattern === 'string' ? raw.Pattern.trim() : '';
  if (raw.Pattern !== undefined && typeof raw.Pattern !== 'string') {
    errors.push('ConsoleFilter "Pattern" was not a string; reset to empty.');
  }

  const Strip = raw.Strip === true;
  if (raw.Strip !== undefined && typeof raw.Strip !== 'boolean') {
    errors.push('ConsoleFilter "Strip" was not a boolean; reset to false.');
  }

  if (Mode === 'regex' && Pattern) {
    try {
      // Validate only; the compiled instance is discarded (the client compiles
      // its own at run time).
      new RegExp(Pattern);
    } catch (err) {
      errors.push(`ConsoleFilter regex "${Pattern}" is invalid: ${(err as Error).message}`);
    }
  }

  return { filter: { Mode, Pattern, Strip }, errors };
}

// Normalize a Bootstrap Icons reference into a bare icon name (no "bi-"
// prefix). Accepts "terminal", "bi-terminal", or "bi bi-terminal" and strips
// anything that isn't a valid icon-name character. Returns '' when unusable.
function NormalizeIconName(value: unknown): string {
  if (typeof value !== 'string') return '';
  let name = value.trim().toLowerCase();
  if (!name) return '';
  // Drop a leading "bi " (from a full "bi bi-xxx" class string).
  name = name.replace(/^bi\s+/, '');
  // Drop a leading "bi-" prefix.
  name = name.replace(/^bi-/, '');
  // Bootstrap icon names are lowercase letters, digits and hyphens only.
  if (!/^[a-z0-9-]+$/.test(name)) return '';
  return name;
}

function NormalizeTimeoutMs(value: unknown): number | null {
  // Stored in Script.json as integer milliseconds.
  if (typeof value === 'number' && Number.isInteger(value) && value >= 5000) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 5000) return parsed;
  }
  return null;
}

function ResolveLegacyPathTargets(legacyPath: string): string[] {
  const extension = path.extname(legacyPath).toLowerCase();
  if (WINDOWS_SCRIPT_EXTENSIONS.has(extension)) return ['Windows'];
  if (POSIX_SCRIPT_EXTENSIONS.has(extension)) return ['macOS', 'Linux'];
  // Unknown/neutral files fall back to all primary platforms.
  return ['Windows', 'macOS', 'Linux'];
}

// The managed keys every normalized Script.json carries. Unknown author keys
// are preserved alongside these (hence the index signature).
interface NormalizedScriptConfig {
  Name: string;
  Description: string;
  Colour: number;
  Icon: string;
  Weight: number;
  Confirmation: boolean;
  /** Present only when "Critical"; see CONFIRMATION_LEVELS. */
  ConfirmationStyle?: 'Critical';
  Enabled: boolean;
  Timeout: number;
  Platforms: Record<string, string>;
  Arguments: Record<string, string>;
  ConsoleFilter: ConsoleFilterConfig;
  [key: string]: unknown;
}

// Produce a fully-normalized config object for a script folder.
function NormalizeScriptConfig(
  RawData: unknown,
  ID: string
): { config: NormalizedScriptConfig; changed: boolean; errors: string[] } {
  const errors: string[] = [];
  const data: Record<string, unknown> = IsPlainObject(RawData) ? RawData : {};
  if (!IsPlainObject(RawData)) {
    errors.push('Root value was not a JSON object; rebuilt from defaults.');
  }

  // Preserve any unknown keys the author added (e.g. comments/notes), then
  // overwrite the managed keys with validated values below.
  const config: Record<string, unknown> = { ...data };

  // Name -----------------------------------------------------------------
  if (typeof data.Name === 'string' && data.Name.trim()) {
    config.Name = data.Name;
  } else {
    config.Name = ID;
    errors.push('"Name" was missing or invalid; defaulted to the script ID.');
  }

  // Description ----------------------------------------------------------
  if (typeof data.Description === 'string') {
    config.Description = data.Description;
  } else {
    config.Description = '';
    if (data.Description !== undefined) {
      errors.push('"Description" was not a string; reset to empty.');
    }
  }

  // Colour ---------------------------------------------------------------
  const rawColour = data.Colour;
  const legacyStyle =
    typeof data.Style === 'string'
      ? data.Style
      : typeof data.LabelStyle === 'string'
        ? data.LabelStyle
        : null;

  if (
    typeof rawColour === 'number' &&
    Number.isInteger(rawColour) &&
    rawColour >= 0 &&
    rawColour < SCRIPT_COLOURS.length
  ) {
    config.Colour = rawColour;
  } else if (
    legacyStyle &&
    Object.prototype.hasOwnProperty.call(BOOTSTRAP_TO_COLOUR_INDEX, legacyStyle)
  ) {
    config.Colour = BOOTSTRAP_TO_COLOUR_INDEX[legacyStyle];
    errors.push(`Legacy Style "${legacyStyle}" was migrated to colour index ${config.Colour}.`);
  } else {
    config.Colour = 6; // default: light grey
    if (rawColour !== undefined || legacyStyle !== null) {
      errors.push('"Colour" was missing or invalid; defaulted to index 6 (light grey).');
    }
  }

  // Icon -----------------------------------------------------------------
  // Bootstrap Icons name (e.g. "terminal"), stored without the "bi-" prefix.
  // Defaults to "terminal" to match the historical run-button glyph.
  const NormalizedIcon = NormalizeIconName(data.Icon);
  config.Icon = NormalizedIcon || 'terminal';
  if (data.Icon !== undefined && !NormalizedIcon) {
    errors.push('"Icon" was missing or invalid; defaulted to "terminal".');
  }

  // Weight ---------------------------------------------------------------
  if (typeof data.Weight === 'number' && Number.isFinite(data.Weight)) {
    config.Weight = data.Weight;
  } else if (
    typeof data.Weight === 'string' &&
    data.Weight.trim() !== '' &&
    Number.isFinite(Number(data.Weight))
  ) {
    config.Weight = Number(data.Weight);
    errors.push('"Weight" was a string; coerced to a number.');
  } else {
    config.Weight = 0;
    errors.push('"Weight" was missing or invalid; defaulted to 0.');
  }

  // Confirmation ---------------------------------------------------------
  if (typeof data.Confirmation === 'boolean') {
    config.Confirmation = data.Confirmation;
  } else {
    config.Confirmation = false;
    errors.push('"Confirmation" was missing or invalid; defaulted to false.');
  }
  // The style only means something on a confirmed script, and only "Critical"
  // is ever stored; anything else is dropped so the file stays canonical.
  if (config.Confirmation === true && data.ConfirmationStyle === CRITICAL_CONFIRMATION_STYLE) {
    config.ConfirmationStyle = CRITICAL_CONFIRMATION_STYLE;
  } else if ('ConfirmationStyle' in config) {
    delete config.ConfirmationStyle;
    if (config.Confirmation === true && data.ConfirmationStyle !== 'Standard') {
      errors.push('"ConfirmationStyle" was invalid; reset to a standard confirmation.');
    }
  }

  // Enabled --------------------------------------------------------------
  if (typeof data.Enabled === 'boolean') {
    config.Enabled = data.Enabled;
  } else {
    config.Enabled = false;
    errors.push('"Enabled" was missing or invalid; defaulted to false.');
  }

  // Timeout --------------------------------------------------------------
  const TimeoutMs = NormalizeTimeoutMs(data.Timeout);
  if (TimeoutMs !== null) {
    config.Timeout = TimeoutMs;
  } else {
    config.Timeout = SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS;
    if (data.Timeout !== undefined) {
      errors.push(
        `"Timeout" was invalid (minimum 5000ms); defaulted to ${SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS}ms.`
      );
    } else {
      errors.push(`"Timeout" was missing; defaulted to ${SCRIPT_EXECUTION_DEFAULT_TIMEOUT_MS}ms.`);
    }
  }

  // Platforms ------------------------------------------------------------
  const rawPlatforms = IsPlainObject(data.Platforms) ? data.Platforms : null;
  const legacyPath =
    typeof data.Path === 'string' && data.Path.trim() ? NormalizeRelativePath(data.Path) : null;

  if (!rawPlatforms && !legacyPath) {
    errors.push('"Platforms" was missing; added an empty cross-platform map.');
  } else if (!rawPlatforms) {
    errors.push('"Platforms" was missing; created from the legacy "Path" value.');
  }

  const platforms: Record<string, string> = {};
  for (const key of PLATFORM_KEYS) {
    const value = rawPlatforms ? rawPlatforms[key] : undefined;
    if (typeof value === 'string') {
      const normalized = NormalizeRelativePath(value);
      platforms[key] = normalized;
      if (value.trim() !== normalized) {
        errors.push(`Platform "${key}" path was normalized to "${normalized}".`);
      }
    } else if (value === undefined || value === null) {
      platforms[key] = '';
    } else {
      platforms[key] = '';
      errors.push(`Platform "${key}" had a non-string value; reset to empty.`);
    }
  }

  // Legacy compatibility: fold old RPM-specific entries into Linux.
  if (rawPlatforms) {
    const rpm = NormalizeRelativePath(rawPlatforms.RPM);
    if (rpm && !platforms.Linux) {
      platforms.Linux = rpm;
      errors.push('Legacy "Platforms.RPM" was migrated to "Platforms.Linux".');
    }
  }

  // Migrate a legacy single "Path" into platform slots based on script type.
  if (legacyPath) {
    const targets = ResolveLegacyPathTargets(legacyPath);
    let migrated = false;
    for (const key of targets) {
      if (!platforms[key]) {
        platforms[key] = legacyPath;
        migrated = true;
      }
    }
    if (migrated) {
      errors.push(`Legacy "Path" was migrated into platform targets: ${targets.join(', ')}.`);
    }
  }

  config.Platforms = platforms;

  // Arguments ------------------------------------------------------------
  const rawArguments = IsPlainObject(data.Arguments) ? data.Arguments : null;
  if (!rawArguments) {
    errors.push('"Arguments" was missing; added an empty cross-platform map.');
  }

  const argumentsByPlatform: Record<string, string> = {};
  for (const key of PLATFORM_KEYS) {
    const value = rawArguments ? rawArguments[key] : undefined;
    if (typeof value === 'string') {
      const normalized = NormalizeArgumentString(value);
      argumentsByPlatform[key] = normalized;
      if (value !== normalized) {
        errors.push(`Arguments for "${key}" were trimmed.`);
      }
    } else if (value === undefined || value === null) {
      argumentsByPlatform[key] = '';
    } else {
      argumentsByPlatform[key] = '';
      errors.push(`Arguments for "${key}" had a non-string value; reset to empty.`);
    }
  }

  config.Arguments = argumentsByPlatform;

  // ConsoleFilter ---------------------------------------------------------
  const { filter: consoleFilter, errors: consoleFilterErrors } = NormalizeConsoleFilter(
    data.ConsoleFilter
  );
  config.ConsoleFilter = consoleFilter;
  errors.push(...consoleFilterErrors);

  // The legacy top-level "Path" is superseded by Platforms; drop it.
  if ('Path' in config) delete config.Path;
  // "Type" is no longer part of the schema; drop it.
  if ('Type' in config) delete config.Type;
  // Legacy string colour keys are superseded by the integer Colour index.
  if ('Style' in config) delete config.Style;
  if ('LabelStyle' in config) delete config.LabelStyle;

  const changed = !isDeepStrictEqual(data, config);
  return { config: config as NormalizedScriptConfig, changed, errors };
}

export {
  PLATFORM_KEYS,
  CONFIRMATION_LEVELS,
  IsConfirmationLevel,
  ResolveConfirmationLevel,
  SCRIPT_COLOURS,
  BOOTSTRAP_TO_COLOUR_INDEX,
  CONSOLE_FILTER_MODES,
  DEFAULT_CONSOLE_FILTER_MODE,
  NormalizeScriptConfig,
  NormalizeConsoleFilter,
  NormalizeIconName,
};
export type { NormalizedScriptConfig, ConsoleFilterConfig, ConfirmationLevel };
