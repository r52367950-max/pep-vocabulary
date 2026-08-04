import { testAssistantConnection } from "@/lib/assistant/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return testAssistantConnection(request);
}
