// Records how real Node (the pinned version)'s internalBinding('http_parser') reacts to many byte streams.
// Run: npx -y node@<version in src/node/version.ts> --expose-internals --no-warnings test/fixtures-gen/http_parser.mjs
// Writes test/unit/fixtures/http_parser.json, replayed by test/unit/bindings-http_parser.test.ts.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { internalBinding } = require('internal/test/binding');
const { HTTPParser, ConnectionsList, methods, allMethods } = internalBinding('http_parser');

const REQ = HTTPParser.REQUEST;
const RES = HTTPParser.RESPONSE;
const ALL = HTTPParser.kLenientAll;
const L = HTTPParser;

// ---------------------------------------------------------------------------
// cases: { name, type, input (latin1 string) | chunks, lenient?, max?, hc? (headers-complete return), split? }

const cases = [];
const add = (c) => cases.push(c);

// --- requests
add({ name: 'simple GET', type: REQ, input: 'GET / HTTP/1.1\r\nHost: example.com\r\n\r\n', split: true });
add({ name: 'GET with query/fragment', type: REQ, input: 'GET /a/b?c=d&e=f#frag HTTP/1.1\r\nHost: x\r\n\r\n', split: true });
add({ name: 'absolute url', type: REQ, input: 'GET http://user:pw@example.com:8080/p?q#f HTTP/1.1\r\n\r\n', split: true });
add({ name: 'asterisk', type: REQ, input: 'OPTIONS * HTTP/1.1\r\n\r\n' });
add({ name: 'CONNECT', type: REQ, input: 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\nraw tunnel bytes', split: true });
add({ name: 'CONNECT with hc=2', type: REQ, hc: 2, input: 'CONNECT example.com:443 HTTP/1.1\r\n\r\nxyz' });
add({ name: 'POST content-length', type: REQ, input: 'POST /submit HTTP/1.1\r\nContent-Length: 11\r\nContent-Type: text/plain\r\n\r\nhello world', split: true });
add({ name: 'POST chunked with ext and trailers', type: REQ, input: 'POST /c HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5;foo=bar;baz="q\\"x"\r\nhello\r\n6\r\n world\r\n0\r\nX-Trailer: yes\r\nX-Other: 2\r\n\r\n', split: true });
add({ name: 'chunked uppercase hex', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n' });
add({ name: 'pipelined', type: REQ, input: 'GET /1 HTTP/1.1\r\nHost: a\r\n\r\nPOST /2 HTTP/1.1\r\nContent-Length: 3\r\n\r\nabcGET /3 HTTP/1.1\r\n\r\n', split: true });
add({ name: 'pipelined keep-alive 1.0', type: REQ, input: 'GET /1 HTTP/1.0\r\nConnection: keep-alive\r\n\r\nGET /2 HTTP/1.0\r\n\r\n' });
add({ name: 'HTTP/1.0 close then data', type: REQ, input: 'GET /1 HTTP/1.0\r\n\r\nGET /2 HTTP/1.0\r\n\r\n' });
add({ name: 'Connection close then CRLF', type: REQ, input: 'GET / HTTP/1.1\r\nConnection: close\r\n\r\n\r\n\r\n' });
add({ name: 'Connection close then data', type: REQ, input: 'GET / HTTP/1.1\r\nConnection: close\r\n\r\nGET / HTTP/1.1\r\n\r\n' });
add({ name: 'Connection close then data lenient', type: REQ, lenient: L.kLenientDataAfterClose, input: 'GET / HTTP/1.1\r\nConnection: close\r\n\r\nGET / HTTP/1.1\r\n\r\n' });
add({ name: 'Connection close lenient keep-alive', type: REQ, lenient: L.kLenientKeepAlive, input: 'GET / HTTP/1.1\r\nConnection: close\r\n\r\nGET /2 HTTP/1.1\r\n\r\n' });
add({ name: 'connection tokens', type: REQ, input: 'GET / HTTP/1.1\r\nConnection: Keep-Alive, Upgrade\r\nUpgrade: websocket\r\n\r\n' });
add({ name: 'connection token list', split: true, type: REQ, input: 'GET / HTTP/1.1\r\nConnection: foo, close ,bar\r\n\r\n' });
add({ name: 'connection closed-ish token', type: REQ, input: 'GET / HTTP/1.1\r\nConnection: closed\r\n\r\nGET / HTTP/1.1\r\n\r\n' });
add({ name: 'proxy-connection', type: REQ, input: 'GET / HTTP/1.0\r\nProxy-Connection: keep-alive\r\n\r\n' });
add({ name: 'upgrade websocket', type: REQ, input: 'GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\n\r\n\x81\x05hello', split: true });
add({ name: 'upgrade with hc=2', type: REQ, hc: 2, input: 'GET /ws HTTP/1.1\r\nConnection: upgrade\r\nUpgrade: websocket\r\n\r\nframe' });
add({ name: 'upgrade with body', type: REQ, input: 'POST /ws HTTP/1.1\r\nConnection: upgrade\r\nUpgrade: foo\r\nContent-Length: 4\r\n\r\nbodyREST' });
add({ name: 'upgrade header without connection', type: REQ, input: 'GET / HTTP/1.1\r\nUpgrade: websocket\r\n\r\n' });
add({ name: 'many headers (flush)', type: REQ, input: 'GET /many HTTP/1.1\r\n' + Array.from({ length: 70 }, (_, i) => `X-H${i}: v${i}\r\n`).join('') + '\r\n' });
add({ name: 'many headers then next message', type: REQ, input: 'GET /m HTTP/1.1\r\n' + Array.from({ length: 33 }, (_, i) => `H${i}: ${i}\r\n`).join('') + '\r\nGET /n HTTP/1.1\r\nA: b\r\n\r\n' });
add({ name: 'many trailers', split: true, type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n' + Array.from({ length: 40 }, (_, i) => `T${i}: ${i}\r\n`).join('') + '\r\n' });
add({ name: 'header value OWS trimming', type: REQ, input: 'GET / HTTP/1.1\r\nA:   spaced value  \t \r\nB:\r\nC: \r\nD:x\r\n\r\n', split: true });
add({ name: 'empty header value', type: REQ, input: 'GET / HTTP/1.1\r\nX-Empty:\r\nY: 1\r\n\r\n' });
add({ name: 'obs-fold strict', type: REQ, input: 'GET / HTTP/1.1\r\nA: one\r\n two\r\n\r\n' });
add({ name: 'obs-fold lenient', split: true, type: REQ, lenient: L.kLenientHeaders, input: 'GET / HTTP/1.1\r\nA: one\r\n two\r\n\tthree\r\n\r\n' });
add({ name: 'space before colon strict', type: REQ, input: 'GET / HTTP/1.1\r\nHost : x\r\n\r\n' });
add({ name: 'space before colon lenient', split: true, type: REQ, lenient: L.kLenientHeaders, input: 'GET / HTTP/1.1\r\nHost : x\r\n\r\n' });
add({ name: 'invalid header token', type: REQ, input: 'GET / HTTP/1.1\r\nBad(Header): x\r\n\r\n' });
add({ name: 'header starts with colon', type: REQ, input: 'GET / HTTP/1.1\r\n: x\r\n\r\n' });
add({ name: 'invalid header value char', type: REQ, input: 'GET / HTTP/1.1\r\nA: b\x01c\r\n\r\n' });
add({ name: 'invalid header value char lenient', type: REQ, lenient: L.kLenientHeaders, input: 'GET / HTTP/1.1\r\nA: b\x01c\r\n\r\n' });
add({ name: 'high bytes in header value', type: REQ, input: 'GET / HTTP/1.1\r\nA: caf\xe9 \xff\r\n\r\n' });
add({ name: 'unexpected space after start line', type: REQ, input: 'GET / HTTP/1.1\r\n Host: x\r\n\r\n' });
add({ name: 'unexpected space after start line lenient', type: REQ, lenient: L.kLenientHeaders, input: 'GET / HTTP/1.1\r\n Host: x\r\n\r\n' });
add({ name: 'LF only strict', type: REQ, input: 'GET / HTTP/1.1\nHost: x\n\n' });
add({ name: 'LF only lenient', type: REQ, lenient: ALL, input: 'GET / HTTP/1.1\nHost: x\n\n' });
add({ name: 'LF after header value strict', type: REQ, input: 'GET / HTTP/1.1\r\nHost: x\nA: b\r\n\r\n' });
add({ name: 'CR without LF strict', type: REQ, input: 'GET / HTTP/1.1\rHost: x\r\n\r\n' });
add({ name: 'CR without LF lenient', type: REQ, lenient: L.kLenientOptionalLFAfterCR, input: 'GET / HTTP/1.1\rHost: x\r\n\r\n' });
add({ name: 'missing LF after headers', type: REQ, input: 'GET / HTTP/1.1\r\nHost: x\r\n\rX' });
add({ name: 'missing LF after header value', type: REQ, input: 'GET / HTTP/1.1\r\nHost: x\rY\r\n\r\n' });
add({ name: 'leading CRLF', type: REQ, input: '\r\n\r\nGET / HTTP/1.1\r\n\r\n' });
add({ name: 'invalid method', type: REQ, input: 'FOO / HTTP/1.1\r\n\r\n' });
add({ name: 'lowercase method', type: REQ, input: 'get / HTTP/1.1\r\n\r\n' });
add({ name: 'method prefix', type: REQ, input: 'GETX / HTTP/1.1\r\n\r\n' });
add({ name: 'method partial', type: REQ, input: 'GET_X / HTTP/1.1\r\n\r\n' });
add({ name: 'M-SEARCH', type: REQ, input: 'M-SEARCH * HTTP/1.1\r\n\r\n' });
add({ name: 'QUERY method', type: REQ, input: 'QUERY /q HTTP/1.1\r\nContent-Length: 2\r\n\r\nab' });
add({ name: 'PROPPATCH', type: REQ, input: 'PROPPATCH /x HTTP/1.1\r\n\r\n' });
add({ name: 'RTSP method on HTTP', type: REQ, input: 'DESCRIBE / HTTP/1.1\r\n\r\n' });
add({ name: 'RTSP request', type: REQ, input: 'DESCRIBE rtsp://x/y RTSP/1.0\r\nCSeq: 1\r\n\r\n' });
add({ name: 'ICE source', type: REQ, input: 'SOURCE /mount ICE/1.0\r\n\r\n' });
add({ name: 'ICE wrong method', type: REQ, input: 'GET /mount ICE/1.0\r\n\r\n' });
add({ name: 'PRI preface', split: true, type: REQ, input: 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n' });
add({ name: 'PRI bad preface', type: REQ, input: 'PRI * HTTP/2.0\r\n\r\nXX' });
add({ name: 'two spaces before url', type: REQ, input: 'GET  /x HTTP/1.1\r\n\r\n' });
add({ name: 'two spaces before version', type: REQ, input: 'GET /x  HTTP/1.1\r\n\r\n' });
add({ name: 'no space after method', type: REQ, input: 'GET\t/ HTTP/1.1\r\n\r\n' });
add({ name: 'tab in url', type: REQ, input: 'GET /a\tb HTTP/1.1\r\n\r\n' });
add({ name: 'high byte in url', type: REQ, input: 'GET /caf\xe9 HTTP/1.1\r\n\r\n' });
add({ name: 'bad char in query', type: REQ, input: 'GET /a?b\x7f HTTP/1.1\r\n\r\n' });
add({ name: 'double @', type: REQ, input: 'GET http://a@b@c/ HTTP/1.1\r\n\r\n' });
add({ name: 'bad schema', type: REQ, input: 'GET ht1p://x/ HTTP/1.1\r\n\r\n' });
add({ name: 'bad schema delim', type: REQ, input: 'GET http:/x HTTP/1.1\r\n\r\n' });
add({ name: 'bad url start', type: REQ, input: 'GET %2F HTTP/1.1\r\n\r\n' });
add({ name: 'url with space start', type: REQ, input: 'GET \r\n\r\n' });
add({ name: 'HTTP/0.9', split: true, type: REQ, input: 'GET /\r\n\r\n' });
add({ name: 'HTTP/0.9 LF', type: REQ, input: 'GET /\n\r\n' });
add({ name: 'url then CR without LF', type: REQ, input: 'GET /\rX' });
add({ name: 'invalid version', type: REQ, input: 'GET / HTTP/1.2\r\n\r\n' });
add({ name: 'invalid version lenient', type: REQ, lenient: L.kLenientVersion, input: 'GET / HTTP/1.2\r\n\r\n' });
add({ name: 'HTTP/2.0 request', type: REQ, input: 'GET / HTTP/2.0\r\n\r\n' });
add({ name: 'bad protocol', type: REQ, input: 'GET / HTXP/1.1\r\n\r\n' });
add({ name: 'missing dot', type: REQ, input: 'GET / HTTP/1-1\r\n\r\n' });
add({ name: 'bad major', type: REQ, input: 'GET / HTTP/x.1\r\n\r\n' });
add({ name: 'garbage after version', type: REQ, input: 'GET / HTTP/1.1x\r\n\r\n' });
add({ name: 'CL duplicate', type: REQ, input: 'POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na' });
add({ name: 'CL invalid', type: REQ, input: 'POST / HTTP/1.1\r\nContent-Length: 1a\r\n\r\na' });
add({ name: 'CL empty', type: REQ, input: 'POST / HTTP/1.1\r\nContent-Length:\r\n\r\n' });
add({ name: 'CL spaces', type: REQ, input: 'POST / HTTP/1.1\r\nContent-Length:  3  \r\n\r\nabc' });
add({ name: 'CL max', type: REQ, input: 'POST / HTTP/1.1\r\nContent-Length: 18446744073709551615\r\n\r\nabc' });
add({ name: 'CL overflow', split: true, type: REQ, input: 'POST / HTTP/1.1\r\nContent-Length: 18446744073709551616\r\n\r\nabc' });
add({ name: 'CL zero', type: REQ, input: 'POST / HTTP/1.1\r\nContent-Length: 0\r\n\r\nGET / HTTP/1.1\r\n\r\n' });
add({ name: 'CL with TE', type: REQ, input: 'POST / HTTP/1.1\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n' });
add({ name: 'TE with CL', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n3\r\nabc\r\n0\r\n\r\n' });
add({ name: 'TE with CL lenient', type: REQ, lenient: L.kLenientChunkedLength, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n3\r\nabc\r\n0\r\n\r\n' });
add({ name: 'TE gzip, chunked', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n' });
add({ name: 'TE chunked, gzip request', split: true, type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked, gzip\r\n\r\n' });
add({ name: 'TE chunked twice', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n' });
add({ name: 'TE identity request', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: identity\r\n\r\nabc' });
add({ name: 'TE identity request lenient', type: REQ, lenient: L.kLenientTransferEncoding, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: identity\r\n\r\nabc' });
add({ name: 'TE CHUNKED uppercase', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: CHUNKED\r\n\r\n1\r\nz\r\n0\r\n\r\n' });
add({ name: 'TE chunkedx', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunkedx\r\n\r\n' });
add({ name: 'chunk size invalid', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n' });
add({ name: 'chunk size overflow', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n10000000000000000\r\n' });
add({ name: 'chunk size space', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3 \r\nabc\r\n0\r\n\r\n' });
add({ name: 'chunk size space lenient', type: REQ, lenient: L.kLenientSpacesAfterChunkSize, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3 \r\nabc\r\n0\r\n\r\n' });
add({ name: 'chunk missing CRLF', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabcX\r\n0\r\n\r\n' });
add({ name: 'chunk missing CRLF lenient', split: true, type: REQ, lenient: L.kLenientOptionalCRLFAfterChunk, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc3\r\ndef\r\n0\r\n\r\n' });
add({ name: 'chunk LF only', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\nabc\n0\n\n' });
add({ name: 'chunk LF only lenient', split: true, type: REQ, lenient: ALL, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\nabc\n0\n\n' });
add({ name: 'chunk ext bad', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3; a=b\r\nabc\r\n0\r\n\r\n' });
add({ name: 'chunk ext bad name char', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;a@=b\r\nabc\r\n0\r\n\r\n' });
add({ name: 'chunk ext bad value char', split: true, type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;a=b c\r\nabc\r\n0\r\n\r\n' });
add({ name: 'chunk ext quoted bad', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;a="b\x01"\r\nabc\r\n0\r\n\r\n' });
add({ name: 'chunk ext quoted then junk', split: true, type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;a="b"x\r\nabc\r\n0\r\n\r\n' });
add({ name: 'chunk ext name only', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;a;b=c\r\nabc\r\n0;last\r\n\r\n', split: true });
add({ name: 'chunk extensions overflow', type: REQ, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;a=' + 'x'.repeat(17000) + '\r\nabc\r\n0\r\n\r\n' });
add({ name: 'header overflow', split: true, type: REQ, max: 100, input: 'GET / HTTP/1.1\r\nX-Long: ' + 'a'.repeat(200) + '\r\n\r\n' });
add({ name: 'header overflow in url', type: REQ, max: 50, input: 'GET /' + 'u'.repeat(100) + ' HTTP/1.1\r\n\r\n' });
add({ name: 'header overflow across chunks', type: REQ, max: 64, chunks: ['GET / HTTP/1.1\r\nX-A: ', 'a'.repeat(30), 'b'.repeat(30), '\r\n\r\n'] });
add({ name: 'header overflow exactly at limit', type: REQ, max: 40, input: 'GET / HTTP/1.1\r\nAB: 0123456789012345678901234\r\n\r\n' });
add({ name: 'header size default (16k)', type: REQ, input: 'GET / HTTP/1.1\r\nX: ' + 'v'.repeat(17000) + '\r\n\r\n' });
add({ name: 'trailers overflow', type: REQ, max: 60, input: 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\nT: ' + 't'.repeat(80) + '\r\n\r\n' });
add({ name: 'response bytes to request parser', type: REQ, input: 'HTTP/1.1 200 OK\r\n\r\n' });
add({ name: 'headers_complete returns 1 (skip body)', type: REQ, hc: 1, input: 'POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabcGET / HTTP/1.1\r\n\r\n' });
add({ name: 'headers_complete returns bad value', type: REQ, hc: 7, input: 'GET / HTTP/1.1\r\n\r\n' });
add({ name: 'headers_complete returns true', type: REQ, hc: true, input: 'POST / HTTP/1.1\r\nContent-Length: 2\r\n\r\nxy' });

// --- responses
add({ name: 'simple 200', type: RES, input: 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello', split: true });
add({ name: '200 no reason', type: RES, input: 'HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n' });
add({ name: '200 empty reason', type: RES, input: 'HTTP/1.1 200 \r\nContent-Length: 0\r\n\r\n' });
add({ name: 'reason with spaces', type: RES, input: 'HTTP/1.1 404 Not  Found  \r\nContent-Length: 0\r\n\r\n' });
add({ name: 'read until EOF', type: RES, input: 'HTTP/1.1 200 OK\r\n\r\nsome body bytes', finish: true, split: true });
add({ name: 'read until EOF HTTP/1.0', type: RES, input: 'HTTP/1.0 200 OK\r\nServer: x\r\n\r\nbody', finish: true });
add({ name: 'chunked response', type: RES, input: 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n', split: true });
add({ name: 'chunked response with trailers', split: true, type: RES, input: 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X\r\n\r\n2\r\nhi\r\n0\r\nX: done\r\n\r\n', finish: true });
add({ name: 'TE gzip response (read to EOF)', type: RES, input: 'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\nbinarydata', finish: true });
add({ name: 'TE chunked, gzip response', type: RES, input: 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\n\r\nzz', finish: true });
add({ name: '204 no body', type: RES, input: 'HTTP/1.1 204 No Content\r\nContent-Length: 10\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx' });
add({ name: '304', type: RES, input: 'HTTP/1.1 304 Not Modified\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n' });
add({ name: '100 continue then 200', split: true, type: RES, input: 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok' });
add({ name: '103 early hints', type: RES, input: 'HTTP/1.1 103 Early Hints\r\nLink: </a>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n' });
add({ name: '101 switching', split: true, type: RES, input: 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n\x81\x00' });
add({ name: '101 without upgrade headers', type: RES, input: 'HTTP/1.1 101 Switching Protocols\r\n\r\nxx' });
add({ name: 'upgrade headers on 200', type: RES, input: 'HTTP/1.1 200 OK\r\nConnection: upgrade\r\nUpgrade: h2c\r\nContent-Length: 2\r\n\r\nok' });
add({ name: 'HEAD response (hc=1)', split: true, type: RES, hc: 1, input: 'HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nz' });
add({ name: 'HEAD response chunked (hc=1)', type: RES, hc: 1, input: 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' });
add({ name: 'response connection close', split: true, type: RES, input: 'HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nokEXTRA' });
add({ name: 'response keep-alive 1.0', type: RES, input: 'HTTP/1.0 200 OK\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\nokHTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n' });
add({ name: 'bad status', type: RES, input: 'HTTP/1.1 2x0 OK\r\n\r\n' });
add({ name: 'status 4 digits', type: RES, input: 'HTTP/1.1 2000 OK\r\n\r\n' });
add({ name: 'status LF only', type: RES, input: 'HTTP/1.1 200 OK\nContent-Length: 0\n\n' });
add({ name: 'status LF only lenient', split: true, type: RES, lenient: ALL, input: 'HTTP/1.1 200 OK\nContent-Length: 0\n\n' });
add({ name: 'status no reason LF lenient', type: RES, lenient: ALL, input: 'HTTP/1.1 200\nContent-Length: 0\n\n' });
add({ name: 'bad response protocol', type: RES, input: 'HTXP/1.1 200 OK\r\n\r\n' });
add({ name: 'request bytes to response parser', type: RES, input: 'GET / HTTP/1.1\r\n\r\n' });
add({ name: 'RTSP response', type: RES, input: 'RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 0\r\n\r\n' });
add({ name: 'ICE response', type: RES, input: 'ICE/1.0 200 OK\r\nContent-Length: 0\r\n\r\n' });
add({ name: 'response version 1.5', type: RES, input: 'HTTP/1.5 200 OK\r\n\r\n' });
add({ name: 'response version 1.5 lenient', type: RES, lenient: ALL, input: 'HTTP/1.5 200 OK\r\nContent-Length: 0\r\n\r\n' });
add({ name: 'no space after version', type: RES, input: 'HTTP/1.1200 OK\r\n\r\n' });
add({ name: 'response finish mid headers', type: RES, input: 'HTTP/1.1 200 OK\r\nContent-Le', finish: true });
add({ name: 'response finish mid body', type: RES, input: 'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc', finish: true });
add({ name: 'response finish after complete', type: RES, input: 'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc', finish: true });
add({ name: 'finish with nothing', type: REQ, input: '', finish: true });
add({ name: 'finish mid request', type: REQ, input: 'GET / HT', finish: true });
add({ name: 'execute after error', type: REQ, chunks: ['FOO / HTTP/1.1\r\n', 'GET / HTTP/1.1\r\n\r\n'], finish: true });
add({ name: 'empty chunks', type: REQ, chunks: ['', 'GET / HTTP/1.1\r\nHost: x', '', '\r\n\r\n', ''] });
add({ name: 'body split with empty chunks', type: REQ, chunks: ['POST / HTTP/1.1\r\nContent-Length: 4\r\n\r\n', '', 'ab', '', 'cd'] });
add({ name: 'lenient all mixed', split: true, type: REQ, lenient: ALL, input: 'GET / HTTP/1.1\r\nHost : x\r\nA: b\x01c\r\nConnection: close\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\n\r\n4 \nabcd\n0\n\nGARBAGE' });

// pause/resume
add({ name: 'pause then execute', type: REQ, ops: [['exec', 'GET /a HTTP/1.1\r\n\r\n'], ['pause'], ['exec', 'GET /b HTTP/1.1\r\n\r\n'], ['resume'], ['exec', 'GET /c HTTP/1.1\r\n\r\n']] });
add({ name: 'pause inside callback', type: REQ, pauseInHeadersComplete: true, ops: [['exec', 'GET /a HTTP/1.1\r\n\r\nGET /b HTTP/1.1\r\n\r\n'], ['exec', 'GET /c HTTP/1.1\r\n\r\n'], ['resume'], ['exec', 'GET /d HTTP/1.1\r\n\r\n']] });
add({ name: 'reinitialize', type: REQ, ops: [['exec', 'GET /a HTTP/1.1\r\nHost: x'], ['init', RES], ['exec', 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n']] });
add({ name: 'upgrade then continue', type: REQ, ops: [['exec', 'GET / HTTP/1.1\r\nConnection: upgrade\r\nUpgrade: x\r\n\r\nAB'], ['exec', 'GET /next HTTP/1.1\r\n\r\n']] });
add({ name: 'callback throws in body', type: REQ, throwIn: 'body', ops: [['exec', 'POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'], ['exec', 'GET / HTTP/1.1\r\n\r\n']] });
add({ name: 'callback throws in headers complete', type: REQ, throwIn: 'hc', ops: [['exec', 'GET / HTTP/1.1\r\n\r\n'], ['exec', 'GET / HTTP/1.1\r\n\r\n']] });
add({ name: 'callback throws in message complete', type: REQ, throwIn: 'mc', ops: [['exec', 'GET / HTTP/1.1\r\n\r\n'], ['exec', 'GET / HTTP/1.1\r\n\r\n']] });
add({ name: 'callback throws in headers', type: REQ, throwIn: 'headers', ops: [['exec', 'GET / HTTP/1.1\r\n' + Array.from({ length: 40 }, (_, i) => `H${i}: ${i}\r\n`).join('') + '\r\n']] });
add({ name: 'no callbacks set', type: REQ, noCallbacks: true, input: 'POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc' });

// ---------------------------------------------------------------------------
// the harness (mirrored in test/unit/bindings-http_parser.test.ts)

const latin1 = (b) => Buffer.from(b).toString('latin1');
const bytes = (s) => Buffer.from(s, 'latin1');

function describeResult(r, lingering) {
  if (r instanceof Error) {
    const o = { error: { code: r.code, reason: r.reason, message: r.message } };
    if (!lingering) o.error.bytesParsed = r.bytesParsed;
    return o;
  }
  return { value: r === undefined ? null : r };
}

function runCase(c) {
  const events = [];
  const parser = new HTTPParser();
  let errored = false;
  if (!c.noCallbacks) {
    parser[HTTPParser.kOnHeaders] = function (headers, url) {
      events.push(['headers', headers, url]);
      if (c.throwIn === 'headers') throw new Error('boom headers');
    };
    parser[HTTPParser.kOnHeadersComplete] = function (major, minor, headers, method, url, statusCode, statusMessage, upgrade, keepAlive) {
      events.push(['hc', major, minor, headers ?? null, method ?? null, url ?? null, statusCode ?? null, statusMessage ?? null, upgrade, keepAlive]);
      if (c.throwIn === 'hc') throw new Error('boom hc');
      if (c.pauseInHeadersComplete) this.pause();
      return c.hc ?? 0;
    };
    parser[HTTPParser.kOnBody] = function (b) {
      events.push(['body', latin1(b), Buffer.isBuffer(b)]);
      if (c.throwIn === 'body') throw new Error('boom body');
    };
    parser[HTTPParser.kOnMessageComplete] = function () {
      events.push(['mc', this.getCurrentBuffer().length]);
      if (c.throwIn === 'mc') throw new Error('boom mc');
    };
  }
  const init = (type) => {
    parser.initialize(type, {}, c.max ?? 0, c.lenient ?? 0);
    errored = false;
  };
  init(c.type);
  const exec = (s) => {
    let r;
    try {
      r = parser.execute(bytes(s));
    } catch (e) {
      events.push(['throw', e.message]);
      errored = true; // the parser is left in an error state with a stale position
      return;
    }
    const d = describeResult(r, errored);
    // A lingering error after an upgrade returns error_pos - data of an old buffer: garbage.
    if (typeof d.value === 'number' && (d.value < 0 || d.value > s.length)) d.value = 'stale';
    events.push(['exec', d]);
    if (r instanceof Error) errored = true;
  };
  const ops = c.ops ?? [...(c.chunks ?? [c.input]).map((s) => ['exec', s]), ...(c.finish ? [['finish']] : [])];
  for (const op of ops) {
    if (op[0] === 'exec') exec(op[1]);
    else if (op[0] === 'finish') {
      let r;
      try {
        r = parser.finish();
      } catch (e) {
        events.push(['throw', e.message]);
        continue;
      }
      // bytesParsed of a finish() error is not meaningful (pointer arithmetic on NULL)
      events.push(['finish', describeResult(r, true)]);
    } else if (op[0] === 'pause') {
      parser.pause();
      errored = true; // the next execute reports a lingering error
    } else if (op[0] === 'resume') {
      parser.resume();
    } else if (op[0] === 'init') {
      init(op[1]);
    }
  }
  if (c.pauseInHeadersComplete) {
    // the pause from inside the callback makes the *next* execute report HPE_PAUSED with no position
    for (const e of events) if (e[0] === 'exec' && e[1].error?.code === 'HPE_PAUSED') delete e[1].error.bytesParsed;
  }
  parser.close();
  return events;
}

// Expand "split" cases: every 2-way split, plus byte-by-byte.
const out = [];
for (const c of cases) {
  const { split, ...base } = c;
  out.push({ ...base, events: runCase(base) });
  if (split) {
    const input = c.input;
    for (let i = 1; i < input.length; i++) {
      const sc = { ...base, name: `${c.name} [split ${i}]`, input: undefined, chunks: [input.slice(0, i), input.slice(i)] };
      out.push({ ...sc, events: runCase(sc) });
    }
    const bc = { ...base, name: `${c.name} [bytewise]`, input: undefined, chunks: input.split('') };
    out.push({ ...bc, events: runCase(bc) });
  }
}

// ConnectionsList membership through a message's life
function connectionsScenario() {
  const list = new ConnectionsList();
  const a = new HTTPParser();
  const b = new HTTPParser();
  const snap = (label) => ({ label, all: list.all().map((p) => p.tag), idle: list.idle().map((p) => p.tag), active: list.active().map((p) => p.tag) });
  a.tag = 'a';
  b.tag = 'b';
  const steps = [];
  steps.push(snap('empty'));
  a.initialize(REQ, {}, 0, 0, list);
  steps.push(snap('a initialized'));
  b.initialize(REQ, {}, 0, 0, list);
  steps.push(snap('b initialized'));
  a.execute(bytes('GET / HTTP/1.1\r\n\r\n'));
  steps.push(snap('a complete'));
  b.execute(bytes('GET / HTTP/1.1\r\nHost'));
  steps.push(snap('b mid headers'));
  a.execute(bytes('GET /2 HTTP/1.1\r\n'));
  steps.push(snap('a second started'));
  steps.push({ label: 'expired 0 0', expired: list.expired(0, 0).map((p) => p.tag) });
  steps.push({ label: 'expired big', expired: list.expired(1e9, 1e9).map((p) => p.tag) });
  b.remove();
  steps.push(snap('b removed'));
  a.remove();
  steps.push(snap('a removed'));
  return steps;
}

const fixtures = {
  node: process.version,
  methods,
  allMethods,
  constants: Object.fromEntries(Object.keys(HTTPParser).map((k) => [k, HTTPParser[k]])),
  proto: Object.getOwnPropertyNames(HTTPParser.prototype).sort(),
  connections: connectionsScenario(),
  cases: out,
};

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '../unit/fixtures/http_parser.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(fixtures));
console.log(`${out.length} cases written to ${file}`);
