/* Thin exports over zstd's streaming API for ../zstd.ts.
 * ov_io() holds a ZSTD_inBuffer {src, size, pos} followed by a ZSTD_outBuffer {dst, size, pos}. */

#include <stddef.h>
#include <stdint.h>
#include "zstd.h"
#include "zstd_errors.h"

size_t *ov_io(void);

#define EXPORT(name) __attribute__((export_name(#name)))

EXPORT(zc_create) void *zc_create(void) { return ZSTD_createCCtx(); }
EXPORT(zc_free) void zc_free(void *c) { ZSTD_freeCCtx((ZSTD_CCtx *)c); }
EXPORT(zc_load_dict) size_t zc_load_dict(void *c, const void *p, size_t n) {
  return ZSTD_CCtx_loadDictionary((ZSTD_CCtx *)c, p, n);
}
EXPORT(zc_pledge) size_t zc_pledge(void *c, unsigned long long n) {
  return ZSTD_CCtx_setPledgedSrcSize((ZSTD_CCtx *)c, n);
}
EXPORT(zc_set) size_t zc_set(void *c, int key, int value) {
  return ZSTD_CCtx_setParameter((ZSTD_CCtx *)c, (ZSTD_cParameter)key, value);
}
EXPORT(zc_stream) size_t zc_stream(void *c, int end) {
  size_t *io = ov_io();
  return ZSTD_compressStream2((ZSTD_CCtx *)c, (ZSTD_outBuffer *)&io[3], (ZSTD_inBuffer *)&io[0],
                              (ZSTD_EndDirective)end);
}

EXPORT(zd_create) void *zd_create(void) { return ZSTD_createDCtx(); }
EXPORT(zd_free) void zd_free(void *d) { ZSTD_freeDCtx((ZSTD_DCtx *)d); }
EXPORT(zd_load_dict) size_t zd_load_dict(void *d, const void *p, size_t n) {
  return ZSTD_DCtx_loadDictionary((ZSTD_DCtx *)d, p, n);
}
EXPORT(zd_set) size_t zd_set(void *d, int key, int value) {
  return ZSTD_DCtx_setParameter((ZSTD_DCtx *)d, (ZSTD_dParameter)key, value);
}
EXPORT(zd_stream) size_t zd_stream(void *d) {
  size_t *io = ov_io();
  return ZSTD_decompressStream((ZSTD_DCtx *)d, (ZSTD_outBuffer *)&io[3], (ZSTD_inBuffer *)&io[0]);
}

EXPORT(z_is_error) unsigned z_is_error(size_t r) { return ZSTD_isError(r); }
EXPORT(z_error_code) int z_error_code(size_t r) { return (int)ZSTD_getErrorCode(r); }
EXPORT(z_error_string) const char *z_error_string(int code) { return ZSTD_getErrorString((ZSTD_ErrorCode)code); }
