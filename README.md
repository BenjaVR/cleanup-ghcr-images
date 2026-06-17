# Cleanup GHCR images

Configurable GitHub Action that deletes old GitHub Container Registry package
versions. By default it cleans container packages in the current repository
owner namespace, and it can optionally discover images from Kamal-style deploy
config files.

## Usage

```yaml
name: Cleanup GHCR images

on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:
    inputs:
      dry_run:
        description: Report deletions without deleting package versions
        required: false
        default: false
        type: boolean

concurrency:
  group: cleanup-ghcr-images
  cancel-in-progress: false

permissions:
  packages: write

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Delete old GHCR image versions
        uses: BenjaVR/cleanup-ghcr-images@v1
        with:
          max-age-days: 30
          min-versions-to-keep: 10
          dry-run: ${{ inputs.dry_run || false }}
```

## Owner Cleanup

The default `owner` source lists every container package in the current
repository owner namespace. Set `owner-type` to avoid auto-detection when you
know the namespace is an organization or user:

```yaml
- name: Delete old GHCR image versions
  uses: BenjaVR/cleanup-ghcr-images@v1
  with:
    owner-type: org
    max-age-days: 30
    min-versions-to-keep: 10
```

Limit cleanup to specific packages with a comma-separated or newline-separated
list:

```yaml
- name: Delete selected GHCR image versions
  uses: BenjaVR/cleanup-ghcr-images@v1
  with:
    owner: acme
    owner-type: org
    package-names: |
      apps/api
      apps/web
    max-age-days: 30
    min-versions-to-keep: 10
```

## Kamal-Styled Projects

For projects that keep image names in Kamal-style deploy config files, use
`source: deploy-configs`. The default config scan looks for
`**/config/deploy{,.*}.{yml,yaml}` under `root-directory`, so it matches
Kamal-style files such as:

```text
config/deploy.yml
config/deploy.yaml
config/deploy.production.yml
apps/web/config/deploy.yml
apps/web/config/deploy.production.yaml
```

It reads an `image:` field like:

```yaml
image: ghcr.io/acme/apps/api
```

Because this mode reads repository files, check out the repository first:

```yaml
permissions:
  contents: read
  packages: write

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Delete old GHCR image versions
        uses: BenjaVR/cleanup-ghcr-images@v1
        with:
          source: deploy-configs
          max-age-days: 30
          min-versions-to-keep: 10
```

Customize `image-regex` if your deploy files store the image in a different
shape. Prefer a named capture group called `image`.

## Inputs

| Input                  | Default                                       | Description                                                                                      |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `github-token`         | `${{ github.token }}`                         | GitHub token with `packages: write` permission.                                                  |
| `max-age-days`         | `30`                                          | Delete only versions older than this many days.                                                  |
| `min-versions-to-keep` | `10`                                          | Always keep at least this many newest versions per package.                                      |
| `dry-run`              | `false`                                       | Report deletions without deleting package versions.                                              |
| `source`               | `owner`                                       | Where to discover images. Use `owner` or `deploy-configs`.                                       |
| `owner`                | Current repository owner                      | Organization or user to scan when `source` is `owner`.                                           |
| `owner-type`           | `auto`                                        | Owner namespace type. Use `auto`, `org`, or `user`.                                              |
| `package-names`        |                                               | Optional comma-separated or newline-separated package names to include in `owner` mode.          |
| `root-directory`       | `.`                                           | Directory to scan for deploy config files when `source` is `deploy-configs`.                     |
| `deploy-config-path`   | `**/config/deploy{,.*}.{yml,yaml}`            | Relative deploy config glob to match under the root directory when `source` is `deploy-configs`. |
| `image-regex`          | `^image:\s*['"]?(?<image>[^'"\s#]+)['"]?\s*$` | Regular expression used to extract the image when `source` is `deploy-configs`.                  |

## Outputs

| Output              | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `images-found`      | Number of unique GHCR images discovered.                    |
| `versions-found`    | Number of package versions listed across discovered images. |
| `versions-eligible` | Number of package versions eligible for deletion.           |
| `versions-deleted`  | Number of package versions actually deleted.                |

## Behavior

In `owner` mode, the action lists every container package for the configured
owner and optionally filters that list with `package-names`. In `deploy-configs`
mode, it scans deploy files and extracts unique images from their `image:`
fields.

For each selected package, the action lists package versions through the GitHub
REST API. With `owner-type: auto`, it first tries the organization package route
and falls back to the user package route on a `404`.

A package version is deleted only when both conditions are true:

1. It is older than `max-age-days`.
1. It is outside the newest `min-versions-to-keep` versions for that package.

Deploy-config images may be written as `ghcr.io/owner/package`, `owner/package`,
and may include a tag or digest. Only GHCR images are supported.
