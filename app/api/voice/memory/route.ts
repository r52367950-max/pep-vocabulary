import { getVoiceMemory, putVoiceMemory } from "@/lib/voice/coach-server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return getVoiceMemory(request); }
export async function PUT(request: Request) { return putVoiceMemory(request); }
