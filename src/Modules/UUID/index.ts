import { v4 as uuidv4 } from 'uuid';

export const Manager = {
  Generate(): string {
    return uuidv4();
  },
};
