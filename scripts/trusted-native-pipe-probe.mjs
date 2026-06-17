export async function probeNativePipe({ socketPath, message }) {
  const nativePipe = globalThis.nodeRepl?.nativePipe;
  const result = {
    hasNativePipe: Boolean(nativePipe),
    nativePipeType: typeof nativePipe?.createConnection,
    messages: [],
  };

  if (!nativePipe || typeof nativePipe.createConnection !== "function") {
    return result;
  }

  const socket = await nativePipe.createConnection(socketPath);
  const chunks = [];
  let remaining = new Uint8Array(0);

  const append = (chunk) => {
    const next = new Uint8Array(remaining.length + chunk.length);
    next.set(remaining);
    next.set(chunk, remaining.length);
    remaining = next;
  };

  const readLength = (buffer) => {
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
    return view.getUint32(0, true);
  };

  socket.on("data", (chunk) => {
    chunks.push(chunk);
    append(chunk);
    while (remaining.length >= 4) {
      const length = readLength(remaining);
      if (remaining.length < 4 + length) {
        break;
      }
      const frame = remaining.slice(4, 4 + length);
      result.messages.push(new TextDecoder().decode(frame));
      remaining = remaining.slice(4 + length);
    }
  });

  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, body.length, true);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header);
  frame.set(body, header.length);
  socket.write(frame);

  await new Promise((resolve) => setTimeout(resolve, 1500));
  socket.end();
  result.rawBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return result;
}
