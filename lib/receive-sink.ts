// Receiver-side storage for incoming files.
// Chunks are streamed into the Origin Private File System (OPFS) when the browser supports it,
// so large files never have to fit in memory. Older browsers fall back to keeping chunks in RAM.

export type ReceiveSink = {
  readonly onDisk: boolean;
  // Queue a chunk for writing at its index; writes are applied in call order
  write: (index: number, data: ArrayBuffer) => void;
  // Flush everything and return the finished file
  finish: (mime: string) => Promise<Blob>;
  // Drop the data (and the OPFS file, if any)
  discard: () => Promise<void>;
  // First storage error, if one happened (e.g. quota exceeded)
  error: () => Error | null;
};

const INBOX_DIRECTORY = "myftp-inbox";
// Group consecutive chunks into larger writes to cut per-call overhead
const WRITE_BATCH_BYTES = 1024 * 1024;

let staleInboxCleanup: Promise<void> | null = null;

const toError = (value: unknown) => (value instanceof Error ? value : new Error(String(value)));

const supportsDiskSink = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.storage?.getDirectory === "function" &&
  typeof FileSystemFileHandle !== "undefined" &&
  "createWritable" in FileSystemFileHandle.prototype;

// Files left behind by a previous session are removed once, before the first new write
const getInboxDirectory = async () => {
  const root = await navigator.storage.getDirectory();
  staleInboxCleanup ??= root.removeEntry(INBOX_DIRECTORY, { recursive: true }).catch(() => undefined);
  await staleInboxCleanup;
  return root.getDirectoryHandle(INBOX_DIRECTORY, { create: true });
};

const createMemorySink = (): ReceiveSink => {
  let chunks: ArrayBuffer[] = [];

  return {
    onDisk: false,
    write(index, data) {
      chunks[index] = data;
    },
    async finish(mime) {
      return new Blob(chunks, { type: mime });
    },
    async discard() {
      chunks = [];
    },
    error: () => null,
  };
};

const createDiskSink = (transferId: string, chunkSize: number): ReceiveSink => {
  const fileName = transferId.replace(/[^A-Za-z0-9_-]/g, "_");
  let failure: Error | null = null;
  let directory: FileSystemDirectoryHandle | null = null;
  let handle: FileSystemFileHandle | null = null;
  let writable: FileSystemWritableFileStream | null = null;
  let pendingStart = 0;
  let pendingParts: ArrayBuffer[] = [];
  let pendingBytes = 0;

  let chain: Promise<void> = (async () => {
    directory = await getInboxDirectory();
    handle = await directory.getFileHandle(fileName, { create: true });
    writable = await handle.createWritable();
  })().catch((err) => {
    failure = toError(err);
  });

  const enqueue = (task: () => Promise<void>) => {
    chain = chain
      .then(() => (failure ? undefined : task()))
      .catch((err) => {
        failure ??= toError(err);
      });
  };

  const flushPending = () => {
    if (pendingParts.length === 0) {
      return;
    }

    const blob = new Blob(pendingParts);
    const position = pendingStart * chunkSize;
    pendingParts = [];
    pendingBytes = 0;
    enqueue(async () => {
      await writable?.write({ type: "write", position, data: blob });
    });
  };

  return {
    onDisk: true,
    write(index, data) {
      // Resumed or out-of-order chunks start a new batch at their own position
      if (pendingParts.length > 0 && index !== pendingStart + pendingParts.length) {
        flushPending();
      }
      if (pendingParts.length === 0) {
        pendingStart = index;
      }

      pendingParts.push(data);
      pendingBytes += data.byteLength;
      if (pendingBytes >= WRITE_BATCH_BYTES) {
        flushPending();
      }
    },
    async finish(mime) {
      flushPending();
      enqueue(async () => {
        await writable?.close();
        writable = null;
      });
      await chain;

      if (failure) {
        throw failure;
      }
      if (!handle) {
        throw new Error("Download storage was not created");
      }

      const file = await handle.getFile();
      // slice() keeps the blob disk-backed while giving it the right MIME type
      return file.slice(0, file.size, mime);
    },
    async discard() {
      pendingParts = [];
      pendingBytes = 0;
      await chain;
      const openWritable = writable;
      writable = null;
      await openWritable?.abort().catch(() => undefined);
      await directory?.removeEntry(fileName).catch(() => undefined);
    },
    error: () => failure,
  };
};

export const createReceiveSink = (transferId: string, chunkSize: number): ReceiveSink =>
  supportsDiskSink() ? createDiskSink(transferId, chunkSize) : createMemorySink();
