# Auto-Deploy-to-Vercel

Automated GitHub Actions deployment pipeline that validates web projects, builds them, deploys to Vercel, and verifies the production URL.

## Supported frameworks

- Next.js
- React
- Vue
- Astro
- Static websites (`index.html` or `public/index.html`)

## Required repository secrets

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

## Workflow trigger

Workflow file: `/home/runner/work/Auto-Deploy-to-Vercel/Auto-Deploy-to-Vercel/.github/workflows/deploy-vercel.yml`

Deployment runs when:
- Triggered manually via **workflow_dispatch**
- Triggered via **repository_dispatch** with type `deploy-ready`

## Pipeline stages

1. Framework detection and validation
2. Dependency installation (`npm ci` or `npm install`)
3. Build process (`npm run build`)
4. Vercel production deployment
5. Reachability verification of the final URL

## Output format

On success:

```text
✅ Deployment Successful

Repository: {repository_name}
Branch: {branch_name}

Live URL:
{deployment_url}
```

On failure:

```text
❌ Deployment Failed

Stage: {which_stage_failed}

Error:
{specific_error_message}

Suggested Fix:
{recommended_solution_based_on_error}

Logs:
{relevant_deployment_logs}
```
