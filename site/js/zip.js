/* ============================================================
   zip.js · 零依赖 ZIP/CBZ 解包
   只读取需要的字节段，避免把整个压缩包读进内存。
   支持 store(0) 与 deflate(8)，支持 ZIP64 与 GBK 文件名。
   ============================================================ */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;

const IMG_EXT = /\.(jpe?g|jfif|png|webp|gif|avif|bmp)$/i;

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', bmp: 'image/bmp',
};

const naturalSort = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const hasDS = typeof DecompressionStream !== 'undefined';

function mimeOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

function decodeName(bytes, flags) {
  if (flags & 0x800) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    try { return new TextDecoder('gbk').decode(bytes); } catch (e2) { /* noop */ }
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function readU64(bytes, off) {
  let v = 0;
  for (let i = 7; i >= 0; i--) v = v * 256 + bytes[off + i];
  return v;
}

/** 是否为应跳过的垃圾条目 */
function isJunk(name) {
  const base = name.split('/').pop() || '';
  if (!base) return true;
  if (base.startsWith('.')) return true;
  if (name.startsWith('__MACOSX/')) return true;
  if (/^Thumbs\.db$/i.test(base)) return true;
  if (name.includes('/._')) return true;
  return false;
}

/** 读取 ZIP 的中央目录，返回条目描述数组 */
async function readCentralDirectory(file) {
  const tailLen = Math.min(file.size, 66000);
  if (tailLen < 22) throw new Error('文件太小，不是有效的压缩包');

  const tailBuf = await file.slice(file.size - tailLen).arrayBuffer();
  const tail = new DataView(tailBuf);

  let p = -1;
  for (let i = tailBuf.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG_EOCD) { p = i; break; }
  }
  if (p < 0) throw new Error('找不到中央目录记录，可能不是 ZIP/CBZ 文件');

  let total = tail.getUint16(p + 10, true);
  let cdSize = tail.getUint32(p + 12, true);
  let cdOffset = tail.getUint32(p + 16, true);

  // ---- ZIP64 ----
  const locOff = p - 20;
  if (locOff >= 0 && tail.getUint32(locOff, true) === SIG_EOCD64_LOC) {
    const z64 = readU64(new Uint8Array(tailBuf, locOff + 8, 8), 0);
    if (z64 > 0 && z64 < file.size) {
      const recBuf = await file.slice(z64, Math.min(z64 + 56, file.size)).arrayBuffer();
      if (recBuf.byteLength >= 56) {
        const rec = new DataView(recBuf);
        if (rec.getUint32(0, true) === SIG_EOCD64) {
          total = Number(rec.getBigUint64(32, true));
          cdSize = Number(rec.getBigUint64(40, true));
          cdOffset = Number(rec.getBigUint64(48, true));
        }
      }
    }
  }

  if (cdOffset + cdSize > file.size) {
    throw new Error('压缩包结构异常（中央目录越界），文件可能已损坏');
  }

  const cdBuf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const dv = new DataView(cdBuf);
  const entries = [];
  let o = 0;

  while (o + 46 <= cdBuf.byteLength) {
    if (dv.getUint32(o, true) !== SIG_CENTRAL) break;

    const flags = dv.getUint16(o + 8, true);
    const method = dv.getUint16(o + 10, true);
    let compSize = dv.getUint32(o + 20, true);
    let uncompSize = dv.getUint32(o + 24, true);
    const nameLen = dv.getUint16(o + 28, true);
    const extraLen = dv.getUint16(o + 30, true);
    const commentLen = dv.getUint16(o + 32, true);
    let localOff = dv.getUint32(o + 42, true);

    const name = decodeName(new Uint8Array(cdBuf, o + 46, nameLen), flags);

    // ZIP64 扩展字段
    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localOff === 0xFFFFFFFF) {
      const extra = new Uint8Array(cdBuf, o + 46 + nameLen, extraLen);
      let eo = 0;
      while (eo + 4 <= extra.length) {
        const hid = extra[eo] | (extra[eo + 1] << 8);
        const hsz = extra[eo + 2] | (extra[eo + 3] << 8);
        if (hid === 0x0001) {
          let f = eo + 4;
          if (uncompSize === 0xFFFFFFFF) { uncompSize = readU64(extra, f); f += 8; }
          if (compSize === 0xFFFFFFFF) { compSize = readU64(extra, f); f += 8; }
          if (localOff === 0xFFFFFFFF) { localOff = readU64(extra, f); f += 8; }
          break;
        }
        eo += 4 + hsz;
      }
    }

    if (!name.endsWith('/')) {
      entries.push({ name, method, compSize, uncompSize, localOff });
    }

    o += 46 + nameLen + extraLen + commentLen;
    if (entries.length > 20000) break; // 安全阀
  }

  if (!entries.length) throw new Error('压缩包为空，或未包含任何文件');
  return entries;
}

/** 解出单个条目的内容，返回 Blob */
async function extractEntry(file, e) {
  const headLen = 30;
  if (e.localOff + headLen > file.size) throw new Error(`条目 "${e.name}" 偏移越界`);
  const headBuf = await file.slice(e.localOff, e.localOff + headLen).arrayBuffer();
  const dv = new DataView(headBuf);
  const nLen = dv.getUint16(26, true);
  const eLen = dv.getUint16(28, true);
  const dataStart = e.localOff + headLen + nLen + eLen;

  const type = mimeOf(e.name);

  if (e.method === 0) {
    const raw = await file.slice(dataStart, dataStart + e.compSize).arrayBuffer();
    return new Blob([raw], { type });
  }

  if (e.method === 8) {
    if (!hasDS) {
      throw new Error('当前浏览器不支持流式解压，请改用图片导入，或改用新版 Chrome / Edge / Safari');
    }
    if (!e.compSize) throw new Error(`条目 "${e.name}" 缺少压缩长度信息`);
    const raw = await file.slice(dataStart, dataStart + e.compSize).arrayBuffer();
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const out = await new Response(stream).arrayBuffer();
      return new Blob([out], { type });
    } catch (err) {
      throw new Error(`解压 "${e.name}" 失败，压缩包可能已损坏`);
    }
  }

  throw new Error(`不支持的压缩算法（method=${e.method}），请用标准 ZIP 重新打包`);
}

/**
 * 列出压缩包内的图片页，按文件名自然排序
 * @param {File|Blob} file
 * @param {{onScan?:(n:number)=>void}} [opts]
 * @returns {Promise<Array<{name:string,size:number,read:()=>Promise<Blob>}>>}
 */
async function listZipImages(file, opts = {}) {
  const all = await readCentralDirectory(file);
  if (opts.onScan) opts.onScan(all.length);

  return all
    .filter((e) => IMG_EXT.test(e.name) && !isJunk(e.name))
    .sort((a, b) => naturalSort.compare(a.name, b.name))
    .map((e) => ({
      name: e.name,
      size: e.uncompSize,
      read: () => extractEntry(file, e),
    }));
}

/** 探测文件是否为 ZIP（按魔数 / 扩展名） */
async function looksLikeZip(file) {
  if (/\.(zip|cbz)$/i.test(file.name || '')) return true;
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b;
  } catch (e) {
    return false;
  }
}

export { listZipImages, looksLikeZip, naturalSort, IMG_EXT, hasDS };
