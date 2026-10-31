import { prepareLiveDictation } from '@/lib/voice/live-learning-tools';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { return prepareLiveDictation(request); }
