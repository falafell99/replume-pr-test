// Copy beside the workflow as .github/replume-pr-check-publish.mjs on the trusted base branch.
// This job reads only the verify result artifact; it never runs code from the PR checkout.
import { existsSync, readFileSync } from "node:fs";

const marker = "<!-- replume-pr-check -->";
const text = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/[<>`]/g, "").slice(0, 350);
const items = (entries) => entries.length ? entries.map((entry) => `- ${entry}`).join("\n") : "- None recorded.";

function result(reportPath, exitPath) {
  let report = null;
  try { if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { /* incomplete below */ }
  let exit = "";
  try { if (existsSync(exitPath)) exit = readFileSync(exitPath, "utf8").trim(); } catch { /* incomplete below */ }
  const expected = report?.verdict === "pass" ? "0" : report?.verdict === "fail" ? "1" : report?.verdict === "incomplete" ? "2" : "";
  const verdict = expected && exit === expected ? report.verdict.toUpperCase() : "INCOMPLETE";
  return { report: report && typeof report === "object" ? report : null, verdict,
    reason: verdict === "INCOMPLETE" && expected !== exit ? "Verification did not produce a usable, matching result." : "" };
}

export function commentBody(reportPath, exitPath) {
  const { report, verdict, reason } = result(reportPath, exitPath);
  const done = Array.isArray(report?.done) ? report.done : [];
  const failed = Array.isArray(report?.failed) ? report.failed : [];
  const extra = Array.isArray(report?.extra) ? report.extra : [];
  const tampering = Array.isArray(report?.tampering) ? report.tampering : [];
  const notChecked = Array.isArray(report?.notChecked) ? report.notChecked : [];
  const verified = done.map((entry) => `${text(entry.id)}: ${text(entry.evidence)}`);
  const failures = failed.map((entry) => `${text(entry.id)}: ${text(entry.evidence)}`);
  const beyond = [
    ...extra.map((entry) => `${text(entry.path)}: ${text(entry.reason)}${entry.informational ? " (information only)" : ""}`),
    ...tampering.map((entry) => `${text(entry.path)}: ${text(entry.detail)}`),
  ];
  const unchecked = [
    ...notChecked.map((entry) => `${text(entry.path)}: ${text(entry.reason)}`),
    "CI did not observe agent steps; this result covers the commit diff and checks run here.",
  ];
  if (reason) unchecked.unshift(reason);
  return [marker, `**Replume: ${verdict}**`, "",
    "## Verified", items(verified), "",
    ...(failures.length ? ["## Failed", items(failures), ""] : []),
    "## Changed beyond the task", items(beyond), "",
    "## Not checked", items(unchecked), "",
    "_Tests ran in an isolated working copy. This comment was made from the saved CI result; it did not rerun verification._",
  ].join("\n");
}

async function api(path, method, token, body) {
  const base = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} returned HTTP ${response.status}`);
  return response.json();
}

export async function publish(env = process.env) {
  const repo = env.GITHUB_REPOSITORY, pr = Number(env.PR_NUMBER), sha = env.HEAD_SHA, token = env.GITHUB_TOKEN;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? "") || !Number.isSafeInteger(pr) || pr < 1 || !/^[a-fA-F0-9]{40}$/.test(sha ?? "") || !token)
    throw new Error("Missing or invalid GitHub repository, PR, head SHA, or token");
  const reportPath = env.REPLUME_REPORT || "replume-ci/report.json";
  const exitPath = env.REPLUME_VERIFY_EXIT_FILE || "replume-ci/exit.txt";
  const body = commentBody(reportPath, exitPath);
  const verdict = result(reportPath, exitPath).verdict;
  let existing = null;
  for (let page = 1; page <= 20; page++) {
    const comments = await api(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`, "GET", token);
    if (!Array.isArray(comments)) throw new Error("GitHub comments response was not a list");
    existing = comments.find((entry) => entry?.body?.startsWith(marker) && entry?.user?.login === "github-actions[bot]") ?? null;
    if (existing || comments.length < 100) break;
  }
  if (existing) await api(`/repos/${repo}/issues/comments/${existing.id}`, "PATCH", token, { body });
  else await api(`/repos/${repo}/issues/${pr}/comments`, "POST", token, { body });
  const conclusion = verdict === "PASS" ? "success" : verdict === "FAIL" ? "failure" : "neutral";
  await api(`/repos/${repo}/check-runs`, "POST", token, {
    name: "Replume / task", head_sha: sha, status: "completed", conclusion,
    output: { title: `Replume: ${verdict}`, summary: body.slice(0, 60000) },
  });
  process.stdout.write(`Replume: ${verdict}; ${existing ? "updated" : "posted"} one PR comment; check ${conclusion}.\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  publish().catch((error) => { process.stderr.write(`replume-pr-check: ${error.message}\n`); process.exitCode = 1; });
}
