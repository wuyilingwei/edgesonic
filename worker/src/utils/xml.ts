type XMLValue = string | number | boolean | null | undefined | Record<string, unknown> | XMLValue[];

interface XMLNodeData {
  _attributes?: Record<string, string | number | boolean | undefined>;
}

export function toXML(node: Record<string, unknown>): string {
  const rootKey = Object.keys(node)[0];
  const rootVal = node[rootKey] as Record<string, unknown> | undefined;

  const attrs = rootVal ? (rootVal._attributes as Record<string, string | number | boolean | undefined>) : undefined;
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<${rootKey}`;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined && v !== null) xml += ` ${k}="${esc(String(v))}"`;
    }
  }
  xml += ">";

  if (rootVal) {
    for (const [k, v] of Object.entries(rootVal)) {
      if (k === "_attributes") continue;
      xml += buildElement(k, v);
    }
  }

  xml += `</${rootKey}>`;
  return xml;
}

function buildElement(key: string, value: unknown): string {
  if (value === undefined || value === null) return "";

  if (Array.isArray(value)) {
    return value.map((item) => buildElement(key, item)).join("");
  }

  if (typeof value === "object" && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    const attrs = obj._attributes as Record<string, string | number | boolean | undefined> | undefined;
    let el = `<${key}`;
    if (attrs) {
      for (const [ak, av] of Object.entries(attrs)) {
        if (av !== undefined && av !== null) el += ` ${ak}="${esc(String(av))}"`;
      }
    }

    const childKeys = Object.keys(obj).filter((k) => k !== "_attributes");
    if (childKeys.length === 0 && attrs) {
      el += "/>";
    } else {
      el += ">";
      for (const ck of childKeys) {
        el += buildElement(ck, obj[ck]);
      }
      el += `</${key}>`;
    }
    return el;
  }

  return `<${key}>${esc(String(value))}</${key}>`;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function subsonicOK(inner: Record<string, unknown>, version = "1.16.1"): string {
  return toXML({
    "subsonic-response": {
      _attributes: {
        xmlns: "http://subsonic.org/restapi",
        status: "ok",
        version,
      },
      ...inner,
    },
  });
}
