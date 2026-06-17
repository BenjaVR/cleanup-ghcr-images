import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractImage,
  findDeployConfigs,
  getVersionLabel,
  parseImage,
  parsePackageNames,
  selectDeletableVersions
} from '../src/cleanup.js'

describe('cleanup helpers', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-ghcr-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('finds deploy config files under the configured root', async () => {
    await fs.mkdir(path.join(tempDir, 'api', 'config'), { recursive: true })
    await fs.mkdir(path.join(tempDir, 'web', 'config'), { recursive: true })
    await fs.writeFile(path.join(tempDir, 'api', 'config', 'deploy.yml'), '')
    await fs.writeFile(path.join(tempDir, 'web', 'config', 'deploy.yml'), '')
    await fs.writeFile(path.join(tempDir, 'web', 'deploy.yml'), '')

    await expect(
      findDeployConfigs(tempDir, 'config/deploy.yml')
    ).resolves.toEqual([
      path.join(tempDir, 'api', 'config', 'deploy.yml'),
      path.join(tempDir, 'web', 'config', 'deploy.yml')
    ])
  })

  it('matches Kamal deploy config variants with a glob', async () => {
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true })
    await fs.mkdir(path.join(tempDir, 'apps', 'web', 'config'), {
      recursive: true
    })
    await fs.writeFile(path.join(tempDir, 'config', 'deploy.yml'), '')
    await fs.writeFile(
      path.join(tempDir, 'config', 'deploy.production.yml'),
      ''
    )
    await fs.writeFile(
      path.join(tempDir, 'apps', 'web', 'config', 'deploy.yaml'),
      ''
    )
    await fs.writeFile(
      path.join(tempDir, 'apps', 'web', 'config', 'deploy.staging.yaml'),
      ''
    )
    await fs.writeFile(
      path.join(tempDir, 'apps', 'web', 'config', 'other.yml'),
      ''
    )

    await expect(
      findDeployConfigs(tempDir, '**/config/deploy{,.*}.{yml,yaml}')
    ).resolves.toEqual([
      path.join(tempDir, 'apps', 'web', 'config', 'deploy.staging.yaml'),
      path.join(tempDir, 'apps', 'web', 'config', 'deploy.yaml'),
      path.join(tempDir, 'config', 'deploy.production.yml'),
      path.join(tempDir, 'config', 'deploy.yml')
    ])
  })

  it('extracts and parses GHCR image names', () => {
    expect(extractImage('image: "ghcr.io/acme/apps/api:main"\n')).toBe(
      'ghcr.io/acme/apps/api:main'
    )
    expect(parseImage('ghcr.io/acme/apps/api:main')).toEqual({
      owner: 'acme',
      packageName: 'apps/api'
    })
    expect(parseImage('acme/apps/api@sha256:123')).toEqual({
      owner: 'acme',
      packageName: 'apps/api'
    })
  })

  it('selects versions older than the cutoff after the keep count', () => {
    const versions = [
      version(1, '2026-06-18T00:00:00Z'),
      version(2, '2026-06-01T00:00:00Z'),
      version(3, '2026-05-01T00:00:00Z'),
      version(4, '2026-04-01T00:00:00Z')
    ]
    const cutoff = new Date('2026-06-03T00:00:00Z').getTime()

    expect(
      selectDeletableVersions(versions, cutoff, 2).map(({ id }) => id)
    ).toEqual([3, 4])
  })

  it('labels tagged and untagged versions', () => {
    expect(
      getVersionLabel({
        ...version(1, '2026-06-18T00:00:00Z'),
        metadata: { container: { tags: ['main', 'sha-123'] } }
      })
    ).toBe('main, sha-123')
    expect(getVersionLabel(version(2, '2026-06-18T00:00:00Z'))).toBe('untagged')
  })

  it('parses comma and newline separated package names', () => {
    expect(parsePackageNames('api, web\nworker\n\n')).toEqual([
      'api',
      'web',
      'worker'
    ])
  })
})

function version(id: number, createdAt: string) {
  return {
    id,
    created_at: createdAt
  }
}
