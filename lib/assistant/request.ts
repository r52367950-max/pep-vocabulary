import { readJsonObject, RequestBodyError, sameOriginRequest } from "../http";
import { authenticatedUserKey } from "../server-user";
import { AssistantInputError } from "./core";

// Only the gateway-derived identity can be used to open private provider settings.
export type AuthenticatedUserKey = string & { readonly authenticated: unique symbol };

export async function requireRequestUser(request: Request) {
  if (!sameOriginRequest(request)) throw new AssistantInputError("invalid_origin", "只允许同源请求。", 403);
  const userKey = await authenticatedUserKey();
  if (!userKey) throw new AssistantInputError("authentication_required", "请先登录站点。", 401);
  return userKey as AuthenticatedUserKey;
}

export async function readJsonRequest(request: Request, maximumBytes = 64_000) {
  try {
    return await readJsonObject(request, maximumBytes);
  } catch (error) {
    if (error instanceof RequestBodyError) throw new AssistantInputError("invalid_request", error.message, error.status);
    throw error;
  }
}
