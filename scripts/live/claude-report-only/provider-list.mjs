// Fixture-copy preparation of the report-only provider list (t2-prepare.mjs F1).
//
// Two exact forms of dist/opencode/report-only.js are accepted:
//   historical  export const VERIFIED_REPORT_ONLY_PROVIDERS = [];               (before feature 0005)
//   final       export const VERIFIED_REPORT_ONLY_PROVIDERS = ['claude-code'];   (feature 0005 and later)
// The historical form is rewritten to the final value; the final form is already correct and left unchanged.
// Anything else (another value, none, or more than one declaration) is rejected. Only the text passed in is
// examined: the caller hands in the fixture COPY, never the installed provider or the repository dist.
export const HISTORICAL_PROVIDER_LIST = 'export const VERIFIED_REPORT_ONLY_PROVIDERS = [];';
export const FINAL_PROVIDER_LIST = "export const VERIFIED_REPORT_ONLY_PROVIDERS = ['claude-code'];";
const DECLARATION = /^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+VERIFIED_REPORT_ONLY_PROVIDERS\b.*$/gm;

export function prepareProviderList(source) {
  const declarations = [...source.matchAll(DECLARATION)];
  if (declarations.length !== 1) throw new Error(`Expected exactly one VERIFIED_REPORT_ONLY_PROVIDERS declaration, found ${declarations.length}`);
  const [match] = declarations;
  if (match[0] === FINAL_PROVIDER_LIST) return { found: 'claude-code', patched: false, text: source };
  if (match[0] === HISTORICAL_PROVIDER_LIST) {
    const replacement = `${FINAL_PROVIDER_LIST} // FIXTURE-ONLY (t2-prepare.mjs F1)`;
    return { found: 'empty', patched: true, text: source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length) };
  }
  throw new Error(`Unexpected VERIFIED_REPORT_ONLY_PROVIDERS declaration: ${match[0].trim().slice(0, 120)}`);
}
