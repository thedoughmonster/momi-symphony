export async function verifyLinearSignature(
  rawBody: Uint8Array,
  supplied: string | null,
  secret: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(supplied ?? "") || !secret) return false
  const signature = Uint8Array.from(
    supplied!.match(/.{2}/g)!,
    (pair) => Number.parseInt(pair, 16),
  )
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  )
  const body = new ArrayBuffer(rawBody.byteLength)
  new Uint8Array(body).set(rawBody)
  return crypto.subtle.verify("HMAC", key, signature, body)
}
