import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

const paginate = jest.fn()
const request = jest.fn()
const getOctokit = jest.fn(() => ({ paginate, request }))
const context = {
  repo: { owner: 'acme' },
  payload: {
    repository: {
      owner: {
        type: 'Organization'
      }
    }
  }
}

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('@actions/github', () => ({ context, getOctokit }))

const { run } = await import('../src/main.js')

describe('main.ts', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-ghcr-main-'))
    jest.useFakeTimers().setSystemTime(new Date('2026-06-18T00:00:00Z'))
    getOctokit.mockReturnValue({ paginate, request })
    mockInputs({
      'github-token': 'token',
      'max-age-days': '30',
      'min-versions-to-keep': '1',
      'dry-run': 'false',
      source: 'deploy-configs',
      owner: '',
      'owner-type': '',
      'package-names': '',
      'root-directory': tempDir,
      'deploy-config-path': 'config/deploy.yml',
      'image-regex': ''
    })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    context.repo.owner = 'acme'
    context.payload.repository.owner.type = 'Organization'
    jest.useRealTimers()
    jest.resetAllMocks()
  })

  it('deletes eligible package versions', async () => {
    await writeDeployConfig('api', 'image: ghcr.io/acme/apps/api:main\n')
    paginate.mockResolvedValueOnce([
      version(1, '2026-06-17T00:00:00Z', ['main']),
      version(2, '2026-05-01T00:00:00Z', ['old'])
    ])

    await run()

    expect(getOctokit).toHaveBeenCalledWith('token')
    expect(request).toHaveBeenCalledWith(
      'DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}',
      {
        org: 'acme',
        package_type: 'container',
        package_name: 'apps/api',
        package_version_id: 2
      }
    )
    expect(core.setOutput).toHaveBeenCalledWith('images-found', 1)
    expect(core.setOutput).toHaveBeenCalledWith('versions-found', 2)
    expect(core.setOutput).toHaveBeenCalledWith('versions-eligible', 1)
    expect(core.setOutput).toHaveBeenCalledWith('versions-deleted', 1)
  })

  it('reports eligible versions without deleting during a dry run', async () => {
    mockInputs({
      'github-token': 'token',
      'max-age-days': '30',
      'min-versions-to-keep': '0',
      'dry-run': 'true',
      source: 'deploy-configs',
      owner: '',
      'owner-type': '',
      'package-names': '',
      'root-directory': tempDir,
      'deploy-config-path': 'config/deploy.yml',
      'image-regex': ''
    })
    await writeDeployConfig('api', 'image: ghcr.io/acme/apps/api:main\n')
    paginate.mockResolvedValueOnce([version(3, '2026-05-01T00:00:00Z')])

    await run()

    expect(request).not.toHaveBeenCalled()
    expect(core.info).toHaveBeenCalledWith(
      '[dry-run] Would delete acme/apps/api@3 (untagged, created 2026-05-01T00:00:00Z)'
    )
    expect(core.setOutput).toHaveBeenCalledWith('versions-deleted', 0)
  })

  it('falls back to user package routes when the org package is not found', async () => {
    mockInputs({
      'github-token': 'token',
      'max-age-days': '30',
      'min-versions-to-keep': '0',
      'dry-run': 'false',
      source: 'deploy-configs',
      owner: '',
      'owner-type': '',
      'package-names': '',
      'root-directory': tempDir,
      'deploy-config-path': 'config/deploy.yml',
      'image-regex': ''
    })
    await writeDeployConfig('api', 'image: ghcr.io/benja/apps/api:main\n')
    const notFound = Object.assign(new Error('not found'), { status: 404 })
    paginate
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce([version(4, '2026-05-01T00:00:00Z')])

    await run()

    expect(request).toHaveBeenCalledWith(
      'DELETE /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}',
      {
        username: 'benja',
        package_type: 'container',
        package_name: 'apps/api',
        package_version_id: 4
      }
    )
  })

  it('fails on invalid numeric inputs', async () => {
    mockInputs({
      'github-token': 'token',
      'max-age-days': 'soon',
      'min-versions-to-keep': '1',
      'dry-run': 'false',
      source: '',
      owner: '',
      'owner-type': '',
      'package-names': '',
      'root-directory': tempDir,
      'deploy-config-path': 'config/deploy.yml',
      'image-regex': ''
    })

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      'max-age-days must be a non-negative integer'
    )
  })

  it('defaults to owner package discovery', async () => {
    mockInputs({
      'github-token': 'token',
      'max-age-days': '30',
      'min-versions-to-keep': '0',
      'dry-run': 'false',
      source: '',
      owner: '',
      'owner-type': 'org',
      'package-names': '',
      'root-directory': tempDir,
      'deploy-config-path': 'config/deploy.yml',
      'image-regex': ''
    })
    paginate
      .mockResolvedValueOnce([{ name: 'apps/api' }])
      .mockResolvedValueOnce([version(5, '2026-05-01T00:00:00Z')])

    await run()

    expect(paginate).toHaveBeenNthCalledWith(1, 'GET /orgs/{org}/packages', {
      org: 'acme',
      package_type: 'container',
      per_page: 100
    })
    expect(request).toHaveBeenCalledWith(
      'DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}',
      {
        org: 'acme',
        package_type: 'container',
        package_name: 'apps/api',
        package_version_id: 5
      }
    )
  })

  it('uses authenticated-user routes for the current user namespace', async () => {
    context.repo.owner = 'benja'
    context.payload.repository.owner.type = 'User'
    mockInputs({
      'github-token': 'token',
      'max-age-days': '30',
      'min-versions-to-keep': '0',
      'dry-run': 'false',
      source: '',
      owner: '',
      'owner-type': '',
      'package-names': '',
      'root-directory': tempDir,
      'deploy-config-path': 'config/deploy.yml',
      'image-regex': ''
    })
    paginate
      .mockResolvedValueOnce([{ name: 'apps/api' }])
      .mockResolvedValueOnce([version(8, '2026-05-01T00:00:00Z')])

    await run()

    expect(paginate).toHaveBeenNthCalledWith(1, 'GET /user/packages', {
      package_type: 'container',
      per_page: 100
    })
    expect(paginate).toHaveBeenNthCalledWith(
      2,
      'GET /user/packages/{package_type}/{package_name}/versions',
      {
        package_type: 'container',
        package_name: 'apps/api',
        per_page: 100
      }
    )
    expect(request).toHaveBeenCalledWith(
      'DELETE /user/packages/{package_type}/{package_name}/versions/{package_version_id}',
      {
        package_type: 'container',
        package_name: 'apps/api',
        package_version_id: 8
      }
    )
  })

  it('deletes eligible versions from every package in the current owner', async () => {
    mockInputs({
      'github-token': 'token',
      'max-age-days': '30',
      'min-versions-to-keep': '0',
      'dry-run': 'false',
      source: 'owner',
      owner: '',
      'owner-type': 'org',
      'package-names': '',
      'root-directory': tempDir,
      'deploy-config-path': 'config/deploy.yml',
      'image-regex': ''
    })
    paginate
      .mockResolvedValueOnce([{ name: 'apps/api' }, { name: 'apps/web' }])
      .mockResolvedValueOnce([version(5, '2026-05-01T00:00:00Z')])
      .mockResolvedValueOnce([version(6, '2026-05-01T00:00:00Z')])

    await run()

    expect(paginate).toHaveBeenNthCalledWith(1, 'GET /orgs/{org}/packages', {
      org: 'acme',
      package_type: 'container',
      per_page: 100
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(core.setOutput).toHaveBeenCalledWith('images-found', 2)
    expect(core.setOutput).toHaveBeenCalledWith('versions-deleted', 2)
  })

  it('filters owner packages by configured package names', async () => {
    mockInputs({
      'github-token': 'token',
      'max-age-days': '30',
      'min-versions-to-keep': '0',
      'dry-run': 'false',
      source: 'owner',
      owner: 'bvrcode',
      'owner-type': 'org',
      'package-names': 'apps/api,missing',
      'root-directory': tempDir,
      'deploy-config-path': 'config/deploy.yml',
      'image-regex': ''
    })
    paginate
      .mockResolvedValueOnce([{ name: 'apps/api' }, { name: 'apps/web' }])
      .mockResolvedValueOnce([version(7, '2026-05-01T00:00:00Z')])

    await run()

    expect(paginate).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledWith(
      'DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}',
      {
        org: 'bvrcode',
        package_type: 'container',
        package_name: 'apps/api',
        package_version_id: 7
      }
    )
    expect(core.warning).toHaveBeenCalledWith(
      'bvrcode/missing: package was not found'
    )
    expect(core.setOutput).toHaveBeenCalledWith('images-found', 1)
  })

  async function writeDeployConfig(appName: string, contents: string) {
    const configDir = path.join(tempDir, appName, 'config')
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'deploy.yml'), contents)
  }
})

function mockInputs(inputs: Record<string, string>) {
  core.getInput.mockImplementation((name) => inputs[name] ?? '')
}

function version(id: number, createdAt: string, tags: string[] = []) {
  return {
    id,
    created_at: createdAt,
    metadata: {
      container: {
        tags
      }
    }
  }
}
