import { closeVoiceSession } from "@/lib/voice/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return closeVoiceSession(request);
}
