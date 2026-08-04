export class SecretCryptoError extends Error {
  readonly code: "encryption_key_missing" | "config_decryption_failed";

  constructor(code: SecretCryptoError["code"]) {
    super(code);
    this.name = "SecretCryptoError";
    this.code = code;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  try {
    const binary = atob(value);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return buffer;
  } catch {
    throw new SecretCryptoError("config_decryption_failed");
  }
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new SecretCryptoError("encryption_key_missing");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const CONFIG_AAD = new TextEncoder().encode("pep-vocab-ai-config:v1").buffer as ArrayBuffer;

export async function encryptSecret(plaintext: string, secret: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer, additionalData: CONFIG_AAD },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(ciphertext: string, iv: string, secret: string): Promise<string> {
  try {
    const key = await encryptionKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToArrayBuffer(iv), additionalData: CONFIG_AAD },
      key,
      base64ToArrayBuffer(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof SecretCryptoError) throw error;
    throw new SecretCryptoError("config_decryption_failed");
  }
}

export async function hashIdentity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.trim().toLowerCase()));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
