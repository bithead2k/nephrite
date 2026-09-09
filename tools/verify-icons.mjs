import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const repoRoot = resolve(import.meta.dirname, "..");
const roots = [
  join(repoRoot, "src-tauri", "icons"),
  join(repoRoot, "ui", "src", "assets", "icons"),
];
const extensions = new Set([".png", ".ico", ".icns"]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function iconFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return iconFiles(path);
    return extensions.has(extname(entry.name).toLowerCase()) ? [path] : [];
  });
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

function pngHasTransparency(buffer, offset) {
  let cursor = offset + pngSignature.length;
  let width;
  let height;
  let channels;
  let paletteAlpha = Buffer.alloc(256, 255);
  const imageData = [];

  while (cursor + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(cursor);
    const type = buffer.toString("ascii", cursor + 4, cursor + 8);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("truncated PNG chunk");

    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      const colorType = buffer[dataStart + 9];
      const interlace = buffer[dataStart + 12];
      if (bitDepth !== 8 || interlace !== 0 || ![3, 4, 6].includes(colorType)) {
        throw new Error(`unsupported PNG format (depth=${bitDepth}, color=${colorType}, interlace=${interlace})`);
      }
      channels = colorType === 6 ? 4 : colorType === 4 ? 2 : 0;
    } else if (type === "tRNS") {
      buffer.copy(paletteAlpha, 0, dataStart, dataEnd);
    } else if (type === "IDAT") {
      imageData.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    cursor = dataEnd + 4;
  }

  if (!width || !height || imageData.length === 0) throw new Error("incomplete PNG");
  const inflated = inflateSync(Buffer.concat(imageData));
  const pixelBytes = channels || 1;
  const stride = width * pixelBytes;
  if (inflated.length !== height * (stride + 1)) throw new Error("invalid PNG data length");
  let transparentPixels = 0;
  let visiblePixels = 0;
  let input = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input++];
    const current = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[input++];
      const left = x >= pixelBytes ? current[x - pixelBytes] : 0;
      const up = previous[x];
      const upperLeft = x >= pixelBytes ? previous[x - pixelBytes] : 0;
      if (filter === 0) current[x] = raw;
      else if (filter === 1) current[x] = (raw + left) & 255;
      else if (filter === 2) current[x] = (raw + up) & 255;
      else if (filter === 3) current[x] = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) current[x] = (raw + paeth(left, up, upperLeft)) & 255;
      else throw new Error(`unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x += 1) {
      const alpha = channels ? current[x * channels + channels - 1] : paletteAlpha[current[x]];
      if (alpha <= 8) transparentPixels += 1;
      if (alpha >= 128) visiblePixels += 1;
      if ((x === 0 || x === width - 1 || y === 0 || y === height - 1) && alpha > 8) {
        throw new Error("opaque pixels on background border");
      }
    }
    previous = current;
  }
  return transparentPixels / (width * height) >= 0.4 && visiblePixels / (width * height) >= 0.1;
}

const failures = [];
const files = [...roots.flatMap(iconFiles), join(repoRoot, "artwork", "nephrite-icon-source.png")];
for (const path of files) {
  const buffer = readFileSync(path);
  const frameOffsets = [];
  let offset = buffer.indexOf(pngSignature);
  while (offset !== -1) {
    frameOffsets.push(offset);
    offset = buffer.indexOf(pngSignature, offset + pngSignature.length);
  }
  if (frameOffsets.length === 0) {
    failures.push(`${relative(repoRoot, path)} contains no verifiable PNG frames`);
    continue;
  }
  for (const [index, frameOffset] of frameOffsets.entries()) {
    try {
      if (!pngHasTransparency(buffer, frameOffset)) {
        failures.push(`${relative(repoRoot, path)} frame ${index + 1} lacks sufficient transparent background or visible artwork`);
      }
    } catch (error) {
      failures.push(`${relative(repoRoot, path)} frame ${index + 1}: ${error.message}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Verified transparent backgrounds in ${files.length} Nephrite icon files on every embedded PNG frame.`);
