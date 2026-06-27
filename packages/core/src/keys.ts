/**
 * Encode a single key component so the "::" join separator can never collide
 * across boundaries. We percent-encode "%" FIRST (so it can act as the escape
 * char without ambiguity) then ":" — after which no component can contain a raw
 * ":" and thus no raw "::". Order matters: encoding "%" before ":" guarantees
 * the transform is reversible and collision-free across namespace/tenant/key/tag.
 */
function encodeComponent(component: string): string {
  return component.replace(/%/g, "%25").replace(/:/g, "%3A");
}

export function scopeKey(namespace: string, key: string, tenant?: string): string {
  const ns = encodeComponent(namespace);
  const k = encodeComponent(key);
  return tenant ? `${ns}::tenant:${encodeComponent(tenant)}::${k}` : `${ns}::${k}`;
}

export function scopeTag(namespace: string, tag: string, tenant?: string): string {
  const ns = encodeComponent(namespace);
  const t = encodeComponent(tag);
  return tenant ? `${ns}::tenant:${encodeComponent(tenant)}::tag:${t}` : `${ns}::tag:${t}`;
}

export function scopePrefix(namespace: string, tenant?: string): string {
  const ns = encodeComponent(namespace);
  return tenant ? `${ns}::tenant:${encodeComponent(tenant)}` : ns;
}
