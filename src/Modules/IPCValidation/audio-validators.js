// Audio asset IPC validators. Normalizes payloads for importing, updating and
// deleting user audio assets used as alert sounds.
const { fail, isPlainObject, normalizeNonEmptyString } = require('./primitives');

module.exports = function registerAudioValidators(Manager) {
  Manager.AudioAssetID = (value, fieldName = 'Audio Asset ID') => {
    return normalizeNonEmptyString(value, fieldName, { minLength: 1, maxLength: 128 });
  };

  Manager.AudioImportPayload = (value) => {
    if (!isPlainObject(value)) fail('Audio import payload must be an object');

    const SourcePath = normalizeNonEmptyString(value.SourcePath, 'Source Path', {
      minLength: 1,
      maxLength: 4096,
    });

    const out = { SourcePath };

    if (Object.prototype.hasOwnProperty.call(value, 'Label') && value.Label != null) {
      if (typeof value.Label !== 'string') fail('Label must be a string');
      out.Label = value.Label;
    }

    if (Object.prototype.hasOwnProperty.call(value, 'Volume') && value.Volume != null) {
      const Volume = Number(value.Volume);
      if (!Number.isFinite(Volume)) fail('Volume must be a number');
      out.Volume = Volume;
    }

    if (Object.prototype.hasOwnProperty.call(value, 'Duration') && value.Duration != null) {
      const Duration = Number(value.Duration);
      if (!Number.isFinite(Duration)) fail('Duration must be a number');
      out.Duration = Duration;
    }

    return out;
  };

  Manager.AudioUpdatePayload = (value) => {
    if (!isPlainObject(value)) fail('Audio update payload must be an object');
    const out = {};
    let touched = false;

    if (Object.prototype.hasOwnProperty.call(value, 'Label') && value.Label != null) {
      if (typeof value.Label !== 'string') fail('Label must be a string');
      out.Label = value.Label;
      touched = true;
    }

    if (Object.prototype.hasOwnProperty.call(value, 'Volume') && value.Volume != null) {
      const Volume = Number(value.Volume);
      if (!Number.isFinite(Volume)) fail('Volume must be a number');
      out.Volume = Volume;
      touched = true;
    }

    if (!touched) fail('Nothing to update');
    return out;
  };
};
