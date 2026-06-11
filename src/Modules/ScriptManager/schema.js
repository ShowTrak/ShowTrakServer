// Script.json schema definition + normalizer
// - Single source of truth for the cross-platform script config shape
// - Auto-adds missing required keys and repairs/defaults invalid values
// - Used both when loading scripts from disk and when saving edits from the
//   Script Manager UI.
const { isDeepStrictEqual } = require('util');
const path = require('path');

// The platforms a script can target. Order is meaningful for display.
const PLATFORM_KEYS = ['Windows', 'macOS', 'Linux'];

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
const BOOTSTRAP_TO_COLOUR_INDEX = {
  primary:   4, // blue
  secondary: 7, // dark grey
  success:   3, // green
  danger:    0, // red
  warning:   2, // yellow
  info:      4, // blue (closest)
  light:     6, // light grey
  dark:      7, // dark grey
};

function IsPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Normalize a relative script path so it matches the folder's file listing and
// resolves identically on every ShowTrakClient OS:
// - convert Windows-style backslashes to forward slashes (path.join treats
//   forward slashes correctly on Windows, macOS and Linux)
// - strip leading "./" / ".\" segments (e.g. "./run.bat" -> "run.bat")
// Returns '' for non-strings/empty input.
function NormalizeRelativePath(value) {
  if (typeof value !== 'string') return '';
  let p = value.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p.trim();
}

function NormalizeArgumentString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function NormalizeTimeoutMs(value) {
  // Stored in Script.json as integer milliseconds.
  if (typeof value === 'number' && Number.isInteger(value) && value >= 5000) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 5000) return parsed;
  }
  return null;
}

function ResolveLegacyPathTargets(legacyPath) {
  const extension = path.extname(legacyPath).toLowerCase();
  if (WINDOWS_SCRIPT_EXTENSIONS.has(extension)) return ['Windows'];
  if (POSIX_SCRIPT_EXTENSIONS.has(extension)) return ['macOS', 'Linux'];
  // Unknown/neutral files fall back to all primary platforms.
  return ['Windows', 'macOS', 'Linux'];
}

// Produce a fully-normalized config object for a script folder.
// Returns { config, changed, errors } where:
//   config  - the cleaned config (always valid against the schema)
//   changed - true when the normalized config differs from the input
//   errors  - human-readable notes describing what was repaired/defaulted
function NormalizeScriptConfig(RawData, ID) {
  const errors = [];
  const data = IsPlainObject(RawData) ? RawData : {};
  if (!IsPlainObject(RawData)) {
    errors.push('Root value was not a JSON object; rebuilt from defaults.');
  }

  // Preserve any unknown keys the author added (e.g. comments/notes), then
  // overwrite the managed keys with validated values below.
  const config = { ...data };

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
  // Stored as an integer index into SCRIPT_COLOURS.  Migrate legacy string
  // Style / LabelStyle values to the nearest colour index automatically.
  const rawColour = data.Colour;
  const legacyStyle =
    typeof data.Style === 'string'
      ? data.Style
      : typeof data.LabelStyle === 'string'
        ? data.LabelStyle
        : null;

  if (typeof rawColour === 'number' && Number.isInteger(rawColour) &&
      rawColour >= 0 && rawColour < SCRIPT_COLOURS.length) {
    config.Colour = rawColour;
  } else if (legacyStyle && Object.prototype.hasOwnProperty.call(BOOTSTRAP_TO_COLOUR_INDEX, legacyStyle)) {
    config.Colour = BOOTSTRAP_TO_COLOUR_INDEX[legacyStyle];
    errors.push(`Legacy Style "${legacyStyle}" was migrated to colour index ${config.Colour}.`);
  } else {
    config.Colour = 6; // default: light grey
    if (rawColour !== undefined || legacyStyle !== null) {
      errors.push('"Colour" was missing or invalid; defaulted to index 6 (light grey).');
    }
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

  // Enabled --------------------------------------------------------------
  if (typeof data.Enabled === 'boolean') {
    config.Enabled = data.Enabled;
  } else {
    config.Enabled = false;
    errors.push('"Enabled" was missing or invalid; defaulted to false.');
  }

  // Timeout --------------------------------------------------------------
  // Per-script execution timeout in milliseconds.
  const TimeoutMs = NormalizeTimeoutMs(data.Timeout);
  if (TimeoutMs !== null) {
    config.Timeout = TimeoutMs;
  } else {
    config.Timeout = 15000;
    if (data.Timeout !== undefined) {
      errors.push('"Timeout" was invalid (minimum 5000ms); defaulted to 15000ms.');
    } else {
      errors.push('"Timeout" was missing; defaulted to 15000ms.');
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

  const platforms = {};
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
  // Windows script files stay on Windows only; POSIX shell scripts stay on
  // macOS/Linux. This prevents accidental cross-OS launch mapping.
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
      errors.push(
        `Legacy "Path" was migrated into platform targets: ${targets.join(', ')}.`
      );
    }
  }

  config.Platforms = platforms;

  // Arguments ------------------------------------------------------------
  // Optional per-platform argument string. Parsed by the client at run time.
  const rawArguments = IsPlainObject(data.Arguments) ? data.Arguments : null;
  if (!rawArguments) {
    errors.push('"Arguments" was missing; added an empty cross-platform map.');
  }

  const argumentsByPlatform = {};
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

  // The legacy top-level "Path" is superseded by Platforms; drop it.
  if ('Path' in config) delete config.Path;
  // "Type" is no longer part of the schema; drop it.
  if ('Type' in config) delete config.Type;
  // Legacy string colour keys are superseded by the integer Colour index.
  if ('Style' in config) delete config.Style;
  if ('LabelStyle' in config) delete config.LabelStyle;

  const changed = !isDeepStrictEqual(data, config);
  return { config, changed, errors };
}

module.exports = {
  PLATFORM_KEYS,
  SCRIPT_COLOURS,
  BOOTSTRAP_TO_COLOUR_INDEX,
  NormalizeScriptConfig,
};
