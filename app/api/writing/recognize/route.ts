import { recognizeWriting } from '@/lib/writing-recognition-server';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return recognizeWriting(request); }
