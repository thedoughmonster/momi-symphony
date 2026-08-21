import { createCipheriv, createDecipheriv, createSecretKey, randomBytes,
  type KeyObject } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import type { HostReviewSubject, SealedReviewCredentials } from "./types.ts"

const credentialName = "momi-review-ledger-key"

type ReviewCredentials = {
  capabilityToken: string
  threadId: string | null
  turnId: string | null
  reviewSubject: HostReviewSubject
}

export class ReviewCredentialBoundary {
  private readonly key: KeyObject

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("review_credential_key_invalid")
    this.key = createSecretKey(key)
  }

  seal(workId: string, fingerprint: string,
    credentials: ReviewCredentials): SealedReviewCredentials {
    const initializationVector = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key, initializationVector)
    cipher.setAAD(aad(workId, fingerprint))
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"), cipher.final(),
    ])
    return { version: 1, algorithm: "aes-256-gcm",
      initializationVector: initializationVector.toString("base64"),
      authenticationTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64") }
  }

  open(workId: string, fingerprint: string,
    envelope: SealedReviewCredentials): ReviewCredentials {
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
      throw new Error("review_credential_envelope_invalid")
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key,
        Buffer.from(envelope.initializationVector, "base64"))
      decipher.setAAD(aad(workId, fingerprint))
      decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64"))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final(),
      ]).toString("utf8")
      return JSON.parse(plaintext) as ReviewCredentials
    } catch {
      throw new Error("review_credential_envelope_invalid")
    }
  }
}

export async function loadReviewCredentialBoundary(
  credentialsDirectory: string,
): Promise<ReviewCredentialBoundary> {
  if (!isAbsolute(credentialsDirectory)) throw new Error("review_credential_boundary_invalid")
  const material = await readFile(join(credentialsDirectory, credentialName))
  const key = material.byteLength === 32 ? material : decodeTextKey(material.toString("utf8"))
  return new ReviewCredentialBoundary(key)
}

function decodeTextKey(value: string): Buffer {
  const encoded = value.trim()
  const key = /^[0-9a-f]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64")
  if (key.byteLength !== 32) throw new Error("review_credential_key_invalid")
  return key
}

function aad(workId: string, fingerprint: string): Buffer {
  return Buffer.from(`momi-agent-control-review-credentials-v1\0${workId}\0${fingerprint}`)
}
