import "edge-runtime"
import { handleRequest } from "../../../services/decision-alert-delivery/functions/momi-decision-alert-delivery-v1/src/handle_request.ts"

Deno.serve(handleRequest)
