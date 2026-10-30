import { getLearningMemory, putLearningMemory } from "@/lib/learning-memory/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return getLearningMemory(request); }
export async function PUT(request: Request) { return putLearningMemory(request); }
