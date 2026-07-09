import { APP_PORT } from './constants';

const Package = require('../../../package.json') as { version?: string };

const Version = Package.version || '0.0.0';

export const Config = {
  Application: {
    Version,
    Name: 'ShowTrak',
    Port: APP_PORT,
  },
  Shared: {
    Version,
  },
};
