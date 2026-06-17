import * as core from '@actions/core'
import * as github from '@actions/github'
import fs from 'node:fs/promises'
import {
  DAY_MS,
  DEFAULT_DEPLOY_CONFIG_PATH,
  DEFAULT_IMAGE_REGEX,
  type CleanupTarget,
  type PackageVersion,
  extractImage,
  findDeployConfigs,
  getVersionLabel,
  parseImage,
  parsePackageNames,
  selectDeletableVersions
} from './cleanup.js'

type Octokit = ReturnType<typeof github.getOctokit>
type OwnerType = 'org' | 'user'
type OwnerTypeInput = OwnerType | 'auto'
type Source = 'deploy-configs' | 'owner'

interface VersionList {
  ownerType: OwnerType
  versions: PackageVersion[]
}

interface PackageList {
  ownerType: OwnerType
  packages: CleanupTarget[]
}

interface PackageSummary {
  name: string
}

interface ActionInput {
  githubToken: string
  source: Source
  owner: string
  ownerType: OwnerTypeInput
  packageNames: string[]
  maxAgeDays: number
  minVersionsToKeep: number
  dryRun: boolean
  rootDirectory: string
  deployConfigPath: string
  imageRegex: string
}

export async function run(): Promise<void> {
  try {
    const input = getActionInput()
    const cutoff = Date.now() - input.maxAgeDays * DAY_MS
    const octokit = github.getOctokit(input.githubToken)
    const targets = await getCleanupTargets(octokit, input)

    if (targets.length === 0) {
      core.warning('No GHCR images matched the cleanup configuration')
      setSummaryOutputs(0, 0, 0, 0)
      return
    }

    let versionsFound = 0
    let versionsEligible = 0
    let versionsDeleted = 0

    for (const {
      owner,
      ownerType: preferredOwnerType,
      packageName
    } of targets) {
      const { ownerType, versions } = await listVersions(
        octokit,
        owner,
        packageName,
        preferredOwnerType
      )
      const deletableVersions = selectDeletableVersions(
        versions,
        cutoff,
        input.minVersionsToKeep
      )

      versionsFound += versions.length
      versionsEligible += deletableVersions.length

      core.info(
        `${owner}/${packageName}: ${versions.length} versions, ${deletableVersions.length} eligible for deletion`
      )

      for (const version of deletableVersions) {
        const label = getVersionLabel(version)

        if (input.dryRun) {
          core.info(
            `[dry-run] Would delete ${owner}/${packageName}@${version.id} (${label}, created ${version.created_at})`
          )
          continue
        }

        core.info(
          `Deleting ${owner}/${packageName}@${version.id} (${label}, created ${version.created_at})`
        )
        await deleteVersion(octokit, ownerType, owner, packageName, version.id)
        versionsDeleted += 1
      }
    }

    setSummaryOutputs(
      targets.length,
      versionsFound,
      versionsEligible,
      versionsDeleted
    )
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

async function getCleanupTargets(
  octokit: Octokit,
  input: ActionInput
): Promise<CleanupTarget[]> {
  if (input.source === 'owner') {
    return getOwnerTargets(octokit, input)
  }

  return getDeployConfigTargets(input)
}

async function getDeployConfigTargets(
  input: ActionInput
): Promise<CleanupTarget[]> {
  const imageMap = new Map<string, CleanupTarget>()

  for (const configPath of await findDeployConfigs(
    input.rootDirectory,
    input.deployConfigPath
  )) {
    const config = await fs.readFile(configPath, 'utf8')
    const image = extractImage(config, input.imageRegex)

    if (!image) {
      core.info(`Skipping ${configPath}: no image entry found`)
      continue
    }

    const parsedImage = parseImage(image)
    imageMap.set(`${parsedImage.owner}/${parsedImage.packageName}`, parsedImage)
  }

  return [...imageMap.values()]
}

async function getOwnerTargets(
  octokit: Octokit,
  input: ActionInput
): Promise<CleanupTarget[]> {
  const { ownerType, packages } = await listPackages(
    octokit,
    input.owner,
    input.ownerType
  )
  const packageNames = new Set(input.packageNames)
  const targets = packages.filter((packageImage) => {
    return packageNames.size === 0 || packageNames.has(packageImage.packageName)
  })

  for (const packageName of packageNames) {
    if (!targets.some((target) => target.packageName === packageName)) {
      core.warning(`${input.owner}/${packageName}: package was not found`)
    }
  }

  return targets.map((target) => ({
    ...target,
    ownerType
  }))
}

function getActionInput(): ActionInput {
  return {
    githubToken: core.getInput('github-token', { required: true }),
    source: getSourceInput(),
    owner: core.getInput('owner') || github.context.repo.owner,
    ownerType: getOwnerTypeInput(),
    packageNames: parsePackageNames(core.getInput('package-names')),
    maxAgeDays: getIntegerInput('max-age-days'),
    minVersionsToKeep: getIntegerInput('min-versions-to-keep'),
    dryRun: getBooleanInput('dry-run'),
    rootDirectory: core.getInput('root-directory') || '.',
    deployConfigPath:
      core.getInput('deploy-config-path') || DEFAULT_DEPLOY_CONFIG_PATH,
    imageRegex: core.getInput('image-regex') || DEFAULT_IMAGE_REGEX
  }
}

function getSourceInput(): Source {
  const value = core.getInput('source') || 'owner'

  if (value === 'deploy-configs' || value === 'owner') return value

  throw new Error('source must be deploy-configs or owner')
}

function getOwnerTypeInput(): OwnerTypeInput {
  const value = core.getInput('owner-type') || 'auto'

  if (value === 'auto' || value === 'org' || value === 'user') return value

  throw new Error('owner-type must be auto, org, or user')
}

function getIntegerInput(name: string): number {
  const value = core.getInput(name, { required: true })
  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }

  return parsed
}

function getBooleanInput(name: string): boolean {
  const value = (core.getInput(name) || 'false').trim().toLowerCase()

  if (['true', '1', 'yes', 'y', 'on'].includes(value)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(value)) return false

  throw new Error(`${name} must be a boolean`)
}

async function listVersions(
  octokit: Octokit,
  owner: string,
  packageName: string,
  preferredOwnerType: OwnerTypeInput = 'auto'
): Promise<VersionList> {
  if (preferredOwnerType === 'org') {
    return {
      ownerType: 'org',
      versions: await listOrgVersions(octokit, owner, packageName)
    }
  }

  if (preferredOwnerType === 'user') {
    return {
      ownerType: 'user',
      versions: await listUserVersions(octokit, owner, packageName)
    }
  }

  try {
    return {
      ownerType: 'org',
      versions: await listOrgVersions(octokit, owner, packageName)
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }

  return {
    ownerType: 'user',
    versions: await listUserVersions(octokit, owner, packageName)
  }
}

async function listPackages(
  octokit: Octokit,
  owner: string,
  ownerType: OwnerTypeInput
): Promise<PackageList> {
  if (ownerType === 'org') {
    return {
      ownerType: 'org',
      packages: await listOrgPackages(octokit, owner)
    }
  }

  if (ownerType === 'user') {
    return {
      ownerType: 'user',
      packages: await listUserPackages(octokit, owner)
    }
  }

  try {
    return {
      ownerType: 'org',
      packages: await listOrgPackages(octokit, owner)
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }

  return {
    ownerType: 'user',
    packages: await listUserPackages(octokit, owner)
  }
}

async function listOrgPackages(
  octokit: Octokit,
  owner: string
): Promise<CleanupTarget[]> {
  const packages = (await octokit.paginate('GET /orgs/{org}/packages', {
    org: owner,
    package_type: 'container',
    per_page: 100
  })) as PackageSummary[]

  return packages.map(({ name }) => ({
    owner,
    packageName: name
  }))
}

async function listUserPackages(
  octokit: Octokit,
  owner: string
): Promise<CleanupTarget[]> {
  const packages = (await octokit.paginate('GET /users/{username}/packages', {
    username: owner,
    package_type: 'container',
    per_page: 100
  })) as PackageSummary[]

  return packages.map(({ name }) => ({
    owner,
    packageName: name
  }))
}

async function listOrgVersions(
  octokit: Octokit,
  owner: string,
  packageName: string
): Promise<PackageVersion[]> {
  return (await octokit.paginate(
    'GET /orgs/{org}/packages/{package_type}/{package_name}/versions',
    {
      org: owner,
      package_type: 'container',
      package_name: packageName,
      per_page: 100
    }
  )) as PackageVersion[]
}

async function listUserVersions(
  octokit: Octokit,
  owner: string,
  packageName: string
): Promise<PackageVersion[]> {
  return (await octokit.paginate(
    'GET /users/{username}/packages/{package_type}/{package_name}/versions',
    {
      username: owner,
      package_type: 'container',
      package_name: packageName,
      per_page: 100
    }
  )) as PackageVersion[]
}

async function deleteVersion(
  octokit: Octokit,
  ownerType: OwnerType,
  owner: string,
  packageName: string,
  versionId: number
): Promise<void> {
  if (ownerType === 'org') {
    await octokit.request(
      'DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}',
      {
        org: owner,
        package_type: 'container',
        package_name: packageName,
        package_version_id: versionId
      }
    )
    return
  }

  await octokit.request(
    'DELETE /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}',
    {
      username: owner,
      package_type: 'container',
      package_name: packageName,
      package_version_id: versionId
    }
  )
}

function setSummaryOutputs(
  imagesFound: number,
  versionsFound: number,
  versionsEligible: number,
  versionsDeleted: number
): void {
  core.setOutput('images-found', imagesFound)
  core.setOutput('versions-found', versionsFound)
  core.setOutput('versions-eligible', versionsEligible)
  core.setOutput('versions-deleted', versionsDeleted)
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    (error as { status?: number }).status === 404
  )
}
