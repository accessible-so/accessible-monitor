import * as signature from './index';

declare global {
  // eslint-disable-next-line no-var
  var AccessibleSignature: typeof signature | undefined;
}

globalThis.AccessibleSignature = signature;
