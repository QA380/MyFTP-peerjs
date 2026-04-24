self.onmessage = async (event) => {
  const payload = event.data;
  if (!payload || payload.type !== "prepare-file") {
    return;
  }

  const { transferId, source, file, chunkSize } = payload;

  try {
    const fileName = file.webkitRelativePath || file.name;
    const mime = file.type || "application/octet-stream";
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

    self.postMessage({
      type: "prepared-start",
      transferId,
      source,
      name: fileName,
      mime,
      size: file.size,
      totalChunks,
    });

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

    self.postMessage({
      type: "prepared-end",
      transferId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({
      type: "prepared-error",
      transferId,
      message,
    });
  }
};
