// Run with: npx -y node@<version in src/node/version.ts> --expose-internals --no-warnings test/fixtures-gen/crypto-tables.cjs src/nodejs/bindings/crypto/tables.ts
const b = require('internal/test/binding').internalBinding('crypto');
const fs = require('fs');
const supported = (n) => {
  const l = n.toLowerCase();
  if (/ocb|xts|aria|camellia|sm4|des3-wrap|cms3deswrap/.test(l)) return false;
  return /^(aes|id-aes|chacha20|des-ede|des3)/.test(l);
};
const ciphers = b.getCiphers().filter(supported);
const table = {};
for (const n of ciphers) {
  const info = b.getCipherInfo({}, n);
  table[n.toLowerCase()] = info;
}
const out = `// Generated from Node ${process.version} (OpenSSL ${process.versions.openssl}) by test/fixtures-gen/crypto-tables.cjs. Do not edit.
// Cipher metadata for the ciphers OpenVessel implements: lookup key is the lower-cased name.

export interface CipherInfo { mode?: string; name: string; nid: number; blockSize?: number; ivLength?: number; keyLength: number }

export const CIPHERS: Record<string, CipherInfo> = ${JSON.stringify(table, null, 0).replace(/\},"/g, '},\n  "')};

export const SSL_CIPHERS: string[] = ${JSON.stringify(b.getSSLCiphers())};

// Digest names OpenSSL resolves → Node's digest cache id (filled by getHashes() as a side effect)
export const HASH_ALIASES: Record<string, number> = ${(b.getHashes(), JSON.stringify(b.getCachedAliases()))};
`;
const groups = {};
for (const g of ['modp1', 'modp2', 'modp5', 'modp14', 'modp15', 'modp16', 'modp17', 'modp18']) groups[g] = new b.DiffieHellmanGroup(g).getPrime().toString('hex');
fs.writeFileSync(process.argv[2], out + `
// Primes of the DiffieHellmanGroup groups (RFC 2409 / RFC 3526), generator 2.
export const DH_GROUPS: Record<string, string> = ${JSON.stringify(groups, null, 1).replace(/\n\s*/g, ' ')};
`);
console.log(Object.keys(table).length, 'ciphers');
