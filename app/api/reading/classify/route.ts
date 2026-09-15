import { classifyImportedReading } from "@/lib/assistant/server";

export const dynamic = "force-dynamic";
export async function POST(request: Request) { return classifyImportedReading(request); }
