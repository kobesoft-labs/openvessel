'use strict';
// OpenVessel: amaro bundles swc as a 3 MB WebAssembly module. It is not part of nodelib.js but
// fetched from the runtime (amaro.js) the first time TypeScript is stripped; see src/nodejs/typescript.ts.
module.exports = globalThis.__ovAmaro(require);
