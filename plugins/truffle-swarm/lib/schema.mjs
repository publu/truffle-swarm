// One field description serves three consumers: CLI flag parsing, MCP input
// schemas, and validation. truffle-plugin kept these in three places and they
// drifted, so here a field is declared once and derived everywhere.

const PATTERNS = {
  id: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/,
  page: /^[a-z0-9][a-z0-9/_-]{0,119}$/,
  room: /^[a-z0-9-]{1,40}$/,
};

/** A single operation input. `field(type, options)` keeps declarations short. */
export function field(type, options = {}) {
  return { type, ...options };
}

function fail(name, advice) {
  throw Error(`${name}: ${advice}`);
}

function coerceOne(name, spec, raw) {
  switch (spec.type) {
    case "string": {
      const value = String(raw);
      if (!value && spec.required) fail(name, "must not be empty.");
      if (spec.max && value.length > spec.max)
        fail(name, `must be ${spec.max} characters or fewer (got ${value.length}).`);
      return value;
    }
    case "id":
    case "page":
    case "room": {
      const value = String(raw);
      if (!PATTERNS[spec.type].test(value))
        fail(
          name,
          spec.type === "page"
            ? "must be a lowercase page path such as decisions/api-shape."
            : spec.type === "room"
              ? "must be a lowercase room name such as general."
              : "must be a short identifier without spaces.",
        );
      return value;
    }
    case "integer": {
      const value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isSafeInteger(value)) fail(name, "must be a whole number.");
      if (spec.min !== undefined && value < spec.min) fail(name, `must be at least ${spec.min}.`);
      if (spec.max !== undefined && value > spec.max) fail(name, `must be at most ${spec.max}.`);
      return value;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "") return true;
      if (raw === "false") return false;
      return fail(name, "must be true or false.");
    case "enum": {
      const value = String(raw);
      if (!spec.values.includes(value)) fail(name, `must be one of ${spec.values.join(", ")}.`);
      return value;
    }
    case "url": {
      const value = String(raw);
      if (!/^https?:\/\/\S+$/.test(value) || value.length > 1000)
        fail(name, "must be an http(s) URL that others can open.");
      return value;
    }
    default:
      throw Error(`Unknown field type ${spec.type}`);
  }
}

/** Validate and coerce one operation's inputs. Unknown keys are refused. */
export function validate(inputs, raw) {
  const result = {};
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(inputs, key)) throw Error(`Unknown option ${key}.`);
  }
  for (const [key, spec] of Object.entries(inputs)) {
    const present = raw[key] !== undefined && raw[key] !== null;
    if (!present) {
      if (spec.required) throw Error(`Missing ${key}.`);
      if (spec.default !== undefined) result[key] = structuredClone(spec.default);
      continue;
    }
    if (spec.list) {
      const items = Array.isArray(raw[key]) ? raw[key] : String(raw[key]).split(",").filter(Boolean);
      if (spec.max && items.length > spec.max) throw Error(`${key}: at most ${spec.max} entries.`);
      result[key] = items.map((item) => coerceOne(key, { ...spec, list: false, max: spec.itemMax }, item));
      continue;
    }
    result[key] = coerceOne(key, spec, raw[key]);
  }
  return result;
}

const JSON_TYPES = { string: "string", id: "string", page: "string", room: "string", url: "string", enum: "string", integer: "integer", boolean: "boolean" };

function jsonForField(spec) {
  const leaf = { type: JSON_TYPES[spec.type] };
  if (spec.type === "enum") leaf.enum = spec.values;
  if (spec.type === "page") leaf.pattern = PATTERNS.page.source;
  if (spec.type === "room") leaf.pattern = PATTERNS.room.source;
  if (spec.type === "url") leaf.format = "uri";
  if (spec.type === "integer") {
    if (spec.min !== undefined) leaf.minimum = spec.min;
    if (spec.max !== undefined) leaf.maximum = spec.max;
  } else if (spec.max !== undefined && !spec.list) leaf.maxLength = spec.max;
  if (spec.list) {
    const wrapper = { type: "array", items: { ...leaf, ...(spec.itemMax ? { maxLength: spec.itemMax } : {}) } };
    if (spec.max !== undefined) wrapper.maxItems = spec.max;
    return wrapper;
  }
  return leaf;
}

/** Derive a JSON Schema object for MCP tool registration. */
export function jsonSchema(inputs) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(inputs)) {
    properties[key] = { ...jsonForField(spec), ...(spec.description ? { description: spec.description } : {}) };
    if (spec.default !== undefined) properties[key].default = spec.default;
    if (spec.required) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** Render one operation's flags for `help` output. */
export function usage(name, inputs) {
  const parts = Object.entries(inputs).map(([key, spec]) => {
    const flag = `--${spec.flag ?? key} ${spec.type === "boolean" ? "" : key.toUpperCase()}`.trim();
    return spec.required && !spec.cliOptional ? flag : `[${flag}]`;
  });
  return [name, ...parts].join(" ");
}
