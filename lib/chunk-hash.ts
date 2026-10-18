// File integrity check that works chunk by chunk.
// WebCrypto cannot hash a stream incrementally, so each chunk is hashed natively and the file
// fingerprint is SHA-256 over the ordered list of chunk hashes. Sender and receiver compute it
// the same way, so equal fingerprints mean every byte arrived intact and in order.

export const canHashChunks = () =>
  typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function";

// digest() copies the bytes synchronously, so the buffer can be reused or sent right away
export const hashChunk = (data: Uint8Array<ArrayBuffer>) => crypto.subtle.digest("SHA-256", data);

export const combineChunkHashes = async (hashes: ArrayBuffer[]): Promise<string> => {
  const joined = new Uint8Array(hashes.length * 32);
  hashes.forEach((hash, index) => {
    joined.set(new Uint8Array(hash ?? new ArrayBuffer(0)), index * 32);
  });

  const digest = await crypto.subtle.digest("SHA-256", joined);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
