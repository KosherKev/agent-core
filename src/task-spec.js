import { validate } from './validators.js';

/**
 * The one rule a schema cannot express: when both `grant_ref` and an embedded `grant` with a `task_id` are present,
 * they must be equal. Returns { valid, errors }. Does not run the schema.
 */
export function checkGrantRef(spec) {
  const ref = spec && spec.grant_ref;
  const id = spec && spec.grant && spec.grant.task_id;
  if (ref !== undefined && id !== undefined && ref !== id) {
    return { valid: false, errors: [`/grant_ref "${ref}" does not match /grant/task_id "${id}"`] };
  }
  return { valid: true, errors: [] };
}

/**
 * Validate a task spec: the schema first (its errors are returned as is), then checkGrantRef.
 * The v1 schema already refuses a spec that carries both `grant` and `grant_ref`, so today the cross-check
 * only matters if that rule is ever relaxed or a caller passes the pieces separately; `schemaCheck` lets a test
 * (or such a caller) supply the schema step.
 */
export function validateTaskSpec(spec, schemaCheck = (s) => validate('task-spec', s)) {
  const r = schemaCheck(spec);
  if (!r.valid) return r;
  return checkGrantRef(spec);
}
