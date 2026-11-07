/**
 * A request's connection, taking one query at a time. Some screens ask for several things at once over the
 * request's one connection (Analytics' boards, Promise.all over req.db). pg queues them today but warns, and pg 9
 * refuses a second query while one runs; here they wait their turn in the order asked. Each caller still gets its
 * own answer or error, and one that fails never stops the next.
 */
export function oneAtATime<C extends { query: (...args: never[]) => unknown }>(client: C): C {
  let last: Promise<unknown> = Promise.resolve();
  const query = (...args: Parameters<C["query"]>) => {
    const run = last.then(() => client.query(...args));
    last = run.catch(() => undefined);
    return run;
  };
  return new Proxy(client, {
    get(target, key) {
      if (key === "query") return query;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
