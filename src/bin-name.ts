/**
 * Name used when suggesting follow-up commands (AXI principle 9).
 *
 * Deliberately a constant rather than `basename(process.argv[1])`. Suggestions
 * have to be runnable, and the runnable name is the package's `bin` entry —
 * whereas argv[1] is `jira-axi.js` for a direct `node dist/...` run, the vitest
 * binary under test, and the script path when the skill generator imports this
 * module. Principle 10's requirement to disclose the actual executable path is
 * met separately: the SDK prints it as `bin:` in the home view.
 */
export const BIN = "jira-axi";
