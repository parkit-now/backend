# CI/CD Pipeline

This directory contains the single GitHub Actions workflow for the project.

## Branching model recap

See `CONTRIBUTING.md` for the full strategy. Quick summary:

- All Pull Requests target **`main`**.
- **`develop`** is the integration / pre-prod environment. It does NOT
  receive PRs and does NOT accumulate merges: developers force-push their
  rebased feature branches onto `develop` to validate together with other
  in-flight work. See "Validate in develop" in `CONTRIBUTING.md`.
- Workflow trigger:
  - `feat/*` / `fix/*` -> rebase + force-push to `develop` -> pipeline
    deploys that snapshot to the develop environment for QA.
  - When the change is approved on the PR to `main` and merged -> pipeline
    deploys the merged commit to PROD.

## Files

| File          | Trigger                                                              | Purpose                                                                            |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pipeline.yml`| every `pull_request` (any target) + every `push` to `develop`/`main` | One unified CI/CD pipeline. CI stages gate CD via `needs:`; failures stop the run. |

## Pipeline shape

All jobs live in a single workflow and are wired with `needs:` so CD jobs
literally cannot run unless every CI job above them succeeded:

```
              lint
                |
              typecheck
                |
              test
              /  \
   build-verify   build-publish        (mutually exclusive via `if:`)
   (PR only)      (push only)
                       |
              deploy-develop   (push to develop)
              deploy-prod      (push to main)
```

- On a **PR** (any target): `lint -> typecheck -> test -> build-verify`.
  No publish, no deploy.
- On a **push** to `develop` or `main`:
  `lint -> typecheck -> test -> build-publish -> deploy-<env>`.
  If lint/typecheck/test/build-publish fail at any point, the deploy never
  starts.

This is **not** "build once, deploy many" — `develop` (integration of WIP
features) and `main` (merged stable) hold genuinely different code at any
moment in this gitflow, so each push produces a separate artifact for its
environment. What we do guarantee:

- **Reproducibility.** Each environment runs *exactly* the bytes from a
  known commit SHA.
- **Fast rollback.** Redeploy the previous SHA tag — no rebuild needed.
- **Config is data, not code.** Environment differences live in env vars
  and secrets, never baked into the image.
- **No drift between code and what's running.** A SHA-tagged image is the
  single source of truth for "what is in `develop`" / "what is in PROD".

## Status: scaffolded, not yet active

`pipeline.yml` ships with every GCP-related step **commented out**, so the
workflow runs green even before any GCP configuration is in place. Each
build/deploy job has a `Placeholder` step that prints what would happen.

When the GCP project, secrets, and variables listed below are set up,
uncomment the blocks marked `# ---- Uncomment everything below ...` in
`pipeline.yml` to enable real builds and deploys.

## Required GitHub configuration

### Repository **Variables** (`Settings -> Secrets and variables -> Actions -> Variables`)

| Name                    | Example                                                | Used by                       |
| ----------------------- | ------------------------------------------------------ | ----------------------------- |
| `GCP_PROJECT`           | `parkit-now`                                           | `build-publish`               |
| `GCP_REGION`            | `southamerica-east1`                                   | `build-publish`, `deploy-*`   |
| `GCP_AR_REPO`           | `parkit-docker`                                        | `build-publish`               |
| `SERVICE_NAME`          | `parkit-backend`                                       | `build-publish`, `deploy-*`   |
| `RUN_SA_DEVELOP`        | `cloudrun-develop@<project>.iam.gserviceaccount.com`   | `deploy-develop`              |
| `RUN_SA_PROD`           | `cloudrun-prod@<project>.iam.gserviceaccount.com`      | `deploy-prod`                 |
| `GCP_BUILD_LOGS_BUCKET` | `parkit-build-logs`                                    | `build-publish` (Cloud Build) |

### Repository **Secrets** (`Settings -> Secrets and variables -> Actions -> Secrets`)

| Name                | Purpose                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `GCP_WIF_PROVIDER`  | Workload Identity Federation provider resource name. No static keys.      |
| `GCP_BUILD_SA`      | Service account used by the build job to push to Artifact Registry.       |
| `GCP_DEPLOY_SA`     | Service account used by deploy jobs to update Cloud Run services.         |
| `CODECOV_TOKEN`     | (optional) Coverage upload.                                               |

### GCP setup checklist

1. Create the Artifact Registry repo (`gcloud artifacts repositories create`).
2. Create two Cloud Run services (one per environment) or rely on the
   `service-name` + `service-name-develop` convention from `pipeline.yml`.
3. Configure Workload Identity Federation between GitHub Actions and GCP:
   - Create a Workload Identity Pool and Provider in GCP.
   - Bind the build & deploy service accounts to the provider.
   - Store the provider resource name as `GCP_WIF_PROVIDER`.
4. Grant the build SA the `roles/artifactregistry.writer` role.
5. Grant the deploy SA the `roles/run.admin` role on the Cloud Run services
   and `roles/iam.serviceAccountUser` on the runtime SAs.

### GitHub Environments

Create two environments in **Settings -> Environments**:

- `develop` — no required reviewers; auto-deploys on every push to
  `develop` (including force-pushes coming from feature integration).
- `production` — recommended: 1 required reviewer + a 5–10 minute wait timer
  so an emergency rollback can be triggered before traffic shifts.

## Filling in the template

The `TODO` comments in `pipeline.yml` mark the points that need
project-specific values:

- Runtime setup (Node / Python / Bun / Go / etc.).
- Lint / typecheck / test commands.
- Integration test services (Postgres, Redis, ...).
- Build command (Cloud Build vs. `docker buildx`).
- Cloud Run flags (`--update-secrets`, scaling, auth policy).
- Auto-versioning (release-please / semantic-release).

Remove any `TODO` block that doesn't apply to the project once filled in.
