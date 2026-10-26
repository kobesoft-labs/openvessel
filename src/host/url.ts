// Base URLs given to boot(): runtimeUrl and previewUrl name a directory.

/**
 * The directory a deployment URL names, with a trailing slash. A last path segment with an extension
 * (`…/runtime.html`) is a file in that directory; one without (`https://pv.example.com/app`) is the
 * directory itself, so `new URL('./', …)` doesn't climb to its parent. Query and fragment are dropped.
 */
export function directoryUrl(url: string, base: string): URL {
  const u = new URL(url, base);
  u.search = '';
  u.hash = '';
  const last = u.pathname.slice(u.pathname.lastIndexOf('/') + 1);
  if (last && !last.includes('.')) u.pathname += '/';
  return new URL('./', u);
}
