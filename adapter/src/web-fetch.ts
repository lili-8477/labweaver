// Fetch one web page for the memory builder ("extract this from that link").
// Runs in the member's container, which can also reach the hub's internal
// services, so only public http(s) addresses are fetched: every hop of a
// redirect is resolved and checked before it is requested. The body is capped
// and must be a type the builder can read.

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/** Content types the builder reads, by the file extension memory-builder.py expects. */
const EXT_BY_TYPE: Record<string, string> = {
  "text/html": ".html",
  "application/xhtml+xml": ".html",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
};

const internal = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) internal.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  internal.addSubnet(net, bits, "ipv6");
}

/** False for loopback, private, link-local, carrier-grade NAT, multicast and reserved addresses. */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !internal.check(address, family === 4 ? "ipv4" : "ipv6");
}

export interface FetchedPage {
  /** The final URL, after redirects. */
  url:  string;
  ext:  string;
  body: Buffer;
}

export interface FetchOptions {
  lookup?:   (host: string) => Promise<Array<{ address: string; family: number }>>;
  fetchFn?:  typeof fetch;
  maxBytes?: number;
}

async function assertPublic(url: URL, lookup: NonNullable<FetchOptions["lookup"]>): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https links can be fetched: ${url.href}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host);
  if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) {
    throw new Error(`${url.hostname} resolves to an internal address; only public sites can be fetched`);
  }
}

export async function fetchPage(link: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const lookup = opts.lookup ?? ((host: string) => dnsLookup(host, { all: true }));
  const fetchFn = opts.fetchFn ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error(`not a link: ${link}`);
  }
  for (let hop = 0; ; hop++) {
    await assertPublic(url, lookup);
    const res = await fetchFn(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "LabWeaver memory builder", accept: "text/html,application/pdf,text/*;q=0.9,*/*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${link}`);
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`${url.href} returned ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) throw new Error(`cannot read ${type || "unknown"} content from ${url.href}`);
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new Error(`${url.href} is larger than ${maxBytes / 1024 / 1024} MB`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`${url.href} is larger than ${maxBytes / 1024 / 1024} MB`);
      chunks.push(Buffer.from(chunk));
    }
    return { url: url.href, ext, body: Buffer.concat(chunks) };
  }
}
