import { handleAssistantRequest } from "@/lib/assistant/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleAssistantRequest(request, "contrast-words");
}
