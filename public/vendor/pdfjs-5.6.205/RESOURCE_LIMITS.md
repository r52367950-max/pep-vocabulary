# Local resource-budget patch

The upstream PDF.js version and Apache licence notices remain 5.6.205. These
vendored files include local import protections and must not be replaced without
reapplying and testing this patch:

- `pdf.mjs` forwards `maxDecodedStreamBytes` and `maxDecodedDocumentBytes`.
- `pdf.worker.mjs` uses `resource-budget.mjs` at decoded-buffer growth,
  synchronous Brotli output/ring-buffer growth, direct CCITT
  allocation, JPEG coefficients/output, JBIG2 bitmap allocation, JPX codestream
  dimensions, and image-codec output/heap growth.
- Native JPEG frames and the main PDF image/mask typed-array and canvas backing
  allocations also count towards the cumulative budget.
- `wasm/openjpeg_nowasm_fallback.js` applies the same checks to its fixed heaps,
  heap growth and output arrays.

The application creates a fresh module Worker for each PDF and supplies a 64 MiB
single allocation/decoded-stream ceiling and 256 MiB cumulative allocation
budget. The budget conservatively includes replacement buffers and copies; it
does not subtract memory on page cleanup or assume immediate garbage collection.
The application additionally streams text and caps all pages together at 24,000
items, 120,000 raw characters, 512 distinct styles and 6,000 English words before
retaining further chunks. Normalized imported text remains limited to 60,000
characters. A resource failure remains latched and is checked before successful
document/text/operator-list completion. Since PDF.js can finish an operator list
while image decoding is still pending and turn a later failure into a null image,
the import also awaits `checkResourceBudget()` after rendering and before OCR,
and before accepting the final text. This barrier waits for tracked image tasks
and checks the failure latch, so recovery cannot silently accept a partial
document after exhaustion. Cancellation terminates the actual Worker
without waiting for a busy synchronous decoder to process a message.

Budgeted documents deliberately use the checked JS Flate/Brotli decoders rather
than `DecompressionStream`. Counting native output chunks after reading does not
prove that a native implementation avoids allocating very large internal output
from a compressed input write. This changes a decoding optimization, not supported
PDF formats; ordinary text and scanned PDFs still follow their existing paths.

This is an allocation budget for the patched paths, not a proof that total process
memory is bounded by 256 MiB. Compressed input, JavaScript object/string overhead,
browser-native image decoding, canvas/OCR allocations and fixed initial WASM
heaps have separate lifetimes and existing limits. Codec-specific temporary
objects and malformed-format CPU behaviour are not comprehensively measured.
Ordinary text and scanned-PDF rendering/OCR must remain covered by real browser
controls; unusually large legitimate PDFs may be rejected and require fewer pages.

Regression tests: `tests/pdf-resource-limits.test.mjs` exercises the shipped parser
with small compressed samples and small budgets, guarded Flate and synchronous
Brotli paths, direct CCITT/JPEG allocation checks, native-frame accounting,
detached-image failure, streamed-text budgets and abort.
Do not test these limits by exhausting the host with very large samples.
