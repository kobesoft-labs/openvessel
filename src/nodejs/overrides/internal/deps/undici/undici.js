'use strict';
// OpenVessel: undici speaks HTTP over TCP sockets, which a browser can't open to the outside.
// fetch and the web classes come from src/nodejs/fetch.ts (virtual ports via node:http,
// everything else via the runtime's policy-checked proxy).
module.exports = globalThis.__ovUndici;
