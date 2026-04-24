// Prepare file data in the background so large uploads do not block the UI
self.onmessage = async (event) => {
  const payload = event.data;
  if (!payload || payload.type !== "prepare-file") {
    return;
  }

  const { transferId, source, file, chunkSize } = payload;

  try {
    // Capture the metadata that the sender UI needs to mirror the transfer
    const fileName = file.webkitRelativePath || file.name;
    const mime = file.type || "application/octet-stream";
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

    // Tell the main thread that this transfer is ready to stream
    self.postMessage({
      type: "prepared-start",
      transferId,
      source,
      name: fileName,
      mime,
      size: file.size,
      totalChunks,
    });

    // Slice the file into raw binary chunks and transfer ownership to the main thread
    for (let index = 0, offset = 0; offset < file.size; index += 1, offset += chunkSize) {
      const chunkBlob = file.slice(offset, Math.min(offset + chunkSize, file.size));
      const arrayBuffer = await chunkBlob.arrayBuffer();

      self.postMessage(
        {
          type: "prepared-chunk",
          transferId,
          index,
          data: arrayBuffer,
        },
        [arrayBuffer]
      );
    }

    // Signal that the worker finished preparing every chunk
    self.postMessage({
      type: "prepared-end",
      transferId,
    });
  } catch (error) {
    // Forward worker errors so the sender UI can mark the transfer as failed
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: "prepared-error",
      transferId,
      message,
    });
  }
};
