import { generateWritingTopic } from '@/lib/writing-topic-server';
export const dynamic='force-dynamic';
export async function POST(request:Request){return generateWritingTopic(request);}
