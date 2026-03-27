# certyn/action

Official GitHub Action for Certyn CI verification.

Trigger Certyn test runs, send AI instructions, and gate deployments on results.

## Quick start

### Run smoke tests on every PR

```yaml
- uses: certyn/action@v1
  with:
    api_key: ${{ secrets.CERTYN_API_KEY }}
    project_slug: my-app
    process_slug: smoke-suite
```

### Post-deploy: bump version, run smoke, and explore changes

```yaml
- uses: certyn/action@v1
  with:
    api_key: ${{ secrets.CERTYN_API_KEY }}
    project_slug: my-app
    process_slug: smoke-suite
    environment_key: prod
    instruction: |
      Bump prod version to ${{ github.sha }}.
      Check the checkout page and write test cases for recent changes.
```

When `instruction` is provided alongside `process_slug`, the action:
1. Creates the CI run (smoke tests) as usual
2. Sends the instruction to Certyn AI in the background
3. Polls test results, then waits for the AI conversation to complete
4. Outputs both test results and the AI response

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `api_key` | yes | - | Certyn API key |
| `project_slug` | yes | - | Certyn project slug |
| `environment_key` | no | - | Target environment (e.g., staging, prod) |
| `instruction` | no | - | Natural language instruction for Certyn AI |
| `process_slug` | conditional | - | Process to run (recommended) |
| `tags` | conditional | - | Alternative to `process_slug` |
| `api_url` | no | `https://api.certyn.io` | API base URL |
| `repository` | no | `GITHUB_REPOSITORY` | Git metadata |
| `ref` | no | `GITHUB_REF_NAME` | Git metadata |
| `commit_sha` | no | `GITHUB_SHA` | Git metadata |
| `event` | no | `GITHUB_EVENT_NAME` | Git metadata |
| `external_url` | no | current Actions run URL | Link back to CI |
| `idempotency_key` | no | auto-generated | Prevents duplicate runs on retries |
| `wait_for_completion` | no | `true` | Wait for terminal state |
| `timeout_seconds` | no | `1800` | Max wait time |
| `initial_poll_interval_seconds` | no | `10` | Min poll interval |
| `max_poll_interval_seconds` | no | `30` | Max poll interval |
| `fail_on_failed` | no | `true` | Fail when tests fail |
| `fail_on_blocked` | no | `true` | Fail when tests are blocked |
| `fail_on_cancelled` | no | `true` | Fail when run is cancelled |
| `cancel_on_timeout` | no | `true` | Cancel run on timeout |
| `cancel_on_job_cancel` | no | `true` | Cancel run on SIGINT/SIGTERM |
| `cancel_reason` | no | `Cancelled by certyn/action` | Cancel reason |
| `request_timeout_seconds` | no | `30` | Per-request HTTP timeout |
| `http_max_attempts` | no | `4` | Retries for 429/5xx/network errors |

`process_slug` and `tags` are mutually exclusive. Provide exactly one.

`instruction` is optional and works alongside either mode.

## Outputs

| Output | Description |
|---|---|
| `run_id` | Certyn run ID |
| `status_url` | Absolute status URL |
| `app_url` | App URL for run details |
| `test_case_count` | Number of tests in the run |
| `idempotency_replayed` | `true` if reusing an existing run |
| `state` | Final run state (`completed` or `cancelled`) |
| `conclusion` | Final outcome (`success`, `failure`, `action_required`, `neutral`, `cancelled`) |
| `total`, `passed`, `failed`, `blocked`, `pending`, `skipped` | Test counters |
| `conversation_id` | AI conversation ID (when `instruction` is provided) |
| `conversation_state` | Conversation state (`idle`, `failed`, `processing`) |
| `conversation_response` | AI response text |

## Examples

### Deployment pipeline with AI instructions

```yaml
name: Deploy & Verify

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # ... your deploy steps ...

      - name: Verify deployment
        uses: certyn/action@v1
        with:
          api_key: ${{ secrets.CERTYN_API_KEY }}
          project_slug: my-app
          environment_key: prod
          process_slug: smoke-suite
          instruction: |
            We deployed version ${{ github.sha }} to production.
            Bump the prod environment version.
            After smoke tests pass, explore the checkout and payment pages.
            Record any observations and propose new test cases.
```

### Tags instead of process slug

```yaml
- uses: certyn/action@v1
  with:
    api_key: ${{ secrets.CERTYN_API_KEY }}
    project_slug: my-app
    tags: smoke,critical
```

### Fire and forget (no waiting)

```yaml
- uses: certyn/action@v1
  id: certyn
  with:
    api_key: ${{ secrets.CERTYN_API_KEY }}
    project_slug: my-app
    process_slug: smoke-suite
    wait_for_completion: false

- run: echo "Run URL ${{ steps.certyn.outputs.status_url }}"
```

### Use AI response in subsequent steps

```yaml
- uses: certyn/action@v1
  id: certyn
  with:
    api_key: ${{ secrets.CERTYN_API_KEY }}
    project_slug: my-app
    process_slug: smoke-suite
    instruction: "Summarize test health and top risks for this release."

- name: Post AI summary to PR
  if: github.event_name == 'pull_request'
  uses: actions/github-script@v7
  with:
    script: |
      github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: `## Certyn AI Summary\n\n${{ steps.certyn.outputs.conversation_response }}`
      })
```

## Testing

- Unit tests: `npm test`
- Live smoke: `.github/workflows/live-smoke.yml`

## Recommended rollout

1. Start with `wait_for_completion: false` to validate connectivity.
2. Enable waiting with `fail_on_failed: true` for PR gating.
3. Add `instruction` to deployment workflows for AI-driven post-deploy verification.
