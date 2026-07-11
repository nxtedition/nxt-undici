import type { BodyReadable } from '../lib/index.js'

async function consume(body: BodyReadable) {
  const bytes: Uint8Array = await body.bytes()
  const used: boolean = body.bodyUsed
  // These deliberately mirror @nxtedition/undici's runtime: BodyReadable has
  // no Fetch ReadableStream getter and formData() always rejects as unsupported.
  const unsupportedBody: undefined = body.body
  const unsupportedFormData: Promise<never> = body.formData()
  return { bytes, used, unsupportedBody, unsupportedFormData }
}

void consume
