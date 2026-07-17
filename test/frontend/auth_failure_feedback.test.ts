import * as fs from "node:fs";
import * as path from "node:path";

let failures = 0;
function assert(condition: unknown, message: string) {
  if (condition) console.log(`  ✓ ${message}`);
  else { failures++; console.error(`  ✗ ${message}`); }
}

const root = path.resolve(__dirname, "../..");
const api = fs.readFileSync(path.join(root, "web/src/api.ts"), "utf8");
const app = fs.readFileSync(path.join(root, "web/src/App.vue"), "utf8");
const palette = fs.readFileSync(path.join(root, "web/src/assets/palette.css"), "utf8");

assert(api.includes("confirmSessionFailure"), "401 starts a session verification request");
assert(api.includes("/auth/sessions/list?"), "session verification uses the authenticated session endpoint");
assert(api.includes('showError(i18n.global.t("common.sessionExpired"))'), "failed session verification shows an error toast");
assert(api.includes('await router.replace("/login")'), "failed session verification forces navigation to login");
assert(app.includes("activeToast"), "app renders the global toast channel");
assert(palette.includes("background: var(--color-bg-elevated);"), "toasts use an opaque background");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
