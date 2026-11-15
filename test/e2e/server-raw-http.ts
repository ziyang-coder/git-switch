/**
 * Raw-HTTP client for server tests.
 *
 * `fetch` normalises too much to attack a request handler with: it trims header
 * values, refuses to duplicate most headers and cannot send a forged Host. These
 * helpers speak HTTP/1.1 on a plain socket so a test can send exactly the bytes
 * an attacker would.
 */

import net from 'node:net';

export interface RawRequest {
  method?: string;
  path: string;
  /** Header lines sent verbatim, e.g. `Host: evil.example:1234`. */
  headers?: string[];
  body?: string;
  /** Overrides the default `Connection: close`. */
  connection?: string;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Send one request; resolve with the parsed response. */
export function rawRequest(port: number, req: RawRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (res: RawResponse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(res);
    };
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error(`raw request timed out: ${req.method ?? 'GET'} ${req.path}`));
    });
    socket.on('error', (err) => {
      if (!settled) reject(err);
    });

    socket.on('connect', () => {
      const method = req.method ?? 'GET';
      const body = req.body ?? '';
      const lines = [`${method} ${req.path} HTTP/1.1`];
      if (!req.headers?.some((h) => /^host:/i.test(h))) lines.push(`Host: 127.0.0.1:${port}`);
      for (const header of req.headers ?? []) lines.push(header);
      if (body !== '' || !req.headers?.some((h) => /^(content-length|transfer-encoding):/i.test(h))) {
        lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      }
      lines.push(`Connection: ${req.connection ?? 'close'}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n' + body);
    });

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const split = indexOfHeadEnd(raw);
      if (split === -1) return;
      const head = raw.subarray(0, split).toString('utf8');
      const bodyBytes = raw.subarray(split + 4);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const status = Number.parseInt(/(\d{3})/.exec(statusLine ?? '')?.[1] ?? '0', 10);
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const name = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
      }
      if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
        const decoded = decodeChunked(bodyBytes);
        if (decoded === undefined) return; // last chunk not received yet
        finish({ status, headers, body: decoded });
        return;
      }

      const length = Number.parseInt(headers['content-length'] ?? '', 10);
      if (Number.isFinite(length) && bodyBytes.length < length) return;
      finish({ status, headers, body: bodyBytes.toString('utf8') });
    });

    socket.on('end', () => {
      // The handler closed the connection. Only fall back to a partial read when
      // the data event never completed: otherwise the response is already done.
      if (settled) return;
      const raw = Buffer.concat(chunks);
      const split = indexOfHeadEnd(raw);
      if (split === -1) {
        finish({ status: 0, headers: {}, body: '' });
        return;
      }
      const head = raw.subarray(0, split).toString('utf8');
      const headers: Record<string, string> = {};
      for (const line of head.split('\r\n').slice(1)) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      const bodyBytes = raw.subarray(split + 4);
      finish({
        status: Number.parseInt(/(\d{3})/.exec(head.split('\r\n')[0] ?? '')?.[1] ?? '0', 10),
        headers,
        body: decodeChunked(bodyBytes) ?? bodyBytes.toString('utf8'),
      });
    });
  });
}

/** Offset of the CRLFCRLF that ends the response head, searched in bytes. */
function indexOfHeadEnd(buffer: Buffer): number {
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) return i;
  }
  return -1;
}

/**
 * Decode a chunked body, byte-exactly: the chunk-size prefix counts *bytes*, and
 * the payload is UTF-8 (so the byte length and the string length differ).
 * `undefined` means the terminating `0` chunk has not arrived yet.
 */
function decodeChunked(body: Buffer): string | undefined {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const eol = body.indexOf(13, offset); // '\r'
    if (eol === -1 || body[eol + 1] !== 10) return undefined;
    const sizeText = body.subarray(offset, eol).toString('ascii').trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) return undefined;
    const start = eol + 2;
    if (size === 0) return Buffer.concat(parts).toString('utf8');
    if (body.length < start + size + 2) return undefined;
    parts.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
}

/** Parse a JSON response body, failing the test with the raw text when it is not JSON. */
export function asJson<T>(res: RawResponse): T {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`expected JSON, got ${res.status} ${res.body.slice(0, 200)}`);
  }
}
