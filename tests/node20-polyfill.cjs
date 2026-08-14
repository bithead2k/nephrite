// jsdom 29 advertises Node 20+, while the development shell may still run
// Node 18. These accessors are feature probes only; jsdom does not resize the
// backing buffers in Nephrite's DOM tests.
for (const [prototype, property] of [
  [ArrayBuffer.prototype, "resizable"],
  [globalThis.SharedArrayBuffer?.prototype, "growable"],
]) {
  if (prototype && !Object.getOwnPropertyDescriptor(prototype, property)) {
    Object.defineProperty(prototype, property, { configurable: true, get: () => false });
  }
}

if (typeof globalThis.File === "undefined") {
  globalThis.File = class File extends Blob {
    constructor(parts = [], name = "", options = {}) {
      super(parts, options);
      this.name = String(name);
      this.lastModified = options.lastModified ?? Date.now();
    }
  };
}

if (!String.prototype.toWellFormed) {
  Object.defineProperty(String.prototype, "toWellFormed", {
    configurable: true,
    value() { return String(this).replace(/[\uD800-\uDFFF]/g, "\uFFFD"); },
  });
}
