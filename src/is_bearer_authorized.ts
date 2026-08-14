export async function isBearerAuthorized(
  authorization: string | null,
  expected: string,
): Promise<boolean> {
  if (!authorization?.startsWith("Bearer ") || !expected) return false
  const encoder = new TextEncoder()
  const [presented, configured] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(authorization.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ])
  const left = new Uint8Array(presented)
  const right = new Uint8Array(configured)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}
