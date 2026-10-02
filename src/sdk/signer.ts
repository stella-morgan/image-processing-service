import { sign } from '../lib/signing.js';
import type { Signer } from './index.js';

export function createSigner(secret: string): Signer {
  return (path, params) => sign(secret, path, params);
}
