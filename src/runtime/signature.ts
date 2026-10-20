/**
 * The CMS's signature on a webhook body: X-CMS-Signature: sha256=<hex
 * HMAC-SHA256 of the body with the shared secret>, compared in constant time.
 * Web Crypto only, so it runs on Workers.
 */
export async function verify(body: string, header: string | null, secret: string): Promise<boolean> {
  const given = header?.startsWith("sha256=") ? header.slice(7) : null;
  if (!given) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== given.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return difference === 0;
}

/** How old a signed post may be, in seconds: the contract's advised five minutes. */
export const TOLERANCE_SECONDS = 300;

/**
 * A request's signature, as a CMS from 2.8.0 signs it: X-CMS-Signature-V2
 * over "<X-CMS-Timestamp>.<body>", with the timestamp no older (or further
 * ahead) than the tolerance, so a captured post can't be replayed later. A
 * CMS before 2.8.0 sends neither, and its X-CMS-Signature is checked as it
 * was.
 */
export async function verifyRequest(body: string, headers: Headers, secret: string, now = Date.now()): Promise<boolean> {
  const v2 = headers.get("X-CMS-Signature-V2");
  if (v2 === null) return verify(body, headers.get("X-CMS-Signature"), secret);
  const timestamp = headers.get("X-CMS-Timestamp");
  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  return verify(`${timestamp}.${body}`, v2, secret);
}
