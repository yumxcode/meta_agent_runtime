/**
 * ContextPager — type definitions
 *
 * The ContextPager manages a virtual knowledge space that is selectively
 * paged into the LLM prompt, mirroring Linux demand-paging:
 *
 *   PageSlot   ≈ memory page (unit of knowledge with a token cost)
 *   Manifest   ≈ /proc/meminfo (always-visible compact index, ~100 tokens)
 *   checkout() ≈ mmap() — bring a page into the active window
 *   checkin()  ≈ munmap() — explicitly release a page
 *   tick()     ≈ page-aging — decrement TTL, evict expired pages
 *   maxBudget  ≈ physical memory limit for the dynamic knowledge window
 */
export {};
//# sourceMappingURL=types.js.map