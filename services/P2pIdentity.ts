/**
 * Wi-Fi Direct identity and MAC helpers for the MAC-keyed call path (step 4).
 *
 * The framework's P2P device name is the phone's model/Bluetooth name, a
 * namespace that can never match the contact name (see
 * ROUTE1-RELIABILITY-2026-11-03.md, "Name-matching for P2P peers is dead code
 * in practice"). Both phones therefore publish a stable tag derived from the
 * account UUID, so a scanner can identify a saved friend by tag alone.
 *
 * The tag is SHA-256(uuid)[0..12] prefixed with "BK-". It is a *hash*, not the
 * UUID, so a nearby scanner learns a 48-bit identifier rather than the account
 * UUID itself. It is identity, never a secret: the control-socket token still
 * authenticates the session.
 */

// FIPS 180-4 round constants.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** UTF-8 encode without relying on TextEncoder, which Hermes does not ship. */
function utf8Bytes(input: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0xd800 || code >= 0xe000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else {
      const next = input.charCodeAt(++i);
      const cp = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** SHA-256 over a short UTF-8 string. Returns the eight big-endian words. */
export function sha256Words(input: string): number[] {
  const bytes = utf8Bytes(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length; the high word is zero for the inputs we hash.
  bytes.push(0, 0, 0, 0,
    (bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff);

  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((bytes[offset + i * 4] << 24) | (bytes[offset + i * 4 + 1] << 16)
        | (bytes[offset + i * 4 + 2] << 8) | bytes[offset + i * 4 + 3]) | 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H;
}

export function sha256Hex(input: string): string {
  return sha256Words(input).map(word => (word >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Symmetric per-session control-socket token. Both phones derive it from the
 * sorted UUID pair and the session id, so the token never travels over Nearby
 * or any out-of-band channel. It is not a replacement for the pinned-key
 * challenge-response step; it only stops a stray connection on the P2P link
 * from impersonating a saved friend.
 */
export function pairToken(a: string, b: string, sessionId: string): string {
  const left = typeof a === 'string' ? a.trim().toLowerCase() : '';
  const right = typeof b === 'string' ? b.trim().toLowerCase() : '';
  const session = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!left || !right || !session) return '';
  return sha256Hex(`${[left, right].sort().join(':')}:${session}`);
}

/** The P2P device name this phone publishes for its account UUID. */
export function p2pTag(uuid: string): string {
  const value = typeof uuid === 'string' ? uuid.trim().toLowerCase() : '';
  if (!value) return '';
  return `BK-${sha256Hex(value).slice(0, 12)}`;
}

/**
 * Discovery candidates for a friend: the deterministic tag first, then the
 * saved display name as a fallback for a peer running an older build that has
 * not set its P2P name yet.
 */
export function expectedPeerNames(uuid: string, deviceName?: string | null): string[] {
  const names: string[] = [];
  const tag = p2pTag(uuid);
  if (tag) names.push(tag);
  const name = typeof deviceName === 'string' ? deviceName.trim() : '';
  if (name && name !== tag) names.push(name);
  return names;
}

const PLACEHOLDER_MACS = new Set(['00:00:00:00:00:00', '02:00:00:00:00:00']);

/**
 * Normalise a cached P2P MAC, rejecting the framework placeholder. A
 * placeholder reaching connect() would mean "connect to anyone".
 */
export function validP2pMac(mac?: string | null): string | null {
  const value = typeof mac === 'string' ? mac.trim().toLowerCase() : '';
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value)) return null;
  return PLACEHOLDER_MACS.has(value) ? null : value;
}
