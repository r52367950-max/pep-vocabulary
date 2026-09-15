export function prepareOfflineLexicon(): Promise<number> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker)
    return Promise.reject(
      new Error("离线服务尚未就绪。请在正式站点刷新一次后，再准备离线词库。"),
    );
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
    };
    const timer = setTimeout(() => {
      close();
      reject(new Error("离线准备超时，请保持联网后重试。"));
    }, 120_000);
    channel.port1.onmessage = (
      event: MessageEvent<{ ok?: boolean; files?: number }>,
    ) => {
      close();
      if (
        event.data?.ok === true &&
        Number.isSafeInteger(event.data.files) &&
        event.data.files! > 0
      )
        resolve(event.data.files!);
      else
        reject(
          new Error("未能完整保存离线词库，请检查网络或浏览器存储空间后重试。"),
        );
    };
    try {
      worker.postMessage({ type: "PREPARE_LEXICON" }, [channel.port2]);
    } catch {
      close();
      reject(new Error("离线服务无法连接，请刷新页面后重试。"));
    }
  });
}
