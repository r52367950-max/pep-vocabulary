import { recognizeDictation } from '@/lib/voice/dictation-server';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return recognizeDictation(request); }
