/**
 * Pure helpers for parsing repeatable step flags (`--click`, `--type`,
 * `--wait`) on the `quick` CLI command. Kept in its own module so the
 * parsers are unit-testable without importing cli/index.ts (which has a
 * top-level `program.parseAsync(process.argv)` side effect).
 */

/**
 * Split a `--type` argument of the form `<selector>=<text>` at the first
 * `=` that lies *outside* any `[...]` bracket pair. Attribute-matcher
 * selectors like `textarea[aria-label="Search"]` carry their own `=`
 * inside the brackets; a naïve `indexOf("=")` would slice the selector
 * mid-attribute.
 *
 * Returns `null` when there is no usable separator (no out-of-bracket `=`,
 * empty selector, or empty value).
 */
export function splitTypeArg(val: string): [string, string] | null {
  let bracket = 0;
  for (let i = 0; i < val.length; i++) {
    const c = val[i];
    if (c === "[") bracket++;
    else if (c === "]") bracket--;
    else if (c === "=" && bracket === 0) {
      if (i === 0 || i === val.length - 1) return null;
      return [val.slice(0, i), val.slice(i + 1)];
    }
  }
  return null;
}
