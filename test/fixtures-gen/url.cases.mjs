// Inputs for internalBinding('url'), shared by the fixture generator (real Node) and the unit test
// (OpenVessel's binding). `run(binding)` returns plain JSON-able results.

const urls = [
  'https://user:pass@example.com:1234/foo/bar?baz#quux',
  'https://user@example.com/',
  'https://:pass@example.com/',
  'https://user:@example.com/',
  'http://example.com',
  'http://EXAMPLE.com:80/a/../b/./c',
  'http://example.com:8080',
  'http://example.com:0/',
  'http://example.com:65535/',
  'http://example.com:65536/',
  'http://[::1]:3000/x',
  'http://[2001:db8::ff00:42:8329]/',
  'http://[::ffff:192.168.0.1]/',
  'http://[1:2:3:4:5:6:7:8]/',
  'http://[::1/',
  'http://0x7f.1/',
  'http://127.0.0.1/',
  'http://4294967295/',
  'http://4294967296/',
  'http://1.2.3.4.5/',
  'http://1.2.3.09/',
  'http://xn--nxasmq6b.com/',
  'http://ñ.com/',
  'http://bücher.de/über?q=ä#ö',
  'http://日本語.jp/パス',
  'http://ＥＸＡＭＰＬＥ．ｃｏｍ/',
  'http://a.b.c./',
  'http://xn--iñvalid.com/',
  'http://xn--/',
  'http://ex%41mple.com/',
  'http://ex ample.com/',
  'http://exa<mple.com/',
  'http://%zz/',
  'file:///home/user/a b.txt',
  'file:///C:/Windows/System32',
  'file:///C|/x',
  'file://host/share/f',
  'file://localhost/etc/passwd',
  'file:',
  'file:/x',
  'file://',
  'file:///',
  'file:///a/../../b',
  'mailto:someone@example.com',
  'javascript:alert(1)',
  'data:text/plain,hello world',
  'blob:https://example.com/uuid',
  'blob:http://a.com:81/x',
  'blob:ftp://a.com/x',
  'blob:foo',
  'about:blank',
  'foo://host/path?q#h',
  'foo://',
  'foo:///x',
  'foo:',
  'foo:/',
  'foo://user:pw@h:99/p',
  'web+demo:/.//not-a-host/',
  'web+demo://h//x',
  'sc:/.//p',
  'non-spec:/..//p',
  'ws://example.com/chat',
  'wss://example.com:443/',
  'ftp://ftp.example.com:21/pub',
  'ftp://u:p@ftp.example.com:2121/pub',
  'https://example.com/?',
  'https://example.com/#',
  'https://example.com/?#',
  'https://example.com/p?a=1&b=2#frag?x',
  'https://example.com/p#frag#more',
  'https://example.com/%7Efoo/%zz',
  'https://example.com/a\\b\\c',
  'https://example.com/ \t\n',
  '  https://example.com/trim  ',
  'https://example.com/\u{1F600}?\u{1F600}#\u{1F600}',
  'https://example.com/\ud800',
  'https://example.com/?q=\udfff',
  'https:example.com',
  'https:/example.com',
  'https:\\\\example.com\\p',
  'http://user:p@ss@host/',
  'http://@host/',
  'http://:@host/',
  'http://h:/',
  'http://h:abc/',
  'http:',
  'http://',
  'http:///',
  '',
  ' ',
  '//example.com/p',
  '/abs/path',
  'rel/path',
  '../up',
  '?query',
  '#hash',
  '.',
  'not a url',
  'https://ex\u00ADample.com/',
  'https://example.com./',
  'https://a..b/',
  'https://a\u3002b/',
  'http://[fe80::1%25eth0]/',
  'http://[::1]x/',
  'urn:isbn:0451450523',
  'tel:+1-816-555-1212',
  'git+ssh://git@github.com:user/repo.git',
  'HTTP://Example.COM/A',
  'hTtP://x/',
  'https://example.com:443/',
  'http://example.com:443/',
  'https://ä.example/',
  'https://xn--4ca.example/',
  'https://faß.de/',
  'https://\u200d.com/',
  'https://a\u200db.com/',
];

const formatHrefs = [
  'https://user:pass@example.com:1234/foo/bar?baz#quux',
  'https://user@xn--nxasmq6b.com/',
  'http://xn--bcher-kva.de/%C3%BCber?q=%C3%A4#%C3%B6',
  'http://xn--wgv71a119e.jp/',
  'https://:p@xn--4ca.example:8/x?y#',
  'http://[::1]:3000/x?#',
  'file:///home/user/a%20b.txt',
  'file://xn--4ca/share',
  'mailto:someone@example.com?subject=x#y',
  'foo://u:p@xn--4ca/p?q#h',
  'web+demo:/.//not-a-host/',
  'http://127.0.0.1/',
];

const bases = [
  undefined,
  'https://user:pass@example.com:8080/dir/file?q#h',
  'file:///home/user/',
  'foo://host/a/b',
  'mailto:x@y',
  'not a base',
  'http://[::1]/a/',
];

const relatives = ['', '.', '..', '../..', 'x', '/x', '//h2/x', '?q2', '#h2', 'http:x', 'https:x', 'file:x', 'foo:x', '\\x', 'a/../../b', '%2e%2E/x', 'C:/x', '//', '///x', '\u{1F600}'];

// internal/url.js updateActions
const actions = { kProtocol: 0, kHost: 1, kHostname: 2, kPort: 3, kUsername: 4, kPassword: 5, kPathname: 6, kSearch: 7, kHash: 8, kHref: 9 };
const setterValues = {
  kProtocol: ['http', 'https:', 'ftp', 'file', 'foo', 'ws', 'HTTPS', 'bad scheme', '1abc', 'mailto', 'h:ttp', ''],
  kHost: ['example.org', 'example.org:81', 'EXAMPLE.org:443', '[::1]:9', 'ñ.com', 'a b', '', 'h:abc', 'h:', 'x/y', 'x?y', 'x#y', 'x@y', '0x7f.1'],
  kHostname: ['example.org', 'example.org:81', '[::1]', 'ñ.com', 'a b', '', 'x/y', '1.2.3.4', 'xn--iñ', 'a%41'],
  kPort: ['81', '0', '65535', '65536', '-1', 'abc', '80', '443', '', '12abc', '  8'],
  kUsername: ['user', 'u s@r', '', 'üser', ':'],
  kPassword: ['pw', 'p w:@', '', 'päss'],
  kPathname: ['/a/b', 'a/b', '', '/a b/%zz', '/../x', '\\x\\y', '//x', '/?#', '/\u{1F600}'],
  kSearch: ['?a=1', 'a=1', '', '?', '?a b#c', '\u{1F600}', '??'],
  kHash: ['#x', 'x', '', '#', '# y', '\u{1F600}'],
  kHref: ['https://other.example/', 'not a url', '', 'foo:bar', 'http://[::1]:8/x?y#z', 'file:///x'],
};
const setterTargets = [
  'https://user:pass@example.com:1234/foo/bar?baz#quux',
  'http://example.com/',
  'file:///home/x',
  'file://host/x',
  'foo://host/p',
  'foo:/p',
  'mailto:a@b',
  'web+demo:/.//x',
  'http://[::1]/',
];

const domains = [
  '',
  'example.com',
  'EXAMPLE.COM',
  'ñ.com',
  'xn--ida.com',
  'xn--iñvalid.com',
  'xn--',
  'xn--a',
  'xn--zz-zzz.com',
  '日本語.jp',
  'ＥＸＡＭＰＬＥ．ｃｏｍ',
  'a。b',
  'faß.de',
  'straße.de',
  '\u200d.com',
  'a\u200db.com',
  'a b.com',
  'a%41.com',
  'a/b',
  'a:80',
  'a?b',
  'a#b',
  '[::1]',
  '127.0.0.1',
  '0x7f.1',
  '1.2.3.4.5',
  '-a.com',
  'a-.com',
  'a..b',
  '.',
  'a.',
  '\u0640.com',
  'ab\u0301.com',
  'x',
  'X',
  'xn--4ca',
  'xn--4CA',
  'Xn--4ca',
  'xn--nxasmq6b',
  '\ud800.com',
  '\u{1F600}.com',
  'א.com',
  'aא.com',
];

const paths = [
  ['/home/user/file.txt', false],
  ['/a b/c#d?e%f', false],
  ['/x/~user/[a]/^|"\\', false],
  ['/\t\n\r\0', false],
  ['/日本/ü/\u{1F600}', false],
  ['/\ud800', false],
  ['/', false],
  ['//x', false],
  ['C:\\Users\\a b\\f.txt', true],
  ['C:\\x%y#z', true],
  ['\\share\\res', true, 'server'],
  ['\\x', true, 'xn--4ca'],
  ['\\x', true, 'ñ'],
  ['D:/mixed\\sep', true],
];

function errOf(e) {
  return { threw: e?.constructor?.name, code: e?.code, message: e?.message, input: e?.input, base: e?.base };
}

function comps(binding) {
  return Array.from(binding.urlComponents);
}

export function run(binding) {
  const out = { parse: [], update: [], canParse: [], format: [], getOrigin: [], domainToASCII: [], domainToUnicode: [], pathToFileURL: [] };
  const parseOne = (input, base, raise) => {
    try {
      const href = binding.parse(input, base, raise);
      return href === undefined ? { href: null } : { href, comps: comps(binding) };
    } catch (e) {
      return errOf(e);
    }
  };
  for (const u of urls) {
    for (const base of [undefined, bases[1]]) out.parse.push({ args: [u, base], r: parseOne(u, base, true) });
    out.parse.push({ args: [u, undefined, false], r: parseOne(u, undefined, false) });
    out.canParse.push({ args: [u], r: binding.canParse(u) });
    out.canParse.push({ args: [u, bases[2]], r: binding.canParse(u, bases[2]) });
    try {
      out.getOrigin.push({ args: [u], r: binding.getOrigin(u) });
    } catch (e) {
      out.getOrigin.push({ args: [u], r: errOf(e) });
    }
  }
  for (const href of formatHrefs) {
    for (let m = 0; m < 16; m++) {
      const args = [href, !!(m & 1), !!(m & 2), !!(m & 4), !!(m & 8)];
      out.format.push({ args, r: binding.format(...args) });
    }
  }
  for (const base of bases) for (const rel of relatives) out.parse.push({ args: [rel, base], r: parseOne(rel, base, true) });
  for (const t of setterTargets) {
    const href = binding.parse(t, undefined, true);
    for (const [name, values] of Object.entries(setterValues)) {
      for (const v of values) {
        let r;
        try {
          const res = binding.update(href, actions[name], v);
          // ada reports some no-op setters as `false`; internal/url.js treats both alike.
          r = res === false || res === href ? { unchanged: true } : { href: res, comps: comps(binding) };
        } catch (e) {
          r = errOf(e);
        }
        out.update.push({ args: [href, name, v], r });
      }
    }
  }
  for (const d of domains) {
    out.domainToASCII.push({ args: [d], r: binding.domainToASCII(d) });
    out.domainToUnicode.push({ args: [d], r: binding.domainToUnicode(d) });
  }
  for (const [p, win, host] of paths) {
    try {
      const href = binding.pathToFileURL(p, win, host);
      out.pathToFileURL.push({ args: [p, win, host], r: { href, comps: comps(binding) } });
    } catch (e) {
      out.pathToFileURL.push({ args: [p, win, host], r: errOf(e) });
    }
  }
  return out;
}
