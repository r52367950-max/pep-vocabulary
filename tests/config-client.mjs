// Model a settings client that reads its account-bound view before mutating.
import { GET, POST as post, DELETE as remove } from '../app/api/ai/config/route.ts';
export { GET };
async function withView(request, mutate) {
  let body;
  try { body = request.body ? await request.clone().json() : {}; } catch { return mutate(request); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return mutate(request);
  if ('accountScope' in body) return mutate(request);
  const response = await GET();
  const { accountScope, generation, writeToken } = await response.json();
  if (!generation) return mutate(request);
  return mutate(new Request(request, { body: JSON.stringify({ accountScope, generation, writeToken, ...body }) }));
}
export const POST = request => withView(request, post);
export const DELETE = request => withView(request, remove);
