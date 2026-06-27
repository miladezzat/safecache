# Stale While Revalidate

Stale-while-revalidate lets SafeCache return an expired but still acceptable value while refreshing
that key in the background.

## When to use it

Use stale values for data where low latency matters more than perfect freshness:

- public profile cards
- product catalog metadata
- feature configuration with short TTLs
- expensive read models that tolerate brief staleness

Avoid stale values for balances, permissions, security decisions, or any path that requires strict
read-after-write behavior.

## Query example

```ts
const profile = await cache.query({
  key: `profile:${id}`,
  tags: [`profile:${id}`, "profiles"],
  ttl: "2m",
  staleWhileRevalidate: "30s",
  fetcher: () => profileRepo.findPublicProfile(id),
});
```

After the TTL expires, SafeCache may return the old value during the stale window and refresh in the
background.

## Operational notes

- Stale behavior is opt-in per query.
- Mutation invalidation still removes stale entries.
- Refresh errors emit runtime error events.
- Use metrics to track `cache_stale_served_total`.

## Common mistakes

- Enabling stale reads globally without classifying data.
- Using stale reads for authorization or money movement.
- Forgetting to monitor refresh errors.
- Setting stale windows much longer than the underlying data can tolerate.

## Related docs

- [Safety model](safety-model.md)
- [Metrics](metrics.md)
- [Stampede prevention](stampede-prevention.md)
