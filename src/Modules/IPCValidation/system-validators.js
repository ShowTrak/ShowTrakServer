// Network discovery scan and settings-update validators.
const { fail, isPlainObject, normalizeNonEmptyString } = require('./primitives');

module.exports = function registerSystemValidators(Manager) {
  Manager.NetworkDiscoveryScanID = (value) => {
    return normalizeNonEmptyString(value, 'ScanID', { minLength: 8, maxLength: 128 });
  };

  Manager.NetworkDiscoveryScanOptions = (value) => {
    if (value == null) return {};
    if (!isPlainObject(value)) fail('Network discovery options must be an object');

    const out = {};

    if (Object.prototype.hasOwnProperty.call(value, 'EnableBonjour')) {
      out.EnableBonjour = !!value.EnableBonjour;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'EnableProbe')) {
      out.EnableProbe = !!value.EnableProbe;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'TimeoutMs')) {
      const timeout = Number(value.TimeoutMs);
      if (!Number.isFinite(timeout)) fail('TimeoutMs must be a number');
      if (timeout < 1000 || timeout > 120000) fail('TimeoutMs must be between 1000 and 120000');
      out.TimeoutMs = Math.floor(timeout);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'MaxHostsPerSubnet')) {
      const maxHosts = Number(value.MaxHostsPerSubnet);
      if (!Number.isFinite(maxHosts)) fail('MaxHostsPerSubnet must be a number');
      if (maxHosts < 8 || maxHosts > 4096) fail('MaxHostsPerSubnet must be between 8 and 4096');
      out.MaxHostsPerSubnet = Math.floor(maxHosts);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'Concurrency')) {
      const concurrency = Number(value.Concurrency);
      if (!Number.isFinite(concurrency)) fail('Concurrency must be a number');
      if (concurrency < 1 || concurrency > 128) fail('Concurrency must be between 1 and 128');
      out.Concurrency = Math.floor(concurrency);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'ProbePorts')) {
      if (!Array.isArray(value.ProbePorts)) fail('ProbePorts must be an array');
      if (!value.ProbePorts.length) fail('ProbePorts cannot be empty');
      const ports = value.ProbePorts.map((p) => {
        const port = Number(p);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          fail('ProbePorts must contain valid TCP port numbers');
        }
        return port;
      });
      out.ProbePorts = Array.from(new Set(ports));
    }

    return out;
  };

  Manager.SettingUpdatePayload = (key, value) => {
    const normalizedKey = normalizeNonEmptyString(key, 'Setting key', { minLength: 2, maxLength: 128 });

    if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
      fail('Setting value must be a boolean, string, or number');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      fail('Setting value number is invalid');
    }

    if (normalizedKey === 'WEBUI_PASSWORD') {
      const normalizedValue = String(value == null ? '' : value)
        .replace(/\D/g, '')
        .slice(0, 4);
      if (normalizedValue !== '' && !/^\d{4}$/.test(normalizedValue)) {
        fail('WEBUI_PASSWORD must be exactly 4 digits');
      }
      return [normalizedKey, normalizedValue];
    }

    return [normalizedKey, value];
  };
};
