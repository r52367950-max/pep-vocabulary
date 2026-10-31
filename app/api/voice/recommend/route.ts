import { recommendVoicePractice } from "@/lib/voice/coach-server";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return recommendVoicePractice(request); }
