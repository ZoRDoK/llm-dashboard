import { config } from '../config.js';
import { FETCH_TIMEOUT_MS, MS_PER_SECOND } from '../constants.js';
import { createLogger } from '../logger.js';
import { Provider } from '../provider.js';
import type { ProviderAdapter } from '../types.js';
import { UsageWindow } from '../usage-window.js';
import { retryOn401 } from './auth-json.js';
import { GrokAuth } from './grok-auth.js';

const log = createLogger('adapter:grok');

const BILLING_ENDPOINT = 'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';

// ── Protobuf wire constants ─────────────────────────────────

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_64BIT = 1;
const WIRE_32BIT = 5;

const FIELD_USED_PERCENT = 1;
const FIELD_PERIOD_END = 5;
const FIELD_TIMESTAMP_SECONDS = 1;

const GRPC_FRAME_HEADER_SIZE = 5;
const FIXED32_SIZE = 4;
const FIXED64_SIZE = 8;

const GRPC_WEB_EMPTY_REQUEST = Buffer.alloc(GRPC_FRAME_HEADER_SIZE);

const GRPC_CONTENT_HEADERS = {
  'Content-Type': 'application/grpc-web+proto',
  Accept: 'application/grpc-web+proto',
  'x-grpc-web': '1',
};

// ── Types ───────────────────────────────────────────────────

interface BillingData {
  usedPercent: number;
  resetAt: string;
}

interface FieldInfo {
  fieldNumber: number;
  wireType: number;
  dataStart: number;
}

// ── Protobuf decoder ────────────────────────────────────────

const decodeVarint = (buf: Buffer, offset: number): [value: number, next: number] => {
  let value = 0;
  let shift = 0;
  let pos = offset;

  const MAX_VARINT_BYTES = 10;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    // biome-ignore lint/style/noNonNullAssertion: guarded by loop bound
    const byte = buf[pos]!;
    value |= (byte & 0x7f) << shift;
    pos++;

    if ((byte & 0x80) === 0) {
      break;
    }

    const VARINT_SHIFT = 7;
    shift += VARINT_SHIFT;
  }

  return [value, pos];
};

const skipField = (buf: Buffer, wireType: number, offset: number): number => {
  if (wireType === WIRE_VARINT) {
    const [, after] = decodeVarint(buf, offset);
    return after;
  }

  if (wireType === WIRE_LENGTH_DELIMITED) {
    const [len, after] = decodeVarint(buf, offset);
    return after + len;
  }

  if (wireType === WIRE_32BIT) {
    return offset + FIXED32_SIZE;
  }

  if (wireType === WIRE_64BIT) {
    return offset + FIXED64_SIZE;
  }

  return offset;
};

const readField = (buf: Buffer, offset: number): [info: FieldInfo, next: number] => {
  const [tag, dataStart] = decodeVarint(buf, offset);

  return [
    {
      fieldNumber: tag >>> 3,
      wireType: tag & 0x07,
      dataStart,
    },
    skipField(buf, tag & 0x07, dataStart),
  ];
};

const parseTimestamp = (buf: Buffer): number => {
  let seconds = 0;
  let pos = 0;

  while (pos < buf.length) {
    const [info, next] = readField(buf, pos);

    if (info.fieldNumber === FIELD_TIMESTAMP_SECONDS && info.wireType === WIRE_VARINT) {
      const [val, after] = decodeVarint(buf, info.dataStart);
      seconds = val;
      pos = after;
    } else {
      pos = next;
    }
  }

  return seconds;
};

const parseBillingProto = (buf: Buffer): BillingData => {
  let usedPercent = 0;
  let periodEndSeconds = 0;
  let pos = 0;

  while (pos < buf.length) {
    const [info, next] = readField(buf, pos);

    if (info.fieldNumber === FIELD_USED_PERCENT && info.wireType === WIRE_32BIT) {
      usedPercent = buf.readFloatLE(info.dataStart);
    } else if (info.fieldNumber === FIELD_PERIOD_END && info.wireType === WIRE_LENGTH_DELIMITED) {
      const [len, after] = decodeVarint(buf, info.dataStart);
      const nested = buf.subarray(after, after + len);
      periodEndSeconds = parseTimestamp(nested);
    }

    pos = next;
  }

  const PERCENT_SCALE = 1000;
  const PERCENT_ROUND = 10;
  const usedPct = Math.round(usedPercent * PERCENT_SCALE) / PERCENT_ROUND;
  const resetAt = new Date(periodEndSeconds * MS_PER_SECOND).toISOString();

  return { usedPercent: usedPct, resetAt };
};

// ── gRPC-web frame parser ──────────────────────────────────

const unwrapGrpcWeb = (raw: ArrayBuffer): Buffer => {
  const buf = Buffer.from(raw);

  if (buf.length < GRPC_FRAME_HEADER_SIZE) {
    throw new Error('Response too short for gRPC-web frame');
  }

  const payloadLength = buf.readUInt32BE(1);

  return buf.subarray(GRPC_FRAME_HEADER_SIZE, GRPC_FRAME_HEADER_SIZE + payloadLength);
};

const unwrapBillingMessage = (buf: Buffer): Buffer => {
  // The billing response is wrapped in a top-level field 1 (length-delimited).
  // Peel off that outer layer so parseBillingProto sees the actual fields.
  let pos = 0;

  while (pos < buf.length) {
    const [info, next] = readField(buf, pos);

    if (info.fieldNumber === FIELD_USED_PERCENT && info.wireType === WIRE_32BIT) {
      // Not wrapped — top-level already has billing fields
      return buf;
    }

    if (info.fieldNumber === 1 && info.wireType === WIRE_LENGTH_DELIMITED) {
      const [len, after] = decodeVarint(buf, info.dataStart);

      return buf.subarray(after, after + len);
    }

    pos = next;
  }

  return buf;
};

const parseGrpcWebResponse = (raw: ArrayBuffer): BillingData => {
  const payload = unwrapGrpcWeb(raw);
  const unwrapped = unwrapBillingMessage(payload);

  return parseBillingProto(unwrapped);
};

// ── Adapter ─────────────────────────────────────────────────

const auth = new GrokAuth();

export class Grok implements ProviderAdapter {
  id = 'grok';
  name = 'Grok';

  async fetchUsage(): Promise<Provider> {
    const bearerResult = await this.tryBearerAuth();

    if (bearerResult) {
      return bearerResult;
    }

    const cookie = config.GROK_COOKIE;

    if (!cookie) {
      return Provider.notConfigured(this.id, this.name);
    }

    try {
      const headers = { Cookie: cookie, ...GRPC_CONTENT_HEADERS };

      return this.fetchProvider(headers);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        'Grok cookie auth failed',
      );

      return Provider.notConfigured(this.id, this.name);
    }
  }

  private async tryBearerAuth(): Promise<Provider | null> {
    let token: string | null = null;
    let fromAuth = false;

    try {
      token = await auth.getToken();
      fromAuth = true;
    } catch (err) {
      log.debug({ err }, 'Grok auth.json token unavailable, falling back to env token');

      token = config.GROK_ACCESS_TOKEN ?? null;
    }

    if (!token) {
      return null;
    }

    // Token from auth may be invalidated after our freshness check —
    // retryOn401 does one force-fresh re-fetch on HTTP 401.
    return await retryOn401(token, fromAuth, auth, (t) => {
      const headers = { Authorization: `Bearer ${t}`, ...GRPC_CONTENT_HEADERS };

      return this.fetchProvider(headers);
    });
  }

  private async fetchProvider(headers: Record<string, string>): Promise<Provider> {
    const data = await this.fetchBilling(headers);
    const windows = this.buildWins(data);

    return new Provider(this.id, this.name, 'SuperGrok', [{ modelName: 'SuperGrok', windows }]);
  }

  private async fetchBilling(headers: Record<string, string>): Promise<BillingData> {
    const response = await fetch(BILLING_ENDPOINT, {
      method: 'POST',
      headers,
      body: GRPC_WEB_EMPTY_REQUEST,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = await response.arrayBuffer();

    return parseGrpcWebResponse(raw);
  }

  private buildWins(data: BillingData): UsageWindow[] {
    return [UsageWindow.fromApi('monthly', data.usedPercent, data.resetAt)];
  }
}
