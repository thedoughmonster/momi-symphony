import "edge-runtime"
import { handleRequest } from "../../../services/agent-control/functions/momi-agent-control-linear-webhook-v1/src/handle_request.ts"

Deno.serve(handleRequest)
