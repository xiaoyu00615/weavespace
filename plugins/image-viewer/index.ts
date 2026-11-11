/**
 * 图片查看器插件（P0 探针版，仅 viewer）。
 * 存在意义：证明「新增一个只读查看器插件不需要修改既有模块源码」（CT-11）。
 * 不声明 write 能力、不提供 serializer：任何写回尝试都应在 Core 侧被拒绝。
 */
export interface ImageMeta {
  extension: string;
  byteLength: number;
  /** 仅做魔数探测，不做解码；P0 不解码像素。 */
  detectedFormat: string;
}

const MAGIC: { format: string; bytes: number[] }[] = [
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

export function detectFormat(buffer: Uint8Array): string {
  for (const m of MAGIC) {
    if (m.bytes.every((b, i) => buffer[i] === b)) return m.format;
  }
  return 'unknown';
}

export function createImageViewerPlugin() {
  return {
    activate() {
      /* 只读查看器无副作用 */
    },
    deactivate() {
      /* 无可释放资源 */
    },
    inspect(path: string, buffer: Uint8Array): ImageMeta {
      return {
        extension: path.slice(path.lastIndexOf('.')),
        byteLength: buffer.byteLength,
        detectedFormat: detectFormat(buffer),
      };
    },
  };
}
