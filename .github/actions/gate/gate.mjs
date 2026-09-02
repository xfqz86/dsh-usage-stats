/**
 * Gate — 校验指定 SHA 的 CI job 是否已成功（仅供 GitHub Action 使用）
 * 通过 REST API 查询 check-runs，匹配 job 名（支持 "verify" 与 "CI / verify"）。
 * inputs 均由 action.yml 传入，无默认值硬编码在代码外（除 yml 已给）。
 */

function getInput(name, fallback = '') {
  const val = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] || ''
  const trimmed = val.trim()
  if (trimmed === '') return fallback
  return trimmed
}

const shaInput = getInput('sha', '') || process.env.GITHUB_SHA || ''
const workflowName = getInput('workflow', 'CI')
const jobName = getInput('job', 'verify')
const token = getInput('token', '') || process.env.GITHUB_TOKEN || ''

if (!shaInput) {
  console.error('::error::sha input is required')
  process.exit(1)
}

const repo = process.env.GITHUB_REPOSITORY
if (!repo || !repo.includes('/')) {
  console.error('::error::GITHUB_REPOSITORY is required (owner/repo)')
  process.exit(1)
}
const [owner, repoName] = repo.split('/')

if (!token) {
  console.error('::error::token input or GITHUB_TOKEN is required')
  process.exit(1)
}

async function run() {
  const sha = shaInput
  // 复用 tag 触发时的 context.ref 日志
  const ref = process.env.GITHUB_REF || ''
  console.log(`Checking ${workflowName}/${jobName} for ${ref || sha} @ ${sha}`)

  // 直接用 fetch 调 GitHub REST API，避免 @actions/* 打包
  const url = `https://api.github.com/repos/${owner}/${repoName}/commits/${sha}/check-runs?per_page=100`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gate-ci-action',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`::error::GitHub API failed ${res.status} ${res.statusText}: ${body}`)
    process.exit(1)
  }
  const data = await res.json()
  const runs = data.check_runs || []
  console.log(`Found ${runs.length} check runs`)
  for (const c of runs) {
    console.log(`- ${c.name}: ${c.status}/${c.conclusion} (app: ${c.app?.slug})`)
  }

  let verify = runs.find(c => c.name === jobName && c.conclusion === 'success')
  if (!verify) verify = runs.find(c => c.name.endsWith(`/ ${jobName}`) && c.conclusion === 'success')

  if (verify) {
    console.log(`${workflowName}/${jobName} passed at ${verify.completed_at}`)
    process.exit(0)
  }

  const any = runs.find(c => c.name === jobName || c.name.endsWith(`/ ${jobName}`))
  if (any) {
    if (any.status !== 'completed') {
      console.error(`::error::CI job '${jobName}' not completed (status=${any.status}), wait for CI before tagging (sha=${sha})`)
    } else {
      console.error(`::error::CI job '${jobName}' conclusion is '${any.conclusion}', not success, gate rejected (sha=${sha})`)
    }
    process.exit(1)
  } else {
    const names = runs.map(c => c.name).join(', ') || 'none'
    console.error(`::error::No CI job '${jobName}' check run found (sha=${sha}), maybe CI did not run on this commit. Push to main and wait for CI. Available checks: ${names}`)
    process.exit(1)
  }
}

if (import.meta.main) run()
