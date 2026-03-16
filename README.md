# certyn/action

Official GitHub Action for Certyn CI verification.

It triggers a Certyn run (`POST /api/ci/runs`), optionally waits for completion (`GET /api/ci/runs/{runId}`), and fails your workflow based on run results.

## Why use this action

- Safe retries with idempotency key defaults
- Polling that respects `retryAfterSeconds`
- Clear outputs (`run_id`, `state`, counts, `app_url`)
- Optional best-effort cancellation on timeout/job cancellation

## Quick start

```yaml
name: Certyn Smoke Gate

on:
  pull_request:

jobs:
  certyn:
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Certyn CI run
        uses: certyn/action@v1
        with:
          api_key: ${{ secrets.CERTYN_API_KEY }}
          project_slug: ${{ secrets.CERTYN_PROJECT_SLUG }}
          environment_key: staging
          process_slug: smoke-suite
```

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `api_key` | yes | - | Certyn API key |
| `project_slug` | yes | - | Certyn project slug |
| `environment_key` | no | - | Optional environment key |
| `process_slug` | conditional | - | Recommended selector |
| `tags` | conditional | - | Use only if `process_slug` is not provided |
| `api_url` | no | `https://api.certyn.io` | Use dev/staging/prod hosts |
| `repository` | no | `GITHUB_REPOSITORY` | Metadata sent to Certyn |
| `ref` | no | `GITHUB_REF_NAME` | Metadata sent to Certyn |
| `commit_sha` | no | `GITHUB_SHA` | Metadata sent to Certyn |
| `event` | no | `GITHUB_EVENT_NAME` | Metadata sent to Certyn |
| `external_url` | no | current Actions run URL | Metadata sent to Certyn |
| `idempotency_key` | no | `GITHUB_RUN_ID-GITHUB_RUN_ATTEMPT-GITHUB_JOB` | Prevents duplicate runs on retries |
| `wait_for_completion` | no | `true` | If `false`, action exits after create |
| `timeout_seconds` | no | `1800` | Max wait time |
| `initial_poll_interval_seconds` | no | `10` | Min poll interval |
| `max_poll_interval_seconds` | no | `30` | Max poll interval |
| `fail_on_failed` | no | `true` | Fail when failed > 0 |
| `fail_on_blocked` | no | `true` | Fail when blocked > 0 |
| `fail_on_cancelled` | no | `true` | Fail when state is cancelled |
| `cancel_on_timeout` | no | `true` | Best-effort cancel when timing out |
| `cancel_on_job_cancel` | no | `true` | Best-effort cancel on SIGINT/SIGTERM |
| `cancel_reason` | no | `Cancelled by certyn/action` | Cancel payload reason |
| `request_timeout_seconds` | no | `30` | Per-request timeout |
| `http_max_attempts` | no | `4` | Retries for 429/5xx/network |

`process_slug` and `tags` are mutually exclusive. You must provide exactly one.

## Outputs

| Output | Description |
|---|---|
| `run_id` | Certyn run ID |
| `status_url` | Absolute status URL |
| `app_url` | App URL for artifacts |
| `test_case_count` | Test case count from create response |
| `idempotency_replayed` | `true` if create reused existing run |
| `state` | Final run state |
| `conclusion` | Final conclusion |
| `total`, `passed`, `failed`, `blocked`, `pending`, `skipped` | Final counters |

## Examples

### Use tags instead of process slug

```yaml
- uses: certyn/action@v1
  with:
    api_key: ${{ secrets.CERTYN_API_KEY }}
    project_slug: ${{ secrets.CERTYN_PROJECT_SLUG }}
    tags: smoke,critical
```

### Trigger only (no waiting)

```yaml
- uses: certyn/action@v1
  id: certyn
  with:
    api_key: ${{ secrets.CERTYN_API_KEY }}
    project_slug: ${{ secrets.CERTYN_PROJECT_SLUG }}
    process_slug: smoke-suite
    wait_for_completion: false

- run: echo "Run URL: ${{ steps.certyn.outputs.status_url }}"
```

### Non-production host (dev/staging)

```yaml
- uses: certyn/action@v1
  with:
    api_key: ${{ secrets.CERTYN_API_KEY_DEV }}
    project_slug: ${{ secrets.CERTYN_PROJECT_SLUG_DEV }}
    api_url: https://api.dev.certyn.io
    process_slug: smoke-suite
```

## Testing this action

- Unit/integration tests: `npm test`
- Live smoke test workflow: `.github/workflows/live-smoke.yml`

The live smoke workflow supports dev/staging/prod targets and optional custom URL/slug overrides.

## Recommended rollout

1. Start with `wait_for_completion: false` in a non-blocking workflow to validate connectivity.
2. Enable waiting and strict gating (`fail_on_failed=true`, `fail_on_blocked=true`).
3. Add nightly `regression-suite` workflow separately from PR smoke gating.
