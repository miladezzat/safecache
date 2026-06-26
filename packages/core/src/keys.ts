export function scopeKey(namespace: string, key: string, tenant?: string): string {
  return tenant ? `${namespace}::tenant:${tenant}::${key}` : `${namespace}::${key}`;
}

export function scopeTag(namespace: string, tag: string, tenant?: string): string {
  return tenant ? `${namespace}::tenant:${tenant}::tag:${tag}` : `${namespace}::tag:${tag}`;
}

export function scopePrefix(namespace: string, tenant?: string): string {
  return tenant ? `${namespace}::tenant:${tenant}` : namespace;
}
