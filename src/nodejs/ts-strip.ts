// TypeScript type stripping for the ported Node (stands in for amaro, whose swc build is a 3 MB
// WebAssembly module). Built as its own script and loaded on first use by typescript.ts.
import { transform } from 'sucrase';

(globalThis as any).__ovSucraseTransform = (source: string, options: { mode?: string; sourceMap?: boolean; filename?: string }) => {
  const r = transform(source, {
    transforms: ['typescript'],
    disableESTransforms: true,
    keepUnusedImports: true,
    filePath: options.filename,
    sourceMapOptions: options.sourceMap ? { compiledFilename: options.filename ?? 'file.ts' } : undefined,
  });
  return { code: r.code, map: r.sourceMap ? JSON.stringify(r.sourceMap) : undefined };
};
