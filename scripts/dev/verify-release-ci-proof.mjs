/**
 * Release CI proof: the commit being released must have PASSED CI on `main`.
 *
 * Why this exists (2026-09 CI-trigger revision): ci.yml used to trigger on tag
 * pushes too. The linux chain stepped aside for tags (release.yml's validation
 * is its mechanical superset) but the Windows leg deliberately kept running,
 * because release.yml has no win32-semantics leg. On this repository's flow the
 * tag always points at a commit that was pushed to `main` first, so that tag run
 * only repeated work on the identical SHA — while leaving a hole: tagging a
 * commit that never went through `main` skipped the linux chain entirely, so
 * "a release cannot ship an untested commit" rested on procedure, not on an
 * assertion.
 *
 * This gate replaces the re-run with the proof, and closes the hole: the release
 * commit must carry a COMPLETED, SUCCESSFUL `ci.yml` push run on `main` whose
 * `test` and `test-windows` jobs both succeeded. A run still in progress is
 * waited for (a release may be tagged seconds after the push); a failed run, a
 * commit that never went through `main`, or anything still unresolved at the
 * deadline fails closed.
 *
 * Usage:
 *   node scripts/dev/verify-release-ci-proof.mjs --sha <commit>
 *        [--repo owner/name] [--workflow ci.yml] [--branch main]
 *        [--wait-ms 1800000] [--poll-ms 20000]
 *
 * `--repo` defaults to GITHUB_REPOSITORY (set by Actions), the token to
 * GITHUB_TOKEN / GH_TOKEN (optional on public repositories, but GitHub
 * rate-limits anonymous callers — release.yml passes the runner's own read-only
 * token, which is not a release credential).
 */
import { argv, env, exit } from 'node:process'

/** Jobs that must have concluded `success` on the proven run: the linux chain
 *  (release.yml's mechanical superset is validated against it) and the Windows
 *  contract leg release.yml has no equivalent of. */
export const REQUIRED_JOBS = ['test', 'test-windows']

/**
 * Pick the candidate proof runs for one commit: push runs on the base branch,
 * newest first. Other events (pull_request) and other branches never prove a
 * release — a PR run may have skipped or split the chain.
 * @param runs - `/actions/workflows/<wf>/runs` entries.
 * @param facts - `{ sha, branch }` the release must be proven for.
 * @returns matching runs, newest first.
 */
export function pickCandidateRuns(runs, { sha, branch }) {
  return (Array.isArray(runs) ? runs : [])
    .filter(run => run !== null && typeof run === 'object')
    .filter(run => run.head_sha === sha && run.event === 'push' && run.head_branch === branch)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
}

/**
 * Judge ONE run against its jobs. Pure, so the policy suite can cover every arm
 * without a network or a runner.
 * @param run - the run entry (needs `status`, `conclusion`, `html_url`).
 * @param jobs - that run's job entries (needs `name`, `conclusion`).
 * @param requiredJobs - job names that must all be `success`.
 * @returns `{ state: 'ok' | 'pending' | 'failed', reason }`.
 */
export function judgeRun(run, jobs, requiredJobs = REQUIRED_JOBS) {
  const url = typeof run?.html_url === 'string' ? run.html_url : '(no url)'
  if (run === null || typeof run !== 'object') return { state: 'failed', reason: 'run entry missing' }
  if (run.status !== 'completed') return { state: 'pending', reason: `run ${url} is ${run.status}` }
  if (run.conclusion !== 'success') return { state: 'failed', reason: `run ${url} concluded ${run.conclusion}` }
  const byName = new Map((Array.isArray(jobs) ? jobs : [])
    .filter(job => job !== null && typeof job === 'object')
    .map(job => [job.name, job]))
  for (const name of requiredJobs) {
    const job = byName.get(name)
    if (job === undefined) return { state: 'failed', reason: `run ${url} has no ${name} job (chain incomplete)` }
    if (job.conclusion !== 'success') {
      return { state: 'failed', reason: `run ${url} job ${name} concluded ${job.conclusion}` }
    }
  }
  return { state: 'ok', reason: `run ${url} passed ${requiredJobs.join(' + ')}` }
}

/**
 * Judge every candidate run: the strongest verdict wins, so a flaky failure that
 * was re-run green still proves the commit (the proof is "a full green chain
 * exists"), while a pending run keeps the caller waiting instead of failing.
 * @param candidates - `pickCandidateRuns` output.
 * @param jobsByRunId - `Map<runId, jobs>` for the runs that already completed.
 * @param requiredJobs - job names that must all be `success`.
 * @returns `{ state, reason }` — `pending` when no candidate has concluded.
 */
export function judgeCandidates(candidates, jobsByRunId, requiredJobs = REQUIRED_JOBS) {
  if (candidates.length === 0) return { state: 'pending', reason: 'no ci.yml push run on the base branch yet' }
  const verdicts = candidates.map(run => judgeRun(run, jobsByRunId.get(run.id), requiredJobs))
  const ok = verdicts.find(verdict => verdict.state === 'ok')
  if (ok !== undefined) return ok
  if (verdicts.some(verdict => verdict.state === 'pending')) {
    return { state: 'pending', reason: verdicts.find(verdict => verdict.state === 'pending').reason }
  }
  return { state: 'failed', reason: verdicts.map(verdict => verdict.reason).join('; ') }
}

/** Parse the CLI flags (kept tiny: no dependency, no config file). */
export function parseArgs(args) {
  const options = {
    sha: '',
    repo: env.GITHUB_REPOSITORY ?? '',
    workflow: 'ci.yml',
    branch: 'main',
    waitMs: 30 * 60 * 1000,
    pollMs: 20 * 1000,
  }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag.startsWith('--')) throw new Error(`unexpected argument ${JSON.stringify(flag)}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    index += 1
    if (flag === '--sha') options.sha = value
    else if (flag === '--repo') options.repo = value
    else if (flag === '--workflow') options.workflow = value
    else if (flag === '--branch') options.branch = value
    else if (flag === '--wait-ms') options.waitMs = Number(value)
    else if (flag === '--poll-ms') options.pollMs = Number(value)
    else throw new Error(`unknown flag ${flag}`)
  }
  if (!/^[0-9a-f]{40}$/.test(options.sha)) throw new Error('--sha must be a full 40-hex commit')
  if (!/^[^/]+\/[^/]+$/.test(options.repo)) throw new Error('--repo must be owner/name (or set GITHUB_REPOSITORY)')
  if (!Number.isFinite(options.waitMs) || options.waitMs < 0) throw new Error('--wait-ms must be a non-negative number')
  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) throw new Error('--poll-ms must be a positive number')
  return options
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function api(path, token) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  if (token !== '') headers.authorization = `Bearer ${token}`
  const response = await fetch(`https://api.github.com${path}`, { headers })
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`)
  return response.json()
}

async function main() {
  const options = parseArgs(argv.slice(2))
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN ?? ''
  const deadline = Date.now() + options.waitMs
  let last = 'no poll yet'
  for (;;) {
    const runs = (await api(
      `/repos/${options.repo}/actions/workflows/${options.workflow}/runs?head_sha=${options.sha}&per_page=50`,
      token,
    )).workflow_runs
    const candidates = pickCandidateRuns(runs, { sha: options.sha, branch: options.branch })
    const jobsByRunId = new Map()
    for (const run of candidates) {
      if (run.status !== 'completed') continue
      const jobs = (await api(`/repos/${options.repo}/actions/runs/${run.id}/jobs?per_page=100`, token)).jobs
      jobsByRunId.set(run.id, jobs)
    }
    const verdict = judgeCandidates(candidates, jobsByRunId)
    if (verdict.state === 'ok') {
      console.log(`release CI proof: OK — ${verdict.reason}`)
      return
    }
    last = verdict.reason
    if (verdict.state === 'failed') {
      console.error(`release CI proof: FAILED — ${last}`)
      console.error(`  commit ${options.sha} must have a successful ${options.workflow} push run on ${options.branch};`)
      console.error('  wait for CI, then re-run this release.')
      exit(1)
    }
    if (Date.now() >= deadline) {
      console.error(`release CI proof: FAILED — still unresolved after ${Math.round(options.waitMs / 1000)}s: ${last}`)
      console.error(`  commit ${options.sha} has no successful ${options.workflow} push run on ${options.branch}.`)
      exit(1)
    }
    console.log(`release CI proof: waiting — ${last}`)
    await sleep(options.pollMs)
  }
}

if (import.meta.url === `file://${argv[1]}`) {
  try {
    await main()
  } catch (error) {
    console.error(`release CI proof: FAILED — ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  }
}
