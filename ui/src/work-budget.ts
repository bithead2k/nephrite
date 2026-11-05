/** Allow input/paint between bounded batches without a timer delay per batch. */
export function workBudget(): () => Promise<void> | undefined {
  let deadline = 0;
  return () => {
    if (performance.now() < deadline) return undefined;
    return new Promise<void>(resolve => setTimeout(() => {
      deadline = performance.now() + 8;
      resolve();
    }, 0));
  };
}
