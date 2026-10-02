// Local PDF.js import hardening. See RESOURCE_LIMITS.md before replacing vendor files.
export class PdfResourceLimitError extends Error {
  constructor() {
    super("PDF resource limit exceeded; select fewer pages or a smaller document.");
    this.name = "PdfResourceLimitError";
  }
}

class PdfResourceBudget {
  constructor(options = {}) {
    this.streamLimit = options.maxDecodedStreamBytes ?? Infinity;
    this.documentLimit = options.maxDecodedDocumentBytes ?? Infinity;
    this.allocated = 0;
    this.failure = null;
    this.pending = new Set();
  }
  check() {
    if (this.failure) throw this.failure;
  }
  fail() {
    this.failure ??= new PdfResourceLimitError();
    throw this.failure;
  }
  checkSize(size) {
    this.check();
    if (!Number.isSafeInteger(size) || size < 0 || size > this.streamLimit) this.fail();
  }
  reserve(size) {
    this.checkSize(size);
    // Count allocations conservatively, including replacements and copies. No
    // optimistic credit is given for buffers whose collection cannot be observed.
    if (size > this.documentLimit - this.allocated) this.fail();
    this.allocated += size;
    return size;
  }
  image(width, height, components = 1) {
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 || !Number.isSafeInteger(components) || components <= 0) this.fail();
    this.checkSize(width * height * components);
  }
  track(operation) {
    this.pending.add(operation);
    const done = () => this.pending.delete(operation);
    // Observe both outcomes without creating an unhandled rejected finally chain.
    void operation.then(done, done);
  }
  async waitForPending() {
    this.check();
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
      this.check();
    }
  }
}

let current = new PdfResourceBudget();
export function configurePdfResourceBudget(options = {}) {
  for (const key of ["maxDecodedStreamBytes", "maxDecodedDocumentBytes"]) {
    if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key] <= 0)) throw new TypeError(`Invalid ${key}`);
  }
  current = new PdfResourceBudget(options);
  return current;
}
export function pdfResourceBudget() { return current; }
export function checkedPdfAllocation(size) { return current.reserve(size); }
