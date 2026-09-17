(function () {
  "use strict";

  const MAX_FILE_SIZE = 100 * 1024 * 1024;
  const AI_ENDPOINT = "https://photo-evidence-location-ai.edia--nfo.workers.dev/analyze";
  const els = {
    dropZone: document.getElementById("dropZone"),
    fileInput: document.getElementById("fileInput"),
    browseBtn: document.getElementById("browseBtn"),
    reportActions: document.getElementById("reportActions"),
    empty: document.getElementById("emptyState"),
    loading: document.getElementById("loadingState"),
    scanFileName: document.getElementById("scanFileName"),
    scanTitle: document.getElementById("scanTitle"),
    scanStatus: document.getElementById("scanStatus"),
    scanChecks: document.getElementById("scanChecks"),
    scanProgress: document.getElementById("scanProgress"),
    scanProgressFill: document.getElementById("scanProgressFill"),
    skipScanBtn: document.getElementById("skipScanBtn"),
    error: document.getElementById("errorState"),
    errorMessage: document.getElementById("errorMessage"),
    result: document.getElementById("resultState"),
    copyBtn: document.getElementById("copyBtn"),
    exportBtn: document.getElementById("exportBtn"),
    clearBtn: document.getElementById("clearBtn"),
    tryAgainBtn: document.getElementById("tryAgainBtn"),
    toast: document.getElementById("toast")
  };

  let currentReport = null;
  let currentFile = null;
  let currentObjectUrl = null;
  let toastTimer = null;
  let inspectionId = 0;
  let scanAnimation = null;

  const tagNames = {
    0x010f: "Make",
    0x0110: "Model",
    0x0112: "Orientation",
    0x0131: "Software",
    0x0132: "DateTime",
    0x013b: "Artist",
    0x829a: "ExposureTime",
    0x829d: "FNumber",
    0x8769: "ExifIFDPointer",
    0x8827: "ISO",
    0x8825: "GPSIFDPointer",
    0x9003: "DateTimeOriginal",
    0x9004: "DateTimeDigitized",
    0x9011: "OffsetTimeOriginal",
    0x920a: "FocalLength",
    0xa002: "PixelXDimension",
    0xa003: "PixelYDimension",
    0xa433: "LensMake",
    0xa434: "LensModel"
  };

  const gpsTagNames = {
    0x0001: "GPSLatitudeRef",
    0x0002: "GPSLatitude",
    0x0003: "GPSLongitudeRef",
    0x0004: "GPSLongitude",
    0x0005: "GPSAltitudeRef",
    0x0006: "GPSAltitude",
    0x0007: "GPSTimeStamp",
    0x0010: "GPSImgDirectionRef",
    0x0011: "GPSImgDirection",
    0x001d: "GPSDateStamp"
  };

  const orientationNames = {
    1: "Normal",
    2: "Mirrored horizontally",
    3: "Rotated 180°",
    4: "Mirrored vertically",
    5: "Mirrored and rotated 90°",
    6: "Rotated 90° clockwise",
    7: "Mirrored and rotated 270°",
    8: "Rotated 90° counter-clockwise"
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function cleanText(value) {
    if (value === undefined || value === null) return null;
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    return text.replaceAll("\u0000", "").trim() || null;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "Unknown";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = units[0];
    for (let i = 1; value >= 1024 && i < units.length; i += 1) {
      value /= 1024;
      unit = units[i];
    }
    return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
  }

  function formatExifDate(value) {
    if (!value) return null;
    const raw = cleanText(value);
    const match = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(.*)$/);
    if (match) return `${match[1]}-${match[2]}-${match[3]} · ${match[4]}:${match[5]}:${match[6]}${match[7] || ""}`;
    const parsed = raw && new Date(raw);
    if (parsed && !Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(parsed);
    }
    return raw;
  }

  function formatFileDate(timestamp) {
    if (!timestamp) return "Unknown";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
  }

  function readAscii(view, start, length) {
    if (start < 0 || length < 0 || start + length > view.byteLength) return "";
    let out = "";
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(start + i));
    return out;
  }

  function getUint24LE(view, offset) {
    if (offset + 3 > view.byteLength) return 0;
    return view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  }

  function parseTiff(view, tiffStart) {
    const result = {};
    if (tiffStart < 0 || tiffStart + 8 > view.byteLength) return result;
    const byteOrder = view.getUint16(tiffStart, false);
    const little = byteOrder === 0x4949;
    if (!little && byteOrder !== 0x4d4d) return result;

    const safe16 = (offset) => offset >= 0 && offset + 2 <= view.byteLength ? view.getUint16(offset, little) : null;
    const safe32 = (offset) => offset >= 0 && offset + 4 <= view.byteLength ? view.getUint32(offset, little) : null;
    if (safe16(tiffStart + 2) !== 42) return result;

    const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };
    const visited = new Set();

    function readValue(entryOffset, type, count) {
      const unit = typeSize[type];
      if (!unit || !count || count > 100000) return null;
      const total = unit * count;
      const storedOffset = total <= 4 ? entryOffset + 8 : tiffStart + (safe32(entryOffset + 8) ?? -1);
      if (storedOffset < 0 || storedOffset + total > view.byteLength) return null;

      if (type === 2) return readAscii(view, storedOffset, count).replace(/\0+$/, "").trim();
      if (type === 7) return `[${count} bytes]`;

      const values = [];
      for (let i = 0; i < count; i += 1) {
        const offset = storedOffset + i * unit;
        let value = null;
        if (type === 1) value = view.getUint8(offset);
        else if (type === 3) value = view.getUint16(offset, little);
        else if (type === 4) value = view.getUint32(offset, little);
        else if (type === 5) {
          const numerator = view.getUint32(offset, little);
          const denominator = view.getUint32(offset + 4, little);
          value = denominator ? numerator / denominator : null;
        } else if (type === 9) value = view.getInt32(offset, little);
        else if (type === 10) {
          const numerator = view.getInt32(offset, little);
          const denominator = view.getInt32(offset + 4, little);
          value = denominator ? numerator / denominator : null;
        } else if (type === 11) value = view.getFloat32(offset, little);
        else if (type === 12) value = view.getFloat64(offset, little);
        values.push(value);
      }
      return count === 1 ? values[0] : values;
    }

    function readIfd(relativeOffset, kind) {
      if (!Number.isFinite(relativeOffset) || relativeOffset <= 0 || visited.has(`${kind}:${relativeOffset}`)) return;
      visited.add(`${kind}:${relativeOffset}`);
      const ifdOffset = tiffStart + relativeOffset;
      const count = safe16(ifdOffset);
      if (count === null || count > 1000 || ifdOffset + 2 + count * 12 > view.byteLength) return;
      const childPointers = [];

      for (let i = 0; i < count; i += 1) {
        const entry = ifdOffset + 2 + i * 12;
        const tag = safe16(entry);
        const type = safe16(entry + 2);
        const valueCount = safe32(entry + 4);
        if (tag === null || type === null || valueCount === null) continue;
        const value = readValue(entry, type, valueCount);
        if (value === null || value === "") continue;
        const name = kind === "gps" ? gpsTagNames[tag] : tagNames[tag];
        if (name) result[name] = value;
        if (tag === 0x8769 && Number.isFinite(value)) childPointers.push([value, "exif"]);
        if (tag === 0x8825 && Number.isFinite(value)) childPointers.push([value, "gps"]);
      }
      childPointers.forEach(([offset, childKind]) => readIfd(offset, childKind));
    }

    const firstIfd = safe32(tiffStart + 4);
    if (firstIfd !== null) readIfd(firstIfd, "root");
    return result;
  }

  function parseExifPayload(view, start, length) {
    if (length <= 0 || start < 0 || start >= view.byteLength) return {};
    const signature = readAscii(view, start, Math.min(6, length));
    if (signature === "Exif\u0000\u0000") return parseTiff(view, start + 6);
    return parseTiff(view, start);
  }

  function mergeMissing(target, source) {
    Object.entries(source || {}).forEach(([key, value]) => {
      if ((target[key] === undefined || target[key] === null || target[key] === "") && value !== undefined && value !== null && value !== "") {
        target[key] = value;
      }
    });
    return target;
  }

  function parseJpeg(view) {
    const result = { format: "JPEG", metadata: {}, width: null, height: null };
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) { offset += 1; continue; }
      let marker = view.getUint8(offset + 1);
      while (marker === 0xff && offset + 2 < view.byteLength) { offset += 1; marker = view.getUint8(offset + 1); }
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2, false);
      if (length < 2 || offset + 2 + length > view.byteLength) break;
      const dataStart = offset + 4;
      const dataLength = length - 2;

      if (marker === 0xe1) mergeMissing(result.metadata, parseExifPayload(view, dataStart, dataLength));
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && dataLength >= 5) {
        result.height = view.getUint16(dataStart + 1, false);
        result.width = view.getUint16(dataStart + 3, false);
      }
      offset += 2 + length;
    }
    return result;
  }

  function parsePng(view) {
    const result = { format: "PNG", metadata: {}, width: null, height: null };
    let offset = 8;
    while (offset + 12 <= view.byteLength) {
      const length = view.getUint32(offset, false);
      const type = readAscii(view, offset + 4, 4);
      const dataStart = offset + 8;
      if (dataStart + length + 4 > view.byteLength) break;
      if (type === "IHDR" && length >= 8) {
        result.width = view.getUint32(dataStart, false);
        result.height = view.getUint32(dataStart + 4, false);
      } else if (type === "eXIf") {
        mergeMissing(result.metadata, parseExifPayload(view, dataStart, length));
      }
      offset = dataStart + length + 4;
      if (type === "IEND") break;
    }
    return result;
  }

  function parseWebp(view) {
    const result = { format: "WebP", metadata: {}, width: null, height: null };
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const type = readAscii(view, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      if (dataStart + length > view.byteLength) break;
      if (type === "VP8X" && length >= 10) {
        result.width = getUint24LE(view, dataStart + 4) + 1;
        result.height = getUint24LE(view, dataStart + 7) + 1;
      } else if (type === "VP8 " && length >= 10 && readAscii(view, dataStart + 3, 3) === "\u009d\u0001\u002a") {
        result.width = view.getUint16(dataStart + 6, true) & 0x3fff;
        result.height = view.getUint16(dataStart + 8, true) & 0x3fff;
      } else if (type === "VP8L" && length >= 5 && view.getUint8(dataStart) === 0x2f) {
        const bits = view.getUint32(dataStart + 1, true);
        result.width = (bits & 0x3fff) + 1;
        result.height = ((bits >> 14) & 0x3fff) + 1;
      } else if (type === "EXIF") {
        mergeMissing(result.metadata, parseExifPayload(view, dataStart, length));
      }
      offset = dataStart + length + (length % 2);
    }
    return result;
  }

  function findEmbeddedExif(view) {
    const max = Math.min(view.byteLength - 10, 16 * 1024 * 1024);
    for (let i = 0; i < max; i += 1) {
      if (
        view.getUint8(i) === 0x45 && view.getUint8(i + 1) === 0x78 && view.getUint8(i + 2) === 0x69 &&
        view.getUint8(i + 3) === 0x66 && view.getUint8(i + 4) === 0 && view.getUint8(i + 5) === 0
      ) return parseTiff(view, i + 6);
    }
    return {};
  }

  function extractXmp(view) {
    const sampleLength = Math.min(view.byteLength, 12 * 1024 * 1024);
    let text = "";
    try { text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(view.buffer, view.byteOffset, sampleLength)); }
    catch { return {}; }

    function get(names) {
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const attr = text.match(new RegExp(`${escaped}=["']([^"']+)["']`, "i"));
        if (attr) return attr[1];
        const node = text.match(new RegExp(`<${escaped}[^>]*>([^<]+)</${escaped}>`, "i"));
        if (node) return node[1];
      }
      return null;
    }

    return {
      DateTimeOriginal: get(["exif:DateTimeOriginal", "photoshop:DateCreated"]),
      CreateDate: get(["xmp:CreateDate"]),
      Make: get(["tiff:Make"]),
      Model: get(["tiff:Model"]),
      Software: get(["xmp:CreatorTool"]),
      GPSLatitudeXmp: get(["exif:GPSLatitude"]),
      GPSLongitudeXmp: get(["exif:GPSLongitude"])
    };
  }

  function detectAndParse(buffer, file) {
    const view = new DataView(buffer);
    if (view.byteLength < 4) throw new Error("The file is too small to be a valid photo.");
    let parsed;
    if (view.getUint16(0, false) === 0xffd8) parsed = parseJpeg(view);
    else if (view.byteLength >= 8 && readAscii(view, 1, 3) === "PNG") parsed = parsePng(view);
    else if (readAscii(view, 0, 4) === "RIFF" && readAscii(view, 8, 4) === "WEBP") parsed = parseWebp(view);
    else if ([0x4949, 0x4d4d].includes(view.getUint16(0, false))) parsed = { format: "TIFF", metadata: parseTiff(view, 0), width: null, height: null };
    else if (/hei[cf]|avif/i.test(file.type) || /\.(heic|heif|avif)$/i.test(file.name)) parsed = { format: /avif/i.test(file.type + file.name) ? "AVIF" : "HEIC / HEIF", metadata: findEmbeddedExif(view), width: null, height: null };
    else parsed = { format: file.type ? file.type.replace("image/", "").toUpperCase() : "Image", metadata: findEmbeddedExif(view), width: null, height: null };

    mergeMissing(parsed.metadata, extractXmp(view));
    if (!Object.keys(parsed.metadata).length) mergeMissing(parsed.metadata, findEmbeddedExif(view));
    return parsed;
  }

  function toDecimal(dms, ref) {
    if (!Array.isArray(dms) || dms.length < 2) return null;
    const values = dms.map(Number);
    if (values.some((value) => !Number.isFinite(value))) return null;
    let decimal = values[0] + values[1] / 60 + (values[2] || 0) / 3600;
    if (["S", "W"].includes(String(ref || "").toUpperCase())) decimal *= -1;
    return decimal;
  }

  function parseXmpCoordinate(value, isLongitude) {
    if (!value) return null;
    const direct = Number(String(value).replace(/[^\d+\-.]/g, ""));
    if (/^-?\d+(\.\d+)?$/.test(String(value).trim()) && Number.isFinite(direct)) return direct;
    const match = String(value).trim().match(/(\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)(?:[, ]+(\d+(?:\.\d+)?))?\s*([NSEW])/i);
    if (!match) return null;
    const max = isLongitude ? 180 : 90;
    const decimal = Number(match[1]) + Number(match[2]) / 60 + Number(match[3] || 0) / 3600;
    return decimal <= max ? (["S", "W"].includes(match[4].toUpperCase()) ? -decimal : decimal) : null;
  }

  async function getImageDimensions(file) {
    if ("createImageBitmap" in window) {
      try {
        const bitmap = await createImageBitmap(file);
        const dimensions = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        return dimensions;
      } catch { /* Fall through to image decoding. */ }
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => { resolve({ width: image.naturalWidth, height: image.naturalHeight }); URL.revokeObjectURL(url); };
      image.onerror = () => { resolve({ width: null, height: null }); URL.revokeObjectURL(url); };
      image.src = url;
    });
  }

  async function sha256(buffer) {
    if (!window.crypto?.subtle) return null;
    try {
      const hash = await window.crypto.subtle.digest("SHA-256", buffer);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch { return null; }
  }

  function normalizeDevice(make, model) {
    const cleanMake = cleanText(make);
    const cleanModel = cleanText(model);
    if (!cleanMake && !cleanModel) return null;
    if (!cleanMake) return cleanModel;
    if (!cleanModel) return cleanMake;
    return cleanModel.toLowerCase().startsWith(cleanMake.toLowerCase()) ? cleanModel : `${cleanMake} ${cleanModel}`;
  }

  async function analyzePhoto(file) {
    if (!file) throw new Error("No photo was selected.");
    if (file.size > MAX_FILE_SIZE) throw new Error("This photo is larger than 100 MB. Choose a smaller copy.");
    if (!file.type.startsWith("image/") && !/\.(jpe?g|png|webp|tiff?|heic|heif|avif)$/i.test(file.name)) {
      throw new Error("Choose a JPG, PNG, WebP, TIFF, HEIC, or AVIF image.");
    }

    const buffer = await file.arrayBuffer();
    const parsed = detectAndParse(buffer, file);
    if (!parsed.width || !parsed.height) {
      const dimensions = await getImageDimensions(file);
      parsed.width ||= dimensions.width;
      parsed.height ||= dimensions.height;
    }

    const meta = parsed.metadata;
    const latitude = toDecimal(meta.GPSLatitude, meta.GPSLatitudeRef) ?? parseXmpCoordinate(meta.GPSLatitudeXmp, false);
    const longitude = toDecimal(meta.GPSLongitude, meta.GPSLongitudeRef) ?? parseXmpCoordinate(meta.GPSLongitudeXmp, true);
    const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
    const altitudeValue = Number(meta.GPSAltitude);
    const altitude = Number.isFinite(altitudeValue) ? (Number(meta.GPSAltitudeRef) === 1 ? -altitudeValue : altitudeValue) : null;
    const dateRaw = cleanText(meta.DateTimeOriginal);
    const timezoneOffset = cleanText(meta.OffsetTimeOriginal);
    const creationDateRaw = cleanText(meta.DateTimeDigitized || meta.CreateDate);
    const embeddedModifiedDateRaw = cleanText(meta.DateTime);
    const device = normalizeDevice(meta.Make, meta.Model);
    const lens = normalizeDevice(meta.LensMake, meta.LensModel);
    const whatsappLike = /(?:^|[_-])WA\d{3,}(?:[_-]|\.)|IMG[-_]\d{8}[-_]WA|WhatsApp Image/i.test(file.name);
    const evidenceCount = [dateRaw, hasCoordinates, device].filter(Boolean).length;
    const metadataKeys = Object.entries(meta).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([key]) => key);

    return {
      file: {
        name: file.name,
        size: file.size,
        mimeType: file.type || "Unknown",
        lastModified: file.lastModified,
        sha256: await sha256(buffer)
      },
      image: {
        format: parsed.format,
        width: parsed.width,
        height: parsed.height,
        megapixels: parsed.width && parsed.height ? (parsed.width * parsed.height / 1000000) : null,
        orientation: meta.Orientation ? orientationNames[Number(meta.Orientation)] || `Code ${meta.Orientation}` : null
      },
      capture: {
        dateRaw,
        dateDisplay: dateRaw ? `${formatExifDate(dateRaw)}${timezoneOffset ? ` ${timezoneOffset}` : ""}` : null,
        timezoneOffset,
        creationDateRaw,
        embeddedModifiedDateRaw,
        device,
        make: cleanText(meta.Make),
        model: cleanText(meta.Model),
        software: cleanText(meta.Software),
        lens,
        exposureTime: Number.isFinite(Number(meta.ExposureTime)) ? Number(meta.ExposureTime) : null,
        fNumber: Number.isFinite(Number(meta.FNumber)) ? Number(meta.FNumber) : null,
        iso: Number.isFinite(Number(meta.ISO)) ? Number(meta.ISO) : null,
        focalLength: Number.isFinite(Number(meta.FocalLength)) ? Number(meta.FocalLength) : null
      },
      location: {
        hasCoordinates,
        latitude: hasCoordinates ? latitude : null,
        longitude: hasCoordinates ? longitude : null,
        altitude,
        direction: Number.isFinite(Number(meta.GPSImgDirection)) ? Number(meta.GPSImgDirection) : null,
        gpsDate: cleanText(meta.GPSDateStamp),
        placeName: null
      },
      assessment: {
        evidenceCount,
        metadataFieldsFound: metadataKeys.length,
        whatsappLike,
        level: evidenceCount >= 2 ? "strong" : evidenceCount === 1 || metadataKeys.length ? "limited" : "none"
      }
    };
  }

  function evidenceCard(index, code, title, value, sub, extra = "") {
    return `
      <article class="evidence-card">
        <div class="card-index"><span>${escapeHtml(index)}</span><em>${escapeHtml(code)}</em></div>
        <h3>${escapeHtml(title)}</h3>
        <p class="evidence-value">${escapeHtml(value || "Not embedded")}</p>
        <span class="evidence-sub">${escapeHtml(sub)}</span>
        ${extra}
      </article>`;
  }

  function row(label, value) {
    if (value === null || value === undefined || value === "") return "";
    return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
  }

  function renderReport(report) {
    const { file, image, capture, location, assessment } = report;
    const dimensions = image.width && image.height ? `${image.width.toLocaleString()} × ${image.height.toLocaleString()}` : "Not decoded";
    const photoResolution = image.megapixels ? `${dimensions} · ${image.megapixels.toFixed(1)} MP` : dimensions;
    const coordinateText = location.hasCoordinates ? `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}` : null;
    const locationExtra = location.hasCoordinates ? `
      <div class="place-actions">
        <a class="mini-action" href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(location.latitude)}&mlon=${encodeURIComponent(location.longitude)}#map=16/${encodeURIComponent(location.latitude)}/${encodeURIComponent(location.longitude)}" target="_blank" rel="noopener noreferrer">OPEN MAP</a>
        <button id="lookupPlaceBtn" class="mini-action" type="button">FIND PLACE NAME</button>
      </div>
      <p id="placeResult" class="place-result">Place lookup sends only these coordinates to OpenStreetMap.</p>` : "";

    let statusTitle = "Camera metadata found";
    let statusText = `${assessment.evidenceCount} of the 3 key evidence groups are present in the file.`;
    let limitedClass = "";
    if (assessment.level === "limited") {
      statusTitle = "Only limited metadata was found";
      statusText = "Some useful details remain, but this file cannot answer every question.";
      limitedClass = " is-limited";
    } else if (assessment.level === "none") {
      statusTitle = "Camera metadata is missing";
      statusText = assessment.whatsappLike
        ? "The filename looks like a WhatsApp image. WhatsApp often removes capture details when photos are sent normally."
        : "The image may have been edited, exported, screenshotted, or shared through a service that removed its metadata.";
      limitedClass = " is-limited";
    }

    const cameraDetails = [
      row("Manufacturer", capture.make),
      row("Model", capture.model),
      row("Lens", capture.lens),
      row("Software", capture.software),
      row("Exposure", capture.exposureTime ? (capture.exposureTime < 1 ? `1/${Math.round(1 / capture.exposureTime)} sec` : `${capture.exposureTime} sec`) : null),
      row("Aperture", capture.fNumber ? `f/${capture.fNumber}` : null),
      row("ISO", capture.iso),
      row("Focal length", capture.focalLength ? `${capture.focalLength} mm` : null)
    ].join("") || row("Camera fields", "No camera settings embedded");

    const fileDetails = [
      row("File name", file.name),
      row("File type", file.mimeType),
      row("Image format", image.format),
      row("File size", formatBytes(file.size)),
      row("Dimensions", dimensions),
      row("Megapixels", image.megapixels ? image.megapixels.toFixed(2) : null),
      row("Orientation", image.orientation),
      row("Embedded created / digitized", formatExifDate(capture.creationDateRaw)),
      row("Embedded modified time", formatExifDate(capture.embeddedModifiedDateRaw)),
      row("File saved / modified", formatFileDate(file.lastModified)),
      row("Sharing filename clue", assessment.whatsappLike ? "Looks like a WhatsApp export; this is not proof of capture date or origin" : null),
      row("SHA-256 fingerprint", file.sha256 || "Unavailable")
    ].join("");

    const locationDetails = location.hasCoordinates ? [
      row("Latitude", location.latitude.toFixed(7)),
      row("Longitude", location.longitude.toFixed(7)),
      row("Altitude", Number.isFinite(location.altitude) ? `${location.altitude.toFixed(1)} m` : null),
      row("Camera direction", Number.isFinite(location.direction) ? `${location.direction.toFixed(1)}°` : null),
      row("GPS date", location.gpsDate)
    ].join("") : row("GPS", "No coordinates embedded");

    els.result.innerHTML = `
      <div class="file-hero">
        <div class="photo-preview"><img src="${escapeHtml(currentObjectUrl)}" alt="Preview of the selected photo" /></div>
        <div>
          <h3 class="file-title">${escapeHtml(file.name)}</h3>
          <div class="file-meta"><span>${escapeHtml(image.format)}</span><span>${escapeHtml(formatBytes(file.size))}</span><span>${escapeHtml(photoResolution)}</span></div>
        </div>
      </div>

      <div class="status-banner${limitedClass}">
        <span class="status-dot" aria-hidden="true"></span>
        <div><strong>${escapeHtml(statusTitle)}</strong><p>${escapeHtml(statusText)}</p></div>
      </div>

      <div class="evidence-grid">
        ${evidenceCard("01", "DATE", "Date taken", capture.dateDisplay, capture.dateDisplay ? "Embedded capture timestamp" : "No capture timestamp in the file")}
        ${evidenceCard("02", "GPS", "Taken location", coordinateText, coordinateText ? "Embedded GPS coordinates" : "Location was not included", locationExtra)}
        ${evidenceCard("03", "CAM", "Phone or camera", capture.device, capture.device ? "Embedded manufacturer / model" : "Device identity was not included")}
      </div>

      <section class="ai-location-card" aria-labelledby="ai-location-title">
        <div class="ai-location-heading"><div><span class="ai-kicker">OPTIONAL · VISUAL ANALYSIS</span><h3 id="ai-location-title">Estimate location from visible clues</h3></div><span class="ai-badge">AI ESTIMATE</span></div>
        <p class="ai-location-copy">If GPS was removed, AI can examine public landmarks, signs, language, roads, architecture and scenery. It cannot recover deleted GPS or reliably identify a phone model from pixels.</p>
        <div class="ai-privacy"><strong>Your choice:</strong> Clicking the button sends a resized, metadata-free JPEG to Cloudflare Workers AI. This app does not store the photo.</div>
        <button id="aiLocationBtn" class="secondary-button ai-location-button" type="button">Estimate from visible clues</button>
        <div id="aiLocationResult" class="ai-location-result" hidden></div>
      </section>

      <div class="detail-section">
        <details open>
          <summary>File and image details</summary>
          <table class="detail-table"><tbody>${fileDetails}</tbody></table>
        </details>
        <details>
          <summary>Camera settings</summary>
          <table class="detail-table"><tbody>${cameraDetails}</tbody></table>
        </details>
        <details>
          <summary>Location details</summary>
          <table class="detail-table"><tbody>${locationDetails}</tbody></table>
        </details>
      </div>

      <div class="integrity-note"><span aria-hidden="true">⚠</span><span><strong>Do not treat this as proof.</strong> Embedded metadata can be changed. Compare it with the visible image, message history, and original source when accuracy matters.</span></div>`;

    document.getElementById("lookupPlaceBtn")?.addEventListener("click", lookupPlaceName);
    document.getElementById("aiLocationBtn")?.addEventListener("click", analyzeVisualLocation);
    const preview = els.result.querySelector(".photo-preview img");
    if (preview) preview.addEventListener("error", () => {
      preview.parentElement.innerHTML = '<span class="preview-fallback">PREVIEW<br>UNAVAILABLE</span>';
    }, { once: true });
  }

  async function lookupPlaceName() {
    if (!currentReport?.location?.hasCoordinates) return;
    const button = document.getElementById("lookupPlaceBtn");
    const output = document.getElementById("placeResult");
    if (!button || !output) return;
    button.disabled = true;
    button.textContent = "LOOKING UP…";
    output.textContent = "Sending only the coordinates for a place-name lookup…";
    try {
      const { latitude, longitude } = currentReport.location;
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}&zoom=16&addressdetails=1`;
      const response = await fetch(url, { headers: { "Accept-Language": navigator.language || "en" } });
      if (!response.ok) throw new Error("Lookup unavailable");
      const data = await response.json();
      const place = cleanText(data.display_name);
      if (!place) throw new Error("No place name returned");
      currentReport.location.placeName = place;
      output.textContent = place;
      button.textContent = "PLACE FOUND";
    } catch {
      output.textContent = "Place-name lookup is unavailable. You can still open the coordinates on the map.";
      button.textContent = "TRY AGAIN";
      button.disabled = false;
    }
  }

  async function prepareAiImage(file) {
    let source;
    let cleanup = () => {};
    try {
      if ("createImageBitmap" in window) {
        source = await createImageBitmap(file);
        cleanup = () => source.close?.();
      } else {
        const objectUrl = URL.createObjectURL(file);
        cleanup = () => URL.revokeObjectURL(objectUrl);
        source = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("This browser cannot decode the photo for visual analysis."));
          image.src = objectUrl;
        });
        cleanup = () => URL.revokeObjectURL(objectUrl);
      }
      const sourceWidth = source.width || source.naturalWidth;
      const sourceHeight = source.height || source.naturalHeight;
      if (!sourceWidth || !sourceHeight) throw new Error("The photo dimensions could not be decoded.");
      const scale = Math.min(1, 1400 / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("The browser could not prepare the reduced image.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.78);
    } finally { cleanup(); }
  }

  function renderAiLocationResult(result) {
    const output = document.getElementById("aiLocationResult");
    if (!output) return;
    const placeParts = [result.likelyPlace, result.region, result.country].filter((value, index, items) => value && value !== "Unknown" && items.indexOf(value) === index);
    const place = placeParts.join(", ") || "Unable to estimate";
    const confidence = ["high", "medium", "low", "none"].includes(result.confidence) ? result.confidence : "low";
    const clues = Array.isArray(result.clues) && result.clues.length ? `<ul>${result.clues.map((clue) => `<li>${escapeHtml(clue)}</li>`).join("")}</ul>` : "<p>No reliable geographic clues were found.</p>";
    const alternatives = Array.isArray(result.alternatives) && result.alternatives.length ? `<div class="ai-alternatives"><strong>Other possibilities</strong>${result.alternatives.map((item) => `<p><span>${escapeHtml(item.place)}</span>${escapeHtml(item.reason)}</p>`).join("")}</div>` : "";
    const mapLink = result.mapQuery ? `<a class="mini-action" href="https://www.openstreetmap.org/search?query=${encodeURIComponent(result.mapQuery)}" target="_blank" rel="noopener noreferrer">SEARCH THIS AREA</a>` : "";
    output.hidden = false;
    output.className = "ai-location-result";
    output.innerHTML = `<div class="ai-result-top"><div><span>LIKELY AREA</span><strong>${escapeHtml(place)}</strong></div><span class="confidence confidence-${escapeHtml(confidence)}">${escapeHtml(confidence.toUpperCase())} CONFIDENCE</span></div><p class="ai-summary">${escapeHtml(result.summary)}</p><div class="ai-clues"><strong>Visible clues used</strong>${clues}</div>${alternatives}<div class="ai-result-actions">${mapLink}</div><p class="ai-limitation"><strong>Limitation:</strong> ${escapeHtml(result.limitations || "Visual geolocation is an estimate and may be wrong.")}</p>`;
  }

  async function analyzeVisualLocation() {
    if (!currentFile || !currentReport) return;
    const requestReport = currentReport;
    const requestFile = currentFile;
    const button = document.getElementById("aiLocationBtn");
    const output = document.getElementById("aiLocationResult");
    if (!button || !output) return;
    button.disabled = true;
    button.textContent = "PREPARING PRIVATE COPY…";
    output.hidden = false;
    output.className = "ai-location-result is-loading";
    output.textContent = "Creating a smaller JPEG and removing the original metadata…";
    try {
      const image = await prepareAiImage(requestFile);
      button.textContent = "ANALYZING VISIBLE CLUES…";
      output.textContent = "The reduced copy is being analyzed. This can take up to a minute…";
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 75000);
      let response;
      try { response = await fetch(AI_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }), signal: controller.signal }); }
      finally { clearTimeout(timeoutId); }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Visual analysis is unavailable.");
      if (!payload.result) throw new Error("The AI service returned no location result.");
      if (currentReport !== requestReport) return;
      requestReport.visualLocation = payload.result;
      renderAiLocationResult(payload.result);
      button.textContent = "ANALYZE AGAIN";
    } catch (error) {
      if (currentReport !== requestReport) return;
      output.hidden = false;
      output.className = "ai-location-result is-error";
      output.textContent = error?.name === "AbortError" ? "The visual analysis timed out. Please try again." : (error instanceof Error ? error.message : "Visual analysis failed. Please try again.");
      button.textContent = "TRY VISUAL ANALYSIS AGAIN";
    } finally { button.disabled = false; }
  }

  function showState(name, message = "") {
    els.empty.hidden = name !== "empty";
    els.loading.hidden = name !== "loading";
    els.error.hidden = name !== "error";
    els.result.hidden = name !== "result";
    els.reportActions.hidden = name !== "result";
    if (message) els.errorMessage.textContent = message;
    document.getElementById("reportPanel").setAttribute("aria-busy", String(name === "loading"));
  }

  function cancelScanAnimation() {
    if (scanAnimation) scanAnimation.finish();
    scanAnimation = null;
    els.skipScanBtn.hidden = true;
  }

  function beginScan(file) {
    els.result.classList.remove("is-revealing");
    els.scanFileName.textContent = file.name;
    els.scanTitle.textContent = "Reading photo evidence";
    els.scanStatus.textContent = "Reading image structure, embedded tags and file fingerprint locally…";
    els.scanProgress.setAttribute("aria-valuenow", "0");
    els.scanProgressFill.style.width = "0%";
    els.scanChecks.innerHTML = ["Image structure", "Embedded metadata", "Capture timestamp", "GPS coordinates", "Phone / camera identity", "Evidence report"].map((label) => `<li><span>···</span>${label}</li>`).join("");
    els.skipScanBtn.hidden = true;
    showState("loading");
  }

  function revealScanChecks(report) {
    const checks = [
      { text: `Image structure · ${report.image.format}`, found: true },
      { text: `Embedded metadata · ${report.assessment.metadataFieldsFound} fields found`, found: report.assessment.metadataFieldsFound > 0 },
      { text: `Capture timestamp · ${report.capture.dateDisplay ? "found" : "not embedded"}`, found: Boolean(report.capture.dateDisplay) },
      { text: `GPS coordinates · ${report.location.hasCoordinates ? "found" : "not embedded"}`, found: report.location.hasCoordinates },
      { text: `Phone / camera · ${report.capture.device || "not embedded"}`, found: Boolean(report.capture.device) },
      { text: "Evidence report · ready to reveal", found: true }
    ];
    const rows = Array.from(els.scanChecks.children);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    els.scanTitle.textContent = "Verifying the evidence";
    els.scanStatus.textContent = "Revealing verified checks. Missing information stays marked as missing.";
    return new Promise((resolve) => {
      const timers = [];
      let finished = false;
      function updateCheck(index) {
        const check = checks[index];
        rows[index].className = `is-verified${check.found ? "" : " is-missing"}`;
        rows[index].innerHTML = `<span>${check.found ? "[OK]" : "[--]"}</span>${escapeHtml(check.text)}`;
        const progress = Math.round((index + 1) / checks.length * 100);
        els.scanProgressFill.style.width = `${progress}%`;
        els.scanProgress.setAttribute("aria-valuenow", String(progress));
        if (index === checks.length - 1) {
          els.scanTitle.textContent = "Inspection complete";
          els.scanStatus.textContent = "Local checks complete. Opening your evidence report…";
        }
      }
      const session = {
        finish() {
          if (finished) return;
          finished = true;
          timers.forEach(clearTimeout);
          if (scanAnimation === session) scanAnimation = null;
          els.skipScanBtn.hidden = true;
          resolve();
        }
      };
      scanAnimation = session;
      if (reducedMotion) {
        checks.forEach((_, index) => updateCheck(index));
        session.finish();
        return;
      }
      els.skipScanBtn.hidden = false;
      checks.forEach((_, index) => timers.push(setTimeout(() => updateCheck(index), 180 + index * 330)));
      timers.push(setTimeout(() => session.finish(), 2400));
    });
  }

  async function handleFile(file) {
    const requestId = ++inspectionId;
    cancelScanAnimation();
    currentReport = null;
    currentFile = null;
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
    beginScan(file);
    els.dropZone.classList.remove("is-dragging");
    if (window.matchMedia("(max-width: 1050px)").matches) document.getElementById("reportPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      if (requestId !== inspectionId) return;
      const report = await analyzePhoto(file);
      if (requestId !== inspectionId) return;
      await revealScanChecks(report);
      if (requestId !== inspectionId) return;
      currentObjectUrl = URL.createObjectURL(file);
      currentReport = report;
      currentFile = file;
      renderReport(currentReport);
      els.result.classList.add("is-revealing");
      showState("result");
    } catch (error) {
      if (requestId !== inspectionId) return;
      cancelScanAnimation();
      currentReport = null;
      currentFile = null;
      if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
      showState("error", error instanceof Error ? error.message : "Try another photo file.");
    }
  }

  function clearReport() {
    inspectionId += 1;
    cancelScanAnimation();
    currentReport = null;
    currentFile = null;
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
    els.fileInput.value = "";
    els.result.innerHTML = "";
    els.result.classList.remove("is-revealing");
    showState("empty");
  }

  function makeTextReport(report) {
    const lines = [
      "PHOTO EVIDENCE REPORT",
      `File: ${report.file.name}`,
      `Format: ${report.image.format}`,
      `Size: ${formatBytes(report.file.size)}`,
      `Dimensions: ${report.image.width && report.image.height ? `${report.image.width} × ${report.image.height}` : "Not decoded"}`,
      `Date taken: ${report.capture.dateDisplay || "Not embedded"}`,
      `Location: ${report.location.hasCoordinates ? `${report.location.latitude.toFixed(7)}, ${report.location.longitude.toFixed(7)}` : "Not embedded"}`,
      `Place name: ${report.location.placeName || "Not looked up / unavailable"}`,
      `Phone or camera: ${report.capture.device || "Not embedded"}`,
      `Software: ${report.capture.software || "Not embedded"}`,
      `File saved / modified: ${formatFileDate(report.file.lastModified)}`,
      `SHA-256: ${report.file.sha256 || "Unavailable"}`,
      "",
      "Note: Metadata is a clue, not proof. It can be removed or changed."
    ];
    if (report.visualLocation) {
      const ai = report.visualLocation;
      lines.splice(lines.length - 2, 0, "", "AI VISUAL LOCATION ESTIMATE",
        `Likely area: ${[ai.likelyPlace, ai.region, ai.country].filter(Boolean).join(", ") || "Unable to estimate"}`,
        `Confidence: ${ai.confidence || "unknown"}`,
        `Summary: ${ai.summary || "Unavailable"}`,
        `Visible clues: ${Array.isArray(ai.clues) && ai.clues.length ? ai.clues.join("; ") : "None found"}`,
        `Limitation: ${ai.limitations || "Visual geolocation may be wrong."}`
      );
    }
    return lines.join("\n");
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("is-visible");
    toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2300);
  }

  async function copyReport() {
    if (!currentReport) return;
    try {
      await navigator.clipboard.writeText(makeTextReport(currentReport));
      showToast("Report copied to clipboard");
    } catch { showToast("Copy was blocked by the browser"); }
  }

  function exportReport() {
    if (!currentReport) return;
    const data = { ...currentReport, generatedAt: new Date().toISOString(), warning: "Metadata can be edited and should not be treated as proof by itself." };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentReport.file.name.replace(/\.[^.]+$/, "") || "photo"}-metadata-report.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast("JSON report downloaded");
  }

  function openPicker() { els.fileInput.click(); }

  els.browseBtn.addEventListener("click", (event) => { event.stopPropagation(); openPicker(); });
  els.dropZone.addEventListener("click", openPicker);
  els.dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openPicker(); }
  });
  els.fileInput.addEventListener("change", () => { if (els.fileInput.files?.[0]) handleFile(els.fileInput.files[0]); });
  els.clearBtn.addEventListener("click", clearReport);
  els.copyBtn.addEventListener("click", copyReport);
  els.exportBtn.addEventListener("click", exportReport);
  els.tryAgainBtn.addEventListener("click", openPicker);
  els.skipScanBtn.addEventListener("click", () => scanAnimation?.finish());

  ["dragenter", "dragover"].forEach((name) => els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropZone.classList.add("is-dragging");
  }));
  ["dragleave", "drop"].forEach((name) => els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropZone.classList.remove("is-dragging");
  }));
  els.dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });

  window.addEventListener("paste", (event) => {
    const file = Array.from(event.clipboardData?.files || []).find((item) => item.type.startsWith("image/"));
    if (file) handleFile(file);
  });

  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  function validateEmptyToolInput(input) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
      throw new Error("This tool accepts an empty object only.");
    }
  }

  function registerWebMcpTools() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      Promise.resolve(context.registerTool({
        name: "get_current_photo_report",
        title: "Read current photo report",
        description: "Return the metadata report currently visible in the photo inspector. Fails when no photo has been analyzed.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute(input) {
          validateEmptyToolInput(input);
          if (!currentReport) throw new Error("No photo report is currently available.");
          return JSON.parse(JSON.stringify(currentReport));
        }
      }, { signal: lifecycle.signal })).catch(() => {});
      Promise.resolve(context.registerTool({
        name: "clear_current_photo_report",
        title: "Clear current photo report",
        description: "Remove the current local photo report and return the inspector to its empty state.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) { validateEmptyToolInput(input); clearReport(); return { cleared: true }; }
      }, { signal: lifecycle.signal })).catch(() => {});
    } catch { /* Unsupported or unavailable browser implementation. */ }
  }

  registerWebMcpTools();
}());
