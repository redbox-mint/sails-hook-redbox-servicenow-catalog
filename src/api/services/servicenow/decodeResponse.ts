import type { AxiosResponse } from 'axios';
import { promisify } from 'node:util';
import { brotliDecompress, inflate, inflateRaw, unzip, zstdDecompress } from 'node:zlib';

const decodeBrotli = promisify(brotliDecompress);
const decodeDeflate = promisify(inflate);
const decodeRawDeflate = promisify(inflateRaw);
const decodeGzip = promisify(unzip);
const decodeZstd = promisify(zstdDecompress);

export class ResponseDecodingError extends Error {
  constructor(encoding: string) {
    // Do not retain the response or axios config: they can contain credentials.
    super(`ServiceNow response could not be decompressed (${encoding}).`);
    this.name = 'ResponseDecodingError';
  }
}

/**
 * Axios's default Z_SYNC_FLUSH/BROTLI_OPERATION_FLUSH accepts truncated bodies.
 * Decode the buffered response with zlib's strict defaults before parsing JSON,
 * so an accepted order with a damaged response cannot be reported as success.
 */
export async function decodeResponse(response: AxiosResponse<Buffer>): Promise<AxiosResponse<unknown>> {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  let body = response.data;
  // HTTP defines these responses as bodyless, even with a stale encoding header.
  const bodyless = response.status === 204 || response.config.method?.toLowerCase() === 'head';
  if (!bodyless) {
    try {
      switch (encoding) {
        case 'br':
          body = await decodeBrotli(body);
          break;
        case 'gzip':
        case 'x-gzip':
        case 'compress':
        case 'x-compress':
          body = await decodeGzip(body);
          break;
        case 'deflate':
          // Some servers send raw deflate, which axios also accepts.
          body = (body[0] & 0x0f) === 8 ? await decodeDeflate(body) : await decodeRawDeflate(body);
          break;
        case 'zstd':
          body = await decodeZstd(body);
          break;
      }
    } catch {
      throw new ResponseDecodingError(encoding);
    }
  }
  const text = body.toString('utf8').replace(/^\uFEFF/, '');
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Preserve axios's default handling of non-JSON response bodies.
  }
  return { ...response, data };
}
