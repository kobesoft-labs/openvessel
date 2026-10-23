/* Thin exports over brotli's streaming API for ../brotli.ts.
 * Stream buffers are passed through ov_io(): [avail_in, next_in, avail_out, next_out]. */

#include <stddef.h>
#include <stdint.h>
#include <brotli/decode.h>
#include <brotli/encode.h>

size_t *ov_io(void);

#define EXPORT(name) __attribute__((export_name(#name)))

EXPORT(enc_create) void *enc_create(void) { return BrotliEncoderCreateInstance(NULL, NULL, NULL); }
EXPORT(enc_destroy) void enc_destroy(void *s) { BrotliEncoderDestroyInstance((BrotliEncoderState *)s); }
EXPORT(enc_set) int enc_set(void *s, int key, uint32_t value) {
  return BrotliEncoderSetParameter((BrotliEncoderState *)s, (BrotliEncoderParameter)key, value);
}
EXPORT(enc_stream) int enc_stream(void *s, int op) {
  size_t *io = ov_io();
  const uint8_t *next_in = (const uint8_t *)io[1];
  uint8_t *next_out = (uint8_t *)io[3];
  int r = BrotliEncoderCompressStream((BrotliEncoderState *)s, (BrotliEncoderOperation)op, &io[0], &next_in, &io[2],
                                      &next_out, NULL);
  io[1] = (size_t)next_in;
  io[3] = (size_t)next_out;
  return r;
}

EXPORT(dec_create) void *dec_create(void) { return BrotliDecoderCreateInstance(NULL, NULL, NULL); }
EXPORT(dec_destroy) void dec_destroy(void *s) { BrotliDecoderDestroyInstance((BrotliDecoderState *)s); }
EXPORT(dec_set) int dec_set(void *s, int key, uint32_t value) {
  return BrotliDecoderSetParameter((BrotliDecoderState *)s, (BrotliDecoderParameter)key, value);
}
EXPORT(dec_stream) int dec_stream(void *s) {
  size_t *io = ov_io();
  const uint8_t *next_in = (const uint8_t *)io[1];
  uint8_t *next_out = (uint8_t *)io[3];
  int r = BrotliDecoderDecompressStream((BrotliDecoderState *)s, &io[0], &next_in, &io[2], &next_out, NULL);
  io[1] = (size_t)next_in;
  io[3] = (size_t)next_out;
  return r;
}
EXPORT(dec_error_code) int dec_error_code(void *s) { return BrotliDecoderGetErrorCode((BrotliDecoderState *)s); }
EXPORT(dec_error_string) const char *dec_error_string(int code) {
  return BrotliDecoderErrorString((BrotliDecoderErrorCode)code);
}
