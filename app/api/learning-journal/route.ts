import { getJournal, writeJournal } from "@/lib/learning-journal/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return getJournal(request); }
export async function POST(request: Request) { return writeJournal(request,"POST"); }
export async function PUT(request: Request) { return writeJournal(request,"PUT"); }
export async function DELETE(request: Request) { return writeJournal(request,"DELETE"); }
