'use strict';

/**
 * Tool registry + router.
 *
 * Every tool is declared with a JSON-Schema parameter contract, a category,
 * a risk level and an optional `confirm` predicate. The router enforces:
 *  - category must be enabled in settings
 *  - arguments must validate against the schema
 *  - destructive tools emit a confirmation request to the UI and are only
 *    executed after an explicit, token-matched user approval
 */

const { randomUUID } = require('crypto');

const RISK = Object.freeze({ READ: 'read', WRITE: 'write', DESTRUCTIVE: 'destructive', SYSTEM: 'system' });

class ToolError extends Error {
  constructor(message, code) { super(message); this.name = 'ToolError'; this.code = code || 'E_TOOL'; }
}
class ValidationError extends ToolError {
  constructor(msg, detail) { super(msg, 'E_VALIDATION'); this.name = 'ValidationError'; this.detail = detail || null; }
}
class PermissionDenied extends ToolError {
  constructor(msg) { super(msg, 'E_PERMISSION'); this.name = 'PermissionDenied'; }
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validate(schema, value, pathStr) {
  const p = pathStr || 'value';
  if (schema.type) {
    const t = schema.type;
    const actual = typeOf(value);
    const ok = Array.isArray(t) ? t.includes(actual) : t === actual;
    if (!ok) throw new ValidationError(`"${p}" must be ${Array.isArray(t) ? t.join(' or ') : t} (got ${actual}).`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ValidationError(`"${p}" must be one of: ${schema.enum.join(', ')}.`);
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.type === 'integer' && !Number.isInteger(value)) throw new ValidationError(`"${p}" must be a whole number.`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new ValidationError(`"${p}" must be >= ${schema.minimum}.`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new ValidationError(`"${p}" must be <= ${schema.maximum}.`);
  }
  if (schema.type === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new ValidationError(`"${p}" must be at least ${schema.minLength} characters.`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new ValidationError(`"${p}" must be at most ${schema.maxLength} characters.`);
    }
  }
  if (schema.type === 'object' && schema.properties) {
    const out = {};
    for (const key of Object.keys(schema.properties)) out[key] = value[key];
    for (const req of (schema.required || [])) {
      if (value[req] === undefined || value[req] === null || value[req] === '') {
        throw new ValidationError(`"${p}.${req}" is required.`);
      }
      out[req] = validate(schema.properties[req], value[req], `${p}.${req}`);
    }
    for (const key of Object.keys(value)) {
      if (key in schema.properties) continue;
      if (schema.additionalProperties === false) continue;
      if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        out[key] = validate(schema.additionalProperties, value[key], `${p}.${key}`);
      }
    }
    return out;
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    return value.map((v, i) => validate(schema.items, v, `${p}[${i}]`));
  }
  return value;
}

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool || typeof tool.name !== 'string' || typeof tool.handler !== 'function') {
      throw new ToolError('A tool needs a name and a handler.');
    }
    if (this.tools.has(tool.name)) throw new ToolError(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, Object.assign({
      category: 'system',
      risk: RISK.READ,
      description: '',
      parameters: { type: 'object', properties: {} },
      confirm: null
    }, tool));
    return this;
  }

  get(name) { return this.tools.get(name) || null; }
  list() { return Array.from(this.tools.values()); }

  /** Compact catalogue for the model's tool-calling prompt. */
  catalogue(allowedCategories) {
    return this.list()
      .filter((t) => allowedCategories.includes(t.category))
      .map((t) => ({
        name: t.name,
        category: t.category,
        risk: t.risk,
        description: t.description,
        parameters: t.parameters
      }));
  }

  validateArgs(tool, args) {
    const raw = args && typeof args === 'object' ? args : {};
    return validate(tool.parameters, raw, tool.name);
  }
}

module.exports = { ToolRegistry, ToolError, ValidationError, PermissionDenied, RISK, validate };
