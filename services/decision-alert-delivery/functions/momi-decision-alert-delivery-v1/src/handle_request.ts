import { handleRequestWithDependencies } from "./handle_request_with_dependencies.ts"

export function handleRequest(request: Request): Promise<Response> {
  return handleRequestWithDependencies(request)
}
