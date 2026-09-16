const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const element = () => ({ addEventListener() {}, classList: { add() {}, remove() {} }, value: "", hidden: false });
const elements = new Map();
const source = fs.readFileSync(require("node:path").join(__dirname, "../dist/app.js"), "utf8")
  .replace("  registerWebMcpTools();", "  globalThis.metadataTestApi = { parseTiff, detectAndParse, toDecimal };");
const sandbox = {
  document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
  window: { addEventListener() {} },
  TextDecoder,
  DataView,
  Uint8Array,
  Set,
  console
};
vm.runInNewContext(source, sandbox);
const api = sandbox.metadataTestApi;

const tiff = Buffer.alloc(512);
tiff.write("II", 0, "ascii");
tiff.writeUInt16LE(42, 2);
tiff.writeUInt32LE(8, 4);
function entry(offset, tag, type, count, value, inline = false) {
  tiff.writeUInt16LE(tag, offset);
  tiff.writeUInt16LE(type, offset + 2);
  tiff.writeUInt32LE(count, offset + 4);
  if (inline) tiff.write(value, offset + 8, "ascii");
  else tiff.writeUInt32LE(value, offset + 8);
}
tiff.writeUInt16LE(4, 8);
entry(10, 0x010f, 2, 6, 220);
entry(22, 0x0110, 2, 10, 230);
entry(34, 0x8769, 4, 1, 64);
entry(46, 0x8825, 4, 1, 100);
tiff.write("Apple\0", 220, "ascii");
tiff.write("iPhone 15\0", 230, "ascii");
tiff.writeUInt16LE(2, 64);
entry(66, 0x9003, 2, 20, 250);
entry(78, 0x9011, 2, 7, 275);
tiff.write("2026:09:16 08:15:30\0", 250, "ascii");
tiff.write("+05:30\0", 275, "ascii");
tiff.writeUInt16LE(4, 100);
entry(102, 0x0001, 2, 2, "N\0", true);
entry(114, 0x0002, 5, 3, 300);
entry(126, 0x0003, 2, 2, "E\0", true);
entry(138, 0x0004, 5, 3, 324);
[[6, 300], [55, 308], [12, 316], [79, 324], [51, 332], [36, 340]].forEach(([value, offset]) => {
  tiff.writeUInt32LE(value, offset);
  tiff.writeUInt32LE(1, offset + 4);
});

const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
const metadata = api.parseTiff(view, 0);
assert.equal(metadata.Make, "Apple");
assert.equal(metadata.Model, "iPhone 15");
assert.equal(metadata.DateTimeOriginal, "2026:09:16 08:15:30");
assert.equal(metadata.OffsetTimeOriginal, "+05:30");
assert.ok(Math.abs(api.toDecimal(metadata.GPSLatitude, metadata.GPSLatitudeRef) - 6.92) < 0.000001);
assert.ok(Math.abs(api.toDecimal(metadata.GPSLongitude, metadata.GPSLongitudeRef) - 79.86) < 0.000001);

const exif = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
const segmentHeader = Buffer.alloc(4);
segmentHeader[0] = 0xff;
segmentHeader[1] = 0xe1;
segmentHeader.writeUInt16BE(exif.length + 2, 2);
const frame = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x58, 0x03, 0x20, 0x01, 0x01, 0x11, 0x00]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), segmentHeader, exif, frame, Buffer.from([0xff, 0xd9])]);
const jpegBuffer = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength);
const parsed = api.detectAndParse(jpegBuffer, { type: "image/jpeg", name: "camera.jpg" });
assert.equal(parsed.format, "JPEG");
assert.equal(parsed.width, 800);
assert.equal(parsed.height, 600);
assert.equal(parsed.metadata.Model, "iPhone 15");
assert.deepEqual(Object.keys(api.parseTiff(new DataView(new ArrayBuffer(3)), 0)), []);
console.log("Metadata checks passed: JPEG EXIF, date, device, GPS, dimensions, and malformed input.");
