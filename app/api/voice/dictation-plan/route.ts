import { planDictation } from '@/lib/voice/dictation-server';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return planDictation(request); }
