/* Minimal libc for the freestanding wasm32 build of brotli and zstd (see ../build.sh).
 * stdlib.h, string.h, math.h, ... in this directory all include this header. */
#ifndef OV_LIBC_H
#define OV_LIBC_H
#include <stddef.h>

void *malloc(size_t n);
void *calloc(size_t n, size_t m);
void *realloc(void *p, size_t n);
void free(void *p);
void abort(void) __attribute__((noreturn));
void exit(int code) __attribute__((noreturn));
#define EXIT_FAILURE 1
#define EXIT_SUCCESS 0

void *memcpy(void *d, const void *s, size_t n);
void *memmove(void *d, const void *s, size_t n);
void *memset(void *d, int c, size_t n);
int memcmp(const void *a, const void *b, size_t n);
size_t strlen(const char *s);

/* Imported from JS (Math.log2 / Math.log), so the encoder's cost model matches a regular libm. */
__attribute__((import_module("env"), import_name("log2"))) double log2(double x);
__attribute__((import_module("env"), import_name("log"))) double log(double x);

#define HUGE_VAL __builtin_huge_val()

#define assert(x) ((void)0)

typedef struct OV_FILE FILE;

#endif
