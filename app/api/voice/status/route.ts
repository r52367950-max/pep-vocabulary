import { voiceStatus } from "@/lib/voice/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return voiceStatus(request);
}
