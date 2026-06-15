const path = require('path');
const fs = require('fs');

const { Manager: AppDataManager } = require('../AppData');
const { Manager: UUIDManager } = require('../UUID');

const IdentityFilePath = path.join(AppDataManager.GetStorageDirectory(), 'server-identity.json');

let cachedIdentity = null;

function loadIdentityFromDisk() {
  try {
    if (!fs.existsSync(IdentityFilePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(IdentityFilePath, 'utf8'));
    if (!parsed || typeof parsed.Token !== 'string' || !parsed.Token.trim()) {
      return null;
    }
    return {
      Token: parsed.Token.trim(),
      CreatedAt: typeof parsed.CreatedAt === 'number' ? parsed.CreatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function writeIdentityToDisk(identity) {
  fs.writeFileSync(IdentityFilePath, JSON.stringify(identity, null, 2));
}

const Manager = {};

Manager.GetIdentity = () => {
  if (cachedIdentity) return cachedIdentity;

  AppDataManager.Initialize();

  const existing = loadIdentityFromDisk();
  if (existing) {
    cachedIdentity = existing;
    return cachedIdentity;
  }

  const created = {
    Token: UUIDManager.Generate(),
    CreatedAt: Date.now(),
  };
  writeIdentityToDisk(created);
  cachedIdentity = created;
  return cachedIdentity;
};

Manager.GetIdentityToken = () => {
  const identity = Manager.GetIdentity();
  return identity && identity.Token ? identity.Token : '';
};

module.exports = {
  Manager,
};
