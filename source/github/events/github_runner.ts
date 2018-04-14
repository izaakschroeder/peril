import * as express from "express"
import winston from "../../logger"

import { PERIL_BOT_USER_ID } from "../../globals"

import { DangerResults } from "danger/distribution/dsl/DangerResults"
import { GitHub } from "danger/distribution/platforms/GitHub"
import { GitHubAPI } from "danger/distribution/platforms/github/GitHubAPI"

import vm2 from "danger/distribution/runner/runners/vm2"
import { getTemporaryAccessTokenForInstallation } from "../../api/github"
import { DangerRun, dangerRunForRules, dsl, feedback } from "../../danger/danger_run"
import { executorForInstallation, runDangerForInstallation } from "../../danger/danger_runner"
import perilPlatform from "../../danger/peril_platform"
import { GitHubInstallation, GithubRepo } from "../../db"
import { getDB } from "../../db/getDB"
import { GitHubInstallationSettings } from "../../db/GitHubRepoSettings"
import logger from "../../logger"
import { Pull_request } from "../events/types/pull_request_opened.types"
import { canUserWriteToRepo, getGitHubFileContents } from "../lib/github_helpers"
import { createPRDSL } from "./createPRDSL"

/**
 * So, these function have a bunch of responsibilities.
 *
 *  - Validating there is an installation ref in the db
 *  - Generating runs for an installation, could be up to two (org + repo) per integration event
 *  - Going from a run to executing Danger for that run
 *  - Handling the varients in a Danger run
 *
 *    - Event is org based (no repo, DSL is event JSON)
 *    - Event is repo based (has a reference to a repo, but nothing to comment on)
 *    - Event is PR based (has a repo + issue, can comment, gets normal DangerDSL)
 *    - Event is issue based (has a repo + issue, can comment, gets event DSL )
 *
 *  - Passing back the feedback results, if we can
 *
 * As you can imagine, this does indeed make it ripe for a good refactoring in the future.
 */

const log = (message: string) => winston.info(`[runner] - ${message}`)

export interface GitHubRunSettings {
  commentableID: number | null
  isRepoEvent: boolean | null
  isTriggeredByUser: boolean
  repoSpecificRules: any
  repoName: string | null
  triggeredByUsername: string | null
  hasRelatedCommentable: boolean
  eventID: string
  installationID: number
  installationSettings: GitHubInstallationSettings
}

export const getRepoSpecificRules = (installation: GitHubInstallation, repoName: string): GithubRepo | null => {
  const repos = installation.repos
  if (!repos[repoName]) {
    return null
  }

  const repo: GithubRepo = {
    fullName: repoName,
    installationID: installation.id,
    rules: repos[repoName],
  }

  return repo
}

export const setupForRequest = async (req: express.Request, installationSettings: any): Promise<GitHubRunSettings> => {
  const isRepoEvent = !!req.body.repository
  const repoName = isRepoEvent && req.body.repository.full_name
  const installationID = req.body.installation.id as number
  const db = getDB()
  const installation = await db.getInstallation(installationID)
  const isTriggeredByUser = !!req.body.sender
  const hasRelatedCommentable = getIssueNumber(req.body) !== null
  const dbRepo = isRepoEvent ? getRepoSpecificRules(installation!, repoName) : null
  const repoSpecificRules = dbRepo && dbRepo.rules ? dbRepo.rules : {}

  return {
    commentableID: hasRelatedCommentable ? getIssueNumber(req.body) : null,
    eventID: req.headers["X-GitHub-Delivery"] || "Unknown",
    hasRelatedCommentable,
    installationID,
    installationSettings,
    isRepoEvent,
    isTriggeredByUser,
    repoName,
    repoSpecificRules,
    triggeredByUsername: isTriggeredByUser ? req.body.sender.login : null,
  }
}

export const githubDangerRunner = async (event: string, req: express.Request, res: express.Response, next: any) => {
  const action = req.body.action as string | null
  const installationID = req.body.installation.id as number

  const db = getDB()
  const installation = await db.getInstallation(installationID)
  if (!installation) {
    res.status(404).send(`Could not find installation with id: ${installationID}`)
    return
  }

  const settings = await setupForRequest(req, installation.settings)

  // Allow edge-case repos to skip Danger rules. E.g. in Artsy, our analytics and marketing repos
  // do not need the same level of thought as an larger engineering project would.
  if (settings.repoName && installation.settings.ignored_repos.includes(settings.repoName)) {
    res.status(200).send(`Skipping peril run due to repo being in ignored`)
    return
  }

  // Some events aren't tied to a repo (like creating a user) and so
  // right now I've not thought through what is necessary to run those
  if (!settings.isRepoEvent) {
    res.status(404).send(`WIP - not built out support for non-repo related events - sorry`)
    return
  }

  const runs = runsForEvent(event, action, installation, settings)
  logger.info(`Found ${runs.length} runs for ${action}`)
  await runEverything(runs, settings, installation, req, res, next)
}

export function runsForEvent(
  event: string,
  action: string | null,
  installation: GitHubInstallation,
  settings: GitHubRunSettings
) {
  const installationRun = dangerRunForRules(event, action, installation.rules)
  const repoRun = dangerRunForRules(event, action, settings.repoSpecificRules)
  return [...installationRun, ...repoRun].filter(r => !!r) as DangerRun[]
}

export const runEverything = async (
  runs: DangerRun[],
  settings: GitHubRunSettings,
  _: GitHubInstallation,
  req: express.Request,
  res: express.Response,
  next: any
) => {
  // We got no runs ( so there were no rules that correspond to the event)
  if (runs.length === 0) {
    res.status(204).send(`No work to do.`)
    next()
    return
  }

  if (!req.body.installation || !req.body.installation.id) {
    res.status(204).send(`No installation ID sent from GitHub.`)
    next()
    return
  }

  log(`Event Settings: ${JSON.stringify(settings, null, " ")}`)
  const token = await getTemporaryAccessTokenForInstallation(req.body.installation.id)

  const allResults = [] as DangerResults[]

  const prRuns = runs.filter(r => r.dslType === dsl.pr)
  const eventRuns = runs.filter(r => r.dslType === dsl.import)

  // Loop through all PRs, which are definitely special cases compare to simple events
  for (const run of prRuns) {
    const results = await runPRRun(run, settings, token, req.body.pull_request || req.body)
    if (results) {
      allResults.push(results)
    }
  }

  for (const run of eventRuns) {
    const results = await runEventRun(run, settings, token, req.body)
    if (results) {
      allResults.push(results)
    }
  }

  const commentableRun = runs.find(r => r.feedback === feedback.commentable)
  if (commentableRun && allResults.length) {
    const finalResults = mergeResults(allResults)
    log(`Commenting, with results: ${mdResults(finalResults)}`)
    const isPRDSL = runs.find(r => r.dslType === dsl.pr) ? dsl.pr : dsl.import
    commentOnResults(isPRDSL, finalResults, token, settings)
  }

  const status = `Run ${runs.length} Dangerfile${runs.length > 1 ? "s" : ""}`
  res.status(200).send(JSON.stringify({ status, results: allResults }, null, "  "))
}

export const runEventRun = async (
  run: DangerRun,
  settings: GitHubRunSettings,
  token: string,
  dangerDSL: any
): Promise<DangerResults | null> => {
  const repoForDangerfile = run.repoSlug || (dangerDSL.repository && dangerDSL.repository.full_name)
  if (!repoForDangerfile) {
    return null
  }

  const supportsGithubCommentAPIs = run.feedback === feedback.commentable

  // Do we need an authenticated Danger GitHubAPI instance so we
  // can leave feedback on an issue?
  let githubAPI = null as GitHubAPI | null
  if (supportsGithubCommentAPIs && settings.commentableID && settings.repoName) {
    githubAPI = githubAPIForCommentable(token, settings.repoName, settings.commentableID)
  }

  const headDangerfile = await getGitHubFileContents(token, repoForDangerfile, run.dangerfilePath, run.branch)

  const installationSettings = {
    id: settings.installationID,
    settings: settings.installationSettings,
  }

  const results = await runDangerForInstallation(
    headDangerfile,
    run.referenceString,
    githubAPI,
    run.dslType,
    installationSettings,
    { github: dangerDSL }
  )

  return results || null
}

export const runPRRun = async (
  run: DangerRun,
  settings: GitHubRunSettings,
  token: string,
  pr: Pull_request
): Promise<DangerResults | null> => {
  if (!settings.repoName) {
    console.error("An event without a repo name was passed to runRPRun") // tslint:disable-line
    return null
  }

  if (!settings.triggeredByUsername) {
    console.error("An event without a username was passed to runRPRun") // tslint:disable-line
    return null
  }

  const githubAPI = githubAPIForCommentable(token, settings.repoName, settings.commentableID)

  // In theory only a PR requires a custom branch, so we can check directly for that
  // in the event JSON and if it's not there then use master
  // prioritise the run metadata

  // TODO: this check can crash during a non-repo event
  const dangerfileRepoForPR = pr.head.repo.full_name
  const dangerfileBranchForPR = pr.head.ref
  const neededDangerfileIsLocalRepo = !run.repoSlug
  const branch = neededDangerfileIsLocalRepo ? dangerfileBranchForPR : null

  // Either it's dictated in the run as an external repo, or we use the most natural repo
  const repoForDangerfile = run.repoSlug || dangerfileRepoForPR

  const baseDangerfile = await getGitHubFileContents(token, repoForDangerfile, run.dangerfilePath, branch)
  const headDangerfile = await getGitHubFileContents(token, repoForDangerfile, run.dangerfilePath, branch)
  const dangerfilesExist = headDangerfile !== "" && baseDangerfile !== ""

  // Shortcut to determine if both Dangerfile exists, and that they have different content
  if (dangerfilesExist && baseDangerfile !== headDangerfile) {
    // Check to see if they have write access, if they don't then don't run the
    // Dangerfile, but put out a message that it's not being ran on purpose
    const userCanWrite = await canUserWriteToRepo(token, settings.triggeredByUsername, dangerfileRepoForPR)
    if (!userCanWrite) {
      const message = "Not running Danger rules due to user with no write access changing the Dangerfile."
      return {
        fails: [],
        markdowns: [],
        warnings: [],
        messages: [{ message }],
      }
    }
  }

  const reportData = (reason: string) => {
    const stateForErrorHandling = {
      branch,
      dangerfileBranchForPR,
      neededDangerfileIsLocalRepo,
      repoForDangerfile,
      run,
      settings,
    }

    return `${reason}

## Full state of PR run:

\`\`\`json
${JSON.stringify(stateForErrorHandling, null, "  ")}
\`\`\`
      `
  }

  if (headDangerfile === "") {
    if (settings.installationSettings.ignore_missing) {
      return null
    }
    const actualBranch = branch ? branch : "master"
    const message = `Could not find Dangerfile at <code>${
      run.dangerfilePath
    }</code> on <code>${repoForDangerfile}</code> on branch <code>${actualBranch}</code>`

    const report = reportData(message)
    return {
      fails: [{ message: report }],
      markdowns: [],
      warnings: [],
      messages: [],
    }
  } else {
    // Everything is :+1:

    const installationSettings = {
      id: settings.installationID,
      settings: settings.installationSettings,
    }

    const dangerDSL = await createPRDSL(githubAPI)
    const results = await runDangerForInstallation(
      headDangerfile,
      run.referenceString,
      githubAPI,
      run.dslType,
      installationSettings,
      dangerDSL
    )

    if (results && pr.body !== null && pr.body.includes("Peril: Debug")) {
      results.markdowns.push({ message: reportData("Showing PR details due to including 'Peril: Debug'") })
    }
    return results ? results : null
  }
}

export const mdResults = (results: DangerResults): string => {
  return `
mds: ${results.markdowns.length}
messages: ${results.messages.length}
warns: ${results.warnings.length}
fails: ${results.fails.length}
  `
}

export const mergeResults = (results: DangerResults[]): DangerResults => {
  return results.reduce(
    (curr: DangerResults, newResults: DangerResults) => {
      return {
        fails: [...curr.fails, ...newResults.fails],
        markdowns: [...curr.markdowns, ...newResults.markdowns],
        messages: [...curr.messages, ...newResults.messages],
        warnings: [...curr.warnings, ...newResults.warnings],
      }
    },
    { fails: [], markdowns: [], warnings: [], messages: [] }
  )
}

export const commentOnResults = async (
  dslType: dsl,
  results: DangerResults,
  token: string,
  settings: GitHubRunSettings
) => {
  const githubAPI = githubAPIForCommentable(token, settings.repoName!, settings.commentableID)
  const gh = new GitHub(githubAPI)
  const platform = perilPlatform(dslType, gh, {})
  const exec = executorForInstallation(platform, vm2)

  // TODO: Figure what happens here with `git` as being nully,
  // for one I think it would mean non-sandbox runs cant use inline?
  await exec.handleResults(results, {} as any)
}

// This doesn't feel great, but is OK for now
const getIssueNumber = (json: any): number | null => {
  if (json.pull_request) {
    return json.pull_request.number
  }
  if (json.issue) {
    return json.issue.number
  }
  return null
}

export const githubAPIForCommentable = (token: string, repoSlug: string, issueNumber: number | null) => {
  const githubAPI = new GitHubAPI({ repoSlug, pullRequestID: String(issueNumber) }, token)
  githubAPI.additionalHeaders = {
    Accept: "application/vnd.github.machine-man-preview+json",
  }

  // How can I get this from an API, if we cannot use /me ?
  // https://api.github.com/repos/PerilTest/PerilPRTester/issues/5/comments
  // Talked to GH - they know it's an issue.
  githubAPI.getUserID = () => Promise.resolve(parseInt(PERIL_BOT_USER_ID as string, 10))
  return githubAPI
}

export default githubDangerRunner
