/** One origin-wide lock queue shared by independently captured tab operations. */
export function installPracticeLocks(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let queue = Promise.resolve();
  const manager = {
    request(name, callback) {
      if (name !== 'vocab-local-practice-storage-v1') throw new Error(`Unexpected lock ${name}`);
      const result = queue.then(() => callback({ name }));
      queue = result.catch(() => undefined);
      return result;
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: manager } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; });
  return manager;
}
