import { createHash } from 'crypto';
import fs from 'fs';

import { CreateLogger } from '../Logger';

const Logger = CreateLogger('Checksum');

export const Manager = {
  // SHA-1 hex digest of the file contents. The algorithm must stay in step
  // with the ShowTrakClient ChecksumManager, which compares these values to
  // detect changed script files during sync.
  Checksum(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const hash = createHash('sha1');
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        Logger.error(`Failed to checksum ${filePath}:`, err);
        resolve(null);
      });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  },
};
