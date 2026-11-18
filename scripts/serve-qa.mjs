import { localWorker } from './local-worker.mjs';
const worker=await localWorker();
console.log(`QA_URL=${worker.ready}`);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{await worker.close();process.exit(0);});
