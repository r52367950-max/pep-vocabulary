/** Builds an authentic pre-scope v1 record for regression tests only. */
export async function legacyAiCredential(secret, keyBase64) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(keyBase64, 'base64'), { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode('pep-vocab-ai-config:v1') }, key, new TextEncoder().encode(secret));
  return { encryptedApiKey: Buffer.from(ciphertext).toString('base64'), keyIv: Buffer.from(iv).toString('base64'), encryptionVersion: 1 };
}
