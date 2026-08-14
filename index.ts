import "edge-runtime"
import { handleRequest } from "../../../services/agent-control/functions/momi-agent-control-dispatch-v1/src/handle_request.ts"

Deno.serve(handleRequest)
