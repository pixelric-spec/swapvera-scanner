# Swapvera scanner

Finds OpenAI, Anthropic and Gemini model IDs in your code that are **already retired** or **scheduled for shutdown**, and tells you the replacement and the date.

Providers retire models every few months. Most apps hard-code the model ID, and most migrations happen only after requests start failing. This action catches it before.

## Use it as a GitHub Action

```yaml
# .github/workflows/swapvera.yml
name: Swapvera
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 7 * * 1'   # every Monday, to catch new retirement notices
permissions:
  contents: read
  issues: write
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pixelric-spec/swapvera-scanner@v1
        with:
          fail-on: retired     # retired | soon | never | days:30
```

What you get:

- An annotation on every line that uses a deprecated model.
- A summary table in the job page.
- One issue, kept up to date, listing every model, its shutdown date and its replacement. It closes itself when the models are gone.
- `swapvera-scan.json` with the full report.

| Input | Default | Meaning |
| --- | --- | --- |
| `path` | `.` | Directory to scan |
| `fail-on` | `retired` | `retired`, `soon` (inside `warn-days`), `never`, or `days:N` |
| `warn-days` | `90` | Shutdowns closer than this are warnings |
| `create-issue` | `true` | Keep one issue up to date (needs `issues: write`) |
| `ignore` | | Paths to skip, comma or newline separated |

Outputs: `found`, `retired`, `soonest-days`, `issue-number`, `report-file`.

## Use it locally

```bash
npx swapvera-scan .
npx swapvera-scan . --json --fail-on days:30
```

## How matching works

- Exact IDs and dated snapshots (`claude-sonnet-4-5-20250929`, `gpt-4o-2024-08-06`, `gemini-2.0-flash-001`).
- The most specific match wins: `gpt-4o-2024-05-13` has its own date, other `gpt-4o` snapshots follow `gpt-4o`.
- Amazon Bedrock IDs (`us.anthropic.claude-...-v1:0`) use Bedrock dates, which often differ by months.
- Vertex AI-only dates are reported as notices unless the file uses Vertex AI.
- Very short IDs (`o1`, `o3`) only match inside quotes, to avoid false positives.
- Retired endpoints too: the Assistants API and reusable prompt objects (`pmpt_...`).

No code leaves your runner. The scanner has no dependencies and makes no network calls except to the GitHub API to manage the issue.

## Is the replacement safe?

Changing the model ID is one line. Knowing whether your answers got worse is not. [Swapvera](https://swapvera.example) runs your prompts on the old and the new model and posts a statistical verdict on the pull request: safe to migrate, review these cases, or do not migrate.

## Dates

Every entry in `src/registry.json` cites the page it comes from. If a date is wrong, open an issue with the provider's link.

License: MIT.
