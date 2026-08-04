import { handleLearningAssistantRequest } from "@/lib/assistant/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleLearningAssistantRequest(request, "plan-study");
}
