import path from 'path';
import fs from 'fs';

import { Manager as AppDataManager } from '../AppData';
import { Manager as UUIDManager } from '../UUID';

interface ServerIdentityRecord {
  Token: string;
  CreatedAt: number;
}

const IdentityFilePath = path.join(AppDataManager.GetStorageDirectory(), 'server-identity.json');

let cachedIdentity: ServerIdentityRecord | null = null;

function loadIdentityFromDisk(): ServerIdentityRecord | null {
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

function writeIdentityToDisk(identity: ServerIdentityRecord): void {
  fs.writeFileSync(IdentityFilePath, JSON.stringify(identity, null, 2));
}

export const Manager = {
  GetIdentity(): ServerIdentityRecord {
    if (cachedIdentity) return cachedIdentity;

    AppDataManager.Initialize();

    const existing = loadIdentityFromDisk();
    if (existing) {
      cachedIdentity = existing;
      return cachedIdentity;
    }

    const created: ServerIdentityRecord = {
      Token: UUIDManager.Generate(),
      CreatedAt: Date.now(),
    };
    writeIdentityToDisk(created);
    cachedIdentity = created;
    return cachedIdentity;
  },

  GetIdentityToken(): string {
    const identity = Manager.GetIdentity();
    return identity && identity.Token ? identity.Token : '';
  },
};
