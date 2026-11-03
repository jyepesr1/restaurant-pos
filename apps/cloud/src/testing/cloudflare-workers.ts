// Stands in for `cloudflare:workers` in the Node tests (alias in vitest.config.ts): the Durable
// Object base class only keeps `ctx` and `env`, as the real one does. The tests do not run workerd.

export abstract class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState
  protected env: Env
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}
