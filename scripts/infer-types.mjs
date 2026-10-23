// Turns JSON samples into a TypeScript type, merging several samples of the same endpoint.
const ID_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** A merged description of every value seen. */
function empty() {
  return { n: 0, kinds: new Set(), fields: null, items: null, examples: new Set() };
}

export function observe(node, value) {
  node.n++;
  if (value === null) return void node.kinds.add('null');
  if (Array.isArray(value)) {
    node.kinds.add('array');
    node.items ??= empty();
    for (const item of value) observe(node.items, item);
    return;
  }
  if (typeof value === 'object') {
    node.kinds.add('object');
    node.fields ??= new Map();
    for (const [key, v] of Object.entries(value)) {
      if (!node.fields.has(key)) node.fields.set(key, empty());
      observe(node.fields.get(key), v);
    }
    node.objects = (node.objects ?? 0) + 1;
    for (const key of Object.keys(value)) node.fields.get(key).seen = (node.fields.get(key).seen ?? 0) + 1;
    return;
  }
  node.kinds.add(typeof value);
  if (typeof value === 'string' && node.examples.size < 6) node.examples.add(value);
}

const quote = (key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));

/** TypeScript source for a merged node. */
export function render(node, indent = '', depth = 0) {
  const parts = [];
  const kinds = [...node.kinds];
  for (const kind of kinds) {
    if (kind === 'array') {
      const inner = node.items.n ? render(node.items, indent, depth + 1) : 'unknown';
      parts.push(/[|]/.test(inner) && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`);
    } else if (kind === 'object') {
      const keys = [...node.fields.keys()];
      if (keys.length > 10 && keys.every((k) => ID_KEY.test(k))) {
        const merged = empty();
        for (const f of node.fields.values()) {
          merged.n += f.n;
          for (const k of f.kinds) merged.kinds.add(k);
          merged.fields = mergeMaps(merged.fields, f.fields);
          merged.items = merged.items ?? f.items;
        }
        parts.push(`Record<string, ${render(merged, indent, depth + 1)}>`);
      } else if (!keys.length) {
        parts.push('Record<string, unknown>');
      } else if (depth > 8) {
        parts.push('Record<string, unknown>');
      } else {
        const inner = `${indent}  `;
        const lines = keys.map((k) => {
          const f = node.fields.get(k);
          const optional = f.seen < node.objects ? '?' : '';
          const example = f.kinds.has('string') && f.examples.size && f.examples.size <= 4 && f.kinds.size === 1 && keys.length < 60
            ? `  // e.g. ${[...f.examples].map((e) => JSON.stringify(e.length > 24 ? `${e.slice(0, 24)}…` : e)).join(', ')}`
            : '';
          return `${inner}${quote(k)}${optional}: ${render(f, inner, depth + 1)};${example}`;
        });
        parts.push(`{\n${lines.join('\n')}\n${indent}}`);
      }
    } else {
      parts.push(kind);
    }
  }
  return parts.length ? parts.join(' | ') : 'unknown';
}

function mergeMaps(a, b) {
  if (!b) return a;
  const out = a ?? new Map();
  for (const [k, v] of b) {
    if (!out.has(k)) out.set(k, v);
    else {
      const t = out.get(k);
      t.n += v.n;
      for (const kind of v.kinds) t.kinds.add(kind);
      t.seen = (t.seen ?? 0) + (v.seen ?? 0);
      t.items ??= v.items;
      t.fields = mergeMaps(t.fields, v.fields);
    }
  }
  return out;
}

/** `export type Name = …;` for one or more samples. */
export function inferType(name, samples) {
  const node = empty();
  for (const sample of samples) observe(node, sample);
  return `export type ${name} = ${render(node)};`;
}

export const pascal = (text) => text.replace(/(^|[-_ ]+)(\w)/g, (_, __, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, '');
