// P0 SECURITY (Cloud, Day 227, obs 7df70723): a `/* ... */` comment written INSIDE a template
// literal that reaches a Response body is served, verbatim, publicly, unauthenticated. This has
// now leaked THREE times (d4f48795, 7df70723's own predecessor, and 7df70723 itself) on nothing
// but the discipline of "never put a comment inside the backticks" -- a rule that has already
// failed three times and will fail again, because nothing enforces it except a human remembering.
//
// So: every served CSS/JS string is passed through this at MODULE LOAD, once, before the
// constant is ever read -- a comment that slips back inside a template literal can no longer
// reach a browser BY CONSTRUCTION, regardless of whether anyone remembered the rule.
//
// Deliberately dumb and CSS/JS-comment-shaped only (`/* ... */`), not a general sanitizer: it
// does not touch `//` line comments (several served JS strings use `://` inside real URLs, and a
// naive `//`-strip would corrupt them) and does not touch HTML `<!-- -->` comments (a different
// syntax, not what Cloud's ruling named). Scope matches exactly what was asked: "strip every
// /* */ comment from SITE_CSS and every served CSS or JS string."
export function stripServedComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}
