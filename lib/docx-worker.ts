import { readDocxDocument } from "./docx-archive";

const context = self as unknown as {
  onmessage: ((event: MessageEvent<Uint8Array>) => void) | null;
  postMessage: (message: unknown, transfer: Transferable[]) => void;
};
context.onmessage = event => {
  try {
    const xml = readDocxDocument(event.data);
    context.postMessage({ xml }, [xml.buffer]);
  } catch (error) {
    context.postMessage({ error: error instanceof Error ? error.message : "无法读取这份 Word 文档。" }, []);
  }
};
