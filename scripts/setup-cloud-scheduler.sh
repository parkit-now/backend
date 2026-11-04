#!/usr/bin/env bash
#
# Crea (o actualiza) lo que Cloud Scheduler necesita para disparar los jobs
# internos del backend (src/internal-jobs). Es idempotente: se puede correr de
# nuevo sin duplicar nada.
#
# POR QUÉ EXISTE
#
# En Cloud Run (scale-to-zero) un `@Cron` dentro del proceso sólo corre si hay
# una instancia viva a esa hora. Cloud Scheduler llama por HTTP al backend, lo
# despierta y deja registro de cada corrida. Esta configuración vive en GCP y
# no en el repo: este script es su versión reproducible.
#
# QUÉ HACE
#
#   1. Habilita la API de Cloud Scheduler.
#   2. Crea la service account con la que Scheduler firma las llamadas. No
#      lleva ningún rol: sólo sirve para emitir el token OIDC que el backend
#      verifica (SchedulerOidcGuard).
#   3. Carga INTERNAL_JOBS_AUDIENCE e INTERNAL_JOBS_INVOKER_EMAIL en el
#      servicio de Cloud Run (genera una revisión nueva). Con esas variables
#      el endpoint se activa y el `@Cron` local deja de correr ahí.
#   4. Crea o actualiza los jobs.
#
# COSTO
#
# Cloud Scheduler cobra por job, no por ejecución: 3 jobs gratis por cuenta de
# facturación (no por proyecto). Hoy hay UNO. Antes de sumar otro, contar los
# que ya existen en toda la cuenta.
#
# NO TOCA `LPR_IMAGE_RETENTION_DRY_RUN`: activar el borrado real es una
# decisión aparte (ver .env.example).
#
# USO
#
#   scripts/setup-cloud-scheduler.sh            # aplica
#   DRY_RUN=1 scripts/setup-cloud-scheduler.sh  # sólo muestra los comandos
#
# Variables (con los valores de producción por defecto):
#   GCP_PROJECT, GCP_REGION, RUN_SERVICE, SCHEDULER_SA_NAME

set -euo pipefail

PROJECT="${GCP_PROJECT:-parkit-496022}"
REGION="${GCP_REGION:-southamerica-east1}"
SERVICE="${RUN_SERVICE:-backend}"
SA_NAME="${SCHEDULER_SA_NAME:-parkit-scheduler}"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
TIME_ZONE="America/Argentina/Buenos_Aires"

run() {
  if [[ -n "${DRY_RUN:-}" ]]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

command -v gcloud >/dev/null 2>&1 || {
  echo "✗ Falta gcloud. https://cloud.google.com/sdk/docs/install" >&2
  exit 1
}

echo "→ Proyecto $PROJECT, región $REGION, servicio $SERVICE"

run gcloud services enable cloudscheduler.googleapis.com \
  --project "$PROJECT" --quiet

if gcloud iam service-accounts describe "$SA_EMAIL" \
  --project "$PROJECT" >/dev/null 2>&1; then
  echo "✓ Service account $SA_EMAIL ya existe"
else
  run gcloud iam service-accounts create "$SA_NAME" \
    --project "$PROJECT" \
    --display-name "Cloud Scheduler: jobs internos del backend" \
    --description "Identidad con la que Cloud Scheduler llama a /internal/jobs/* del backend. Sin roles." \
    --quiet
fi

# La audiencia del token es la URL del servicio: el backend rechaza cualquier
# token emitido para otra cosa.
SERVICE_URL="$(gcloud run services describe "$SERVICE" \
  --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
if [[ -z "$SERVICE_URL" ]]; then
  echo "✗ No se pudo leer la URL del servicio $SERVICE" >&2
  exit 1
fi
echo "→ URL del servicio: $SERVICE_URL"

# --update-env-vars sólo toca estas dos: el resto de las variables queda igual.
run gcloud run services update "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --update-env-vars "INTERNAL_JOBS_AUDIENCE=${SERVICE_URL},INTERNAL_JOBS_INVOKER_EMAIL=${SA_EMAIL}" \
  --quiet

# upsert_job <nombre> <cron> <path> <descripción>
upsert_job() {
  local name="$1" schedule="$2" path="$3" description="$4"
  local action="create"
  if gcloud scheduler jobs describe "$name" \
    --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    action="update"
  fi
  run gcloud scheduler jobs "$action" http "$name" \
    --project "$PROJECT" --location "$REGION" \
    --schedule "$schedule" --time-zone "$TIME_ZONE" \
    --uri "${SERVICE_URL}${path}" --http-method POST \
    --oidc-service-account-email "$SA_EMAIL" \
    --oidc-token-audience "$SERVICE_URL" \
    --attempt-deadline 180s --max-retry-attempts 2 \
    --description "$description" \
    --quiet
  echo "✓ Job $name ($action): $schedule $TIME_ZONE"
}

# Retención de imágenes LPR: una vez por día, de madrugada, cuando las playas
# están entre turnos (el tier de ruido exige que no haya caja abierta).
upsert_job lpr-image-retention "30 4 * * *" \
  /internal/jobs/lpr-image-retention \
  "Retencion diaria de imagenes LPR (backend /internal/jobs/lpr-image-retention)"

echo ""
echo "Listo. Para probar una corrida ahora:"
echo "  gcloud scheduler jobs run lpr-image-retention --project $PROJECT --location $REGION"
