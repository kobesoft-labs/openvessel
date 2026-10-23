/* Minimal libc for the wasm32 builds of brotli and zstd.
 *
 * Every compression stream gets its own WebAssembly instance (see ../wasm.ts), so the
 * allocator only has to be good enough for one stream's lifetime: power-of-two size classes
 * with per-class free lists. Freed blocks are reused by later allocations of the same class;
 * memory is returned to the JS GC when the instance is dropped. */

#include <stddef.h>
#include <stdint.h>
#include "include/ovlibc.h"

extern unsigned char __heap_base;

#define HDR 16u          /* keeps 16-byte alignment for the payload */
#define MIN_CLASS 5u     /* 32-byte blocks */
#define NCLASSES 32u

static uintptr_t heap_top;
static void *free_lists[NCLASSES];

static unsigned class_for(size_t n) {
  size_t need = n + HDR;
  unsigned c = MIN_CLASS;
  while (((size_t)1 << c) < need) {
    c++;
    if (c >= NCLASSES) return NCLASSES;
  }
  return c;
}

void *malloc(size_t n) {
  unsigned c = class_for(n);
  if (c >= NCLASSES) return NULL;
  void *blk = free_lists[c];
  if (blk) {
    free_lists[c] = *(void **)((unsigned char *)blk + HDR);
    return (unsigned char *)blk + HDR;
  }
  if (!heap_top) heap_top = ((uintptr_t)&__heap_base + 15u) & ~(uintptr_t)15u;
  size_t size = (size_t)1 << c;
  uintptr_t start = heap_top;
  uintptr_t end = start + size;
  if (end < start) return NULL;
  size_t have = __builtin_wasm_memory_size(0) * 65536u;
  if (end > have) {
    size_t pages = (end - have + 65535u) / 65536u;
    if (__builtin_wasm_memory_grow(0, pages) == (size_t)-1) return NULL;
  }
  heap_top = end;
  *(uint32_t *)start = c;
  return (unsigned char *)start + HDR;
}

void free(void *p) {
  if (!p) return;
  unsigned char *blk = (unsigned char *)p - HDR;
  unsigned c = *(uint32_t *)blk;
  *(void **)p = free_lists[c];
  free_lists[c] = blk;
}

void *calloc(size_t n, size_t m) {
  size_t t = n * m;
  if (m && t / m != n) return NULL;
  void *p = malloc(t);
  if (p) memset(p, 0, t);
  return p;
}

void *realloc(void *p, size_t n) {
  if (!p) return malloc(n);
  unsigned c = *(uint32_t *)((unsigned char *)p - HDR);
  size_t cap = ((size_t)1 << c) - HDR;
  if (n <= cap) return p;
  void *q = malloc(n);
  if (!q) return NULL;
  memcpy(q, p, cap);
  free(p);
  return q;
}

void abort(void) { __builtin_trap(); }
void exit(int code) {
  (void)code;
  __builtin_trap();
}

/* With -mbulk-memory these builtins lower to memory.copy / memory.fill. */
void *memcpy(void *d, const void *s, size_t n) {
  __builtin_memmove(d, s, n);
  return d;
}
void *memmove(void *d, const void *s, size_t n) {
  __builtin_memmove(d, s, n);
  return d;
}
void *memset(void *d, int c, size_t n) {
  __builtin_memset(d, c, n);
  return d;
}
int memcmp(const void *a, const void *b, size_t n) {
  const unsigned char *x = a, *y = b;
  for (size_t i = 0; i < n; i++)
    if (x[i] != y[i]) return x[i] - y[i];
  return 0;
}
size_t strlen(const char *s) {
  size_t n = 0;
  while (s[n]) n++;
  return n;
}

/* Scratch area shared with JS for passing sizes/pointers in and out. */
static size_t io_words[8];
size_t *ov_io(void) { return io_words; }
