import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Minimatch } from 'minimatch'

export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_DEPLOY_CONFIG_PATH = '**/config/deploy{,.*}.{yml,yaml}'
export const DEFAULT_IMAGE_REGEX =
  '^image:\\s*[\'"]?(?<image>[^\'"\\s#]+)[\'"]?\\s*$'

export interface PackageImage {
  owner: string
  packageName: string
}

export interface CleanupTarget extends PackageImage {
  ownerType?: 'org' | 'user'
}

export interface PackageVersion {
  id: number
  created_at: string
  metadata?: {
    container?: {
      tags?: string[]
    }
  }
}

export function normalizeConfigPattern(configPattern: string): string {
  const segments = configPattern.split(/[\\/]+/).filter(Boolean)
  const normalized = segments.join('/')

  if (
    !normalized ||
    path.isAbsolute(configPattern) ||
    segments.includes('..')
  ) {
    throw new Error('deploy-config-path must be a relative glob pattern')
  }

  if (!new Minimatch(normalized).hasMagic()) {
    return `**/${normalized}`
  }

  return normalized
}

export async function findDeployConfigs(
  rootDir: string,
  deployConfigPattern: string
): Promise<string[]> {
  const matcher = new Minimatch(normalizeConfigPattern(deployConfigPattern), {
    dot: true
  })
  const configs: string[] = []

  async function visit(dir: string): Promise<void> {
    let entries: Dirent[]

    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      throw error
    }

    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          await visit(entryPath)
          return
        }

        if (!entry.isFile()) return

        const relativePath = toPosixPath(path.relative(rootDir, entryPath))
        if (matcher.match(relativePath)) {
          configs.push(entryPath)
        }
      })
    )
  }

  await visit(rootDir)
  return configs.sort()
}

export function extractImage(
  config: string,
  imageRegex = DEFAULT_IMAGE_REGEX
): string | undefined {
  const match = new RegExp(imageRegex, 'm').exec(config)
  return match?.groups?.image ?? match?.slice(1).find(Boolean)
}

export function parseImage(image: string): PackageImage {
  const imageWithoutRegistry = stripGhcrRegistry(image.trim())
  const imageWithoutDigest = imageWithoutRegistry.split('@')[0]
  const lastSlashIndex = imageWithoutDigest.lastIndexOf('/')
  const tagIndex = imageWithoutDigest.lastIndexOf(':')
  const packagePath =
    tagIndex > lastSlashIndex
      ? imageWithoutDigest.slice(0, tagIndex)
      : imageWithoutDigest
  const [owner, ...packageParts] = packagePath.split('/').filter(Boolean)

  if (!owner || packageParts.length === 0) {
    throw new Error(`Expected image to look like owner/package, got ${image}`)
  }

  return {
    owner,
    packageName: packageParts.join('/')
  }
}

export function selectDeletableVersions(
  versions: PackageVersion[],
  cutoff: number,
  minVersionsToKeep: number
): PackageVersion[] {
  return [...versions]
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    .filter((version, index) => {
      return (
        index >= minVersionsToKeep &&
        new Date(version.created_at).getTime() < cutoff
      )
    })
}

export function getVersionLabel(version: PackageVersion): string {
  const tags = version.metadata?.container?.tags ?? []
  return tags.length ? tags.join(', ') : 'untagged'
}

export function parsePackageNames(input: string): string[] {
  return input
    .split(/[\n,]+/)
    .map((packageName) => packageName.trim())
    .filter(Boolean)
}

function stripGhcrRegistry(image: string): string {
  if (/^ghcr\.io\//i.test(image)) return image.replace(/^ghcr\.io\//i, '')

  const firstSegment = image.split('/')[0]
  if (firstSegment.includes('.') || firstSegment.includes(':')) {
    throw new Error(`Only ghcr.io images are supported, got ${image}`)
  }

  return image
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
