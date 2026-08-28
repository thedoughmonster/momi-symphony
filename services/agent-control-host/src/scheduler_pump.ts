import { randomUUID } from "node:crypto"

export type SchedulerPumpReceipt = {
  ok: true
  routes: number
  observed: number
  claimed: number
  technical_retries: number
  projection_retries: number
  projection_failures: number
}

export type SchedulerPumpConfiguration = {
  enabled: boolean
  intervalMs: number
  releaseSha: string | null
}

export function readSchedulerPumpConfiguration(
  environment: NodeJS.ProcessEnv,
): SchedulerPumpConfiguration {
  const enabled = environment.MOMI_AGENT_CONTROL_SCHEDULER_ENABLED?.trim() === "true"
  const configuredInterval = Number(
    environment.MOMI_AGENT_CONTROL_SCHEDULER_INTERVAL_MS ?? "15000",
  )
  const validInterval = Number.isInteger(configuredInterval) &&
    configuredInterval >= 10_000 && configuredInterval <= 60_000
  const releaseSha = environment.MOMI_AGENT_CONTROL_RELEASE_SHA?.trim() || null
  if (enabled && (!validInterval || !/^[0-9a-f]{40}$/.test(releaseSha ?? ""))) {
    throw new Error("agent_control_scheduler_configuration_invalid")
  }
  return { enabled, intervalMs: validInterval ? configuredInterval : 15_000, releaseSha }
}

export class SchedulerPump {
  private readonly callbackUrl: URL
  private readonly secret: string
  private readonly intervalMs: number
  private readonly activeWorkIds: () => string[]
  private readonly schedulerId: string
  private readonly releaseSha: string
  private readonly fetchImpl: typeof fetch
  private timer: NodeJS.Timeout | null = null
  private inFlight = false

  constructor(options: {
    callbackUrl: URL
    secret: string
    intervalMs: number
    activeWorkIds: () => string[]
    releaseSha: string
    schedulerId?: string
    fetchImpl?: typeof fetch
  }) {
    this.callbackUrl = options.callbackUrl
    this.secret = options.secret
    this.intervalMs = options.intervalMs
    this.activeWorkIds = options.activeWorkIds
    this.releaseSha = options.releaseSha
    this.schedulerId = options.schedulerId ?? randomUUID()
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  start(): void {
    if (this.timer) return
    void this.pump().catch(() => undefined)
    this.timer = setInterval(() => void this.pump().catch(() => undefined), this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async pump(): Promise<SchedulerPumpReceipt | null> {
    if (this.inFlight) return null
    this.inFlight = true
    try {
      const response = await this.fetchImpl(this.callbackUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event: "scheduler_pump",
          scheduler_id: this.schedulerId,
          release_sha: this.releaseSha,
          active_work_ids: this.activeWorkIds(),
        }),
        signal: AbortSignal.timeout(Math.min(this.intervalMs, 10_000)),
      })
      const body = await response.json().catch(() => null) as SchedulerPumpReceipt | null
      if (!response.ok || body?.ok !== true) throw new Error("scheduler_pump_failed")
      return body
    } finally {
      this.inFlight = false
    }
  }
}
