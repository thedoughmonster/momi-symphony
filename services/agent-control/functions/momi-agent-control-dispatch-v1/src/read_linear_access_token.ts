export function readLinearAccessToken(): string {
  const installed = Deno.env.get("LINEAER_ACCESS")?.trim() ?? ""
  return installed || Deno.env.get("LINEAR_API_KEY")?.trim() || ""
}
