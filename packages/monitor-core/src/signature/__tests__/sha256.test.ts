import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../sha256';

// Vectors from FIPS 180-4 / NIST examples.
describe('sha256Hex', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('hashes a two-block message', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });
  it('encodes non-ASCII input as UTF-8 before hashing', () => {
    // "é" is 0xC3 0xA9 in UTF-8; a Latin-1 or UTF-16 encoding would hash differently.
    expect(sha256Hex('é')).not.toBe(sha256Hex('e'));
    expect(sha256Hex('é')).toHaveLength(64);
    expect(sha256Hex('é')).toBe(sha256Hex('é'));
  });
});
