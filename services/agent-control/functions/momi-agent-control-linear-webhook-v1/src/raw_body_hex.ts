export function rawBodyHex(rawBody: Uint8Array): string {
  return Array.from(rawBody, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
