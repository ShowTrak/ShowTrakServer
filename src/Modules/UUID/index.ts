import { randomUUID } from 'crypto';

export const Manager = {
  Generate(): string {
    return randomUUID();
  },
};
